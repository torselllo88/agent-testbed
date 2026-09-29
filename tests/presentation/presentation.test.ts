import { describe, expect, it } from "vitest";
import { applyRunOverrides, configHash, parseExperimentConfig, taskDefinitionHash, type ExperimentConfig } from "../../src/experiment/config.js";
import type { CompletionRequest } from "../../src/llm/provider.js";
import { endingNarration, openingNarration, renderTemplate } from "../../src/presentation/narration.js";
import { runtimeStrings } from "../../src/presentation/runtimeStrings.js";
import { ReadOnlyScenarioError, ScenarioRepository } from "../../src/persistence/scenarioRepository.js";
import { BUILTIN_SCENARIOS } from "../../src/scenarios/index.js";
import { spaceStationConfig } from "../../src/scenarios/spaceStation/config.js";
import { kestrelConfig } from "../../src/scenarios/spaceStation/kestrel.js";
import { termination } from "../../src/experiment/outcome.js";
import { createHarness, ofType, script, useModel } from "../helpers/harness.js";

/** Kestrel with test-speed settings: no pacing, no retry delays. */
function fastKestrel(model?: string, mutate?: (c: ExperimentConfig) => void): ExperimentConfig {
  const c = kestrelConfig(model);
  c.presentation.pacing = { minVisibleIntervalMs: 0, perCharMs: 0, maxGapMs: 0 };
  c.runtime.providerRetryDelayMs = 0;
  mutate?.(c);
  return c;
}

const messages = (h: ReturnType<typeof createHarness>, id: string) =>
  ofType(h.events(id), "message_posted").map((e) => e.payload as { index: number; sender: { kind: string; name?: string }; text: string; narration?: { source: string; language: string } });

describe("task definition hash", () => {
  it("is shared by the benchmark and Kestrel, while the full config hash differs", () => {
    const benchmark = parseExperimentConfig(spaceStationConfig());
    const kestrel = parseExperimentConfig(kestrelConfig());
    expect(taskDefinitionHash(kestrel)).toBe(taskDefinitionHash(benchmark));
    expect(configHash(kestrel)).not.toBe(configHash(benchmark));
  });

  it("ignores language, persona, names, models and presentation — but not private facts or the evaluator", () => {
    const base = parseExperimentConfig(kestrelConfig());
    const cosmetic = structuredClone(base);
    cosmetic.conversation.language = "ru";
    cosmetic.agents[0]!.persona = "completely different";
    cosmetic.agents[0]!.name = "Someone Else";
    cosmetic.agents[0]!.model = { provider: "openrouter", model: "x/y", structuredOutput: "prompt" };
    cosmetic.presentation.pacing.minVisibleIntervalMs = 1;
    expect(taskDefinitionHash(cosmetic)).toBe(taskDefinitionHash(base));
    expect(configHash(cosmetic)).not.toBe(configHash(base));

    const facts = structuredClone(base);
    facts.agents[2]!.privateContext += "\nExtra fact.";
    expect(taskDefinitionHash(facts)).not.toBe(taskDefinitionHash(base));
    const env = structuredClone(base);
    (env.evaluator.params as { coolantRequiredKw: number }).coolantRequiredKw = 35;
    expect(taskDefinitionHash(env)).not.toBe(taskDefinitionHash(base));
  });
});

describe("run overrides", () => {
  it("apply to the run's snapshot without touching the scenario", () => {
    const scenario = parseExperimentConfig(kestrelConfig());
    const run = applyRunOverrides(scenario, { language: "ru" });
    expect(run.conversation.language).toBe("ru");
    expect(scenario.conversation.language).toBe("en");
  });

  it("are recorded in the run environment and snapshot", async () => {
    const h = createHarness();
    const runner = h.runner(fastKestrel());
    // Harness constructs runners without overrides; build one with the option directly.
    const { ExperimentRunner } = await import("../../src/experiment/runner.js");
    const { createEvaluatorRegistry } = await import("../../src/scenarios/index.js");
    const overridden = new ExperimentRunner({ db: h.db, providers: h.providers, evaluators: createEvaluatorRegistry() }, fastKestrel(), {
      overrides: { language: "ru" },
    });
    await Promise.all([runner.run(), overridden.run()]);

    const env = (id: string) => ofType(h.events(id), "experiment_started")[0]!.payload.environment;
    expect(env(runner.id)).toMatchObject({ conversationLanguage: "en", languageOverridden: false, scenarioDefaultLanguage: "en" });
    expect(env(overridden.id)).toMatchObject({ conversationLanguage: "ru", languageOverridden: true, scenarioDefaultLanguage: "en" });
    expect(h.record(overridden.id).config.conversation.language).toBe("ru");
    expect(h.record(overridden.id).taskDefinitionHash).toBe(h.record(runner.id).taskDefinitionHash);
  });
});

