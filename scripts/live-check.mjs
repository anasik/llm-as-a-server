// Local end-to-end check against the real provider.
//
// Boots `wrangler pages dev` with local D1 and R2, then drives the site the way
// a browser or curl would: ordinary requests to ordinary URLs. Everything the
// server returns was decided by the model; the only thing this script reads out
// of band is the x-las-* telemetry.
//
// Nothing here is deployed. Everything runs on localhost.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 8788);
const BASE = `http://127.0.0.1:${PORT}`;
const PERSIST = join(ROOT, ".wrangler/state");
const WRANGLER = join(ROOT, "node_modules/wrangler/bin/wrangler.js");

// The free provider tier allows 8,000 tokens/minute and one request costs
// roughly 4,000, so this paces itself to about two requests a minute rather
// than fighting the limiter.
const PACE_MS = Number(process.env.PACE_MS ?? 32_000);
let lastRequestAt = 0;
let cookie = null;

function line(char = "=") {
  console.log(char.repeat(78));
}

async function pace() {
  const wait = lastRequestAt === 0 ? 0 : Math.max(0, PACE_MS - (Date.now() - lastRequestAt));
  if (wait > 0) {
    process.stdout.write(`    (pacing ${Math.round(wait / 1000)}s for the provider's token budget)\r`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  lastRequestAt = Date.now();
}

async function visit(method, path, { form, json, redirect = "manual" } = {}) {
  await pace();
  const headers = {};
  if (cookie) headers.cookie = cookie;
  let body;
  if (form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(form).toString();
  } else if (json) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(json);
  }

  const started = Date.now();
  let response = await fetch(BASE + path, { method, headers, body, redirect });

  // One backoff retry if the provider's token bucket is still refilling.
  for (let attempt = 0; attempt < 2 && response.status === 429; attempt++) {
    const wait = Math.min(60, Number(response.headers.get("retry-after")) || 30);
    process.stdout.write(`    (provider rate limited; waiting ${wait}s)\r`);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000 + 1500));
    lastRequestAt = Date.now();
    response = await fetch(BASE + path, { method, headers, body, redirect });
  }

  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await response.text();
  const h = (name) => response.headers.get(name) ?? "—";

  console.log(`\n--> ${method} ${path}${form ? ` (form ${JSON.stringify(form)})` : json ? ` ${JSON.stringify(json)}` : ""}`);
  console.log(
    `<-- HTTP ${response.status} ${h("content-type")}` +
      `${response.headers.get("location") ? ` -> ${h("location")}` : ""}  ${text.length} bytes`,
  );
  if (text.length > 0) {
    const preview = text.replace(/\s+/g, " ").slice(0, 140);
    console.log(`    ${preview}${text.length > 140 ? "…" : ""}`);
  }
  console.log(`    state ${h("x-las-state")}  persisted=${h("x-las-persisted")}`);
  console.log(
    `    inferences=${h("x-las-inferences")}  ${Date.now() - started}ms wall / ${h("x-las-provider-ms")}ms provider  tokens ${h("x-las-tokens")}`,
  );
  console.log(`    sanitizer removed ${h("x-las-sanitizer")}`);
  console.log(`    filesystem: ${h("x-las-filesystem").toUpperCase()}`);
  if (response.headers.get("x-las-validation")) {
    console.log(`    VALIDATION FAILURES: ${h("x-las-validation")}`);
  }
  return { response, text };
}

// ---- migrations against the local D1 store -------------------------------
console.log("== applying migrations to local D1 ==");
spawnSync(
  process.execPath,
  [WRANGLER, "d1", "execute", "llm_as_a_server_state", "--local", `--persist-to=${PERSIST}`, "--file=./migrations/0001_runtime.sql", "-y"],
  { cwd: ROOT, encoding: "utf8" },
);

