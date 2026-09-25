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
}

/**
 * Scenario-specific, deterministic judge of a committed proposal. It is
 * independent of the agents and is never consulted during the run: the
 * runtime only uses `proposalSchema` (structure, not correctness) before
 * voting, and calls `evaluate` once, after commit.
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
