import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ExperimentConfig } from "../../experiment/config.js";
import type { AdapterCall, AdapterContext, AdapterLogEntry, ProposalDecision, ProtocolAdapter, RawAnswer, TurnDecision } from "../../experiment/protocolAdapter.js";
import { resolveLayout } from "../../experiment/topology.js";
import type { ChatMessage } from "../../llm/provider.js";
import { formatZodError } from "../../experiment/parseJson.js";
import { PilotParamsSchema, ProposalSchema } from "./evaluator.js";
import { bundleInstances } from "./family.js";
import { AGENT_ID, AGENTS, AMOUNT, DATA_ROLES, MILESTONE, ROLE_OF_ID, roleCard, stateHash, type RoleName, type SettlementState } from "./task.js";

/** The plan's generation settings (pilot_config.yaml, generation:) a real endpoint must be given; the budget guard needs the window and the cap. */
export const PILOT_GENERATION = {
  temperature: 1,
  maxOutputTokens: 2560,
  contextLength: 8192,
  keepAlive: "30m",
  sampling: { topP: 0.95, topK: 20, minP: 0, presencePenalty: 0, repeatPenalty: 1 },
} as const;

/**
 * The pilot's protocol (Plan §2, §3.5, §3.6): every model input rendered
 * from the bundle's templates, byte-identical to tools/render_prompts.py;
 * plain-text discussion messages with a visible-token cap, one regeneration
 * and a deterministic truncation; the final proposal parsed as the last JSON
 * object of the answer, with no format constraint; per-call seeds from
 * tools/seeds.py. The bundle is a frozen input: experiments/pilot-settlement/bundle.
 */

export const BUNDLE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "experiments", "pilot-settlement", "bundle");
export const MASTER_SEED = 20261120;
export const ADAPTER_ID = "pilot-settlement";
export const ADAPTER_VERSION = "0.3.1";
export const VISIBLE_MESSAGE_CAP_TOKENS = 200;
/**
 * The plan's prompt_count_rule (§3.7), established at gate G2
 * (experiments/pilot-settlement/calibration/2026-11-20-g2.json, Ollama 0.33.2): the server reports
 * the full prompt in prompt_eval_count whether the prefix was cached or not; the chat template adds
 * 15 tokens to the count of the two messages; prompt_eval_cached_count is not reported. A reported
 * count below the expected one by more than the tolerance is a context truncation (§3.7 post-call check).
 */
export const PROMPT_COUNT_RULE = { templateTokens: 15, tolerance: 0.01, ollamaVersion: "0.33.2", source: "calibration/2026-11-20-g2.json" } as const;
/** Whether the server's prompt_eval_count falls short of the adapter's count under the rule. */
export function promptCountShortfall(counted: number, reported: number): boolean {
  const expected = counted + PROMPT_COUNT_RULE.templateTokens;
  return reported < expected * (1 - PROMPT_COUNT_RULE.tolerance);
}
export const LENGTH_REMINDER = "Your previous draft was too long. Write a shorter message of a few sentences.";

const templates = new Map<string, string>();
function tpl(name: string): string {
  let text = templates.get(name);
  if (text === undefined) templates.set(name, (text = fs.readFileSync(path.join(BUNDLE_DIR, "prompts", name), "utf8")));
  return text;
}
function fill(text: string, values: Record<string, string | number>): string {
  for (const [k, v] of Object.entries(values)) text = text.split(`{{${k}}}`).join(String(v));
  const left = text.indexOf("{{");
  if (left >= 0) throw new Error(`unfilled placeholder in template: ${text.slice(left, left + 40)}`);
  return text;
}
/** Python's str.rstrip("\n"). */
const rstrip = (s: string) => s.replace(/\n+$/, "");

// ---------------------------------------------------------------- seeds (tools/seeds.py)

