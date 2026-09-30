import { describe, expect, it } from "vitest";
import { aggregate, stat, wilson } from "../../src/batch/aggregate.js";
import { BatchService, BatchValidationError, MAX_RUNS_PER_BATCH } from "../../src/batch/service.js";
import { applyVariable, expandConditions, planRuns } from "../../src/batch/spec.js";
import { ExperimentService } from "../../src/experiment/service.js";
import { ProviderRegistry } from "../../src/llm/registry.js";
import { StubProvider } from "../../src/llm/stubProvider.js";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { BatchRepository } from "../../src/persistence/batchRepository.js";
import { EventRepository } from "../../src/persistence/eventRepository.js";
import { presentationExtensions } from "../../src/presentation/index.js";
import { createEvaluatorRegistry, registerBuiltinStubs } from "../../src/scenarios/index.js";
import { spaceStationConfig } from "../../src/scenarios/spaceStation/config.js";
import { script, turnJson } from "../helpers/harness.js";

function setup(stubLatencyMs = 0) {
  const db = createInMemoryDb();
  const stub = registerBuiltinStubs(new StubProvider(stubLatencyMs));
  stub.register("test/chatty", script({ discussion: () => turnJson({ message: "talking" }) }));
  const providers = new ProviderRegistry([], stub);
  const evaluators = createEvaluatorRegistry();
  const service = new ExperimentService({ db, providers, evaluators, extensions: presentationExtensions });
  const batches = new BatchService({ db, providers, evaluators, service });
  return { db, service, batches };
}

const fastBase = () => {
  const c = spaceStationConfig();
  c.runtime.providerRetryDelayMs = 0;
  return c;
};

describe("batch spec expansion", () => {
  it("expands the cartesian product with readable condition keys", () => {
    const conditions = expandConditions([
      { path: "scheduler.type", label: "scheduler", values: ["round_robin", "hybrid"] },
      { path: "limits.agentTokenLimit", values: [1000, null] },
    ]);
    expect(conditions.map((c) => c.key)).toEqual([
      "scheduler=round_robin | limits.agentTokenLimit=1000",
      "scheduler=round_robin | limits.agentTokenLimit=null",
      "scheduler=hybrid | limits.agentTokenLimit=1000",
      "scheduler=hybrid | limits.agentTokenLimit=null",
    ]);
    expect(expandConditions([]).map((c) => c.key)).toEqual(["baseline"]);
  });

  it("interleaves repetitions across conditions by default", () => {
    const conditions = expandConditions([{ path: "x", values: ["a", "b"] }]);
    expect(planRuns(conditions, 2, "interleaved").map((r) => `${r.condition.values.x}${r.repetition}`)).toEqual(["a1", "b1", "a2", "b2"]);
    expect(planRuns(conditions, 2, "sequential").map((r) => `${r.condition.values.x}${r.repetition}`)).toEqual(["a1", "a2", "b1", "b2"]);
  });

  it("applies wildcard paths, whole-object values and the $agents virtual path", () => {
    const config = spaceStationConfig() as unknown as Record<string, any>;
    applyVariable(config, "agents.*.model.model", "space-station/insufficient-power");
    expect(config.agents.every((a: any) => a.model.model === "space-station/insufficient-power")).toBe(true);
    applyVariable(config, "scheduler", { type: "round_robin" });
    expect(config.scheduler).toEqual({ type: "round_robin" });
    applyVariable(config, "$agents", ["operations", "power"]);
    expect(config.agents.map((a: any) => a.id)).toEqual(["operations", "power"]);
    expect(() => applyVariable(config, "no.such.path", 1)).toThrow(/does not exist/);
    expect(() => applyVariable(config, "$agents", ["ghost"])).toThrow(/unknown agent/);
  });
});

