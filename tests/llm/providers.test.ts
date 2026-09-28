import { describe, expect, it } from "vitest";
import { ProviderError, toProviderError } from "../../src/llm/provider.js";
import { OpenRouterProvider } from "../../src/llm/openRouterProvider.js";
import { createProviderRegistryFromEnv, ProviderRegistry } from "../../src/llm/registry.js";
import { StubProvider } from "../../src/llm/stubProvider.js";

describe("StubProvider", () => {
  it("answers from the registered script and reports estimated usage", async () => {
    const stub = new StubProvider().register("echo", (req) => `seen:${String(req.context?.agentId)}`);
    const result = await stub.complete({
      model: "echo",
      messages: [{ role: "user", content: "hello there" }],
      context: { agentId: "ops" },
    });

    expect(result.text).toBe("seen:ops");
    expect(result.servedModel).toBe("stub/echo");
    expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 2 });
  });

  it("rejects an unknown script with a non-retryable ProviderError", async () => {
    const stub = new StubProvider();
    await expect(stub.complete({ model: "missing", messages: [] })).rejects.toMatchObject({
      name: "ProviderError",
      retryable: false,
    });
  });
});

describe("ProviderRegistry", () => {
  it("has only the stub provider when nothing is configured (tests never load .env)", () => {
    const registry = createProviderRegistryFromEnv();
    expect(registry.has("stub")).toBe(true);
    expect(registry.has("openrouter")).toBe(false);
    expect(registry.status().find((p) => p.id === "openrouter")).toMatchObject({ configured: false });
    expect(() => registry.get("openrouter")).toThrow(ProviderError);
    expect(registry.secretValues()).toEqual([]);
  });

  it("exposes configured credentials for redaction, ignoring trivially short values", () => {
    const registry = new ProviderRegistry([], new StubProvider(), { secrets: ["sk-or-v1-abcdef123456", "x"] });
    expect(registry.secretValues()).toEqual(["sk-or-v1-abcdef123456"]);
  });
});

describe("toProviderError", () => {
  it("classifies rate limits, 5xx and network errors as retryable, other 4xx as not", () => {
    expect(toProviderError(Object.assign(new Error("slow down"), { status: 429 }), "x").retryable).toBe(true);
    expect(toProviderError(Object.assign(new Error("boom"), { status: 503 }), "x").retryable).toBe(true);
    expect(toProviderError(new Error("ECONNRESET"), "x").retryable).toBe(true);
    expect(toProviderError(Object.assign(new Error("bad request"), { status: 400 }), "x").retryable).toBe(false);
  });
});

describe("OpenRouterProvider response handling", () => {
  const completion = (overrides: Record<string, unknown>) =>
    new Response(
      JSON.stringify({
        id: "gen-1",
        object: "chat.completion",
        created: 0,
        model: "google/gemini-2.5-flash-lite",
        provider: "Google",
        choices: [{ index: 0, message: { role: "assistant", content: '{"a":1}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.00001 },
        ...overrides,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  it("reports served model, usage, billed cost and upstream provider", async () => {
    const provider = new OpenRouterProvider({ apiKey: "k", baseUrl: "https://example.test/v1", fetch: async () => completion({}) });
    const result = await provider.complete({ model: "~google/flash-latest", messages: [{ role: "user", content: "hi" }] });
    expect(result).toMatchObject({
      text: '{"a":1}',
      requestedModel: "~google/flash-latest",
      servedModel: "google/gemini-2.5-flash-lite",
      usage: { promptTokens: 10, completionTokens: 5 },
      reportedCostUsd: 0.00001,
      providerMeta: { generationId: "gen-1", upstreamProvider: "Google" },
    });
  });

  it("treats HTTP 200 with finish_reason 'error' (upstream failed mid-response) as a retryable provider error", async () => {
    const provider = new OpenRouterProvider({
      apiKey: "k",
      baseUrl: "https://example.test/v1",
      fetch: async () =>
        completion({
          choices: [{ index: 0, message: { role: "assistant", content: '{\n  "message":' }, finish_reason: "error" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
    });
    await expect(provider.complete({ model: "m", messages: [] })).rejects.toMatchObject({ name: "ProviderError", retryable: true });
  });
});
