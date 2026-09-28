import { describe, expect, it } from "vitest";
import { majority, unanimity, type CastVote } from "../../src/consensus/index.js";
import { BudgetTracker } from "../../src/experiment/budget.js";
import { configHash, LimitsConfigSchema, parseExperimentConfig } from "../../src/experiment/config.js";
import { redactSecrets } from "../../src/experiment/events.js";
import { extractJsonObject } from "../../src/experiment/parseJson.js";
import { assertTransition, IllegalPhaseTransitionError, Phase } from "../../src/experiment/phases.js";
import { ReadinessTracker } from "../../src/experiment/readiness.js";
import { spaceStationConfig } from "../../src/scenarios/spaceStation/config.js";

describe("ReadinessTracker", () => {
  it("a substantive message from another agent makes earlier readiness stale; PASS does not", () => {
    const r = new ReadinessTracker(["a", "b", "c"]);
    r.declare("a", true, 3);
    expect(r.onSubstantiveMessage("a", 4)).toEqual([]); // own message never invalidates
    expect(r.get("a").state).toBe("ready");

    const changes = r.onSubstantiveMessage("b", 5);
    expect(changes).toEqual([{ agentId: "a", from: "ready", to: "stale" }]);
    expect(r.get("a").state).toBe("stale");
  });

  it("readiness declared at or after the new message stays valid", () => {
    const r = new ReadinessTracker(["a", "b"]);
    r.declare("a", true, 5);
    expect(r.onSubstantiveMessage("b", 5)).toEqual([]);
    expect(r.get("a").state).toBe("ready");
  });

  it("reports stale agents only when nobody is simply not ready", () => {
    const r = new ReadinessTracker(["a", "b", "c"]);
    r.declare("a", true, 1);
    r.onSubstantiveMessage("b", 2);
    expect(r.staleBlockingConsensus()).toEqual([]); // b and c are not ready at all
    r.declare("b", true, 2);
    r.declare("c", true, 2);
    expect(r.staleBlockingConsensus()).toEqual(["a"]);
    expect(r.allReady()).toBe(false);
    r.declare("a", true, 2);
    expect(r.allReady()).toBe(true);
  });
});

describe("consensus rules", () => {
  const votes = (...values: CastVote["vote"][]): CastVote[] => values.map((vote, i) => ({ agentId: `a${i}`, vote, reason: "" }));
  const ids = ["a0", "a1", "a2", "a3"];

  it("unanimity needs every eligible approval; an invalid vote blocks it", () => {
    expect(unanimity.decide(votes("APPROVE", "APPROVE", "APPROVE", "APPROVE"), ids).reached).toBe(true);
    expect(unanimity.decide(votes("APPROVE", "APPROVE", "APPROVE", "INVALID"), ids)).toMatchObject({ reached: false, invalid: 1 });
  });

  it("majority is strictly more than half — a tie fails", () => {
    expect(majority.decide(votes("APPROVE", "APPROVE", "APPROVE", "REJECT"), ids).reached).toBe(true);
    expect(majority.decide(votes("APPROVE", "APPROVE", "REJECT", "REJECT"), ids)).toMatchObject({ reached: false, required: 3 });
  });
});

