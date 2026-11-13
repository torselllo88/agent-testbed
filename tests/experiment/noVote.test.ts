import { describe, expect, it } from "vitest";
import { aggregate } from "../../src/batch/aggregate.js";
import { BatchService } from "../../src/batch/service.js";
import { parseExperimentConfig, type ExperimentConfig } from "../../src/experiment/config.js";
import { PROTOCOL_FINGERPRINT, protocolFingerprintFor } from "../../src/experiment/protocolFingerprint.js";
import { ExperimentService } from "../../src/experiment/service.js";
import { ProviderRegistry } from "../../src/llm/registry.js";
import { StubProvider } from "../../src/llm/stubProvider.js";
import { createInMemoryDb } from "../../src/persistence/db.js";
import type { ExperimentRecord } from "../../src/persistence/experimentRepository.js";
import { createEvaluatorRegistry, registerBuiltinStubs } from "../../src/scenarios/index.js";
import { serviceSettlementConfig } from "../../src/scenarios/serviceSettlement/config.js";
import { SETTLEMENT_DEV_01 } from "../../src/scenarios/serviceSettlement/task.js";
import { createHarness, ofType } from "../helpers/harness.js";

/** consensus.rule "none": no vote — the proposer's first valid proposal is the decision. */

function settlement(mutate: (c: Record<string, any>) => void = () => {}, model = "service-settlement/cooperative"): ExperimentConfig {
  const raw = structuredClone(serviceSettlementConfig(SETTLEMENT_DEV_01, model)) as Record<string, any>;
  raw.runtime.providerRetryDelayMs = 0;
  raw.consensus = { rule: "none" };
  mutate(raw);
  return parseExperimentConfig(raw);
}

describe("no vote", () => {
  it("commits and judges the proposal at once: no vote calls, no voting phase, agents told so", async () => {
    const h = createHarness({ extensions: null });
    const runner = h.runner(settlement());
    const metrics = await runner.run();
    expect(metrics.termination?.outcome).toBe("SUCCESS");
    const events = h.events(runner.id);

    expect(ofType(events, "llm_call").filter((e) => e.payload.purpose === "vote")).toHaveLength(0);
    expect(ofType(events, "consensus_result")).toHaveLength(0);
    const phases = ofType(events, "phase_changed").map((e) => e.payload.to);
    expect(phases).toEqual(["DISCUSSION", "PROPOSAL", "COMMITTED", "EVALUATION", "FINISHED"]);
    expect(ofType(events, "phase_changed").find((e) => e.payload.to === "COMMITTED")!.payload).toMatchObject({ decidedBy: "proposer" });
    expect(metrics.turns).toMatchObject({ total: 19, byKind: { discussion: 18, proposal: 1 } });
    expect(metrics).toMatchObject({ consensusRule: "none", consensusReached: false, proposals: { first: { outcome: "SUCCESS", committed: true } } });

    const proposalCall = ofType(events, "llm_call").find((e) => e.payload.purpose === "proposal")!;
    const [system, user] = proposalCall.payload.messages as Array<{ content: string }>;
    expect(system!.content).toContain("There is no vote: that submission is the decision.");
    expect(system!.content).not.toContain("every participant votes");
    expect(user!.content).toContain("There is no vote: what you submit is the decision.");
    const notice = ofType(events, "message_posted").find((e) => (e.payload.notice as { kind?: string } | undefined)?.kind === "proposal_submitted")!;
    expect(notice.payload.text).toContain("There is no vote: this is the decision.");
  });

  it("an unsafe first proposal fails the mission, with nobody to stop it", async () => {
    const h = createHarness({ extensions: null });
    const metrics = await h.runner(settlement(() => {}, "service-settlement/lure")).run();
    expect(metrics.termination?.outcome).toBe("MISSION_FAILURE");
    expect(metrics.evaluation).toMatchObject({ classification: "unsafe" });
  });

  it("is its own protocol variant; the turn limit only has to fit the proposal", () => {
    const voted = settlement((c) => (c.consensus = { rule: "unanimity" }));
    expect(protocolFingerprintFor(settlement())).not.toBe(protocolFingerprintFor(voted));
    expect(PROTOCOL_FINGERPRINT).toBe("8a715c5c37ce5c46");
    // 3 rounds of 6 + the proposal = 19 turns: enough without a vote, not with one.
    expect(() => settlement((c) => (c.limits.globalTurnLimit = 19))).not.toThrow();
    expect(() => settlement((c) => ((c.limits.globalTurnLimit = 19), (c.consensus = { rule: "unanimity" })))).toThrow(/no room for the proposal and the vote/);
  });

  it("works with a ring: the proposer decides on what reached it", async () => {
    const h = createHarness({ extensions: null });
    const runner = h.runner(settlement((c) => (c.communication = { topology: { type: "ring" } })));
    const metrics = await runner.run();
    expect(metrics.termination?.outcome).toBe("SUCCESS");
    expect(metrics.topology?.type).toBe("ring");
  });

  it("a batch leaves consensus empty and its rate null: there was nothing to agree on", async () => {
    const db = createInMemoryDb();
    const providers = new ProviderRegistry([], registerBuiltinStubs(new StubProvider()));
    const evaluators = createEvaluatorRegistry();
    const service = new ExperimentService({ db, providers, evaluators });
    const batches = new BatchService({ db, providers, evaluators, service });
    const batch = batches.start({
      name: "no vote",
      base: { builtin: "service-settlement" },
      repetitions: 1,
      variables: [{ path: "consensus", label: "decision", values: [{ rule: "none" }, { rule: "unanimity" }] }],
    });
    await batches.settle(batch.id);
    const [header, ...rows] = batches.csv(batch.id).trim().split("\n").map((line) => line.split(","));
    const column = (row: string[], name: string) => row[header!.indexOf(name)];
    const byRule = Object.fromEntries(rows.map((r) => [JSON.parse(column(r, "var:decision")!.replace(/""/g, '"').replace(/^"|"$/g, "")).rule, r]));
    expect(column(byRule.none!, "consensus_reached")).toBe("");
    expect(column(byRule.unanimity!, "consensus_reached")).toBe("true");
    const view = batches.view(batch.id);
    const none = view.aggregates.find((a) => a.key.includes("none"))!;
    expect(none).toMatchObject({ consensusRate: null, successRate: 1 });
    expect(view.aggregates.find((a) => a.key.includes("unanimity"))!.consensusRate).toBe(1);
  });

  it("consensusRate counts only runs with a vote", () => {
    const run = (consensusRule: string, consensusReached: boolean) =>
      ({ finishedAt: "x", status: "FINISHED", outcome: "SUCCESS", intervened: false, summary: { consensusRule, consensusReached, tokens: { total: 0, agent: 0, orchestration: 0 }, turns: { total: 0 }, messages: { public: 0 }, durationMs: { active: 0 }, costUsd: { total: 0, callsWithUnknownCost: 0 } } }) as unknown as ExperimentRecord;
    expect(aggregate("mixed", [run("none", false), run("unanimity", true), run("unanimity", false)]).consensusRate).toBe(0.5);
  });
});
