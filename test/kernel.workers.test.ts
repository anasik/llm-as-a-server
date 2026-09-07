import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleSimulatedRequest } from "../src/kernel/handle";
import { LIMITS } from "../src/kernel/limits";
import { ProviderError } from "../src/kernel/providers";
import {
  countingEnv,
  failingGroq,
  final,
  formRequest,
  mockGroq,
  page,
  readSite,
  sessionIdFromCookie,
  siteRequest,
  storedStateJson,
} from "./helpers";

describe("ordinary request lifecycle", () => {
  it("1. GET / produces a model-generated homepage as a real HTML response", async () => {
    const groq = mockGroq([
      final({
        body: page(
          "<h1>LLM as a Server</h1><p>This page was produced by a state transition.</p><nav><a href='/architecture'>Architecture</a></nav>",
          "LLM as a Server",
        ),
        state: { identity: { name: "LLM as a Server" } },
      }),
    ]);
    const testEnv = countingEnv();

    const result = await readSite(await handleSimulatedRequest(siteRequest({ path: "/" }), testEnv, { inference: groq }));

    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toContain("text/html");
    expect(result.body).toContain("<!doctype html>");
    expect(result.body).toContain("LLM as a Server");
    expect(result.telemetry.inferences).toBe(1);
    expect(result.telemetry.persisted).toBe("ok");
    expect(result.sessionCookie).toMatch(/^las_session=[A-Za-z0-9_-]{43}$/);
    expect(result.setCookie).toContain("HttpOnly");
    expect(result.setCookie).toContain("SameSite=Lax");
    expect(result.setCookie).toContain("Secure");
    // The kernel decided nothing about "/" — it only carried the request.
    expect(groq.callCount).toBe(1);
    expect(testEnv.storageCalls).toEqual([]);
  });

  it("serves the model's own styling and no stylesheet of the runtime's", async () => {
    const groq = mockGroq([
      final({
        body: `<!doctype html><html><head><title>Styled</title><style>:root{--ink:#111}body{background:#fafafa;color:var(--ink)}</style></head><body><h1>Styled</h1></body></html>`,
      }),
    ]);
    const result = await readSite(await handleSimulatedRequest(siteRequest({ path: "/" }), countingEnv(), { inference: groq }));

    expect(result.body).toContain("--ink:#111");
    expect(result.body).toContain("background:#fafafa");
    // Inline styling is what makes model-authored design possible; scripting is
    // still impossible.
    expect(result.headers["content-security-policy"]).toContain("style-src 'unsafe-inline'");
    expect(result.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(result.headers["content-security-policy"]).not.toContain("script-src 'unsafe-inline'");
  });

  it("2. an arbitrary previously unknown path is handled by the model", async () => {
    const groq = mockGroq([final({ status: 404, body: page("<h1>No such resource</h1>"), state: {} })]);
    const result = await readSite(
      await handleSimulatedRequest(siteRequest({ path: "/deeply/nested/thing-that-does-not-exist" }), countingEnv(), { inference: groq }),
    );

    // A real 404 reaches the browser, not a 200 pretending to be one.
    expect(result.status).toBe(404);
    const lastPrompt = groq.prompts[0]!.at(-1)!.content;
    expect(lastPrompt).toContain("/deeply/nested/thing-that-does-not-exist");
  });

  it("3+4. a POST changes opaque state and a later GET observes the change", async () => {
    const testEnv = countingEnv();
    const created = mockGroq([
      final({
        status: 303,
        headers: [
          { name: "content-type", value: "text/html; charset=utf-8" },
          { name: "location", value: "/things/kettle" },
        ],
        body: page("<h1>Created</h1>"),
        state: { things: { kettle: { title: "Kettle", body: "boils water" } } },
      }),
    ]);

    const postResult = await readSite(
      await handleSimulatedRequest(formRequest("/things", { title: "Kettle" }), testEnv, { inference: created }),
    );
    expect(postResult.status).toBe(303);
    expect(postResult.headers["location"]).toBe("/things/kettle");
    expect(postResult.telemetry.versionAfter).toBe(1);
    expect(postResult.telemetry.stateAfter!).toBeGreaterThan(postResult.telemetry.stateBefore);

    const cookie = postResult.sessionCookie!;
    const stored = await storedStateJson(sessionIdFromCookie(cookie));
    expect(stored).toContain("kettle");

    // The next inference receives that state verbatim, which is the only way
    // the model can "remember" anything.
    const read = mockGroq([final({ body: page("<h1>Kettle</h1><p>boils water</p>"), state: JSON.parse(stored!) })]);
    const getResult = await readSite(
      await handleSimulatedRequest(siteRequest({ path: "/things/kettle", cookie }), testEnv, { inference: read }),
    );

    expect(getResult.body).toContain("boils water");
    expect(read.prompts[0]!.at(-1)!.content).toContain("kettle");
    // The read returned the document unchanged, so nothing was written and the
    // version did not move.
    expect(getResult.telemetry.versionBefore).toBe(1);
    expect(getResult.telemetry.versionAfter).toBe(1);
    expect(getResult.telemetry.persisted).toBe("unchanged");
  });

  it("treats a null next_state as an explicit no-op, writing nothing", async () => {
    const testEnv = countingEnv();
    const seed = await readSite(
      await handleSimulatedRequest(formRequest("/things", { title: "Kettle" }), testEnv, {
        inference: mockGroq([final({ status: 201, state: { things: { kettle: true } } })]),
      }),
    );
    const cookie = seed.sessionCookie!;
    const before = await storedStateJson(sessionIdFromCookie(cookie));

    // The normal answer to a read: nothing changed, so nothing is serialized.
    const read = await readSite(
      await handleSimulatedRequest(siteRequest({ path: "/things", cookie }), testEnv, {
        inference: mockGroq([{ ...final({ body: page("<h1>Things</h1>") }), next_state: null }]),
      }),
    );

    expect(read.status).toBe(200);
    expect(read.telemetry.persisted).toBe("unchanged");
    expect(read.telemetry.versionAfter).toBe(read.telemetry.versionBefore);
    expect(read.telemetry.validation).toEqual([]);
    // The visitor's data survived a read that declined to rewrite it.
    expect(await storedStateJson(sessionIdFromCookie(cookie))).toBe(before);
  });

  it("decodes an ordinary form submission into fields without attaching meaning", async () => {
    const groq = mockGroq([final({ state: {} })]);
    await handleSimulatedRequest(
      formRequest("/anything", { title: "Kettle", note: "boils water", _method: "PUT" }),
      countingEnv(),
      { inference: groq },
    );

    const prompt = groq.prompts[0]!.at(-1)!.content;
    // Fields arrive as data. The kernel does not interpret `_method` or any
    // other name; the model decides what they mean.
    expect(prompt).toContain('"title":"Kettle"');
    expect(prompt).toContain('"_method":"PUT"');
    expect(prompt).toContain('"method":"POST"');
  });

  it("5. PATCH and DELETE change the same model-owned concept with no domain handler", async () => {
    const testEnv = countingEnv();
    const first = await readSite(
      await handleSimulatedRequest(formRequest("/things", { title: "Kettle" }), testEnv, {
        inference: mockGroq([final({ status: 201, state: { things: { kettle: { title: "Kettle", litres: 1 } } } })]),
      }),
    );
    const cookie = first.sessionCookie!;

    const patch = await readSite(
      await handleSimulatedRequest(
        siteRequest({ method: "PATCH", path: "/things/kettle", body: { litres: 1.7 }, cookie }),
        testEnv,
        { inference: mockGroq([final({ state: { things: { kettle: { title: "Kettle", litres: 1.7 } } } })]) },
      ),
    );
    expect(patch.status).toBe(200);
    expect(await storedStateJson(sessionIdFromCookie(cookie))).toContain("1.7");

    const del = await readSite(
      await handleSimulatedRequest(siteRequest({ method: "DELETE", path: "/things/kettle", cookie }), testEnv, {
        inference: mockGroq([final({ status: 204, body: "", state: { things: {} } })]),
      }),
    );
    expect(del.status).toBe(204);
    expect(del.body).toBe("");
    expect(await storedStateJson(sessionIdFromCookie(cookie))).not.toContain("Kettle");
    expect(testEnv.storageCalls).toEqual([]);
  });

  it("6. refreshing preserves the anonymous session", async () => {
    const testEnv = countingEnv();
    const first = await readSite(
      await handleSimulatedRequest(siteRequest({ path: "/" }), testEnv, { inference: mockGroq([final({ state: { visits: 1 } })]) }),
    );
    const cookie = first.sessionCookie!;

    const refresh = await readSite(
      await handleSimulatedRequest(siteRequest({ path: "/", cookie }), testEnv, {
        inference: mockGroq([final({ state: { visits: 2 } })]),
      }),
    );

    expect(refresh.setCookie).toBeNull();
    expect(refresh.telemetry.versionBefore).toBe(1);
    expect(refresh.telemetry.versionAfter).toBe(2);
  });

  it("7. separate sessions cannot see each other's state", async () => {
    const testEnv = countingEnv();
    const a = await readSite(
      await handleSimulatedRequest(siteRequest({ path: "/" }), testEnv, {
        inference: mockGroq([final({ state: { secret: "alpha-only" } })]),
      }),
    );
    const b = mockGroq([final({ state: { secret: "beta-only" } })]);
    const second = await readSite(await handleSimulatedRequest(siteRequest({ path: "/" }), testEnv, { inference: b }));

    expect(second.sessionCookie).not.toBe(a.sessionCookie);
    expect(JSON.stringify(b.prompts)).not.toContain("alpha-only");
    expect(second.telemetry.versionBefore).toBe(0);
    expect(await storedStateJson(sessionIdFromCookie(a.sessionCookie!))).toContain("alpha-only");
  });
});

describe("generic validation boundary", () => {
  it("8. invalid model output is rejected without modifying state or files", async () => {
    const testEnv = countingEnv();
    const seed = await readSite(
      await handleSimulatedRequest(siteRequest({ path: "/" }), testEnv, {
        inference: mockGroq([final({ state: { keep: "this" } })]),
      }),
    );
    const cookie = seed.sessionCookie!;
    const before = await storedStateJson(sessionIdFromCookie(cookie));

    const cases: [string, unknown][] = [
      ["not json", "definitely not json"],
      ["wrong kind", { kind: "whatever", response: null, next_state: null, filesystem_mutations: null, filesystem_request: null }],
      ["status out of range", final({ status: 999 })],
      ["prohibited header", final({ headers: [{ name: "set-cookie", value: "admin=1" }] })],
      ["header not allowlisted", final({ headers: [{ name: "x-random", value: "1" }] })],
      ["header injection", final({ headers: [{ name: "content-type", value: "text/html\r\nSet-Cookie: a=1" }] })],
      ["redirect without location", final({ status: 302 })],
      ["state not json", { ...final(), next_state: "{oops" }],
      ["state not a string", { ...final(), next_state: { a: 1 } }],
      ["mutation without necessity", final({ mutations: [{ op: "write", path: "/a.txt", encoding: "utf8", content: "x", content_type: "text/plain", necessity: "" }] })],
    ];

    for (const [label, output] of cases) {
      const result = await readSite(
        await handleSimulatedRequest(siteRequest({ path: "/", cookie }), testEnv, {
          inference: mockGroq([output as object]),
        }),
      );
      expect(result.status, label).toBe(502);
      expect(result.telemetry.validation.length, label).toBeGreaterThan(0);
      expect(result.telemetry.persisted, label).toBe("skipped");
      expect(result.telemetry.filesystem.untouched, label).toBe(true);
      expect(await storedStateJson(sessionIdFromCookie(cookie)), label).toBe(before);
    }
    expect(testEnv.storageCalls).toEqual([]);
  });

  it("9. oversized opaque state is rejected", async () => {
    const testEnv = countingEnv();
    const result = await readSite(
      await handleSimulatedRequest(siteRequest({ path: "/" }), testEnv, {
        inference: mockGroq([final({ state: { blob: "x".repeat(LIMITS.stateBytes + 1024) } })]),
      }),
    );

    expect(result.status).toBe(502);
    expect(result.telemetry.validation).toContain("next_state.too_large");
    expect(result.telemetry.persisted).toBe("skipped");
    // The session row exists (it is created on read) but still holds its
    // initial empty document.
    expect(await storedStateJson(sessionIdFromCookie(result.sessionCookie!))).toBe("null");
  });

  it("9b. an oversized request body is rejected before any inference", async () => {
    const groq = mockGroq([final()]);
    const result = await readSite(
      await handleSimulatedRequest(
        siteRequest({ method: "POST", path: "/", body: { note: "y".repeat(LIMITS.clientRequestBytes + 100) } }),
        countingEnv(),
        { inference: groq },
      ),
    );

    expect(result.status).toBe(413);
    expect(groq.callCount).toBe(0);
  });

  it("10. a concurrent stale write does not overwrite newer state", async () => {
    const testEnv = countingEnv();
    const seed = await readSite(
      await handleSimulatedRequest(siteRequest({ path: "/" }), testEnv, { inference: mockGroq([final({ state: { v: 1 } })]) }),
    );
    const cookie = seed.sessionCookie!;
    const sessionId = sessionIdFromCookie(cookie);

    const slowGroq = {
      model: "mock-model",
      async infer() {
        // While this "inference" is in flight, another writer commits.
        await env.STATE_DB.prepare(
          "UPDATE sessions SET state_json = ?1, version = version + 1, updated_at = ?2 WHERE session_id = ?3",
        )
          .bind(JSON.stringify({ v: "written-by-the-winner" }), Date.now(), sessionId)
          .run();
        return {
          text: JSON.stringify(final({ state: { v: "written-by-the-loser" } })),
          latencyMs: 1,
          provider: "mock",
          model: "mock-model",
          attempts: 1,
          usage: { prompt: 1, completion: 1, cached: 0, total: 2 },
        };
      },
    };

    const stale = await readSite(
      await handleSimulatedRequest(siteRequest({ path: "/", cookie }), testEnv, { inference: slowGroq }),
    );

    expect(stale.status).toBe(409);
    expect(stale.telemetry.persisted).toBe("conflict");
    const stored = await storedStateJson(sessionId);
    expect(stored).toContain("written-by-the-winner");
    expect(stored).not.toContain("written-by-the-loser");
  });

  it("13. ordinary GET/POST/PUT/PATCH/DELETE sequences make exactly zero storage calls", async () => {
    const testEnv = countingEnv();
    let cookie: string | null = null;

    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
      const result = await readSite(
        await handleSimulatedRequest(
          siteRequest({
            method,
            path: "/things/kettle",
            body: method === "GET" || method === "DELETE" ? null : { a: 1 },
            cookie,
          }),
          testEnv,
          { inference: mockGroq([final({ state: { method } })]) },
        ),
      );
      cookie ??= result.sessionCookie;
      expect(result.status, method).toBe(200);
      expect(result.telemetry.filesystem.untouched, method).toBe(true);
      expect(result.telemetry.filesystem.calls, method).toBe(0);
      expect(result.telemetry.inferences, method).toBe(1);
    }

    expect(testEnv.storageCalls).toEqual([]);
  });

  it("14. no filesystem manifest, metadata or contents appear in the first Groq request", async () => {
    await env.VFS_BUCKET.put("sessions/whatever/secret-note.txt", "private file body");

    const groq = mockGroq([final()]);
    await handleSimulatedRequest(siteRequest({ path: "/" }), countingEnv(), { inference: groq });

    const prompt = JSON.stringify(groq.prompts[0]);
    expect(prompt).not.toContain("secret-note");
    expect(prompt).not.toContain("private file body");
    expect(prompt).not.toContain("sessions/");

    const perRequest = groq.prompts[0]!.at(-1)!.content;
    expect(perRequest).not.toMatch(/manifest|file_tree|file_list|content_type/i);
    expect(perRequest.split("\n").filter((line) => line.endsWith(":"))).toEqual([
      "CURRENT_STATE (opaque to the runtime; this is your own document):",
      "HTTP_REQUEST:",
    ]);

    // Assert the property, not the wording: the constitution must say the
    // capability exists, must stay unused, and carries no data with it.
    expect(prompt).toContain("must remain unused");
    expect(prompt).toMatch(/no (file )?listing, no manifest/i);
  });

  it("prompt ordering keeps the cacheable prefix first and per-request data last", async () => {
    const groq = mockGroq([final()]);
    await handleSimulatedRequest(siteRequest({ path: "/ordering" }), countingEnv(), { inference: groq });
    const messages = groq.prompts[0]!;

    // A single system message: providers that keep only one must still receive
    // the constitution, not just the schema.
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain("constitution of a simulated HTTP server");
    expect(messages[0]!.content).toContain("OUTPUT CONTRACT");
    expect(messages[0]!.content.indexOf("constitution of a simulated")).toBeLessThan(
      messages[0]!.content.indexOf("OUTPUT CONTRACT"),
    );
    expect(messages[1]!.role).toBe("user");
    expect(messages[1]!.content.indexOf("CURRENT_STATE")).toBeLessThan(messages[1]!.content.indexOf("HTTP_REQUEST"));
  });

  it("never forwards cookies, credentials or platform headers to the provider", async () => {
    const groq = mockGroq([final()]);
    const request = siteRequest({
      path: "/",
      headers: {
        cookie: "las_session=abc; tracking=xyz",
        authorization: "Bearer super-secret",
        "cf-connecting-ip": "203.0.113.9",
        accept: "text/html",
      },
    });

    await handleSimulatedRequest(request, countingEnv(), { inference: groq });
    const prompt = JSON.stringify(groq.prompts[0]);

    expect(prompt).not.toContain("super-secret");
    expect(prompt).not.toContain("tracking=xyz");
    expect(prompt).not.toContain("cf-connecting-ip");
    expect(prompt).not.toContain("203.0.113.9");
    expect(prompt).toContain("text/html");
  });
});

