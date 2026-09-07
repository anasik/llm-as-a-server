import { env } from "cloudflare:test";
import type { InferenceClient, InferenceResult } from "../src/kernel/providers";
import type { KernelEnv } from "../src/kernel/types";

export { env };

export interface MockGroq extends InferenceClient {
  /** Every message array the kernel sent, in order. */
  readonly prompts: ChatMessage[][];
  readonly callCount: number;
}

/**
 * A stand-in for the provider. The real client is stateless HTTP, so replacing
 * it changes nothing about the architecture under test: the kernel still gets
 * one JSON document per inference and must validate it.
 */
export function mockGroq(outputs: (string | object)[], model = "mock-model"): MockGroq {
  const prompts: ChatMessage[][] = [];
  let index = 0;
  return {
    model,
    get prompts() {
      return prompts;
    },
    get callCount() {
      return prompts.length;
    },
    async infer(messages: ChatMessage[]): Promise<InferenceResult> {
      prompts.push(messages);
      const output = outputs[index++];
      if (output === undefined) throw new Error(`mock provider ran out of outputs at call ${index}`);
      return {
        text: typeof output === "string" ? output : JSON.stringify(output),
        latencyMs: 1,
        provider: "mock",
        model,
        attempts: 1,
        usage: { prompt: 100, completion: 20, cached: 64, total: 120 },
      };
    },
  };
}

export function failingGroq(error: Error): InferenceClient {
  return {
    model: "mock-model",
    async infer() {
      throw error;
    },
  };
}

export interface ModelOutputInit {
  status?: number;
  headers?: { name: string; value: string }[];
  body?: string;
  state?: unknown;
  mutations?: unknown;
}

/** A minimal but complete document, the way the model is asked to answer. */
export function page(inner: string, title = "Page"): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:system-ui;margin:0}</style></head><body>${inner}</body></html>`;
}

/** A well-formed `final` transition. */
export function final(init: ModelOutputInit = {}) {
  return {
    kind: "final",
    response: {
      status: init.status ?? 200,
      headers: init.headers ?? [{ name: "content-type", value: "text/html; charset=utf-8" }],
      body: init.body ?? page("<h1>page</h1>"),
    },
    next_state: JSON.stringify(init.state ?? {}),
    filesystem_mutations: init.mutations ?? [],
    filesystem_request: null,
  };
}

/** A well-formed exceptional filesystem read request. */
export function filesystemRequest(
  operations: unknown[],
  necessity = "The visitor asked for the contents of a file they previously stored.",
) {
  return {
    kind: "filesystem_request",
    response: null,
    next_state: null,
    filesystem_mutations: null,
    filesystem_request: { necessity, operations },
  };
}

export interface CountedEnv extends KernelEnv {
  readonly storageCalls: string[];
}

/**
 * Wraps the R2 binding so every call is recorded at the *binding* level,
 * independently of the kernel's own counters. This is how the "ordinary
 * requests make zero storage calls" invariant is checked rather than asserted.
 */
export function countingEnv(overrides: Partial<KernelEnv> = {}): CountedEnv {
  const storageCalls: string[] = [];
  const bucket = env.VFS_BUCKET;
  const counted = new Proxy(bucket, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          storageCalls.push(String(property));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  });
  return {
    STATE_DB: env.STATE_DB,
    VFS_BUCKET: counted as R2Bucket,
    GROQ_API_KEY: "test-key",
    VFS_NAMESPACE_SALT: "test-salt",
    GROQ_MODEL: "mock-model",
    ...overrides,
    get storageCalls() {
      return storageCalls;
    },
  } as CountedEnv;
}

export interface SiteRequestInit {
  method?: string;
  path?: string;
  body?: unknown;
  contentType?: string;
  headers?: Record<string, string>;
  cookie?: string | null;
}

/** An ordinary browser-shaped request straight at the site. */
export function siteRequest(init: SiteRequestInit = {}): Request {
  const headers = new Headers(init.headers ?? {});
  if (init.cookie) headers.set("cookie", init.cookie);

  let body: string | undefined;
  if (init.body !== undefined && init.body !== null) {
    if (typeof init.body === "string") {
      body = init.body;
      if (!headers.has("content-type")) headers.set("content-type", init.contentType ?? "text/plain");
    } else {
      body = JSON.stringify(init.body);
      if (!headers.has("content-type")) headers.set("content-type", init.contentType ?? "application/json");
    }
  }

  return new Request(`https://example.test${init.path ?? "/"}`, {
    method: init.method ?? "GET",
    headers,
    body,
  });
}

