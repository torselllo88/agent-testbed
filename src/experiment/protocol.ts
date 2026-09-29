import { z } from "zod";
import type { RoomMessage } from "../transport/transport.js";
import type { AgentConfig, ExperimentConfig } from "./config.js";
import { languageName } from "../presentation/languages.js";
import { toJsonSchema } from "./jsonSchema.js";

/**
 * The testbed's agent protocol: what an agent is told about the room, and
 * the JSON shapes it answers with. Scenario-neutral — scenario content comes
 * only from the config (task, shared context, prompts, private context) and
 * the evaluator's proposal schema.
 */

// Strict schemas (every field required, nullable instead of optional) are
// what providers enforce natively; the lenient parse schemas below accept a
// model that simply omits a null field in prompt-only mode.

const TurnStrict = z.object({
  message: z.string(),
  pass: z.boolean(),
  target: z.string().nullable(),
  intent: z.string().nullable(),
  readyToCommit: z.boolean(),
});
export const TurnResponseSchema = z.object({
  message: z.string().default(""),
  pass: z.boolean().default(false),
  target: z.string().nullable().default(null),
  intent: z.string().nullable().default(null),
  readyToCommit: z.boolean().default(false),
});
export type TurnResponse = z.infer<typeof TurnResponseSchema>;
export const TURN_JSON_SCHEMA = toJsonSchema(TurnStrict, "agent_turn");

/** Envelope only — the proposal body is validated against the scenario's schema separately, so "unparseable" and "schema-invalid" stay distinct outcomes. */
export const ProposalEnvelopeSchema = z.object({
  rationale: z.string().default(""),
  proposal: z.unknown(),
});
export type ProposalEnvelope = z.infer<typeof ProposalEnvelopeSchema>;
export function proposalJsonSchema(proposalSchema: z.ZodTypeAny): Record<string, unknown> {
  return toJsonSchema(z.object({ rationale: z.string(), proposal: proposalSchema.nullable() }), "final_proposal");
}

const VoteStrict = z.object({ vote: z.enum(["APPROVE", "REJECT"]), reason: z.string() });
export const VoteResponseSchema = z.object({
  vote: z.preprocess((v) => (typeof v === "string" ? v.trim().toUpperCase() : v), z.enum(["APPROVE", "REJECT"])),
  reason: z.string().default(""),
});
export type VoteResponse = z.infer<typeof VoteResponseSchema>;
export const VOTE_JSON_SCHEMA = toJsonSchema(VoteStrict, "vote");

const RouterStrict = z.object({ nextAgentId: z.string(), reason: z.string() });
export const RouterResponseSchema = z.object({ nextAgentId: z.string(), reason: z.string().default("") });
export type RouterResponse = z.infer<typeof RouterResponseSchema>;
export const ROUTER_JSON_SCHEMA = toJsonSchema(RouterStrict, "next_speaker");

export interface ProgressInfo {
  discussionTurnsUsed: number;
  discussionTurnLimit: number;
  proposalAttempt: number;
  maxProposalAttempts: number;
}

function roster(config: ExperimentConfig, self?: AgentConfig): string {
  return config.agents
    .map((a) => `- ${a.id}: ${a.name} — ${a.role}${self && a.id === self.id ? " (you)" : ""}`)
    .join("\n");
}

export function renderTranscript(
  messages: RoomMessage[],
  config: ExperimentConfig,
  selfId?: string
): string {
  if (messages.length === 0) return "(no messages yet)";
  const names = new Map(config.agents.map((a) => [a.id, a.name]));
  return messages
    .map((m) => {
      if (m.sender.kind === "system") return `[${m.index}] [moderator] ${m.text}`;
      if (m.sender.kind === "narrator") return `[${m.index}] [narrator] ${m.text}`;
      const id = m.sender.agentId;
      return `[${m.index}] ${names.get(id) ?? id} (${id})${id === selfId ? " (you)" : ""}: ${m.text}`;
    })
    .join("\n");
}

function jsonInstruction(schema: Record<string, unknown>): string {
  return `Respond with ONLY a single JSON object matching this JSON Schema — no other text:\n${JSON.stringify(schema)}`;
}

/** Participant-visible text follows the conversation language; the protocol itself never changes. */
function languageInstruction(code: string): string {
  return (
    `Language: write everything other participants can read — your room messages, proposal rationale and vote reasons — in ${languageName(code)} (${code}). ` +
    "JSON field names, participant ids and enum values (e.g. APPROVE, REJECT, research_labs) stay exactly as specified; never translate them."
  );
}

