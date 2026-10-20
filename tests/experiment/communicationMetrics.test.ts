import { describe, expect, it } from "vitest";
import { aggregate } from "../../src/batch/aggregate.js";
import { createHarness, script, testConfig, turnJson, useModel } from "../helpers/harness.js";

/** Structural communication metrics, from a scripted discussion whose addressing is known (agentTurn counts from 0). */

function scriptedRun(discussion: (agentId: string, agentTurn: number) => string) {
  const h = createHarness({ extensions: null, scripts: { "test/talk": script({ discussion: (agentId, turn) => discussion(agentId, turn) }) } });
  const config = testConfig();
  useModel(config, "test/talk");
  config.scheduler = { type: "round_robin", startAgentId: "operations" }; // operations, engineering, power, life_support, …
  return h.runner(config).run();
}

describe("communication metrics", () => {
  it("addressing, responses, participation and time to decision", async () => {
    // Round 1: operations → power; engineering passes; power → operations; life support to everyone. Then everyone passes, ready.
    const metrics = await scriptedRun((agentId, turn) => {
      if (turn === 0 && agentId === "operations") return turnJson({ message: "Power, how much is free?", target: "power" });
      if (turn === 0 && agentId === "power") return turnJson({ message: "10 kW. Operations, shed the labs?", target: "operations", ready: true });
      if (turn === 0 && agentId === "life_support") return turnJson({ message: "Life support stays at 40 kW.", ready: true });
      return turnJson({ pass: true, ready: true });
    });
    expect(metrics.termination?.outcome).toBe("SUCCESS");
    const c = metrics.communication;
    expect(c).toMatchObject({ addressed: 2, broadcast: 1, edges: { "operations->power": 1, "power->operations": 1 } });
    expect(c.addressedShare).toBeCloseTo(2 / 3);
    expect(c.peersAddressed).toEqual({ operations: 1, engineering: 0, power: 1, life_support: 0 });
    expect(c.interactionDensity).toBeCloseTo(2 / 12);
    expect(c.interactionReciprocity).toBe(1);
    // power answered operations two turns later (engineering passed in between); operations never answered power.
    expect(c.responses).toEqual({ addressed: 2, addresseeSpokeNext: 0, addresseeSpokeLater: 1, meanTurnsUntilAddresseeSpeaks: 2 });
    expect(c.participation.silentAgents).toBe(1);
    expect(c.participation.evenness).toBeCloseTo(Math.log(3) / Math.log(4));
    expect(c.participation.gini).toBeCloseTo(0.25);
    expect(c.timeline.discussionSegments).toBe(1);
    expect(c.timeline.discussionTurnsToAllReady).toBeGreaterThanOrEqual(4);
    expect(c.timeline.turnsToFirstProposal).toBe(metrics.turns.byKind.discussion);
  });

  it("an addressee that speaks right away is answered next; a target that is not an agent (or oneself) does not count", async () => {
    const metrics = await scriptedRun((agentId, turn) => {
      if (turn === 0 && agentId === "operations") return turnJson({ message: "Engineering?", target: "engineering" });
      if (turn === 0 && agentId === "engineering") return turnJson({ message: "Loop B works.", target: "nobody", ready: true });
      if (turn === 0 && agentId === "power") return turnJson({ message: "Noted.", target: "power", ready: true });
      return turnJson({ pass: true, ready: true });
    });
    const c = metrics.communication;
    expect(c.edges).toEqual({ "operations->engineering": 1 });
    expect(c).toMatchObject({ addressed: 1, broadcast: 2 });
    expect(c.responses).toMatchObject({ addressed: 1, addresseeSpokeNext: 1, addresseeSpokeLater: 1, meanTurnsUntilAddresseeSpeaks: 1 });
  });

  it("an all-PASS discussion has no messages and no shares to report", async () => {
    const metrics = await scriptedRun(() => turnJson({ pass: true, ready: true }));
    expect(metrics.communication).toMatchObject({ addressed: 0, broadcast: 0, addressedShare: null, interactionReciprocity: null, participation: { evenness: null, gini: null, silentAgents: 4 } });
  });

  it("batch aggregates include them, and leave out runs recorded before they existed", async () => {
    const metrics = await scriptedRun((agentId, turn) =>
      turn === 0 && agentId === "operations" ? turnJson({ message: "Power?", target: "power", ready: true }) : turnJson({ pass: true, ready: true })
    );
    const old = { ...metrics, communication: undefined } as unknown as typeof metrics;
    const run = (summary: typeof metrics) => ({ outcome: "SUCCESS", status: "SUCCESS", finishedAt: "x", intervened: false, summary }) as never;
    const agg = aggregate("all", [run(metrics), run(old)]);
    expect(agg.communication.addressedShare).toMatchObject({ n: 1, mean: 1 });
  });
});
