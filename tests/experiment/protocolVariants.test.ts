import { describe, expect, it } from "vitest";
import { configHash, parseExperimentConfig, type ExperimentConfig } from "../../src/experiment/config.js";
import { renderProposalPrompt, renderSystemPrompt, proposalJsonSchema } from "../../src/experiment/protocol.js";
import { PROTOCOL_FINGERPRINT, protocolFingerprintFor } from "../../src/experiment/protocolFingerprint.js";
import { SpaceStationProposalSchema } from "../../src/scenarios/spaceStation/evaluator.js";
import { createHarness, ofType, SAFE_PLAN, script, testConfig, turnJson, useModel } from "../helpers/harness.js";

/** Protocol options for controlled designs: fixed discussion rounds, a required proposal, judging every proposal. */

function roundRobin(c: ExperimentConfig) {
  c.scheduler = { type: "round_robin", startAgentId: "operations" };
}

describe("fixed discussion rounds", () => {
  it("every agent speaks exactly that many times; readiness neither ends the discussion nor adds re-check turns", async () => {
    // Round 1: everyone posts and declares ready (each message makes the others' readiness stale — the default
    // protocol would re-check them). From round 2 on: PASS, ready — the default protocol would end there.
    const h = createHarness({
      extensions: null,
      scripts: { "test/eager": script({ discussion: (agentId, turn) => turnJson(turn === 0 ? { message: `${agentId} reporting`, ready: true } : { pass: true, ready: true }) }) },
    });
    const config = testConfig(roundRobin);
    useModel(config, "test/eager");
    config.discussion = { fixedRounds: 3 };
    const runner = h.runner(config);
    const metrics = await runner.run();
    const events = h.events(runner.id);

    expect(metrics.turns.byKind.discussion).toBe(12);
    expect(metrics.turns.byAgent).toMatchObject({ operations: 5, engineering: 4, power: 4, life_support: 4 }); // 3 discussion turns + 1 vote each; the proposer one more
    expect(ofType(events, "routing_decision").map((e) => e.payload.source)).not.toContain("readiness_recheck");
    const end = ofType(events, "phase_changed").find((e) => e.payload.to === "PROPOSAL")!;
    expect(end.payload).toMatchObject({ discussionEnd: "fixed_rounds", discussionTurnsUsed: 12 });
    // Readiness is still recorded: everyone was first ready at once at turn 7 (the last to post in round 1 stayed
    // ready; the other three re-declared in round 2) — and the discussion went on.
    expect(end.payload.allReadyAtTurn).toBe(7);
    expect(metrics.communication.timeline.discussionTurnsToAllReady).toBe(7);
    expect(metrics.termination?.outcome).toBe("SUCCESS");
  });

  it("needs round-robin, and room for the proposal and the vote within the global turn limit", () => {
    const hybrid = testConfig();
    hybrid.discussion = { fixedRounds: 2 };
    expect(() => parseExperimentConfig(hybrid)).toThrow(/fixed rounds need the round_robin scheduler/);
    const tight = testConfig(roundRobin);
    tight.discussion = { fixedRounds: 3 };
    tight.limits.globalTurnLimit = 16; // 12 discussion + 1 proposal + 4 votes = 17
    expect(() => parseExperimentConfig(tight)).toThrow(/leaves no room for the proposal and the vote/);
  });

  it("agents are told the discussion has a fixed number of rounds instead of the readiness re-check rule", () => {
    const config = parseExperimentConfig(testConfig(roundRobin));
    const fixed = parseExperimentConfig({ ...testConfig(roundRobin), discussion: { fixedRounds: 3 } });
    expect(renderSystemPrompt(config, config.agents[0]!)).toMatch(/you will be asked again/);
    const prompt = renderSystemPrompt(fixed, fixed.agents[0]!);
    expect(prompt).toMatch(/fixed number of rounds/);
    expect(prompt).not.toMatch(/you will be asked again/);
  });
});

describe("a required proposal", () => {
  it("declining is not offered: a null proposal is answered like a format error, and the next try counts", async () => {
    let calls = 0;
    const h = createHarness({
      extensions: null,
      scripts: { "test/hesitant": script({ proposal: () => JSON.stringify({ rationale: "not sure", proposal: calls++ === 0 ? null : SAFE_PLAN }) }) },
    });
    const config = testConfig();
    useModel(config, "test/hesitant");
    config.decision.proposalRequired = true;
    const runner = h.runner(config);
    const metrics = await runner.run();
    const rejected = ofType(h.events(runner.id), "proposal_rejected_format");
    expect(rejected.map((e) => e.payload.kind)).toEqual(["declined_not_allowed"]);
    expect(metrics.proposals).toMatchObject({ declined: 0, formatRejections: 1, frozen: 1 });
    expect(metrics.termination?.outcome).toBe("SUCCESS");
    // The second try was told why.
    const proposalCalls = ofType(h.events(runner.id), "llm_call").filter((e) => e.payload.purpose === "proposal");
    expect(JSON.stringify(proposalCalls[1]!.payload.messages)).toMatch(/a proposal is required here/);
  });

  it("a proposer that keeps declining ends the run as an invalid proposal, not as a decline", async () => {
    const h = createHarness({ extensions: null, scripts: { "test/never": script({ proposal: () => JSON.stringify({ rationale: "no", proposal: null }) }) } });
    const config = testConfig();
    useModel(config, "test/never");
    config.decision.proposalRequired = true;
    const metrics = await h.runner(config).run();
    expect(metrics.termination?.outcome).toBe("PROPOSAL_INVALID");
  });

  it("the prompt and the schema leave no null to choose; false is the default and hashes like it", () => {
    const config = parseExperimentConfig({ ...testConfig(), decision: { proposerId: "operations", proposalRequired: true } });
    expect(renderProposalPrompt(config, config.agents[0]!, [], {})).toMatch(/A proposal is required/);
    expect(renderProposalPrompt(config, config.agents[0]!, [], {})).not.toMatch(/set "proposal" to null/);
    expect(JSON.stringify(proposalJsonSchema(SpaceStationProposalSchema, true))).not.toMatch(/"null"/);
    expect(JSON.stringify(proposalJsonSchema(SpaceStationProposalSchema))).toMatch(/"null"/);
    const base = testConfig();
    expect(configHash(parseExperimentConfig({ ...base, decision: { ...base.decision, proposalRequired: false } }))).toBe(configHash(parseExperimentConfig(base)));
  });
});

