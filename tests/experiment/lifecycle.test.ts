import { describe, expect, it } from "vitest";
import { EventRepository } from "../../src/persistence/eventRepository.js";
import { ExperimentRepository } from "../../src/persistence/experimentRepository.js";
import { createHarness, ofType, SAFE_PLAN, script, testConfig, turnJson, useModel } from "../helpers/harness.js";

const phasesOf = (events: ReturnType<ReturnType<typeof createHarness>["events"]>) =>
  ofType(events, "phase_changed").map((e) => e.payload.to);

describe("Space Station end-to-end (stub agents)", () => {
  it.each(["hybrid", "round_robin"] as const)("cooperative agents reach SUCCESS with %s scheduling", async (scheduler) => {
    const h = createHarness();
    const config = testConfig((c) => {
      if (scheduler === "round_robin") c.scheduler = { type: "round_robin", startAgentId: "operations" };
    });
    const runner = h.runner(config);
    const metrics = await runner.run();

    expect(metrics.termination).toMatchObject({ outcome: "SUCCESS", category: "task", status: "SUCCESS" });
    expect(metrics.consensusReached).toBe(true);
    expect(metrics.proposals.final?.body).toEqual(SAFE_PLAN);
    expect(metrics.evaluation).toMatchObject({ outcome: "SUCCESS", violated: [] });
    expect(phasesOf(h.events(runner.id))).toEqual(["DISCUSSION", "PROPOSAL", "VOTING", "COMMITTED", "EVALUATION", "FINISHED"]);

    const record = h.record(runner.id);
    expect(record).toMatchObject({ phase: "FINISHED", status: "SUCCESS", outcome: "SUCCESS", intervened: false });
    expect(record.summary).toMatchObject({ consensusReached: true });
  });

  it("consensus is not correctness: a unanimously approved plan with too little power is a MISSION_FAILURE", async () => {
    const h = createHarness();
    const runner = h.runner(testConfig(undefined, "space-station/insufficient-power"));
    const metrics = await runner.run();

    expect(metrics.consensusReached).toBe(true);
    expect(metrics.termination).toMatchObject({ outcome: "MISSION_FAILURE", category: "task" });
    expect(metrics.evaluation).toMatchObject({ violated: ["power_feasible"] });
  });

  it("a repeatedly vetoed plan returns to discussion once, then ends in CONSENSUS_FAILURE", async () => {
    const h = createHarness();
    const runner = h.runner(testConfig(undefined, "space-station/life-support-veto"));
    const metrics = await runner.run();

    expect(metrics.termination).toMatchObject({ outcome: "CONSENSUS_FAILURE", category: "coordination" });
    expect(metrics.proposals.attempts).toBe(2);
    expect(metrics.votes.rounds.map((r) => r.reached)).toEqual([false, false]);
    expect(metrics.votes.final?.find((v) => v.agentId === "life_support")?.vote).toBe("REJECT");
    expect(metrics.evaluation).toBeNull();

    const events = h.events(runner.id);
    expect(phasesOf(events)).toEqual(["DISCUSSION", "PROPOSAL", "VOTING", "DISCUSSION", "PROPOSAL", "VOTING", "FINISHED"]);
    const rediscussion = ofType(events, "phase_changed").find((e) => e.payload.to === "DISCUSSION" && e.payload.segment === 2);
    expect(rediscussion?.payload.turnLimit).toBe(8);
    // Rejection reasons are published to the room for the second discussion round.
    expect(ofType(events, "message_posted").some((e) => String(e.payload.text).includes("was not approved"))).toBe(true);
  });

  it("the trace survives a 'restart': a new repository over the same database sees the whole run", async () => {
    const h = createHarness();
    const runner = h.runner(testConfig());
    await runner.run();

    const events = new EventRepository(h.db).list(runner.id);
    expect(events[0]!.type).toBe("experiment_started");
    expect(events.at(-1)!.type).toBe("experiment_finished");
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events[0]!.payload).toMatchObject({ configHash: expect.any(String), evaluator: { id: "space-station", version: "1" } });
    expect(new ExperimentRepository(h.db).get(runner.id)?.config.name).toBe("Space Station Emergency");
  });
});

