// Anonymous session identity. The cookie value is the only client-visible
// handle; the server-side storage namespace is derived from it and a secret so
// that a leaked cookie never reveals a storage key, and a guessed storage key
// is not reachable.
const COOKIE_NAME = "las_session";
const SESSION_ID_CHARS = 43; // 32 random bytes, base64url, unpadded
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateSessionId(random: (n: number) => Uint8Array): string {
  return base64url(random(32));
}

export function isWellFormedSessionId(value: string): boolean {
  return value.length === SESSION_ID_CHARS && /^[A-Za-z0-9_-]+$/.test(value);
}

export function readSessionId(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== COOKIE_NAME) continue;
    const value = part.slice(eq + 1).trim();
    return isWellFormedSessionId(value) ? value : null;
  }
  return null;
}

export function sessionCookie(sessionId: string, secure: boolean): string {
  const attrs = [
    `${COOKIE_NAME}=${sessionId}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${MAX_AGE_SECONDS}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearedSessionCookie(secure: boolean): string {
  const attrs = [`${COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

// Unguessable, deterministic, per-session storage namespace. Derived only
// inside the kernel and never sent to the model or the client.
export async function deriveStorageNamespace(sessionId: string, salt: string | undefined): Promise<string> {
  const material = `llm-as-a-server/v1/${salt ?? "no-salt"}/${sessionId}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sessions/${hex.slice(0, 32)}`;
}

export function isSecureRequest(request: Request): boolean {
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return true;
  }
}
