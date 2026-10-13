import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BatchService } from "../../src/batch/service.js";
import { ExperimentService } from "../../src/experiment/service.js";
import { HumanInteractionService } from "../../src/interaction/service.js";
import type { LlmProvider } from "../../src/llm/provider.js";
import { ProviderRegistry } from "../../src/llm/registry.js";
import { StubProvider } from "../../src/llm/stubProvider.js";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { EventRepository } from "../../src/persistence/eventRepository.js";
import { ExperimentRepository } from "../../src/persistence/experimentRepository.js";
import { ScenarioRepository } from "../../src/persistence/scenarioRepository.js";
import { BUILTIN_SCENARIOS, createEvaluatorRegistry, DEMO, registerBuiltinStubs } from "../../src/scenarios/index.js";
import { createApp } from "../../src/server/app.js";

/** The About & demo page: one button — real models when OpenRouter is configured, scripted stub agents otherwise. */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function start(withOpenRouter: boolean) {
  const db = createInMemoryDb();
  new ScenarioRepository(db).syncBuiltins(BUILTIN_SCENARIOS);
  const stub = registerBuiltinStubs(new StubProvider());
  // A stand-in for OpenRouter that answers like the scenario's own stub scripts.
  const fakeOpenRouter: LlmProvider = {
    id: "openrouter",
    complete: (req) => stub.complete({ ...req, model: req.context?.purpose === "router" ? "router/next-in-order" : "space-station/cooperative" }),
  };
  const providers = new ProviderRegistry(withOpenRouter ? [fakeOpenRouter] : [], stub);
  const evaluators = createEvaluatorRegistry();
  const service = new ExperimentService({ db, providers, evaluators });
  const batches = new BatchService({ db, providers, evaluators, service });
  const interaction = new HumanInteractionService({ db, providers, experiments: service });
  const server = createApp({ db, providers, evaluators, service, batches, interaction });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(async () => {
    await service.settle();
    await interaction.settle();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const call = async (method: string, path: string) => {
    const res = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { db, service, call };
}

describe("the demo page", () => {
  it("serves its text, says whether the run will be live, and points at the library's built-in", async () => {
    const t = await start(false);
    const { status, body } = await t.call("GET", "/api/demo");
    expect(status).toBe(200);
    expect(body.content.title).toBe(DEMO.content.title);
    expect(body.content.sections.length).toBeGreaterThan(0);
    expect(body.live).toBe(false);
    expect(body.scenarioId).toBe(new ScenarioRepository(t.db).getBuiltin(DEMO.scenario)!.id);
    // Facts read from the scenario itself: they never drift from what runs.
    expect(body.facts).toEqual(expect.arrayContaining(["4 agents", "private facts for each agent", "scripted stand-in agents", "unanimous vote"]));
    expect(body.facts.some((f: string) => /^\d+ evaluator checks$/.test(f))).toBe(true);
  });

  it("without OpenRouter: the scenario's scripted agents, in English", async () => {
    const t = await start(false);
    const { status, body } = await t.call("POST", "/api/demo/run");
    expect(status).toBe(201);
    await t.service.settle();
    const record = new ExperimentRepository(t.db).getOrThrow(body.id);
    expect(record.scenarioId).toBe(new ScenarioRepository(t.db).getBuiltin(DEMO.scenario)!.id);
    expect(record.config.conversation.language).toBe("en");
    expect(record.config.agents.every((a) => a.model.provider === "stub")).toBe(true);
    expect(record.outcome).toBe("SUCCESS");
    const env = new EventRepository(t.db).list(body.id).find((e) => e.type === "experiment_started")!.payload.environment as Record<string, unknown>;
    expect(env.modelsOverridden).toBe(false);
  });

  it("with OpenRouter: the demo's real models for the agents and the routers, recorded as chosen for this run", async () => {
    const t = await start(true);
    expect((await t.call("GET", "/api/demo")).body.live).toBe(true);
    const { status, body } = await t.call("POST", "/api/demo/run");
    expect(status).toBe(201);
    await t.service.settle();
    const record = new ExperimentRepository(t.db).getOrThrow(body.id);
    expect(record.config.agents.every((a) => a.model.provider === "openrouter" && a.model.model === DEMO.liveModels.agents.model)).toBe(true);
    const scheduler = record.config.scheduler;
    expect(scheduler.type === "hybrid" && scheduler.classifier?.model).toBe(DEMO.liveModels.orchestration.model);
    expect(record.config.humanInteraction?.debrief.router?.model).toBe(DEMO.liveModels.orchestration.model);
    const env = new EventRepository(t.db).list(body.id).find((e) => e.type === "experiment_started")!.payload.environment as Record<string, unknown>;
    expect(env.modelsOverridden).toBe(true);
    // The saved built-in is untouched.
    expect(new ScenarioRepository(t.db).getBuiltin(DEMO.scenario)!.config.agents.every((a) => a.model.provider === "stub")).toBe(true);
  });
});
