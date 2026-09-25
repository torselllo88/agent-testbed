import { describe, expect, it } from "vitest";
import { ProviderError, toProviderError } from "../../src/llm/provider.js";
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
    const registry = new ProviderRegistry([], new StubProvider(), ["sk-or-v1-abcdef123456", "x"]);
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
