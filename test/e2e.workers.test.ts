import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleHarnessAttachment, handleSimulatedRequest } from "../src/kernel/handle";
import { deriveStorageNamespace } from "../src/kernel/session";
import {
  countingEnv,
  filesystemRequest,
  final,
  formRequest,
  mockGroq,
  page,
  readSite,
  sessionIdFromCookie,
  sha256Hex,
  siteRequest,
  storedStateJson,
} from "./helpers";
import type { CountedEnv } from "./helpers";

interface Step {
  request: { method?: string; path: string; body?: unknown; form?: Record<string, string> };
  outputs: (string | object)[];
}

async function replay(testEnv: CountedEnv, steps: Step[], label: string) {
  const transcript: string[] = [`\n=== ${label} ===`];
  let cookie: string | null = null;
  let inferences = 0;
  const storageAtStart = testEnv.storageCalls.length;

  for (const step of steps) {
    const groq = mockGroq(step.outputs);
    const request = step.request.form
      ? formRequest(step.request.path, step.request.form, cookie)
      : siteRequest({ ...step.request, cookie });

    const result = await readSite(await handleSimulatedRequest(request, testEnv, { inference: groq }));
    cookie ??= result.sessionCookie;
    inferences += result.telemetry.inferences;

    const stateJson = cookie ? await storedStateJson(sessionIdFromCookie(cookie)) : null;
    const hash = stateJson ? (await sha256Hex(stateJson)).slice(0, 12) : "—";
    const describeBody = step.request.form
      ? ` (form ${JSON.stringify(step.request.form)})`
      : step.request.body
        ? ` ${JSON.stringify(step.request.body)}`
        : "";

    transcript.push(
      [
        `--> ${step.request.method ?? (step.request.form ? "POST" : "GET")} ${step.request.path}${describeBody}`,
        `<-- HTTP ${result.status} ${result.headers["content-type"] ?? ""}${result.headers["location"] ? ` -> ${result.headers["location"]}` : ""}`,
        `    body: ${JSON.stringify(result.body.replace(/\s+/g, " ").slice(0, 88))}`,
        `    state: v${result.telemetry.versionBefore}->${result.telemetry.versionAfter ?? "—"}` +
          ` ${result.telemetry.stateBefore}B->${result.telemetry.stateAfter ?? "—"}B sha256:${hash}`,
        `    inferences: ${result.telemetry.inferences}  tokens: ${result.telemetry.tokens.prompt}p/${result.telemetry.tokens.completion}c/${result.telemetry.tokens.cached}cached`,
        `    filesystem: ${result.telemetry.filesystem.raw.toUpperCase()}`,
      ].join("\n"),
    );
  }

  transcript.push(
    `total inferences: ${inferences}   binding-level storage calls during sequence: ${testEnv.storageCalls.length - storageAtStart}`,
  );
  console.log(transcript.join("\n"));
  return { cookie: cookie!, inferences, storageCalls: testEnv.storageCalls.slice(storageAtStart) };
}