describe("BudgetTracker", () => {
  const limits = (overrides: Record<string, unknown>) => LimitsConfigSchema.parse(overrides);

  it("excludes orchestration tokens from the agent budget unless configured", () => {
    const off = new BudgetTracker(limits({ agentTokenLimit: 100 }));
    off.recordCall("orchestration", { promptTokens: 200, completionTokens: 0 }, 0);
    expect(off.checkHardLimits()).toBeNull();

    const on = new BudgetTracker(limits({ agentTokenLimit: 100, countOrchestrationTokens: true }));
    on.recordCall("orchestration", { promptTokens: 200, completionTokens: 0 }, 0);
    expect(on.checkHardLimits()?.outcome).toBe("TOKEN_BUDGET_EXCEEDED");
  });

  it("the total token cap covers agents + orchestration regardless of countOrchestrationTokens", () => {
    const b = new BudgetTracker(limits({ totalTokenCap: 100 }));
    b.recordCall("agent", { promptTokens: 60, completionTokens: 0 }, 0);
    b.recordCall("orchestration", { promptTokens: 50, completionTokens: 0 }, 0);
    expect(b.checkHardLimits()).toMatchObject({ outcome: "TOKEN_BUDGET_EXCEEDED", detail: { limit: "totalTokenCap" } });
  });

  it("stops on the cost cap and on the global turn limit (including turns needed up front)", () => {
    const b = new BudgetTracker(limits({ totalCostCapUsd: 0.01, globalTurnLimit: 3 }));
    b.recordTurn();
    b.recordTurn();
    expect(b.checkHardLimits(1)).toBeNull();
    expect(b.checkHardLimits(2)?.outcome).toBe("TURN_LIMIT_EXCEEDED");
    b.recordCall("agent", { promptTokens: 1, completionTokens: 1 }, 0.02);
    expect(b.checkHardLimits()?.outcome).toBe("COST_LIMIT_EXCEEDED");
  });

  it("does not count paused time against the time limit", () => {
    let now = 0;
    const b = new BudgetTracker(limits({ timeLimitSeconds: 10 }), () => now);
    b.start();
    now = 5_000;
    b.pause();
    now = 60_000;
    b.resume();
    expect(b.activeElapsedMs()).toBe(5_000);
    expect(b.checkTimeLimit()).toBeNull();
    now = 66_000;
    expect(b.checkTimeLimit()?.outcome).toBe("TIMEOUT");
  });
});

describe("phases", () => {
  it("allows the lifecycle edges and rejects shortcuts", () => {
    expect(() => assertTransition(Phase.DISCUSSION, Phase.PROPOSAL)).not.toThrow();
    expect(() => assertTransition(Phase.VOTING, Phase.DISCUSSION)).not.toThrow();
    expect(() => assertTransition(Phase.DISCUSSION, Phase.EVALUATION)).toThrow(IllegalPhaseTransitionError);
    expect(() => assertTransition(Phase.FINISHED, Phase.DISCUSSION)).toThrow(IllegalPhaseTransitionError);
  });
});

describe("config", () => {
  it("rejects unknown proposer / duplicate agent ids with every issue listed", () => {
    const raw = spaceStationConfig();
    raw.decision.proposerId = "nobody";
    raw.agents[1]!.id = raw.agents[0]!.id;
    expect(() => parseExperimentConfig(raw)).toThrow(/decision\.proposerId.*nobody|duplicate agent id/);
  });

  it("hashes the resolved config, so omitted defaults and key order don't change the hash", () => {
    const { limits: _limits, runtime: _runtime, ...rest } = spaceStationConfig();
    const omitted = parseExperimentConfig(rest);
    const explicit = parseExperimentConfig({ ...rest, limits: LimitsConfigSchema.parse({}), runtime: {} });
    expect(configHash(explicit)).toBe(configHash(omitted));

    const reordered = parseExperimentConfig(Object.fromEntries(Object.entries(explicit).reverse()));
    expect(configHash(reordered)).toBe(configHash(explicit));

    const changed = parseExperimentConfig({ ...rest, limits: { discussionTurnLimit: 5 } });
    expect(configHash(changed)).not.toBe(configHash(omitted));
  });
});

describe("helpers", () => {
  it("extracts a JSON object from fenced or chatty responses, but not from broken JSON", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
    expect(extractJsonObject('Sure! {"a":1} Hope that helps')).toEqual({ ok: true, value: { a: 1 } });
    expect(extractJsonObject('{"a":').ok).toBe(false);
    expect(extractJsonObject("[1,2]").ok).toBe(false);
    // Seen live (gpt-4.1-nano): a valid object followed by a stray extra brace.
    expect(extractJsonObject('{"a":{"b":1}}}')).toEqual({ ok: true, value: { a: { b: 1 } } });
    // Braces inside strings do not confuse the balance scan.
    expect(extractJsonObject('{"t":"x } y {"} trailing }')).toEqual({ ok: true, value: { t: "x } y {" } });
  });

  it("redacts secrets anywhere in a serialized payload", () => {
    const serialized = JSON.stringify({ messages: [{ content: "key sk-secret-123456 here" }] });
    expect(redactSecrets(serialized, ["sk-secret-123456"])).not.toContain("sk-secret-123456");
  });
});
