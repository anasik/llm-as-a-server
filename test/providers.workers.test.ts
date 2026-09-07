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
        { name: "groq", client: rateLimited("groq") },
        { name: "openrouter", client: healthy("openrouter") },
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
        { name: "groq-cooldown-test", client: groq },
        { name: "openrouter", client: healthy("openrouter") },
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
        { name: "a", client: broken("a") },
        { name: "b", client: healthy("b") },
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
        { name: "a", client: broken("a") },
        { name: "b", client: rateLimited("b") },
      ],
      cooldowns,
    );

    await expect(router.infer([])).rejects.toBeInstanceOf(ProviderError);
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
