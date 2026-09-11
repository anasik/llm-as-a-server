// The prompt prefix is authored as two markdown files and compiled into a
// byte-stable TS module.
//
//   CONTRACT.md — the runtime contract. Applies to every deployment; the kernel
//                 and its tests enforce it whatever the site says.
//   SITE.md     — what this particular site is. Replace it to build something
//                 else.
//
// Prompt caching keys on an exact shared prefix, so this text must be identical
// on every request. Generating it removes any chance of the runtime
// interpolating per-request data into the cached prefix.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bytes = (text) => new TextEncoder().encode(text).length;

const contract = readFileSync(join(root, "CONTRACT.md"), "utf8");
const site = readFileSync(join(root, "SITE.md"), "utf8");

const out = `// GENERATED FILE — do not edit.
// Sources: CONTRACT.md, SITE.md (npm run constitution)
export const CONTRACT = ${JSON.stringify(contract)};
export const SITE = ${JSON.stringify(site)};
export const CONTRACT_BYTES = ${bytes(contract)};
export const SITE_BYTES = ${bytes(site)};
`;
writeFileSync(join(root, "src/kernel/constitution.generated.ts"), out);

console.log(`contract: ${bytes(contract)} bytes   site: ${bytes(site)} bytes   total: ${bytes(contract) + bytes(site)} bytes`);
