/**
 * The research demo's data (#/research): the pilot's dev runs as a replay dataset, served read-only.
 * The dataset lives in experiments/pilot-settlement/demo/ — run logs (schemas/run_log.schema.json,
 * thinking files left out), the pair records of the pair runner, and the detector outputs
 * (schemas/detector_output.schema.json) when present. Everything the page shows is derived here
 * from those files and the bundle's instances: the paired runs, what every agent had received
 * before a turn, the path of every fact through the graph, the batch summary.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROMPT_COUNT_RULE } from "./adapter.js";
import { bundleInstances } from "./family.js";
import { AGENTS, baseFacts, evaluate, FACT_IDS, FACT_SOURCE, factSentence, roleCard, type FactId, type FactValue, type Proposal, type RoleName, type SettlementState } from "./task.js";
import type { Claim, DecisionSupport } from "./detector/postprocess.js";

export const DEMO_DATA_DIR = fileURLToPath(new URL("../../../experiments/pilot-settlement/demo", import.meta.url));

// ---------------------------------------------------------------- the files

interface RunLogAttempt {
  attempt_index: number;
  kind: string;
  accepted: boolean;
  content: string | null;
  done_reason: string | null;
  prompt_eval_count: number | null;
  eval_count: number | null;
  content_tokens: number | null;
  thinking_tokens: number | null;
  total_duration_ns: number | null;
  error: string | null;
}
interface RunLogCall {
  call_index: number;
  call_type: "discussion" | "final" | "oracle" | "public_only";
  turn: number | null;
  round: number | null;
  speaker: RoleName;
  recipients?: RoleName[];
  accepted_text?: string | null;
  visible_history_turns?: number[];
  visible_tokens?: number | null;
  flags: string[];
  prompt_tokens_counted: number;
  attempts: RunLogAttempt[];
}
export interface RunLogFile {
  run_id: string;
  instance_id: string;
  condition: string;
  topology: "complete" | "ring" | "none";
  config_version: string;
  class: string;
  subtype: string | null;
  speaking_order: RoleName[];
  ring_positions: RoleName[] | null;
  attempt: number;
  calls: RunLogCall[];
  final: { raw_content: string | null; parsed: Proposal | null; schema_valid: boolean; extra_text: boolean; canonical: Proposal; correct_exact: boolean; field_correct: Record<string, boolean>; final_model_failure: boolean };
  validity: { status: string; detail: string; flags: string[] };
  environment_snapshots: Array<{ when: string; normal: boolean; deviation: string | null; taken_at: string }>;
  preload?: { ok?: boolean };
}
export interface DetectorFile {
  run_id: string;
  detector_version: string;
  extraction_model: string;
  claims: Claim[];
  operations: DecisionSupport;
  extraction_failures: number[];
}

export interface DemoDataset {
  dir: string;
  runs: Map<string, RunLogFile>;
  detector: Map<string, DetectorFile>;
  /** Instance ids with both a Complete and a Ring log, in id order. */
  instances: string[];
}

function readJsonFiles<T>(dir: string, keep: (name: string) => boolean): T[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && keep(f))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as T);
}

const cache = new Map<string, DemoDataset>();
/** The dataset, read once per directory (the files are static; restart the server after replacing them). */
export function loadDemoDataset(dir: string = DEMO_DATA_DIR): DemoDataset {
  const hit = cache.get(dir);
  if (hit) return hit;
  const runs = new Map<string, RunLogFile>();
  for (const log of readJsonFiles<RunLogFile>(path.join(dir, "dev-runs"), (f) => !f.includes(".thinking.") && !f.includes(".detector."))) {
    if (log.condition === "discussion" && (log.topology === "complete" || log.topology === "ring")) runs.set(log.run_id, log);
  }
  const detector = new Map<string, DetectorFile>();
  for (const d of readJsonFiles<DetectorFile>(path.join(dir, "detector"), (f) => f.endsWith(".detector.json"))) detector.set(d.run_id, d);
  const known = bundleInstances();
  const instances = [...new Set([...runs.values()].map((r) => r.instance_id))].filter((id) => known[id] && runs.has(`${id}-COMPLETE`) && runs.has(`${id}-RING`)).sort();
  const ds = { dir, runs, detector, instances };
  cache.set(dir, ds);
  return ds;
}
export function resetDemoDatasetCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------- derived views

