import { describe, expect, it } from "vitest";
import { BatchService, BatchValidationError } from "../../src/batch/service.js";
import { parseExperimentConfig } from "../../src/experiment/config.js";
import { protocolFingerprintFor } from "../../src/experiment/protocolFingerprint.js";
import { ExperimentService } from "../../src/experiment/service.js";
import { ProviderRegistry } from "../../src/llm/registry.js";
import { StubProvider } from "../../src/llm/stubProvider.js";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { EventRepository } from "../../src/persistence/eventRepository.js";
import { createEvaluatorRegistry, registerBuiltinStubs } from "../../src/scenarios/index.js";
import { serviceSettlementConfig } from "../../src/scenarios/serviceSettlement/config.js";

/** $solo: calibration — the proposer alone, asked once, with every agent's information ("full") or only its own ("public"). */

function setup() {
  const db = createInMemoryDb();
  const providers = new ProviderRegistry([], registerBuiltinStubs(new StubProvider()));
  const evaluators = createEvaluatorRegistry();
  const batches = new BatchService({ db, providers, evaluators, service: new ExperimentService({ db, providers, evaluators }) });
  return { batches, events: (id: string) => new EventRepository(db).list(id) };
}

describe("$solo", () => {
  it("one call, no discussion, no vote — and the prompt holds everyone's facts (full) or only the proposer's own (public)", async () => {
    const { batches, events } = setup();
    const batch = batches.start({
      name: "calibration",
      base: { builtin: "service-settlement" },
      repetitions: 1,
      variables: [
        { path: "$instance", label: "instance", values: ["dev-01"] },
        { path: "$solo", label: "information", values: ["full", "public"] },
      ],
    });
    await batches.settle(batch.id);
    const runs = batches.runs(batch.id);
    expect(runs).toHaveLength(2);
    const byInfo = Object.fromEntries(runs.map((r) => [(r.config as { name: string }).name.endsWith("solo (full)") ? "full" : "public", r]));
    const compliance = serviceSettlementConfig().agents.find((a) => a.id === "compliance")!;

    for (const info of ["full", "public"] as const) {
      const run = byInfo[info]!;
      expect(run.outcome).toBe("SUCCESS"); // the scripted proposer answers the same either way
      const calls = events(run.id).filter((e) => e.type === "llm_call");
      expect(calls.map((c) => c.payload.purpose)).toEqual(["proposal"]);
      const [system, user] = calls[0]!.payload.messages as Array<{ content: string }>;
      expect(system!.content).toContain("You decide alone: there is no discussion and no vote.");
      expect(system!.content).not.toContain("participants");
      expect(user!.content).not.toContain("TRANSCRIPT");
      expect(user!.content).toContain("Submit the final decision now. There is no vote");
      if (info === "full") {
        expect(user!.content).toContain(`What Compliance (${compliance.role}) knows:`);
        expect(user!.content).toContain(compliance.privateContext.trim().split("\n")[0]!);
      } else {
        expect(user!.content).not.toContain("What Compliance");
      }
      const summary = run.summary as { turns: { total: number; byKind: Record<string, number> }; consensusRule: string };
      expect(summary.turns).toMatchObject({ total: 1, byKind: { proposal: 1 } });
      expect(summary.consensusRule).toBe("none");
    }
  });

  it("is its own protocol variant; a single agent must decide alone; with a topology it is one config", () => {
    const solo = parseExperimentConfig({ ...serviceSettlementConfig(), agents: serviceSettlementConfig().agents.slice(0, 1), discussion: { fixedRounds: 0 }, consensus: { rule: "none" } });
    expect(protocolFingerprintFor(solo)).not.toBe(protocolFingerprintFor(parseExperimentConfig({ ...serviceSettlementConfig(), consensus: { rule: "none" } })));
    expect(() => parseExperimentConfig({ ...serviceSettlementConfig(), agents: serviceSettlementConfig().agents.slice(0, 1) })).toThrow(/a single agent decides alone/);

    // Deciding alone removes the graph: complete and ring become one config — refused as measuring the same thing.
    try {
      setup().batches.start({
        name: "x",
        base: { builtin: "service-settlement" },
        repetitions: 1,
        variables: [
          { path: "communication", values: [{ topology: { type: "complete" } }, { topology: { type: "ring" } }] },
          { path: "$solo", values: ["full"] },
        ],
      });
      throw new Error("expected the batch to be refused");
    } catch (err) {
      expect(err).toBeInstanceOf(BatchValidationError);
      expect((err as BatchValidationError).problems.join("\n")).toMatch(/produce the same config/);
    }
  });
});
