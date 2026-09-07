// The generic validation boundary.
//
// Everything checked here is transport, serializability, size, isolation or
// safety. Nothing here inspects what `next_state` means, what a path refers to,
// or what a page says. If any check fails, the caller must persist nothing.
import { LIMITS, PROHIBITED_RESPONSE_HEADER_PREFIXES, RESPONSE_HEADER_ALLOWLIST } from "./limits";
import { isAllowedMime, normalizeVirtualDir, normalizeVirtualPath } from "./vfspath";
import type { FinalTransition, FsMutation, FsReadOp, FsRequest, ModelTransition } from "./types";

export type Validated<T> = { ok: true; value: T } | { ok: false; failures: string[] };

const HEADER_NAME = /^[a-z0-9-]{1,64}$/;
const HEADER_VALUE_UNSAFE = /[\x00-\x1f\x7f]/;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

// A capability token. The symbol is module-private, so a `FilesystemAccess`
// value cannot be constructed anywhere except by the validators below — which
// only mint one after a concrete necessity statement and a well-formed generic
// operation set have been accepted. The R2 adapter refuses to run without one.
declare const FS_ACCESS_BRAND: unique symbol;
export interface FilesystemAccess {
  readonly [FS_ACCESS_BRAND]: true;
  readonly mode: "read" | "mutate" | "harness";
  readonly necessityChars: number;
}
function mintAccess(mode: "read" | "mutate", necessity: string): FilesystemAccess {
  return { mode, necessityChars: necessity.length } as unknown as FilesystemAccess;
}

// The deterministic harness needs storage access for two operator actions the
// model is not involved in at all: downloading a stored file the visitor asked
// for, and wiping a session's namespace on reset. Kept as a separate, named,
// auditable mint so it can never be mistaken for the model-driven path.
export function harnessFilesystemAccess(): FilesystemAccess {
  return { mode: "harness", necessityChars: 0 } as unknown as FilesystemAccess;
}

function checkNecessity(value: unknown, label: string, failures: string[]): string | null {
  if (typeof value !== "string") {
    failures.push(`${label}.necessity_missing`);
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length < LIMITS.necessityMinChars) {
    failures.push(`${label}.necessity_too_short`);
    return null;
  }
  if (trimmed.length > LIMITS.necessityMaxChars) {
    failures.push(`${label}.necessity_too_long`);
    return null;
  }
  return trimmed;
}

function validateResponse(input: unknown, failures: string[]) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    failures.push("response.missing");
    return null;
  }
  const raw = input as Record<string, unknown>;

  const status = raw.status;
  if (typeof status !== "number" || !Number.isInteger(status)) {
    failures.push("response.status_not_integer");
    return null;
  }
  if (status < LIMITS.statusMin || status > LIMITS.statusMax) {
    failures.push("response.status_out_of_range");
    return null;
  }

  if (typeof raw.body !== "string") {
    failures.push("response.body_not_string");
    return null;
  }
  if (byteLength(raw.body) > LIMITS.responseBodyBytes) {
    failures.push("response.body_too_large");
    return null;
  }

  const headers: { name: string; value: string }[] = [];
  const rawHeaders = raw.headers === null || raw.headers === undefined ? [] : raw.headers;
  if (!Array.isArray(rawHeaders)) {
    failures.push("response.headers_not_array");
    return null;
  }
  if (rawHeaders.length > LIMITS.responseHeaderCount) {
    failures.push("response.too_many_headers");
    return null;
  }
  const seen = new Set<string>();
  for (const entry of rawHeaders) {
    if (!entry || typeof entry !== "object") {
      failures.push("response.header_not_object");
      return null;
    }
    const { name, value } = entry as Record<string, unknown>;
    if (typeof name !== "string" || typeof value !== "string") {
      failures.push("response.header_not_string");
      return null;
    }
    const lower = name.toLowerCase().trim();
    if (!HEADER_NAME.test(lower)) {
      failures.push("response.header_name_invalid");
      return null;
    }
    if (PROHIBITED_RESPONSE_HEADER_PREFIXES.some((p) => lower === p || lower.startsWith(p))) {
      failures.push("response.header_prohibited");
      return null;
    }
    if (!RESPONSE_HEADER_ALLOWLIST.has(lower)) {
      failures.push("response.header_not_allowlisted");
      return null;
    }
    if (HEADER_VALUE_UNSAFE.test(value) || value.length > LIMITS.responseHeaderValueChars) {
      failures.push("response.header_value_invalid");
      return null;
    }
    if (seen.has(lower)) {
      failures.push("response.header_duplicate");
      return null;
    }
    seen.add(lower);
    headers.push({ name: lower, value: value.trim() });
  }

  if (REDIRECT_STATUSES.has(status) && !seen.has("location")) {
    failures.push("response.redirect_without_location");
    return null;
  }

  return { status, headers, body: raw.body };
}

