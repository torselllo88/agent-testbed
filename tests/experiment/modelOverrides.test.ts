import { describe, expect, it } from "vitest";
import { applyRunOverrides, parseExperimentConfig, RunOverridesSchema } from "../../src/experiment/config.js";
import { ConfigNotRunnableError, ExperimentRunner } from "../../src/experiment/runner.js";
import { createEvaluatorRegistry } from "../../src/scenarios/index.js";
import { kestrelConfig } from "../../src/scenarios/spaceStation/kestrel.js";
import { spaceStationConfig } from "../../src/scenarios/spaceStation/config.js";
import { createHarness, ofType } from "../helpers/harness.js";

/** Choosing models for a whole run: overrides.models. */

const HAIKU = { provider: "openrouter" as const, model: "anthropic/claude-haiku-4.5", structuredOutput: "native" as const };
const LITE = { provider: "openrouter" as const, model: "google/gemini-2.5-flash-lite", structuredOutput: "prompt" as const };

describe("overrides.models", () => {
  it("sets provider and model of every agent; temperature, seed and output cap stay; routing is dropped", () => {
    const scenario = parseExperimentConfig(kestrelConfig());
    scenario.agents[0]!.model = { ...scenario.agents[0]!.model, provider: "openrouter", temperature: 0.3, seed: 7, routing: { only: ["together"] } };
    const run = applyRunOverrides(scenario, { models: { agents: HAIKU } });
    for (const [i, agent] of run.agents.entries()) {
      expect(agent.model).toMatchObject({ provider: "openrouter", model: HAIKU.model, structuredOutput: "native" });
      expect(agent.model.maxOutputTokens).toBe(scenario.agents[i]!.model.maxOutputTokens);
      expect(agent.model.routing).toBeUndefined();
    }
    expect(run.agents[0]!.model).toMatchObject({ temperature: 0.3, seed: 7 });
    // The scenario itself is untouched.
    expect(scenario.agents[1]!.model.provider).toBe("stub");
  });

  it("orchestration: the router classifier and the debrief router the scenario has — none is switched on", () => {
    const kestrel = applyRunOverrides(parseExperimentConfig(kestrelConfig()), { models: { orchestration: LITE } });
    expect(kestrel.scheduler.type === "hybrid" && kestrel.scheduler.classifier).toMatchObject({ provider: "openrouter", model: LITE.model, structuredOutput: "prompt" });
    expect(kestrel.humanInteraction?.debrief.router).toMatchObject({ provider: "openrouter", model: LITE.model });
    expect(kestrel.agents.every((a) => a.model.provider === "stub")).toBe(true); // agents untouched

    const bare = parseExperimentConfig(spaceStationConfig());
    if (bare.scheduler.type === "hybrid") bare.scheduler.classifier = null;
    const run = applyRunOverrides(bare, { models: { orchestration: LITE } });
    expect(run.scheduler.type === "hybrid" && run.scheduler.classifier).toBeNull();
    expect(run.humanInteraction?.debrief.router ?? null).toBeNull();
  });

  it("without structuredOutput, each reference keeps its own mode", () => {
    const scenario = parseExperimentConfig(spaceStationConfig());
    scenario.agents[0]!.model.structuredOutput = "prompt";
    const run = applyRunOverrides(scenario, { models: { agents: { provider: "stub", model: "space-station/cooperative" } } });
    expect(run.agents.map((a) => a.model.structuredOutput)).toEqual(scenario.agents.map((a) => a.model.structuredOutput));
  });

  it("is validated strictly", () => {
    expect(() => RunOverridesSchema.parse({ models: { agents: { provider: "openrouter" } } })).toThrow();
    expect(() => RunOverridesSchema.parse({ models: { agent: HAIKU } })).toThrow();
    expect(() => RunOverridesSchema.parse({ models: { agents: { ...HAIKU, temperature: 1 } } })).toThrow();
  });

  it("a run records the models it used and that they were chosen for it; the task definition is unchanged", async () => {
    const h = createHarness();
    const base = () => {
      const c = spaceStationConfig();
      c.runtime.providerRetryDelayMs = 0;
      return c;
    };
    const plain = h.runner(base());
    const chosen = new ExperimentRunner({ db: h.db, providers: h.providers, evaluators: createEvaluatorRegistry() }, base(), {
      overrides: { models: { agents: { provider: "stub", model: "space-station/insufficient-power" } } },
    });
    const [plainMetrics, chosenMetrics] = await Promise.all([plain.run(), chosen.run()]);
    expect(plainMetrics.termination?.outcome).toBe("SUCCESS");
    expect(chosenMetrics.termination?.outcome).toBe("MISSION_FAILURE"); // the chosen models really ran
    const env = (id: string) => ofType(h.events(id), "experiment_started")[0]!.payload.environment;
    expect(env(plain.id)).toMatchObject({ modelsOverridden: false });
    expect(env(chosen.id)).toMatchObject({ modelsOverridden: true });
    expect(h.record(chosen.id).config.agents.every((a) => a.model.model === "space-station/insufficient-power")).toBe(true);
    expect(h.record(chosen.id).configHash).not.toBe(h.record(plain.id).configHash);
    expect(h.record(chosen.id).taskDefinitionHash).toBe(h.record(plain.id).taskDefinitionHash);
  });

  it("a provider that is not configured is refused before a run exists", () => {
    const h = createHarness();
    expect(
      () => new ExperimentRunner({ db: h.db, providers: h.providers, evaluators: createEvaluatorRegistry() }, spaceStationConfig(), { overrides: { models: { agents: HAIKU } } })
    ).toThrow(ConfigNotRunnableError);
  });
});
