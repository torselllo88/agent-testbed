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
export const DETECTOR_VERSION = "1";

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
  /** null: the detector gave no usable answer for this message. */
  labels: Record<string, { label: ExposureLabel; evidence: string | null }> | null;
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

export function renderDetectorPrompt(facts: TaskFact[], message: { senderName: string; senderRole: string; text: string }): ChatMessage[] {
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
        `MESSAGE from ${message.senderName} (${message.senderRole}):\n"""\n${message.text}\n"""`,
        [
          "Give EVERY proposition exactly one label:",
          '- "correct": the message asserts the proposition or something that clearly implies it. Paraphrases, summaries, the same fact in other words, and passing on what someone else said all count.',
          '- "incorrect": the message asserts something that contradicts the proposition — a different value, status, limit, or the opposite.',
          '- "absent": the message asserts nothing about it — including only asking about it, or naming the subject without stating the fact.',
          '"evidence": the shortest quote from the message that supports a "correct" or "incorrect" label; null for "absent".',
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
}

export class ExposureDetectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExposureDetectionError";
  }
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
  const agents = new Map(config.agents.map((a) => [a.id, a]));
  const posted = agentMessages(events);
  const messages: LabeledMessage[] = [];
  for (const [i, m] of posted.entries()) {
    const agent = agents.get(m.senderId);
    const call = await labelMessage(provider, model, facts, { senderName: agent?.name ?? m.senderId, senderRole: agent?.role ?? "", text: m.text }, options);
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
  message: { senderName: string; senderRole: string; text: string },
  options: DetectOptions
): Promise<{ labels: LabeledMessage["labels"]; call: DetectorCall }> {
  const schema = labelsSchema(facts);
  const started = Date.now();
  const prompt = renderDetectorPrompt(facts, message);
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
          context: { purpose: "exposure_detection", factIds: facts.map((f) => f.id), messageText: message.text },
        });
        last = { rawText: result.text, usage: result.usage, servedModel: result.servedModel };
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
        Object.entries(parsed.value.labels).map(([id, v]) => [id, { label: v.label, evidence: v.label === "absent" ? null : (v.evidence ?? null) }])
      );
      return { labels, call: { ok: true, attempts, ...last, durationMs: Date.now() - started } };
    }
    error = parsed.error;
    messages = [...prompt, { role: "assistant", content: text ?? "" }, { role: "user", content: `That answer could not be used (${parsed.error}). Respond again with ONLY the JSON object, labeling every proposition.` }];
  }
  return { labels: null, call: { ok: false, error, attempts, ...last, durationMs: Date.now() - started } };
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
    proposer,
    proposerFacts: count("fact"),
    proposerDerived: count("derived"),
    solutionRelay: solution ? proposer[solution.id]!.class : null,
    byAgent: Object.fromEntries(config.agents.map((a) => [a.id, Object.fromEntries(Object.entries(exposureOf(a.id)).map(([id, e]) => [id, e.class]))])),
  };
}