describe("Kestrel end-to-end (stub agents)", () => {
  it("opens and ends with narration in the room; agents never see it", async () => {
    const seen: CompletionRequest[] = [];
    const cooperative = (await import("../../src/scenarios/spaceStation/stubScripts.js")).spaceStationScript("cooperative");
    const h = createHarness({ scripts: { "test/record": (req) => (seen.push(req), cooperative(req)) } });
    const config = fastKestrel();
    useModel(config, "test/record");
    const runner = h.runner(config);
    const metrics = await runner.run();

    expect(metrics.termination?.outcome).toBe("SUCCESS");
    const room = messages(h, runner.id);
    expect(room[0]).toMatchObject({ index: 1, sender: { kind: "narrator", name: "MISSION CONTROL" }, narration: { source: "opening", language: "en" } });
    expect(room[0]!.text).toContain("Station Kestrel has lost its primary reactor cooling loop");
    expect(room.at(-1)).toMatchObject({ sender: { kind: "narrator" }, narration: { source: "outcomes.SUCCESS" } });
    expect(room.at(-1)!.text).toContain("Mission successful");
    expect(metrics.messages.narrator).toBe(2);

    // Narration never reaches any agent's context.
    for (const req of seen) expect(req.messages.map((m) => m.content).join("\n")).not.toContain("03:17 UTC");
    // Persona reaches its agent; names come from the cast.
    const sarah = seen.find((r) => r.context?.agentId === "operations")!;
    expect(sarah.messages[0]!.content).toContain("You are Sarah Okafor");
    expect(sarah.messages[0]!.content).toContain("Your character");
  });

  it("in Russian: agents are told to write Russian, moderator notices and narration are Russian, machine values are not", async () => {
    const seen: CompletionRequest[] = [];
    const cooperative = (await import("../../src/scenarios/spaceStation/stubScripts.js")).spaceStationScript("cooperative");
    const h = createHarness({ scripts: { "test/record": (req) => (seen.push(req), cooperative(req)) } });
    const config = fastKestrel(undefined, (c) => {
      c.conversation.language = "ru";
    });
    useModel(config, "test/record");
    const runner = h.runner(config);
    await runner.run();

    expect(seen[0]!.messages[0]!.content).toContain("in Russian (ru)");
    expect(seen[0]!.messages[0]!.content).toMatch(/never translate them/);
    const room = messages(h, runner.id);
    expect(room[0]!.sender.name).toBe("ЦЕНТР УПРАВЛЕНИЯ");
    expect(room[0]!.text).toContain("Станция «Кестрел»");
    expect(room.find((m) => m.sender.kind === "system")!.text).toContain("Итоговое предложение №1");
    // The protocol notice carries a machine-readable tag so viewers can recognize it; its text is unchanged for agents.
    const notice = ofType(h.events(runner.id), "message_posted").find((e) => e.payload.sender && (e.payload.sender as { kind: string }).kind === "system")!;
    const frozen = ofType(h.events(runner.id), "proposal_frozen")[0]!;
    expect(notice.payload.notice).toEqual({ kind: "proposal_submitted", proposalId: frozen.payload.id });
    expect(room.at(-1)!.text).toContain("Миссия выполнена");
    const votes = ofType(h.events(runner.id), "vote_cast").map((e) => e.payload.vote);
    expect(votes.every((v) => v === "APPROVE")).toBe(true);
  });

  it("MISSION_FAILURE ending is grounded in the evaluator: primary cause by priority, real numbers", async () => {
    const h = createHarness();
    const runner = h.runner(fastKestrel("space-station/insufficient-power"));
    const metrics = await runner.run();
    const ending = messages(h, runner.id).at(-1)!;
    expect(metrics.termination?.outcome).toBe("MISSION_FAILURE");
    expect(ending.narration?.source).toBe("missionFailure.power_feasible");
    expect(ending.text).toContain("22 kW available, 30 kW required");
    expect(metrics.evaluation).toMatchObject({ violated: ["power_feasible"] });
  });

  it("CONSENSUS_FAILURE and operator stop get their own endings", async () => {
    const h = createHarness({ scripts: { "test/chatty": script({ discussion: () => JSON.stringify({ message: "hm", pass: false, target: null, intent: null, readyToCommit: false }) }) } });
    const veto = h.runner(fastKestrel("space-station/life-support-veto"));
    await veto.run();
    expect(messages(h, veto.id).at(-1)!.narration?.source).toBe("outcomes.CONSENSUS_FAILURE");

    const config = fastKestrel();
    useModel(config, "test/chatty");
    config.limits.discussionTurnLimit = 1000;
    config.limits.globalTurnLimit = 1000;
    const stopped = h.runner(config);
    stopped.control({ type: "pause" });
    const done = stopped.run();
    await new Promise((r) => setTimeout(r, 20));
    stopped.control({ type: "stop" });
    await done;
    const ending = messages(h, stopped.id).at(-1)!;
    expect(ending.narration?.source).toBe("runtime.neutral");
    expect(ending.text).toBe("The run was stopped by the operator.");
  });

  it("an unauthored presentation language falls back for narration, while agents still get the requested language", async () => {
    const seen: CompletionRequest[] = [];
    const cooperative = (await import("../../src/scenarios/spaceStation/stubScripts.js")).spaceStationScript("cooperative");
    const h = createHarness({ scripts: { "test/record": (req) => (seen.push(req), cooperative(req)) } });
    const config = fastKestrel(undefined, (c) => {
      c.conversation.language = "sr-Latn";
    });
    useModel(config, "test/record");
    const runner = h.runner(config);
    await runner.run();
    expect(seen[0]!.messages[0]!.content).toContain("Serbian (Latin script) (sr-Latn)");
    expect(messages(h, runner.id)[0]!.narration).toMatchObject({ language: "en" });
  });

  it("the neutral benchmark has no narration and no pacing", async () => {
    const h = createHarness();
    const c = spaceStationConfig();
    c.runtime.providerRetryDelayMs = 0;
    const runner = h.runner(c);
    const metrics = await runner.run();
    expect(metrics.messages.narrator).toBe(0);
    expect(ofType(h.events(runner.id), "presentation_delay")).toHaveLength(0);
    expect(metrics.durationMs.presentation).toBe(0);
  });
});

