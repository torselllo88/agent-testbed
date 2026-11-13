import { describe, expect, it } from "vitest";
import { BatchService, BatchValidationError } from "../../src/batch/service.js";
import { seededShuffle } from "../../src/experiment/topology.js";
import { ExperimentService } from "../../src/experiment/service.js";
import { ProviderRegistry } from "../../src/llm/registry.js";
import { StubProvider } from "../../src/llm/stubProvider.js";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { createEvaluatorRegistry, registerBuiltinStubs } from "../../src/scenarios/index.js";
import { SETTLEMENT_DEV_01 } from "../../src/scenarios/serviceSettlement/task.js";

/** $instance: task instances as a batch variable — facts and judge from one parameter set, paired by the instance's seed. */

const IDS = ["operations", "contract", "verification", "compliance", "treasury", "settlement"];

function service() {
  const db = createInMemoryDb();
  const providers = new ProviderRegistry([], registerBuiltinStubs(new StubProvider()));
  const evaluators = createEvaluatorRegistry();
  return new BatchService({ db, providers, evaluators, service: new ExperimentService({ db, providers, evaluators }) });
}

// The same task with a smaller invoice: the scripted agents still pay 12,000, so the judge — reading this instance — fails it.
const DEV_02 = { id: "dev-02", seed: 5, params: { ...SETTLEMENT_DEV_01, instanceId: "dev-02", amount: 9000 } };

describe("$instance", () => {
  it("named and inline instances × topology: facts and judge per instance, the speaking order per instance seed", async () => {
    const batches = service();
    const batch = batches.start({
      name: "instances",
      base: { builtin: "service-settlement" },
      repetitions: 1,
      variables: [
        { path: "$instance", label: "instance", values: ["dev-01", DEV_02] },
        { path: "communication", label: "graph", values: [{ topology: { type: "complete" } }, { topology: { type: "ring" } }] },
      ],
    });
    await batches.settle(batch.id);
    // An inline instance appears by its id, not its whole parameter set.
    expect(batches.view(batch.id).aggregates.map((a) => a.key)).toContain('instance=dev-02 | graph={"topology":{"type":"ring"}}');
    const [header, ...rows] = batches.csv(batch.id).trim().split("\n").map((line) => line.split(","));
    const column = (row: string[], name: string) => row[header!.indexOf(name)]!;
    expect(rows).toHaveLength(4);
    const of = (instance: string) => rows.filter((r) => column(r, "var:instance") === instance);
    const [dev01, dev02] = [of("dev-01"), of("dev-02")];
    expect([dev01.length, dev02.length]).toEqual([2, 2]);

    // One task per instance, whatever the topology; two instances, two tasks.
    expect(new Set(dev01.map((r) => column(r, "task_definition_hash"))).size).toBe(1);
    expect(column(dev01[0]!, "task_definition_hash")).not.toBe(column(dev02[0]!, "task_definition_hash"));
    // Paired by the instance's seed: dev-01 carries seed 1, dev-02 seed 5.
    for (const [rowsOf, seed] of [[dev01, 1], [dev02, 5]] as const) {
      expect(rowsOf.map((r) => column(r, "randomization_seed"))).toEqual([String(seed), String(seed)]);
      expect(rowsOf.map((r) => column(r, "speaking_order"))).toEqual(Array(2).fill(seededShuffle(IDS, seed, "speaking-order").join(">")));
    }
    // The judge reads each instance's own parameters.
    expect(dev01.map((r) => column(r, "outcome"))).toEqual(["SUCCESS", "SUCCESS"]);
    expect(dev02.map((r) => column(r, "outcome"))).toEqual(["MISSION_FAILURE", "MISSION_FAILURE"]);
    expect(column(dev02[0]!, "violated")).toContain("amount_not_above_invoice");

    const names = batches.runs(batch.id).map((r) => (r.config as { name: string }).name);
    expect(names.filter((n) => n.endsWith(" · dev-02"))).toHaveLength(2);
  });

  it("refuses what it cannot instantiate, before anything runs", () => {
    const problems = (base: unknown, values: unknown[]): string => {
      try {
        service().start({ name: "x", base, repetitions: 1, variables: [{ path: "$instance", values }] });
      } catch (err) {
        expect(err).toBeInstanceOf(BatchValidationError);
        return (err as BatchValidationError).problems.join("\n");
      }
      throw new Error("expected the batch to be refused");
    };
    expect(problems({ builtin: "service-settlement" }, ["dev-99"])).toMatch(/unknown instance "dev-99" \(known: dev-01\)/);
    expect(problems({ builtin: "service-settlement" }, [{ id: "bad", params: { ...SETTLEMENT_DEV_01, amount: -1 } }])).toMatch(/\$instance "bad": invalid parameters/);
    expect(problems({ builtin: "service-settlement" }, [{ params: SETTLEMENT_DEV_01 }])).toMatch(/an inline instance is/);
    expect(problems({ builtin: "space-station" }, ["dev-01"])).toMatch(/has no task family/);
  });
});