export interface DemoCall {
  turn: number;
  round: number;
  speaker: RoleName;
  recipients: RoleName[];
  /** The accepted message; null for a silent turn. */
  text: string | null;
  /** Turns whose messages were in the speaker's history for this call. */
  visible_turns: number[];
  flags: string[];
  prompt_tokens: number | null;
  message_tokens: number | null;
  thinking_tokens: number | null;
  duration_ms: number | null;
  attempts: number;
}
export interface DemoRun {
  run_id: string;
  topology: "complete" | "ring";
  config_version: string;
  speaking_order: RoleName[];
  ring_positions: RoleName[] | null;
  /** Who each agent sends to (and, the graphs being symmetric, receives from). */
  neighbours: Record<RoleName, RoleName[]>;
  calls: DemoCall[];
  final: { proposal: Proposal | null; canonical: Proposal; correct: boolean; field_correct: Record<string, boolean>; schema_valid: boolean; model_failure: boolean; raw: string | null; prompt_tokens: number | null; thinking_tokens: number | null };
  validity: { status: string; detail: string; flags: string[] };
  snapshots_normal: boolean;
  stats: { messages: number; silent_turns: number; regenerations: number; message_tokens_median: number | null; message_tokens_max: number | null; thinking_tokens_median: number | null; thinking_tokens_max: number | null; prompt_tokens_max: number | null; duration_s: number | null };
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const max = (xs: number[]): number | null => (xs.length ? Math.max(...xs) : null);
const ms = (ns: number | null | undefined): number | null => (typeof ns === "number" ? Math.round(ns / 1e6) : null);

function neighboursOf(log: RunLogFile): Record<RoleName, RoleName[]> {
  const out = {} as Record<RoleName, RoleName[]>;
  if (log.topology === "ring" && log.ring_positions) {
    const ring = log.ring_positions;
    ring.forEach((r, i) => (out[r] = [ring[(i + ring.length - 1) % ring.length]!, ring[(i + 1) % ring.length]!]));
  } else for (const r of AGENTS) out[r] = AGENTS.filter((x) => x !== r);
  return out;
}

export function demoRun(log: RunLogFile): DemoRun {
  const calls: DemoCall[] = log.calls
    .filter((c) => c.call_type === "discussion" && typeof c.turn === "number")
    .map((c) => {
      const accepted = c.attempts.find((a) => a.accepted) ?? c.attempts[c.attempts.length - 1];
      return {
        turn: c.turn as number,
        round: c.round ?? Math.ceil((c.turn as number) / 6),
        speaker: c.speaker,
        recipients: c.recipients ?? [],
        text: typeof c.accepted_text === "string" ? c.accepted_text : null,
        visible_turns: c.visible_history_turns ?? [],
        flags: c.flags ?? [],
        prompt_tokens: c.attempts[0]?.prompt_eval_count ?? null,
        message_tokens: accepted?.content_tokens ?? c.visible_tokens ?? null,
        thinking_tokens: accepted?.thinking_tokens ?? null,
        duration_ms: ms(c.attempts.reduce((n, a) => n + (a.total_duration_ns ?? 0), 0)) || null,
        attempts: c.attempts.length,
      };
    })
    .sort((a, b) => a.turn - b.turn);
  const finalCall = log.calls.find((c) => c.call_type === "final");
  const finalAttempt = finalCall?.attempts[finalCall.attempts.length - 1];
  const messageTokens = calls.map((c) => c.message_tokens).filter((x): x is number => typeof x === "number");
  const thinkingTokens = calls.map((c) => c.thinking_tokens).filter((x): x is number => typeof x === "number");
  const promptTokens = [...calls.map((c) => c.prompt_tokens), finalAttempt?.prompt_eval_count ?? null].filter((x): x is number => typeof x === "number");
  const durations = [...calls.map((c) => c.duration_ms), ms(finalAttempt?.total_duration_ns)].filter((x): x is number => typeof x === "number");
  return {
    run_id: log.run_id,
    topology: log.topology as "complete" | "ring",
    config_version: log.config_version,
    speaking_order: log.speaking_order,
    ring_positions: log.ring_positions,
    neighbours: neighboursOf(log),
    calls,
    final: {
      proposal: log.final.parsed,
      canonical: log.final.canonical,
      correct: log.final.correct_exact,
      field_correct: log.final.field_correct,
      schema_valid: log.final.schema_valid,
      model_failure: log.final.final_model_failure,
      raw: log.final.raw_content,
      prompt_tokens: finalAttempt?.prompt_eval_count ?? null,
      thinking_tokens: finalAttempt?.thinking_tokens ?? null,
    },
    validity: log.validity,
    snapshots_normal: log.environment_snapshots.every((s) => s.normal),
    stats: {
      messages: calls.filter((c) => c.text !== null).length,
      silent_turns: calls.filter((c) => c.text === null).length,
      regenerations: calls.filter((c) => c.flags.includes("over_length_regenerated")).length,
      message_tokens_median: median(messageTokens),
      message_tokens_max: max(messageTokens),
      thinking_tokens_median: median(thinkingTokens),
      thinking_tokens_max: max(thinkingTokens),
      prompt_tokens_max: max(promptTokens),
      duration_s: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / 1000) : null,
    },
  };
}

