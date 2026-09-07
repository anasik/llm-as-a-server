// Deliberately exceeds the primary provider's token budget to show what the
// router does about it. Without failover, requests past the budget are 429s;
// with it, they should be served by the secondary provider instead.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 8790);
const BASE = `http://127.0.0.1:${PORT}`;
const PERSIST = join(ROOT, ".wrangler/state");
const WRANGLER = join(ROOT, "node_modules/wrangler/bin/wrangler.js");
const COUNT = Number(process.env.COUNT ?? 8);

spawnSync(
  process.execPath,
  [WRANGLER, "d1", "execute", "llm_as_a_server_state", "--local", `--persist-to=${PERSIST}`, "--file=./migrations/0001_runtime.sql", "-y"],
  { cwd: ROOT, encoding: "utf8" },
);

const server = spawn(
  process.execPath,
  [WRANGLER, "pages", "dev", "--port", String(PORT), `--persist-to=${PERSIST}`, "--ip=127.0.0.1"],
  { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
);
let log = "";
server.stdout.on("data", (c) => (log += c));
server.stderr.on("data", (c) => (log += c));
const shutdown = () => {
  try {
    server.kill("SIGTERM");
  } catch {}
};
process.on("exit", shutdown);

try {
  const deadline = Date.now() + 90_000;
  let health = null;
  while (Date.now() < deadline && !health) {
    try {
      const response = await fetch(`${BASE}/__harness/health`);
      if (response.ok) health = await response.json();
    } catch {
      await new Promise((r) => setTimeout(r, 700));
    }
  }
  if (!health) throw new Error("server never became healthy");
  console.log(`providers configured: ${JSON.stringify(health.providers)}\n`);

  // Each request is a separate visitor, so per-session throttling never fires
  // and the only limit in play is the provider's.
  console.log(`firing ${COUNT} requests with no pacing at all\n`);
  console.log(`${"#".padEnd(4)} ${"status".padEnd(7)} ${"provider".padEnd(24)} ${"ms".padEnd(7)} tokens`);
  console.log("-".repeat(78));

  const served = {};
  for (let i = 0; i < COUNT; i++) {
    const started = Date.now();
    const response = await fetch(`${BASE}/page-${i}`);
    await response.text();
    const provider = response.headers.get("x-las-provider") ?? "—";
    const model = response.headers.get("x-las-model") ?? "—";
    // A 404 chosen by the model is a correct response, not a failure. Only the
    // runtime's own error codes count against availability.
    const kernelError = response.status >= 500 || response.status === 429;
    const key = kernelError ? `RUNTIME ${response.status}` : provider.split(" ")[0];
    served[key] = (served[key] ?? 0) + 1;

    console.log(
      `${String(i).padEnd(4)} ${String(response.status).padEnd(7)} ${provider.padEnd(24)} ` +
        `${String(Date.now() - started).padEnd(7)} ${response.headers.get("x-las-tokens") ?? "—"}`,
    );
    if (response.status === 200 && i === 0) console.log(`     model: ${model}`);
    const validation = response.headers.get("x-las-validation");
    if (validation) console.log(`     rejected: ${validation}`);
  }

  console.log("\nserved by:");
  for (const [key, count] of Object.entries(served)) console.log(`  ${key.padEnd(24)} ${count}`);
} catch (error) {
  console.error("burst check failed:", error.message);
  console.error(log.split("\n").slice(-20).join("\n"));
  shutdown();
  process.exit(1);
}

shutdown();
process.exit(0);
