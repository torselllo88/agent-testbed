import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BatchService } from "../../src/batch/service.js";
import { conditionConfig } from "../../src/batch/spec.js";
import { parseExperimentConfig, type ExperimentConfig } from "../../src/experiment/config.js";
import { ConfigNotRunnableError, ExperimentRunner } from "../../src/experiment/runner.js";
import { EvaluatorRegistry } from "../../src/evaluation/registry.js";
import { pilotSettlementEvaluator } from "../../src/scenarios/pilotSettlement/evaluator.js";
import { adapterFingerprint, PROTOCOL_FINGERPRINT } from "../../src/experiment/protocolFingerprint.js";
import { ExperimentService } from "../../src/experiment/service.js";
import { OllamaProvider } from "../../src/llm/ollamaProvider.js";
import { ProviderRegistry } from "../../src/llm/registry.js";
import { StubProvider } from "../../src/llm/stubProvider.js";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { EventRepository } from "../../src/persistence/eventRepository.js";
import { createEvaluatorRegistry, registerBuiltinStubs, TASK_FAMILIES } from "../../src/scenarios/index.js";
import {
  approximateCounter,
  callSeed,
  finalUser,
  lastJsonObject,
  LENGTH_REMINDER,
  oracleMessages,
  PilotSettlementAdapter,
  publicOnlyMessages,
  publicOnlySeed,
  systemPrompt,
  truncateToSentences,
  turnUser,
} from "../../src/scenarios/pilotSettlement/adapter.js";
import { pilotSettlementConfig } from "../../src/scenarios/pilotSettlement/config.js";
import { bundleInstances } from "../../src/scenarios/pilotSettlement/family.js";
import { buildRunLog } from "../../src/scenarios/pilotSettlement/runLog.js";
import { probeScript } from "../../src/scenarios/pilotSettlement/stubScripts.js";
import { AGENT_ID, AGENTS, classify, evaluate, metadata, roleCard, ROLE_OF_ID, stateHash, type RoleName } from "../../src/scenarios/pilotSettlement/task.js";
import { FAKE_OLLAMA_MODELS, startFakeOllamaServer, type FakeOllamaServer } from "../helpers/fakeOllamaServer.js";
import { createHarness, ofType } from "../helpers/harness.js";

/**
 * The pilot's task family and protocol adapter against the bundle's
 * reference implementation (tests/fixtures/pilot-settlement-reference.json:
 * tools/render_prompts.py, seeds.py, settlement_task.py and
 * validate_run_log.simulate_probe, dumped for all 50 instances; full texts
 * for DEV-01 and P-01). Gate G1: the delivery probe matches the simulation
 * for every instance in both topologies.
 */

interface Digests {
  state_hash: string;
  canonical: unknown;
  metadata: unknown;
  role_cards: Record<RoleName, string>;
  system_prompts: Record<"complete" | "ring", Record<RoleName, string>>;
  probe: Record<"complete" | "ring", Array<{ turn: number | null; speaker: RoleName; user: string; accepted: string | null }>>;
  oracle: [string, string];
  public_only: [string, string];
  seed_table: Array<{ call_type: "discussion" | "final"; round: number | null; speaker: RoleName; seed: number }>;
  oracle_seeds: number[];
  public_only_seeds: number[];
  empty_turn_user: string;
  empty_final_user: string;
}
interface Full {
  role_cards: Record<RoleName, string>;
  system_prompts: Record<"complete" | "ring", Record<RoleName, string>>;
  probe: Record<"complete" | "ring", Array<{ turn: number | null; speaker: RoleName; user_text: string; accepted_text: string | null }>>;
  oracle_messages: Array<{ role: string; content: string }>;
  public_only_messages: Array<{ role: string; content: string }>;
}
const REF = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../fixtures/pilot-settlement-reference.json", import.meta.url)), "utf8")) as {
  digests: Record<string, Digests>;
  full: Record<string, Full>;
};
const IDS = Object.keys(REF.digests);
const sha16 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
const names = (id: string) => ROLE_OF_ID[id] ?? id;

/** The pilot config of an instance under a topology (the ring in the instance's arrangement, as a batch's finalize sets it). */
function configFor(id: string, topology: "complete" | "ring"): ExperimentConfig {
  const base = pilotSettlementConfig(id);
  if (topology === "complete") return base;
  const ring = (base.protocol!.params.ringPositions as RoleName[]).map((r) => AGENT_ID[r]);
  return parseExperimentConfig({ ...base, communication: { topology: { type: "ring", order: ring } } });
}

