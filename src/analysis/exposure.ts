import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { EvaluatorRegistry } from "../evaluation/registry.js";
import type { TaskFact } from "../evaluation/types.js";
import { canonicalJson, ModelRefSchema, modelProviderKey, sha256, type ExperimentConfig, type ModelRef } from "../experiment/config.js";
import { EventType, type ExperimentEvent } from "../experiment/events.js";
import { parseWithSchema } from "../experiment/parseJson.js";
import type { ChatMessage, ProviderId, TokenUsage } from "../llm/provider.js";
import { ProviderError } from "../llm/provider.js";
import type { ProviderRegistry } from "../llm/registry.js";
import type { Db } from "../persistence/db.js";
import { EventRepository } from "../persistence/eventRepository.js";
import { ExposureRepository, type ExposureDetectionRecord } from "../persistence/exposureRepository.js";

/**
 * Exposure detection — Level 2 of the topology measurements: WHAT reached
 * whom, not only who talked to whom.
 *
 * An analysis pass over a finished run, never part of it (agents never see
 * it; it cannot change an outcome; it can be re-run with another model or
 * detector version). The scenario's evaluator supplies a closed list of
 * propositions that are TRUE for the instance (ScenarioEvaluator.facts). An
 * LLM labels every agent message against every proposition:
 *
 *   correct    the message asserts it, or something that implies it (paraphrase, summary, relay)
 *   incorrect  the message asserts something that contradicts it
 *   absent     the message asserts nothing about it (asking about it is absent)
 *
 * The labels are then combined with who received each message (the trace's
 * audiences) up to the decision horizon — the first proposal request — into
 * every agent's exposure per proposition:
 *
 *   absent       nothing about it reached the agent
 *   correct      only correct mentions reached it
 *   distorted    only incorrect mentions reached it
 *   conflicting  both reached it
 *   own          it is the agent's own private fact
 *
 * The proposer's exposure is the pilot's mechanism measure; the "solution"
 * proposition is solution relay. Validity of derived propositions (did the
 * sender have the premises?) is left to analysis: the labels say what was
 * asserted, the trace says what the sender had seen.
 */

/** Bump whenever the prompt, the label rules or the aggregation change. */
export const DETECTOR_VERSION = "2";

export const EXPOSURE_LABELS = ["absent", "correct", "incorrect"] as const;
export type ExposureLabel = (typeof EXPOSURE_LABELS)[number];
export type ExposureClass = "absent" | "correct" | "distorted" | "conflicting" | "own";

export interface LabeledMessage {
  messageId: string;
  seq: number;
  /** Position in the whole transcript. */
  index: number;
  /** The global turn the message was posted in. */
  turn: number | null;
  senderId: string;
  /** Who received it (null: everyone). */
  audience: string[] | null;
  /** Posted before the first proposal request — inside the decision horizon. */
  beforeProposal: boolean;
  text: string;
  /**
   * null: the detector gave no usable answer for this message. A "correct" or
   * "incorrect" whose quoted evidence is not in the message is kept as
   * "absent", with the claimed label in `unverified` (a guess, not a reading).
   */
  labels: Record<string, { label: ExposureLabel; evidence: string | null; unverified?: Exclude<ExposureLabel, "absent"> }> | null;
  call: DetectorCall;
}

export interface DetectorCall {
  ok: boolean;
  error?: string;
  attempts: number;
  rawText: string | null;
  usage: TokenUsage | null;
  servedModel: string | null;
  durationMs: number;
}

export interface FactExposure {
  class: ExposureClass;
  /** The first message that brought a correct mention: its turn and sender. */
  firstCorrectTurn: number | null;
  firstCorrectFrom: string | null;
}

export interface ExposureSummary {
  proposerId: string;
  /** Messages labeled / not labeled (detector failures) — unlabeled ones count as saying nothing. */
  labeledMessages: number;
  unlabeledMessages: number;
  /** Every message inside the horizon was labeled: only then is the proposer's exposure a measurement, not a lower bound. */
  complete: boolean;
  /** Labels the detector claimed with evidence that is not in the message — counted as absent. */
  unverifiedLabels: number;
  /** The proposer's exposure at the decision horizon, per proposition. */
  proposer: Record<string, FactExposure>;
  /** Over the other agents' private facts (kind "fact", not the proposer's own). */
  proposerFacts: Record<Exclude<ExposureClass, "own">, number> & { total: number };
  /** Over derived propositions. */
  proposerDerived: Record<Exclude<ExposureClass, "own">, number> & { total: number };
  /** The solution proposition's class for the proposer (solution relay); null without one. */
  solutionRelay: ExposureClass | null;
  /** Every agent's exposure at the horizon: agentId -> factId -> class. */
  byAgent: Record<string, Record<string, ExposureClass>>;
}

