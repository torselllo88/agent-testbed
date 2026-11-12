import { afterEach, describe, expect, it } from "vitest";
import { resolveOpenAiCompatibleEndpoints } from "../../src/config/env.js";
import { applyRunOverrides, parseExperimentConfig, withModelChoice } from "../../src/experiment/config.js";
import { ConfigNotRunnableError, ExperimentRunner } from "../../src/experiment/runner.js";
import { contextOverflowSuspected, OllamaProvider } from "../../src/llm/ollamaProvider.js";
import { OpenAiCompatibleProvider } from "../../src/llm/openAiCompatibleProvider.js";
import { ProviderError } from "../../src/llm/provider.js";
import { isSelfHostedProvider, ProviderRegistry } from "../../src/llm/registry.js";
import { StubProvider } from "../../src/llm/stubProvider.js";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { EventRepository } from "../../src/persistence/eventRepository.js";
import { createEvaluatorRegistry, registerBuiltinStubs } from "../../src/scenarios/index.js";
import { spaceStationConfig } from "../../src/scenarios/spaceStation/config.js";
import { FAKE_OLLAMA_MODELS, startFakeOllamaServer, type FakeOllamaServer } from "../helpers/fakeOllamaServer.js";

/** Ollama endpoints: the native API, so thinking, the context window and the seed are set per request and recorded. */

const servers: FakeOllamaServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});
async function fakeServer() {
  const s = await startFakeOllamaServer();
  servers.push(s);
  return s;
}

const MESSAGES = [
  { role: "system" as const, content: "You are an agent." },
  { role: "user" as const, content: "Return {\"ok\": true}" },
];

describe("Ollama provider", () => {
  it("sends think, the options and the schema natively, and reads the answer, usage and timings", async () => {
    const server = await fakeServer();
    // A trailing /v1 (the OpenAI-compatible address people copy) is ignored.
    const provider = new OllamaProvider({ name: "lab-ollama", baseUrl: `${server.url}/v1/` });
    const result = await provider.complete({
      model: FAKE_OLLAMA_MODELS[0]!,
      messages: MESSAGES,
      temperature: 0,
      seed: 7,
      maxOutputTokens: 300,
      think: false,
      contextLength: 8192,
      responseFormat: { name: "vote", schema: { type: "object", properties: { ok: { type: "boolean" } } } },
    });
    expect(server.requests[0]).toEqual({
      model: FAKE_OLLAMA_MODELS[0],
      messages: MESSAGES,
      stream: false,
      think: false,
      format: { type: "object", properties: { ok: { type: "boolean" } } },
      options: { temperature: 0, seed: 7, num_predict: 300, num_ctx: 8192 },
    });
    expect(result).toMatchObject({
      servedModel: FAKE_OLLAMA_MODELS[0],
      usage: { promptTokens: 900, completionTokens: 40 },
      finishReason: "stop",
      providerMeta: { endpoint: "lab-ollama", api: "ollama", contextLength: 8192, durationsMs: { total: 2500, load: 1000, promptEval: 500, eval: 1000 } },
    });
    expect(result.providerMeta).not.toHaveProperty("contextOverflowSuspected");
    expect(result.providerMeta).not.toHaveProperty("thinking");
  });

  it("leaves out what is not configured, and keeps thinking the model did anyway apart from the answer", async () => {
    const server = await fakeServer();
    server.respondWith({ extra: { message: { role: "assistant", content: "{\"ok\":true}", thinking: "Let me think…" } } });
    const result = await new OllamaProvider({ name: "lab-ollama", baseUrl: server.url }).complete({ model: FAKE_OLLAMA_MODELS[0]!, messages: MESSAGES });
    expect(server.requests[0]).toEqual({ model: FAKE_OLLAMA_MODELS[0], messages: MESSAGES, stream: false });
    expect(result.text).toBe("{\"ok\":true}");
    expect(result.providerMeta).toMatchObject({ thinking: "Let me think…", contextLength: null });
  });

  it("flags a prompt that probably did not fit the context window", async () => {
    expect(contextOverflowSuspected(MESSAGES, undefined, 10_000)).toBe(false);
    expect(contextOverflowSuspected([{ role: "user", content: "x".repeat(4100) }], 1000, undefined)).toBe(true);
    expect(contextOverflowSuspected(MESSAGES, 1000, 960)).toBe(true);
    expect(contextOverflowSuspected(MESSAGES, 1000, 500)).toBe(false);
    const server = await fakeServer();
    const result = await new OllamaProvider({ name: "lab-ollama", baseUrl: server.url }).complete({ model: FAKE_OLLAMA_MODELS[0]!, messages: MESSAGES, contextLength: 920 });
    expect(result.providerMeta).toMatchObject({ contextOverflowSuspected: true });
  });

  it("maps server errors: an unknown model is not retried, an overloaded server is", async () => {
    const server = await fakeServer();
    const provider = new OllamaProvider({ name: "lab-ollama", baseUrl: server.url });
    const missing = await provider.complete({ model: "no-such:1b", messages: MESSAGES }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(ProviderError);
    expect(missing).toMatchObject({ retryable: false, status: 404 });
    expect((missing as Error).message).toMatch(/not found, try pulling it first/);
    server.respondWith({ status: 503, body: { error: "server busy" } });
    await expect(provider.complete({ model: FAKE_OLLAMA_MODELS[0]!, messages: MESSAGES })).rejects.toMatchObject({ retryable: true, status: 503 });
    await expect(new OllamaProvider({ name: "down", baseUrl: "http://127.0.0.1:9" }).complete({ model: "m", messages: MESSAGES })).rejects.toMatchObject({ retryable: true });
  });

  it("on an OpenAI-API server, think goes as chat_template_kwargs (vLLM, SGLang), and a context window is refused", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchStub = (async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)));
      const completion = { id: "c1", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "{}" }, finish_reason: "stop" }] };
      return new Response(JSON.stringify(completion), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const provider = new OpenAiCompatibleProvider({ name: "lab-vllm", baseUrl: "http://gpu:8000/v1", fetch: fetchStub });
    await provider.complete({ model: "m", messages: MESSAGES, think: false });
    expect(bodies[0]).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
    await provider.complete({ model: "m", messages: MESSAGES });
    expect(bodies[1]).not.toHaveProperty("chat_template_kwargs");
    await expect(provider.complete({ model: "m", messages: MESSAGES, contextLength: 8192 })).rejects.toMatchObject({ retryable: false });
  });

  it("lists the models the server has pulled", async () => {
    const server = await fakeServer();
    expect(await new OllamaProvider({ name: "lab-ollama", baseUrl: server.url }).listModels()).toEqual([...FAKE_OLLAMA_MODELS].sort());
  });
});