describe("end-to-end sequences", () => {
  it("ordinary browsing and CRUD-like editing: one inference each, zero storage calls", async () => {
    const testEnv = countingEnv();

    const home = { identity: { name: "LLM as a Server" }, concepts: {} };
    const withKettle = { identity: home.identity, concepts: { kettle: { title: "Kettle", litres: 1 } } };
    const patched = { identity: home.identity, concepts: { kettle: { title: "Kettle", litres: 1.7 } } };
    const emptied = { identity: home.identity, concepts: {} };

    const outcome = await replay(
      testEnv,
      [
        { request: { path: "/" }, outputs: [final({ body: page("<h1>LLM as a Server</h1><p>This page is a state transition.</p>"), state: home })] },
        { request: { path: "/architecture/kernel-boundary" }, outputs: [final({ body: page("<h1>Kernel boundary</h1>"), state: home })] },
        {
          request: { path: "/concepts", form: { title: "Kettle" } },
          outputs: [
            final({
              status: 303,
              headers: [
                { name: "content-type", value: "text/html; charset=utf-8" },
                { name: "location", value: "/concepts/kettle" },
              ],
              body: "",
              state: withKettle,
            }),
          ],
        },
        { request: { path: "/concepts/kettle" }, outputs: [final({ body: page("<h1>Kettle</h1><p>1 litre</p>"), state: withKettle })] },
        { request: { method: "PATCH", path: "/concepts/kettle", body: { litres: 1.7 } }, outputs: [final({ body: page("<h1>Kettle</h1><p>1.7 litres</p>"), state: patched })] },
        { request: { method: "PUT", path: "/concepts/kettle", body: { title: "Kettle", litres: 1.7 } }, outputs: [final({ body: page("<h1>Kettle</h1>"), state: patched })] },
        { request: { path: "/concepts/kettle" }, outputs: [final({ body: page("<h1>Kettle</h1><p>1.7 litres</p>"), state: patched })] },
        { request: { method: "DELETE", path: "/concepts/kettle" }, outputs: [final({ status: 204, body: "", state: emptied })] },
        { request: { path: "/concepts/kettle" }, outputs: [final({ status: 404, body: page("<h1>Gone</h1>"), state: emptied })] },
      ],
      "ordinary sequence — the filesystem must stay untouched",
    );

    expect(outcome.inferences).toBe(9);
    expect(outcome.storageCalls).toEqual([]);
    expect(JSON.parse((await storedStateJson(sessionIdFromCookie(outcome.cookie)))!)).toEqual(emptied);
  });

  it("exceptional sequence: the generic filesystem protocol, with safe telemetry only", async () => {
    const testEnv = countingEnv();
    const csv = "concept,litres\nkettle,1.7\n";
    const necessity = "The visitor explicitly asked for a downloadable export artifact, which cannot live in bounded opaque state.";

    const outcome = await replay(
      testEnv,
      [
        {
          request: { path: "/exports", form: { format: "csv" } },
          outputs: [
            final({
              status: 201,
              body: page('<h1>Export ready</h1><p><a href="/__harness/attachment?path=%2Fexports%2Fconcepts.csv">concepts.csv</a></p>'),
              state: { exports: ["/exports/concepts.csv"] },
              mutations: [
                { op: "write", path: "/exports/concepts.csv", encoding: "utf8", content: csv, content_type: "text/csv", necessity },
              ],
            }),
          ],
        },
        {
          request: { path: "/exports/concepts.csv" },
          outputs: [
            filesystemRequest(
              [
                { op: "stat", path: "/exports/concepts.csv", limit: null, max_bytes: null },
                { op: "read", path: "/exports/concepts.csv", limit: null, max_bytes: 8192 },
              ],
              necessity,
            ),
            final({ body: page("<h1>concepts.csv</h1><pre>concept,litres</pre>"), state: { exports: ["/exports/concepts.csv"] } }),
          ],
        },
      ],
      "exceptional sequence — explicit file artifact",
    );

    // One write round trip, then one read round trip with a second inference.
    expect(outcome.inferences).toBe(3);
    expect(outcome.storageCalls.length).toBeGreaterThan(0);

    const download = await handleHarnessAttachment(
      new Request("https://example.test/__harness/attachment?path=%2Fexports%2Fconcepts.csv", {
        headers: { cookie: outcome.cookie },
      }),
      testEnv,
    );
    expect(download.status).toBe(200);
    expect(await download.text()).toBe(csv);
    console.log(
      `\nattachment: HTTP ${download.status} ${download.headers.get("content-type")} ` +
        `${download.headers.get("content-disposition")} nosniff=${download.headers.get("x-content-type-options")}`,
    );

    // Nothing private escaped: no storage keys in what a client can observe.
    const namespace = await deriveStorageNamespace(sessionIdFromCookie(outcome.cookie), "test-salt");
    expect(JSON.stringify([...download.headers])).not.toContain(namespace);
    expect(await env.VFS_BUCKET.head(`${namespace}/exports/concepts.csv`)).not.toBeNull();
  });

  it("a visitor sees a website, not an experiment harness", async () => {
    const testEnv = countingEnv();
    const groq = mockGroq([
      final({
        body: page(
          '<header><h1>Field Notes</h1></header><main><p>An essay.</p></main><footer><a href="/colophon">Colophon</a></footer>',
          "Field Notes",
        ),
      }),
    ]);

    const result = await readSite(await handleSimulatedRequest(siteRequest({ path: "/" }), testEnv, { inference: groq }));

    // The response is the model's document and nothing else: no injected
    // banner, console, diagnostics panel or client script.
    expect(result.body).toContain("<h1>Field Notes</h1>");
    expect(result.body).not.toMatch(/harness|diagnostics|console|address bar/i);
    expect(result.body).not.toContain("<script");
    expect(result.body).not.toContain("las_session");
    // The experiment is still observable, out of band.
    expect(result.headers["x-las-inferences"]).toBe("1");
    expect(result.headers["x-las-filesystem"]).toBe("untouched");
  });
});
