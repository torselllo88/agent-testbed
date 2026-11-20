import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExperimentEvent } from "../../experiment/events.js";
import type { ExperimentRecord } from "../../persistence/experimentRepository.js";
import { BUNDLE_DIR, PROMPT_COUNT_RULE, promptCountShortfall } from "./adapter.js";
import { PilotParamsSchema } from "./evaluator.js";
import { AGENTS, classify, evaluate, ROLE_OF_ID, stateHash, type Proposal, type RoleName } from "./task.js";

/**
 * One run of the pilot as the bundle's schemas/run_log.schema.json describes
 * it, built from the testbed's trace (the experiment record and its events)
 * — the file the bundle's tools/validate_run_log.py checks, and the detector
 * and the analysis read. Everything in it is derived from the trace; nothing
 * is measured again. Thinking text never enters the log: each attempt
 * carries its sha256 and length, and the texts go to a separate file.
 *
 * Beyond the schema: `replicate` (config.protocol.replicate — the run log
 * schema has no field for it yet; proposed to the authors) and `testbed`
 * (experiment id, config hash, protocol fingerprint) for the way back to
 * the trace.
 */

export type SnapshotMoment = "before_pair" | "between_runs" | "after_pair";

export interface EnvironmentSnapshot {
  when: SnapshotMoment;
  taken_at: string;
  ollama_version: string;
  ollama_ps: Record<string, unknown>;
  nvidia_smi: string;
  normal: boolean;
  deviation: string | null;
}

export interface RunLogOptions {
  /** The pair's snapshots (the pair runner); omitted: none — or, for a run served by the stub provider, a record saying so. */
  snapshots?: EnvironmentSnapshot[];
  preload?: Record<string, unknown>;
  /** 0 = first execution, 1 = the single permitted re-execution. */
  attempt?: number;
  /** Written into the log as `thinking_log` when any attempt had thinking. */
  thinkingLogPath?: string;
}

export interface RunLogExport {
  runLog: Record<string, unknown>;
  /** The thinking texts, per call and attempt — kept apart from the log. */
  thinking: Array<{ call_index: number; attempt_index: number; thinking: string }>;
}

type P = Record<string, unknown>;

/** The flag enums of run_log.schema.json (per call, and for the run's validity). */
const CALL_FLAGS = new Set(["over_length_regenerated", "over_length_truncated", "silent_turn_model_failure", "final_model_failure", "technical_retry", "extra_text"]);
const RUN_FLAGS = new Set(["silent_turn_model_failure", "over_length_regenerated", "over_length_truncated", "extra_text", "final_model_failure"]);

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const roleOf = (id: string | null | undefined): RoleName | string => (id ? (ROLE_OF_ID[id] ?? id) : "");
const ms2ns = (ms: unknown) => (typeof ms === "number" ? Math.round(ms * 1_000_000) : null);

/** The frozen bundle files the log is tied to (plan: config, prompts, render_prompts.py, settlement_task.py). */
export function bundleFileHashes(): Record<string, string> {
  const files = [
    "config/pilot_config.yaml",
    "tools/render_prompts.py",
    "tools/settlement_task.py",
    "tools/seeds.py",
    ...fs
      .readdirSync(path.join(BUNDLE_DIR, "prompts"))
      .filter((f) => f.endsWith(".txt"))
      .sort()
      .map((f) => `prompts/${f}`),
  ];
  return Object.fromEntries(files.map((f) => [f, sha256(fs.readFileSync(path.join(BUNDLE_DIR, f), "utf8"))]));
}

let configVersion: string | null = null;
export function bundleConfigVersion(): string {
  if (configVersion === null) {
    const yaml = fs.readFileSync(path.join(BUNDLE_DIR, "config", "pilot_config.yaml"), "utf8");
    configVersion = /^\s*config_version:\s*"?([^"\n]+)"?\s*$/m.exec(yaml)?.[1]?.trim() ?? "unknown";
  }
  return configVersion;
}

/** Snapshots for a run no model server took part in (stub provider): a record that there was nothing to observe. */
export function stubSnapshots(at: string): EnvironmentSnapshot[] {
  return (["before_pair", "between_runs", "after_pair"] as const).map((when) => ({
    when,
    taken_at: at,
    ollama_version: "stub",
    ollama_ps: { models: [] },
    nvidia_smi: "(stub provider: no model server, no GPU)",
    normal: true,
    deviation: null,
  }));
}

