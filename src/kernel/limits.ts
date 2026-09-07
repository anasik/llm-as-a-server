// Every bound the deterministic kernel enforces. All of them are generic
// transport/storage/safety limits. None of them encode application meaning.
export const LIMITS = {
  // transport
  clientRequestBytes: 32 * 1024,
  simulatedBodyChars: 16 * 1024,
  simulatedPathChars: 512,
  simulatedHeaderCount: 8,
  simulatedHeaderValueChars: 256,
  simulatedQueryCount: 24,
  simulatedQueryValueChars: 512,

  // model response envelope
  responseBodyBytes: 96 * 1024,
  // presentation the model authors for itself
  styleChars: 24 * 1024,
  dataUriChars: 8 * 1024,
  // The icon is repeated in every response, so it is capped hard: a simple
  // mark is ~280 characters and anything larger is paying per page view.
  iconHrefChars: 512,
  responseHeaderCount: 12,
  responseHeaderValueChars: 1024,
  statusMin: 200,
  statusMax: 599,

  // opaque state
  stateBytes: 64 * 1024,

  // exceptional virtual filesystem
  fsReadOpsPerRequest: 4,
  fsMutationsPerRequest: 4,
  fsReadBytes: 32 * 1024,
  fsListLimit: 100,
  fsResultBytes: 48 * 1024,
  fsFileBytes: 64 * 1024,
  fsSessionBytes: 512 * 1024,
  fsSessionFiles: 32,
  fsPathChars: 256,
  fsPathSegments: 12,
  fsPathSegmentChars: 64,
  necessityMinChars: 12,
  necessityMaxChars: 600,

  // abuse control
  throttleWindowMs: 60_000,
  throttlePerSessionPerWindow: 30,
  globalPerWindow: 900,

  // provider
  //
  // Short on purpose. With failover configured, a slow primary should cost a
  // couple of seconds before the secondary is tried — not most a minute. Groq
  // queues rather than refusing when its token budget is spent, so without this
  // a burst stalls instead of routing around the exhausted provider.
  providerTimeoutMs: 20_000,
  maxCompletionTokens: 8000,
} as const;

// Response headers the model is allowed to set. Anything else fails the
// transition. Chosen for transport safety, not for any application behaviour.
export const RESPONSE_HEADER_ALLOWLIST = new Set([
  "content-type",
  "cache-control",
  "location",
  "content-disposition",
  "content-language",
  "etag",
  "retry-after",
  "x-content-type-options",
]);

// Client-declared request headers forwarded into the model prompt.
// Cookies, authorization and platform headers are never forwarded.
export const REQUEST_HEADER_ALLOWLIST = new Set([
  "accept",
  "accept-language",
  "content-type",
  "x-requested-with",
]);

export const PROHIBITED_RESPONSE_HEADER_PREFIXES = [
  "set-cookie",
  "cookie",
  "authorization",
  "proxy-",
  "cf-",
  "access-control-",
  "strict-transport-security",
  "content-security-policy",
  "x-frame-options",
  "server",
  "transfer-encoding",
  "content-length",
  "connection",
  "host",
];

// Inert MIME types accepted for stored bytes. "Inert" here means the kernel
// will never execute, parse or render them; active formats are still stored as
// opaque bytes and always downloaded as attachments with nosniff.
export const FS_MIME_ALLOWLIST = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "text/css",
  "application/json",
  "application/xml",
  "application/pdf",
  "application/octet-stream",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

// Virtual path prefixes reserved for the harness so model-chosen file paths can
// never collide with runtime endpoints.
export const FS_RESERVED_PREFIXES = ["/__", "/api"];