/** The messages an agent had received (or sent) before turn `t`: immediate delivery, own messages included. */
export function receivedBefore(run: DemoRun, agent: RoleName, t: number): DemoCall[] {
  return run.calls.filter((c) => c.turn < t && c.text !== null && (c.speaker === agent || c.recipients.includes(agent)));
}

export interface FactChainStep {
  turn: number;
  sender: RoleName;
  recipients: RoleName[];
  value: FactValue;
  truth: boolean;
  source: string | null;
  support: string | null;
  hedged: boolean;
  span: string;
}
export interface FactView {
  fact: FactId;
  holder: RoleName;
  true_value: FactValue;
  sentence: string;
  /** Operations' exposure state (E6): absent, correct, incorrect, conflicting. */
  exposure: string;
  /** The first turn a supported, unhedged claim of the true value reached Operations; null if never. */
  exposed_at: number | null;
  /** The first turn the holder stated it; null if never. */
  stated_at: number | null;
  chain: FactChainStep[];
  /** Agents that had received a supported claim of the fact but never passed it on. */
  received_not_relayed: RoleName[];
  /** Where propagation stopped, in words; null when the fact reached Operations. */
  stop: string | null;
}
export interface DetectorView {
  run_id: string;
  detector_version: string;
  extraction_model: string;
  facts: FactView[];
  category: string;
  minimal_fact_set_exposed: boolean;
  levels: Record<string, string>;
  unsupported: DecisionSupport["unsupported_exposure"];
  claim_counts: Record<string, number>;
  source_counts: Record<string, number>;
  extraction_failures: number[];
}