describe("discussion termination", () => {
  it("discussionTurnLimit moves to the decision phase and is not a failure by itself", async () => {
    const h = createHarness({ scripts: { "test/chatty": script({ discussion: () => turnJson({ message: "more thoughts", ready: false }) }) } });
    const config = testConfig((c) => {
      c.limits.discussionTurnLimit = 5;
    });
    useModel(config, "test/chatty");
    const runner = h.runner(config);
    const metrics = await runner.run();

    expect(metrics.turns.byKind.discussion).toBe(5);
    const toProposal = ofType(h.events(runner.id), "phase_changed").find((e) => e.payload.to === "PROPOSAL");
    expect(toProposal?.payload.discussionEnd).toBe("discussion_turn_limit");
    expect(metrics.termination?.outcome).toBe("SUCCESS");
  });

  it("the global turn limit is a hard terminal limit", async () => {
    const h = createHarness({ scripts: { "test/chatty": script({ discussion: () => turnJson({ message: "more thoughts" }) }) } });
    const config = testConfig((c) => {
      c.limits.discussionTurnLimit = 50;
      c.limits.globalTurnLimit = 6;
    });
    useModel(config, "test/chatty");
    const metrics = await h.runner(config).run();

    expect(metrics.termination).toMatchObject({ outcome: "TURN_LIMIT_EXCEEDED", category: "budget", detail: { limit: "globalTurnLimit" } });
    expect(metrics.turns.total).toBe(6);
  });

  it("the agent token budget ends the run with TOKEN_BUDGET_EXCEEDED", async () => {
    const h = createHarness({ scripts: { "test/chatty": script({ discussion: () => turnJson({ message: "more thoughts" }) }) } });
    const config = testConfig((c) => {
      c.limits.agentTokenLimit = 3000;
    });
    useModel(config, "test/chatty");
    const metrics = await h.runner(config).run();

    expect(metrics.termination).toMatchObject({ outcome: "TOKEN_BUDGET_EXCEEDED", detail: { limit: "agentTokenLimit" } });
    expect(metrics.tokens.agent).toBeGreaterThanOrEqual(3000);
  });

  it("the time limit ends the run with TIMEOUT", async () => {
    const h = createHarness({
      scripts: {
        "test/slow": script({
          discussion: () => {
            const until = Date.now() + 30;
            while (Date.now() < until) {
              // burn time synchronously so the stub is "slow"
            }
            return turnJson({ message: "thinking" });
          },
        }),
      },
    });
    const config = testConfig((c) => {
      c.limits.timeLimitSeconds = 0.1;
    });
    useModel(config, "test/slow");
    const metrics = await h.runner(config).run();
    expect(metrics.termination).toMatchObject({ outcome: "TIMEOUT", category: "budget" });
  });
});

describe("readiness", () => {
  it("readiness declared before new information goes stale and is re-asked before DECISION", async () => {
    // engineering declares ready immediately; power then posts new
    // information, so engineering's readiness is stale and must be renewed.
    const h = createHarness({
      scripts: {
        "test/stale": script({
          discussion: (agentId, n) => {
            if (agentId === "operations" && n === 0) return turnJson({ message: "Status?", target: "engineering" });
            if (agentId === "engineering" && n === 0) return turnJson({ message: "Loop B works; I am ready.", target: "power", ready: true });
            if (agentId === "power" && n === 0) return turnJson({ message: "Only 10 kW is free.", target: "life_support", ready: true });
            return turnJson({ pass: true, ready: true });
          },
        }),
      },
    });
    const config = testConfig();
    useModel(config, "test/stale");
    const runner = h.runner(config);
    await runner.run();
    const events = h.events(runner.id);

    const invalidated = ofType(events, "readiness_invalidated");
    expect(invalidated.map((e) => e.agentId)).toContain("engineering");

    const recheck = ofType(events, "routing_decision").filter((e) => e.payload.source === "readiness_recheck");
    expect(recheck.map((e) => e.agentId)).toContain("engineering");

    // No decision was entered while engineering's readiness was stale.
    const decisionSeq = ofType(events, "phase_changed").find((e) => e.payload.to === "PROPOSAL")!.seq;
    const lastEngineeringReady = ofType(events, "readiness_changed")
      .filter((e) => e.agentId === "engineering" && e.payload.to === "ready")
      .at(-1)!.seq;
    expect(lastEngineeringReady).toBeGreaterThan(invalidated.find((e) => e.agentId === "engineering")!.seq);
    expect(lastEngineeringReady).toBeLessThan(decisionSeq);
  });
});

describe("readiness re-check prompt", () => {
  it("tells a re-checked agent why it is asked and which messages arrived since its declaration", async () => {
    const prompts: Array<{ agentId: string; recheck: boolean; text: string }> = [];
    const h = createHarness({
      scripts: {
        "test/stale-note": script({
          discussion: (agentId, n, req) => {
            prompts.push({ agentId, recheck: req.context?.readinessRecheck === true, text: req.messages.at(-1)!.content });
            if (agentId === "operations" && n === 0) return turnJson({ message: "Status?", target: "engineering" });
            if (agentId === "engineering" && n === 0) return turnJson({ message: "Loop B works; I am ready.", target: "power", ready: true });
            if (agentId === "power" && n === 0) return turnJson({ message: "Only 10 kW is free.", target: "life_support", ready: true });
            return turnJson({ pass: true, ready: true });
          },
        }),
      },
    });
    const config = testConfig();
    useModel(config, "test/stale-note");
    await h.runner(config).run();

    const recheck = prompts.find((p) => p.recheck);
    expect(recheck?.agentId).toBe("engineering");
    expect(recheck?.text).toContain("re-confirm your readiness");
    expect(recheck?.text).toMatch(/#3/); // power's message arrived after engineering declared at #2
    expect(prompts.filter((p) => !p.recheck).every((p) => !p.text.includes("re-confirm your readiness"))).toBe(true);
  });
});
