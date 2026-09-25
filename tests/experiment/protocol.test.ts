import { describe, expect, it } from "vitest";
import { InvalidCommandError } from "../../src/experiment/runner.js";
import { ProviderError, type CompletionRequest, type LlmProvider } from "../../src/llm/provider.js";
import { createHarness, ofType, SAFE_PLAN, script, testConfig, turnJson, useModel } from "../helpers/harness.js";

function runWith(responder: Parameters<typeof script>[0], mutate?: Parameters<typeof testConfig>[0]) {
  const h = createHarness({ scripts: { "test/agent": script(responder) } });
  const config = testConfig(mutate);
  useModel(config, "test/agent");
  const runner = h.runner(config);
  return { h, runner, done: runner.run() };
}

describe("proposal", () => {
  it("a schema-invalid proposal is re-requested with the validation errors, then accepted", async () => {
    const prompts: string[] = [];
    const { h, runner, done } = runWith({
      proposal: (req) => {
        prompts.push(req.messages.at(-1)!.content);
        return JSON.stringify({ rationale: "r", proposal: prompts.length === 1 ? { coolant: "banana" } : SAFE_PLAN });
      },
    });
    const metrics = await done;

    expect(metrics.termination?.outcome).toBe("SUCCESS");
    expect(metrics.proposals).toMatchObject({ attempts: 1, formatRejections: 1, frozen: 1 });
    const rejection = ofType(h.events(runner.id), "proposal_rejected_format")[0]!;
    expect(rejection.payload.kind).toBe("schema");
    expect(prompts[1]).toContain("does not match the required structure");
  });

  it("schema validation never checks success constraints: an unsafe but well-formed plan goes to the vote", async () => {
    const unsafe = { ...SAFE_PLAN, scram_reactor: false };
    const { done } = runWith({ proposal: () => JSON.stringify({ rationale: "r", proposal: unsafe }) });
    const metrics = await done;
    expect(metrics.proposals.formatRejections).toBe(0);
    expect(metrics.termination).toMatchObject({ outcome: "MISSION_FAILURE", detail: { violated: ["reactor_scrammed"] } });
  });

  it("ends in PROPOSAL_INVALID when every submission fails the schema", async () => {
    const { done } = runWith({ proposal: () => JSON.stringify({ rationale: "r", proposal: { coolant: "banana" } }) });
    const metrics = await done;
    expect(metrics.termination).toMatchObject({ outcome: "PROPOSAL_INVALID", category: "protocol" });
    expect(metrics.proposals.formatRejections).toBe(2); // first try + 1 format retry
    expect(metrics.turns.byKind.proposal).toBe(2);
  });

  it("ends in PROPOSAL_PARSE_FAILED when the proposer never produces parseable JSON", async () => {
    const { done } = runWith({ proposal: () => "I think we should use loop B." });
    const metrics = await done;
    expect(metrics.termination).toMatchObject({ outcome: "PROPOSAL_PARSE_FAILED", category: "protocol" });
    // Each proposal activation made 2 calls (1 parse retry), all counted.
    expect(metrics.llmCalls.byPurpose.proposal).toBe(4);
    expect(metrics.llmCalls.parseFailures).toBeGreaterThanOrEqual(4);
  });

  it("a declined proposal returns to discussion, then ends in NO_PROPOSAL", async () => {
    const { h, runner, done } = runWith({ proposal: () => JSON.stringify({ rationale: "We lack power data.", proposal: null }) });
    const metrics = await done;
    expect(metrics.termination).toMatchObject({ outcome: "NO_PROPOSAL", category: "coordination" });
    expect(metrics.proposals.declined).toBe(2);
    // The proposer's explanation is published to the room.
    expect(ofType(h.events(runner.id), "message_posted").some((e) => e.payload.text === "We lack power data.")).toBe(true);
  });
});

