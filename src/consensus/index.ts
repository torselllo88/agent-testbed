import type { ConsensusConfig } from "../experiment/config.js";

/** An invalid vote (unparseable after retries) is recorded as such and never counts as approval. */
export type VoteValue = "APPROVE" | "REJECT" | "INVALID";

export interface CastVote {
  agentId: string;
  vote: VoteValue;
  reason: string;
}

export interface ConsensusResult {
  rule: string;
  reached: boolean;
  approvals: number;
  rejections: number;
  invalid: number;
  required: number;
  eligible: number;
}

/**
 * Decides whether a set of votes on ONE proposal meets the decision
 * criterion. Agreement only — correctness is the evaluator's job. Future
 * rules (leader decision, weighted expertise, domain veto) implement the
 * same interface and may read per-agent config.
 */
export interface ConsensusRule {
  readonly id: string;
  decide(votes: CastVote[], eligibleAgentIds: string[]): ConsensusResult;
}

function thresholdRule(id: string, required: (eligible: number) => number): ConsensusRule {
  return {
    id,
    decide(votes, eligibleAgentIds) {
      const eligible = eligibleAgentIds.length;
      const counted = votes.filter((v) => eligibleAgentIds.includes(v.agentId));
      const approvals = counted.filter((v) => v.vote === "APPROVE").length;
      const rejections = counted.filter((v) => v.vote === "REJECT").length;
      const invalid = counted.filter((v) => v.vote === "INVALID").length;
      const needed = required(eligible);
      return { rule: id, reached: approvals >= needed, approvals, rejections, invalid, required: needed, eligible };
    },
  };
}

/** Every eligible agent must approve. */
export const unanimity = thresholdRule("unanimity", (eligible) => eligible);
/** Strictly more than half of the eligible agents must approve (a tie fails). */
export const majority = thresholdRule("majority", (eligible) => Math.floor(eligible / 2) + 1);

/** No vote: the proposer's proposal is the decision. The runner never asks this rule to decide. */
export const none: ConsensusRule = {
  id: "none",
  decide() {
    throw new Error('consensus rule "none" takes no votes');
  },
};

export const CONSENSUS_RULES = { unanimity, majority, none } as const;

export function createConsensusRule(config: ConsensusConfig): ConsensusRule {
  return CONSENSUS_RULES[config.rule];
}