export function renderSystemPrompt(config: ExperimentConfig, agent: AgentConfig): string {
  return [
    `You are ${agent.name} (id "${agent.id}"), role: ${agent.role}.`,
    `You are one of ${config.agents.length} participants in a shared discussion room:`,
    roster(config, agent),
    agent.objective.trim() ? `Your objective: ${agent.objective.trim()}` : "",
    agent.persona.trim()
      ? `Your character — let it shape how you communicate and react, never what facts you report:
${agent.persona.trim()}`
      : "",
    agent.systemPrompt.trim(),
    [
      "How the room works:",
      "- Participants speak one at a time. On your turn you either post ONE message to the room, or PASS if you have nothing useful to add.",
      "- Everything you post is visible to every participant. Your private information is visible only to you — share what is relevant, because others cannot see it otherwise.",
      "- To address a specific participant, set \"target\" to their id; they are likely to speak next. Use null if no one in particular.",
      "- Set \"readyToCommit\" to true only when you believe the room already has enough information to agree on a final decision. Readiness you declared becomes stale when someone posts new information, and you will be asked again.",
      "- When the discussion ends, one participant is asked to submit a formal proposal, and then every participant votes on exactly that proposal.",
      "- Be concise. Do not repeat information that has already been established.",
    ].join("\n"),
    languageInstruction(config.conversation.language),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function contextSections(config: ExperimentConfig, agent: AgentConfig, transcript: RoomMessage[]): string[] {
  return [
    `TASK:\n${config.task.description.trim()}`,
    config.task.sharedContext.trim() ? `SHARED CONTEXT (known to everyone):\n${config.task.sharedContext.trim()}` : "",
    `YOUR PRIVATE INFORMATION (only you can see this):\n${agent.privateContext.trim() || "(none)"}`,
    `ROOM TRANSCRIPT (oldest first):\n${renderTranscript(transcript, config, agent.id)}`,
  ].filter(Boolean);
}

export function renderDiscussionPrompt(
  config: ExperimentConfig,
  agent: AgentConfig,
  transcript: RoomMessage[],
  progress: ProgressInfo,
  /** Runtime lifecycle note for this specific turn (e.g. a readiness re-check). */
  note?: string
): string {
  const budget = config.agentVisibility.discussionBudget
    ? ` (discussion turns used: ${progress.discussionTurnsUsed} of ${progress.discussionTurnLimit}; proposal attempt ${progress.proposalAttempt} of ${progress.maxProposalAttempts})`
    : "";
  return [
    ...contextSections(config, agent, transcript),
    `It is your turn in the DISCUSSION phase${budget}.`,
    note ?? "",
    'Fields: "message" = what you post to the room (empty when passing); "pass" = true to skip your turn; "target" = id of the participant you address, or null; "intent" = a few words on the purpose of your message, or null; "readyToCommit" = whether you are ready for the decision phase.',
    jsonInstruction(TURN_JSON_SCHEMA),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function renderProposalPrompt(
  config: ExperimentConfig,
  agent: AgentConfig,
  transcript: RoomMessage[],
  schema: Record<string, unknown>,
  feedback?: string
): string {
  return [
    ...contextSections(config, agent, transcript),
    "The DISCUSSION phase has ended. You have been asked to submit the room's final proposal. Every participant will vote on exactly what you submit.",
    'Put the complete decision in "proposal", using exactly the structure required by the schema. Put a short explanation for the other participants in "rationale". If you believe no acceptable proposal can be made yet, set "proposal" to null and explain why in "rationale".',
    feedback ? `Your previous submission was not accepted: ${feedback}` : "",
    jsonInstruction(schema),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function renderVotePrompt(
  config: ExperimentConfig,
  agent: AgentConfig,
  transcript: RoomMessage[],
  proposal: { proposerName: string; rationale: string; body: unknown }
): string {
  return [
    ...contextSections(config, agent, transcript),
    `VOTING phase. ${proposal.proposerName} submitted this final proposal:\n${JSON.stringify(proposal.body, null, 2)}`,
    `Proposer's rationale: ${proposal.rationale || "(none)"}`,
    "Vote independently on exactly this proposal, using your private information. Approve only if you believe it is correct and safe as written. You cannot see anyone else's vote.",
    jsonInstruction(VOTE_JSON_SCHEMA),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The router sees only what is public: the task, who is in the room and
 * their roles, and the recent conversation. Never private context, never the
 * evaluator — it decides who should speak, not what the answer is.
 */
export function renderRouterPrompt(
  config: ExperimentConfig,
  transcript: RoomMessage[],
  lastSpeakerId: string | null,
  candidateIds: string[]
): { system: string; user: string } {
  return {
    system:
      "You moderate turn-taking in a discussion room. Choose which participant should speak next so the conversation makes progress: the participant who was just asked something, who most likely holds the missing information, or who has not been heard from. Do not try to solve the task yourself.",
    user: [
      `TASK:\n${config.task.description.trim()}`,
      `PARTICIPANTS:\n${roster(config)}`,
      `RECENT CONVERSATION (oldest first):\n${renderTranscript(transcript, config)}`,
      `Last speaker: ${lastSpeakerId ?? "(none)"}. Choose the next speaker from: ${candidateIds.join(", ")}.`,
      'Fields: "nextAgentId" = the chosen participant id; "reason" = one short sentence.',
      jsonInstruction(ROUTER_JSON_SCHEMA),
    ].join("\n\n"),
  };
}