function seedOf(key: string): number {
  const digest = createHash("sha256").update(key, "utf8").digest();
  return digest.readUInt32BE(0) & 0x7fffffff;
}
export function callSeed(instanceId: string, callType: "discussion" | "final" | "oracle", round: number | null, speaker: string | null, replicate = 0, master = MASTER_SEED): number {
  return seedOf(`${master}|${instanceId}|${callType}|${round ?? ""}|${speaker ?? ""}|${replicate}`);
}
/** json.dumps([[role, content], …], ensure_ascii=False, separators=(",", ":")) — the same bytes as JSON.stringify for these texts. */
export function messagesSha256(messages: ChatMessage[]): string {
  return createHash("sha256").update(JSON.stringify(messages.map((m) => [m.role, m.content])), "utf8").digest("hex");
}
export function publicOnlySeed(messages: ChatMessage[], replicate = 0, master = MASTER_SEED): number {
  return seedOf(`${master}|public_only|${messagesSha256(messages)}|${replicate}`);
}

// ---------------------------------------------------------------- rendering (tools/render_prompts.py)

export function publicRules(state: SettlementState): string {
  return rstrip(fill(tpl("public_rules.txt"), { amount: AMOUNT, milestone: MILESTONE, requested_destination: state.requested_destination }));
}

function stateOf(config: ExperimentConfig): SettlementState {
  return PilotParamsSchema.parse(config.evaluator.params).state;
}

export function systemPrompt(config: ExperimentConfig, agentId: string): string {
  const role = ROLE_OF_ID[agentId];
  if (!role) throw new Error(`pilot-settlement: unknown agent "${agentId}"`);
  const neighbours = resolveLayout(config).neighbours;
  const others = config.agents.map((a) => a.id).filter((id) => id !== agentId);
  const recipientIds = neighbours ? (neighbours[agentId] ?? []) : others;
  // In AGENTS order, as the reference renders them (Ring and Complete are symmetric: senders = recipients).
  const names = AGENTS.filter((r) => recipientIds.includes(AGENT_ID[r])).join(", ");
  const note = role === "Operations" ? "After round 3 you alone will be asked for the final proposal.\n" : "";
  return rstrip(
    fill(tpl("system_agent.txt"), {
      role,
      public_rules: publicRules(stateOf(config)),
      role_card: roleCard(stateOf(config), role),
      recipients: names,
      senders: names,
      operations_note: note,
    })
  );
}

export function historyText(log: readonly AdapterLogEntry[], viewerId: string, names: (id: string) => string): string {
  const lines: string[] = [];
  for (const m of log) {
    if (m.speakerId === viewerId) lines.push(`[Round ${m.round}] You (${names(viewerId)}): ${m.text}`);
    else if (m.audience === null || m.audience.includes(viewerId)) lines.push(`[Round ${m.round}] ${names(m.speakerId)}: ${m.text}`);
  }
  return lines.length ? lines.join("\n") : "(no messages yet)";
}

export function turnUser(log: readonly AdapterLogEntry[], viewerId: string, round: number, names: (id: string) => string): string {
  return rstrip(fill(tpl("turn_user.txt"), { history: historyText(log, viewerId, names), round }));
}

export function finalUser(log: readonly AdapterLogEntry[], names: (id: string) => string): string {
  return rstrip(fill(tpl("final_user.txt"), { history: historyText(log, AGENT_ID.Operations, names) }));
}

function soloSystem(state: SettlementState): string {
  return rstrip(fill(tpl("system_operations_solo.txt"), { public_rules: publicRules(state) }));
}

export function oracleMessages(state: SettlementState): ChatMessage[] {
  const cards = DATA_ROLES.map((r) => roleCard(state, r)).join("\n\n");
  return [
    { role: "system", content: soloSystem(state) },
    { role: "user", content: rstrip(fill(tpl("oracle_user.txt"), { all_role_cards: cards })) },
  ];
}

