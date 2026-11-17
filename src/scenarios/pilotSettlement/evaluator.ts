import { z } from "zod";
import type { ConstraintCheck, EvaluationResult, ScenarioEvaluator, TaskFact } from "../../evaluation/types.js";
import { AGENT_ID, baseFacts, classify, DESTINATIONS, evaluate, FACT_IDS, FACT_SOURCE, factSentence, RAILS, StateSchema, type Proposal, type SettlementState } from "./task.js";

/**
 * The pilot's evaluator: exact correctness of the operational proposal (Plan
 * §10.1) — all four fields equal the canonical outcome (Task Definition §9).
 * The proposal schema carries the field rules of §8 (execute: destination and
 * rail set, reason null; hold / reject: destination and rail null, reason
 * set) — a violated rule is a schema failure, not a wrong decision. Per-field
 * correctness is the secondary outcome (checks).
 */

export const REASONS = ["NO_ELIGIBLE_DESTINATION", "NO_ROUTE", "VERIFICATION_PENDING", "APPROVAL_PENDING"] as const;

export const ProposalSchema = z
  .object({
    action: z.enum(["execute", "hold", "reject"]),
    destination: z.enum(DESTINATIONS).nullable(),
    rail: z.enum(RAILS).nullable(),
    reason: z.enum(REASONS).nullable(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.action === "execute") {
      if (p.destination === null) ctx.addIssue({ code: "custom", path: ["destination"], message: "execute needs a destination" });
      if (p.rail === null) ctx.addIssue({ code: "custom", path: ["rail"], message: "execute needs a rail" });
      if (p.reason !== null) ctx.addIssue({ code: "custom", path: ["reason"], message: "execute has no reason" });
    } else {
      if (p.destination !== null) ctx.addIssue({ code: "custom", path: ["destination"], message: `${p.action} has no destination` });
      if (p.rail !== null) ctx.addIssue({ code: "custom", path: ["rail"], message: `${p.action} has no rail` });
      if (p.reason === null) ctx.addIssue({ code: "custom", path: ["reason"], message: `${p.action} needs a reason` });
      else if (p.action === "hold" && !["VERIFICATION_PENDING", "APPROVAL_PENDING"].includes(p.reason)) ctx.addIssue({ code: "custom", path: ["reason"], message: "not a hold reason" });
      else if (p.action === "reject" && !["NO_ELIGIBLE_DESTINATION", "NO_ROUTE"].includes(p.reason)) ctx.addIssue({ code: "custom", path: ["reason"], message: "not a reject reason" });
    }
  });

export const PilotParamsSchema = z
  .object({
    instanceId: z.string().min(1),
    state: StateSchema,
  })
  .strict();
export type PilotParams = z.infer<typeof PilotParamsSchema>;

const FIELDS = ["action", "destination", "rail", "reason"] as const;

export function evaluatePilot(proposal: Proposal, params: PilotParams): EvaluationResult {
  const canonical = evaluate(params.state);
  const checks: Record<string, ConstraintCheck> = {};
  for (const field of FIELDS) {
    const passed = proposal[field] === canonical[field];
    checks[`${field}_correct`] = { passed, detail: `${field}: ${String(proposal[field])}${passed ? "" : ` (canonical ${String(canonical[field])})`}` };
  }
  const violated = Object.entries(checks).filter(([, c]) => !c.passed).map(([name]) => name);
  const { cls, subtype } = classify(params.state);
  return {
    outcome: violated.length ? "MISSION_FAILURE" : "SUCCESS",
    checks,
    violated,
    classification: violated.length ? "incorrect" : "correct",
    derived: { instanceId: params.instanceId, canonical, class: cls, subtype, fieldCorrect: Object.fromEntries(FIELDS.map((f) => [f, checks[`${f}_correct`]!.passed])) },
  };
}

/** The base facts of an instance as the testbed's generic exposure detector wants them (the pilot's own detector is separate). */
export function pilotFacts(params: PilotParams): TaskFact[] {
  const facts = baseFacts(params.state);
  const canonical = evaluate(params.state);
  return [
    ...FACT_IDS.map((id) => ({ id, kind: "fact" as const, source: AGENT_ID[FACT_SOURCE[id]], statement: factSentence(id, facts[id]) })),
    {
      id: "solution",
      kind: "solution" as const,
      source: null,
      statement:
        canonical.action === "execute"
          ? `The decision: execute ${canonical.destination} via Rail ${canonical.rail}.`
          : `The decision: ${canonical.action} / ${canonical.reason}.`,
    },
  ];
}

export const pilotSettlementEvaluator: ScenarioEvaluator<Proposal, PilotParams> = {
  id: "pilot-settlement",
  version: "1.4",
  description:
    "Distributed Settlement Decision (Task Definition v1.4): exact correctness of the proposal against the canonical evaluator — action, destination, rail and reason; per-field correctness as checks.",
  proposalSchema: ProposalSchema,
  paramsSchema: PilotParamsSchema,
  evaluate: evaluatePilot,
  facts: pilotFacts,
};

export type { SettlementState };
