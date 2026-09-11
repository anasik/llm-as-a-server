// Session identity and storage namespacing. Contract-independent: isolation is
// a kernel guarantee, not something a deployment's prose can weaken.
import { describe, expect, it } from "vitest";
import {
  clearedSessionCookie,
  deriveStorageNamespace,
  generateSessionId,
  isSecureRequest,
  isWellFormedSessionId,
  readSessionId,
  sessionCookie,
} from "../src/kernel/session";

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const withCookie = (header: string) => new Request("https://example.test/", { headers: { cookie: header } });

describe("session identifiers", () => {
  it("generates unguessable, url-safe ids", () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateSessionId(random)));
    expect(ids.size).toBe(200);
    for (const id of ids) {
      // 32 random bytes, base64url, unpadded.
      expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(isWellFormedSessionId(id)).toBe(true);
    }
  });

  it("rejects ids that are the wrong shape", () => {
    for (const bad of ["", "short", "a".repeat(42), "a".repeat(44), "a".repeat(42) + "+", "a".repeat(42) + "/", "a".repeat(42) + "="]) {
      expect(isWellFormedSessionId(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("is deterministic given the same random bytes", () => {
    const fixed = () => new Uint8Array(32).fill(7);
    expect(generateSessionId(fixed)).toBe(generateSessionId(fixed));
  });
});

describe("reading the cookie", () => {
  it("finds the session among other cookies", () => {
    const id = generateSessionId(random);
    expect(readSessionId(withCookie(`las_session=${id}`))).toBe(id);
    expect(readSessionId(withCookie(`other=1; las_session=${id}; third=x`))).toBe(id);
    expect(readSessionId(withCookie(`  las_session=${id}  `))).toBe(id);
  });

  it("returns null rather than trusting a malformed value", () => {
    // A caller supplying its own id must not be able to pick one.
    for (const header of [
      "las_session=",
      "las_session=short",
      "las_session=../../etc/passwd",
      "las_session=" + "a".repeat(200),
      "las_session=abc def",
      "other=1",
      "",
      "las_sessionx=" + "a".repeat(43),
    ]) {
      expect(readSessionId(withCookie(header)), header.slice(0, 30)).toBeNull();
    }
    expect(readSessionId(new Request("https://example.test/"))).toBeNull();
  });
});

describe("cookie attributes", () => {
  it("issues a hardened cookie over https", () => {
    const cookie = sessionCookie("a".repeat(43), true);
    expect(cookie).toContain("las_session=" + "a".repeat(43));
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(cookie).toMatch(/Max-Age=\d+/);
  });

  it("omits Secure only for plain-http local development", () => {
    expect(sessionCookie("a".repeat(43), false)).not.toContain("Secure");
    expect(isSecureRequest(new Request("https://example.test/"))).toBe(true);
    expect(isSecureRequest(new Request("http://127.0.0.1:8788/"))).toBe(false);
  });

  it("expires the cookie on reset without leaking the old value", () => {
    const cleared = clearedSessionCookie(true);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("HttpOnly");
    expect(cleared).toMatch(/^las_session=;/);
  });
});

describe("storage namespace derivation", () => {
  const salt = "a-secret-salt";

  it("is stable for a session and shaped like a key prefix", async () => {
    const id = generateSessionId(random);
    const first = await deriveStorageNamespace(id, salt);
    expect(first).toMatch(/^sessions\/[0-9a-f]{32}$/);
    expect(await deriveStorageNamespace(id, salt)).toBe(first);
  });

  it("never reveals the cookie value it was derived from", async () => {
    const id = generateSessionId(random);
    const namespace = await deriveStorageNamespace(id, salt);
    expect(namespace).not.toContain(id);
    expect(namespace).not.toContain(id.slice(0, 8));
  });

  it("separates sessions and separates deployments", async () => {
    const a = generateSessionId(random);
    const b = generateSessionId(random);
    expect(await deriveStorageNamespace(a, salt)).not.toBe(await deriveStorageNamespace(b, salt));
    // A different salt means a leaked cookie from one deployment cannot address
    // objects in another.
    expect(await deriveStorageNamespace(a, salt)).not.toBe(await deriveStorageNamespace(a, "different-salt"));
    expect(await deriveStorageNamespace(a, undefined)).not.toBe(await deriveStorageNamespace(a, salt));
  });

  it("spreads adjacent ids across the keyspace", async () => {
    // Sequential-looking ids must not produce adjacent prefixes.
    const one = await deriveStorageNamespace("a".repeat(43), salt);
    const two = await deriveStorageNamespace("a".repeat(42) + "b", salt);
    const shared = [...one].findIndex((char, i) => char !== two[i]);
    expect(shared).toBeLessThan(14);
  });
});