export interface ExposureResult {
  detectorVersion: string;
  facts: TaskFact[];
  messages: LabeledMessage[];
  summary: ExposureSummary;
}

export function factsHash(facts: TaskFact[]): string {
  return sha256(canonicalJson(facts)).slice(0, 16);
}

// ------------------------------------------------------------------ prompt

function labelsSchema(facts: TaskFact[]) {
  const entry = z.object({ label: z.enum(EXPOSURE_LABELS), evidence: z.string().nullable().default(null) });
  return z.object({ labels: z.object(Object.fromEntries(facts.map((f) => [f.id, entry]))) });
}

/** Built by hand: proposition ids are free strings (dots, dashes), every one required. */
function labelsJsonSchema(facts: TaskFact[]): Record<string, unknown> {
  const entry = {
    type: "object",
    properties: { label: { type: "string", enum: [...EXPOSURE_LABELS] }, evidence: { type: ["string", "null"] } },
    required: ["label", "evidence"],
    additionalProperties: false,
  };
  return {
    type: "object",
    properties: {
      labels: { type: "object", properties: Object.fromEntries(facts.map((f) => [f.id, entry])), required: facts.map((f) => f.id), additionalProperties: false },
    },
    required: ["labels"],
    additionalProperties: false,
  };
}

/**
 * The detector sees the propositions and the message — not who wrote it: a
 * label must not depend on whether the holder of a fact or a relay says it
 * (in a ring, facts reach the proposer through others far more often).
 */
export function renderDetectorPrompt(facts: TaskFact[], text: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You label what ONE message from a discussion asserts about a fixed list of propositions. Every proposition is true. You do not judge whether the message is right in reality — only what it asserts, compared with each proposition.",
    },
    {
      role: "user",
      content: [
        `PROPOSITIONS:\n${facts.map((f) => `- [${f.id}] ${f.statement}`).join("\n")}`,
        `MESSAGE from a participant:\n"""\n${text}\n"""`,
        [
          "Give EVERY proposition exactly one label:",
          '- "correct": the message asserts the proposition or something that clearly implies it. Paraphrases, summaries, the same fact in other words, and passing on what someone else said all count.',
          '- "incorrect": the message asserts something that contradicts the proposition — a different value, status, limit, or the opposite.',
          '- "absent": the message asserts nothing about it — including only asking about it, or naming the subject without stating the fact.',
          '"evidence": an EXACT, contiguous quote from the message that supports a "correct" or "incorrect" label — copied word for word, at least two words, no "…"; null for "absent". A label whose quote is not in the message is not counted.',
        ].join("\n"),
        `Respond with ONLY a single JSON object matching this JSON Schema — no other text:\n${JSON.stringify(labelsJsonSchema(facts))}`,
      ].join("\n\n"),
    },
  ];
}

// ------------------------------------------------------------------ detection

export interface DetectOptions {
  /** Provider retries per message (transient errors). */
  maxProviderRetries?: number;
  /** Extra attempts after an unusable answer. */
  maxParseRetries?: number;
  retryDelayMs?: number;
  signal?: AbortSignal;
  onMessage?: (done: number, total: number) => void;
  /** Awaited before every request to the model (e.g. to wait while experiments use the same server). */
  gate?: () => Promise<void>;
}

export class ExposureDetectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExposureDetectionError";
  }
}

export class ExposureCancelledError extends Error {
  constructor() {
    super("labeling was cancelled");
    this.name = "ExposureCancelledError";
  }
}

export interface LabelRunsResult {
  labeled: number;
  /** Already labeled with this detector version, model and fact list (and force was off). */
  skipped: number;
  /** Runs that could not be labeled at all (no fact list, not finished, …). */
  failed: Array<{ runId: string; error: string }>;
  cancelled: boolean;
}

/**
 * Labels many runs, one after another — the CLI's "label" and the web UI's
 * labeling job. Skips finished passes with the same detector version, model
 * and fact list unless forced, so it can always be resumed by running it
 * again (e.g. after a restart).
 */
