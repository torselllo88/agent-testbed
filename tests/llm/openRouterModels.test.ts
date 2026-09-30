import { describe, expect, it } from "vitest";
import { OpenRouterModelCatalog, parseCatalog } from "../../src/llm/openRouterModels.js";

const BODY = {
  data: [
    {
      id: "z-ai/glm",
      name: "GLM",
      context_length: 128000,
      pricing: { prompt: "0.0000006", completion: "0.0000022" },
      supported_parameters: ["temperature", "response_format"],
    },
    {
      id: "google/gemini-2.5-flash-lite",
      name: "Google: Gemini 2.5 Flash Lite",
      context_length: 1048576,
      pricing: { prompt: "0.0000001", completion: "0.0000004" },
      supported_parameters: ["structured_outputs", "response_format"],
    },
    { name: "no id — skipped" },
  ],
};

describe("OpenRouter model catalog", () => {
  it("keeps what the editor needs: stable id, name, context, price per million, structured-output support", () => {
    expect(parseCatalog(BODY)).toEqual([
      { id: "google/gemini-2.5-flash-lite", name: "Google: Gemini 2.5 Flash Lite", contextLength: 1048576, promptPerM: 0.1, completionPerM: 0.4, structuredOutputs: true },
      { id: "z-ai/glm", name: "GLM", contextLength: 128000, promptPerM: 0.6, completionPerM: 2.2, structuredOutputs: false },
    ]);
    expect(() => parseCatalog({ nope: 1 })).toThrow(/unexpected/);
  });

  it("fetches the public endpoint without credentials and caches it", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(BODY), { status: 200 });
    }) as unknown as typeof fetch;
    let now = 1_000_000;
    const catalog = new OpenRouterModelCatalog("https://openrouter.example/api/v1/", fakeFetch, () => now);

    const [a, b] = await Promise.all([catalog.get(), catalog.get()]);
    expect(a.models).toHaveLength(2);
    expect(b).toBe(a);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://openrouter.example/api/v1/models");
    expect(new Headers(calls[0]!.init?.headers).has("authorization")).toBe(false);

    now += 7 * 60 * 60 * 1000; // past the TTL
    await catalog.get();
    expect(calls).toHaveLength(2);
  });

  it("reports an upstream failure instead of an empty list", async () => {
    const failing = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    await expect(new OpenRouterModelCatalog("https://x", failing).get()).rejects.toThrow(/503/);
  });
});