interface Attempt {
  attempt_index: number;
  kind: "initial" | "technical_retry" | "length_regeneration";
  seed: number | null;
  user_text_sha256: string;
  error: string | null;
  content: string | null;
  thinking_sha256: string | null;
  thinking_chars: number | null;
  done_reason: string | null;
  prompt_eval_count: number | null;
  prompt_eval_cached_count: number | null;
  eval_count: number | null;
  content_tokens: number | null;
  thinking_tokens: number | null;
  total_duration_ns: number | null;
  load_duration_ns: number | null;
  accepted: boolean;
  model_failure: boolean;
  /** Not in the schema: the thinking text, moved out before the log is written. */
  _thinking?: string;
}

function attemptOf(call: P, index: number): Attempt {
  const messages = (call.messages as Array<{ role: string; content: string }>) ?? [];
  const user = messages.find((m) => m.role === "user")?.content ?? "";
  const meta = (call.providerMeta ?? {}) as P;
  const usage = call.usage as { promptTokens: number; completionTokens: number } | null;
  const durations = (meta.durationsMs ?? {}) as P;
  const error = call.error as { message: string } | undefined;
  const thinking = typeof meta.thinking === "string" ? meta.thinking : null;
  const attemptKind = call.attemptKind === "length_regeneration" ? "length_regeneration" : "initial";
  const kind = typeof call.providerAttempt === "number" && call.providerAttempt > 0 ? "technical_retry" : attemptKind;
  return {
    attempt_index: index,
    kind,
    seed: typeof call.seed === "number" ? call.seed : null,
    user_text_sha256: sha256(user),
    error: error ? error.message : null,
    content: error ? null : ((call.responseText as string | undefined) ?? null),
    thinking_sha256: thinking ? sha256(thinking) : null,
    thinking_chars: thinking ? thinking.length : null,
    done_reason: (call.finishReason as string | null | undefined) ?? null,
    prompt_eval_count: usage?.promptTokens ?? null,
    prompt_eval_cached_count: null,
    eval_count: usage?.completionTokens ?? null,
    content_tokens: null,
    thinking_tokens: null,
    total_duration_ns: ms2ns(durations.total),
    load_duration_ns: ms2ns(durations.load),
    accepted: false,
    model_failure: false,
    ...(thinking ? { _thinking: thinking } : {}),
  };
}

