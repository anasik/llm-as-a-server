// Are Groq's rate-limit buckets per-model or shared across the organization?
//
// The docs say limits "apply at the organization level" but publish different
// ceilings per model, which is ambiguous. This settles it: exhaust one model
// until it 429s, then immediately ask a sibling model. If the sibling answers,
// the buckets are separate and model-level failover is real free capacity.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const key = readFileSync(join(ROOT, ".dev.vars"), "utf8").match(/^GROQ_API_KEY=(.+)$/m)?.[1]?.trim();

const PRIMARY = process.env.PRIMARY ?? "openai/gpt-oss-120b";
const SIBLING = process.env.SIBLING ?? "openai/gpt-oss-20b";

// Big enough to burn the 8,000 TPM budget in a handful of calls.
const FILLER = "Consider the following note carefully. ".repeat(200);

async function ask(model, label) {
  const started = Date.now();
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: `${FILLER}\n\nReply with the single word: ok` }],
      max_completion_tokens: 20,
    }),
  });
  const remaining = response.headers.get("x-ratelimit-remaining-tokens") ?? "—";
  const reset = response.headers.get("x-ratelimit-reset-tokens") ?? "—";
  const elapsed = Date.now() - started;

  if (!response.ok) {
    await response.body?.cancel();
    console.log(`  ${label.padEnd(26)} ${model.padEnd(24)} HTTP ${response.status}  remaining=${remaining}  reset=${reset}  ${elapsed}ms`);
    return response.status;
  }
  const payload = await response.json();
  console.log(
    `  ${label.padEnd(26)} ${model.padEnd(24)} HTTP 200  remaining=${String(remaining).padEnd(6)} reset=${String(reset).padEnd(9)} used=${payload.usage?.total_tokens}  ${elapsed}ms`,
  );
  return 200;
}

console.log(`exhausting ${PRIMARY}, then asking ${SIBLING}\n`);

let exhausted = false;
for (let i = 1; i <= 12 && !exhausted; i++) {
  const status = await ask(PRIMARY, `primary #${i}`);
  if (status === 429) exhausted = true;
}

if (!exhausted) {
  console.log("\nprimary never hit its limit; increase the filler or the loop count");
  process.exit(1);
}

console.log("\nprimary is now rate limited. Asking the sibling model immediately:\n");
const siblingStatus = await ask(SIBLING, "sibling");

console.log("\nAnd re-confirming the primary is still limited:\n");
const primaryAgain = await ask(PRIMARY, "primary again");

console.log(
  `\nverdict: ${
    siblingStatus === 200 && primaryAgain === 429
      ? "SEPARATE buckets — model-level failover gives real extra capacity"
      : siblingStatus === 429
        ? "SHARED bucket — switching models inside Groq buys nothing"
        : "inconclusive, run again"
  }`,
);
