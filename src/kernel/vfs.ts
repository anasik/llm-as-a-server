// The ONLY module in this codebase that touches R2.
//
// It cannot run without a `FilesystemAccess` capability token, and that token
// can only be minted inside validate.ts after an explicit, concrete necessity
// statement and a well-formed generic operation set have been accepted. The
// ordinary request path never holds the bucket binding or a token, so it cannot
// reach this code. Every call is counted so the "zero storage calls on the
// ordinary path" invariant is mechanically checkable rather than asserted.
import { LIMITS } from "./limits";
import { decodeContent, isActiveMime } from "./vfspath";
import type { FilesystemAccess } from "./validate";
import type { FsMutation, FsReadOp } from "./types";

export interface ListEntryResult {
  path: string;
  size: number;
  content_type: string;
  updated_at: string;
}

export type ReadOpResult =
  | { op: "list"; path: string; entries: ListEntryResult[]; truncated: boolean }
  | { op: "stat"; path: string; exists: boolean; size: number | null; content_type: string | null; updated_at: string | null }
  | {
      op: "read";
      path: string;
      exists: boolean;
      encoding: "utf8" | "base64" | null;
      content: string | null;
      bytes: number;
      truncated: boolean;
    }
  | { op: "list" | "stat" | "read"; path: string; error: string };

export interface MutationResult {
  op: "write" | "delete";
  path: string;
  applied: boolean;
  bytes: number;
  existed_before: boolean;
  error: string | null;
}

export interface StoredObject {
  bytes: ArrayBuffer;
  contentType: string;
  size: number;
  active: boolean;
}

export interface FilesystemGateway {
  readonly calls: number;
  readonly bytesRead: number;
  readonly bytesWritten: number;
  readonly bytesDeleted: number;
  executeReads(ops: FsReadOp[]): Promise<{ results: ReadOpResult[]; accepted: number; rejected: number }>;
  applyMutations(mutations: FsMutation[]): Promise<MutationResult[]>;
  compensate(results: MutationResult[]): Promise<{ removed: number; irreversible: number }>;
  fetchForDownload(path: string): Promise<StoredObject | null>;
  deleteNamespace(): Promise<number>;
}

