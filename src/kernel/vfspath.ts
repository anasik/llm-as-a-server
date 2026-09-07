// Pure validation for the exceptional virtual filesystem. Deliberately kept in
// its own module with no R2 import: `validate.ts` needs these checks on the
// ordinary path, and the ordinary path must not be able to reach storage.
import { FS_MIME_ALLOWLIST, FS_RESERVED_PREFIXES, LIMITS } from "./limits";

export type PathCheck = { ok: true; path: string } | { ok: false; reason: string };

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export function normalizeVirtualPath(input: unknown): PathCheck {
  if (typeof input !== "string") return { ok: false, reason: "path_not_string" };
  if (input.length === 0 || input.length > LIMITS.fsPathChars) return { ok: false, reason: "path_length" };
  if (!input.startsWith("/")) return { ok: false, reason: "path_not_absolute" };
  if (input.includes("\\")) return { ok: false, reason: "path_backslash" };
  if (CONTROL_CHARS.test(input)) return { ok: false, reason: "path_control_char" };
  // Reject percent-encoding outright rather than guessing an encoding layer.
  if (input.includes("%")) return { ok: false, reason: "path_ambiguous_encoding" };
  if (input !== input.normalize("NFC")) return { ok: false, reason: "path_not_nfc" };

  const segments: string[] = [];
  for (const raw of input.split("/")) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") return { ok: false, reason: "path_traversal" };
    if (raw.length > LIMITS.fsPathSegmentChars) return { ok: false, reason: "path_segment_length" };
    segments.push(raw);
  }
  if (segments.length === 0) return { ok: false, reason: "path_empty" };
  if (segments.length > LIMITS.fsPathSegments) return { ok: false, reason: "path_too_deep" };

  const path = "/" + segments.join("/");
  for (const prefix of FS_RESERVED_PREFIXES) {
    if (path === prefix || path.startsWith(prefix)) return { ok: false, reason: "path_reserved_prefix" };
  }
  return { ok: true, path };
}

// A directory-ish path for `list`. Same rules, but the namespace root is valid.
export function normalizeVirtualDir(input: unknown): PathCheck {
  if (input === "/" || input === "") return { ok: true, path: "/" };
  return normalizeVirtualPath(input);
}

export function isAllowedMime(value: string): boolean {
  return FS_MIME_ALLOWLIST.has(value.toLowerCase().split(";")[0]!.trim());
}

// MIME types a browser could treat as active content. Stored bytes of these
// types are still accepted, but only ever handed back as
// application/octet-stream attachments with nosniff, never rendered.
const ACTIVE_MIME = new Set(["text/html", "text/css", "application/xml", "application/pdf", "image/webp"]);

export function isActiveMime(value: string): boolean {
  return ACTIVE_MIME.has(value.toLowerCase().split(";")[0]!.trim());
}

export function decodeContent(
  content: string,
  encoding: "utf8" | "base64",
): { ok: true; bytes: Uint8Array } | { ok: false; reason: string } {
  if (encoding === "utf8") {
    const bytes = new TextEncoder().encode(content);
    if (bytes.length > LIMITS.fsFileBytes) return { ok: false, reason: "file_too_large" };
    return { ok: true, bytes };
  }
  const compact = content.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    return { ok: false, reason: "base64_invalid" };
  }
  try {
    const raw = atob(compact);
    if (raw.length > LIMITS.fsFileBytes) return { ok: false, reason: "file_too_large" };
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return { ok: true, bytes };
  } catch {
    return { ok: false, reason: "base64_invalid" };
  }
}
