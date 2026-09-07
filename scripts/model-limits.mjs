// Probes candidate models for two things that decide whether switching helps:
// the rate-limit budget the free tier grants, and whether the model supports
// strict Structured Outputs — which this architecture depends on, since the
// output schema is the enforcement boundary for every response.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const key = readFileSync(join(ROOT, ".dev.vars"), "utf8").match(/^GROQ_API_KEY=(.+)$/m)?.[1]?.trim();

const CANDIDATES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "openai/gpt-oss-20b",
      "openai/gpt-oss-120b",
      "qwen/qwen3.8-27b",
      "llama-3.1-8b-instant",
      "llama-3.3-70b-versatile",
      "gemma2-9b-it",
      "openai/gpt-oss-safeguard-20b",
    ];

// A miniature version of the real contract: nullable branches and a nested
// object, which is what trips up models without constrained decoding.
const SCHEMA = {
  name: "probe",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "response"],
    properties: {
      kind: { type: "string", enum: ["final", "filesystem_request"] },
      response: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["status", "body"],
            properties: { status: { type: "integer" }, body: { type: "string" } },
          },
          { type: "null" },
        ],
      },
    },
  },
};

function pad(value, width) {
  return String(value).padEnd(width);
}

console.log(
  `${pad("model", 30)} ${pad("strict", 8)} ${pad("req/window", 12)} ${pad("tokens/min", 11)} ${pad("reset", 10)} notes`,
);
console.log("-".repeat(100));

for (const model of CANDIDATES) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: 'Reply with kind "final", status 200, body "ok".' }],
      response_format: { type: "json_schema", json_schema: SCHEMA },
      max_completion_tokens: Number(process.env.MAX_TOKENS ?? 120),
    }),
  });

  const limitRequests = response.headers.get("x-ratelimit-limit-requests") ?? "—";
  const limitTokens = response.headers.get("x-ratelimit-limit-tokens") ?? "—";
  const resetTokens = response.headers.get("x-ratelimit-reset-tokens") ?? "—";

  let strict = response.ok ? "yes" : "NO";
  let note = "";
  if (response.ok) {
    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content ?? "";
    try {
      const parsed = JSON.parse(content);
      note = `returned ${JSON.stringify(parsed).slice(0, 40)}`;
    } catch {
      strict = "NO";
      note = "output was not valid JSON";
    }
  } else {
    const body = await response.text();
    const message = (() => {
      try {
        return JSON.parse(body).error?.message ?? body;
      } catch {
        return body;
      }
    })();
    note = String(message).replace(/\s+/g, " ").slice(0, 60);
  }

  console.log(`${pad(model, 30)} ${pad(strict, 8)} ${pad(limitRequests, 12)} ${pad(limitTokens, 11)} ${pad(resetTokens, 10)} ${note}`);
}