const TEXTUAL = /^(text\/|application\/(json|xml)$)/;

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function openFilesystem(
  bucket: R2Bucket,
  namespace: string,
  access: FilesystemAccess,
): FilesystemGateway {
  if (!access || typeof access !== "object" || typeof (access as { mode?: unknown }).mode !== "string") {
    throw new Error("filesystem_access_not_authorized");
  }

  let calls = 0;
  let bytesRead = 0;
  let bytesWritten = 0;
  let bytesDeleted = 0;

  const keyFor = (path: string) => `${namespace}${path}`;
  const pathFor = (key: string) => key.slice(namespace.length);

  async function listRaw(prefix: string, limit: number) {
    calls++;
    // `include` asks R2 to return stored content types with the listing; the
    // option is not present in every published version of the type definitions.
    return bucket.list({ prefix, limit, include: ["httpMetadata"] } as unknown as R2ListOptions);
  }

  async function usage(): Promise<{ count: number; bytes: number }> {
    let count = 0;
    let bytes = 0;
    let cursor: string | undefined;
    do {
      calls++;
      const page: R2Objects = await bucket.list({ prefix: namespace, limit: 1000, cursor });
      for (const object of page.objects) {
        count++;
        bytes += object.size;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return { count, bytes };
  }

  return {
    get calls() {
      return calls;
    },
    get bytesRead() {
      return bytesRead;
    },
    get bytesWritten() {
      return bytesWritten;
    },
    get bytesDeleted() {
      return bytesDeleted;
    },

    async executeReads(ops) {
      const results: ReadOpResult[] = [];
      let accepted = 0;
      let rejected = 0;
      let budget = LIMITS.fsResultBytes;

      for (const op of ops) {
        if (budget <= 0) {
          results.push({ op: op.op, path: op.path, error: "result_budget_exhausted" });
          rejected++;
          continue;
        }
        try {
          if (op.op === "list") {
            const prefix = op.path === "/" ? namespace : keyFor(op.path);
            const limit = Math.min(op.limit ?? LIMITS.fsListLimit, LIMITS.fsListLimit);
            const page = await listRaw(prefix, limit);
            const entries: ListEntryResult[] = page.objects.map((object) => ({
              path: pathFor(object.key),
              size: object.size,
              content_type: object.httpMetadata?.contentType ?? "application/octet-stream",
              updated_at: object.uploaded.toISOString(),
            }));
            const payload = JSON.stringify(entries);
            budget -= payload.length;
            results.push({ op: "list", path: op.path, entries, truncated: page.truncated });
            accepted++;
            continue;
          }

          if (op.op === "stat") {
            calls++;
            const head = await bucket.head(keyFor(op.path));
            results.push({
              op: "stat",
              path: op.path,
              exists: head !== null,
              size: head?.size ?? null,
              content_type: head?.httpMetadata?.contentType ?? null,
              updated_at: head?.uploaded.toISOString() ?? null,
            });
            accepted++;
            continue;
          }

          calls++;
          const object = await bucket.get(keyFor(op.path));
          if (!object) {
            results.push({ op: "read", path: op.path, exists: false, encoding: null, content: null, bytes: 0, truncated: false });
            accepted++;
            continue;
          }
          const cap = Math.min(op.max_bytes ?? LIMITS.fsReadBytes, LIMITS.fsReadBytes, budget);
          const buffer = await object.arrayBuffer();
          const truncated = buffer.byteLength > cap;
          const slice = truncated ? buffer.slice(0, cap) : buffer;
          const contentType = object.httpMetadata?.contentType ?? "application/octet-stream";
          const textual = TEXTUAL.test(contentType);
          const content = textual ? new TextDecoder().decode(slice) : toBase64(slice);
          bytesRead += slice.byteLength;
          budget -= content.length;
          results.push({
            op: "read",
            path: op.path,
            exists: true,
            encoding: textual ? "utf8" : "base64",
            content,
            bytes: slice.byteLength,
            truncated,
          });
          accepted++;
        } catch {
          results.push({ op: op.op, path: op.path, error: "storage_error" });
          rejected++;
        }
      }
      return { results, accepted, rejected };
    },

    async applyMutations(mutations) {
      const out: MutationResult[] = [];
      let { count, bytes } = await usage();

      for (const mutation of mutations) {
        calls++;
        const head = await bucket.head(keyFor(mutation.path)).catch(() => null);
        const existedBefore = head !== null;

        if (mutation.op === "delete") {
          if (!existedBefore) {
            out.push({ op: "delete", path: mutation.path, applied: false, bytes: 0, existed_before: false, error: "not_found" });
            continue;
          }
          try {
            calls++;
            await bucket.delete(keyFor(mutation.path));
            bytesDeleted += head!.size;
            count--;
            bytes -= head!.size;
            out.push({ op: "delete", path: mutation.path, applied: true, bytes: head!.size, existed_before: true, error: null });
          } catch {
            out.push({ op: "delete", path: mutation.path, applied: false, bytes: 0, existed_before: true, error: "storage_error" });
          }
          continue;
        }

        const decoded = decodeContent(mutation.content ?? "", mutation.encoding ?? "utf8");
        if (!decoded.ok) {
          out.push({ op: "write", path: mutation.path, applied: false, bytes: 0, existed_before: existedBefore, error: decoded.reason });
          continue;
        }
        const projectedCount = existedBefore ? count : count + 1;
        const projectedBytes = bytes - (head?.size ?? 0) + decoded.bytes.length;
        if (projectedCount > LIMITS.fsSessionFiles) {
          out.push({ op: "write", path: mutation.path, applied: false, bytes: 0, existed_before: existedBefore, error: "session_file_quota" });
          continue;
        }
        if (projectedBytes > LIMITS.fsSessionBytes) {
          out.push({ op: "write", path: mutation.path, applied: false, bytes: 0, existed_before: existedBefore, error: "session_byte_quota" });
          continue;
        }
        try {
          calls++;
          await bucket.put(keyFor(mutation.path), decoded.bytes, {
            httpMetadata: { contentType: mutation.content_type ?? "application/octet-stream" },
          });
          count = projectedCount;
          bytes = projectedBytes;
          bytesWritten += decoded.bytes.length;
          out.push({ op: "write", path: mutation.path, applied: true, bytes: decoded.bytes.length, existed_before: existedBefore, error: null });
        } catch {
          out.push({ op: "write", path: mutation.path, applied: false, bytes: 0, existed_before: existedBefore, error: "storage_error" });
        }
      }
      return out;
    },

    // Best-effort compensation when the state write that justified these
    // mutations did not land. Newly created objects are removed. Overwrites and
    // deletes cannot be undone; they are reported as irreversible rather than
    // hidden.
    async compensate(results) {
      let removed = 0;
      let irreversible = 0;
      for (const result of results) {
        if (!result.applied) continue;
        if (result.op === "write" && !result.existed_before) {
          try {
            calls++;
            await bucket.delete(keyFor(result.path));
            removed++;
          } catch {
            irreversible++;
          }
          continue;
        }
        irreversible++;
      }
      return { removed, irreversible };
    },

    async fetchForDownload(path) {
      calls++;
      const object = await bucket.get(keyFor(path));
      if (!object) return null;
      const bytes = await object.arrayBuffer();
      const contentType = object.httpMetadata?.contentType ?? "application/octet-stream";
      bytesRead += bytes.byteLength;
      return { bytes, contentType, size: bytes.byteLength, active: isActiveMime(contentType) };
    },

    async deleteNamespace() {
      let deleted = 0;
      let cursor: string | undefined;
      do {
        calls++;
        const page: R2Objects = await bucket.list({ prefix: namespace, limit: 1000, cursor });
        const keys = page.objects.map((object) => object.key);
        if (keys.length > 0) {
          calls++;
          await bucket.delete(keys);
          deleted += keys.length;
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return deleted;
    },
  };
}