describe("configuration", () => {
  it("an endpoint speaks Ollama's API with _API=ollama; anything else is not configured, with a hint", () => {
    expect(
      resolveOpenAiCompatibleEndpoints({
        OPENAI_COMPATIBLE_ENDPOINTS: "lab-ollama,lab-x",
        OPENAI_COMPATIBLE_LAB_OLLAMA_BASE_URL: "http://localhost:11434",
        OPENAI_COMPATIBLE_LAB_OLLAMA_API: "Ollama",
        OPENAI_COMPATIBLE_LAB_X_BASE_URL: "http://x",
        OPENAI_COMPATIBLE_LAB_X_API: "grpc",
      })
    ).toEqual([
      { name: "lab-ollama", baseUrl: "http://localhost:11434", api: "ollama" },
      { name: "lab-x", baseUrl: "http://x", api: "openai", invalidApi: "grpc" },
    ]);
  });

  it("think and contextLength belong to self-hosted endpoints only; a model choice sets, keeps or drops them", () => {
    const config = spaceStationConfig();
    config.agents[0]!.model = { provider: "openai-compatible", endpoint: "lab-ollama", model: "m", structuredOutput: "native", think: false, contextLength: 8192 };
    expect(() => parseExperimentConfig(config)).not.toThrow();
    const stray = spaceStationConfig();
    (stray.agents[0]!.model as { think?: boolean }).think = false;
    expect(() => parseExperimentConfig(stray)).toThrow(/think is only meaningful for a self-hosted endpoint/);

    const ref = config.agents[0]!.model;
    expect(withModelChoice(ref, { provider: "openai-compatible", endpoint: "lab-ollama", model: "other" })).toMatchObject({ think: false, contextLength: 8192, model: "other" });
    expect(withModelChoice(ref, { provider: "openai-compatible", endpoint: "lab-ollama", model: "m", think: true, contextLength: 4096 })).toMatchObject({ think: true, contextLength: 4096 });
    const elsewhere = withModelChoice(ref, { provider: "openrouter", model: "a/b" });
    expect(elsewhere).not.toHaveProperty("think");
    expect(elsewhere).not.toHaveProperty("contextLength");
    // A run override from a stub scenario can switch thinking off and set the window for every agent.
    const run = applyRunOverrides(parseExperimentConfig(spaceStationConfig()), {
      models: { agents: { provider: "openai-compatible", endpoint: "lab-ollama", model: "m", think: false, contextLength: 8192 } },
    });
    expect(run.agents.every((a) => a.model.think === false && a.model.contextLength === 8192)).toBe(true);
  });
});