export function publicOnlyMessages(state: SettlementState): ChatMessage[] {
  return [
    { role: "system", content: soloSystem(state) },
    { role: "user", content: rstrip(tpl("public_only_user.txt")) },
  ];
}

// ---------------------------------------------------------------- token counting and the message cap (Plan §3.4, §3.5)

export interface TokenCounter {
  kind: "tokenizer" | "approximate";
  count(text: string): number;
}
/** Until the model's tokenizer is in place: about 4 characters per token (the reference's planning estimate). */
export const approximateCounter: TokenCounter = { kind: "approximate", count: (text) => Math.floor((text.length + 3) / 4) };

/** The longest prefix ending at a sentence boundary that fits the cap; the first sentence cut hard if none does. */
export function truncateToSentences(text: string, cap: number, counter: TokenCounter): string {
  if (counter.count(text) <= cap) return text;
  const ends = [...text.matchAll(/[.!?](?=\s|$)/g)].map((m) => m.index! + 1);
  let best = "";
  for (const end of ends) {
    const candidate = text.slice(0, end).trimEnd();
    if (counter.count(candidate) <= cap) best = candidate;
    else break;
  }
  if (best) return best;
  // No sentence fits: cut by words.
  const words = text.split(/\s+/);
  let out = "";
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (counter.count(next) > cap) break;
    out = next;
  }
  return out;
}

// ---------------------------------------------------------------- final-output parsing (Plan §3.6)

/** Strips surrounding whitespace and one ``` / ```json fence. */
function unfence(text: string): string {
  let t = text.trim();
  const m = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(t);
  if (m) t = m[1]!.trim();
  return t;
}

/** The last top-level JSON object in the text, and whether other text surrounds it. */
export function lastJsonObject(text: string): { object: unknown; extraText: boolean } | null {
  const t = unfence(text);
  // Walk from the end: the last "}" that closes a balanced object which parses.
  for (let end = t.lastIndexOf("}"); end >= 0; end = t.lastIndexOf("}", end - 1)) {
    let depth = 0;
    let inString = false;
    let start = -1;
    for (let i = end; i >= 0; i--) {
      const c = t[i];
      if (inString) {
        if (c === '"' && t[i - 1] !== "\\") inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "}") depth++;
      else if (c === "{") {
        depth--;
        if (depth === 0) {
          start = i;
          break;
        }
      }
    }
    if (start < 0) continue;
    try {
      const object = JSON.parse(t.slice(start, end + 1));
      if (object && typeof object === "object" && !Array.isArray(object)) {
        const extraText = (t.slice(0, start) + t.slice(end + 1)).trim().length > 0;
        return { object, extraText };
      }
    } catch {
      // not an object: try an earlier "}"
    }
  }
  return null;
}

// ---------------------------------------------------------------- the adapter

export const PilotProtocolParamsSchema = z
  .object({
    instanceId: z.string().min(1),
    /** Role names in ring positions 0–5 (Operations at 0), from the instance file. */
    ringPositions: z.array(z.enum(AGENTS)).length(6).optional(),
    /** Role names in speaking order, from the instance file. */
    speakingOrder: z.array(z.enum(AGENTS)).length(6).optional(),
    visibleMessageCapTokens: z.number().int().positive().default(VISIBLE_MESSAGE_CAP_TOKENS),
  })
  .strict();

export class PilotSettlementAdapter implements ProtocolAdapter {
  readonly id = ADAPTER_ID;
  readonly version = ADAPTER_VERSION;
  readonly paramsSchema = PilotProtocolParamsSchema;

  constructor(readonly counter: TokenCounter = approximateCounter) {}