describe("voting", () => {
  it("every agent votes, in parallel and blind, on the same immutable artifact", async () => {
    const votePrompts = new Map<string, string>();
    const { h, runner, done } = runWith({
      vote: (agentId, req) => {
        votePrompts.set(agentId, req.messages.at(-1)!.content);
        return JSON.stringify({ vote: "APPROVE", reason: `SENTINEL-${agentId}` });
      },
    });
    await done;
    const events = h.events(runner.id);
    const frozen = ofType(events, "proposal_frozen")[0]!;
    const votes = ofType(events, "vote_cast");

    expect(votes.map((v) => v.agentId).sort()).toEqual(["engineering", "life_support", "operations", "power"]);
    expect(new Set(votes.map((v) => v.payload.proposalHash))).toEqual(new Set([frozen.payload.hash]));
    // Blind: no voter's prompt contains anything from another agent's vote.
    for (const prompt of votePrompts.values()) expect(prompt).not.toContain("SENTINEL");
    // Same artifact: every voter was shown the identical proposal body.
    const body = JSON.stringify(frozen.payload.body, null, 2);
    for (const prompt of votePrompts.values()) expect(prompt).toContain(body);
    // Parallel: all vote turns start before any vote is cast.
    const firstVoteCast = votes[0]!.seq;
    const voteTurns = ofType(events, "turn_started").filter((e) => e.payload.kind === "vote");
    expect(voteTurns.every((e) => e.seq < firstVoteCast)).toBe(true);
  });

  it("an unparseable vote is recorded as INVALID and never counts as approval", async () => {
    const { h, runner, done } = runWith(
      { vote: (agentId) => (agentId === "power" ? "yes!!" : JSON.stringify({ vote: "APPROVE", reason: "ok" })) },
      (c) => {
        c.decision.maxProposalAttempts = 1;
      }
    );
    const metrics = await done;
    expect(metrics.termination?.outcome).toBe("CONSENSUS_FAILURE");
    expect(metrics.protocolIncidents.invalid_vote).toBe(1);
    expect(ofType(h.events(runner.id), "vote_cast").find((v) => v.agentId === "power")?.payload.vote).toBe("INVALID");
  });

  it("majority rule commits despite one rejection", async () => {
    const { done } = runWith(
      { vote: (agentId) => JSON.stringify({ vote: agentId === "power" ? "REJECT" : "APPROVE", reason: "" }) },
      (c) => {
        c.consensus.rule = "majority";
      }
    );
    const metrics = await done;
    expect(metrics.termination?.outcome).toBe("SUCCESS");
    expect(metrics.votes.rounds[0]).toMatchObject({ reached: true, approvals: 3, required: 3 });
  });
});

describe("protocol robustness and accounting", () => {
  it("an unparseable discussion turn is retried, counted as one turn, and recorded as an incident", async () => {
    let calls = 0;
    const { h, runner, done } = runWith({
      discussion: (agentId, n) => {
        if (agentId === "operations" && n === 0) {
          calls += 1;
          return "no json here";
        }
        return turnJson({ pass: true, ready: true });
      },
    });
    const metrics = await done;
    expect(calls).toBe(2); // 1 + maxParseRetries
    expect(metrics.protocolIncidents.unparseable_turn).toBe(1);
    const opsTurns = ofType(h.events(runner.id), "turn_started").filter((e) => e.agentId === "operations" && e.payload.kind === "discussion");
    expect(opsTurns.length).toBeGreaterThanOrEqual(1);
    // Both attempts are separate llm_call events with their own usage.
    const opsCalls = ofType(h.events(runner.id), "llm_call").filter((e) => e.agentId === "operations" && e.payload.turn === 1);
    expect(opsCalls).toHaveLength(2);
    expect(opsCalls.every((e) => (e.payload.usage as { promptTokens: number }).promptTokens > 0)).toBe(true);
    expect(opsCalls[1]!.payload.parseAttempt).toBe(1);
  });

  it("retries transient provider errors (each attempt logged), and ends in PROVIDER_ERROR when they persist", async () => {
    let failuresLeft = 1;
    const flaky: LlmProvider = {
      id: "openrouter",
      async complete(req: CompletionRequest) {
        if (failuresLeft-- > 0) throw new ProviderError("rate limited", true, 429);
        return { text: script({})(req), requestedModel: req.model, servedModel: req.model, usage: { promptTokens: 10, completionTokens: 5 }, reportedCostUsd: 0.001 };
      },
    };
    const h = createHarness({ providers: [flaky] });
    const config = testConfig();
    for (const agent of config.agents) agent.model = { provider: "openrouter", model: "vendor/model", structuredOutput: "native" };
    const runner = h.runner(config);
    const metrics = await runner.run();
    expect(metrics.termination?.outcome).toBe("SUCCESS");
    expect(metrics.llmCalls.failed).toBe(1);
    expect(metrics.costUsd.agent).toBeGreaterThan(0); // provider-reported cost is used

    const down: LlmProvider = {
      id: "openrouter",
      async complete() {
        throw new ProviderError("503 unavailable", true, 503);
      },
    };
    const h2 = createHarness({ providers: [down] });
    const metrics2 = await h2.runner(config).run();
    expect(metrics2.termination).toMatchObject({ outcome: "PROVIDER_ERROR", category: "infrastructure", status: "ABORTED" });
    expect(metrics2.llmCalls.failed).toBe(3); // 1 + maxProviderRetries
  });

  it("never persists credentials, even if they leak into prompts", async () => {
    const secret = "sk-or-v1-supersecretvalue";
    const h = createHarness({ secrets: [secret], scripts: { "test/agent": script({}) } });
    const config = testConfig((c) => {
      c.agents[0]!.privateContext = `debug key ${secret}`;
    });
    useModel(config, "test/agent");
    const runner = h.runner(config);
    await runner.run();
    const raw = h.db.prepare(`SELECT group_concat(payload_json) AS all_payloads FROM events`).get() as { all_payloads: string };
    expect(raw.all_payloads).not.toContain(secret);
    expect(raw.all_payloads).toContain("[REDACTED]");
  });

  it("agents never see other agents' private context or control metadata", async () => {
    const seen: string[] = [];
    const { done } = runWith({
      discussion: (agentId, n, req) => {
        if (agentId === "power") seen.push(req.messages.map((m) => m.content).join("\n"));
        return agentId === "operations" && n === 0
          ? turnJson({ message: "Power, report.", target: "power" })
          : turnJson({ pass: true, ready: true });
      },
    });
    await done;
    const powerView = seen[0]!;
    expect(powerView).toContain("Unallocated reserve"); // its own private info
    expect(powerView).not.toContain("Loop B requires at least 30 kW"); // engineering's
    const transcript = /ROOM TRANSCRIPT \(oldest first\):\n([\s\S]*?)\n\n/.exec(powerView)![1]!;
    expect(transcript).toBe("[1] Station Operations (operations): Power, report."); // visible text only, no target/readiness
  });
});