export function buildRunLog(record: ExperimentRecord, events: ExperimentEvent[], options: RunLogOptions = {}): RunLogExport {
  const { config } = record;
  if (!config.protocol || config.protocol.adapter !== "pilot-settlement") throw new Error(`run ${record.id} did not use the pilot-settlement protocol adapter`);
  const params = PilotParamsSchema.parse(config.evaluator.params);
  const protocolParams = config.protocol.params as { instanceId?: string; ringPositions?: string[]; speakingOrder?: string[] };
  const control = config.protocol.control ?? null;
  const started = events.find((e) => e.type === "experiment_started")?.payload ?? {};
  const layout = (started.layout ?? {}) as { topology?: string; speakingOrder?: string[] | null; neighbours?: Record<string, string[]> | null };
  const finished = events.find((e) => e.type === "experiment_finished")?.payload ?? {};
  const termination = (finished.termination ?? {}) as { outcome?: string; category?: string; reason?: string; detail?: P };
  const agentIds = config.agents.map((a) => a.id);
  const isProbe = config.agents.every((a) => a.model.provider === "stub" && a.model.model === "pilot-settlement/probe");
  const isStub = config.agents.every((a) => a.model.provider === "stub");
  // A control call is what it is whatever answers it; "probe" is the scripted discussion run of gate G1.
  const condition = control === "oracle" ? "oracle" : control === "public_only" ? "public_only" : isProbe ? "probe" : "discussion";
  const topology = control ? "none" : layout.topology === "ring" ? "ring" : "complete";
  const n = agentIds.length;

  const recipientsOf = (id: string): string[] => (layout.neighbours ? (layout.neighbours[id] ?? []) : agentIds.filter((x) => x !== id)).map((x) => roleOf(x) as string);

  // Group the trace by global turn.
  const turns: Array<{ turn: number; kind: string; agentId: string; calls: P[]; message: P | null; completed: P | null; meta: P | null }> = [];
  for (const e of events) {
    const p = e.payload;
    switch (e.type) {
      case "turn_started":
        turns.push({ turn: p.turn as number, kind: String(p.kind), agentId: e.agentId ?? "", calls: [], message: null, completed: null, meta: null });
        break;
      case "llm_call": {
        const t = turns.find((x) => x.turn === p.turn);
        if (t) t.calls.push(p);
        break;
      }
      case "message_posted": {
        const sender = p.sender as { kind: string; agentId?: string };
        const current = turns.at(-1);
        if (sender.kind === "agent" && current && current.agentId === sender.agentId && !current.completed) current.message = p;
        break;
      }
      case "agent_meta": {
        const t = turns.find((x) => x.turn === p.turn);
        if (t) t.meta = p;
        break;
      }
      case "turn_completed": {
        const t = turns.find((x) => x.turn === p.turn);
        if (t) t.completed = p;
        break;
      }
    }
  }

  const thinking: RunLogExport["thinking"] = [];
  const calls: P[] = [];
  const delivered: Array<{ turn: number; speaker: string; recipients: string[] }> = [];
  const allFlags = new Set<string>();
  let discussionIndex = 0;
  for (const t of turns) {
    if (t.kind !== "discussion" && t.kind !== "proposal") continue;
    const speakerRole = roleOf(t.agentId) as string;
    const initial = t.calls[0];
    const messages = (initial?.messages as Array<{ role: string; content: string }>) ?? [];
    const attempts = t.calls.map((c, i) => attemptOf(c, i));
    const flags = new Set<string>(Array.isArray(t.completed?.flags) ? (t.completed!.flags as string[]).filter((f) => CALL_FLAGS.has(f)) : []);
    if (attempts.some((a) => a.kind === "technical_retry")) flags.add("technical_retry");
    const callIndex = calls.length;
    for (const a of attempts) {
      if (a._thinking !== undefined) {
        thinking.push({ call_index: callIndex, attempt_index: a.attempt_index, thinking: a._thinking });
        delete a._thinking;
      }
    }
    const lastOk = [...attempts].reverse().find((a) => a.error === null);
    const base = {
      call_index: callIndex,
      speaker: speakerRole,
      system_text: messages.find((m) => m.role === "system")?.content ?? "",
      user_text: messages.find((m) => m.role === "user")?.content ?? "",
      prompt_tokens_counted: typeof initial?.promptTokensCounted === "number" ? initial.promptTokensCounted : -1,
      token_counter: (initial?.tokenCounter as string | null | undefined) ?? null,
      budget_ok: initial?.budgetOk !== false,
      attempts,
      seed: typeof initial?.seed === "number" ? initial.seed : null,
    };
    if (t.kind === "discussion") {
      const turn = ++discussionIndex;
      const visible = delivered.filter((d) => d.speaker === speakerRole || d.recipients.includes(speakerRole)).map((d) => d.turn);
      const text = t.message ? String(t.message.text) : null;
      if (lastOk) {
        lastOk.accepted = text !== null;
        lastOk.model_failure = text === null;
      }
      const recipients = recipientsOf(t.agentId);
      if (text !== null) delivered.push({ turn, speaker: speakerRole, recipients });
      for (const f of flags) allFlags.add(f);
      calls.push({
        ...base,
        call_type: "discussion",
        turn,
        round: Math.floor((turn - 1) / n) + 1,
        position_in_round: ((turn - 1) % n) + 1,
        recipients,
        visible_history_turns: visible,
        accepted_text: text,
        visible_tokens: typeof t.meta?.visibleTokens === "number" ? t.meta.visibleTokens : null,
        flags: [...flags],
      });
    } else {
      const visible = delivered.filter((d) => d.speaker === "Operations" || d.recipients.includes("Operations")).map((d) => d.turn);
      const result = String(t.completed?.result ?? "");
      if (lastOk) {
        lastOk.accepted = result === "frozen";
        lastOk.model_failure = result === "model_failure";
      }
      if (result === "model_failure") flags.add("final_model_failure");
      for (const f of flags) allFlags.add(f);
      calls.push({
        ...base,
        call_type: control === "oracle" ? "oracle" : control === "public_only" ? "public_only" : "final",
        turn: null,
        round: null,
        position_in_round: null,
        recipients: [],
        visible_history_turns: visible,
        accepted_text: null,
        visible_tokens: null,
        flags: [...flags],
      });
    }
  }

  // The final proposal and its judgement.
  const frozen = events.find((e) => e.type === "proposal_frozen")?.payload;
  const rejected = events.find((e) => e.type === "proposal_rejected_format")?.payload;
  const evaluation = events.find((e) => e.type === "evaluation_result")?.payload as { classification?: string; derived?: { fieldCorrect?: Record<string, boolean> } } | undefined;
  const finalTurn = turns.find((t) => t.kind === "proposal");
  const finalCall = finalTurn?.calls.at(-1);
  const canonical = evaluate(params.state);
  const parsed = (frozen?.body as Proposal | undefined) ?? null;
  const fieldCorrect = evaluation?.derived?.fieldCorrect ?? { action: false, destination: false, rail: false, reason: false };
  const finalModelFailure = rejected?.kind === "model_failure";
  const final = {
    raw_content: finalCall && !finalCall.error ? ((finalCall.responseText as string | undefined) ?? null) : null,
    parsed,
    schema_valid: parsed !== null,
    extra_text: frozen?.extraText === true || rejected?.extraText === true,
    canonical,
    correct_exact: evaluation?.classification === "correct",
    field_correct: fieldCorrect,
    final_model_failure: finalModelFailure,
  };
  if (final.extra_text) allFlags.add("extra_text");
  if (finalModelFailure) allFlags.add("final_model_failure");

  // Validity (plan §11), from the trace and the snapshots alone — never from the outcome.
  const snapshots = options.snapshots ?? (isStub ? stubSnapshots(record.finishedAt ?? record.startedAt ?? record.createdAt) : []);
  const allCalls = turns.flatMap((t) => t.calls);
  const overflow = allCalls.some((c) => ((c.providerMeta ?? {}) as P).contextOverflowSuspected === true);
  // The post-call check (§3.7): on an Ollama call counted with the tokenizer, prompt_eval_count must be the count plus the template's tokens, within the tolerance.
  const shortfall = allCalls.find((c) => {
    const meta = (c.providerMeta ?? {}) as P;
    const usage = c.usage as { promptTokens?: number } | null | undefined;
    return meta.api === "ollama" && c.tokenCounter === "tokenizer" && typeof c.promptTokensCounted === "number" && typeof usage?.promptTokens === "number" && promptCountShortfall(c.promptTokensCounted, usage.promptTokens);
  });
  const reload = calls.some((c) => (c.attempts as Attempt[]).some((a) => (a.load_duration_ns ?? 0) > 1_000_000_000));
  const abnormal = snapshots.some((s) => !s.normal);
  // The pair's preload must have answered done_reason "load" (plan §3.2); the pair runner records `ok`.
  const preloadFailed = options.preload?.ok === false;
  let status: "valid" | "technical_failure" | "environment_deviation" | "context_truncation" | "agent_system_failure";
  let detail: string;
  if (termination.outcome === "CONTEXT_BUDGET_VIOLATION" || shortfall || overflow) {
    status = "context_truncation";
    detail =
      termination.outcome === "CONTEXT_BUDGET_VIOLATION"
        ? String(termination.reason)
        : shortfall
          ? `prompt_eval_count ${(shortfall.usage as { promptTokens: number }).promptTokens} below the counted prompt (${shortfall.promptTokensCounted as number} + ${PROMPT_COUNT_RULE.templateTokens} template tokens) on the ${String(shortfall.purpose ?? "")} call at turn ${String(shortfall.turn ?? "?")}: context truncation (prompt_count_rule)`
          : "context overflow suspected on a call (prompt tokens below the prompt's length)";
  } else if (termination.category === "infrastructure" || termination.category === "operator" || termination.category === "budget" || termination.category === "coordination") {
    // A budget limit or a run without a proposal cannot happen under the plan's config: the run was not carried out as planned.
    status = "technical_failure";
    detail = `${termination.outcome}: ${termination.reason}`;
  } else if (abnormal || reload || preloadFailed) {
    status = "environment_deviation";
    detail = abnormal
      ? (snapshots.find((s) => !s.normal)?.deviation ?? "abnormal environment snapshot")
      : reload
        ? "model reloaded mid-run (load_duration > 1 s)"
        : "the pair's preload did not answer done_reason \"load\"";
  } else {
    status = "valid";
    detail = `${termination.outcome ?? "unknown"}: ${termination.reason ?? ""}`.trim();
  }

  const firstCall = allCalls.find((c) => !c.error);
  const model = config.agents[0]!.model;
  const serving = ((firstCall?.providerMeta ?? {}) as P).serving as { digest?: string } | null | undefined;
  const replicate = config.protocol.replicate;
  const suffix = control ? (control === "oracle" ? "ORACLE" : "PUBLIC_ONLY") : topology.toUpperCase();
  // The probe is its own kind of run: its logs never stand in for a model's.
  const runId = `${params.instanceId}-${suffix}${replicate ? `-rep${replicate}` : ""}${condition === "probe" ? "-PROBE" : ""}`;
  const testbed = record.testbedVersion;

  const runLog: P = {
    run_id: runId,
    instance_id: params.instanceId,
    state_hash: stateHash(params.state),
    class: classify(params.state).cls,
    subtype: classify(params.state).subtype,
    condition,
    topology,
    config_version: bundleConfigVersion(),
    replicate,
    software: {
      testbed_commit: testbed.gitCommit ? `${testbed.gitCommit}${testbed.gitDirty ? "-dirty" : ""}` : "unknown",
      file_hashes: bundleFileHashes(),
      ollama_version: snapshots[0]?.ollama_version ?? (isStub ? "stub" : "unknown"),
    },
    model: {
      name: (firstCall?.requestedModel as string | undefined) ?? model.model,
      digest: serving?.digest ?? (isStub ? "stub" : "unknown"),
    },
    generation: {
      think: model.think ?? false,
      options: {
        num_ctx: model.contextLength ?? null,
        temperature: model.temperature ?? null,
        top_p: model.sampling?.topP ?? null,
        top_k: model.sampling?.topK ?? null,
        min_p: model.sampling?.minP ?? null,
        presence_penalty: model.sampling?.presencePenalty ?? null,
        repeat_penalty: model.sampling?.repeatPenalty ?? null,
        seed: "per call (tools/seeds.py)",
      },
      num_predict: { discussion: model.maxOutputTokens ?? null, final: model.maxOutputTokens ?? null },
      keep_alive: model.keepAlive ?? null,
    },
    // The protocol's K (the schema fixes it at 3); a control call has no discussion of its own.
    K: 3,
    discussion_rounds: config.discussion?.fixedRounds ?? 0,
    speaking_order: (protocolParams.speakingOrder ?? layout.speakingOrder?.map((id) => roleOf(id)) ?? [...AGENTS]) as string[],
    ring_positions: protocolParams.ringPositions ?? [...AGENTS],
    attempt: options.attempt ?? 0,
    started_at: record.startedAt ?? record.createdAt,
    finished_at: record.finishedAt ?? null,
    calls,
    final,
    validity: { status, detail, flags: [...allFlags].filter((f) => RUN_FLAGS.has(f)) },
    ...(thinking.length && options.thinkingLogPath ? { thinking_log: options.thinkingLogPath } : {}),
    environment_snapshots: snapshots,
    ...(options.preload ? { preload: options.preload } : {}),
    testbed: {
      experiment_id: record.id,
      batch_id: record.batchId,
      condition_key: record.conditionKey,
      repetition: record.repetition,
      config_hash: record.configHash,
      task_definition_hash: record.taskDefinitionHash,
      protocol_fingerprint: (started.protocolFingerprint as string | undefined) ?? null,
      outcome: record.outcome,
      status: record.status,
    },
  };
  return { runLog, thinking };
}

/** Writes `<run_id>.json` (and `<run_id>.thinking.json` when there is thinking) into outDir; returns the log's path. */
export function writeRunLog(record: ExperimentRecord, events: ExperimentEvent[], outDir: string, options: RunLogOptions = {}): { path: string; runLog: Record<string, unknown> } {
  fs.mkdirSync(outDir, { recursive: true });
  const probe = buildRunLog(record, events);
  const runId = String(probe.runLog.run_id);
  const thinkingPath = path.join(outDir, `${runId}.thinking.json`);
  const { runLog, thinking } = buildRunLog(record, events, { ...options, thinkingLogPath: thinking_rel(outDir, thinkingPath) });
  const file = path.join(outDir, `${runId}.json`);
  fs.writeFileSync(file, JSON.stringify(runLog, null, 1), "utf8");
  if (thinking.length) fs.writeFileSync(thinkingPath, JSON.stringify({ run_id: runId, thinking }, null, 1), "utf8");
  return { path: file, runLog };
}

const thinking_rel = (outDir: string, file: string) => path.relative(outDir, file).split(path.sep).join("/");