// Returns the canonical document, or UNCHANGED when the model declined to
// change anything. `null` is a first-class answer here: a read should not have
// to re-serialize a document it did not touch.
const UNCHANGED = Symbol("state_unchanged");

function validateNextState(input: unknown, failures: string[]): string | typeof UNCHANGED | null {
  if (input === null || input === undefined) return UNCHANGED;
  if (typeof input !== "string") {
    failures.push("next_state.not_string");
    return null;
  }
  if (byteLength(input) > LIMITS.stateBytes) {
    failures.push("next_state.too_large");
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    failures.push("next_state.not_json");
    return null;
  }
  let canonical: string;
  try {
    canonical = JSON.stringify(parsed);
  } catch {
    failures.push("next_state.not_serializable");
    return null;
  }
  if (canonical === undefined) {
    failures.push("next_state.not_serializable");
    return null;
  }
  if (byteLength(canonical) > LIMITS.stateBytes) {
    failures.push("next_state.too_large");
    return null;
  }
  return canonical;
}

export function validateMutations(input: unknown, failures: string[]): FsMutation[] | null {
  if (input === null || input === undefined) return [];
  if (!Array.isArray(input)) {
    failures.push("filesystem_mutations.not_array");
    return null;
  }
  if (input.length > LIMITS.fsMutationsPerRequest) {
    failures.push("filesystem_mutations.too_many");
    return null;
  }
  const out: FsMutation[] = [];
  const paths = new Set<string>();
  for (const entry of input) {
    if (!entry || typeof entry !== "object") {
      failures.push("filesystem_mutations.entry_not_object");
      return null;
    }
    const raw = entry as Record<string, unknown>;
    if (raw.op !== "write" && raw.op !== "delete") {
      failures.push("filesystem_mutations.op_invalid");
      return null;
    }
    const path = normalizeVirtualPath(raw.path);
    if (!path.ok) {
      failures.push(`filesystem_mutations.${path.reason}`);
      return null;
    }
    if (paths.has(path.path)) {
      failures.push("filesystem_mutations.duplicate_path");
      return null;
    }
    paths.add(path.path);

    const necessity = checkNecessity(raw.necessity, "filesystem_mutations", failures);
    if (necessity === null) return null;

    if (raw.op === "write") {
      const encoding = raw.encoding === null || raw.encoding === undefined ? "utf8" : raw.encoding;
      if (encoding !== "utf8" && encoding !== "base64") {
        failures.push("filesystem_mutations.encoding_invalid");
        return null;
      }
      if (typeof raw.content !== "string") {
        failures.push("filesystem_mutations.content_missing");
        return null;
      }
      const contentType =
        raw.content_type === null || raw.content_type === undefined ? "text/plain" : raw.content_type;
      if (typeof contentType !== "string" || !isAllowedMime(contentType)) {
        failures.push("filesystem_mutations.content_type_not_allowlisted");
        return null;
      }
      out.push({
        op: "write",
        path: path.path,
        encoding,
        content: raw.content,
        content_type: contentType.toLowerCase().split(";")[0]!.trim(),
        necessity,
      });
    } else {
      out.push({ op: "delete", path: path.path, encoding: null, content: null, content_type: null, necessity });
    }
  }
  return out;
}

