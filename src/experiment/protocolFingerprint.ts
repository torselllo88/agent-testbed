import { z } from "zod";
import type { RoomMessage } from "../transport/transport.js";
import { canonicalJson, parseExperimentConfig, sha256, type ExperimentConfig } from "./config.js";
import { COMMON_LANGUAGES, languageName } from "./languages.js";
import {
  PROTOCOL_FEEDBACK,
  proposalJsonSchema,
  readinessRecheckNote,
  renderDiscussionPrompt,
  renderProposalPrompt,
  renderRouterPrompt,
  renderSystemPrompt,
  renderVotePrompt,
  ROUTER_JSON_SCHEMA,
  TURN_JSON_SCHEMA,
  VOTE_JSON_SCHEMA,
} from "./protocol.js";
import { AUTHORED_PROTOCOL_LANGUAGES, protocolStrings } from "./protocolStrings.js";

/**
 * A fingerprint of the shared protocol assets: everything the core itself
 * tells agents and the router, independent of any scenario — the prompt
 * templates (system, discussion, proposal, vote, router), the runtime notes
 * and feedback (readiness re-check, parse retry, proposal format feedback),
 * the moderator's protocol notices in every authored language, and the JSON
 * schemas agents answer with.
 *
 * It is computed by RENDERING those templates for fixed, neutral fixtures
 * (covering their branches: languages, budget visibility, empty fields,
 * empty transcripts, feedback) and hashing the result — not by hashing source
 * code, so a refactor that keeps every text identical keeps the fingerprint.
 *
 * What it is not: a description of the whole runtime. Readiness logic,
 * scheduling and parsing leniency are code; the git commit stays the final
 * provenance. Debrief prompts are not part of it: no experiment depends on them.
 */

const FIXTURE_PROPOSAL_SCHEMA = z.object({ choice: z.enum(["a", "b"]), amount: z.number() });

function fixtureConfig(language: string, discussionBudget: boolean): ExperimentConfig {
  const agent = (id: string, full: boolean) => ({
    id,
    name: `Name ${id}`,
    role: `role of ${id}`,
    objective: full ? `objective of ${id}` : "",
    persona: full ? `persona of ${id}` : "",
    systemPrompt: full ? `extra instructions of ${id}` : "",
    privateContext: full ? `private context of ${id}` : "",
    model: { provider: "stub", model: "fixture" },
  });
  return parseExperimentConfig({
    schemaVersion: 1,
    name: "protocol fixture",
    task: { description: "the fixture task", sharedContext: "" },
    agents: [agent("agent_a", true), agent("agent_b", false)],
    scheduler: { type: "round_robin", startAgentId: "agent_a" },
    consensus: { rule: "unanimity" },
    decision: { proposerId: "agent_a" },
    agentVisibility: { discussionBudget },
    conversation: { language },
    evaluator: { id: "fixture" },
  });
}

const TS = "2000-01-01T00:00:00.000Z";
const TRANSCRIPT: RoomMessage[] = [
  { id: "m1", index: 1, ts: TS, sender: { kind: "agent", agentId: "agent_a" }, text: "first message" },
  { id: "m2", index: 2, ts: TS, sender: { kind: "system" }, text: "a moderator notice" },
  { id: "m3", index: 3, ts: TS, sender: { kind: "agent", agentId: "agent_b" }, text: "second message" },
];

const PROGRESS = { discussionTurnsUsed: 3, discussionTurnLimit: 10, proposalAttempt: 1, maxProposalAttempts: 2 };
const PROPOSAL = { proposerName: "Name agent_a", rationale: "a rationale", body: { choice: "a", amount: 1 } };

/** The rendered protocol assets — deterministic, scenario-free. */
export function protocolAssets(): Record<string, unknown> {
  const schema = proposalJsonSchema(FIXTURE_PROPOSAL_SCHEMA);
  const prompts: Record<string, unknown> = {};
  for (const language of ["en", "ru", "sr-Latn"]) {
    for (const budget of [false, true]) {
      const config = fixtureConfig(language, budget);
      const key = `${language}/${budget ? "budget" : "no-budget"}`;
      prompts[key] = config.agents.map((agent) => ({
        system: renderSystemPrompt(config, agent),
        discussion: renderDiscussionPrompt(config, agent, TRANSCRIPT, PROGRESS),
        discussionEmptyRoom: renderDiscussionPrompt(config, agent, [], PROGRESS),
        recheck: renderDiscussionPrompt(config, agent, TRANSCRIPT, PROGRESS, readinessRecheckNote(TRANSCRIPT, agent.id, 1)),
        proposal: renderProposalPrompt(config, agent, TRANSCRIPT, schema),
        proposalAfterFeedback: renderProposalPrompt(config, agent, TRANSCRIPT, schema, PROTOCOL_FEEDBACK.proposalSchemaInvalid("<error>")),
        vote: renderVotePrompt(config, agent, TRANSCRIPT, PROPOSAL),
      }));
      prompts[`${key}/router`] = renderRouterPrompt(config, TRANSCRIPT, "agent_a", ["agent_b"]);
    }
  }
  const notices: Record<string, unknown> = {};
  for (const language of [...AUTHORED_PROTOCOL_LANGUAGES, "sr-Latn"]) {
    const s = protocolStrings(language);
    notices[language] = {
      submitted: [s.proposalSubmitted({ attempt: 1, proposerName: "P", body: "{}", rationale: "r" }), s.proposalSubmitted({ attempt: 2, proposerName: "P", body: "{}", rationale: "" })],
      notApproved: ["unanimity", "majority"].map((rule) => s.proposalNotApproved({ attempt: 1, approvals: 1, eligible: 3, rule, required: 3 })),
      votes: (["APPROVE", "REJECT", "INVALID"] as const).flatMap((vote) => [s.voteLine({ agentName: "A", vote, reason: "why" }), s.voteLine({ agentName: "A", vote, reason: "" })]),
    };
  }
  return {
    prompts,
    feedback: {
      parseRetry: PROTOCOL_FEEDBACK.parseRetry("<error>"),
      proposalUnparseable: PROTOCOL_FEEDBACK.proposalUnparseable("<error>"),
      proposalSchemaInvalid: PROTOCOL_FEEDBACK.proposalSchemaInvalid("<error>"),
      recheckRanges: [readinessRecheckNote(TRANSCRIPT, "agent_a", 0), readinessRecheckNote([], "agent_a", null)],
    },
    notices,
    languageNames: Object.fromEntries(COMMON_LANGUAGES.map((code) => [code, languageName(code)])),
    schemas: { turn: TURN_JSON_SCHEMA, vote: VOTE_JSON_SCHEMA, router: ROUTER_JSON_SCHEMA, proposalEnvelope: schema },
  };
}

/** sha256 of the canonical rendered protocol assets (first 16 hex digits). */
export function computeProtocolFingerprint(): string {
  return sha256(canonicalJson(protocolAssets())).slice(0, 16);
}

/** This build's protocol fingerprint, recorded with every run. */
export const PROTOCOL_FINGERPRINT = computeProtocolFingerprint();