export function detectorView(d: DetectorFile, state: SettlementState): DetectorView {
  const truth = baseFacts(state);
  const base = d.claims.filter((c): c is Extract<Claim, { type: "base" }> => c.type === "base");
  const facts: FactView[] = FACT_IDS.map((fact) => {
    const chain = base
      .filter((c) => c.fact === fact)
      .map((c) => ({ turn: c.turn as number, sender: c.sender as RoleName, recipients: (c.recipients ?? []) as RoleName[], value: c.value, truth: c.truth as boolean, source: c.source ?? null, support: c.support ?? null, hedged: c.hedged, span: c.span }))
      .sort((a, b) => a.turn - b.turn);
    const holder = FACT_SOURCE[fact];
    const toOps = chain.filter((s) => s.recipients.includes("Operations") && !s.hedged && s.support === "supported" && s.truth);
    const exposedAt = toOps.length ? toOps[0]!.turn : null;
    const stated = chain.filter((s) => s.sender === holder && !s.hedged);
    const received = new Set<RoleName>();
    const relayed = new Set<RoleName>(chain.filter((s) => !s.hedged).map((s) => s.sender));
    for (const s of chain) if (!s.hedged && s.support === "supported" && s.truth) for (const r of s.recipients) received.add(r);
    const receivedNotRelayed = [...received].filter((r) => !relayed.has(r) && r !== "Operations");
    let stop: string | null = null;
    if (exposedAt === null) {
      if (!chain.length) stop = `never stated by ${holder}`;
      else if (!stated.length) stop = `${holder} never stated it; only ${[...relayed].join(", ")} asserted it (${chain.map((s) => s.support ?? "?").filter((x, i, a) => a.indexOf(x) === i).join(", ")})`;
      else if (receivedNotRelayed.length) stop = `received by ${receivedNotRelayed.join(", ")} and not passed on`;
      else if (d.operations.exposure[fact] === "incorrect" || d.operations.exposure[fact] === "conflicting") stop = `reached Operations as ${d.operations.exposure[fact]}`;
      else stop = "stated, but no supported claim of the true value reached Operations";
    }
    return {
      fact,
      holder,
      true_value: truth[fact],
      sentence: factSentence(fact, truth[fact]),
      exposure: d.operations.exposure[fact],
      exposed_at: exposedAt,
      stated_at: stated.length ? stated[0]!.turn : null,
      chain,
      received_not_relayed: receivedNotRelayed,
      stop,
    };
  });
  const count = (xs: string[]) => xs.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
  return {
    run_id: d.run_id,
    detector_version: d.detector_version,
    extraction_model: d.extraction_model,
    facts,
    category: d.operations.category,
    minimal_fact_set_exposed: d.operations.minimal_fact_set_exposed,
    levels: d.operations.levels,
    unsupported: d.operations.unsupported_exposure,
    claim_counts: count(d.claims.map((c) => c.type)),
    source_counts: count(d.claims.map((c) => c.source).filter((s): s is NonNullable<typeof s> => !!s)),
    extraction_failures: d.extraction_failures,
  };
}

export interface InstanceOverview {
  id: string;
  class: string;
  subtype: string | null;
  requested: string;
  canonical: Proposal;
  complete: { run_id: string; correct: boolean; validity: string; proposal: Proposal | null; category: string | null };
  ring: { run_id: string; correct: boolean; validity: string; proposal: Proposal | null; category: string | null };
}

export function instanceOverviews(ds: DemoDataset): InstanceOverview[] {
  const known = bundleInstances();
  return ds.instances.map((id) => {
    const inst = known[id]!;
    const side = (topology: "COMPLETE" | "RING") => {
      const log = ds.runs.get(`${id}-${topology}`)!;
      return { run_id: log.run_id, correct: log.final.correct_exact, validity: log.validity.status, proposal: log.final.parsed, category: ds.detector.get(log.run_id)?.operations.category ?? null };
    };
    return { id, class: (inst as unknown as { class: string }).class, subtype: (inst as unknown as { subtype: string | null }).subtype, requested: inst.state.requested_destination, canonical: evaluate(inst.state), complete: side("COMPLETE"), ring: side("RING") };
  });
}

export interface InstanceView {
  id: string;
  class: string;
  subtype: string | null;
  state: SettlementState;
  canonical: Proposal;
  role_cards: Record<RoleName, string>;
  facts: Array<{ fact: FactId; holder: RoleName; value: FactValue; sentence: string }>;
  minimal_fact_sets: string[][];
  runs: { complete: DemoRun; ring: DemoRun };
  detector: { complete: DetectorView; ring: DetectorView } | null;
}

export function instanceView(ds: DemoDataset, id: string): InstanceView | null {
  const inst = bundleInstances()[id];
  const complete = ds.runs.get(`${id}-COMPLETE`);
  const ring = ds.runs.get(`${id}-RING`);
  if (!inst || !complete || !ring) return null;
  const truth = baseFacts(inst.state);
  const dc = ds.detector.get(complete.run_id);
  const dr = ds.detector.get(ring.run_id);
  return {
    id,
    class: (inst as unknown as { class: string }).class,
    subtype: (inst as unknown as { subtype: string | null }).subtype,
    state: inst.state,
    canonical: evaluate(inst.state),
    role_cards: Object.fromEntries(AGENTS.map((r) => [r, roleCard(inst.state, r)])) as Record<RoleName, string>,
    facts: FACT_IDS.map((f) => ({ fact: f, holder: FACT_SOURCE[f], value: truth[f], sentence: factSentence(f, truth[f]) })),
    minimal_fact_sets: ((inst as unknown as { metadata?: { minimal_fact_sets?: string[][] } }).metadata?.minimal_fact_sets ?? []) as string[][],
    runs: { complete: demoRun(complete), ring: demoRun(ring) },
    detector: dc && dr ? { complete: detectorView(dc, inst.state), ring: detectorView(dr, inst.state) } : null,
  };
}

