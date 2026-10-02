import { describe, expect, it } from "vitest";
import { BatchService, BatchValidationError } from "../../src/batch/service.js";
import { configHash, parseExperimentConfig, taskDefinitionHash } from "../../src/experiment/config.js";
import { termination } from "../../src/experiment/outcome.js";
import { ExperimentService } from "../../src/experiment/service.js";
import { ProviderRegistry } from "../../src/llm/registry.js";
import { StubProvider } from "../../src/llm/stubProvider.js";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { EventRepository } from "../../src/persistence/eventRepository.js";
import { ExperimentRepository } from "../../src/persistence/experimentRepository.js";
import { endingNarration } from "../../src/presentation/narration.js";
import { presentationExtensions } from "../../src/presentation/index.js";
import { createEvaluatorRegistry, registerBuiltinStubs } from "../../src/scenarios/index.js";
import { kestrelCascadeConfig } from "../../src/scenarios/kestrelCascade/config.js";
import { CascadeParamsSchema, evaluateCascade, type CascadeProposal } from "../../src/scenarios/kestrelCascade/evaluator.js";
import { CASCADE_EVALUATOR } from "../../src/scenarios/kestrelCascade/task.js";
import { kestrelConfig } from "../../src/scenarios/spaceStation/kestrel.js";
import { createHarness } from "../helpers/harness.js";

/** Regression tests for the final focused review. */

function setup() {
  const db = createInMemoryDb();
  const providers = new ProviderRegistry([], registerBuiltinStubs(new StubProvider()));
  const evaluators = createEvaluatorRegistry();
  const service = new ExperimentService({ db, providers, evaluators, extensions: presentationExtensions });
  return { db, service, batches: new BatchService({ db, providers, evaluators, service }) };
}

function problems(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof BatchValidationError) return err.problems;
    throw err;
  }
  return [];
}

