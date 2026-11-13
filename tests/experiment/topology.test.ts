import { describe, expect, it } from "vitest";
import { BatchService } from "../../src/batch/service.js";
import { ExperimentService } from "../../src/experiment/service.js";
import { ProviderRegistry } from "../../src/llm/registry.js";
import { StubProvider } from "../../src/llm/stubProvider.js";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { createEvaluatorRegistry, registerBuiltinStubs } from "../../src/scenarios/index.js";
import { configHash, parseExperimentConfig, type ExperimentConfig } from "../../src/experiment/config.js";
import type { ExperimentEvent } from "../../src/experiment/events.js";
import { PROTOCOL_FINGERPRINT, protocolFingerprintFor } from "../../src/experiment/protocolFingerprint.js";
import { resolveLayout, seededShuffle, temporalReach } from "../../src/experiment/topology.js";
import type { CompletionRequest } from "../../src/llm/provider.js";
import { serviceSettlementConfig } from "../../src/scenarios/serviceSettlement/config.js";
import { settlementScript } from "../../src/scenarios/serviceSettlement/stubScripts.js";
import { createHarness, ofType } from "../helpers/harness.js";

/**
 * A communication topology: who hears whom in discussion. Complete (the
 * default) must stay exactly as before; a ring delivers each message to the
 * sender's two neighbours only, and every agent reads only its own view.
 */

const IDS = ["operations", "contract", "verification", "compliance", "treasury", "settlement"];

function settlement(mutate: (c: Record<string, any>) => void = () => {}): ExperimentConfig {
  const raw = structuredClone(serviceSettlementConfig()) as Record<string, any>;
  raw.runtime.providerRetryDelayMs = 0;
  mutate(raw);
  return parseExperimentConfig(raw);
}
/** Ring in config order: operations sits between settlement and contract. */
const ring = () => settlement((c) => (c.communication = { topology: { type: "ring" } }));

type LlmMessage = { role: string; content: string };
const prompts = (events: ExperimentEvent[], agentId: string, purpose: string) =>
  ofType(events, "llm_call").filter((e) => e.agentId === agentId && e.payload.purpose === purpose).map((e) => e.payload.messages as LlmMessage[]);
const userPrompt = (messages: LlmMessage[]) => messages.find((m) => m.role === "user")!.content;
const messageTexts = (events: ExperimentEvent[], from: string) =>
  ofType(events, "message_posted").filter((e) => (e.payload.sender as { agentId?: string }).agentId === from).map((e) => String(e.payload.text));

describe("topology config", () => {
  it("an explicit complete topology is the default: same config hash, same protocol fingerprint", () => {
    const plain = settlement();
    const explicit = settlement((c) => (c.communication = { topology: { type: "complete" } }));
    expect(explicit.communication).toBeUndefined();
    expect(configHash(explicit)).toBe(configHash(plain));
    expect(protocolFingerprintFor(explicit)).toBe(protocolFingerprintFor(plain));
    // A ring is its own protocol variant; the default protocol is untouched.
    expect(protocolFingerprintFor(ring())).not.toBe(protocolFingerprintFor(plain));
    expect(protocolFingerprintFor(parseExperimentConfig(withoutVariants(plain)))).toBe(PROTOCOL_FINGERPRINT);
  });

  it("rejects what a topology cannot do, saying why", () => {
    const bad = (mutate: (c: Record<string, any>) => void) => () => settlement(mutate);
    expect(bad((c) => ((c.communication = { topology: { type: "ring" } }), (c.scheduler = { type: "hybrid" }), delete c.discussion))).toThrow(/needs the round_robin scheduler/);
    expect(bad((c) => (c.communication = { topology: { type: "ring", order: ["operations", "contract"] } }))).toThrow(/ring order must list every agent id exactly once: missing/);
    expect(bad((c) => (c.communication = { topology: { type: "edges", edges: [["operations", "operations"]] } }))).toThrow(/to itself/);
    expect(bad((c) => (c.communication = { topology: { type: "edges", edges: [["operations", "contract"], ["contract", "operations"]] } }))).toThrow(/duplicate edge/);
    expect(bad((c) => (c.communication = { topology: { type: "edges", edges: [["operations", "nobody"]] } }))).toThrow(/unknown agent "nobody"/);
    expect(bad((c) => (c.scheduler = { type: "round_robin", order: ["operations", "operations", ...IDS.slice(2)] }))).toThrow(/"operations" more than once/);
    // The seed decides the speaking order: a configured start agent would contradict it.
    expect(bad((c) => ((c.scheduler.startAgentId = "operations"), (c.randomization = { seed: 1 })))).toThrow(/drawn from the seed: remove scheduler.order and scheduler.startAgentId/);
    expect(bad((c) => ((c.communication = { topology: { type: "ring", order: IDS } }), (c.randomization = { seed: 1, speakingOrder: false })))).toThrow(/not both/);
  });
});

