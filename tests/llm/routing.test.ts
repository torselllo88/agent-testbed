import { describe, expect, it } from "vitest";
import { effectiveOpenRouterRouting, ModelRefSchema, parseExperimentConfig } from "../../src/experiment/config.js";
import { OpenRouterProvider, toOpenRouterProviderObject } from "../../src/llm/openRouterProvider.js";
import type { CompletionRequest, LlmProvider } from "../../src/llm/provider.js";
import { createHarness, ofType, script, testConfig } from "../helpers/harness.js";

describe("OpenRouter routing config", () => {
  it("is OpenRouter-specific: rejected for other providers, strict about unknown fields", () => {
    expect(ModelRefSchema.safeParse({ provider: "openrouter", model: "m", routing: { only: ["together"] } }).success).toBe(true);
    const stub = ModelRefSchema.safeParse({ provider: "stub", model: "m", routing: { only: ["together"] } });
    expect(stub.success).toBe(false);
    expect(JSON.stringify(stub.error?.issues)).toMatch(/OpenRouter-specific/);
    expect(ModelRefSchema.safeParse({ provider: "openrouter", model: "m", routing: { onlyy: ["x"] } }).success).toBe(false);
    expect(ModelRefSchema.safeParse({ provider: "openrouter", model: "m", routing: { only: [] } }).success).toBe(false);
  });

  it("defaults requireParameters to true for native structured output only; an explicit value wins", () => {
    const ref = (extra: Record<string, unknown>) => ModelRefSchema.parse({ provider: "openrouter", model: "m", ...extra });
    expect(effectiveOpenRouterRouting(ref({}))).toEqual({ requireParameters: true });
    expect(effectiveOpenRouterRouting(ref({ structuredOutput: "prompt" }))).toBeNull();
    expect(effectiveOpenRouterRouting(ref({ routing: { requireParameters: false, only: ["together"] } }))).toEqual({
      requireParameters: false,
      only: ["together"],
    });
    expect(effectiveOpenRouterRouting(ModelRefSchema.parse({ provider: "stub", model: "m" }))).toBeNull();
  });

  it("is validated inside a full experiment config, including the router classifier", () => {
    const config = testConfig();
    if (config.scheduler.type === "hybrid") {
      config.scheduler.classifier = { provider: "stub", model: "router/next-in-order", structuredOutput: "native", routing: { sort: "price" } } as never;
    }
    expect(() => parseExperimentConfig(config)).toThrow(/scheduler\.classifier\.routing.*OpenRouter-specific/);
  });
});

describe("OpenRouter request mapping", () => {
  it("maps routing to OpenRouter's snake_case provider object, omitting unset fields", () => {
    expect(
      toOpenRouterProviderObject({ only: ["together"], allowFallbacks: false, requireParameters: true, dataCollection: "deny", sort: "latency" })
    ).toEqual({ only: ["together"], allow_fallbacks: false, require_parameters: true, data_collection: "deny", sort: "latency" });
    expect(toOpenRouterProviderObject(undefined)).toBeNull();
    expect(toOpenRouterProviderObject({})).toBeNull();
  });

  it("sends the provider object in the request body only when routing is given", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const provider = new OpenRouterProvider({
      apiKey: "k",
      baseUrl: "https://example.test/v1",
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            id: "gen-1",
            object: "chat.completion",
            created: 0,
            model: "m",
            provider: "Together",
            choices: [{ index: 0, message: { role: "assistant", content: "{}" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      },
    });
    await provider.complete({ model: "m", messages: [], routing: { order: ["together", "deepinfra"], allowFallbacks: false } });
    await provider.complete({ model: "m", messages: [] });
    expect(bodies[0]!.provider).toEqual({ order: ["together", "deepinfra"], allow_fallbacks: false });
    expect(bodies[1]).not.toHaveProperty("provider");
  });
});

describe("routing in the trace", () => {
  it("records requested and effective routing on every llm_call, next to the backend that actually served it", async () => {
    const seen: CompletionRequest[] = [];
    const respond = script({});
    const fake: LlmProvider = {
      id: "openrouter",
      async complete(req) {
        seen.push(req);
        return { text: respond(req), requestedModel: req.model, servedModel: req.model, usage: { promptTokens: 1, completionTokens: 1 }, providerMeta: { upstreamProvider: "Together" } };
      },
    };
    const h = createHarness({ providers: [fake] });
    const config = testConfig();
    for (const agent of config.agents) agent.model = { provider: "openrouter", model: "vendor/m", structuredOutput: "native", routing: { only: ["together"] } };
    if (config.scheduler.type === "hybrid") config.scheduler.classifier = null;
    const runner = h.runner(config);
    await runner.run();

    expect(seen.every((r) => r.routing?.only?.[0] === "together" && r.routing.requireParameters === true)).toBe(true);
    const call = ofType(h.events(runner.id), "llm_call")[0]!;
    expect(call.payload.routing).toEqual({ requested: { only: ["together"] }, effective: { only: ["together"], requireParameters: true } });
    expect(call.payload.providerMeta).toMatchObject({ upstreamProvider: "Together" });
  });
});