describe("one set of effective evaluator params for the snapshot, the evaluator and the hashes", () => {
  it('Cascade with params {} and with every default written out: equal snapshot, configHash and taskDefinitionHash', async () => {
    const h = createHarness({ extensions: null });
    const run = async (params: Record<string, unknown>) => {
      const config = kestrelCascadeConfig();
      config.runtime.providerRetryDelayMs = 0;
      config.evaluator.params = params;
      const runner = h.runner(config);
      await runner.run();
      return h.record(runner.id);
    };
    const empty = await run({});
    const explicit = await run(CascadeParamsSchema.parse({}) as unknown as Record<string, unknown>);
    expect(empty.config.evaluator.params).toEqual(CascadeParamsSchema.parse({}));
    expect(empty.config).toEqual(explicit.config);
    expect(empty.configHash).toBe(explicit.configHash);
    expect(empty.taskDefinitionHash).toBe(explicit.taskDefinitionHash);
    expect(empty.configHash).toBe(configHash(parseExperimentConfig(empty.config)));
  });

  it("a batch whose conditions differ only by default-valued params is one config, and rejected as such", () => {
    const base = kestrelCascadeConfig();
    const found = problems(() =>
      setup().batches.resolve({
        name: "defaults",
        base: { config: base },
        repetitions: 1,
        variables: [{ path: "evaluator.params.loadKw", values: [{ research_labs: 12 }, { research_labs: 12, external_communications: 8 }] }],
      })
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("produce the same config");
  });
});

describe("batch object values", () => {
  it("a whole-object value may omit fields the schema defaults; every field it sets must survive", () => {
    const { batches } = setup();
    const models = [
      { provider: "stub", model: "space-station/cooperative" },
      { provider: "stub", model: "space-station/insufficient-power" },
    ];
    const resolved = batches.resolve({ name: "models", base: { builtin: "space-station" }, repetitions: 1, variables: [{ path: "agents.*.model", values: models }] });
    expect(resolved.conditions).toHaveLength(2);
    const typo = problems(() =>
      batches.resolve({ name: "typo", base: { builtin: "space-station" }, repetitions: 1, variables: [{ path: "agents.*.model", values: [{ ...models[0], temprature: 1 }] }] })
    );
    expect(typo.some((p) => p.includes('"agents.*.model" is not a setting of this config'))).toBe(true);
  });
});

describe("crash recovery is atomic per row", () => {
  it("a recovery that fails half-way leaves no partial experiment_finished; the retry writes exactly one", () => {
    const { db, service } = setup();
    const repo = new ExperimentRepository(db);
    repo.create({ id: "run-x", config: kestrelConfig(), configHash: "h", testbedVersion: { version: "test" } as never });
    db.prepare(`UPDATE experiments SET owner_id = NULL WHERE id = 'run-x'`).run(); // its owner is gone
    const inner = (service as unknown as { experiments: ExperimentRepository }).experiments;
    const update = inner.update.bind(inner);
    let failures = 1;
    inner.update = (...args: Parameters<ExperimentRepository["update"]>) => {
      if (failures-- > 0) throw new Error("database is locked");
      return update(...args);
    };
    const finished = () => new EventRepository(db).list("run-x").filter((e) => e.type === "experiment_finished");

    expect(() => service.recoverInterrupted()).toThrow("database is locked");
    expect(finished()).toHaveLength(0); // rolled back together with the failed update
    expect(repo.getOrThrow("run-x").finishedAt).toBeNull();

    expect(service.recoverInterrupted()).toEqual(["run-x"]);
    expect(service.recoverInterrupted()).toEqual([]);
    expect(finished()).toHaveLength(1);
    expect(repo.getOrThrow("run-x").outcome).toBe("INTERRUPTED");
  });
});

describe("Cascade evaluator v5: one check per fact an ending can state", () => {
  const params = CascadeParamsSchema.parse({ ...CASCADE_EVALUATOR.params, r3EvacuationMinutes: 3 });
  const dumpPlan = (actions: CascadeProposal["actions"]): CascadeProposal => ({ recovery_path: "thermal_dump_c", actions, life_support_power_kw: 40 });

  it("evacuated in time but sealed only after the dump: an isolation failure, not 'crew in the discharge path'", () => {
    const proposal = dumpPlan([
      "switch_beacon_to_battery",
      "shutdown_research_labs",
      "shutdown_external_communications",
      "route_power_to_thermal_dump_c",
      "evacuate_r3",
      "activate_thermal_dump_c",
      "isolate_r3",
      "scram_reactor",
    ]);
    const evaluation = evaluateCascade(proposal, params);
    expect(evaluation.violated).toEqual(["r3_isolated_before_dump"]);
    const text = endingNarration(parseExperimentConfig(kestrelCascadeConfig()), "en", termination("MISSION_FAILURE", "x"), evaluation, params)!.text;
    expect(text).toContain("R3 is empty, but it is not sealed");
    expect(text).not.toContain("discharge path");
  });

  it("the dump before the evacuation is the crew-exposure failure", () => {
    const proposal = dumpPlan([
      "switch_beacon_to_battery",
      "shutdown_research_labs",
      "shutdown_external_communications",
      "route_power_to_thermal_dump_c",
      "activate_thermal_dump_c",
      "evacuate_r3",
      "isolate_r3",
      "scram_reactor",
    ]);
    const evaluation = evaluateCascade(proposal, params);
    expect(evaluation.violated).toEqual(["r3_evacuated_before_dump", "r3_isolated_before_dump"]);
    const text = endingNarration(parseExperimentConfig(kestrelCascadeConfig()), "en", termination("MISSION_FAILURE", "x"), evaluation, params)!.text;
    expect(text).toContain("6 crew members are in the discharge path");
  });

  it("the evaluator version is in the task definition", () => {
    expect(createEvaluatorRegistry().get("kestrel-cascade").version).toBe("6");
    const config = parseExperimentConfig(kestrelCascadeConfig());
    expect(taskDefinitionHash(config, "6")).not.toBe(taskDefinitionHash(config, "5"));
  });
});