describe("layout: speaking order and graph", () => {
  it("draws from a seed with a fixed procedure, separately for speaking order and ring — so conditions with one seed are paired", () => {
    // Pinned: a change of the drawing procedure must be visible in review (recorded runs used these orders).
    expect(seededShuffle(IDS, 7, "speaking-order")).toEqual(["verification", "operations", "treasury", "compliance", "contract", "settlement"]);
    expect(seededShuffle(IDS, 7, "ring")).toEqual(["verification", "settlement", "contract", "operations", "compliance", "treasury"]);

    const seeded = (topology: string) =>
      settlement((c) => {
        c.randomization = { seed: 7 };
        c.communication = { topology: { type: topology } };
      });
    const complete = resolveLayout(seeded("complete"));
    const ringed = resolveLayout(seeded("ring"));
    expect(complete.speakingOrder).toEqual(ringed.speakingOrder);
    expect(complete).toMatchObject({ topology: "complete", ring: null, neighbours: null, seed: 7 });
    expect(ringed.ring).toEqual(seededShuffle(IDS, 7, "ring"));
    expect(ringed.neighbours!.operations).toEqual(["contract", "compliance"]);
  });

  it("an explicit rotation starts at the start agent; edges give undirected neighbours", () => {
    const explicit = resolveLayout(settlement((c) => (c.scheduler = { type: "round_robin", startAgentId: "compliance", order: [...IDS].reverse() })));
    expect(explicit.speakingOrder).toEqual(["compliance", "verification", "contract", "operations", "settlement", "treasury"]);
    const star = resolveLayout(settlement((c) => (c.communication = { topology: { type: "edges", edges: IDS.slice(1).map((id) => [id, "operations"]) } })));
    expect(star.neighbours!.operations).toEqual(IDS.slice(1));
    expect(star.neighbours!.treasury).toEqual(["operations"]);
  });

  it("temporal reach: a path counts only if each relay speaks after it heard", () => {
    // Ring t–x–y–z–t: y is two hops from t.
    const ids = ["t", "x", "y", "z"];
    const layout = (speakingOrder: string[]) => ({ topology: "ring" as const, speakingOrder, ring: ids, neighbours: { t: ["z", "x"], x: ["t", "y"], y: ["x", "z"], z: ["y", "t"] }, seed: null });
    // y speaks first, a relay right after it: y reaches t in round 1.
    expect(temporalReach(layout(["y", "z", "x", "t"]), ids, "t", 1)).toEqual({ x: { turn: 3, round: 1 }, y: { turn: 2, round: 1 }, z: { turn: 2, round: 1 } });
    // y speaks last: its relays have already spoken, so it reaches t only in round 2.
    expect(temporalReach(layout(["x", "z", "t", "y"]), ids, "t", 2)).toMatchObject({ y: { turn: 5, round: 2 } });
    expect(temporalReach(layout(["x", "z", "t", "y"]), ids, "t", 1)).toMatchObject({ y: null });
    // Complete: everything arrives when its source first speaks.
    expect(temporalReach({ ...layout(["x", "z", "t", "y"]), topology: "complete", neighbours: null as never }, ids, "t", 1)).toEqual({ x: { turn: 1, round: 1 }, y: { turn: 4, round: 1 }, z: { turn: 2, round: 1 } });
  });
});

