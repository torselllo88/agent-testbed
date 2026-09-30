import { z } from "zod";
import type { AgentConfig, ExperimentConfig } from "../experiment/config.js";
import type { ExperimentEvent } from "../experiment/events.js";
import { toJsonSchema } from "../experiment/jsonSchema.js";
import { languageName } from "../experiment/languages.js";
import { renderTranscript } from "../experiment/protocol.js";
import type { RoomMessage } from "../transport/transport.js";

/**
 * What a character is given in the debrief. The finished run is recorded history
 * (read from the experiment's trace, which is the source of truth); each
 * character keeps its own perspective — its own private information and its
 * own vote, plus everything that was public — and never gains another
 * character's unrevealed private context.
 */

export const DebriefAnswerSchema = z.object({ message: z.string() });
export const DEBRIEF_ANSWER_JSON_SCHEMA = toJsonSchema(DebriefAnswerSchema, "debrief_answer");

export const DebriefRouteSchema = z.object({
  agentId: z.string().nullable().default(null),
  confident: z.boolean().default(false),
  reason: z.string().default(""),
});
export const DEBRIEF_ROUTE_JSON_SCHEMA = toJsonSchema(
  z.object({ agentId: z.string().nullable(), confident: z.boolean(), reason: z.string() }),
  "debrief_route"
);

/** The finished run as the room experienced it, derived from the experiment's own events. */
export interface FinishedRun {
  transcript: RoomMessage[];
  outcome: string;
  /** The ending narration as announced in the room, if the scenario has a narrator. */
  endingNarration: string | null;
  committed: { proposerId: string; body: unknown; rationale: string } | null;
  voteRounds: Array<{ proposalId: string; approvals: number; eligible: number; reached: boolean }>;
  votes: Array<{ agentId: string; proposalId: string; vote: string; reason: string }>;
  evaluation: { outcome: string; checks: Record<string, { passed: boolean; detail: string }> } | null;
}

export function finishedRun(events: ExperimentEvent[]): FinishedRun {
  const transcript: RoomMessage[] = [];
  let endingNarration: string | null = null;
  let outcome = "UNKNOWN";
  let evaluation: FinishedRun["evaluation"] = null;
  let committedId: string | null = null;
  const proposals = new Map<string, { proposerId: string; body: unknown; rationale: string }>();
  const voteRounds: FinishedRun["voteRounds"] = [];
  const votes: FinishedRun["votes"] = [];

  for (const e of events) {
    const p = e.payload as Record<string, any>;
    switch (e.type) {
      case "message_posted":
        if (p.sender?.kind === "narrator") {
          if (p.narration?.source !== "opening") endingNarration = String(p.text);
        } else {
          transcript.push({ id: String(p.messageId), index: Number(p.index), ts: e.ts, sender: p.sender, text: String(p.text) });
        }
        break;
      case "proposal_frozen":
        proposals.set(String(p.id), { proposerId: String(p.proposerId), body: p.body, rationale: String(p.rationale ?? "") });
        break;
      case "consensus_result":
        voteRounds.push({ proposalId: String(p.proposalId), approvals: Number(p.approvals), eligible: Number(p.eligible), reached: Boolean(p.reached) });
        break;
      case "vote_cast":
        votes.push({ agentId: String(e.agentId), proposalId: String(p.proposalId), vote: String(p.vote), reason: String(p.reason ?? "") });
        break;
      case "evaluation_result":
        committedId = String(p.proposalId);
        evaluation = { outcome: String(p.outcome), checks: (p.checks ?? {}) as Record<string, { passed: boolean; detail: string }> };
        break;
      case "experiment_finished":
        outcome = String(p.termination?.outcome ?? outcome);
        break;
    }
  }
  return { transcript, outcome, endingNarration, committed: committedId ? (proposals.get(committedId) ?? null) : null, voteRounds, votes, evaluation };
}

export interface DebriefExchange {
  askerName: string;
  question: string;
  agentId: string;
  answer: string;
}

function languageInstruction(code: string): string {
  return `Language: answer in ${languageName(code)} (${code}).`;
}

