import { env } from "cloudflare:test";

// Applies the real migration SQL (passed in as a binding by the vitest config)
// to the local D1 binding before each test file runs.
const statements = (env.TEST_MIGRATION_SQL as unknown as string)
  .replace(/^\s*--.*$/gm, "")
  .split(";")
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0);

for (const statement of statements) {
  await env.STATE_DB.prepare(statement).run();
}