describe("a ring run", () => {
  it("delivers each message to the sender's neighbours only, and every agent reads only its own view", async () => {
    const h = createHarness({ extensions: null });
    const runner = h.runner(ring());
    const metrics = await runner.run();
    expect(metrics.termination?.outcome).toBe("SUCCESS");
    const events = h.events(runner.id);

    // Every agent message carries its audience: the sender and its two ring neighbours.
    for (const e of ofType(events, "message_posted").filter((e) => (e.payload.sender as { kind: string }).kind === "agent")) {
      const sender = (e.payload.sender as { agentId: string }).agentId;
      const i = IDS.indexOf(sender);
      expect(e.payload.audience).toEqual([sender, IDS[(i + 5) % 6], IDS[(i + 1) % 6]]);
    }

    // Operations hears Contract and Settlement — not Compliance, whose fact never reached it.
    const [system, user] = prompts(events, "operations", "proposal")[0]!;
    expect(system!.content).toContain("Your neighbours: Settlement (settlement), Contract Management (contract).");
    expect(system!.content).not.toContain("Everything you post is visible to every participant");
    const proposalPrompt = user!.content;
    expect(proposalPrompt).toContain("MESSAGES YOU CAN SEE");
    for (const text of [...messageTexts(events, "contract"), ...messageTexts(events, "settlement")]) expect(proposalPrompt).toContain(text);
    for (const text of messageTexts(events, "compliance")) expect(proposalPrompt).not.toContain(text);
    // Numbered by position in its own view: 1, 2, 3, … with no gaps.
    const numbers = [...proposalPrompt.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]));
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));

    // The layout is on record, with what the schedule allows to reach the proposer.
    const started = ofType(events, "experiment_started")[0]!.payload;
    expect(started.layout).toMatchObject({ topology: "ring", ring: IDS, speakingOrder: IDS, seed: null });
    expect(metrics.topology).toMatchObject({ type: "ring", density: 0.4, meanReach: 2, temporalReach: { targetId: "operations", rounds: 3, maxRound: 1, unreachable: 0 } });
  });

  it("readiness goes stale only for agents a message reached", async () => {
    const cooperative = settlementScript("cooperative");
    // Everyone talks at every turn and says it is ready: each message invalidates ready listeners — in a ring, only neighbours.
    const h = createHarness({
      extensions: null,
      scripts: {
        "topology/chatty": (req: CompletionRequest) =>
          req.context?.purpose === "discussion"
            ? JSON.stringify({ message: `${String(req.context.agentId)}, turn ${String(req.context.turn)}`, pass: false, target: null, intent: null, readyToCommit: true })
            : cooperative(req),
      },
    });
    const config = ring();
    for (const agent of config.agents) (agent.model as { model: string }).model = "topology/chatty";
    const runner = h.runner(config);
    await runner.run();
    const events = h.events(runner.id);
    const posted = new Map(ofType(events, "message_posted").map((e) => [e.payload.index, e.payload.audience as string[] | undefined]));
    const invalidations = ofType(events, "readiness_invalidated");
    expect(invalidations.length).toBeGreaterThan(0);
    for (const e of invalidations) expect(posted.get(e.payload.atIndex)).toContain(e.agentId);
  });

  it("the proposal reaches everyone, its rationale only the proposer's neighbours; vote reasons travel along the voter's edges", async () => {
    const cooperative = settlementScript("cooperative");
    const h = createHarness({
      extensions: null,
      // Treasury rejects: the outcome goes to everyone, its reason to Compliance and Settlement only.
      scripts: {
        "topology/treasury-rejects": (req: CompletionRequest) =>
          req.context?.purpose === "vote" && req.context.agentId === "treasury" ? JSON.stringify({ vote: "REJECT", reason: "the second approval is missing" }) : cooperative(req),
      },
    });
    const config = ring();
    for (const agent of config.agents) (agent.model as { model: string }).model = "topology/treasury-rejects";
    const runner = h.runner(config);
    const metrics = await runner.run();
    expect(metrics.termination?.outcome).toBe("CONSENSUS_FAILURE");
    const events = h.events(runner.id);
    const notices = ofType(events, "message_posted").filter((e) => (e.payload.sender as { kind: string }).kind === "system");

    const submitted = notices.filter((e) => (e.payload.notice as { kind: string }).kind === "proposal_submitted");
    expect(submitted.map((e) => e.payload.audience)).toEqual([
      ["operations", "settlement", "contract"],
      ["verification", "compliance", "treasury"],
    ]);
    expect(submitted[0]!.payload.text).toContain("Payment instruction as discussed.");
    expect(submitted[1]!.payload.text).not.toContain("Payment instruction as discussed.");
    expect((submitted[1]!.payload.notice as { copy?: boolean }).copy).toBe(true);

    expect(userPrompt(prompts(events, "contract", "vote")[0]!)).toContain("Proposer's rationale: Payment instruction as discussed.");
    expect(userPrompt(prompts(events, "verification", "vote")[0]!)).toContain("Proposer's rationale: (not shown to you — it reached only the proposer's neighbours)");

    const outcome = notices.find((e) => (e.payload.notice as { kind: string }).kind === "proposal_not_approved")!;
    expect(outcome.payload.audience).toBeUndefined();
    expect(outcome.payload.text).not.toContain("second approval is missing");
    const reason = notices.find((e) => (e.payload.notice as { kind: string }).kind === "vote_reason")!;
    expect(reason.payload).toMatchObject({ audience: ["treasury", "compliance", "settlement"] });
    expect(reason.payload.text).toContain("the second approval is missing");
  });

  it("a complete run records its layout too, and its messages carry no audience", async () => {
    const h = createHarness({ extensions: null });
    const runner = h.runner(settlement());
    const metrics = await runner.run();
    const events = h.events(runner.id);
    expect(ofType(events, "message_posted").every((e) => e.payload.audience === undefined)).toBe(true);
    expect(metrics.topology).toMatchObject({ type: "complete", density: 1, meanReach: 5, speakingOrder: IDS, temporalReach: { maxRound: 1, unreachable: 0 } });
    expect(userPrompt(prompts(events, "operations", "proposal")[0]!)).toContain("ROOM TRANSCRIPT (oldest first):");
  });
});