/** An ordinary HTML form submission, the way a browser sends one. */
export function formRequest(path: string, fields: Record<string, string>, cookie?: string | null): Request {
  return siteRequest({
    method: "POST",
    path,
    body: new URLSearchParams(fields).toString(),
    contentType: "application/x-www-form-urlencoded",
    cookie,
  });
}

export interface SiteResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  setCookie: string | null;
  sessionCookie: string | null;
  telemetry: {
    model: string;
    inferences: number;
    persisted: string;
    stateBefore: number;
    stateAfter: number | null;
    versionBefore: number;
    versionAfter: number | null;
    tokens: { prompt: number; completion: number; cached: number };
    filesystem: {
      raw: string;
      untouched: boolean;
      outcome: string;
      calls: number;
      readOpsAccepted: number;
      readOpsAttempted: number;
      mutationsAccepted: number;
      mutationsAttempted: number;
      read: number;
      written: number;
      deleted: number;
      secondInference: boolean;
      necessityChars: number;
    };
    sanitizer: { elements: number; attributes: number };
    validation: string[];
  };
}

function num(source: string, pattern: RegExp): number {
  const match = source.match(pattern);
  return match ? Number(match[1]) : 0;
}

export async function readSite(response: Response): Promise<SiteResult> {
  const headers: Record<string, string> = {};
  for (const [name, value] of response.headers) headers[name] = value;

  const setCookie = response.headers.get("set-cookie");
  const value = setCookie?.match(/las_session=([A-Za-z0-9_-]+)/)?.[1] ?? null;

  const state = headers["x-las-state"] ?? "";
  const stateMatch = state.match(/^v(\d+)->(\d+|unchanged) (\d+)B->(\d+|unchanged)B$/);
  const fsRaw = headers["x-las-filesystem"] ?? "untouched";
  const tokens = headers["x-las-tokens"] ?? "";
  const sanitizer = headers["x-las-sanitizer"] ?? "";

  return {
    status: response.status,
    headers,
    body: await response.text(),
    setCookie,
    sessionCookie: value ? `las_session=${value}` : null,
    telemetry: {
      model: headers["x-las-model"] ?? "",
      inferences: Number(headers["x-las-inferences"] ?? 0),
      persisted: headers["x-las-persisted"] ?? "",
      versionBefore: stateMatch ? Number(stateMatch[1]) : 0,
      versionAfter: stateMatch && stateMatch[2] !== "unchanged" ? Number(stateMatch[2]) : null,
      stateBefore: stateMatch ? Number(stateMatch[3]) : 0,
      stateAfter: stateMatch && stateMatch[4] !== "unchanged" ? Number(stateMatch[4]) : null,
      tokens: {
        prompt: num(tokens, /prompt=(\d+)/),
        completion: num(tokens, /completion=(\d+)/),
        cached: num(tokens, /cached=(\d+)/),
      },
      filesystem: {
        raw: fsRaw,
        untouched: fsRaw === "untouched",
        outcome: fsRaw.split(" ")[0] ?? "",
        calls: num(fsRaw, /calls=(\d+)/),
        readOpsAccepted: num(fsRaw, /read_ops=(\d+)\//),
        readOpsAttempted: num(fsRaw, /read_ops=\d+\/(\d+)/),
        mutationsAccepted: num(fsRaw, /mutations=(\d+)\//),
        mutationsAttempted: num(fsRaw, /mutations=\d+\/(\d+)/),
        read: num(fsRaw, /\bread=(\d+)B/),
        written: num(fsRaw, /written=(\d+)B/),
        deleted: num(fsRaw, /deleted=(\d+)B/),
        secondInference: /second_inference=true/.test(fsRaw),
        necessityChars: num(fsRaw, /necessity_chars=(\d+)/),
      },
      sanitizer: {
        elements: num(sanitizer, /elements=(\d+)/),
        attributes: num(sanitizer, /attributes=(\d+)/),
      },
      validation: (headers["x-las-validation"] ?? "").split(" ").filter(Boolean),
    },
  };
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function storedStateJson(sessionId: string): Promise<string | null> {
  const row = await env.STATE_DB.prepare("SELECT state_json FROM sessions WHERE session_id = ?1")
    .bind(sessionId)
    .first<{ state_json: string }>();
  return row?.state_json ?? null;
}

export function sessionIdFromCookie(cookie: string): string {
  return cookie.replace("las_session=", "");
}