export function validateFilesystemRequest(input: unknown, failures: string[]): FsRequest | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    failures.push("filesystem_request.missing");
    return null;
  }
  const raw = input as Record<string, unknown>;
  const necessity = checkNecessity(raw.necessity, "filesystem_request", failures);
  if (necessity === null) return null;

  if (!Array.isArray(raw.operations) || raw.operations.length === 0) {
    failures.push("filesystem_request.operations_empty");
    return null;
  }
  if (raw.operations.length > LIMITS.fsReadOpsPerRequest) {
    failures.push("filesystem_request.too_many_operations");
    return null;
  }
  const operations: FsReadOp[] = [];
  for (const entry of raw.operations) {
    if (!entry || typeof entry !== "object") {
      failures.push("filesystem_request.operation_not_object");
      return null;
    }
    const op = (entry as Record<string, unknown>).op;
    if (op !== "list" && op !== "stat" && op !== "read") {
      failures.push("filesystem_request.op_invalid");
      return null;
    }
    const rawPath = (entry as Record<string, unknown>).path;
    const checked = op === "list" ? normalizeVirtualDir(rawPath) : normalizeVirtualPath(rawPath);
    if (!checked.ok) {
      failures.push(`filesystem_request.${checked.reason}`);
      return null;
    }
    const rawLimit = (entry as Record<string, unknown>).limit;
    const rawMax = (entry as Record<string, unknown>).max_bytes;
    const limit =
      typeof rawLimit === "number" && Number.isInteger(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, LIMITS.fsListLimit)
        : LIMITS.fsListLimit;
    const maxBytes =
      typeof rawMax === "number" && Number.isInteger(rawMax) && rawMax > 0
        ? Math.min(rawMax, LIMITS.fsReadBytes)
        : LIMITS.fsReadBytes;
    operations.push({ op, path: checked.path, limit, max_bytes: maxBytes } as FsReadOp);
  }
  return { necessity, operations };
}

export interface ValidatedTransition {
  transition: ModelTransition;
  // Present only when storage access has actually been authorized.
  access: FilesystemAccess | null;
}

export function validateModelOutput(
  text: string,
  options: { allowFilesystemRequest: boolean },
): Validated<ValidatedTransition> {
  const failures: string[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, failures: ["output.not_json"] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, failures: ["output.not_object"] };
  }
  const raw = parsed as Record<string, unknown>;

  if (raw.kind === "filesystem_request") {
    if (!options.allowFilesystemRequest) {
      // The second inference may not ask for storage again.
      return { ok: false, failures: ["output.recursive_filesystem_request"] };
    }
    if (raw.response !== null && raw.response !== undefined) failures.push("output.union_response_present");
    if (raw.next_state !== null && raw.next_state !== undefined) failures.push("output.union_next_state_present");
    if (Array.isArray(raw.filesystem_mutations) && raw.filesystem_mutations.length > 0) {
      failures.push("output.union_mutations_present");
    }
    const request = validateFilesystemRequest(raw.filesystem_request, failures);
    if (request === null || failures.length > 0) return { ok: false, failures };
    return {
      ok: true,
      value: { transition: { kind: "filesystem_request", request }, access: mintAccess("read", request.necessity) },
    };
  }

  if (raw.kind !== "final") return { ok: false, failures: ["output.kind_invalid"] };

  if (raw.filesystem_request !== null && raw.filesystem_request !== undefined) {
    failures.push("output.union_filesystem_request_present");
  }
  const response = validateResponse(raw.response, failures);
  const nextStateJson = validateNextState(raw.next_state, failures);
  const mutations = validateMutations(raw.filesystem_mutations, failures);
  if (response === null || nextStateJson === null || mutations === null || failures.length > 0) {
    return { ok: false, failures };
  }

  const transition: FinalTransition = {
    kind: "final",
    response,
    nextStateJson: nextStateJson === UNCHANGED ? null : nextStateJson,
    mutations,
  };
  const access = mutations.length > 0 ? mintAccess("mutate", mutations[0]!.necessity) : null;
  return { ok: true, value: { transition, access } };
}