  checkConfig(config: ExperimentConfig): string[] {
    const problems: string[] = [];
    const control = config.protocol?.control;
    const ids = config.agents.map((a) => a.id);
    const expected = control ? [AGENT_ID.Operations] : AGENTS.map((r) => AGENT_ID[r]);
    if (ids.join() !== expected.join()) problems.push(`pilot-settlement: agents must be exactly [${expected.join(", ")}] in this order, got [${ids.join(", ")}]`);
    for (const a of config.agents) {
      const role = ROLE_OF_ID[a.id];
      if (role && a.name !== role) problems.push(`pilot-settlement: agent "${a.id}" must be named "${role}"`);
    }
    if (config.evaluator.id !== "pilot-settlement") problems.push(`pilot-settlement: the evaluator must be "pilot-settlement"`);
    if (config.scheduler.type !== "round_robin") problems.push("pilot-settlement: content-blind round-robin only");
    const rounds = config.discussion?.fixedRounds;
    if (control ? rounds !== 0 : rounds !== 3) problems.push(`pilot-settlement: discussion.fixedRounds must be ${control ? 0 : 3} (K = 3; a control call has no discussion)`);
    if (config.consensus.rule !== "none") problems.push('pilot-settlement: consensus.rule must be "none" (Operations alone decides)');
    if (config.decision.proposerId !== AGENT_ID.Operations) problems.push("pilot-settlement: Operations is the proposer");
    if (config.decision.proposalRequired !== true) problems.push("pilot-settlement: decision.proposalRequired must be true");
    if (config.decision.maxProposalAttempts !== 1 || config.decision.maxProposalFormatRetries !== 0) problems.push("pilot-settlement: one proposal attempt, no format retries (a schema failure is incorrect)");
    if (config.randomization) problems.push("pilot-settlement: the speaking order and ring come from the instance, not from randomization");
    // The instance's orders, when the parameters carry them: the rotation and the ring must be exactly those.
    const params = PilotProtocolParamsSchema.safeParse(config.protocol?.params ?? {});
    if (params.success) {
      // The parameters must be the bundle's record of the instance (a hand-edited config cannot carry another order).
      const record = bundleInstances()[params.data.instanceId];
      if (!record) problems.push(`pilot-settlement: unknown instance "${params.data.instanceId}"`);
      else {
        const { speakingOrder, ringPositions } = params.data;
        if (speakingOrder && speakingOrder.join() !== record.topology_assignment.speaking_order.join()) problems.push(`pilot-settlement: protocol.params.speakingOrder is not the instance's speaking order`);
        if (ringPositions && ringPositions.join() !== record.topology_assignment.ring_positions.join()) problems.push(`pilot-settlement: protocol.params.ringPositions is not the instance's ring positions`);
        const state = PilotParamsSchema.safeParse(config.evaluator.params);
        if (state.success && (state.data.instanceId !== params.data.instanceId || stateHash(state.data.state) !== stateHash(record.state))) {
          problems.push(`pilot-settlement: evaluator.params is not the state of instance "${params.data.instanceId}"`);
        }
      }
    }
    // The plan's generation settings (§3.3) on a real endpoint; the stub ignores them. Change here when the plan changes.
    // A real endpoint also needs the model's tokenizer: the budget guard and the visible cap count with it (§3.4, §3.7).
    if (this.counter.kind !== "tokenizer" && config.agents.some((a) => a.model.provider !== "stub")) {
      problems.push("pilot-settlement: a run on a model needs the model's tokenizer (experiments/pilot-settlement/model/show-verbose.json); the adapter only has the approximate counter");
    }
    for (const a of config.agents) {
      const m = a.model;
      if (m.provider === "stub") continue;
      const want = PILOT_GENERATION;
      const wrong: string[] = [];
      if (m.think !== true) wrong.push("think true");
      if (m.contextLength !== want.contextLength) wrong.push(`contextLength ${want.contextLength}`);
      if (m.maxOutputTokens !== want.maxOutputTokens) wrong.push(`maxOutputTokens ${want.maxOutputTokens}`);
      if (m.temperature !== want.temperature) wrong.push(`temperature ${want.temperature}`);
      if (m.keepAlive !== want.keepAlive) wrong.push(`keepAlive "${want.keepAlive}"`);
      for (const [k, v] of Object.entries(want.sampling)) if ((m.sampling as Record<string, number | undefined> | undefined)?.[k] !== v) wrong.push(`sampling.${k} ${v}`);
      if (m.seed !== undefined) wrong.push("no fixed seed (the adapter seeds every call)");
      if (wrong.length) problems.push(`pilot-settlement: agent "${a.id}" must use the plan's generation settings: ${wrong.join(", ")}`);
    }
    if (config.scheduler.type === "round_robin" && config.scheduler.startAgentId !== undefined) problems.push("pilot-settlement: scheduler.startAgentId rotates the instance's speaking order: remove it");
    if (params.success && !control) {
      const { speakingOrder, ringPositions } = params.data;
      const rotation = config.scheduler.type === "round_robin" ? (config.scheduler.order ?? config.agents.map((a) => a.id)) : [];
      if (speakingOrder && rotation.join() !== speakingOrder.map((r) => AGENT_ID[r]).join()) {
        problems.push(`pilot-settlement: scheduler.order must be the instance's speaking order [${speakingOrder.map((r) => AGENT_ID[r]).join(", ")}]`);
      }
      const topology = config.communication?.topology;
      if (ringPositions && topology?.type === "ring") {
        const expectedRing = ringPositions.map((r) => AGENT_ID[r]);
        if ((topology.order ?? config.agents.map((a) => a.id)).join() !== expectedRing.join()) {
          problems.push(`pilot-settlement: communication.topology.order must be the instance's ring positions [${expectedRing.join(", ")}] (a batch's $instance sets it)`);
        }
      }
      if (topology && topology.type !== "ring") problems.push("pilot-settlement: the topologies of the pilot are complete and ring");
    }
    return problems;
  }

