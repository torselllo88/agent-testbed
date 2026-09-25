/**
 * The experiment lifecycle as an explicit state machine. The run loop may
 * only move between phases along these edges; anything else is a bug, and
 * throws rather than silently continuing.
 *
 *   INITIALIZING -> DISCUSSION -> PROPOSAL -> VOTING -> COMMITTED -> EVALUATION -> FINISHED
 *                      ^             |          |
 *                      +-------------+----------+   (failed attempt, budget left)
 *
 * Any non-terminal phase may also go straight to FINISHED (hard limit, error, stop).
 */
export const Phase = {
  INITIALIZING: "INITIALIZING",
  DISCUSSION: "DISCUSSION",
  PROPOSAL: "PROPOSAL",
  VOTING: "VOTING",
  COMMITTED: "COMMITTED",
  EVALUATION: "EVALUATION",
  FINISHED: "FINISHED",
} as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

const TRANSITIONS: Record<Phase, Phase[]> = {
  INITIALIZING: [Phase.DISCUSSION, Phase.FINISHED],
  DISCUSSION: [Phase.PROPOSAL, Phase.FINISHED],
  // Back to DISCUSSION when the proposer declines and attempts remain.
  PROPOSAL: [Phase.VOTING, Phase.DISCUSSION, Phase.FINISHED],
  VOTING: [Phase.COMMITTED, Phase.DISCUSSION, Phase.FINISHED],
  COMMITTED: [Phase.EVALUATION, Phase.FINISHED],
  EVALUATION: [Phase.FINISHED],
  FINISHED: [],
};

export class IllegalPhaseTransitionError extends Error {
  constructor(from: Phase, to: Phase) {
    super(`Illegal phase transition ${from} -> ${to}`);
    this.name = "IllegalPhaseTransitionError";
  }
}

export function assertTransition(from: Phase, to: Phase): void {
  if (!TRANSITIONS[from].includes(to)) throw new IllegalPhaseTransitionError(from, to);
}
