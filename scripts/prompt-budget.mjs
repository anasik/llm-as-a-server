// Where the per-request prompt actually goes. Counts real tokens by asking the
// provider to tokenize each section, so this is measurement rather than a
// chars/4 guess.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const key = readFileSync(join(ROOT, ".dev.vars"), "utf8").match(/^GROQ_API_KEY=(.+)$/m)?.[1]?.trim();
const source = readFileSync(join(ROOT, "SERVER.md"), "utf8");

const schemaSource = readFileSync(join(ROOT, "src/kernel/schema.ts"), "utf8");
const start = schemaSource.indexOf("export const OUTPUT_SCHEMA = {") + "export const OUTPUT_SCHEMA = ".length;
const end = schemaSource.indexOf("} as const;", start) + 1;
const OUTPUT_SCHEMA = eval(`(${schemaSource.slice(start, end)})`);
const schemaJson = JSON.stringify(OUTPUT_SCHEMA.schema);

// Groq returns prompt_tokens for a request, so a minimal request around a piece
// of text measures it. Subtract the overhead of an empty request once.
async function countTokens(text) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "openai/gpt-oss-20b",
      messages: [{ role: "user", content: text }],
      max_completion_tokens: 1,
    }),
  });
  if (!response.ok) throw new Error(`tokenize failed: ${response.status}`);
  const payload = await response.json();
  return payload.usage?.prompt_tokens ?? 0;
}

const overhead = await countTokens("");

// Split the constitution on its headings.
const sections = [];
let current = { title: "(preamble)", body: "" };
for (const line of source.split("\n")) {
  if (line.startsWith("## ")) {
    sections.push(current);
    current = { title: line.replace(/^##\s*/, ""), body: "" };
  } else {
    current.body += line + "\n";
  }
}
sections.push(current);

console.log(`${"section".padEnd(38)} ${"bytes".padEnd(7)} ${"tokens".padEnd(7)} share`);
console.log("-".repeat(70));

let total = 0;
const measured = [];
for (const section of sections) {
  const text = `## ${section.title}\n${section.body}`;
  const tokens = (await countTokens(text)) - overhead;
  measured.push({ ...section, tokens });
  total += tokens;
}

for (const section of measured.sort((a, b) => b.tokens - a.tokens)) {
  const share = ((section.tokens / total) * 100).toFixed(1);
  console.log(
    `${section.title.slice(0, 37).padEnd(38)} ${String(section.body.length).padEnd(7)} ${String(section.tokens).padEnd(7)} ${share}%`,
  );
}

const schemaTokens = (await countTokens(schemaJson)) - overhead;
console.log("-".repeat(70));
console.log(`${"CONSTITUTION TOTAL".padEnd(38)} ${String(source.length).padEnd(7)} ${String(total).padEnd(7)}`);
console.log(`${"+ raw schema sent alongside it".padEnd(38)} ${String(schemaJson.length).padEnd(7)} ${String(schemaTokens).padEnd(7)}`);
console.log(`${"= stable prefix per request".padEnd(38)} ${"".padEnd(7)} ${String(total + schemaTokens).padEnd(7)}`);

// The output contract section restates a schema that is already sent verbatim.
const contractSection = measured.find((s) => s.title.startsWith("7."));
if (contractSection) {
  console.log(
    `\nduplication: section 7 restates the schema in prose (${contractSection.tokens} tokens) ` +
      `while the machine-readable schema (${schemaTokens} tokens) is sent in the same message.`,
  );
}