function services() {
  const db = createInMemoryDb();
  const providers = new ProviderRegistry([], registerBuiltinStubs(new StubProvider()));
  const evaluators = createEvaluatorRegistry();
  const batches = new BatchService({ db, providers, evaluators, service: new ExperimentService({ db, providers, evaluators }) });
  return { batches, events: (id: string) => new EventRepository(db).list(id) };
}

describe("pilot settlement: the task port", () => {
  it("state hash, canonical outcome and E7 metadata equal the reference for all 50 instances", () => {
    expect(IDS).toHaveLength(50);
    for (const id of IDS) {
      const { state } = bundleInstances()[id]!;
      const d = REF.digests[id]!;
      expect(stateHash(state), id).toBe(d.state_hash);
      expect(evaluate(state), id).toEqual(d.canonical);
      expect(metadata(state), id).toEqual(d.metadata);
    }
  });

  it("the class and subtype of every instance match its file", () => {
    for (const [id, inst] of Object.entries(bundleInstances())) {
      const raw = inst as unknown as { class: string; subtype: string | null };
      expect(classify(inst.state), id).toEqual({ cls: raw.class, subtype: raw.subtype });
    }
  });

  it("role cards and system prompts (complete and ring) are byte-identical to render_prompts.py for all 50 instances", () => {
    for (const id of IDS) {
      const d = REF.digests[id]!;
      const { state } = bundleInstances()[id]!;
      for (const role of AGENTS) expect(sha16(roleCard(state, role)), `${id} ${role} card`).toBe(d.role_cards[role]);
      for (const topology of ["complete", "ring"] as const) {
        const config = configFor(id, topology);
        for (const role of AGENTS) expect(sha16(systemPrompt(config, AGENT_ID[role])), `${id} ${topology} ${role}`).toBe(d.system_prompts[topology][role]);
      }
      const oracle = oracleMessages(state);
      const pub = publicOnlyMessages(state);
      expect(oracle.map((m) => sha16(m.content)), `${id} oracle`).toEqual(d.oracle);
      expect(pub.map((m) => sha16(m.content)), `${id} public-only`).toEqual(d.public_only);
      expect(turnUser([], "operations", 1, names), `${id} empty turn`).toBe(d.empty_turn_user);
      expect(finalUser([], names), `${id} empty final`).toBe(d.empty_final_user);
    }
    for (const id of ["DEV-01", "P-01"]) {
      const full = REF.full[id]!;
      const { state } = bundleInstances()[id]!;
      for (const role of AGENTS) expect(roleCard(state, role)).toBe(full.role_cards[role]);
      for (const topology of ["complete", "ring"] as const) {
        const config = configFor(id, topology);
        for (const role of AGENTS) expect(systemPrompt(config, AGENT_ID[role])).toBe(full.system_prompts[topology][role]);
      }
      expect(oracleMessages(state)).toEqual(full.oracle_messages);
      expect(publicOnlyMessages(state)).toEqual(full.public_only_messages);
    }
  });

  it("per-call seeds follow tools/seeds.py", () => {
    for (const id of IDS) {
      const d = REF.digests[id]!;
      for (const row of d.seed_table) expect(callSeed(id, row.call_type, row.round, row.speaker), `${id} ${row.call_type} ${row.round} ${row.speaker}`).toBe(row.seed);
      expect([0, 1, 2].map((r) => callSeed(id, "oracle", null, "Operations", r))).toEqual(d.oracle_seeds);
      const { state } = bundleInstances()[id]!;
      expect([0, 1, 2].map((r) => publicOnlySeed(publicOnlyMessages(state), r))).toEqual(d.public_only_seeds);
    }
  });
});

