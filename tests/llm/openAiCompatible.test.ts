import { afterEach, describe, expect, it } from "vitest";
import { resolveOpenAiCompatibleEndpoints } from "../../src/config/env.js";
import { applyRunOverrides, modelProviderKey, parseExperimentConfig } from "../../src/experiment/config.js";
import { ConfigNotRunnableError, ExperimentRunner } from "../../src/experiment/runner.js";
import { OpenAiCompatibleProvider } from "../../src/llm/openAiCompatibleProvider.js";
import { ProviderRegistry } from "../../src/llm/registry.js";
import { StubProvider } from "../../src/llm/stubProvider.js";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { EventRepository } from "../../src/persistence/eventRepository.js";
import { ExperimentRepository } from "../../src/persistence/experimentRepository.js";
import { createEvaluatorRegistry, registerBuiltinStubs } from "../../src/scenarios/index.js";
import { spaceStationConfig } from "../../src/scenarios/spaceStation/config.js";
import { FAKE_MODELS, startFakeOpenAiServer, type FakeOpenAiServer } from "../helpers/fakeOpenAiServer.js";

/** Self-hosted OpenAI-compatible endpoints (vLLM, TGI, …): config names the endpoint, the environment says where it is. */

const servers: FakeOpenAiServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});
async function fakeServer() {
  const s = await startFakeOpenAiServer();
  servers.push(s);
  return s;
}

const labModel = (structuredOutput: "native" | "prompt" = "native") =>
  ({ provider: "openai-compatible", endpoint: "lab-vllm", model: FAKE_MODELS[0]!, structuredOutput }) as const;

function labConfig(structuredOutput: "native" | "prompt" = "native") {
  const config = spaceStationConfig();
  config.runtime.providerRetryDelayMs = 0;
  for (const agent of config.agents) agent.model = { ...labModel(structuredOutput) };
  if (config.scheduler.type === "hybrid") config.scheduler.classifier = { ...labModel(structuredOutput) };
  return config;
}

describe("configuration", () => {
  it("an openai-compatible model names an endpoint; other providers must not", () => {
    expect(() => parseExperimentConfig(labConfig())).not.toThrow();
    const missing = labConfig();
    delete (missing.agents[0]!.model as { endpoint?: string }).endpoint;
    expect(() => parseExperimentConfig(missing)).toThrow(/needs an endpoint name/);
    const stray = spaceStationConfig();
    (stray.agents[0]!.model as { endpoint?: string }).endpoint = "lab-vllm";
    expect(() => parseExperimentConfig(stray)).toThrow(/only meaningful for provider "openai-compatible"/);
    expect(modelProviderKey(labModel())).toBe("openai-compatible:lab-vllm");
    expect(modelProviderKey({ provider: "openrouter" })).toBe("openrouter");
  });

  it("existing configs are unchanged: no endpoint field appears", () => {
    expect(parseExperimentConfig(spaceStationConfig()).agents.every((a) => !("endpoint" in a.model))).toBe(true);
  });

  it("reads endpoints from the environment: name list, URL, optional key and request limit", () => {
    expect(
      resolveOpenAiCompatibleEndpoints({
        OPENAI_COMPATIBLE_ENDPOINTS: "lab-vllm, lab-tgi",
        OPENAI_COMPATIBLE_LAB_VLLM_BASE_URL: "http://gpu-3:8000/v1",
        OPENAI_COMPATIBLE_LAB_VLLM_API_KEY: "secret-key-123",
        OPENAI_COMPATIBLE_LAB_VLLM_MAX_CONCURRENT: "16",
      })
    ).toEqual([
      { name: "lab-vllm", baseUrl: "http://gpu-3:8000/v1", apiKey: "secret-key-123", maxConcurrent: 16 },
      { name: "lab-tgi" },
    ]);
  });

  it("run overrides can choose an endpoint for all agents", () => {
    const run = applyRunOverrides(parseExperimentConfig(spaceStationConfig()), { models: { agents: labModel() } });
    expect(run.agents.every((a) => a.model.provider === "openai-compatible" && a.model.endpoint === "lab-vllm")).toBe(true);
    const back = applyRunOverrides(run, { models: { agents: { provider: "stub", model: "space-station/cooperative" } } });
    expect(back.agents.every((a) => !("endpoint" in a.model))).toBe(true);
  });
});

