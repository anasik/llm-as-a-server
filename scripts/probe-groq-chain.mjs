// Which Groq models can actually serve this site?
//
// Rate-limit buckets are per-model, so every model that satisfies the contract
// is another full allowance in the failover chain. This enumerates what the
// account can see, sends each one the real contract, and prints a ready-made
// LLM_PROVIDERS value containing only the ones that passed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const key = readFileSync(join(ROOT, ".dev.vars"), "utf8").match(/^GROQ_API_KEY=(.+)$/m)?.[1]?.trim();

const contract = [
  readFileSync(join(ROOT, "CONTRACT.md"), "utf8"),
  readFileSync(join(ROOT, "SITE.md"), "utf8"),
].join("\n\n");

const schemaSource = readFileSync(join(ROOT, "src/kernel/schema.ts"), "utf8");
const start = schemaSource.indexOf("export const OUTPUT_SCHEMA = {") + "export const OUTPUT_SCHEMA = ".length;
const end = schemaSource.indexOf("} as const;", start) + 1;
const OUTPUT_SCHEMA = eval(`(${schemaSource.slice(start, end)})`);

const messages = [
  {
    role: "system",
    content: `${contract}\n\nOUTPUT CONTRACT (enforced by the runtime; violations are rejected and nothing is persisted):\n${JSON.stringify(OUTPUT_SCHEMA.schema)}\nReturn exactly one JSON object matching this schema. No prose, no code fences.`,
  },
  {
    role: "user",
    content: `CURRENT_STATE (opaque to the runtime; this is your own document):\nnull\n\nHTTP_REQUEST:\n${JSON.stringify({ method: "GET", path: "/", query: {}, headers: { accept: "text/html" }, body: null })}`,
  },
];

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
    if (!Number.isInteger(parsed.response.status)) failures.push("status_not_integer");
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

console.log("enumerating models this key can see...\n");
const listing = await (await fetch("https://api.groq.com/openai/v1/models", {
  headers: { authorization: `Bearer ${key}` },
})).json();

// Text models only: audio, vision and moderation endpoints can't serve a page.
const candidates = (listing.data ?? [])
  .map((m) => m.id)
  .filter((id) => !/whisper|tts|guard|vision|embed|safeguard/i.test(id))
  .filter((id) => !process.env.ONLY || process.env.ONLY.split(",").includes(id))
  .sort();

console.log(`${candidates.length} candidate text models\n`);
console.log(`${"model".padEnd(40)} ${"http".padEnd(5)} ${"ms".padEnd(7)} ${"tok".padEnd(6)} verdict`);
console.log("-".repeat(110));

const passing = [];
for (const model of candidates) {
  const started = Date.now();
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        response_format: { type: "json_schema", json_schema: OUTPUT_SCHEMA },
        temperature: 0.4,
        max_completion_tokens: Number(process.env.MAX_TOKENS ?? 4000),
      }),
    });
    const elapsed = Date.now() - started;
    const text = await response.text();

    if (!response.ok) {
      let message = text;
      try {
        message = JSON.parse(text).error?.message ?? text;
      } catch {}
      console.log(`${model.padEnd(40)} ${String(response.status).padEnd(5)} ${String(elapsed).padEnd(7)} ${"—".padEnd(6)} ${String(message).replace(/\s+/g, " ").slice(0, 50)}`);
      continue;
    }

    const payload = JSON.parse(text);
    const content = payload.choices?.[0]?.message?.content ?? "";
    const tokens = payload.usage?.completion_tokens ?? 0;
    const failures = validate(content);
    if (failures.length === 0) passing.push(model);
    console.log(
      `${model.padEnd(40)} ${"200".padEnd(5)} ${String(elapsed).padEnd(7)} ${String(tokens).padEnd(6)} ${failures.length === 0 ? "PASS" : `REJECT ${failures.join(",").slice(0, 45)}`}`,
    );
  } catch (error) {
    console.log(`${model.padEnd(40)} ${"—".padEnd(5)} ${String(Date.now() - started).padEnd(7)} ${"—".padEnd(6)} ${error.message.slice(0, 50)}`);
  }
}

console.log(`\n${passing.length} of ${candidates.length} models satisfy the contract.`);
if (passing.length > 0) {
  console.log(`\nEach carries its own rate-limit bucket, so chained they multiply the budget:\n`);
  console.log(`LLM_PROVIDERS = "${passing.map((m) => `groq:${m}`).join(",")},gemini,openrouter"`);
}
