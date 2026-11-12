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
}
