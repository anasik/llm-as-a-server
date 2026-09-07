import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

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

export default defineProject({
  plugins: [cloudflareTest({ singleWorker: true, miniflare: {
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
      } })],
  test: TEST,
});