export async function labelRuns(
  deps: { db: Db; providers: ProviderRegistry; evaluators: EvaluatorRegistry },
  runIds: string[],
  rawModel: unknown,
  options: DetectOptions & { force?: boolean; onRunStart?: (index: number, total: number, runId: string) => void; onRun?: (index: number, total: number, runId: string, outcome: "labeled" | "skipped" | "failed", detail?: string) => void } = {}
): Promise<LabelRunsResult> {
  const model = ModelRefSchema.parse(rawModel);
  const repo = new ExposureRepository(deps.db);
  const result: LabelRunsResult = { labeled: 0, skipped: 0, failed: [], cancelled: false };
  for (const [i, runId] of runIds.entries()) {
    if (options.signal?.aborted) {
      result.cancelled = true;
      break;
    }
    options.onRunStart?.(i, runIds.length, runId);
    try {
      const started = new EventRepository(deps.db).list(runId).find((e) => e.type === EventType.EXPERIMENT_STARTED);
      if (!started) throw new ExposureDetectionError(`run ${runId} has no trace`);
      const hash = factsHash(factsOf(deps.evaluators, started.payload.config as ExperimentConfig));
      const done = repo.list(runId).some((d) => d.detectorVersion === DETECTOR_VERSION && d.factsHash === hash && canonicalJson(d.model) === canonicalJson(model));
      if (done && !options.force) {
        result.skipped += 1;
        options.onRun?.(i, runIds.length, runId, "skipped");
        continue;
      }
      await detectRun(deps, runId, model, options);
      result.labeled += 1;
      options.onRun?.(i, runIds.length, runId, "labeled");
    } catch (err) {
      if (err instanceof ExposureCancelledError) {
        result.cancelled = true;
        break;
      }
      const error = err instanceof Error ? err.message : String(err);
      result.failed.push({ runId, error });
      options.onRun?.(i, runIds.length, runId, "failed", error);
    }
  }
  return result;
}

/** Labels every agent message of a finished run and stores the pass. */
export async function detectRun(
  deps: { db: Db; providers: ProviderRegistry; evaluators: EvaluatorRegistry },
  experimentId: string,
  rawModel: unknown,
  options: DetectOptions = {}
): Promise<ExposureDetectionRecord> {
  const model = ModelRefSchema.parse(rawModel);
  const events = new EventRepository(deps.db).list(experimentId);
  const started = events.find((e) => e.type === EventType.EXPERIMENT_STARTED);
  if (!started) throw new ExposureDetectionError(`run ${experimentId} has no trace`);
  if (!events.some((e) => e.type === EventType.EXPERIMENT_FINISHED)) throw new ExposureDetectionError(`run ${experimentId} has not finished`);
  const config = started.payload.config as ExperimentConfig;
  const facts = factsOf(deps.evaluators, config);

  const provider = deps.providers.get(modelProviderKey(model) as ProviderId);
  const posted = agentMessages(events);
  const messages: LabeledMessage[] = [];
  for (const [i, m] of posted.entries()) {
    // Cancelled: nothing is stored — a partial pass would look like a run where little reached anyone.
    if (options.signal?.aborted) throw new ExposureCancelledError();
    const call = await labelMessage(provider, model, facts, m.text, options);
    messages.push({ ...m, labels: call.labels, call: call.call });
    options.onMessage?.(i + 1, posted.length);
  }
  const result: ExposureResult = { detectorVersion: DETECTOR_VERSION, facts, messages, summary: summarizeExposure(config, facts, messages) };
  const record: ExposureDetectionRecord = {
    id: randomUUID(),
    experimentId,
    createdAt: new Date().toISOString(),
    detectorVersion: DETECTOR_VERSION,
    model: model as unknown as Record<string, unknown>,
    factsHash: factsHash(facts),
    result,
  };
  new ExposureRepository(deps.db).save(record);
  return record;
}

export function factsOf(evaluators: EvaluatorRegistry, config: ExperimentConfig): TaskFact[] {
  const evaluator = evaluators.get(config.evaluator.id);
  if (!evaluator.facts) throw new ExposureDetectionError(`the evaluator "${evaluator.id}" defines no fact list — exposure cannot be measured for this scenario`);
  const facts = evaluator.facts(evaluator.paramsSchema.parse(config.evaluator.params));
  const ids = facts.map((f) => f.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) throw new ExposureDetectionError(`the fact list has "${duplicate}" twice`);
  return facts;
}

