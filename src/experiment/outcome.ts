/**
 * Every way a run can end. Kept deliberately fine-grained: a malformed
 * proposal, a provider outage, a failure to agree, and an agreed plan that
 * fails the evaluator are materially different research outcomes, even where
 * the UI groups them under one broad status.
 */
export const OUTCOMES = {
  // Task: a committed proposal reached the evaluator.
  SUCCESS: { category: "task", status: "SUCCESS" },
  MISSION_FAILURE: { category: "task", status: "FAILURE" },
  // Coordination: the agents never committed to a proposal.
  CONSENSUS_FAILURE: { category: "coordination", status: "FAILURE" },
  NO_PROPOSAL: { category: "coordination", status: "FAILURE" },
  // Protocol: the proposer could not produce a machine-evaluable proposal.
  PROPOSAL_PARSE_FAILED: { category: "protocol", status: "FAILURE" },
  PROPOSAL_INVALID: { category: "protocol", status: "FAILURE" },
  // Budget: a hard limit ended the run.
  TOKEN_BUDGET_EXCEEDED: { category: "budget", status: "FAILURE" },
  COST_LIMIT_EXCEEDED: { category: "budget", status: "FAILURE" },
  TIMEOUT: { category: "budget", status: "FAILURE" },
  TURN_LIMIT_EXCEEDED: { category: "budget", status: "FAILURE" },
  // Infrastructure: the run could not be carried out as configured.
  PROVIDER_ERROR: { category: "infrastructure", status: "ABORTED" },
  ERROR: { category: "infrastructure", status: "ABORTED" },
  INTERRUPTED: { category: "infrastructure", status: "ABORTED" },
  // Operator.
  STOPPED_BY_OPERATOR: { category: "operator", status: "ABORTED" },
} as const;

export type Outcome = keyof typeof OUTCOMES;
export type OutcomeCategory = (typeof OUTCOMES)[Outcome]["category"];
export type RunStatus = (typeof OUTCOMES)[Outcome]["status"];

export interface Termination {
  outcome: Outcome;
  category: OutcomeCategory;
  status: RunStatus;
  /** Human-readable reason plus machine-readable specifics (which limit, which error, ...). */
  reason: string;
  detail?: Record<string, unknown>;
}

export function termination(outcome: Outcome, reason: string, detail?: Record<string, unknown>): Termination {
  const { category, status } = OUTCOMES[outcome];
  return { outcome, category, status, reason, ...(detail ? { detail } : {}) };
}

/** Thrown inside the runtime to unwind to the run loop with a specific outcome. */
export class TerminateRun extends Error {
  constructor(public readonly termination: Termination) {
    super(termination.reason);
    this.name = "TerminateRun";
  }
}