describe("protocol fingerprint per variant", () => {
  it("the default protocol keeps its fingerprint; each variant has its own, recorded with the run", async () => {
    expect(protocolFingerprintFor(parseExperimentConfig(testConfig()))).toBe(PROTOCOL_FINGERPRINT);
    const fixed = protocolFingerprintFor(parseExperimentConfig({ ...testConfig(roundRobin), discussion: { fixedRounds: 2 } }));
    const required = protocolFingerprintFor(parseExperimentConfig({ ...testConfig(), decision: { proposerId: "operations", proposalRequired: true } }));
    const both = protocolFingerprintFor(parseExperimentConfig({ ...testConfig(roundRobin), discussion: { fixedRounds: 2 }, decision: { proposerId: "operations", proposalRequired: true } }));
    expect(new Set([PROTOCOL_FINGERPRINT, fixed, required, both]).size).toBe(4);
    // The rounds count is a setting, not a text: 2 and 5 rounds are one protocol variant.
    expect(protocolFingerprintFor(parseExperimentConfig({ ...testConfig(roundRobin), discussion: { fixedRounds: 5 } }))).toBe(fixed);

    const h = createHarness({ extensions: null });
    const config = testConfig(roundRobin);
    config.discussion = { fixedRounds: 2 };
    const runner = h.runner(config);
    const metrics = await runner.run();
    expect(ofType(h.events(runner.id), "experiment_started")[0]!.payload.protocolFingerprint).toBe(fixed);
    expect(metrics.protocolFingerprint).toBe(fixed);
  });
});

describe("every proposal is judged once the outcome is decided", () => {
  const LABS_ONLY = { ...SAFE_PLAN, shed_loads: ["research_labs"] };

  it("a rejected first proposal is judged too: first-proposal correctness next to the final outcome", async () => {
    let proposals = 0;
    const h = createHarness({
      extensions: null,
      scripts: {
        "test/second-try": script({
          proposal: () => JSON.stringify({ rationale: "plan", proposal: proposals++ === 0 ? LABS_ONLY : SAFE_PLAN }),
          vote: (_agentId, req) => JSON.stringify({ vote: JSON.stringify(req.context?.proposal) === JSON.stringify(LABS_ONLY) ? "REJECT" : "APPROVE", reason: "" }),
        }),
      },
    });
    const config = testConfig();
    useModel(config, "test/second-try");
    const runner = h.runner(config);
    const metrics = await runner.run();
    expect(metrics.termination?.outcome).toBe("SUCCESS");
    const evaluated = ofType(h.events(runner.id), "proposal_evaluated");
    expect(evaluated.map((e) => [e.payload.attempt, e.payload.committed, e.payload.outcome])).toEqual([
      [1, false, "MISSION_FAILURE"],
      [2, true, "SUCCESS"],
    ]);
    expect(metrics.proposals.first).toMatchObject({ attempt: 1, committed: false, outcome: "MISSION_FAILURE", violated: ["power_feasible"] });
    expect(metrics.proposals.evaluated).toHaveLength(2);
    // Judged after the decision: nothing an agent could have read.
    const seqs = (type: string) => ofType(h.events(runner.id), type).map((e) => e.seq);
    expect(Math.min(...seqs("proposal_evaluated"))).toBeGreaterThan(Math.max(...seqs("llm_call")));
  });

  it("without a commit, the proposal is still judged; the run's outcome stays the consensus failure", async () => {
    const h = createHarness({ extensions: null, scripts: { "test/veto": script({ vote: () => JSON.stringify({ vote: "REJECT", reason: "no" }) }) } });
    const config = testConfig();
    useModel(config, "test/veto");
    config.decision.maxProposalAttempts = 1;
    const metrics = await h.runner(config).run();
    expect(metrics.termination?.outcome).toBe("CONSENSUS_FAILURE");
    expect(metrics.evaluation).toBeNull();
    expect(metrics.proposals.first).toMatchObject({ committed: false, outcome: "SUCCESS" });
  });
});