/** Every agent message of the run, with its audience, turn and whether it is inside the decision horizon. */
function agentMessages(events: ExperimentEvent[]): Array<Omit<LabeledMessage, "labels" | "call">> {
  const horizon = events.find((e) => e.type === EventType.PROPOSAL_REQUESTED)?.seq ?? Infinity;
  let turn: number | null = null;
  const out: Array<Omit<LabeledMessage, "labels" | "call">> = [];
  for (const e of events) {
    if (e.type === EventType.TURN_STARTED) turn = Number(e.payload.turn);
    if (e.type !== EventType.MESSAGE_POSTED) continue;
    const sender = e.payload.sender as { kind: string; agentId?: string };
    if (sender.kind !== "agent" || !sender.agentId) continue;
    out.push({
      messageId: String(e.payload.messageId),
      seq: e.seq,
      index: Number(e.payload.index),
      turn,
      senderId: sender.agentId,
      audience: Array.isArray(e.payload.audience) ? (e.payload.audience as string[]) : null,
      beforeProposal: e.seq < horizon,
      text: String(e.payload.text),
    });
  }
  return out;
}

async function labelMessage(
  provider: ReturnType<ProviderRegistry["get"]>,
  model: ModelRef,
  facts: TaskFact[],
  messageText: string,
  options: DetectOptions
): Promise<{ labels: LabeledMessage["labels"]; call: DetectorCall }> {
  const schema = labelsSchema(facts);
  const started = Date.now();
  const prompt = renderDetectorPrompt(facts, messageText);
  const maxParse = options.maxParseRetries ?? 1;
  const maxProvider = options.maxProviderRetries ?? 2;
  let attempts = 0;
  let last: Omit<DetectorCall, "ok" | "attempts" | "durationMs"> = { rawText: null, usage: null, servedModel: null };
  let error = "";
  let messages = prompt;
  for (let parseTry = 0; parseTry <= maxParse; parseTry++) {
    let text: string | null = null;
    for (let providerTry = 0; providerTry <= maxProvider; providerTry++) {
      attempts += 1;
      await options.gate?.();
      if (options.signal?.aborted) throw new ExposureCancelledError();
      try {
        const result = await provider.complete({
          model: model.model,
          messages,
          temperature: model.temperature,
          seed: model.seed,
          maxOutputTokens: model.maxOutputTokens,
          think: model.think,
          contextLength: model.contextLength,
          responseFormat: model.structuredOutput === "native" ? { name: "exposure_labels", schema: labelsJsonSchema(facts) } : undefined,
          signal: options.signal,
          context: { purpose: "exposure_detection", factIds: facts.map((f) => f.id), facts: facts.map((f) => ({ id: f.id, statement: f.statement })), messageText },
        });
        last = { rawText: result.text, usage: result.usage, servedModel: result.servedModel };
        // An answer cut at maxOutputTokens is not a label set — the longest, fact-densest messages would otherwise count as saying nothing.
        if (result.finishReason === "length") {
          return { labels: null, call: { ok: false, error: `the answer was cut at maxOutputTokens (${model.maxOutputTokens ?? "server default"}): raise it`, attempts, ...last, durationMs: Date.now() - started } };
        }
        text = result.text;
        break;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        const retryable = err instanceof ProviderError && err.retryable && !options.signal?.aborted;
        if (!retryable || providerTry === maxProvider) return { labels: null, call: { ok: false, error, attempts, ...last, durationMs: Date.now() - started } };
        await new Promise((r) => setTimeout(r, options.retryDelayMs ?? 2000));
      }
    }
    const parsed = parseWithSchema(text ?? "", schema);
    if (parsed.ok) {
      const labels = Object.fromEntries(
        Object.entries(parsed.value.labels).map(([id, v]) => {
          if (v.label === "absent") return [id, { label: "absent" as const, evidence: null }];
          // A claim needs its quote: an assertion the detector cannot point to in the text is a guess, and guesses
          // add up with the number of messages that reach the proposer (more in a complete graph).
          return evidenceInMessage(v.evidence, messageText)
            ? [id, { label: v.label, evidence: v.evidence }]
            : [id, { label: "absent" as const, evidence: v.evidence ?? null, unverified: v.label }];
        })
      );
      return { labels, call: { ok: true, attempts, ...last, durationMs: Date.now() - started } };
    }
    error = parsed.error;
    messages = [...prompt, { role: "assistant", content: text ?? "" }, { role: "user", content: `That answer could not be used (${parsed.error}). Respond again with ONLY the JSON object, labeling every proposition.` }];
  }
  return { labels: null, call: { ok: false, error, attempts, ...last, durationMs: Date.now() - started } };
}

