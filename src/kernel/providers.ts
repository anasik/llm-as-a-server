// Inference transport and failover.
//
// Providers are stateless HTTP: every inference carries the whole prompt, and
// nothing about a session lives on any provider's side. That is what makes
// routing between them safe — a request served by the second provider is
// identical in every respect except who computed it.
import { LIMITS } from "./limits";
import { OUTPUT_SCHEMA } from "./schema";
import type { ChatMessage } from "./prompt";
import type { KernelEnv, TokenUsage } from "./types";

export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";
// OpenRouter's auto-router over its free model pool: it picks among several
// free models itself, which adds a second layer of availability underneath ours.
export const DEFAULT_OPENROUTER_MODEL = "openrouter/free";
// Measured against the real output contract, not a toy schema: this one keeps
// `next_state` a serialized string reliably, which weaker models do not.
export const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";

export interface InferenceResult {
  text: string;
  usage: TokenUsage;
  latencyMs: number;
  provider: string;
  model: string;
  /** How many providers were tried, including the one that answered. */
  attempts: number;
}

export interface InferenceClient {
  /** Label used for telemetry before any call has been made. */
  readonly model: string;
  infer(messages: ChatMessage[]): Promise<InferenceResult>;
}

export class ProviderError extends Error {
  /** How many providers were tried before this failure was final. */
  attempts = 1;