describe("a paired batch", () => {
  it("complete × ring × seed: one seed, one speaking order in both conditions; the CSV says what each run had", async () => {
    const db = createInMemoryDb();
    const providers = new ProviderRegistry([], registerBuiltinStubs(new StubProvider()));
    const evaluators = createEvaluatorRegistry();
    const service = new ExperimentService({ db, providers, evaluators });
    const batches = new BatchService({ db, providers, evaluators, service });
    const batch = batches.start({
      name: "paired",
      base: { builtin: "service-settlement" },
      repetitions: 1,
      variables: [
        { path: "communication", label: "graph", values: [{ topology: { type: "complete" } }, { topology: { type: "ring" } }] },
        { path: "randomization", label: "instance", values: [{ seed: 1 }, { seed: 2 }] },
      ],
    });
    await batches.settle(batch.id);
    const [header, ...rows] = batches.csv(batch.id).trim().split("\n").map((line) => line.split(","));
    const column = (row: string[], name: string) => row[header!.indexOf(name)]!;
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => column(r, "outcome") === "SUCCESS")).toBe(true);
    for (const seed of ["1", "2"]) {
      const pair = rows.filter((r) => column(r, "randomization_seed") === seed);
      expect(pair.map((r) => column(r, "topology")).sort()).toEqual(["complete", "ring"]);
      expect(column(pair[0]!, "speaking_order")).toBe(column(pair[1]!, "speaking_order"));
      expect(column(pair[0]!, "speaking_order")).toBe(seededShuffle(IDS, Number(seed), "speaking-order").join(">"));
      const ringRow = pair.find((r) => column(r, "topology") === "ring")!;
      expect(column(ringRow, "ring_order")).toBe(seededShuffle(IDS, Number(seed), "ring").join(">"));
      expect(column(ringRow, "mean_reach")).toBe("2");
      expect(column(pair.find((r) => column(r, "topology") === "complete")!, "ring_order")).toBe("");
    }
    // Different seeds, different orders (for these two).
    expect(seededShuffle(IDS, 1, "speaking-order")).not.toEqual(seededShuffle(IDS, 2, "speaking-order"));
  });
});

/** The settlement config without the options that make it a protocol variant. */
function withoutVariants(config: ExperimentConfig): Record<string, unknown> {
  const raw = structuredClone(config) as Record<string, any>;
  delete raw.discussion;
  delete raw.decision.proposalRequired;
  raw.limits.globalTurnLimit = 80;
  return raw;
}
