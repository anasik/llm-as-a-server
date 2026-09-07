export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export type SimulatedMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface NormalizedRequest {
  method: SimulatedMethod;
  path: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  body: JsonValue;
}

export interface ResponseHeader {
  name: string;
  value: string;
}

export interface SimulatedResponse {
  status: number;
  headers: ResponseHeader[];
  body: string;
}

export type FsReadOp =
  | { op: "list"; path: string; limit: number | null; max_bytes: number | null }
  | { op: "stat"; path: string; limit: number | null; max_bytes: number | null }
  | { op: "read"; path: string; limit: number | null; max_bytes: number | null };

export interface FsRequest {
  necessity: string;
  operations: FsReadOp[];
}

export interface FsMutation {
  op: "write" | "delete";
  path: string;
  encoding: "utf8" | "base64" | null;
  content: string | null;
  content_type: string | null;
  necessity: string;
}

export interface ModelOutputRaw {
  kind: "final" | "filesystem_request";
  response: SimulatedResponse | null;
  next_state: string | null;
  filesystem_mutations: FsMutation[] | null;
  filesystem_request: FsRequest | null;
}

export interface FinalTransition {
  kind: "final";
  response: SimulatedResponse;
  /** `null` means the model left the state alone; nothing is written. */
  nextStateJson: string | null;
  mutations: FsMutation[];
}

export interface FilesystemRequestTransition {
  kind: "filesystem_request";
  request: FsRequest;
}

export type ModelTransition = FinalTransition | FilesystemRequestTransition;

export interface TokenUsage {
  prompt: number;
  completion: number;
  cached: number;
  total: number;
}

export interface FilesystemTelemetry {
  requested: boolean;
  necessity_present: boolean;
  necessity_chars: number;
  second_inference: boolean;
  read_ops_attempted: number;
  read_ops_accepted: number;
  read_ops_rejected: number;
  mutations_attempted: number;
  mutations_accepted: number;
  mutations_rejected: number;
  bytes_read: number;
  bytes_written: number;
  bytes_deleted: number;
  r2_calls: number;
  untouched: boolean;
}

export interface Telemetry {
  method: string;
  path: string;
  status: number | null;
  model: string;
  provider: string;
  provider_attempts: number;
  inferences: number;
  latency_ms: number;
  provider_latency_ms: number;
  tokens: TokenUsage;
  state: {
    version_before: number;
    version_after: number | null;
    bytes_before: number;
    bytes_after: number | null;
  };
  persistence: {
    state: "ok" | "unchanged" | "conflict" | "failed" | "skipped";
    filesystem: "untouched" | "applied" | "partial" | "failed" | "compensated";
  };
  filesystem: FilesystemTelemetry;
  sanitizer: { removed_elements: number; removed_attributes: number };
  validation_failures: string[];
}

export interface KernelEnv {
  STATE_DB: D1Database;
  VFS_BUCKET: R2Bucket;
  GROQ_API_KEY: string;
  VFS_NAMESPACE_SALT?: string;
  GROQ_MODEL?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  /** Comma-separated provider priority, e.g. "groq,openrouter". */
  LLM_PROVIDERS?: string;
}