export interface BatchSummary {
  pairs: number;
  config_versions: string[];
  transitions: { both_correct: number; complete_only: number; ring_only: number; both_incorrect: number };
  by_class: Record<string, { n: number; complete_correct: number; ring_correct: number }>;
  per_topology: Record<"complete" | "ring", { runs: number; correct: number; valid: number; calls: number; silent_turns: number; regenerations: number; truncated: number; schema_failures: number; message_tokens_median: number | null; message_tokens_max: number | null; thinking_tokens_median: number | null; thinking_tokens_max: number | null; prompt_tokens_max: number | null; duration_s_median: number | null; categories: Record<string, number>; exposure_correct_per_run_median: number | null }>;
  environment: { snapshots: number; snapshots_normal: number; deviations: number };
  detector: boolean;
}

export function batchSummary(ds: DemoDataset): BatchSummary {
  const transitions = { both_correct: 0, complete_only: 0, ring_only: 0, both_incorrect: 0 };
  const byClass: BatchSummary["by_class"] = {};
  const per = { complete: [] as DemoRun[], ring: [] as DemoRun[] };
  let snapshots = 0;
  let normal = 0;
  const versions = new Set<string>();
  const known = bundleInstances();
  for (const id of ds.instances) {
    const c = ds.runs.get(`${id}-COMPLETE`)!;
    const r = ds.runs.get(`${id}-RING`)!;
    versions.add(c.config_version);
    versions.add(r.config_version);
    const cls = (known[id] as unknown as { class: string }).class;
    byClass[cls] ??= { n: 0, complete_correct: 0, ring_correct: 0 };
    byClass[cls]!.n += 1;
    if (c.final.correct_exact) byClass[cls]!.complete_correct += 1;
    if (r.final.correct_exact) byClass[cls]!.ring_correct += 1;
    if (c.final.correct_exact && r.final.correct_exact) transitions.both_correct += 1;
    else if (c.final.correct_exact) transitions.complete_only += 1;
    else if (r.final.correct_exact) transitions.ring_only += 1;
    else transitions.both_incorrect += 1;
    per.complete.push(demoRun(c));
    per.ring.push(demoRun(r));
    for (const log of [c, r]) {
      snapshots += log.environment_snapshots.length;
      normal += log.environment_snapshots.filter((s) => s.normal).length;
    }
  }
  const topo = (runs: DemoRun[], topology: "complete" | "ring") => {
    const calls = runs.flatMap((r) => r.calls);
    const msg = calls.map((c) => c.message_tokens).filter((x): x is number => typeof x === "number");
    const think = calls.map((c) => c.thinking_tokens).filter((x): x is number => typeof x === "number");
    const categories: Record<string, number> = {};
    const exposureCorrect: number[] = [];
    for (const r of runs) {
      const d = ds.detector.get(r.run_id);
      if (d) {
        categories[d.operations.category] = (categories[d.operations.category] ?? 0) + 1;
        exposureCorrect.push(Object.values(d.operations.exposure).filter((v) => v === "correct").length);
      }
    }
    return {
      runs: runs.length,
      correct: runs.filter((r) => r.final.correct).length,
      valid: runs.filter((r) => r.validity.status === "valid").length,
      calls: calls.length + runs.length,
      silent_turns: runs.reduce((n, r) => n + r.stats.silent_turns, 0),
      regenerations: runs.reduce((n, r) => n + r.stats.regenerations, 0),
      truncated: calls.filter((c) => c.flags.includes("over_length_truncated")).length,
      schema_failures: runs.filter((r) => !r.final.schema_valid).length,
      message_tokens_median: median(msg),
      message_tokens_max: max(msg),
      thinking_tokens_median: median(think),
      thinking_tokens_max: max(think),
      prompt_tokens_max: max(runs.map((r) => r.stats.prompt_tokens_max).filter((x): x is number => typeof x === "number")),
      duration_s_median: median(runs.map((r) => r.stats.duration_s).filter((x): x is number => typeof x === "number")),
      categories,
      exposure_correct_per_run_median: median(exposureCorrect),
      topology,
    };
  };
  return {
    pairs: ds.instances.length,
    config_versions: [...versions].sort(),
    transitions,
    by_class: byClass,
    per_topology: { complete: topo(per.complete, "complete"), ring: topo(per.ring, "ring") },
    environment: { snapshots, snapshots_normal: normal, deviations: snapshots - normal },
    detector: ds.instances.every((id) => ds.detector.has(`${id}-COMPLETE`) && ds.detector.has(`${id}-RING`)),
  };
}

