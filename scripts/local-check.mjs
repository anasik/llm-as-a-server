// One-shot local verification: build the constitution, find the config shape
// the installed @cloudflare/vitest-pool-workers actually accepts, typecheck the
// deterministic layer, and run the whole suite.
//
// The pool's config API has changed across versions (defineWorkersProject ->
// cloudflareTest/cloudflarePool), so rather than pinning to one spelling this
// script writes each plausible config and keeps the one that loads.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VITEST = join(ROOT, "node_modules/vitest/vitest.mjs");
const TSC = join(ROOT, "node_modules/typescript/bin/tsc");

function run(command, args, { capture = true } = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    env: process.env,
  });
  return { code: result.status ?? 1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const MINIFLARE = `{
        compatibilityDate: "2026-08-22",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["STATE_DB"],
        r2Buckets: ["VFS_BUCKET"],
        bindings: {
          TEST_MIGRATION_SQL: MIGRATION_SQL,
          GROQ_API_KEY: "test-key",
          VFS_NAMESPACE_SALT: "test-salt",
          GROQ_MODEL: "mock-model",
        },
      }`;

const PREAMBLE = `import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";
IMPORT_LINE

// Real local D1 and R2 bindings, seeded from the real migration file.
const MIGRATION_SQL = readFileSync(
  fileURLToPath(new URL("./migrations/0001_runtime.sql", import.meta.url)),
  "utf8",
);

const TEST = {
  name: "kernel",
  include: ["test/**/*.workers.test.ts"],
  setupFiles: ["./test/apply-migrations.ts"],
};
`;

const VARIANTS = {
  "plugin(options)": `${PREAMBLE.replace("IMPORT_LINE", 'import { cloudflareTest } from "@cloudflare/vitest-pool-workers";')}
export default defineProject({
  plugins: [cloudflareTest({ singleWorker: true, miniflare: ${MINIFLARE} })],
  test: TEST,
});
`,
  "plugin(poolOptions)": `${PREAMBLE.replace("IMPORT_LINE", 'import { cloudflareTest } from "@cloudflare/vitest-pool-workers";')}
export default defineProject({
  plugins: [cloudflareTest()],
  test: { ...TEST, poolOptions: { workers: { singleWorker: true, miniflare: ${MINIFLARE} } } },
});
`,
  "pool object": `${PREAMBLE.replace("IMPORT_LINE", 'import { cloudflarePool } from "@cloudflare/vitest-pool-workers";')}
export default defineProject({
  test: {
    ...TEST,
    pool: cloudflarePool,
    poolOptions: { workers: { singleWorker: true, miniflare: ${MINIFLARE} } },
  },
});
`,
  "legacy defineWorkersProject": `import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

const MIGRATION_SQL = readFileSync(
  fileURLToPath(new URL("./migrations/0001_runtime.sql", import.meta.url)),
  "utf8",
);

export default defineWorkersProject({
  test: {
    name: "kernel",
    include: ["test/**/*.workers.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
    poolOptions: { workers: { singleWorker: true, miniflare: ${MINIFLARE} } },
  },
});
`,
};

const CONFIG_PATH = join(ROOT, "vitest.workers.config.ts");
const CONFIG_REJECTED = /Missing "\.\/config"|Failed to initialize projects|Startup Error|failed to load config|is not a function|Cannot find module/;

console.log("== constitution ==");
console.log(run(process.execPath, [join(ROOT, "scripts/build-constitution.mjs")]).out.trim());

console.log("\n== locating a working pool config ==");
let chosen = null;
for (const [name, body] of Object.entries(VARIANTS)) {
  writeFileSync(CONFIG_PATH, body);
  const { out } = run(process.execPath, [VITEST, "run"]);
  if (CONFIG_REJECTED.test(out)) {
    const reason = out.match(/Error: .{0,100}/)?.[0]?.replace(/\s+/g, " ") ?? "rejected";
    console.log(`  ${name}: no  (${reason})`);
    continue;
  }
  console.log(`  ${name}: YES`);
  chosen = name;
  break;
}

if (!chosen) {
  console.log("\n!! no config shape worked. Declared exports:");
  const types = readFileSync(join(ROOT, "node_modules/@cloudflare/vitest-pool-workers/dist/pool/index.d.mts"), "utf8");
  console.log(
    types
      .split("\n")
      .filter((line) => /declare (function|const)|^export|cloudflareTest|cloudflarePool/.test(line))
      .slice(0, 40)
      .join("\n"),
  );
  process.exit(1);
}

console.log("\n== typecheck (deterministic layer) ==");
const typecheck = run(process.execPath, [TSC, "--noEmit"]);
console.log(typecheck.code === 0 ? "clean" : typecheck.out.split("\n").slice(0, 25).join("\n"));

console.log(`\n== full suite (config: ${chosen}) ==`);
const tests = run(process.execPath, [VITEST, "run"], { capture: false });
process.exit(tests.code === 0 && typecheck.code === 0 ? 0 : 1);
