import { describe, expect, it } from "vitest";
import { ExperimentRunner } from "../../src/experiment/runner.js";
import type { LlmProvider } from "../../src/llm/provider.js";
import { ProviderError } from "../../src/llm/provider.js";
import { RoundRobinScheduler } from "../../src/scheduling/roundRobin.js";
import { leastRecentlyActivated, resolveAgentRef, type SchedulingContext } from "../../src/scheduling/types.js";
import { createHarness, ofType, script, testConfig, turnJson, useModel } from "../helpers/harness.js";

function ctx(overrides: Partial<SchedulingContext> = {}): SchedulingContext {
  return { config: testConfig(), transcript: [], lastTurn: null, lastActivatedTurn: new Map(), turn: 1, ...overrides };
}

describe("round robin", () => {
  it("starts with the configured agent, then follows config order and wraps", async () => {
    const rr = new RoundRobinScheduler();
    expect(await rr.next(ctx())).toMatchObject({ agentId: "operations", source: "start" });
    expect(await rr.next(ctx({ lastTurn: { agentId: "operations", pass: false, target: "power" } }))).toMatchObject({
      agentId: "engineering",
      source: "round_robin",
    });
    expect((await rr.next(ctx({ lastTurn: { agentId: "life_support", pass: true, target: null } }))).agentId).toBe("operations");
  });
});

describe("scheduling helpers", () => {
  it("resolves targets by id (any case, optional @) or display name", () => {
    const agents = testConfig().agents;
    expect(resolveAgentRef("POWER", agents)).toBe("power");
    expect(resolveAgentRef("@life_support", agents)).toBe("life_support");
    expect(resolveAgentRef("Reactor Engineering", agents)).toBe("engineering");
    expect(resolveAgentRef("the captain", agents)).toBeNull();
  });

  it("fallback picks whoever waited longest, never the last speaker", () => {
    const lastActivatedTurn = new Map([
      ["operations", 4],
      ["engineering", 2],
      ["power", 3],
    ]);
    expect(leastRecentlyActivated(ctx({ lastActivatedTurn, lastTurn: { agentId: "operations", pass: false, target: null } }))).toBe("life_support");
    lastActivatedTurn.set("life_support", 5);
    expect(leastRecentlyActivated(ctx({ lastActivatedTurn, lastTurn: { agentId: "life_support", pass: false, target: null } }))).toBe("engineering");
  });
});

describe("hybrid routing inside a run", () => {
  const routingOf = (h: ReturnType<typeof createHarness>, runner: ExperimentRunner) =>
    ofType(h.events(runner.id), "routing_decision").map((e) => ({ agentId: e.payload.agentId, source: e.payload.source, details: e.payload.details }));

  it("uses a valid explicit target, and records an invalid one before falling back to the classifier", async () => {
    const h = createHarness({
      scripts: {
        "test/targets": script({
          discussion: (agentId, n) => {
            if (agentId === "operations" && n === 0) return turnJson({ message: "Power?", target: "Power Systems" });
            if (agentId === "power" && n === 0) return turnJson({ message: "Hmm", target: "the captain" });
            return turnJson({ pass: true, ready: true });
          },
        }),
      },
    });
    const config = testConfig();
    useModel(config, "test/targets");
    const runner = h.runner(config);
    await runner.run();

    const routing = routingOf(h, runner);
    expect(routing[0]).toMatchObject({ agentId: "operations", source: "start" });
    expect(routing[1]).toMatchObject({ agentId: "power", source: "explicit" });
    expect(routing[2]).toMatchObject({ agentId: "life_support", source: "classifier", details: { invalidExplicitTarget: "the captain" } });
  });

  it("falls back deterministically when the classifier fails, without ending the run", async () => {
    const failingRouter: LlmProvider = {
      id: "openrouter",
      async complete() {
        throw new ProviderError("upstream down", false, 400);
      },
    };
    const h = createHarness({ providers: [failingRouter], scripts: { "test/quiet": script({}) } });
    const config = testConfig((c) => {
      if (c.scheduler.type === "hybrid") c.scheduler.classifier = { provider: "openrouter", model: "x/router", structuredOutput: "native" };
    });
    useModel(config, "test/quiet");
    const runner = h.runner(config);
    const metrics = await runner.run();

    expect(metrics.termination?.outcome).toBe("SUCCESS");
    const routing = routingOf(h, runner);
    expect(routing.slice(1).every((r) => r.source === "fallback")).toBe(true);
    expect(metrics.routing.classifierFailures).toBeGreaterThan(0);
    // Router calls are orchestration usage, never agent turns.
    expect(metrics.llmCalls.byPurpose.router).toBeGreaterThan(0);
    expect(metrics.turns.total).toBe(metrics.turns.byKind.discussion! + metrics.turns.byKind.proposal! + metrics.turns.byKind.vote!);
  });

  it("round-robin ignores explicit targets", async () => {
    const h = createHarness({
      scripts: {
        "test/rr": script({
          discussion: (agentId, n) => (agentId === "operations" && n === 0 ? turnJson({ message: "LS?", target: "life_support" }) : turnJson({ pass: true, ready: true })),
        }),
      },
    });
    const config = testConfig((c) => {
      c.scheduler = { type: "round_robin", startAgentId: "operations" };
    });
    useModel(config, "test/rr");
    const runner = h.runner(config);
    await runner.run();
    expect(routingOf(h, runner).map((r) => r.agentId).slice(0, 4)).toEqual(["operations", "engineering", "power", "life_support"]);
  });
});