describe("agent visibility", () => {
  it.each([false, true])("shows agents the discussion budget only when agentVisibility.discussionBudget=%s", async (visible) => {
    const prompts: string[] = [];
    const { done } = runWith(
      {
        discussion: (_agentId, _n, req) => {
          prompts.push(req.messages.at(-1)!.content);
          return turnJson({ pass: true, ready: true });
        },
      },
      (c) => {
        c.agentVisibility.discussionBudget = visible;
      }
    );
    await done;
    expect(prompts.some((p) => p.includes("discussion turns used"))).toBe(visible);
  });
});

describe("operator controls", () => {
  it("pause holds the run; step runs exactly one activation; resume continues", async () => {
    const h = createHarness({ scripts: { "test/agent": script({}) } });
    const config = testConfig();
    useModel(config, "test/agent");
    const runner = h.runner(config);
    runner.control({ type: "pause" });
    const done = runner.run();

    await new Promise((r) => setTimeout(r, 20));
    expect(runner.state().turn).toBe(0);
    runner.control({ type: "step" });
    await new Promise((r) => setTimeout(r, 20));
    expect(runner.state().turn).toBe(1);
    runner.control({ type: "resume" });
    const metrics = await done;
    expect(metrics.termination?.outcome).toBe("SUCCESS");
    expect(metrics.intervened).toBe(false); // pause/step/resume don't alter the conversation
    expect(metrics.interventions.map((i) => (i.command as { type: string }).type)).toEqual(["pause", "step", "resume"]);
  });

  it("select_next and force_decision alter the flow and mark the run as intervened", async () => {
    const h = createHarness({ scripts: { "test/chatty": script({ discussion: () => turnJson({ message: "talking" }) }) } });
    const config = testConfig();
    useModel(config, "test/chatty");
    const runner = h.runner(config);
    runner.control({ type: "pause" });
    const done = runner.run();
    await new Promise((r) => setTimeout(r, 10));

    runner.control({ type: "select_next", agentId: "life_support" });
    runner.control({ type: "step" });
    await new Promise((r) => setTimeout(r, 20));
    expect(() => runner.control({ type: "select_next", agentId: "nobody" })).toThrow(InvalidCommandError);
    runner.control({ type: "force_decision" });
    runner.control({ type: "resume" });
    const metrics = await done;

    const routing = ofType(h.events(runner.id), "routing_decision");
    expect(routing[0]).toMatchObject({ agentId: "life_support", payload: { source: "operator" } });
    const toProposal = ofType(h.events(runner.id), "phase_changed").find((e) => e.payload.to === "PROPOSAL");
    expect(toProposal?.payload.discussionEnd).toBe("operator");
    expect(metrics.intervened).toBe(true);
    expect(h.record(runner.id).intervened).toBe(true);
  });

  it("stop ends the run with STOPPED_BY_OPERATOR", async () => {
    const h = createHarness({ scripts: { "test/chatty": script({ discussion: () => turnJson({ message: "talking" }) }) } });
    const config = testConfig((c) => {
      c.limits.discussionTurnLimit = 1000;
      c.limits.globalTurnLimit = 1000;
    });
    useModel(config, "test/chatty");
    const runner = h.runner(config);
    runner.control({ type: "pause" });
    const done = runner.run();
    await new Promise((r) => setTimeout(r, 10));
    runner.control({ type: "stop" });
    const metrics = await done;
    expect(metrics.termination).toMatchObject({ outcome: "STOPPED_BY_OPERATOR", category: "operator", status: "ABORTED" });
    expect(() => runner.control({ type: "resume" })).toThrow(InvalidCommandError);
  });
});

describe("config validation up front", () => {
  it("refuses unconfigured providers and unknown stub models before creating a run", () => {
    const h = createHarness();
    const config = testConfig();
    config.agents[0]!.model = { provider: "openrouter", model: "x", structuredOutput: "native" };
    expect(() => h.runner(config)).toThrow(/not configured/);

    const config2 = testConfig();
    useModel(config2, "does/not-exist");
    expect(() => h.runner(config2)).toThrow(/unknown stub model/);
    expect(h.db.prepare(`SELECT COUNT(*) AS n FROM experiments`).get()).toEqual({ n: 0 });
  });
});