describe("the provider", () => {
  it("calls the server over HTTP: schema enforced natively or described in the prompt, usage recorded, key sent", async () => {
    const fake = await fakeServer();
    const provider = new OpenAiCompatibleProvider({ name: "lab-vllm", baseUrl: fake.url, apiKey: "lab-key-0123456789" });
    const native = await provider.complete({
      model: FAKE_MODELS[0]!,
      messages: [{ role: "user", content: "VOTING phase. …" }],
      responseFormat: { name: "vote", schema: { type: "object" } },
    });
    expect(JSON.parse(native.text)).toMatchObject({ vote: "APPROVE" });
    expect(native).toMatchObject({ servedModel: FAKE_MODELS[0], usage: { promptTokens: 100, completionTokens: 20 }, providerMeta: { endpoint: "lab-vllm" } });
    expect(fake.requests[0]).toMatchObject({ kind: "vote", native: true, authorization: "Bearer lab-key-0123456789" });
    await provider.complete({ model: FAKE_MODELS[0]!, messages: [{ role: "user", content: "VOTING phase. …" }] });
    expect(fake.requests[1]).toMatchObject({ kind: "vote", native: false });
    expect(await provider.listModels()).toEqual([...FAKE_MODELS].sort());
  });

  it("an unknown model is a non-retryable request error; an unreachable server a retryable one", async () => {
    const fake = await fakeServer();
    const provider = new OpenAiCompatibleProvider({ name: "lab-vllm", baseUrl: fake.url });
    await expect(provider.complete({ model: "nope", messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ retryable: false, status: 404 });
    const down = new OpenAiCompatibleProvider({ name: "lab-down", baseUrl: "http://127.0.0.1:9/v1" });
    await expect(down.complete({ model: "m", messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ retryable: true });
  });
});

describe("running an experiment on a self-hosted endpoint", () => {
  async function run(structuredOutput: "native" | "prompt") {
    const fake = await fakeServer();
    const db = createInMemoryDb();
    const providers = new ProviderRegistry(
      [new OpenAiCompatibleProvider({ name: "lab-vllm", baseUrl: fake.url, apiKey: "lab-key-0123456789" })],
      registerBuiltinStubs(new StubProvider()),
      { secrets: ["lab-key-0123456789"], maxConcurrentRequests: 8, maxConcurrentByProvider: { "openai-compatible:lab-vllm": 2 } }
    );
    const runner = new ExperimentRunner({ db, providers, evaluators: createEvaluatorRegistry() }, labConfig(structuredOutput));
    const metrics = await runner.run();
    return { fake, db, providers, runner, metrics };
  }

  it("runs end to end, with its own request gate; cost unknown, never the key in the trace", async () => {
    const { fake, db, providers, runner, metrics } = await run("native");
    expect(metrics.termination?.outcome).toBe("SUCCESS");
    expect(fake.requests.length).toBeGreaterThan(4);
    expect(new Set(fake.requests.map((r) => r.kind))).toEqual(new Set(["agent_turn", "final_proposal", "vote", "next_speaker"])); // the router classifier runs there too
    expect(providers.gate("openai-compatible:lab-vllm")?.stats().maxConcurrent).toBe(2);
    expect(metrics.costUsd.callsWithUnknownCost).toBeGreaterThan(0);
    const events = new EventRepository(db).list(runner.id);
    const call = events.find((e) => e.type === "llm_call")!.payload;
    expect(call).toMatchObject({ provider: "openai-compatible:lab-vllm", servedModel: FAKE_MODELS[0], costSource: "unknown" });
    expect(JSON.stringify(events)).not.toContain("lab-key-0123456789");
    expect(new ExperimentRepository(db).getOrThrow(runner.id).config.agents[0]!.model).toMatchObject({ provider: "openai-compatible", endpoint: "lab-vllm" });
  });

  it("works in prompt-only mode for servers without structured output", async () => {
    const { fake, metrics } = await run("prompt");
    expect(metrics.termination?.outcome).toBe("SUCCESS");
    expect(fake.requests.every((r) => !r.native)).toBe(true);
  });

  it("an endpoint that is not configured is refused before a run exists, naming what to set", () => {
    const providers = new ProviderRegistry([], registerBuiltinStubs(new StubProvider()));
    expect(() => new ExperimentRunner({ db: createInMemoryDb(), providers, evaluators: createEvaluatorRegistry() }, labConfig())).toThrow(ConfigNotRunnableError);
    try {
      new ExperimentRunner({ db: createInMemoryDb(), providers, evaluators: createEvaluatorRegistry() }, labConfig());
    } catch (err) {
      expect((err as ConfigNotRunnableError).problems[0]).toContain('OpenAI-compatible endpoint "lab-vllm" is not configured');
    }
  });

  it("the registry lists each endpoint with its URL (never its key), and declared-but-incomplete ones as not configured", async () => {
    const fake = await fakeServer();
    const providers = new ProviderRegistry([new OpenAiCompatibleProvider({ name: "lab-vllm", baseUrl: fake.url, apiKey: "k-0123456789" })], new StubProvider(), {
      maxConcurrentRequests: 4,
      unavailable: [{ id: "openai-compatible:lab-tgi", configured: false, hint: "Set OPENAI_COMPATIBLE_LAB_TGI_BASE_URL", endpoint: { name: "lab-tgi" } }],
    });
    const status = providers.status();
    expect(status.find((s) => s.id === "openai-compatible:lab-vllm")).toMatchObject({ configured: true, endpoint: { name: "lab-vllm", baseUrl: fake.url } });
    expect(status.find((s) => s.id === "openai-compatible:lab-tgi")).toMatchObject({ configured: false });
    expect(JSON.stringify(status)).not.toContain("k-0123456789");
  });
});
