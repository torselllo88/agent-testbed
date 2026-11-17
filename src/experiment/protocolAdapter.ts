import type { z } from "zod";
import type { ChatMessage } from "../llm/provider.js";
import type { AgentConfig, ExperimentConfig } from "./config.js";

/**
 * A protocol adapter replaces the testbed's own agent protocol (JSON turns,
 * readiness, the proposal envelope) with an experiment's exact one — every
 * model input rendered by the adapter, plain-text or custom-parsed answers,
 * per-call seeds. The runner keeps the lifecycle (round-robin turns, the
 * fixed rounds, the audience of every message, the final proposal, the
 * evaluator); the adapter decides what each call says and how its answer is
 * read. Registered next to the evaluators (`config.protocol.adapter`), so the
 * generic core knows nothing about any task.
 *
 * Constraints an adapter may rely on (checked by checkConfig): fixed
 * discussion rounds, no vote, a required proposal with no format retries —
 * i.e. the discussion is a fixed schedule and the final call is one call.
 */

/** One accepted discussion message, as the adapter sees the run so far. */
export interface AdapterLogEntry {
  /** 1-based discussion turn. */
  turn: number;
  round: number;
  speakerId: string;
  /** Agent ids the message reached, the sender excluded; null: every other agent. */
  audience: string[] | null;
  text: string;
}

export interface AdapterContext {
  config: ExperimentConfig;
  agent: AgentConfig;
  log: readonly AdapterLogEntry[];
  /** The discussion turn (1-based) of a discussion call; the final call's turn is the discussion turns + 1. */
  turn: number;
  /** The round of a discussion call; null for the final call. */
  round: number | null;
  /** The replicate index of the run (config.protocol.replicate). */
  replicate: number;
  /** A length reminder to append (a regeneration after an over-length answer). */
  reminder?: string;
}

export interface AdapterCall {
  messages: ChatMessage[];
  /** The seed of this call (overrides the model reference's). */
  seed?: number;
  /** Locally counted prompt tokens, and how they were counted. */
  promptTokensCounted?: number;
  tokenCounter?: "tokenizer" | "approximate";
}

export type TurnDecision =
  | { kind: "message"; text: string; flags: string[]; visibleTokens: number }
  /** Ask again (same seed) with a reminder appended to the user text. */
  | { kind: "regenerate"; reminder: string; flags: string[] }
  /** A model failure: nothing is delivered, the run goes on. */
  | { kind: "silent"; reason: string; flags: string[] };

export type ProposalDecision =
  | { kind: "proposal"; proposal: unknown; extraText: boolean }
  | { kind: "model_failure"; reason: string }
  /** extraText: text around the (rejected) object, when one was found. */
  | { kind: "schema_failure"; error: string; extraText?: boolean };

export interface RawAnswer {
  text: string;
  finishReason: string | null;
}

export interface ProtocolAdapter {
  readonly id: string;
  /** Bumped with any change of a rendered text or a parsing rule. */
  readonly version: string;
  /** Validates config.protocol.params (strict). */
  readonly paramsSchema: z.ZodTypeAny;
  /** Problems with a config beyond the schemas (the roles, the schedule, …): a run is refused before its record exists. */
  checkConfig(config: ExperimentConfig): string[];
  /** Deterministic rendered fixtures; the protocol fingerprint of a run hashes them with the adapter's id and version. */
  fingerprintAssets(): unknown;
  renderDiscussionCall(ctx: AdapterContext): AdapterCall;
  /** The final call — or, when config.protocol.control is set, the control call (e.g. an oracle or a public-only call). */
  renderProposalCall(ctx: AdapterContext): AdapterCall;
  /** attempt: 0 for the first answer, 1 for the regeneration. */
  acceptTurn(answer: RawAnswer, ctx: AdapterContext, attempt: number): TurnDecision;
  acceptProposal(answer: RawAnswer, ctx: AdapterContext): ProposalDecision;
}
