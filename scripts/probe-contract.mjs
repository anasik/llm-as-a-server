// Tests candidate OpenRouter models against the REAL contract — the full output
// schema and the real constitution — rather than a simplified probe. A model
// that passes a toy schema can still fail the one this architecture depends on.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const vars = readFileSync(join(ROOT, ".dev.vars"), "utf8");
const key = vars.match(/^OPENROUTER_API_KEY=(.+)$/m)?.[1]?.trim();
const geminiKey = vars.match(/^GEMINI_API_KEY=(.+)$/m)?.[1]?.trim();

// Gemini exposes an OpenAI-compatible endpoint, so the same request shape works
// for it, OpenRouter and Groq alike.
function endpointFor(model) {
  if (model.startsWith("gemini")) {
    return {
      url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      key: geminiKey,
      extra: {},
    };
  }
  return {
    url: "https://openrouter.ai/api/v1/chat/completions",
    key,
    extra: { provider: { require_parameters: true } },
  };
}
const constitution = [readFileSync(join(ROOT, "CONTRACT.md"), "utf8"), readFileSync(join(ROOT, "SITE.md"), "utf8")].join("\n\n");

// Load the real schema out of the TypeScript source.
const schemaSource = readFileSync(join(ROOT, "src/kernel/schema.ts"), "utf8");
const start = schemaSource.indexOf("export const OUTPUT_SCHEMA = {") + "export const OUTPUT_SCHEMA = ".length;
const end = schemaSource.indexOf("} as const;", start) + 1;
const OUTPUT_SCHEMA = eval(`(${schemaSource.slice(start, end)})`);

const messages = [
  { role: "system", content: constitution },
  {
    role: "system",
    content: [
      "OUTPUT CONTRACT (enforced by the runtime; violations are rejected and nothing is persisted):",
      JSON.stringify(OUTPUT_SCHEMA.schema),
      "Return exactly one JSON object matching this schema. No prose, no code fences.",
    ].join("\n"),
  },
  {
    role: "user",
    content: [
      "CURRENT_STATE (opaque to the runtime; this is your own document):",
      "null",
      "",
      "HTTP_REQUEST:",
      JSON.stringify({ method: "GET", path: "/", query: {}, headers: { accept: "text/html" }, body: null }),
    ].join("\n"),
  },
];

// The same checks the kernel applies, so a "pass" here means the kernel would
// have served the page.
const ALLOWED_HEADERS = new Set([
  "content-type", "cache-control", "location", "content-disposition",
  "content-language", "etag", "retry-after", "x-content-type-options",
]);

function validate(raw) {
  const failures = [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return ["output.not_json"];
  }
  if (parsed.kind !== "final" && parsed.kind !== "filesystem_request") failures.push("output.kind_invalid");
  if (parsed.kind === "final") {
    if (!parsed.response) failures.push("response.missing");
    else {
      if (!Number.isInteger(parsed.response.status)) failures.push("response.status_not_integer");
      else if (parsed.response.status < 200 || parsed.response.status > 599) failures.push("response.status_out_of_range");
      if (typeof parsed.response.body !== "string") failures.push("response.body_not_string");
      for (const header of parsed.response.headers ?? []) {
        if (!ALLOWED_HEADERS.has(String(header?.name).toLowerCase())) {
          failures.push(`response.header_not_allowlisted(${header?.name})`);
        }
      }
    }
    if (typeof parsed.next_state !== "string") failures.push("next_state.not_string");
    else {
      try {
        JSON.parse(parsed.next_state);
      } catch {
        failures.push("next_state.not_json");
      }
    }
    if (parsed.filesystem_request !== null && parsed.filesystem_request !== undefined) {
      failures.push("output.union_filesystem_request_present");
    }
  }
  return failures;
}

const CANDIDATES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "openrouter/free",
      "nvidia/nemotron-3-super-120b-a12b:free",
      "dots-studio/dots-3-note-preview:free",
      "liquid/lfm-2.5-2.6b:free",
    ];

const RUNS = Number(process.env.RUNS ?? 2);

console.log(`real contract, ${RUNS} run(s) each\n`);
console.log(`${"model".padEnd(42)} ${"run".padEnd(4)} ${"http".padEnd(5)} ${"ms".padEnd(7)} ${"tok".padEnd(6)} verdict`);
console.log("-".repeat(120));

for (const model of CANDIDATES) {
  for (let run = 1; run <= RUNS; run++) {
    const started = Date.now();
    try {
      const target = endpointFor(model);
      const response = await fetch(target.url, {
        method: "POST",
        headers: { authorization: `Bearer ${target.key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          response_format: { type: "json_schema", json_schema: OUTPUT_SCHEMA },
          temperature: 0.4,
          max_tokens: 8000,
          ...target.extra,
        }),
      });
      const elapsed = Date.now() - started;
      const text = await response.text();

      if (!response.ok) {
        let message = text;
        try {
          message = JSON.parse(text).error?.message ?? text;
        } catch {}
        console.log(`${model.padEnd(42)} ${String(run).padEnd(4)} ${String(response.status).padEnd(5)} ${String(elapsed).padEnd(7)} ${"—".padEnd(6)} ${String(message).replace(/\s+/g, " ").slice(0, 60)}`);
        continue;
      }

      const payload = JSON.parse(text);
      const content = payload.choices?.[0]?.message?.content ?? "";
      const tokens = payload.usage?.completion_tokens ?? 0;
      const failures = validate(content);
      const verdict = failures.length === 0 ? `PASS via ${payload.provider ?? "?"}` : `REJECT ${failures.join(",").slice(0, 55)}`;
      console.log(`${model.padEnd(42)} ${String(run).padEnd(4)} ${"200".padEnd(5)} ${String(elapsed).padEnd(7)} ${String(tokens).padEnd(6)} ${verdict}`);
    } catch (error) {
      console.log(`${model.padEnd(42)} ${String(run).padEnd(4)} ${"—".padEnd(5)} ${String(Date.now() - started).padEnd(7)} ${"—".padEnd(6)} ${error.message.slice(0, 60)}`);
    }
  }
}
