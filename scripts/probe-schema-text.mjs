// Is the in-prompt copy of the output schema earning its 372 tokens?
//
// The schema is already sent as `response_format`, where it drives constrained
// decoding. This sends the real contract to every model twice — once with the
// schema also spelled out in the system message, once without — and compares
// how often the result passes the kernel's validation.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const vars = readFileSync(join(ROOT, ".dev.vars"), "utf8");
const keys = {
  groq: vars.match(/^GROQ_API_KEY=(.+)$/m)?.[1]?.trim(),
  gemini: vars.match(/^GEMINI_API_KEY=(.+)$/m)?.[1]?.trim(),
};

const contract = [
  readFileSync(join(ROOT, "CONTRACT.md"), "utf8"),
  readFileSync(join(ROOT, "SITE.md"), "utf8"),
].join("\n\n");

const schemaSource = readFileSync(join(ROOT, "src/kernel/schema.ts"), "utf8");
const start = schemaSource.indexOf("export const OUTPUT_SCHEMA = {") + "export const OUTPUT_SCHEMA = ".length;
const end = schemaSource.indexOf("} as const;", start) + 1;
const OUTPUT_SCHEMA = eval(`(${schemaSource.slice(start, end)})`);

const SCHEMA_BLOCK = [
  "OUTPUT CONTRACT (enforced by the runtime; violations are rejected and nothing is persisted):",
  JSON.stringify(OUTPUT_SCHEMA.schema),
  "Return exactly one JSON object matching this schema. No prose, no code fences.",
].join("\n");

// Without the schema text, the model still needs to be told to answer as one
// JSON object; only the machine-readable copy is removed.
const TERSE_BLOCK = "Return exactly one JSON object matching the enforced schema. No prose, no code fences.";

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
    return ["not_json"];
  }
  if (parsed.kind !== "final") failures.push(`kind=${parsed.kind}`);
  if (!parsed.response) failures.push("no_response");
  else {
    if (!Number.isInteger(parsed.response.status)) failures.push("status");
    if (typeof parsed.response.body !== "string") failures.push("body_not_string");
    else if (!/<html[\s>]/i.test(parsed.response.body)) failures.push("not_a_document");
    for (const header of parsed.response.headers ?? []) {
      if (!ALLOWED_HEADERS.has(String(header?.name).toLowerCase())) failures.push(`header:${header?.name}`);
    }
  }
  if (parsed.next_state !== null && typeof parsed.next_state !== "string") failures.push("next_state_not_string");
  else if (typeof parsed.next_state === "string") {
    try {
      JSON.parse(parsed.next_state);
    } catch {
      failures.push("next_state_not_json");
    }
  }
  return failures;
}

const MODELS = [
  ["groq", "openai/gpt-oss-120b"],
  ["groq", "qwen/qwen3.8-27b"],
  ["groq", "openai/gpt-oss-20b"],
  ["groq", "qwen/qwen3.6-27b"],
  ["gemini", "gemini-3.1-flash-lite"],
  ["gemini", "gemini-3.1-flash-lite-preview"],
];

const ENDPOINTS = {
  groq: "https://api.groq.com/openai/v1/chat/completions",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
};

const RUNS = Number(process.env.RUNS ?? 3);

async function attempt(provider, model, withSchemaText) {
  const messages = [
    { role: "system", content: `${contract}\n\n${withSchemaText ? SCHEMA_BLOCK : TERSE_BLOCK}` },
    {
      role: "user",
      content: `CURRENT_STATE (opaque to the runtime; this is your own document):\nnull\n\nHTTP_REQUEST:\n${JSON.stringify({ method: "GET", path: "/architecture", query: {}, headers: { accept: "text/html" }, body: null })}`,
    },
  ];
  const response = await fetch(ENDPOINTS[provider], {
    method: "POST",
    headers: { authorization: `Bearer ${keys[provider]}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: "json_schema", json_schema: OUTPUT_SCHEMA },
      temperature: 0.4,
      [provider === "groq" ? "max_completion_tokens" : "max_tokens"]: 3000,
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return { ok: false, reason: `http_${response.status}`, prompt: 0 };
  }
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content ?? "";
  const failures = validate(content);
  return { ok: failures.length === 0, reason: failures.join(",") || "pass", prompt: payload.usage?.prompt_tokens ?? 0 };
}

console.log(`${RUNS} runs per model per variant\n`);
console.log(`${"model".padEnd(34)} ${"with schema text".padEnd(20)} ${"without".padEnd(20)} prompt tokens`);
console.log("-".repeat(100));

const totals = { with: { pass: 0, total: 0 }, without: { pass: 0, total: 0 } };

for (const [provider, model] of MODELS) {
  const results = { with: [], without: [] };
  let promptWith = 0;
  let promptWithout = 0;

  for (let run = 0; run < RUNS; run++) {
    for (const variant of ["with", "without"]) {
      const outcome = await attempt(provider, model, variant === "with");
      results[variant].push(outcome);
      totals[variant].total++;
      if (outcome.ok) totals[variant].pass++;
      if (variant === "with") promptWith = outcome.prompt || promptWith;
      else promptWithout = outcome.prompt || promptWithout;
    }
  }

  const summarise = (list) => {
    const passed = list.filter((r) => r.ok).length;
    const reasons = [...new Set(list.filter((r) => !r.ok).map((r) => r.reason))].join(";").slice(0, 16);
    return `${passed}/${list.length}${reasons ? ` ${reasons}` : ""}`;
  };

  console.log(
    `${model.padEnd(34)} ${summarise(results.with).padEnd(20)} ${summarise(results.without).padEnd(20)} ${promptWith} -> ${promptWithout}`,
  );
}

console.log("-".repeat(100));
console.log(
  `with schema text: ${totals.with.pass}/${totals.with.total}    without: ${totals.without.pass}/${totals.without.total}`,
);