describe("presentation pacing", () => {
  it("delays visible messages at the publish boundary, recorded separately and excluded from active time and provider latency", async () => {
    const h = createHarness();
    const config = fastKestrel(undefined, (c) => {
      c.presentation.pacing = { minVisibleIntervalMs: 60, perCharMs: 0, maxGapMs: 1000 };
    });
    const runner = h.runner(config);
    const metrics = await runner.run();
    const delays = ofType(h.events(runner.id), "presentation_delay");

    expect(delays.length).toBeGreaterThan(3);
    // waited ≈ gap − time since the previous message, plus OS timer granularity (~15 ms on Windows)
    expect(delays.every((d) => d.payload.gapMs === 60 && (d.payload.waitedMs as number) <= 60 + 30)).toBe(true);
    const total = delays.reduce((s, d) => s + (d.payload.waitedMs as number), 0);
    expect(metrics.durationMs.presentation).toBeGreaterThanOrEqual(total - 5);
    // wall ≈ active + presentation (no pauses here)
    expect(metrics.durationMs.wall! - metrics.durationMs.active! - metrics.durationMs.presentation!).toBeLessThan(40);
    // provider latency is untouched by pacing (stub calls are instant)
    for (const call of ofType(h.events(runner.id), "llm_call")) expect(call.payload.durationMs as number).toBeLessThan(30);
  });

  it("scales with the previous message's length, up to the cap", async () => {
    const h = createHarness();
    const config = fastKestrel(undefined, (c) => {
      c.presentation.pacing = { minVisibleIntervalMs: 0, perCharMs: 1, maxGapMs: 120 };
    });
    const runner = h.runner(config);
    await runner.run();
    const gaps = ofType(h.events(runner.id), "presentation_delay").map((d) => d.payload.gapMs as number);
    expect(Math.max(...gaps)).toBe(120); // the long opening narration hits the cap
    expect(new Set(gaps).size).toBeGreaterThan(1);
  });

  it("is interrupted immediately by stop", async () => {
    const h = createHarness();
    const config = fastKestrel(undefined, (c) => {
      c.presentation.pacing = { minVisibleIntervalMs: 60000, perCharMs: 0, maxGapMs: 60000 };
    });
    const runner = h.runner(config);
    const t0 = Date.now();
    const done = runner.run();
    await new Promise((r) => setTimeout(r, 50));
    runner.control({ type: "stop" });
    const metrics = await done;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(metrics.termination?.outcome).toBe("STOPPED_BY_OPERATOR");
    expect(ofType(h.events(runner.id), "presentation_delay")[0]!.payload.interrupted).toBe(true);
  });
});

