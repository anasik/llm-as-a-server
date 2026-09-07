// Verifies the serving surface through `wrangler pages dev` without spending a
// single provider token: only requests the kernel answers before it would call
// the model, plus the harness endpoints.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 8789);
const BASE = `http://127.0.0.1:${PORT}`;
const PERSIST = join(ROOT, ".wrangler/state");
const WRANGLER = join(ROOT, "node_modules/wrangler/bin/wrangler.js");

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

let failures = 0;
function check(label, condition, detail = "") {
  console.log(`${condition ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures++;
}

try {
  const deadline = Date.now() + 90_000;
  let up = false;
  while (Date.now() < deadline && !up) {
    try {
      up = (await fetch(`${BASE}/__harness/health`)).ok;
    } catch {
      await new Promise((r) => setTimeout(r, 700));
    }
  }
  if (!up) throw new Error("server never became healthy");

  console.log("\n== harness endpoints ==");
  const health = await (await fetch(`${BASE}/__harness/health`)).json();
  check("health reports the state store", health.state_store === "ok");
  check("health reports the provider secret configured", health.provider_secret === "configured");
  check("health reports the storage binding", health.filesystem_binding === "bound");
  check("health leaks no secret value", !JSON.stringify(health).includes("gsk_"));

  const diagnostics = await (await fetch(`${BASE}/__harness/diagnostics`)).json();
  check("diagnostics answers without a session", diagnostics.ok === true);
  check("unknown harness control 404s", (await fetch(`${BASE}/__harness/nonsense`)).status === 404);
  check("attachment without a session 404s", (await fetch(`${BASE}/__harness/attachment?path=/nope.txt`)).status === 404);

  console.log("\n== requests refused before any inference ==");
  const trace = await fetch(`${BASE}/`, { method: "OPTIONS" });
  check("unsupported method is refused", trace.status === 405, `HTTP ${trace.status}`);

  const oversized = await fetch(`${BASE}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ note: "x".repeat(40_000) }),
  });
  check("oversized body is refused", oversized.status === 413, `HTTP ${oversized.status}`);

  const multipart = await fetch(`${BASE}/`, {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=x" },
    body: "--x--",
  });
  check("multipart is refused", multipart.status === 415, `HTTP ${multipart.status}`);

  console.log("\n== what a refused request reveals ==");
  const body = await trace.text();
  check("error page is a plain server page", body.includes("<!doctype html>") && body.includes("405"));
  for (const leak of ["groq", "Groq", "gsk_", "constitution", "harness", "experiment"]) {
    check(`error page does not mention ${leak}`, !body.includes(leak));
  }

  console.log("\n== response headers ==");
  const csp = trace.headers.get("content-security-policy") ?? "";
  check("CSP present", csp.length > 0);
  check("CSP blocks everything by default", csp.includes("default-src 'none'"));
  check("CSP permits the model's own styling", csp.includes("style-src 'unsafe-inline'"));
  check("CSP grants no script source", !csp.includes("script-src"));
  check("nosniff", trace.headers.get("x-content-type-options") === "nosniff");
  check("framing denied", trace.headers.get("x-frame-options") === "DENY");
  check("telemetry travels out of band", trace.headers.get("x-las-filesystem") === "untouched");
  check("telemetry exposes no secret", !JSON.stringify([...trace.headers]).includes("gsk_"));

  console.log("\n== no static assets are served ==");
  // Every path, including ones that look like files, reaches the model rather
  // than a file on disk. Refused here only because it would cost a token.
  check("no client bundle exists", (await fetch(`${BASE}/app.js`)).headers.get("x-las-model") !== null);
  check("no stylesheet exists", (await fetch(`${BASE}/styles.css`)).headers.get("x-las-model") !== null);

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
} catch (error) {
  console.error("smoke check failed:", error.message);
  console.error(log.split("\n").slice(-20).join("\n"));
  failures++;
}

shutdown();
process.exit(failures === 0 ? 0 : 1);
