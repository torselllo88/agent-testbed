import { describe, expect, it } from "vitest";
import { applyRunOverrides, configHash, parseExperimentConfig, taskDefinitionHash, type ExperimentConfig } from "../../src/experiment/config.js";
import type { CompletionRequest } from "../../src/llm/provider.js";
import { endingNarration, openingNarration, renderTemplate } from "../../src/presentation/narration.js";
import { protocolStrings } from "../../src/experiment/protocolStrings.js";
import { ReadOnlyScenarioError, ScenarioRepository } from "../../src/persistence/scenarioRepository.js";
import { BUILTIN_SCENARIOS } from "../../src/scenarios/index.js";
import { spaceStationConfig } from "../../src/scenarios/spaceStation/config.js";
import { kestrelConfig } from "../../src/scenarios/spaceStation/kestrel.js";
import { termination } from "../../src/experiment/outcome.js";
import { ExperimentRunner } from "../../src/experiment/runner.js";
import { presentationExtensions } from "../../src/presentation/index.js";
import { createEvaluatorRegistry } from "../../src/scenarios/index.js";
import { createHarness, ofType, script, turnJson, useModel } from "../helpers/harness.js";

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
    // Narration has no place in the experiment transcript: the first agent message is #1.
    expect(room[0]).toMatchObject({ index: null, sender: { kind: "narrator", name: "MISSION CONTROL" }, narration: { source: "opening", language: "en" } });
    expect(room[1]).toMatchObject({ index: 1, sender: { kind: "agent" } });
    expect(room[0]!.text).toContain("Station Kestrel has lost its primary reactor cooling loop");
    // The ending is revealed as a sequence: tally → pump start → outcome.
    const ending = room.filter((m) => m.narration?.source === "outcomes.SUCCESS");
    expect(ending.map((m) => (m.narration as { part?: number }).part)).toEqual([1, 2, 3]);
    expect(ending[0]!.text).toBe("Vote: 4 of 4 in favor. Decision locked — executing the recovery procedure.");
    expect(room.at(-1)).toBe(ending[2]);
    expect(room.at(-1)!.text).toContain("Mission successful");
    const beats = room.filter((m) => m.narration?.source.startsWith("beats."));
    expect(metrics.messages.narrator).toBe(1 + beats.length + 3);

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