function harness(server: FakeOllamaServer | null, api: "ollama" | "openai" = "ollama") {
  const db = createInMemoryDb();
  const provider =
    api === "ollama"
      ? new OllamaProvider({ name: "lab-ollama", baseUrl: server!.url })
      : new OpenAiCompatibleProvider({ name: "lab-ollama", baseUrl: "http://127.0.0.1:9/v1" });
  const providers = new ProviderRegistry([provider], registerBuiltinStubs(new StubProvider()));
  return { db, providers, evaluators: createEvaluatorRegistry() };
}

function ollamaConfig(model: Record<string, unknown> = {}) {
  const config = spaceStationConfig();
  config.runtime.providerRetryDelayMs = 0;
  config.scheduler = { type: "round_robin", startAgentId: "operations" };
  for (const agent of config.agents) {
    agent.model = { provider: "openai-compatible", endpoint: "lab-ollama", model: FAKE_OLLAMA_MODELS[0]!, structuredOutput: "native", temperature: 0, seed: 1, think: false, contextLength: 8192, ...model };
  }
  return config;
}

describe("a run on an Ollama endpoint", () => {
  it("runs end to end, and every call records the serving options it was sent with", async () => {
    const server = await fakeServer();
    const deps = harness(server);
    const runner = new ExperimentRunner(deps, ollamaConfig());
    const metrics = await runner.run();
    expect(metrics.termination?.outcome).toBe("SUCCESS");
    expect(server.requests.length).toBeGreaterThan(0);
    expect(server.requests.every((r) => r.think === false && r.options?.num_ctx === 8192 && r.options?.seed === 1 && r.options?.temperature === 0)).toBe(true);
    const calls = new EventRepository(deps.db).list(runner.id).filter((e) => e.type === "llm_call");
    expect(calls.every((c) => c.payload.think === false && c.payload.contextLength === 8192)).toBe(true);
    expect(calls[0]!.payload.providerMeta).toMatchObject({ api: "ollama", contextLength: 8192 });
    expect(metrics.llmCalls).toMatchObject({ contextOverflowSuspected: 0, withThinking: 0 });
    expect(isSelfHostedProvider(deps.providers.get("openai-compatible:lab-ollama"))).toBe(true);
    expect(deps.providers.status().find((s) => s.id === "openai-compatible:lab-ollama")?.endpoint).toMatchObject({ api: "ollama" });
  });

  it("a prompt that may not fit the window is counted in the metrics", async () => {
    const server = await fakeServer();
    const metrics = await new ExperimentRunner(harness(server), ollamaConfig({ contextLength: 300 })).run();
    expect(metrics.llmCalls.contextOverflowSuspected).toBe(metrics.llmCalls.total);
  });

  it("contextLength on an endpoint that speaks the OpenAI API is refused before the run starts", () => {
    expect(() => new ExperimentRunner(harness(null, "openai"), ollamaConfig())).toThrow(ConfigNotRunnableError);
    expect(() => new ExperimentRunner(harness(null, "openai"), ollamaConfig())).toThrow(/speaks the OpenAI API/);
    // think alone is fine there (chat_template_kwargs).
    expect(() => new ExperimentRunner(harness(null, "openai"), ollamaConfig({ contextLength: undefined }))).not.toThrow();
  });
});