describe("honest failure reporting", () => {
  it("21. a failing state write is surfaced honestly and never masquerades as success", async () => {
    const broken = countingEnv({
      STATE_DB: new Proxy(env.STATE_DB, {
        get(target, property, receiver) {
          if (property === "prepare") {
            return (sql: string) => {
              if (sql.trimStart().toUpperCase().startsWith("UPDATE SESSIONS")) {
                return {
                  bind: () => ({
                    run: async () => {
                      throw new Error("simulated D1 outage");
                    },
                  }),
                };
              }
              return target.prepare(sql);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      }) as D1Database,
    });

    const result = await readSite(
      await handleSimulatedRequest(siteRequest({ path: "/" }), broken, {
        inference: mockGroq([final({ body: page("<h1>looks fine</h1>"), state: { attempted: true } })]),
      }),
    );

    expect(result.status).toBe(500);
    expect(result.telemetry.persisted).toBe("failed");
    expect(result.telemetry.stateAfter).toBeNull();
    // The model's page is not served as though everything worked.
    expect(result.body).not.toContain("looks fine");
    expect(result.body).toContain("nothing was committed");
  });

  it("provider failures and timeouts are reported as such, with nothing persisted", async () => {
    const testEnv = countingEnv();
    const timeout = await readSite(
      await handleSimulatedRequest(siteRequest({ path: "/" }), testEnv, {
        inference: failingGroq(new ProviderError("provider timed out", "provider_timeout", null)),
      }),
    );
    expect(timeout.status).toBe(504);
    expect(timeout.telemetry.persisted).toBe("skipped");

    const failure = await readSite(
      await handleSimulatedRequest(siteRequest({ path: "/" }), testEnv, {
        inference: failingGroq(new ProviderError("provider returned 500", "provider_error", 500)),
      }),
    );
    expect(failure.status).toBe(502);

    // A provider-side rate limit is reported as a rate limit, with its window.
    const limited = await readSite(
      await handleSimulatedRequest(siteRequest({ path: "/" }), testEnv, {
        inference: failingGroq(new ProviderError("provider returned 429", "provider_rate_limited", 429, 27)),
      }),
    );
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBe("27");
  });

  it("error pages disclose nothing about the runtime's internals", async () => {
    const result = await readSite(
      await handleSimulatedRequest(siteRequest({ path: "/" }), countingEnv(), {
        inference: failingGroq(new ProviderError("provider returned 500 (json_validate_failed)", "provider_error", 500)),
      }),
    );

    for (const leak of ["groq", "Groq", "gsk_", "SERVER.md", "constitution", "R2", "D1", "next_state", "json_validate_failed"]) {
      expect(result.body, leak).not.toContain(leak);
    }
  });

  it("per-session throttling stops requests before provider spend", async () => {
    const testEnv = countingEnv();
    const holder = await readSite(
      await handleSimulatedRequest(siteRequest({ path: "/" }), testEnv, { inference: mockGroq([final()]) }),
    );
    const cookie = holder.sessionCookie!;

    let limited: Awaited<ReturnType<typeof readSite>> | null = null;
    for (let i = 0; i < LIMITS.throttlePerSessionPerWindow + 2; i++) {
      const groq = mockGroq([final({ state: { i } })]);
      const result = await readSite(
        await handleSimulatedRequest(siteRequest({ path: "/", cookie }), testEnv, { inference: groq }),
      );
      if (result.status === 429) {
        expect(groq.callCount).toBe(0);
        limited = result;
        break;
      }
    }

    expect(limited).not.toBeNull();
    expect(Number(limited!.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("rejects methods a browser or API client should not be sending here", async () => {
    const result = await readSite(
      await handleSimulatedRequest(siteRequest({ method: "TRACE", path: "/" }), countingEnv(), {
        inference: mockGroq([]),
      }),
    );
    expect(result.status).toBe(405);
  });
});