  fingerprintAssets(): unknown {
    const state: SettlementState = { requested_destination: "D2", permitted_destinations: ["D1", "D2"], authorized_destinations: ["D1", "D2"], supported_routes: ["D1/B", "D2/A"], verification_status: "accepted", approval_status: "approved" };
    const names = (id: string) => ROLE_OF_ID[id] ?? id;
    const log: AdapterLogEntry[] = [
      { turn: 1, round: 1, speakerId: "contract", audience: null, text: "first message" },
      { turn: 2, round: 1, speakerId: "operations", audience: ["contract", "settlement"], text: "second message" },
    ];
    return {
      templates: Object.fromEntries(["system_agent.txt", "public_rules.txt", "turn_user.txt", "final_user.txt", "oracle_user.txt", "public_only_user.txt", "system_operations_solo.txt"].map((n) => [n, tpl(n)])),
      roleCards: Object.fromEntries(AGENTS.map((r) => [r, roleCard(state, r)])),
      publicRules: publicRules(state),
      history: [historyText(log, "operations", names), historyText(log, "treasury", names), historyText([], "operations", names)],
      turnUser: turnUser(log, "operations", 1, names),
      finalUser: finalUser(log, names),
      oracle: oracleMessages(state),
      publicOnly: publicOnlyMessages(state),
      reminder: LENGTH_REMINDER,
      cap: VISIBLE_MESSAGE_CAP_TOKENS,
      seeds: { master: MASTER_SEED, sample: callSeed("X-1", "discussion", 1, "Operations", 0) },
    };
  }

  private names(config: ExperimentConfig): (id: string) => string {
    const byId = new Map(config.agents.map((a) => [a.id, a.name]));
    return (id) => byId.get(id) ?? id;
  }

  private params(config: ExperimentConfig) {
    return PilotProtocolParamsSchema.parse(config.protocol?.params ?? {});
  }