describe("Kestrel dramaturgy (observer-only)", () => {
  /** A run whose discussion lasts long enough for every beat: chatty turns until the soft limit, then a rejected plan, then agreement. */
  function longKestrel(language = "en") {
    const chatty = script({
      discussion: (agentId, turn) => turnJson({ message: `${agentId} point ${turn}`, ready: turn >= 4 }),
      vote: (agentId, req) =>
        JSON.stringify({ vote: agentId === "life_support" && Number(req.context?.proposalAttempt) === 1 ? "REJECT" : "APPROVE", reason: "r" }),
    });
    const config = fastKestrel(undefined, (c) => {
      c.conversation.language = language;
    });
    useModel(config, "test/long");
    return { chatty, config };
  }

  it("beats fire on protocol state — progress thresholds once, a rejected plan every time — just before the next visible message", async () => {
    const { chatty, config } = longKestrel();
    const h = createHarness({ scripts: { "test/long": chatty } });
    const runner = h.runner(config);
    await runner.run();

    const room = messages(h, runner.id);
    const sources = room.map((m) => (m.sender.kind === "narrator" ? String(m.narration?.source) : m.sender.kind));
    expect(sources.filter((s) => s.startsWith("beats."))).toEqual(["beats.window", "beats.urgent", "beats.rejected"]);
    // Every beat is followed by a visible (non-narrator) message: it never trails or interrupts one.
    for (const [i, s] of sources.entries()) if (s.startsWith("beats.")) expect(["agent", "system"]).toContain(sources[i + 1]);
    // The rejected-plan beat comes after the "not approved" notice.
    const notice = room.findIndex((m) => m.sender.kind === "system" && m.text.includes("not approved"));
    expect(sources.indexOf("beats.rejected")).toBeGreaterThan(notice);
    const window = room.find((m) => m.narration?.source === "beats.window")!;
    expect(window.text).toContain("primary cooling is still offline");
  });

  it("beats and the ending sequence are localized", async () => {
    const { chatty, config } = longKestrel("ru");
    const h = createHarness({ scripts: { "test/long": chatty } });
    const runner = h.runner(config);
    await runner.run();
    const room = messages(h, runner.id);
    expect(room.find((m) => m.narration?.source === "beats.rejected")!.text).toBe("План отклонён. Процедуры нет — активная зона продолжает нагреваться.");
    expect(room.find((m) => m.narration?.source === "outcomes.SUCCESS")!.text).toBe(
      "Голосование: «за» — 4 из 4. Решение принято — выполняется процедура восстановления."
    );
  });

  it("removing all presentation changes nothing the agents see or decide", async () => {
    const prompts = async (extensions: null | undefined) => {
      const seen: CompletionRequest[] = [];
      const { chatty, config } = longKestrel();
      const h = createHarness({ extensions, scripts: { "test/long": (req) => (seen.push(req), chatty(req)) } });
      const runner = h.runner(config);
      const metrics = await runner.run();
      return { metrics, seen: seen.map((r) => ({ context: r.context, messages: r.messages })), narrator: metrics.messages.narrator };
    };
    const withPresentation = await prompts(undefined);
    const bare = await prompts(null);
    expect(withPresentation.narrator).toBeGreaterThan(5);
    expect(bare.narrator).toBe(0);
    expect(withPresentation.seen).toEqual(bare.seen);
    expect(withPresentation.metrics.termination).toEqual(bare.metrics.termination);
    expect(withPresentation.metrics.turns).toEqual(bare.metrics.turns);
  });

  it("the ending reveal pauses on the held clock, and pacing: off removes the pause", async () => {
    const h = createHarness();
    const config = fastKestrel();
    config.presentation.pacing.sequencePauseMs = 150;
    const paced = h.runner(config);
    const pacedMetrics = await paced.run();
    const endings = messages(h, paced.id).filter((m) => m.narration?.source === "outcomes.SUCCESS");
    const times = ofType(h.events(paced.id), "message_posted")
      .filter((e) => (e.payload.narration as { source?: string } | undefined)?.source === "outcomes.SUCCESS")
      .map((e) => Date.parse(e.ts));
    expect(endings).toHaveLength(3);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(130);
    expect(pacedMetrics.durationMs.presentation).toBeGreaterThanOrEqual(260);

    const off = new ExperimentRunner({ db: h.db, providers: h.providers, evaluators: createEvaluatorRegistry(), extensions: presentationExtensions }, config, { overrides: { pacing: "off" } });
    const offMetrics = await off.run();
    expect(off.config.presentation.pacing.sequencePauseMs).toBe(0);
    expect(offMetrics.durationMs.presentation).toBeLessThan(50);
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

  it("English protocol strings match the text the benchmark always used", () => {
    expect(protocolStrings("en").proposalSubmitted({ attempt: 1, proposerName: "Ops", body: "{}", rationale: "" })).toBe(
      "Final proposal #1 submitted by Ops:\n{}\nRationale: (none)\nVoting is open."
    );
    expect(protocolStrings("xx").voteLine({ agentName: "A", vote: "REJECT", reason: "no" })).toBe("- A: REJECT — no");
  });
});

describe("scenario library", () => {
  it("syncs built-ins as read-only rows, updates them in place on a version bump, never touches user scenarios", () => {
    const h = createHarness();
    const repo = new ScenarioRepository(h.db);
    const user = repo.create(spaceStationConfig());
    expect(repo.syncBuiltins(BUILTIN_SCENARIOS)).toEqual({ added: ["space-station", "station-kestrel", "station-kestrel-cascade"], updated: [] });
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
    expect(repo.list().slice(0, 3).map((s) => s.builtin?.id)).toEqual(["space-station", "station-kestrel", "station-kestrel-cascade"]);
  });
});
