// The trusted runtime kernel.
//
// It resolves a session, loads an opaque document, asks the model for a state
// transition, validates generic transport/safety properties, persists, and
// serves the result as an ordinary HTTP response. It contains no route table,
// no resource registry, no domain model, and no branch that depends on what the
// requested path means.
import { buildSecondInferenceMessages, buildTransitionMessages } from "./prompt";
import { DEFAULT_GROQ_MODEL, ProviderError, createConfiguredClient, createCooldownStore } from "./providers";
import type { InferenceClient } from "./providers";
import { LIMITS } from "./limits";
import { normalizeIncomingRequest } from "./normalize";
import { sanitizeDocument } from "./sanitize";
import {
  clearedSessionCookie,
  deriveStorageNamespace,
  generateSessionId,
  isSecureRequest,
  readSessionId,
  sessionCookie,
} from "./session";
import { consumeQuota, loadOrCreateSession, resetSessionState, saveState } from "./state";
import { harnessFilesystemAccess, validateModelOutput } from "./validate";
import type { FilesystemAccess } from "./validate";
import { openFilesystem } from "./vfs";
import type { FilesystemGateway, MutationResult } from "./vfs";
import { normalizeVirtualPath } from "./vfspath";
import type { KernelEnv, NormalizedRequest, Telemetry, TokenUsage } from "./types";

// The ordinary transition path is handed this narrowed environment. The bucket
// binding is absent from the type, so no code on that path can reach storage.
export type OrdinaryEnv = Omit<KernelEnv, "VFS_BUCKET">;

export interface KernelDeps {
  inference?: InferenceClient;
  now?: () => number;
  random?: (bytes: number) => Uint8Array;
}

export type ErrorCode =
  | "method_not_allowed"
  | "bad_request"
  | "payload_too_large"
  | "unsupported_media_type"
  | "rate_limited"
  | "provider_error"
  | "provider_timeout"
  | "invalid_model_output"
  | "state_conflict"
  | "state_write_failed"
  | "filesystem_error"
  | "internal_error";

const ERROR_STATUS: Record<ErrorCode, number> = {
  method_not_allowed: 405,
  bad_request: 400,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  provider_error: 502,
  provider_timeout: 504,
  invalid_model_output: 502,
  state_conflict: 409,
  state_write_failed: 500,
  filesystem_error: 500,
  internal_error: 500,
};

// Scripting is impossible; presentation is entirely the model's, so inline
// styles are permitted. Nothing may be fetched from anywhere else.
const CSP =
  "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; " +
  "form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function emptyTelemetry(model: string): Telemetry {
  return {
    method: "",
    path: "",
    status: null,
    model,
    inferences: 0,
    provider: "none",
    provider_attempts: 0,
    latency_ms: 0,
    provider_latency_ms: 0,
    tokens: { prompt: 0, completion: 0, cached: 0, total: 0 },
    state: { version_before: 0, version_after: null, bytes_before: 0, bytes_after: null },
    persistence: { state: "skipped", filesystem: "untouched" },
    filesystem: {
      requested: false,
      necessity_present: false,
      necessity_chars: 0,
      second_inference: false,
      read_ops_attempted: 0,
      read_ops_accepted: 0,
      read_ops_rejected: 0,
      mutations_attempted: 0,
      mutations_accepted: 0,
      mutations_rejected: 0,
      bytes_read: 0,
      bytes_written: 0,
      bytes_deleted: 0,
      r2_calls: 0,
      untouched: true,
    },
    sanitizer: { removed_elements: 0, removed_attributes: 0 },
    validation_failures: [],
  };
}

function addUsage(target: TokenUsage, usage: TokenUsage): void {
  target.prompt += usage.prompt;
  target.completion += usage.completion;
  target.cached += usage.cached;
  target.total += usage.total;
}