  renderDiscussionCall(ctx: AdapterContext): AdapterCall {
    const { instanceId } = this.params(ctx.config);
    const role = ROLE_OF_ID[ctx.agent.id]!;
    let user = turnUser(ctx.log, ctx.agent.id, ctx.round ?? 1, this.names(ctx.config));
    if (ctx.reminder) user = `${user}\n${ctx.reminder}`;
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt(ctx.config, ctx.agent.id) },
      { role: "user", content: user },
    ];
    return this.withCount({ messages, seed: callSeed(instanceId, "discussion", ctx.round, role, ctx.replicate) });
  }

  renderProposalCall(ctx: AdapterContext): AdapterCall {
    const { instanceId } = this.params(ctx.config);
    const control = ctx.config.protocol?.control;
    const state = stateOf(ctx.config);
    if (control === "oracle") {
      return this.withCount({ messages: oracleMessages(state), seed: callSeed(instanceId, "oracle", null, "Operations", ctx.replicate) });
    }
    if (control === "public_only") {
      const messages = publicOnlyMessages(state);
      return this.withCount({ messages, seed: publicOnlySeed(messages, ctx.replicate) });
    }
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt(ctx.config, ctx.agent.id) },
      { role: "user", content: finalUser(ctx.log, this.names(ctx.config)) },
    ];
    return this.withCount({ messages, seed: callSeed(instanceId, "final", null, "Operations", ctx.replicate) });
  }

  /**
   * The prompt's token count: the messages counted one by one and summed. The chat template's own
   * tokens (role markers, newlines, the thinking prefix) are not in it; how the count relates to the
   * server's `prompt_eval_count` is the plan's `prompt_count_rule` (§3.7, gate G2 step 3).
   */
  private withCount(call: AdapterCall): AdapterCall {
    const counted = call.messages.reduce((n, m) => n + this.counter.count(m.content), 0);
    return { ...call, promptTokensCounted: counted, tokenCounter: this.counter.kind };
  }

  acceptTurn(answer: RawAnswer, ctx: AdapterContext, attempt: number): TurnDecision {
    const cap = this.params(ctx.config).visibleMessageCapTokens;
    const text = answer.text.trim();
    // Plan §3.5: done_reason "length" with empty or unfinished content is a model failure (thinking overflow) — never delivered.
    if (answer.finishReason === "length") return { kind: "silent", reason: "thinking_overflow", flags: ["silent_turn_model_failure"] };
    if (!text) return { kind: "silent", reason: "empty_content", flags: ["silent_turn_model_failure"] };
    const tokens = this.counter.count(text);
    if (tokens <= cap) return { kind: "message", text, flags: [], visibleTokens: tokens };
    if (attempt === 0) return { kind: "regenerate", reminder: LENGTH_REMINDER, flags: ["over_length_regenerated"] };
    const truncated = truncateToSentences(text, cap, this.counter);
    return { kind: "message", text: truncated, flags: ["over_length_regenerated", "over_length_truncated"], visibleTokens: this.counter.count(truncated) };
  }

  acceptProposal(answer: RawAnswer): ProposalDecision {
    const text = answer.text.trim();
    if (!text) return { kind: "model_failure", reason: answer.finishReason === "length" ? "thinking_overflow" : "empty_content" };
    const found = lastJsonObject(text);
    // Cut at num_predict without a complete object: unfinished content — a model failure, not a schema failure (plan §3.5).
    if (!found && answer.finishReason === "length") return { kind: "model_failure", reason: "thinking_overflow" };
    if (!found) return { kind: "schema_failure", error: "no parsable JSON object", extraText: false };
    const parsed = ProposalSchema.safeParse(found.object);
    if (!parsed.success) return { kind: "schema_failure", error: formatZodError(parsed.error), extraText: found.extraText };
    return { kind: "proposal", proposal: parsed.data, extraText: found.extraText };
  }
}

/** Role name → agent id, for instance files and run logs. */
export const idOfRole = (role: RoleName | string) => AGENT_ID[role as RoleName] ?? role;
