// Turns a real incoming HTTP request into the normalized request the model
// sees. This is transport normalization only: nothing here knows or decides
// what any path, method or body *means*.
import { LIMITS, REQUEST_HEADER_ALLOWLIST } from "./limits";
import type { JsonValue, NormalizedRequest, SimulatedMethod } from "./types";

const METHODS: SimulatedMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export type NormalizeResult =
  | { ok: true; value: NormalizedRequest }
  | { ok: false; reason: string; status: number };

export function normalizePath(input: string): { ok: true; path: string } | { ok: false; reason: string } {
  if (input.length === 0) return { ok: false, reason: "path_empty" };
  if (input.length > LIMITS.simulatedPathChars) return { ok: false, reason: "path_too_long" };
  if (CONTROL_CHARS.test(input)) return { ok: false, reason: "path_control_char" };
  if (!input.startsWith("/")) return { ok: false, reason: "path_not_absolute" };

  const segments: string[] = [];
  for (const raw of input.split("/")) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") {
      // Refuse rather than silently resolving above the root.
      if (segments.length === 0) return { ok: false, reason: "path_escapes_root" };
      segments.pop();
      continue;
    }
    segments.push(raw);
  }
  const trailingSlash = input.length > 1 && input.endsWith("/");
  const path = "/" + segments.join("/") + (trailingSlash && segments.length > 0 ? "/" : "");
  return { ok: true, path };
}

function normalizeQuery(source: URLSearchParams): Record<string, string | string[]> | null {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of source) {
    if (key.length === 0 || key.length > 64) continue;
    if (CONTROL_CHARS.test(key) || CONTROL_CHARS.test(value)) continue;
    const clipped = value.slice(0, LIMITS.simulatedQueryValueChars);
    const existing = out[key];
    if (existing === undefined) out[key] = clipped;
    else if (Array.isArray(existing)) existing.push(clipped);
    else out[key] = [existing, clipped];
  }
  return Object.keys(out).length > LIMITS.simulatedQueryCount ? null : out;
}

// Only an allowlisted subset of client headers reaches the model. Cookies,
// credentials and platform headers are never forwarded.
function normalizeHeaders(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of REQUEST_HEADER_ALLOWLIST) {
    if (Object.keys(out).length >= LIMITS.simulatedHeaderCount) break;
    const value = request.headers.get(name);
    if (value === null || CONTROL_CHARS.test(value)) continue;
    out[name] = value.slice(0, LIMITS.simulatedHeaderValueChars);
  }
  return out;
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 24) return false;
  if (value === null) return true;
  const t = typeof value;
  if (t === "string" || t === "boolean") return true;
  if (t === "number") return Number.isFinite(value as number);
  if (Array.isArray(value)) return value.every((v) => isJsonValue(v, depth + 1));
  if (t === "object") return Object.values(value as object).every((v) => isJsonValue(v, depth + 1));
  return false;
}

async function readBody(request: Request): Promise<{ ok: true; body: JsonValue } | { ok: false; reason: string; status: number }> {
  if (request.method === "GET" || request.method === "HEAD") return { ok: true, body: null };

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > LIMITS.clientRequestBytes) {
    return { ok: false, reason: "request_body_too_large", status: 413 };
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return { ok: false, reason: "request_body_unreadable", status: 400 };
  }
  if (raw.length === 0) return { ok: true, body: null };
  if (new TextEncoder().encode(raw).length > LIMITS.clientRequestBytes) {
    return { ok: false, reason: "request_body_too_large", status: 413 };
  }

  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();

  if (contentType.includes("application/json")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isJsonValue(parsed)) return { ok: false, reason: "body_not_json", status: 400 };
      return { ok: true, body: parsed };
    } catch {
      return { ok: false, reason: "body_not_json", status: 400 };
    }
  }

  // An ordinary HTML form. Decoded into an object so the model sees fields,
  // not an encoding; the kernel attaches no meaning to any field name.
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const fields: Record<string, JsonValue> = {};
    for (const [key, value] of new URLSearchParams(raw)) {
      if (key.length > 64 || CONTROL_CHARS.test(key)) continue;
      const clipped = value.slice(0, LIMITS.simulatedBodyChars);
      const existing = fields[key];
      if (existing === undefined) fields[key] = clipped;
      else if (Array.isArray(existing)) existing.push(clipped);
      else fields[key] = [existing as string, clipped];
    }
    return { ok: true, body: fields };
  }

  if (contentType.includes("multipart/form-data")) {
    // File uploads are outside this experiment's scope, and accepting them
    // would smuggle a storage path into the ordinary request lifecycle.
    return { ok: false, reason: "multipart_unsupported", status: 415 };
  }

  return { ok: true, body: raw.slice(0, LIMITS.simulatedBodyChars) };
}

export async function normalizeIncomingRequest(request: Request): Promise<NormalizeResult> {
  const method = request.method.toUpperCase();
  if (!METHODS.includes(method as SimulatedMethod)) {
    return { ok: false, reason: "method_unsupported", status: 405 };
  }

  const url = new URL(request.url);
  const path = normalizePath(decodeURIComponent(url.pathname));
  if (!path.ok) return { ok: false, reason: path.reason, status: 400 };

  const query = normalizeQuery(url.searchParams);
  if (query === null) return { ok: false, reason: "too_many_query_params", status: 400 };

  const body = await readBody(request);
  if (!body.ok) return { ok: false, reason: body.reason, status: body.status };

  return {
    ok: true,
    value: {
      method: method as SimulatedMethod,
      path: path.path,
      query,
      headers: normalizeHeaders(request),
      body: body.body,
    },
  };
}