/** Word tokens: letters and digits, with -.,/ inside ids and numbers (ACC-7720, 10,000, RAIL-X); formatting and punctuation dropped. */
export function evidenceTokens(text: string): string[] {
  const dashes = /[\u2010-\u2015\u2212]/g;
  return text.toLowerCase().replace(dashes, "-").match(/[\p{L}\p{N}]+(?:[-.,/][\p{L}\p{N}]+)*/gu) ?? [];
}

/**
 * Whether the detector's quote is really in the message: the quote's word
 * tokens must appear as one CONTIGUOUS run among the message's tokens, at
 * least two of them. Formatting does not matter (markdown, bullets, dash
 * variants, quote marks, case, line breaks); words do. "10,000" does not match
 * "100,000"; a quote stitched from pieces ("…") is not a quote. This catches
 * invented evidence — whether the message asserts rather than asks is still
 * the detector's call.
 */
export function evidenceInMessage(evidence: string | null | undefined, message: string): boolean {
  if (!evidence || /\.\.\.|…/.test(evidence)) return false;
  const quote = evidenceTokens(evidence);
  if (quote.length < 2) return false;
  const text = evidenceTokens(message);
  for (let i = 0; i + quote.length <= text.length; i++) {
    if (quote.every((t, j) => text[i + j] === t)) return true;
  }
  return false;
}

// ------------------------------------------------------------------ aggregation

/** Combines per-message labels with the audiences into every agent's exposure at the decision horizon. */
export function summarizeExposure(config: ExperimentConfig, facts: TaskFact[], messages: LabeledMessage[]): ExposureSummary {
  const proposerId = config.decision.proposerId;
  const inHorizon = messages.filter((m) => m.beforeProposal);
  const exposureOf = (agentId: string): Record<string, FactExposure> =>
    Object.fromEntries(
      facts.map((fact) => {
        if (fact.kind === "fact" && fact.source === agentId) return [fact.id, { class: "own", firstCorrectTurn: null, firstCorrectFrom: null }];
        const reaching = inHorizon.filter((m) => m.senderId !== agentId && (m.audience === null || m.audience.includes(agentId)) && m.labels);
        const correct = reaching.filter((m) => m.labels![fact.id]?.label === "correct");
        const incorrect = reaching.some((m) => m.labels![fact.id]?.label === "incorrect");
        const cls: ExposureClass = correct.length && incorrect ? "conflicting" : correct.length ? "correct" : incorrect ? "distorted" : "absent";
        return [fact.id, { class: cls, firstCorrectTurn: correct[0]?.turn ?? null, firstCorrectFrom: correct[0]?.senderId ?? null }];
      })
    );
  const proposer = exposureOf(proposerId);
  const count = (kind: TaskFact["kind"]) => {
    const relevant = facts.filter((f) => f.kind === kind && proposer[f.id]!.class !== "own");
    const tally = { total: relevant.length, absent: 0, correct: 0, distorted: 0, conflicting: 0 };
    for (const f of relevant) tally[proposer[f.id]!.class as Exclude<ExposureClass, "own">] += 1;
    return tally;
  };
  const solution = facts.find((f) => f.kind === "solution");
  return {
    proposerId,
    labeledMessages: messages.filter((m) => m.labels).length,
    unlabeledMessages: messages.filter((m) => !m.labels).length,
    complete: inHorizon.every((m) => m.labels),
    unverifiedLabels: messages.reduce((s, m) => s + Object.values(m.labels ?? {}).filter((l) => l.unverified).length, 0),
    proposer,
    proposerFacts: count("fact"),
    proposerDerived: count("derived"),
    solutionRelay: solution ? proposer[solution.id]!.class : null,
    byAgent: Object.fromEntries(config.agents.map((a) => [a.id, Object.fromEntries(Object.entries(exposureOf(a.id)).map(([id, e]) => [id, e.class]))])),
  };
}
