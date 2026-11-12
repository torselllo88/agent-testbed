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
 *
 * Per protocol variant: options that change what agents are told (fixed
 * discussion rounds, a required proposal) add their own texts to the hashed
 * assets only for runs that use them. A run on the default protocol hashes
 * exactly the default set, so its fingerprint does not change when a new
 * variant is added.
 */

/** The protocol options that change agent-facing texts. */
export interface ProtocolVariant {
  fixedRounds: boolean;
  proposalRequired: boolean;
}
const DEFAULT_VARIANT: ProtocolVariant = { fixedRounds: false, proposalRequired: false };

export function protocolVariant(config: ExperimentConfig): ProtocolVariant {
  return { fixedRounds: config.discussion !== undefined, proposalRequired: config.decision.proposalRequired === true };
}

const isDefault = (v: ProtocolVariant) => !v.fixedRounds && !v.proposalRequired;

const FIXTURE_PROPOSAL_SCHEMA = z.object({ choice: z.enum(["a", "b"]), amount: z.number() });

function fixtureConfig(language: string, discussionBudget: boolean, variant: ProtocolVariant): ExperimentConfig {
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
    decision: { proposerId: "agent_a", ...(variant.proposalRequired ? { proposalRequired: true } : {}) },
    ...(variant.fixedRounds ? { discussion: { fixedRounds: 2 } } : {}),
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

function renderPrompts(variant: ProtocolVariant): Record<string, unknown> {
  const schema = proposalJsonSchema(FIXTURE_PROPOSAL_SCHEMA, variant.proposalRequired);
  const prompts: Record<string, unknown> = {};
  for (const language of ["en", "ru", "sr-Latn"]) {
    for (const budget of [false, true]) {
      const config = fixtureConfig(language, budget, variant);
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
  return prompts;
}

/** The rendered protocol assets of a variant (default: the default protocol) — deterministic, scenario-free. */
export function protocolAssets(variant: ProtocolVariant = DEFAULT_VARIANT): Record<string, unknown> {
  const schema = proposalJsonSchema(FIXTURE_PROPOSAL_SCHEMA);
  const prompts = renderPrompts(DEFAULT_VARIANT);
  const notices: Record<string, unknown> = {};
  for (const language of [...AUTHORED_PROTOCOL_LANGUAGES, "sr-Latn"]) {
    const s = protocolStrings(language);
    notices[language] = {
      submitted: [s.proposalSubmitted({ attempt: 1, proposerName: "P", body: "{}", rationale: "r" }), s.proposalSubmitted({ attempt: 2, proposerName: "P", body: "{}", rationale: "" })],
      notApproved: ["unanimity", "majority"].map((rule) => s.proposalNotApproved({ attempt: 1, approvals: 1, eligible: 3, rule, required: 3 })),
      votes: (["APPROVE", "REJECT", "INVALID"] as const).flatMap((vote) => [s.voteLine({ agentName: "A", vote, reason: "why" }), s.voteLine({ agentName: "A", vote, reason: "" })]),
    };
  }
  const assets: Record<string, unknown> = {
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
  if (isDefault(variant)) return assets;
  return {
    ...assets,
    variant: {
      flags: variant,
      prompts: renderPrompts(variant),
      ...(variant.proposalRequired
        ? { feedback: { proposalRequired: PROTOCOL_FEEDBACK.proposalRequired() }, proposalEnvelope: proposalJsonSchema(FIXTURE_PROPOSAL_SCHEMA, true) }
        : {}),
    },
  };
}

/** sha256 of the canonical rendered protocol assets of a variant (first 16 hex digits). */
export function computeProtocolFingerprint(variant: ProtocolVariant = DEFAULT_VARIANT): string {
  return sha256(canonicalJson(protocolAssets(variant))).slice(0, 16);
}

/** This build's fingerprint of the default protocol. */
export const PROTOCOL_FINGERPRINT = computeProtocolFingerprint();

const byVariant = new Map<string, string>([["false/false", PROTOCOL_FINGERPRINT]]);

/** The fingerprint of the protocol a run with this config uses — recorded with every run. */
export function protocolFingerprintFor(config: ExperimentConfig): string {
  const variant = protocolVariant(config);
  const key = `${variant.fixedRounds}/${variant.proposalRequired}`;
  let fingerprint = byVariant.get(key);
  if (!fingerprint) byVariant.set(key, (fingerprint = computeProtocolFingerprint(variant)));
  return fingerprint;
}
