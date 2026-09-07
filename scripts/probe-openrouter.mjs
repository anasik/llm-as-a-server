// Establishes, by measurement, what OpenRouter can actually do for this
// architecture: what the key's limits are, which free models advertise strict
// structured outputs, and which of those survive a request shaped like the real
// output contract (nullable branches, nested objects).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const vars = readFileSync(join(ROOT, ".dev.vars"), "utf8");
const key = vars.match(/^OPENROUTER_API_KEY=(.+)$/m)?.[1]?.trim();
if (!key) {
  console.error("no OPENROUTER_API_KEY in .dev.vars");
  process.exit(1);
}

const auth = { authorization: `Bearer ${key}`, "content-type": "application/json" };

// ---- 1. what this key is allowed to do ----------------------------------
console.log("== key ==");
try {
  const response = await fetch("https://openrouter.ai/api/v1/key", { headers: auth });
  const payload = await response.json();
  console.log(JSON.stringify(payload.data ?? payload, null, 1));
} catch (error) {
  console.log(`could not read key info: ${error.message}`);
}

// ---- 2. which free models claim structured outputs ----------------------
console.log("\n== free models advertising structured outputs ==");
const models = await (await fetch("https://openrouter.ai/api/v1/models", { headers: auth })).json();
const free = (models.data ?? []).filter((model) => {
  const prompt = Number(model.pricing?.prompt ?? "1");
  const completion = Number(model.pricing?.completion ?? "1");
  const params = model.supported_parameters ?? [];
  return prompt === 0 && completion === 0 && params.includes("structured_outputs");
});

free.sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0));
for (const model of free.slice(0, 15)) {
  console.log(`  ${model.id.padEnd(52)} ctx=${String(model.context_length ?? "?").padEnd(8)}`);
}
console.log(`  (${free.length} free models advertise structured_outputs)`);

// ---- 3. do they survive a request shaped like the real contract? --------
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

const CANDIDATES = process.argv.slice(2).length ? process.argv.slice(2) : free.slice(0, 6).map((m) => m.id);

console.log("\n== strict-schema behaviour on a contract-shaped request ==");
console.log(`${"model".padEnd(52)} ${"ok".padEnd(4)} ${"ms".padEnd(7)} notes`);
console.log("-".repeat(110));

for (const model of CANDIDATES) {
  const started = Date.now();
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: 'Reply with kind "final", a response with status 200 and body "ok".' }],
        response_format: { type: "json_schema", json_schema: SCHEMA },
        // Only route to providers that actually honour response_format,
        // otherwise strict mode silently degrades to best effort.
        provider: { require_parameters: true },
        max_tokens: 2000,
      }),
    });
    const elapsed = Date.now() - started;
    const text = await response.text();

    if (!response.ok) {
      let message = text;
      try {
        message = JSON.parse(text).error?.message ?? text;
      } catch {}
      console.log(`${model.padEnd(52)} ${"NO".padEnd(4)} ${String(elapsed).padEnd(7)} ${String(message).replace(/\s+/g, " ").slice(0, 55)}`);
      continue;
    }

    const payload = JSON.parse(text);
    const content = payload.choices?.[0]?.message?.content ?? "";
    const served = payload.provider ?? "?";
    let ok = "yes";
    let note = `via ${served}`;
    try {
      const parsed = JSON.parse(content);
      if (parsed.kind !== "final" || parsed.response?.status !== 200) {
        ok = "weak";
        note += ` — schema-valid but off-spec: ${JSON.stringify(parsed).slice(0, 40)}`;
      }
    } catch {
      ok = "NO";
      note += " — output was not valid JSON";
    }
    console.log(`${model.padEnd(52)} ${ok.padEnd(4)} ${String(elapsed).padEnd(7)} ${note.slice(0, 55)}`);
  } catch (error) {
    console.log(`${model.padEnd(52)} ${"NO".padEnd(4)} ${"—".padEnd(7)} ${error.message.slice(0, 55)}`);
  }
}