// Safe telemetry travels in response headers: observable in devtools or curl,
// invisible on the page. No paths, no contents, no state, no prompt.
function telemetryHeaders(telemetry: Telemetry): Record<string, string> {
  const fs = telemetry.filesystem;
  const headers: Record<string, string> = {
    "x-las-model": telemetry.model,
    "x-las-provider": `${telemetry.provider} attempts=${telemetry.provider_attempts}`,
    "x-las-inferences": String(telemetry.inferences),
    "x-las-latency-ms": String(telemetry.latency_ms),
    "x-las-provider-ms": String(telemetry.provider_latency_ms),
    "x-las-tokens": `prompt=${telemetry.tokens.prompt} completion=${telemetry.tokens.completion} cached=${telemetry.tokens.cached}`,
    "x-las-state": `v${telemetry.state.version_before}->${telemetry.state.version_after ?? "unchanged"} ${telemetry.state.bytes_before}B->${telemetry.state.bytes_after ?? "unchanged"}B`,
    "x-las-persisted": telemetry.persistence.state,
    "x-las-filesystem": fs.untouched
      ? "untouched"
      : [
          telemetry.persistence.filesystem,
          `calls=${fs.r2_calls}`,
          `read_ops=${fs.read_ops_accepted}/${fs.read_ops_attempted}`,
          `mutations=${fs.mutations_accepted}/${fs.mutations_attempted}`,
          `read=${fs.bytes_read}B`,
          `written=${fs.bytes_written}B`,
          `deleted=${fs.bytes_deleted}B`,
          `second_inference=${fs.second_inference}`,
          `necessity_chars=${fs.necessity_chars}`,
        ].join(" "),
    "x-las-sanitizer": `elements=${telemetry.sanitizer.removed_elements} attributes=${telemetry.sanitizer.removed_attributes}`,
  };
  if (telemetry.validation_failures.length > 0) {
    headers["x-las-validation"] = telemetry.validation_failures.join(" ").slice(0, 300);
  }
  return headers;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

// When the runtime itself fails there is no model output to serve. This is the
// only HTML the deterministic layer ever authors, and it is deliberately plain:
// a server having a bad minute, saying so, and nothing more.
function errorDocument(status: number, title: string, detail: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${status} ${escapeHtml(title)}</title></head>
<body>
<h1>${status} ${escapeHtml(title)}</h1>
<p>${escapeHtml(detail)}</p>
<hr>
<p><small>This response came from the runtime, not from the application layer. Nothing was changed.</small></p>
</body>
</html>
`;
}

const ERROR_TEXT: Record<ErrorCode, { title: string; detail: string }> = {
  method_not_allowed: { title: "Method Not Allowed", detail: "This server accepts GET, POST, PUT, PATCH and DELETE." },
  bad_request: { title: "Bad Request", detail: "The request could not be read." },
  payload_too_large: { title: "Payload Too Large", detail: "The request body exceeds this server's limit." },
  unsupported_media_type: { title: "Unsupported Media Type", detail: "This server does not accept that content type." },
  rate_limited: { title: "Too Many Requests", detail: "This server's request budget is momentarily exhausted. Try again shortly." },
  provider_error: { title: "Bad Gateway", detail: "The application layer did not answer." },
  provider_timeout: { title: "Gateway Timeout", detail: "The application layer took too long to answer." },
  invalid_model_output: { title: "Bad Gateway", detail: "The application layer returned a response this server refused to serve." },
  state_conflict: { title: "Conflict", detail: "This session changed while the request was in flight. Nothing was overwritten; try again." },
  state_write_failed: { title: "Internal Server Error", detail: "The session could not be saved, so nothing was committed." },
  filesystem_error: { title: "Internal Server Error", detail: "A storage operation failed, so nothing was committed." },
  internal_error: { title: "Internal Server Error", detail: "This server could not handle the request." },
};

export async function handleSimulatedRequest(
  request: Request,
  env: KernelEnv,
  deps: KernelDeps = {},
): Promise<Response> {
  const now = deps.now ?? (() => Date.now());
  const random = deps.random ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  const startedAt = now();
  const inference = deps.inference ?? createConfiguredClient(env, createCooldownStore(env.STATE_DB));
  const telemetry = emptyTelemetry(inference.model);
  const secure = isSecureRequest(request);

  const existingSession = readSessionId(request);
  const sessionId = existingSession ?? generateSessionId(random);
  const cookie = existingSession ? null : sessionCookie(sessionId, secure);

  const respond = (status: number, body: string, headers: Record<string, string>): Response => {
    telemetry.latency_ms = now() - startedAt;
    telemetry.status = status;
    const out = new Headers({
      ...headers,
      ...telemetryHeaders(telemetry),
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
    });
    if (cookie) out.append("set-cookie", cookie);
    if (!out.has("cache-control")) out.set("cache-control", "no-store");
    return new Response(status === 204 || status === 304 ? null : body, { status, headers: out });
  };

  const fail = (code: ErrorCode, retryAfterSeconds?: number): Response => {
    const status = ERROR_STATUS[code];
    const text = ERROR_TEXT[code];
    const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
    if (retryAfterSeconds) headers["retry-after"] = String(retryAfterSeconds);
    return respond(status, errorDocument(status, text.title, text.detail), headers);
  };

  const normalized = await normalizeIncomingRequest(request);
  if (!normalized.ok) {
    telemetry.validation_failures.push(normalized.reason);
    const code: ErrorCode =
      normalized.status === 405
        ? "method_not_allowed"
        : normalized.status === 413
          ? "payload_too_large"
          : normalized.status === 415
            ? "unsupported_media_type"
            : "bad_request";
    return fail(code);
  }
  const simulatedRequest: NormalizedRequest = normalized.value;
  telemetry.method = simulatedRequest.method;
  telemetry.path = simulatedRequest.path;

  // Abuse control before any provider spend.
  let quota;
  try {
    quota = await consumeQuota(env.STATE_DB, sessionId, startedAt);
  } catch {
    return fail("internal_error");
  }
  if (!quota.allowed) return fail("rate_limited", quota.retryAfterSeconds);

  let session;
  try {
    session = await loadOrCreateSession(env.STATE_DB, sessionId, startedAt);
  } catch {
    return fail("internal_error");
  }
  telemetry.state.version_before = session.version;
  telemetry.state.bytes_before = byteLength(session.stateJson);

  // ---- first inference -------------------------------------------------
  let first;
  try {
    first = await inference.infer(buildTransitionMessages(session.stateJson, simulatedRequest));
  } catch (error) {
    // Every provider that was tried counts, including the ones that failed.
    telemetry.provider_attempts = attemptsOf(error);
    const failure = providerFailure(error);
    return fail(failure.code, failure.retryAfterSeconds);
  }
  telemetry.inferences = 1;
  telemetry.provider_latency_ms += first.latencyMs;
  telemetry.provider = first.provider;
  telemetry.model = first.model;
  telemetry.provider_attempts = first.attempts;
  addUsage(telemetry.tokens, first.usage);

  let validated = validateModelOutput(first.text, { allowFilesystemRequest: true });

  // A rejected transition is not a transport failure, so the router has already
  // returned successfully and would otherwise never be consulted again. Since
  // rate-limit buckets are per-model, the chain usually has another model with
  // its own budget sitting idle — and a different model rarely makes the same
  // mistake. One retry, then the visitor gets the error honestly.
  if (!validated.ok) {
    telemetry.validation_failures.push(...validated.failures);
    let retried;
    try {
      retried = await inference.infer(buildTransitionMessages(session.stateJson, simulatedRequest), {
        exclude: new Set([first.key]),
      });
    } catch {
      return fail("invalid_model_output");
    }
    telemetry.inferences = 2;
    telemetry.provider_latency_ms += retried.latencyMs;
    telemetry.provider = retried.provider;
    telemetry.model = retried.model;
    telemetry.provider_attempts += retried.attempts;
    addUsage(telemetry.tokens, retried.usage);

    const second = validateModelOutput(retried.text, { allowFilesystemRequest: true });
    if (!second.ok) {
      telemetry.validation_failures.push(...second.failures);
      return fail("invalid_model_output");
    }
    validated = second;
  }

  // ---- exceptional filesystem read round trip --------------------------
  let gateway: FilesystemGateway | null = null;
  const openGateway = async (grant: FilesystemAccess): Promise<FilesystemGateway> => {
    if (gateway) return gateway;
    const namespace = await deriveStorageNamespace(sessionId, env.VFS_NAMESPACE_SALT);
    gateway = openFilesystem(env.VFS_BUCKET, namespace, grant);
    return gateway;
  };

  if (validated.value.transition.kind === "filesystem_request") {
    const fsRequest = validated.value.transition.request;
    telemetry.filesystem.requested = true;
    telemetry.filesystem.necessity_present = fsRequest.necessity.length > 0;
    telemetry.filesystem.necessity_chars = fsRequest.necessity.length;
    telemetry.filesystem.read_ops_attempted = fsRequest.operations.length;

    let results;
    try {
      const fs = await openGateway(validated.value.access!);
      results = await fs.executeReads(fsRequest.operations);
      telemetry.filesystem.read_ops_accepted = results.accepted;
      telemetry.filesystem.read_ops_rejected = results.rejected;
      telemetry.filesystem.bytes_read = fs.bytesRead;
      telemetry.filesystem.r2_calls = fs.calls;
      telemetry.filesystem.untouched = fs.calls === 0;
    } catch {
      return fail("filesystem_error");
    }

    let second;
    try {
      second = await inference.infer(
        buildSecondInferenceMessages(session.stateJson, simulatedRequest, fsRequest, results.results),
      );
    } catch (error) {
      telemetry.provider_attempts += attemptsOf(error);
      const failure = providerFailure(error);
      return fail(failure.code, failure.retryAfterSeconds);
    }
    telemetry.inferences = 2;
    telemetry.filesystem.second_inference = true;
    telemetry.provider_latency_ms += second.latencyMs;
    telemetry.provider_attempts += second.attempts;
    addUsage(telemetry.tokens, second.usage);

    // Recursion is refused here: the second turn may not ask for storage again.
    validated = validateModelOutput(second.text, { allowFilesystemRequest: false });
    if (!validated.ok) {
      telemetry.validation_failures.push(...validated.failures);
      return fail("invalid_model_output");
    }
  }

  if (validated.value.transition.kind !== "final") {
    telemetry.validation_failures.push("output.kind_invalid");
    return fail("invalid_model_output");
  }
  const final = validated.value.transition;

  // ---- persistence ------------------------------------------------------
  // There is no cross-service transaction. Mutations are applied first so that
  // a failed state write leaves objects nothing refers to, and newly created
  // objects are then compensated. Overwrites and deletes are irreversible and
  // reported as such. See README, "consistency limitations".
  let mutationResults: MutationResult[] = [];
  if (final.mutations.length > 0) {
    telemetry.filesystem.mutations_attempted = final.mutations.length;
    // Each mutation carries its own justification; report the shortest, since
    // that is the weakest claim the transition rests on.
    const shortest = Math.min(...final.mutations.map((mutation) => mutation.necessity.length));
    telemetry.filesystem.necessity_present = shortest > 0;
    telemetry.filesystem.necessity_chars = Math.max(telemetry.filesystem.necessity_chars, shortest);
    try {
      const fs = await openGateway(validated.value.access ?? harnessFilesystemAccess());
      mutationResults = await fs.applyMutations(final.mutations);
      telemetry.filesystem.mutations_accepted = mutationResults.filter((r) => r.applied).length;
      telemetry.filesystem.mutations_rejected = mutationResults.filter((r) => !r.applied).length;
      telemetry.filesystem.bytes_written = fs.bytesWritten;
      telemetry.filesystem.bytes_deleted = fs.bytesDeleted;
      telemetry.filesystem.r2_calls = fs.calls;
      telemetry.filesystem.untouched = fs.calls === 0;
      telemetry.persistence.filesystem =
        telemetry.filesystem.mutations_rejected === 0
          ? "applied"
          : telemetry.filesystem.mutations_accepted > 0
            ? "partial"
            : "failed";
    } catch {
      telemetry.persistence.filesystem = "failed";
      return fail("filesystem_error");
    }
  }

  // A transition that changed nothing is not written back. Reading a page
  // should cost no storage write and no version bump: churning the version on
  // every read would also manufacture conflicts between concurrent readers.
  const unchanged = final.nextStateJson === null || final.nextStateJson === session.stateJson;
  const outcome = unchanged
    ? "unchanged"
    : await saveState(env.STATE_DB, sessionId, final.nextStateJson!, session.version, now());
  telemetry.persistence.state = outcome;
  if (outcome !== "ok" && outcome !== "unchanged") {
    if (mutationResults.some((r) => r.applied)) {
      try {
        const fs = await openGateway(harnessFilesystemAccess());
        const compensation = await fs.compensate(mutationResults);
        telemetry.filesystem.r2_calls = fs.calls;
        telemetry.persistence.filesystem = compensation.irreversible > 0 ? "partial" : "compensated";
      } catch {
        telemetry.persistence.filesystem = "partial";
      }
    }
    return fail(outcome === "conflict" ? "state_conflict" : "state_write_failed");
  }
  telemetry.state.version_after = unchanged ? session.version : session.version + 1;
  telemetry.state.bytes_after = byteLength(final.nextStateJson ?? session.stateJson);

  // ---- serve the model's response --------------------------------------
  const headers: Record<string, string> = {};
  for (const header of final.response.headers) headers[header.name] = header.value;
  if (!headers["content-type"]) headers["content-type"] = "text/html; charset=utf-8";

  let body = final.response.body;
  if (headers["content-type"].toLowerCase().includes("text/html")) {
    const sanitized = await sanitizeDocument(body);
    body = sanitized.html;
    telemetry.sanitizer.removed_elements = sanitized.removedElements;
    telemetry.sanitizer.removed_attributes = sanitized.removedAttributes;
  }

  return respond(final.response.status, body, headers);
}

// A routed failure knows how many providers it burned through before giving up.
function attemptsOf(error: unknown): number {
  return error instanceof ProviderError && typeof error.attempts === "number" ? error.attempts : 1;
}

// Provider failures are reported by cause. A provider-side rate limit is a rate
// limit, not an opaque upstream error: the visitor can retry, and the provider
// tells us roughly when.
function providerFailure(error: unknown): { code: ErrorCode; retryAfterSeconds?: number } {
  if (!(error instanceof ProviderError)) return { code: "provider_error" };
  if (error.code === "provider_timeout") return { code: "provider_timeout" };
  if (error.code === "provider_rate_limited") {
    return { code: "rate_limited", ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}) };
  }
  return { code: "provider_error" };
}

// ---- harness -----------------------------------------------------------
// Deterministic experiment controls, namespaced so they can never be confused
// with the simulated website. No application semantics live here: these
// endpoints do not know what any page or concept is, only how to report runtime
// health, wipe a session, and hand back bytes the visitor asked for.

export async function handleHarnessHealth(env: KernelEnv, deps: KernelDeps = {}): Promise<Response> {
  const groqConfigured = typeof env.GROQ_API_KEY === "string" && env.GROQ_API_KEY.length > 0;
  const openrouterConfigured = typeof env.OPENROUTER_API_KEY === "string" && env.OPENROUTER_API_KEY.length > 0;
  const geminiConfigured = typeof env.GEMINI_API_KEY === "string" && env.GEMINI_API_KEY.length > 0;
  let stateOk = false;
  try {
    await env.STATE_DB.prepare("SELECT 1").first();
    stateOk = true;
  } catch {
    stateOk = false;
  }
  return Response.json(
    {
      ok: stateOk && (groqConfigured || geminiConfigured || openrouterConfigured),
      providers: (env.LLM_PROVIDERS ?? "groq,gemini,openrouter")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
          const separator = entry.indexOf(":");
          const name = (separator < 0 ? entry : entry.slice(0, separator)).toLowerCase();
          return {
          name,
          model: separator < 0 ? null : entry.slice(separator + 1),
          configured:
            (name === "groq" && Boolean(env.GROQ_API_KEY)) ||
            (name === "gemini" && Boolean(env.GEMINI_API_KEY)) ||
            (name === "openrouter" && Boolean(env.OPENROUTER_API_KEY)),
          };
        }),
      model: env.GROQ_MODEL ?? DEFAULT_GROQ_MODEL,
      state_store: stateOk ? "ok" : "unavailable",
      provider_secret: groqConfigured || geminiConfigured || openrouterConfigured ? "configured" : "missing",
      filesystem_binding: env.VFS_BUCKET ? "bound" : "absent",
      limits: LIMITS,
      time: (deps.now ?? Date.now)(),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function handleHarnessReset(request: Request, env: KernelEnv, deps: KernelDeps = {}): Promise<Response> {
  const now = (deps.now ?? (() => Date.now()))();
  const sessionId = readSessionId(request);
  const url = new URL(request.url);
  const includeFiles = url.searchParams.get("files") !== "0";

  if (!sessionId) {
    return new Response(errorDocument(200, "No session", "There was nothing to reset."), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  await resetSessionState(env.STATE_DB, sessionId, now);
  let filesDeleted: number | null = null;
  if (includeFiles) {
    const namespace = await deriveStorageNamespace(sessionId, env.VFS_NAMESPACE_SALT);
    filesDeleted = await openFilesystem(env.VFS_BUCKET, namespace, harnessFilesystemAccess()).deleteNamespace();
  }

  // Send the visitor back to the site with a brand-new anonymous session.
  return new Response(null, {
    status: 303,
    headers: {
      location: "/",
      "cache-control": "no-store",
      "set-cookie": clearedSessionCookie(isSecureRequest(request)),
      "x-las-reset": `state=cleared files_deleted=${filesDeleted ?? 0}`,
    },
  });
}

export async function handleHarnessDiagnostics(request: Request, env: KernelEnv, deps: KernelDeps = {}): Promise<Response> {
  const now = (deps.now ?? (() => Date.now()))();
  const sessionId = readSessionId(request);
  if (!sessionId) {
    return Response.json({ ok: true, session: "absent" }, { headers: { "cache-control": "no-store" } });
  }
  const session = await loadOrCreateSession(env.STATE_DB, sessionId, now);
  return Response.json(
    {
      ok: true,
      session: "present",
      state_version: session.version,
      state_bytes: byteLength(session.stateJson),
      state_limit_bytes: LIMITS.stateBytes,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

// Generic attachment delivery. Session-scoped by the cookie-derived namespace,
// so a path from another session simply does not resolve. Bytes are always
// handed back inert; nothing stored is ever rendered inline or interpreted.
export async function handleHarnessAttachment(request: Request, env: KernelEnv): Promise<Response> {
  const notFound = () =>
    new Response(errorDocument(404, "Not Found", "No such file."), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });

  const sessionId = readSessionId(request);
  if (!sessionId) return notFound();

  const url = new URL(request.url);
  const checked = normalizeVirtualPath(url.searchParams.get("path"));
  if (!checked.ok) return notFound();

  const namespace = await deriveStorageNamespace(sessionId, env.VFS_NAMESPACE_SALT);
  const stored = await openFilesystem(env.VFS_BUCKET, namespace, harnessFilesystemAccess()).fetchForDownload(checked.path);
  if (!stored) return notFound();

  const filename = checked.path.split("/").pop() || "attachment";
  return new Response(stored.bytes, {
    status: 200,
    headers: {
      // Always inert: active content is never served with its own type.
      "content-type": stored.active ? "application/octet-stream" : stored.contentType,
      "content-disposition": `attachment; filename="${filename.replace(/["\\]/g, "")}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "no-store",
    },
  });
}