console.log("== starting wrangler pages dev (local) ==");
const server = spawn(
  process.execPath,
  [WRANGLER, "pages", "dev", "--port", String(PORT), `--persist-to=${PERSIST}`, "--ip=127.0.0.1"],
  { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
);
let serverLog = "";
server.stdout.on("data", (chunk) => (serverLog += chunk));
server.stderr.on("data", (chunk) => (serverLog += chunk));
const shutdown = () => {
  try {
    server.kill("SIGTERM");
  } catch {}
};
process.on("exit", shutdown);
process.on("SIGINT", () => {
  shutdown();
  process.exit(130);
});

try {
  const deadline = Date.now() + 90_000;
  let health = null;
  while (Date.now() < deadline && !health) {
    try {
      const response = await fetch(`${BASE}/__harness/health`);
      if (response.ok) health = await response.json();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  }
  if (!health) throw new Error("wrangler pages dev did not become healthy in time");
  console.log(`health: state_store=${health.state_store} provider_secret=${health.provider_secret} model=${health.model}`);

  const only = process.env.ONLY ?? "all";

  if (only === "short") {
    line();
    console.log("SHORT DIAGNOSTIC SEQUENCE");
    line();
    await visit("POST", "/concepts", { form: { title: "Kettle", note: "boils water" } });
    await visit("GET", "/concepts");
    await visit("PATCH", "/concepts/kettle", { json: { note: "boils 1.7 litres" } });
    console.log("\n== done ==");
    shutdown();
    process.exit(0);
  }

  if (only === "all") {
    line();
    console.log("ORDINARY BROWSING — real HTTP, real status codes, filesystem untouched");
    line();
    const home = await visit("GET", "/");
    // Follow a link the model actually put on its own homepage.
    const link = home.text.match(/href="(\/[^"#?]{1,60})"/)?.[1];
    console.log(`\n(following a link the model itself generated: ${link ?? "none found"})`);
    if (link) await visit("GET", link);
    await visit("GET", "/a/path/nobody/has/ever/requested");

    line();
    console.log("CREATING AND EDITING — through ordinary forms and API methods");
    line();
    await visit("POST", "/concepts", { form: { title: "Kettle", note: "boils water" } });
    await visit("GET", "/concepts");
    await visit("PATCH", "/concepts/kettle", { json: { note: "boils 1.7 litres" } });
    await visit("DELETE", "/concepts/kettle");
  }

  line();
  console.log("EXCEPTIONAL — an explicit file artifact");
  line();
  const exported = await visit("POST", "/exports", {
    form: { format: "csv", note: "Please write my concepts to a downloadable CSV file and link it." },
  });
  const download = exported.text.match(/\/__harness\/attachment\?path=[^"'&\s]+/)?.[0];
  if (download) {
    const file = await fetch(BASE + download.replace(/&amp;/g, "&"), { headers: { cookie } });
    const bytes = await file.arrayBuffer();
    console.log(`\n--> GET ${download}`);
    console.log(
      `<-- HTTP ${file.status} ${file.headers.get("content-type")} ${file.headers.get("content-disposition")} ` +
        `nosniff=${file.headers.get("x-content-type-options")} ${bytes.byteLength} bytes`,
    );
    if (file.ok) console.log(`    ${new TextDecoder().decode(bytes).slice(0, 200)}`);
    else console.log("    (the model advertised a file it did not write — the server returns a genuine 404)");
  } else {
    console.log("\n(the model produced no download link)");
  }

  if (only === "all") {
    line();
    console.log("SESSION ISOLATION — a fresh visitor sees none of the above");
    line();
    const previous = cookie;
    cookie = null;
    await visit("GET", "/concepts");
    cookie = previous;
  }

  console.log("\n== done ==");
} catch (error) {
  console.error("\n!! live check failed:", error.message);
  console.error(serverLog.split("\n").slice(-25).join("\n"));
  shutdown();
  process.exit(1);
}

shutdown();
process.exit(0);