describe("pilot settlement: the final-output parser and the message cap", () => {
  const adapter = new PilotSettlementAdapter();
  const ctx = () => ({ config: pilotSettlementConfig(), agent: pilotSettlementConfig().agents[0]!, log: [], turn: 1, round: 1, replicate: 0 });

  it("takes the last top-level JSON object, through a fence, and flags text around it", () => {
    const obj = { action: "hold", destination: null, rail: null, reason: "APPROVAL_PENDING" };
    expect(lastJsonObject(JSON.stringify(obj))).toEqual({ object: obj, extraText: false });
    expect(lastJsonObject("```json\n" + JSON.stringify(obj, null, 2) + "\n```")).toEqual({ object: obj, extraText: false });
    expect(lastJsonObject(`Here is my decision:\n${JSON.stringify(obj)}\nThanks.`)).toEqual({ object: obj, extraText: true });
    expect(lastJsonObject(`{"draft": true} then ${JSON.stringify(obj)}`)).toEqual({ object: obj, extraText: true });
    expect(lastJsonObject('{"a": "b } c"}')).toEqual({ object: { a: "b } c" }, extraText: false });
    expect(lastJsonObject("[1, 2]")).toBeNull();
    expect(lastJsonObject("no json here")).toBeNull();
    expect(lastJsonObject('{"action": "hold", ')).toBeNull();
  });

  it("a schema-valid object is a proposal; field-rule violations and missing objects are schema failures; empty content is a model failure", () => {
    const ok = adapter.acceptProposal({ text: '{"action":"execute","destination":"D2","rail":"A","reason":null}', finishReason: "stop" }, ctx());
    expect(ok).toMatchObject({ kind: "proposal", extraText: false, proposal: { action: "execute", destination: "D2", rail: "A", reason: null } });
    expect(adapter.acceptProposal({ text: '{"action":"execute","destination":"D2","rail":null,"reason":null}', finishReason: "stop" }, ctx())).toMatchObject({ kind: "schema_failure" });
    expect(adapter.acceptProposal({ text: '{"action":"hold","destination":null,"rail":null,"reason":"NO_ROUTE"}', finishReason: "stop" }, ctx())).toMatchObject({ kind: "schema_failure" });
    expect(adapter.acceptProposal({ text: '{"action":"reject","destination":null,"rail":null,"reason":"NO_ROUTE","extra":1}', finishReason: "stop" }, ctx())).toMatchObject({ kind: "schema_failure" });
    expect(adapter.acceptProposal({ text: "I cannot decide.", finishReason: "stop" }, ctx())).toMatchObject({ kind: "schema_failure" });
    expect(adapter.acceptProposal({ text: "   ", finishReason: "length" }, ctx())).toMatchObject({ kind: "model_failure", reason: "thinking_overflow" });
    expect(adapter.acceptProposal({ text: "", finishReason: "stop" }, ctx())).toMatchObject({ kind: "model_failure", reason: "empty_content" });
    // Cut at num_predict before any object: unfinished content is a model failure (plan §3.5), not a schema failure.
    expect(adapter.acceptProposal({ text: 'Let me think. {"action": "exec', finishReason: "length" }, ctx())).toMatchObject({ kind: "model_failure", reason: "thinking_overflow" });
    // A complete object that fails the schema, with text around it: a schema failure that still records extra_text.
    expect(adapter.acceptProposal({ text: 'Decision: {"action":"hold","destination":null,"rail":null,"reason":null}', finishReason: "stop" }, ctx())).toMatchObject({ kind: "schema_failure", extraText: true });
  });

  it("a discussion answer cut at num_predict is a silent turn (thinking overflow), whatever its length", () => {
    expect(adapter.acceptTurn({ text: "Contract permits D1 and", finishReason: "length" }, ctx(), 0)).toMatchObject({ kind: "silent", reason: "thinking_overflow", flags: ["silent_turn_model_failure"] });
    expect(adapter.acceptTurn({ text: "x ".repeat(600), finishReason: "length" }, ctx(), 1)).toMatchObject({ kind: "silent", reason: "thinking_overflow" });
  });

  it("an over-length message is regenerated once with the reminder, then truncated at a sentence boundary within the cap", () => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i + 1} says something about the routes and the rails.`).join(" ");
    const first = adapter.acceptTurn({ text: long, finishReason: "stop" }, ctx(), 0);
    expect(first).toMatchObject({ kind: "regenerate", reminder: LENGTH_REMINDER, flags: ["over_length_regenerated"] });
    const second = adapter.acceptTurn({ text: long, finishReason: "stop" }, ctx(), 1);
    expect(second.kind).toBe("message");
    if (second.kind !== "message") return;
    expect(second.flags).toEqual(["over_length_regenerated", "over_length_truncated"]);
    expect(second.visibleTokens).toBeLessThanOrEqual(200);
    expect(second.text.endsWith(".")).toBe(true);
    expect(long.startsWith(second.text)).toBe(true);
    expect(second.text).toBe(truncateToSentences(long, 200, approximateCounter));
    // The reminder is appended to the user text of the regeneration, on a line of its own.
    const call = adapter.renderDiscussionCall({ ...ctx(), reminder: LENGTH_REMINDER });
    expect(call.messages[1]!.content.endsWith(`\n${LENGTH_REMINDER}`)).toBe(true);
    expect(call.messages).toHaveLength(2);
  });

  it("a short message is delivered as is; an empty one is a silent turn", () => {
    expect(adapter.acceptTurn({ text: "  Contract permits D1 and D2.  ", finishReason: "stop" }, ctx(), 0)).toMatchObject({ kind: "message", text: "Contract permits D1 and D2.", flags: [] });
    expect(adapter.acceptTurn({ text: "\n", finishReason: "stop" }, ctx(), 0)).toMatchObject({ kind: "silent", reason: "empty_content", flags: ["silent_turn_model_failure"] });
  });
});

/** The probe calls of a run as the reference lists them: discussion turns in order, then the final call. */
function probeCalls(events: ReturnType<ReturnType<typeof services>["events"]>) {
  const out: Array<{ turn: number | null; speaker: RoleName; user: string; accepted: string | null; userText: string }> = [];
  let discussionTurn = 0;
  for (const started of ofType(events, "turn_started")) {
    const kind = started.payload.kind as string;
    const call = events.find((e) => e.type === "llm_call" && e.payload.turn === started.payload.turn);
    const user = (call!.payload.messages as Array<{ role: string; content: string }>).find((m) => m.role === "user")!.content;
    const posted = events.find((e) => e.type === "message_posted" && (e.payload.sender as { agentId?: string }).agentId === started.agentId && e.payload.discussionTurn === discussionTurn + 1);
    if (kind === "discussion") {
      discussionTurn += 1;
      out.push({ turn: discussionTurn, speaker: names(started.agentId!) as RoleName, user: sha16(user), accepted: posted ? String(posted.payload.text) : null, userText: user });
    } else {
      out.push({ turn: null, speaker: names(started.agentId!) as RoleName, user: sha16(user), accepted: null, userText: user });
    }
  }
  return out;
}

/** settlement_task.visible_history, independently of the trace: turns whose message is in the agent's history before it speaks. */
function visibleHistory(topology: "complete" | "ring", order: RoleName[], positions: RoleName[], agent: RoleName, upto: number, silent: Set<number>): number[] {
  const neighbours = (r: RoleName) => {
    const i = positions.indexOf(r);
    return [positions[(i + 5) % 6]!, positions[(i + 1) % 6]!];
  };
  const recipients = (r: RoleName) => (topology === "complete" ? AGENTS.filter((a) => a !== r) : neighbours(r));
  const out: number[] = [];
  for (let t = 1; t < upto; t++) {
    const speaker = order[(t - 1) % 6]!;
    if (silent.has(t)) continue;
    if (speaker === agent || recipients(speaker).includes(agent)) out.push(t);
  }
  return out;
}

describe("pilot settlement: gate G1 — the delivery probe through the testbed", () => {
  it("matches validate_run_log.simulate_probe for all 50 instances in both topologies (texts byte for byte for DEV-01 and P-01)", async () => {
    const { batches, events } = services();
    const batch = batches.start({
      name: "probe",
      base: { builtin: "pilot-settlement" },
      repetitions: 1,
      variables: [
        { path: "$instance", label: "instance", values: IDS },
        { path: "communication", label: "graph", values: [{ topology: { type: "complete" } }, { topology: { type: "ring" } }] },
      ],
    });
    await batches.settle(batch.id);
    const runs = batches.runs(batch.id);
    expect(runs).toHaveLength(100);
    for (const run of runs) {
      const config = run.config as ExperimentConfig;
      const id = (config.protocol!.params as { instanceId: string }).instanceId;
      const topology = config.communication?.topology?.type === "ring" ? "ring" : "complete";
      const label = `${id}/${topology}`;
      // The probe's fixed proposal (reject / NO_ROUTE) is judged like any other: right for the R-ROUTE instances, wrong for the rest.
      expect(run.outcome, label).toBe(classify(bundleInstances()[id]!.state).cls === "R-ROUTE" ? "SUCCESS" : "MISSION_FAILURE");
      const calls = probeCalls(events(run.id));
      const expected = REF.digests[id]!.probe[topology];
      expect(calls.map(({ userText: _u, ...c }) => c), label).toEqual(expected);
      if (REF.full[id]) {
        const full = REF.full[id]!.probe[topology];
        expect(calls.map((c) => ({ turn: c.turn, speaker: c.speaker, user_text: c.userText, accepted_text: c.accepted })), label).toEqual(full);
      }
      // The run log: the same calls, with recipients and visible histories as the schedule implies.
      const inst = bundleInstances()[id]!;
      const order = inst.topology_assignment.speaking_order;
      const positions = inst.topology_assignment.ring_positions;
      const { runLog } = buildRunLog(run, events(run.id));
      const logged = runLog.calls as Array<Record<string, unknown>>;
      expect(logged, label).toHaveLength(19);
      expect(runLog, label).toMatchObject({ run_id: `${id}-${topology.toUpperCase()}-PROBE`, condition: "probe", topology, instance_id: id, K: 3, speaking_order: order, ring_positions: positions, replicate: 0 });
      expect((runLog.validity as { status: string }).status, label).toBe("valid");
      for (const [i, c] of logged.entries()) {
        expect(sha16(String(c.user_text)), `${label} call ${i}`).toBe(expected[i]!.user);
        expect(c.accepted_text, `${label} call ${i}`).toBe(expected[i]!.accepted);
        expect(c.seed, `${label} call ${i}`).toBe(i < 18 ? callSeed(id, "discussion", Math.floor(i / 6) + 1, order[i % 6]!) : callSeed(id, "final", null, "Operations"));
        const speaker = i < 18 ? order[i % 6]! : "Operations";
        expect(c.visible_history_turns, `${label} call ${i}`).toEqual(visibleHistory(topology, order, positions, speaker, i < 18 ? i + 1 : 19, new Set()));
        if (i < 18) {
          const expectedRecipients = topology === "complete" ? AGENTS.filter((a) => a !== speaker) : [positions[(positions.indexOf(speaker) + 5) % 6], positions[(positions.indexOf(speaker) + 1) % 6]];
          expect([...(c.recipients as string[])].sort(), `${label} call ${i}`).toEqual([...expectedRecipients].sort());
          expect(c, `${label} call ${i}`).toMatchObject({ call_type: "discussion", turn: i + 1, round: Math.floor(i / 6) + 1, position_in_round: (i % 6) + 1, budget_ok: true, flags: [] });
        } else {
          expect(c, `${label} call ${i}`).toMatchObject({ call_type: "final", turn: null, round: null, recipients: [] });
        }
        const attempts = c.attempts as Array<Record<string, unknown>>;
        expect(attempts, `${label} call ${i}`).toHaveLength(1);
        expect(attempts[0], `${label} call ${i}`).toMatchObject({ attempt_index: 0, kind: "initial", seed: c.seed, accepted: true, model_failure: false, done_reason: "stop", error: null });
      }
      expect(runLog.final, label).toMatchObject({ schema_valid: true, final_model_failure: false, extra_text: false, canonical: evaluate(inst.state), parsed: { action: "reject", destination: null, rail: null, reason: "NO_ROUTE" } });
      expect((runLog.environment_snapshots as unknown[]).length, label).toBe(3);
    }
  }, 120_000);
});

describe("pilot settlement: the adapter's run semantics", () => {
  it("a silent turn delivers nothing: later histories skip it, the run goes on, the log flags it", async () => {
    const harness = createHarness({
      scripts: {
        "pilot-settlement/silent-contract-r2": (req) => {
          const ctx = req.context ?? {};
          return ctx.speaker === "Contract" && ctx.round === 2 ? "" : probeScript(req);
        },
      },
    });
    const config = pilotSettlementConfig("DEV-01", "pilot-settlement/silent-contract-r2");
    const runner = harness.runner(config);
    await runner.run();
    const events = harness.events(runner.id);
    const incidents = ofType(events, "protocol_incident").map((e) => ({ kind: e.payload.kind, agentId: e.agentId }));
    expect(incidents).toEqual([{ kind: "silent_turn_model_failure", agentId: "contract" }]);
    expect(ofType(events, "message_posted").filter((e) => (e.payload.sender as { kind: string }).kind === "agent")).toHaveLength(17);
    const { runLog } = buildRunLog(harness.record(runner.id), events);
    const calls = runLog.calls as Array<Record<string, unknown>>;
    const silent = calls.find((c) => c.speaker === "Contract" && c.round === 2)!;
    expect(silent).toMatchObject({ accepted_text: null, flags: ["silent_turn_model_failure"] });
    expect((silent.attempts as Array<Record<string, unknown>>)[0]).toMatchObject({ accepted: false, model_failure: true, content: "" });
    const silentTurn = silent.turn as number;
    for (const c of calls) {
      if ((c.turn as number | null) !== null && (c.turn as number) > silentTurn) expect(c.visible_history_turns).not.toContain(silentTurn);
    }
    // The validator's rule: the history of a later call omits the silent turn — the user text has no line for it.
    const inst = bundleInstances()["DEV-01"]!;
    const order = inst.topology_assignment.speaking_order;
    const later = calls.filter((c) => (c.turn as number | null) !== null && (c.turn as number) > silentTurn);
    expect(later.length).toBeGreaterThan(0);
    expect((runLog.validity as { status: string; flags: string[] })).toMatchObject({ status: "valid", flags: ["silent_turn_model_failure"] });
    expect(order[(silentTurn - 1) % 6]).toBe("Contract");
  });

  it("a final answer that is not a valid proposal ends the run as PROPOSAL_INVALID (schema failure) or PROPOSAL_PARSE_FAILED (model failure), with no retry", async () => {
    const harness = createHarness({
      scripts: {
        "pilot-settlement/final-garbage": (req) => (req.context?.purpose === "proposal" ? "Execute D2 over rail A." : probeScript(req)),
        "pilot-settlement/final-empty": (req) => (req.context?.purpose === "proposal" ? "" : probeScript(req)),
      },
    });
    for (const [model, outcome, kind] of [
      ["pilot-settlement/final-garbage", "PROPOSAL_INVALID", "schema"],
      ["pilot-settlement/final-empty", "PROPOSAL_PARSE_FAILED", "model_failure"],
    ] as const) {
      const runner = harness.runner(pilotSettlementConfig("DEV-02", model));
      await runner.run();
      const record = harness.record(runner.id);
      expect(record.outcome, model).toBe(outcome);
      expect(record.status, model).toBe("FAILURE");
      const events = harness.events(runner.id);
      expect(ofType(events, "llm_call").filter((e) => e.payload.purpose === "proposal"), model).toHaveLength(1);
      expect(ofType(events, "proposal_rejected_format").map((e) => e.payload.kind), model).toEqual([kind]);
      expect(ofType(events, "proposal_frozen"), model).toHaveLength(0);
      const { runLog } = buildRunLog(record, events);
      expect(runLog.final, model).toMatchObject({ schema_valid: false, parsed: null, correct_exact: false, final_model_failure: kind === "model_failure" });
      expect((runLog.validity as { status: string }).status, model).toBe("valid");
    }
  });

  it("$solo gives the adapter's controls: the oracle call (full) and the public-only call (public), seeded as tools/seeds.py", async () => {
    const { batches, events } = services();
    const batch = batches.start({
      name: "controls",
      base: { builtin: "pilot-settlement" },
      repetitions: 1,
      variables: [
        { path: "$instance", label: "instance", values: ["DEV-03"] },
        { path: "$solo", label: "control", values: ["full", "public"] },
      ],
    });
    await batches.settle(batch.id);
    const runs = batches.runs(batch.id);
    expect(runs).toHaveLength(2);
    const { state } = bundleInstances()["DEV-03"]!;
    for (const run of runs) {
      const config = run.config as ExperimentConfig;
      const control = config.protocol!.control!;
      expect(config.agents.map((a) => a.id)).toEqual(["operations"]);
      const calls = ofType(events(run.id), "llm_call");
      expect(calls).toHaveLength(1);
      const expected = control === "oracle" ? oracleMessages(state) : publicOnlyMessages(state);
      expect(calls[0]!.payload.messages).toEqual(expected);
      expect(calls[0]!.payload.seed).toBe(control === "oracle" ? callSeed("DEV-03", "oracle", null, "Operations") : publicOnlySeed(expected));
      const { runLog } = buildRunLog(run, events(run.id));
      expect(runLog).toMatchObject({ run_id: `DEV-03-${control === "oracle" ? "ORACLE" : "PUBLIC_ONLY"}`, condition: control, topology: "none" });
      expect((runLog.calls as Array<{ call_type: string }>).map((c) => c.call_type)).toEqual([control]);
    }
  });

  it("a replicate changes every seed and the run id, nothing else", () => {
    const base = pilotSettlementConfig("DEV-04");
    const rep = parseExperimentConfig({ ...base, protocol: { ...base.protocol, replicate: 2 } });
    const adapter = new PilotSettlementAdapter();
    const ctx = (config: ExperimentConfig) => ({ config, agent: config.agents[1]!, log: [], turn: 1, round: 1, replicate: config.protocol!.replicate });
    const a = adapter.renderDiscussionCall(ctx(base));
    const b = adapter.renderDiscussionCall(ctx(rep));
    expect(a.messages).toEqual(b.messages);
    expect(a.seed).toBe(callSeed("DEV-04", "discussion", 1, "Contract", 0));
    expect(b.seed).toBe(callSeed("DEV-04", "discussion", 1, "Contract", 2));
    expect(a.seed).not.toBe(b.seed);
  });

  it("the batch's finalize puts the ring in the instance's arrangement; an explicit ring that differs is refused", () => {
    const base = pilotSettlementConfig("DEV-05");
    const raw = conditionConfig(
      base,
      [
        { path: "$instance", label: "instance", values: ["DEV-05"] },
        { path: "communication", label: "graph", values: [{ topology: { type: "ring" } }] },
      ],
      { key: "x", values: { instance: "DEV-05", graph: { topology: { type: "ring" } } } },
      TASK_FAMILIES
    ) as { communication: { topology: { order: string[] } } };
    const positions = bundleInstances()["DEV-05"]!.topology_assignment.ring_positions.map((r) => AGENT_ID[r]);
    expect(raw.communication.topology.order).toEqual(positions);

    const evaluators = createEvaluatorRegistry();
    const adapter = evaluators.adapter("pilot-settlement");
    const wrong = parseExperimentConfig({ ...base, communication: { topology: { type: "ring", order: [...positions].reverse() } } });
    expect(adapter.checkConfig(wrong).join("\n")).toMatch(/ring/);
    expect(adapter.checkConfig(parseExperimentConfig({ ...base, communication: { topology: { type: "ring", order: positions } } }))).toEqual([]);
    expect(adapter.checkConfig(base)).toEqual([]);
    const harness = createHarness();
    expect(() => harness.runner(wrong)).toThrow(ConfigNotRunnableError);
    expect(() => harness.runner({ ...base, discussion: { fixedRounds: 2 } })).toThrow(/fixedRounds must be 3/);
    expect(() => harness.runner({ ...base, scheduler: { ...base.scheduler, startAgentId: "contract" } })).toThrow(/startAgentId/);
    // The parameters must be the bundle's record: another instance's order, or another instance's state, is refused.
    const other = bundleInstances()["DEV-06"]!.topology_assignment.speaking_order;
    expect(adapter.checkConfig(parseExperimentConfig({ ...base, protocol: { ...base.protocol, params: { ...base.protocol!.params, speakingOrder: other } } })).join("\n")).toMatch(/speakingOrder/);
    expect(adapter.checkConfig(parseExperimentConfig({ ...base, evaluator: { ...base.evaluator, params: { ...base.evaluator.params, instanceId: "DEV-06" } } })).join("\n")).toMatch(/evaluator.params/);
    // A real endpoint must be given the plan's generation settings.
    const real = (model: Record<string, unknown>) => parseExperimentConfig({ ...base, agents: base.agents.map((a) => ({ ...a, model: { ...a.model, ...model, provider: "openai-compatible", endpoint: "lab-ollama", model: "qwen-fake:27b" } })) });
    expect(adapter.checkConfig(real({ think: true, contextLength: 8192 })).join("\n")).toBe("");
    expect(adapter.checkConfig(real({ think: true })).join("\n")).toMatch(/contextLength 8192/);
    expect(adapter.checkConfig(real({ think: false, contextLength: 8192 })).join("\n")).toMatch(/think true/);
    expect(adapter.checkConfig(real({ think: true, contextLength: 8192, temperature: 0.7, seed: 1 })).join("\n")).toMatch(/temperature 1.*no fixed seed/);
  });

  it("the protocol fingerprint of a run is the adapter's, and the config refuses what the adapter cannot rely on", async () => {
    const harness = createHarness();
    const runner = harness.runner(pilotSettlementConfig("DEV-06"));
    await runner.run();
    const started = ofType(harness.events(runner.id), "experiment_started")[0]!.payload;
    const adapter = createEvaluatorRegistry().adapter("pilot-settlement");
    expect(started.protocolFingerprint).toBe(adapterFingerprint(adapter));
    expect(started.protocolFingerprint).not.toBe(PROTOCOL_FINGERPRINT);
    expect(started.protocolAdapter).toEqual({ id: "pilot-settlement", version: "0.3.1" });
    expect(adapterFingerprint(adapter)).toMatch(/^[0-9a-f]{16}$/);

    const base = pilotSettlementConfig();
    expect(() => parseExperimentConfig({ ...base, consensus: { rule: "majority" } })).toThrow(/consensus.rule "none"/);
    expect(() => parseExperimentConfig({ ...base, decision: { ...base.decision, maxProposalFormatRetries: 1 } })).toThrow(/maxProposalFormatRetries must be 0/);
    expect(() => parseExperimentConfig({ ...base, randomization: { seed: 1 } })).toThrow(/randomization/);
  });
});

describe("pilot settlement: calls to an Ollama endpoint", () => {
  let server: FakeOllamaServer;
  beforeAll(async () => {
    server = await startFakeOllamaServer();
  });
  afterAll(async () => {
    await server.close();
  });

  const withOllama = (config: ExperimentConfig): ExperimentConfig =>
    parseExperimentConfig({
      ...config,
      agents: config.agents.map((a) => ({
        ...a,
        model: { ...a.model, provider: "openai-compatible", endpoint: "lab-ollama", model: FAKE_OLLAMA_MODELS[0], structuredOutput: "prompt", think: true, contextLength: 8192 },
      })),
    });

  it("sends the pilot's generation settings and the per-call seed; the preflight budget stops a call that cannot fit", async () => {
    const provider = new OllamaProvider({ name: "lab-ollama", baseUrl: server.url });
    const harness = createHarness({ providers: [provider] });
    const config = withOllama(pilotSettlementConfig("DEV-07"));
    const runner = harness.runner(config);
    await runner.run();
    expect(server.requests.length).toBe(19);
    const first = server.requests[0]!;
    const order = bundleInstances()["DEV-07"]!.topology_assignment.speaking_order;
    expect(first.options).toMatchObject({ temperature: 1, num_predict: 2560, num_ctx: 8192, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0, repeat_penalty: 1, seed: callSeed("DEV-07", "discussion", 1, order[0]!) });
    expect(first.think).toBe(true);
    expect((first as { keep_alive?: string }).keep_alive).toBe("30m");
    expect(first.format).toBeUndefined();
    expect(first.messages.map((m) => m.role)).toEqual(["system", "user"]);
    const calls = ofType(harness.events(runner.id), "llm_call");
    expect(calls[0]!.payload).toMatchObject({ raw: true, budgetOk: true, tokenCounter: "approximate", attemptKind: "initial", keepAlive: "30m", sampling: { topP: 0.95, topK: 20, minP: 0, presencePenalty: 0, repeatPenalty: 1 } });
    expect(typeof calls[0]!.payload.promptTokensCounted).toBe("number");

    // The guard: an adapter whose counter sees a prompt too long for the window never lets the call out.
    server.requests.length = 0;
    const evaluators = new EvaluatorRegistry().register(pilotSettlementEvaluator).registerAdapter(new PilotSettlementAdapter({ kind: "approximate", count: () => 6000 }));
    const tight = new ExperimentRunner({ db: harness.db, providers: harness.providers, evaluators }, withOllama(pilotSettlementConfig("DEV-07")));
    await tight.run();
    const record = harness.record(tight.id);
    expect(record.outcome).toBe("CONTEXT_BUDGET_VIOLATION");
    expect(record.status).toBe("ABORTED");
    expect(server.requests.length).toBe(0);
    const incident = ofType(harness.events(tight.id), "protocol_incident")[0]!.payload;
    expect(incident).toMatchObject({ kind: "context_budget_violation", purpose: "discussion", budgetOk: false, promptTokensCounted: 6000, maxOutputTokens: 2560, contextLength: 8192 });
    const { runLog } = buildRunLog(record, harness.events(tight.id));
    expect((runLog.validity as { status: string }).status).toBe("context_truncation");
  });
});
