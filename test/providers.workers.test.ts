import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ProviderError,
  createConfiguredClient,
  createCooldownStore,
  createOpenRouterClient,
  createRoutingClient,
  isFreeOpenRouterModel,
} from "../src/kernel/providers";
import type { InferenceClient } from "../src/kernel/providers";

function stubClient(name: string, behaviour: () => Promise<never> | null): InferenceClient {
  return {
    model: name,
    async infer() {
      const failure = behaviour();
      if (failure) await failure;
      return {
        text: "{}",
        latencyMs: 1,
        provider: name,
        model: name,
        attempts: 1,
        usage: { prompt: 1, completion: 1, cached: 0, total: 2 },
      };
    },
  };
}

const rateLimited = (name: string, retryAfter = 30) =>
  stubClient(name, () => Promise.reject(new ProviderError("429", "provider_rate_limited", 429, retryAfter)));
const broken = (name: string) => stubClient(name, () => Promise.reject(new ProviderError("500", "provider_error", 500)));
const healthy = (name: string) => stubClient(name, () => null);

describe("provider routing", () => {
  it("fails over to the next provider when the first is rate limited", async () => {
    const cooldowns = createCooldownStore(env.STATE_DB);
    const router = createRoutingClient(
      [
        { name: "groq", key: "groq:a", client: rateLimited("groq") },
        { name: "openrouter", key: "openrouter:a", client: healthy("openrouter") },
      ],
      cooldowns,
    );

    const result = await router.infer([]);
    expect(result.provider).toBe("openrouter");
    expect(result.attempts).toBe(2);
  });

  it("remembers the cooldown so an exhausted provider is skipped next time", async () => {
    const cooldowns = createCooldownStore(env.STATE_DB);
    let groqCalls = 0;
    const groq: InferenceClient = {
      model: "groq",
      async infer() {
        groqCalls++;
        throw new ProviderError("429", "provider_rate_limited", 429, 45);
      },
    };
    const router = createRoutingClient(
      [
        { name: "groq-cooldown-test", key: "groq-cooldown-test", client: groq },
        { name: "openrouter", key: "openrouter:a", client: healthy("openrouter") },
      ],
      cooldowns,
    );

    await router.infer([]);
    expect(groqCalls).toBe(1);

    // Second request skips the cooling provider entirely.
    const second = await router.infer([]);
    expect(groqCalls).toBe(1);
    expect(second.provider).toBe("openrouter");
    expect(second.attempts).toBe(1);
  });

  it("tries everything rather than refusing when all providers are cooling", async () => {
    const cooldowns = {
      async active() {
        return new Set(["a", "b"]);
      },
      async cool() {},
    };
    const router = createRoutingClient(
      [
        { name: "a", key: "a", client: broken("a") },
        { name: "b", key: "b", client: healthy("b") },
      ],
      cooldowns,
    );

    // A cooldown is an estimate, not a fact: better to try than to serve a 502.
    const result = await router.infer([]);
    expect(result.provider).toBe("b");
  });

  it("propagates the failure when every provider fails", async () => {
    const cooldowns = { async active() { return new Set<string>(); }, async cool() {} };
    const router = createRoutingClient(
      [
        { name: "a", key: "a", client: broken("a") },
        { name: "b", key: "b", client: rateLimited("b") },
      ],
      cooldowns,
    );

    await expect(router.infer([])).rejects.toBeInstanceOf(ProviderError);
  });

  it("gives each model its own cooldown, because rate limits are per-model", async () => {
    // Measured against Groq: one model returning 429 while a sibling reported
    // its budget untouched. Cooling the provider by name would have skipped a
    // model that still had a full allowance.
    const cooldowns = createCooldownStore(env.STATE_DB);
    let secondCalls = 0;
    const first: InferenceClient = {
      model: "big",
      async infer() {
        throw new ProviderError("429", "provider_rate_limited", 429, 60);
      },
    };
    const second: InferenceClient = {
      model: "small",
      async infer() {
        secondCalls++;
        return { text: "{}", latencyMs: 1, provider: "groq", model: "small", attempts: 1, usage: { prompt: 1, completion: 1, cached: 0, total: 2 } };
      },
    };
    const router = createRoutingClient(
      [
        { name: "groq", key: "groq:per-model-big", client: first },
        { name: "groq", key: "groq:per-model-small", client: second },
      ],
      cooldowns,
    );

    await router.infer([]);
    expect(secondCalls).toBe(1);

    // The exhausted model is skipped next time; its sibling is not.
    const secondRequest = await router.infer([]);
    expect(secondCalls).toBe(2);
    expect(secondRequest.attempts).toBe(1);
  });

  it("can be asked to skip an entry that already answered badly", async () => {
    const cooldowns = { async active() { return new Set<string>(); }, async cool() {} };
    const router = createRoutingClient(
      [
        { name: "groq", key: "groq:first", client: healthy("first") },
        { name: "groq", key: "groq:second", client: healthy("second") },
      ],
      cooldowns,
    );

    const first = await router.infer([]);
    expect(first.key).toBe("groq:first");

    // Excluding it sends the retry to a different model, with its own budget.
    const retry = await router.infer([], { exclude: new Set(["groq:first"]) });
    expect(retry.key).toBe("groq:second");

    // Excluding every entry is an error rather than a silent repeat.
    await expect(router.infer([], { exclude: new Set(["groq:first", "groq:second"]) })).rejects.toThrow(
      /already been tried/,
    );
  });

  it("chains the same provider across several models", () => {
    const cooldowns = createCooldownStore(env.STATE_DB);
    const chained = createConfiguredClient(
      {
        ...env,
        GROQ_API_KEY: "g",
        GEMINI_API_KEY: "gm",
        OPENROUTER_API_KEY: undefined,
        LLM_PROVIDERS: "groq:openai/gpt-oss-120b,groq:openai/gpt-oss-20b,gemini",
      },
      cooldowns,
    );

    // Three links, two of them the same provider on different models.
    expect(chained.model).toContain("openai/gpt-oss-120b");
    expect(chained.model).toContain("openai/gpt-oss-20b");
    expect(chained.model).toContain("gemini");
    expect(chained.model.split(" | ")).toHaveLength(3);
  });

  it("keeps a model id containing colons intact", () => {
    const cooldowns = createCooldownStore(env.STATE_DB);
    // Only the first colon separates provider from model; OpenRouter free ids
    // carry their own.
    const client = createConfiguredClient(
      { ...env, GROQ_API_KEY: "", GEMINI_API_KEY: undefined, OPENROUTER_API_KEY: "o", LLM_PROVIDERS: "openrouter:nvidia/nemotron-3-super-120b-a12b:free" },
      cooldowns,
    );
    expect(client.model).toContain("nvidia/nemotron-3-super-120b-a12b:free");
  });

  it("refuses any OpenRouter model that is not free", () => {
    expect(isFreeOpenRouterModel("openrouter/free")).toBe(true);
    expect(isFreeOpenRouterModel("nvidia/nemotron-3-super-120b-a12b:free")).toBe(true);
    expect(isFreeOpenRouterModel("openai/gpt-4o")).toBe(false);
    expect(isFreeOpenRouterModel("anthropic/claude-opus-4")).toBe(false);

    // A paid id must fail loudly at construction, not quietly on a bill.
    expect(() => createOpenRouterClient("key", "openai/gpt-4o")).toThrow(/not a free-tier id/);
    expect(() => createOpenRouterClient("key", "openrouter/free")).not.toThrow();
  });

  it("builds only the providers that have keys, in the configured order", () => {
    const cooldowns = createCooldownStore(env.STATE_DB);

    const both = createConfiguredClient(
      { ...env, GROQ_API_KEY: "g", OPENROUTER_API_KEY: "o", LLM_PROVIDERS: "groq,openrouter" },
      cooldowns,
    );
    expect(both.model).toContain("groq");
    expect(both.model).toContain("openrouter");

    // With one key there is no router at all, just that provider.
    const groqOnly = createConfiguredClient(
      { ...env, GROQ_API_KEY: "g", OPENROUTER_API_KEY: undefined, LLM_PROVIDERS: "groq,openrouter" },
      cooldowns,
    );
    expect(groqOnly.model).not.toContain("|");

    // Order is configuration, not code.
    const reversed = createConfiguredClient(
      { ...env, GROQ_API_KEY: "g", OPENROUTER_API_KEY: "o", LLM_PROVIDERS: "openrouter,groq" },
      cooldowns,
    );
    expect(reversed.model.indexOf("openrouter")).toBeLessThan(reversed.model.indexOf("groq"));

    expect(() =>
      createConfiguredClient({ ...env, GROQ_API_KEY: "", OPENROUTER_API_KEY: undefined }, cooldowns),
    ).toThrow(/no inference providers/);
  });
});