describe("narration rendering", () => {
  it("fills placeholders from runtime/evaluator state and reports missing ones", () => {
    expect(renderTemplate("{{derived.availableKw}} of {{params.coolantRequiredKw}} ({{nope.x}})", { derived: { availableKw: 22 }, params: { coolantRequiredKw: 30 } })).toEqual({
      text: "22 of 30 ()",
      missing: ["nope.x"],
    });
  });

  it("uses base language and fallback; technical outcomes get neutral runtime text unless authored", () => {
    const c = parseExperimentConfig(kestrelConfig());
    expect(openingNarration(c, "ru-RU")?.language).toBe("ru");
    expect(openingNarration(c, "de")?.language).toBe("en");
    expect(endingNarration(c, "ru", termination("PROVIDER_ERROR", "x"), null, {})).toMatchObject({ source: "runtime.neutral" });
    expect(endingNarration(c, "ru", termination("PROVIDER_ERROR", "x"), null, {})!.text).toContain("сбоя провайдера");
    const noNarrator = parseExperimentConfig(spaceStationConfig());
    expect(openingNarration(noNarrator, "en")).toBeNull();
    expect(endingNarration(noNarrator, "en", termination("SUCCESS", "ok"), null, {})).toBeNull();
  });

  it("English runtime strings match the text the benchmark always used", () => {
    expect(runtimeStrings("en").proposalSubmitted({ attempt: 1, proposerName: "Ops", body: "{}", rationale: "" })).toBe(
      "Final proposal #1 submitted by Ops:\n{}\nRationale: (none)\nVoting is open."
    );
    expect(runtimeStrings("xx").voteLine({ agentName: "A", vote: "REJECT", reason: "no" })).toBe("- A: REJECT — no");
  });
});

describe("scenario library", () => {
  it("syncs built-ins as read-only rows, updates them in place on a version bump, never touches user scenarios", () => {
    const h = createHarness();
    const repo = new ScenarioRepository(h.db);
    const user = repo.create(spaceStationConfig());
    expect(repo.syncBuiltins(BUILTIN_SCENARIOS)).toEqual({ added: ["space-station", "station-kestrel"], updated: [] });
    expect(repo.syncBuiltins(BUILTIN_SCENARIOS)).toEqual({ added: [], updated: [] });

    const kestrel = repo.getBuiltin("station-kestrel")!;
    const codeVersion = BUILTIN_SCENARIOS.find((b) => b.id === "station-kestrel")!.version;
    expect(kestrel).toMatchObject({ version: 1, builtin: { id: "station-kestrel", version: codeVersion } });
    expect(() => repo.update(kestrel.id, kestrel.config)).toThrow(ReadOnlyScenarioError);
    expect(() => repo.delete(kestrel.id)).toThrow(ReadOnlyScenarioError);
    expect(repo.duplicate(kestrel.id)).toMatchObject({ name: "Station Kestrel (copy)", builtin: null });

    const bumped = BUILTIN_SCENARIOS.map((b) => (b.id === "station-kestrel" ? { ...b, version: codeVersion + 1, config: () => ({ ...kestrelConfig(), description: "v2" }) } : b));
    expect(repo.syncBuiltins(bumped).updated).toEqual(["station-kestrel"]);
    expect(repo.getBuiltin("station-kestrel")).toMatchObject({ version: 2, builtin: { version: codeVersion + 1 }, config: { description: "v2" } });
    expect(repo.get(user.id)).toMatchObject({ version: 1, builtin: null });
    expect(repo.list().slice(0, 2).map((s) => s.builtin?.id)).toEqual(["space-station", "station-kestrel"]);
  });
});