describe("batch validation", () => {
  it("rejects the whole batch up front when any condition is not runnable", () => {
    const { batches, db } = setup();
    try {
      batches.start({
        name: "bad",
        base: { config: fastBase() },
        repetitions: 1,
        variables: [{ path: "$agents", label: "agents", values: [["operations", "power", "engineering", "life_support"], ["power", "engineering"]] }],
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BatchValidationError);
      // Removing the proposer (operations) breaks only the second condition.
      expect((err as BatchValidationError).problems.join("\n")).toMatch(/condition "agents=\["power","engineering"\]".*proposerId/);
    }
    expect(new BatchRepository(db).list()).toHaveLength(0);
  });

  it("caps the number of runs", () => {
    const { batches } = setup();
    expect(() =>
      batches.resolve({ name: "huge", base: { builtin: "space-station" }, repetitions: MAX_RUNS_PER_BATCH, variables: [{ path: "consensus.rule", values: ["unanimity", "majority"] }] })
    ).toThrow(BatchValidationError);
  });
});

describe("batch execution", () => {
  it("runs every condition × repetition on the normal engine and aggregates by condition", async () => {
    const { batches, db } = setup();
    const batch = batches.start({
      name: "variants",
      base: { config: fastBase() },
      repetitions: 2,
      concurrency: 3,
      variables: [{ path: "agents.*.model.model", label: "agents", values: ["space-station/cooperative", "space-station/insufficient-power"] }],
    });
    await batches.settle(batch.id);
    const view = batches.view(batch.id);

    expect(view.batch.status).toBe("completed");
    expect(view.progress).toEqual({ total: 4, finished: 4, running: 0, pending: 0 });
    const [coop, lowPower] = view.aggregates;
    expect(coop).toMatchObject({ runs: 2, success: 2, successRate: 1, consensusRate: 1, outcomes: { SUCCESS: 2 } });
    expect(lowPower).toMatchObject({ runs: 2, success: 0, successRate: 0, consensusRate: 1, outcomes: { MISSION_FAILURE: 2 } });
    expect(view.overall).toMatchObject({ runs: 4, success: 2 });

    const runs = batches.runs(batch.id);
    expect(runs.map((r) => r.repetition).sort()).toEqual([1, 1, 2, 2]);
    expect(new Set(runs.map((r) => r.conditionKey)).size).toBe(2);

    const csv = batches.csv(batch.id).trim().split("\n");
    expect(csv).toHaveLength(5);
    expect(csv[0]).toContain("var:agents");
    expect(csv[1]).toContain("space-station/cooperative");

    const started = new EventRepository(db).list(runs[0]!.id).find((e) => e.type === "experiment_started")!;
    expect(started.payload.environment).toMatchObject({ stubLatencyMs: 0, origin: "batch" });
  });

  it("never inherits the interactive stub latency; latency only changes when the spec sets it", async () => {
    const { batches, db } = setup(300); // the web demo's registry
    const t0 = Date.now();
    const fast = batches.start({ name: "fast", base: { config: fastBase() }, repetitions: 1 });
    await batches.settle(fast.id);
    expect(Date.now() - t0).toBeLessThan(2000); // 16 stub calls × 300 ms would take ~5 s

    const slow = batches.start({ name: "slow", base: { config: fastBase() }, repetitions: 1, stubLatencyMs: 5 });
    await batches.settle(slow.id);
    const run = batches.runs(slow.id)[0]!;
    const started = new EventRepository(db).list(run.id).find((e) => e.type === "experiment_started")!;
    expect(started.payload.environment).toMatchObject({ stubLatencyMs: 5, origin: "batch" });
  });

  it("cancel stops in-flight runs, starts no more, and excludes the aborted runs from rates", async () => {
    const { batches } = setup();
    const config = fastBase();
    for (const a of config.agents) a.model = { provider: "stub", model: "test/chatty", structuredOutput: "native" };
    config.limits.discussionTurnLimit = 100000;
    config.limits.globalTurnLimit = 100000;
    const batch = batches.start({ name: "long", base: { config }, repetitions: 5, concurrency: 2 });
    await new Promise((r) => setTimeout(r, 50));
    batches.cancel(batch.id);
    await batches.settle(batch.id);

    const view = batches.view(batch.id);
    expect(view.batch.status).toBe("cancelled");
    expect(view.progress.finished).toBe(2); // only the two in flight ever started
    expect(view.progress.pending).toBe(3);
    expect(view.overall).toMatchObject({
      excluded: { total: 2, byOutcome: { STOPPED_BY_OPERATOR: 2 } },
      providerErrors: 0,
      evaluable: 0,
      successRate: null,
      outcomes: { STOPPED_BY_OPERATOR: 2 },
    });
  });

  it("marks a batch cut off by a restart as interrupted", () => {
    const { batches, db } = setup();
    const repo = new BatchRepository(db);
    const resolved = batches.resolve({ name: "orphan", base: { builtin: "space-station" }, repetitions: 1 });
    repo.create("orphan-batch", { ...resolved, conditionConfigs: undefined } as never);
    expect(batches.recoverInterrupted()).toEqual(["orphan-batch"]);
    expect(repo.getOrThrow("orphan-batch").status).toBe("interrupted");
  });
});

describe("aggregate statistics", () => {
  it("computes mean/median and a Wilson interval", () => {
    expect(stat([3, 1, 2, 10])).toEqual({ n: 4, mean: 4, median: 2.5, min: 1, max: 10 });
    expect(stat([])).toMatchObject({ n: 0, mean: null });
    const [lo, hi] = wilson(8, 10)!;
    expect(lo).toBeCloseTo(0.49, 2);
    expect(hi).toBeCloseTo(0.943, 2);
    expect(wilson(0, 0)).toBeNull();
  });

  it("an empty condition aggregates to nulls rather than zeros", () => {
    expect(aggregate("none", [])).toMatchObject({ runs: 0, successRate: null, consensusRate: null });
  });
});

describe("batch with a presentation-oriented scenario", () => {
  it("varies the conversation language like any field and runs without viewer pacing by default", async () => {
    const { db, batches } = setup();
    const t0 = Date.now();
    const batch = batches.start({
      name: "kestrel languages",
      base: { builtin: "station-kestrel" },
      repetitions: 1,
      variables: [{ path: "conversation.language", label: "lang", values: ["en", "ru"] }],
    });
    await batches.settle(batch.id);
    expect(Date.now() - t0).toBeLessThan(3000); // Kestrel's own pacing would take far longer

    const runs = batches.runs(batch.id);
    expect(runs.map((r) => r.config.conversation.language).sort()).toEqual(["en", "ru"]);
    expect(new Set(runs.map((r) => r.taskDefinitionHash)).size).toBe(1);
    for (const run of runs) {
      const started = new EventRepository(db).list(run.id).find((e) => e.type === "experiment_started")!;
      expect(started.payload.environment).toMatchObject({ headless: true, origin: "batch" });
      // Headless is an add-on option: the experiment config (and its hash) keeps the scenario's pacing.
      expect(run.config.presentation.pacing.minVisibleIntervalMs).toBeGreaterThan(0);
      const note = new EventRepository(db).list(run.id).find((e) => e.type === "extension_note")!;
      expect(note.payload).toMatchObject({ extension: "pacing", pacing: "off", reason: "headless" });
    }
    const ru = runs.find((r) => r.config.conversation.language === "ru")!;
    const ending = new EventRepository(db).list(ru.id).filter((e) => e.type === "message_posted").at(-1)!;
    expect(String(ending.payload.text)).toContain("Миссия выполнена");
  });
});

describe("batch review fixes", () => {
  it("rejects ambiguous specs: two variables with one label, or values that format to the same condition key", () => {
    const { batches } = setup();
    const base = { config: fastBase() };
    const problems = (spec: unknown) => {
      try {
        batches.resolve(spec);
      } catch (err) {
        return (err as BatchValidationError).problems.join(" ");
      }
      return "";
    };
    expect(
      problems({
        name: "labels",
        base,
        repetitions: 1,
        variables: [
          { path: "agents.*.model.model", label: "model", values: ["space-station/cooperative"] },
          { path: "scheduler.classifier.model", label: "model", values: ["router/next-in-order"] },
        ],
      })
    ).toMatch(/share the label "model"/);
    expect(problems({ name: "keys", base, repetitions: 1, variables: [{ path: "limits.discussionTurnLimit", values: [5, "5"] }] })).toMatch(/same key/);
  });

  it("a run that cannot be started ends the batch as interrupted, never leaving it running", async () => {
    const { db, providers } = (() => {
      const s = setup();
      return { db: s.db, providers: new ProviderRegistry([], registerBuiltinStubs(new StubProvider())) };
    })();
    const failing = { start: () => { throw new Error("database is locked"); } } as unknown as ExperimentService;
    const quiet = console.error;
    console.error = () => {};
    const batches = new BatchService({ db, providers, evaluators: createEvaluatorRegistry(), service: failing });
    const batch = batches.start({ name: "b", base: { config: fastBase() }, repetitions: 3 });
    await batches.settle(batch.id);
    console.error = quiet;
    expect(new BatchRepository(db).get(batch.id)?.status).toBe("interrupted");
    expect(batches.isRunning(batch.id)).toBe(false);
  });
});