  constructor(
    message: string,
    readonly code: "provider_error" | "provider_timeout" | "provider_rate_limited",
    readonly status: number | null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
}

// Extracts only the provider's short machine-readable failure code (e.g.
// "json_validate_failed", "rate_limit_exceeded"). Error bodies can echo prompt
// fragments and rejected generations, so everything else is read and dropped.
async function safeFailureCode(response: Response): Promise<string | null> {
  try {
    const payload = (await response.json()) as { error?: { code?: unknown; type?: unknown; message?: unknown } };
    const candidate = payload?.error?.code ?? payload?.error?.type;
    if (typeof candidate !== "string") return null;
    return /^[a-z0-9_]{1,48}$/i.test(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

// Providers report reset windows as durations ("27.277s", "4m19.2s"), as a
// seconds count, or as an epoch milliseconds timestamp.
function parseRetryAfter(response: Response, now: number): number | null {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.ceil(retryAfter);

  const reset = response.headers.get("x-ratelimit-reset") ?? response.headers.get("x-ratelimit-reset-tokens");
  if (!reset) return null;

  const duration = reset.match(/^(?:(\d+)m)?([\d.]+)s$/);
  if (duration) {
    const seconds = Number(duration[1] ?? 0) * 60 + Number(duration[2]);
    return Number.isFinite(seconds) ? Math.ceil(seconds) : null;
  }
  const epoch = Number(reset);
  if (Number.isFinite(epoch) && epoch > now) return Math.ceil((epoch - now) / 1000);
  if (Number.isFinite(epoch) && epoch > 0 && epoch < 86_400) return Math.ceil(epoch);
  return null;
}

interface OpenAiCompatibleConfig {
  name: string;
  endpoint: string;
  apiKey: string;
  model: string;
  maxTokensField: "max_completion_tokens" | "max_tokens";
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
}

/**
 * Groq, Gemini and OpenRouter all speak the OpenAI chat-completions shape, so
 * one implementation covers them; only the endpoint, the token field and a few
 * provider-specific knobs differ.
 */
function createOpenAiCompatibleClient(config: OpenAiCompatibleConfig): InferenceClient {
  return {
    model: `${config.name}/${config.model}`,
    async infer(messages) {
      const started = Date.now();
      let response: Response;
      try {
        response = await fetch(config.endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            "content-type": "application/json",
            ...config.extraHeaders,
          },
          body: JSON.stringify({
            model: config.model,
            messages,
            response_format: { type: "json_schema", json_schema: OUTPUT_SCHEMA },
            temperature: 0.4,
            [config.maxTokensField]: LIMITS.maxCompletionTokens,
            ...config.extraBody,
          }),
          signal: AbortSignal.timeout(LIMITS.providerTimeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof Error && /timed?\s?out|abort/i.test(error.message);
        throw new ProviderError(
          timedOut ? "provider timed out" : "provider unreachable",
          timedOut ? "provider_timeout" : "provider_error",
          null,
        );
      }

      if (!response.ok) {
        const retryAfterSeconds = parseRetryAfter(response, started);
        const failureCode = await safeFailureCode(response);
        throw new ProviderError(
          `provider returned ${response.status}${failureCode ? ` (${failureCode})` : ""}`,
          response.status === 429 ? "provider_rate_limited" : "provider_error",
          response.status,
          retryAfterSeconds,
        );
      }

      const payload = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
        model?: string;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
        };
      };
      const text = payload.choices?.[0]?.message?.content;
      if (typeof text !== "string" || text.length === 0) {
        throw new ProviderError("provider returned no content", "provider_error", 200);
      }
      return {
        text,
        latencyMs: Date.now() - started,
        provider: config.name,
        // An auto-router may report which model it actually chose.
        model: payload.model ?? config.model,
        attempts: 1,
        usage: {
          prompt: payload.usage?.prompt_tokens ?? 0,
          completion: payload.usage?.completion_tokens ?? 0,
          cached: payload.usage?.prompt_tokens_details?.cached_tokens ?? 0,
          total: payload.usage?.total_tokens ?? 0,
        },
      };
    },
  };
}

export function createGroqClient(apiKey: string, model = DEFAULT_GROQ_MODEL): InferenceClient {
  return createOpenAiCompatibleClient({
    name: "groq",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    apiKey,
    model,
    maxTokensField: "max_completion_tokens",
    extraBody: { reasoning_effort: "low" },
  });
}

export function createGeminiClient(apiKey: string, model = DEFAULT_GEMINI_MODEL): InferenceClient {
  return createOpenAiCompatibleClient({
    name: "gemini",
    // Google's OpenAI-compatible surface, so the same request shape works here.
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    apiKey,
    model,
    maxTokensField: "max_tokens",
  });
}

/** Free-tier model ids on OpenRouter, which are the only ones this may use. */
export function isFreeOpenRouterModel(model: string): boolean {
  return model === "openrouter/free" || model.endsWith(":free");
}

export function createOpenRouterClient(apiKey: string, model = DEFAULT_OPENROUTER_MODEL): InferenceClient {
  // A paid model id here would silently start spending money, so it is refused
  // at construction rather than discovered on a bill.
  if (!isFreeOpenRouterModel(model)) {
    throw new Error(`openrouter model "${model}" is not a free-tier id; refusing to use it`);
  }
  return createOpenAiCompatibleClient({
    name: "openrouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    apiKey,
    model,
    maxTokensField: "max_tokens",
    extraHeaders: { "X-Title": "llm-as-a-server" },
    // Only route to providers that honour response_format; without this,
    // strict mode silently degrades to best-effort JSON and the validation
    // boundary starts rejecting output that the model believed was fine.
    extraBody: { provider: { require_parameters: true } },
  });
}

/**
 * Remembers which providers are rate limited, so a known-exhausted provider is
 * skipped instead of being tried and failing again. Backed by the existing
 * generic runtime counters table; no application concept is stored.
 */
export interface CooldownStore {
  active(now: number): Promise<Set<string>>;
  cool(provider: string, untilMs: number): Promise<void>;
}

const COOLDOWN_PREFIX = "provider_cooldown:";

export function createCooldownStore(db: D1Database): CooldownStore {
  return {
    async active(now) {
      const cooling = new Set<string>();
      try {
        const rows = await db
          .prepare(`SELECT name, value FROM runtime_counters WHERE name LIKE ?1`)
          .bind(`${COOLDOWN_PREFIX}%`)
          .all<{ name: string; value: number }>();
        for (const row of rows.results ?? []) {
          if (row.value > now) cooling.add(row.name.slice(COOLDOWN_PREFIX.length));
        }
      } catch {
        // A cooldown lookup failure must never stop a request; the worst case
        // is trying a provider that would have been skipped.
      }
      return cooling;
    },
    async cool(provider, untilMs) {
      try {
        await db
          .prepare(
            `INSERT INTO runtime_counters (name, window_start, value) VALUES (?1, ?2, ?3)
             ON CONFLICT(name) DO UPDATE SET value = ?3, window_start = ?2`,
          )
          .bind(`${COOLDOWN_PREFIX}${provider}`, untilMs, untilMs)
          .run();
      } catch {
        // Best effort: losing a cooldown costs one wasted call, nothing more.
      }
    },
  };
}

const RATE_LIMIT_COOLDOWN_MS = 60_000;
const FAILURE_COOLDOWN_MS = 30_000;

/**
 * Tries providers in priority order and fails over on rate limits, timeouts and
 * upstream errors. The providers are complementary by design: the primary
 * usually has the larger daily allowance, the secondary the larger per-minute
 * allowance, so bursts land on the one that can absorb them.
 */
export function createRoutingClient(
  providers: { name: string; client: InferenceClient }[],
  cooldowns: CooldownStore,
  now: () => number = () => Date.now(),
): InferenceClient {
  if (providers.length === 0) throw new Error("no inference providers are configured");

  return {
    model: providers.map((provider) => provider.client.model).join(" | "),
    async infer(messages) {
      const cooling = await cooldowns.active(now());
      const eligible = providers.filter((provider) => !cooling.has(provider.name));
      // If everything is cooling, try anyway rather than refusing outright: a
      // cooldown is an estimate, not a fact.
      const order = eligible.length > 0 ? eligible : providers;

      let attempts = 0;
      let lastError: unknown;

      for (const provider of order) {
        attempts++;
        try {
          const result = await provider.client.infer(messages);
          return { ...result, attempts };
        } catch (error) {
          lastError = error;
          if (error instanceof ProviderError) {
            const cooldown =
              error.code === "provider_rate_limited"
                ? Math.max(RATE_LIMIT_COOLDOWN_MS, (error.retryAfterSeconds ?? 0) * 1000)
                : FAILURE_COOLDOWN_MS;
            await cooldowns.cool(provider.name, now() + cooldown);
            continue;
          }
          throw error;
        }
      }

      if (lastError instanceof ProviderError) {
        lastError.attempts = attempts;
        throw lastError;
      }
      if (lastError instanceof Error) throw lastError;
      const exhausted = new ProviderError("all providers failed", "provider_error", null);
      exhausted.attempts = attempts;
      throw exhausted;
    },
  };
}

/**
 * Builds the routing client from configuration. A provider with no key is
 * simply absent; order comes from LLM_PROVIDERS, defaulting to Groq first
 * (1,000 requests/day) with OpenRouter absorbing per-minute bursts.
 */
export function createConfiguredClient(env: KernelEnv, cooldowns: CooldownStore): InferenceClient {
  const order = (env.LLM_PROVIDERS ?? "groq,gemini,openrouter")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);

  const available: { name: string; client: InferenceClient }[] = [];
  for (const name of order) {
    if (name === "groq" && env.GROQ_API_KEY) {
      available.push({ name, client: createGroqClient(env.GROQ_API_KEY, env.GROQ_MODEL ?? DEFAULT_GROQ_MODEL) });
    }
    if (name === "gemini" && env.GEMINI_API_KEY) {
      available.push({ name, client: createGeminiClient(env.GEMINI_API_KEY, env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL) });
    }
    if (name === "openrouter" && env.OPENROUTER_API_KEY) {
      available.push({
        name,
        client: createOpenRouterClient(env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL),
      });
    }
  }

  if (available.length === 0) throw new Error("no inference providers are configured");
  return available.length === 1 ? available[0]!.client : createRoutingClient(available, cooldowns);
}