export function renderDebriefSystemPrompt(config: ExperimentConfig, agent: AgentConfig): string {
  return [
    `You are ${agent.name} (id "${agent.id}"), role: ${agent.role}.`,
    agent.persona.trim() ? `Your character — let it shape how you talk, never what facts you report:\n${agent.persona.trim()}` : "",
    agent.systemPrompt.trim(),
    [
      "The session is over. This is the debrief: people who watched it are asking the participants questions in the room.",
      "- The transcript below is recorded history. The final decision and the outcome are fixed; nothing said now can change them.",
      "- Speak from your own perspective. You know your own private information, everything that was said publicly in the room, the final decision and the outcome as announced. You do not know other participants' private information unless they shared it in the room — do not claim to.",
      "- Keep apart what you knew at the time, what you learned from the outcome, and what you are only inferring now.",
      "- Never claim that you, or anyone, said or did something the transcript does not show. If asked what you would do differently, you may speculate — as hindsight, not as a rewrite of what happened.",
      "- Answer the person who asked, by name. Speak naturally and in character, in 1–4 sentences.",
    ].join("\n"),
    languageInstruction(config.conversation.language),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function names(config: ExperimentConfig): Map<string, string> {
  return new Map(config.agents.map((a) => [a.id, a.name]));
}

export function renderDebriefQuestionPrompt(
  config: ExperimentConfig,
  agent: AgentConfig,
  mission: FinishedRun,
  history: DebriefExchange[],
  question: {
    askerName: string;
    text: string;
    /** The room message the question replies to, if it is a reply. */
    inReplyTo?: { authorName: string | null; own: boolean; text: string } | null;
  },
  options: { revealEvaluation: boolean }
): string {
  const nameOf = names(config);
  const ownVotes = mission.votes.filter((v) => v.agentId === agent.id);
  const rounds = mission.voteRounds
    .map((r, i) => `Vote ${i + 1}: ${r.approvals} of ${r.eligible} approved — ${r.reached ? "accepted" : "not accepted"}.`)
    .join("\n");
  const decision = mission.committed
    ? `FINAL DECISION (committed; proposed by ${nameOf.get(mission.committed.proposerId) ?? mission.committed.proposerId}):\n${JSON.stringify(mission.committed.body, null, 2)}\nRationale: ${mission.committed.rationale || "(none)"}`
    : "FINAL DECISION: no plan was committed.";
  const evaluation =
    options.revealEvaluation && mission.evaluation
      ? `EVALUATION (published after the session):\n${Object.entries(mission.evaluation.checks)
          .map(([name, c]) => `- ${name}: ${c.passed ? "passed" : "FAILED"} — ${c.detail}`)
          .join("\n")}`
      : "";
  const debrief = history.length
    ? history.map((x) => `${x.askerName} asked ${nameOf.get(x.agentId) ?? x.agentId}: ${x.question}\n${nameOf.get(x.agentId) ?? x.agentId}: ${x.answer}`).join("\n\n")
    : "(no questions yet)";

  return [
    `THE TASK:\n${config.task.description.trim()}`,
    config.task.sharedContext.trim() ? `SHARED CONTEXT (known to everyone):\n${config.task.sharedContext.trim()}` : "",
    `YOUR PRIVATE INFORMATION DURING THE SESSION (only you had it):\n${agent.privateContext.trim() || "(none)"}`,
    `TRANSCRIPT (recorded history, oldest first):\n${renderTranscript(mission.transcript, config, agent.id)}`,
    rounds ? `VOTING:\n${rounds}` : "",
    ownVotes.length ? `YOUR OWN VOTES:\n${ownVotes.map((v) => `${v.vote}${v.reason ? ` — ${v.reason}` : ""}`).join("\n")}` : "",
    decision,
    `OUTCOME: ${mission.outcome}${mission.endingNarration ? `\nAs announced in the room:\n${mission.endingNarration}` : ""}`,
    evaluation,
    `DEBRIEF SO FAR (oldest first):\n${debrief}`,
    question.inReplyTo
      ? `${question.askerName} is replying to ${question.inReplyTo.own ? "your own message" : `a message by ${question.inReplyTo.authorName ?? "the moderator"}`}:\n"${question.inReplyTo.text}"`
      : "",
    `QUESTION from ${question.askerName}, addressed to you:\n${question.text}`,
    `Answer ${question.askerName} — the person who asked — and address them by name, not anyone mentioned in the transcript.`,
    `Respond with ONLY a single JSON object matching this JSON Schema — no other text:\n${JSON.stringify(DEBRIEF_ANSWER_JSON_SCHEMA)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The debrief router sees only public information: who the characters are, the recent debrief, and the question. */
export function renderDebriefRouterPrompt(
  config: ExperimentConfig,
  history: DebriefExchange[],
  question: { askerName: string; text: string }
): { system: string; user: string } {
  const nameOf = names(config);
  return {
    system:
      "You route questions in a debrief after a finished session to the one participant best placed to answer. Pick the participant the question is about or whose area it concerns. If it is addressed to everyone in general or you are unsure, set confident to false.",
    user: [
      `PARTICIPANTS:\n${config.agents.map((a) => `- ${a.id}: ${a.name} — ${a.role}`).join("\n")}`,
      history.length
        ? `RECENT DEBRIEF:\n${history
            .slice(-4)
            .map((x) => `${x.askerName} → ${nameOf.get(x.agentId) ?? x.agentId}: ${x.question}`)
            .join("\n")}`
        : "",
      `QUESTION from ${question.askerName}:\n${question.text}`,
      'Fields: "agentId" = the participant id, or null; "confident" = whether the choice is clear; "reason" = one short sentence.',
      `Respond with ONLY a single JSON object matching this JSON Schema — no other text:\n${JSON.stringify(DEBRIEF_ROUTE_JSON_SCHEMA)}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}
