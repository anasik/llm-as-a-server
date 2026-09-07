// The constitution is authored as SERVER.md and compiled into a byte-stable TS
// module. Groq prompt caching keys on an exact shared prefix, so this text must
// be identical across requests; generating it removes any chance of the runtime
// interpolating per-request data into the cached prefix.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "SERVER.md"), "utf8");
const out = `// GENERATED FILE — do not edit. Source: SERVER.md (npm run constitution)
export const CONSTITUTION = ${JSON.stringify(source)};
export const CONSTITUTION_BYTES = ${new TextEncoder().encode(source).length};
`;
writeFileSync(join(root, "src/kernel/constitution.generated.ts"), out);
console.log(`constitution: ${new TextEncoder().encode(source).length} bytes`);
