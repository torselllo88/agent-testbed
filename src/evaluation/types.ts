import type { z } from "zod";

export interface ConstraintCheck {
  passed: boolean;
  detail: string;
}

export interface EvaluationResult {
  outcome: "SUCCESS" | "MISSION_FAILURE";
  checks: Record<string, ConstraintCheck>;
  /** Names of the failed checks, in check order. */
  violated: string[];
  /** Derived quantities the checks were computed from (e.g. available power) — for the trace. */
  derived?: Record<string, unknown>;
  /**
   * Optional scenario-defined class of the outcome, finer than SUCCESS /
   * MISSION_FAILURE (e.g. "correct", "unsafe", "overcautious") — reported in
   * the metrics and the batch CSV as is.
   */
  classification?: string;
}

/**
 * One task-relevant proposition of an instance, TRUE for that instance — what
 * the exposure detector (src/analysis/exposure.ts) looks for in messages.
 */
export interface TaskFact {
  /** Stable within the instance, e.g. "compliance.destination.ACC-7720". */
  id: string;
  /** fact: someone's private fact; derived: a conclusion combining facts; solution: the complete decision (solution relay). */
  kind: "fact" | "derived" | "solution";
  /** The agent whose private information it is (kind "fact"); null otherwise. */
  source: string | null;
  /** The true proposition, in plain words. */
  statement: string;
}

/**
 * Scenario-specific, deterministic judge of a committed proposal. It is
 * independent of the agents and is never consulted during the run: the
 * runtime only uses `proposalSchema` (structure, not correctness) before
 * voting, and calls `evaluate` after commit — and, once the outcome is
 * decided, on every other frozen proposal (first-proposal correctness), where
 * it can no longer change anything. `evaluate` must therefore be pure.
 */
export interface ScenarioEvaluator<P = unknown, Params = unknown> {
  readonly id: string;
  /** Bump whenever the rules change — recorded with every evaluation. */
  readonly version: string;
  readonly description: string;
  /** Structure the committed proposal must have. Schema-only: must not encode any success constraint. */
  readonly proposalSchema: z.ZodType<P, z.ZodTypeDef, unknown>;
  readonly paramsSchema: z.ZodType<Params, z.ZodTypeDef, unknown>;
  evaluate(proposal: P, params: Params): EvaluationResult;
  /**
   * Optional: the closed list of task-relevant propositions of an instance,
   * for the exposure detector. Built from the same params as the facts and
   * the ground truth. Pure; never used during a run.
   */
  facts?(params: Params): TaskFact[];
}