/** The methods block of the page: the frozen configuration and the development gates, as facts. */
export const PILOT_DEMO_METHODS = {
  task: "Distributed Settlement Decision, Task Definition v1.4: six agents, private facts split by role, Operations alone proposes {action, destination, rail, reason}; a deterministic evaluator judges exact correctness against the canonical outcome.",
  conditions: "Complete (every message reaches all five others) vs Ring (each message reaches the sender's two ring neighbours). Same instance, same speaking order, same per-call seeds; only the delivery graph differs.",
  protocol: "K = 3 fixed rounds, 18 turns in the instance's order, then one mandatory final call; immediate delivery; every call is [system, user] rebuilt from the log of accepted messages; no assistant turns are ever sent.",
  runtime: "qwen3.8:27b (Q4_K_M) on Ollama 0.33.2, native /api/chat; thinking on, temperature 1.0, top_p 0.95, top_k 20, min_p 0, num_ctx 8192, num_predict 2560; visible messages: at most four sentences and under 100 words, hard cap 200 tokens with one regeneration.",
  seeds: "Per call: sha256(master 20261120 | instance | call type | round | speaker | replicate), first 31 bits — the paired Complete and Ring calls of an instance share seeds.",
  tokenCount: `Prompt tokens are counted with the model's own tokenizer (rebuilt from /api/show; equal to the server on 179 of 179 measured texts); the server reports the count + ${PROMPT_COUNT_RULE.templateTokens} template tokens, cached or not; a shortfall over ${Math.round(PROMPT_COUNT_RULE.tolerance * 100)} % marks the run as a context truncation.`,
  environment: "Per pair: preload, snapshot, run 1, snapshot, run 2, snapshot (nvidia-smi, /api/ps, /api/version); normal = model fully in GPU memory, context 8192, digest and version as recorded; an abnormal snapshot re-executes the pair with the same seeds.",
  gates: [
    { gate: "G1 delivery", result: "scripted probe byte-identical to the reference simulation for all 50 instances × 2 topologies; every run log passes the reference validator and the schema" },
    { gate: "G2 budget", result: "0 truncations, 0 thinking overflows, 0 truncated messages, 0 regenerations of 360 discussion calls; peak prompt + output 3039 of 7992" },
    { gate: "G3 oracle", result: "30 of 30 correct (Operations with every role card)" },
    { gate: "G4 public-only", result: "3 of 30 correct = 10 % in each of 3 replicates (Operations with the public rules only); under every class ceiling" },
    { gate: "G5 schema", result: "0 schema failures in 80 final answers" },
    { gate: "G6 determinism", result: "36 of 36 repeated calls byte-identical in content and thinking, cold and warm cache, under normal snapshots" },
  ],
  detector: "Exposure detector (Exposure & Instance Metadata v1.4): an LLM parses each message into a closed schema (statement spans, polarity, objects, hedges — never attribution or truth); deterministic code attributes every statement to a role, expands it into base facts, and decides truth, source (own / relayed / inferred / unsourced), grounding and support by enumeration over the 1024 public states. Operations' exposure per fact and the decision-support category follow from that.",
};
