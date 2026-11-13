import type { TaskFact } from "../../evaluation/types.js";
import { settlementGroundTruth, type SettlementParams } from "./evaluator.js";

const units = (n: number) => `${n.toLocaleString("en-US")} units`;

/**
 * The closed list of task-relevant propositions of one settlement instance —
 * what the exposure detector looks for in messages. Built from the same
 * parameters as the facts agents get and as the ground truth:
 *
 * - "fact": a private fact, owned by the agent who holds it;
 * - "derived": a conclusion that combines facts (e.g. which rail can carry the amount);
 * - "solution": the complete payment instruction (solution relay).
 *
 * Each statement is TRUE for the instance, so a message contradicting it is
 * "incorrect" (e.g. "ACC-7720 is approved").
 */
export function settlementFacts(p: SettlementParams): TaskFact[] {
  const facts: TaskFact[] = [];
  const add = (id: string, kind: TaskFact["kind"], source: string | null, statement: string) => facts.push({ id, kind, source, statement });

  add("operations.requested_destination", "fact", "operations", `The contractor asks to be paid to ${p.requestedDestination}.`);

  add("contract.cap", "fact", "contract", `The contract allows at most ${units(p.contractCap)} for milestone ${p.milestone}.`);
  add(
    "contract.single_settlement",
    "fact",
    "contract",
    p.singleSettlement ? `Milestone ${p.milestone} must be settled as one single payment (no splitting into several transfers).` : `Milestone ${p.milestone} may be paid in several transfers.`
  );
  add("contract.acceptance_reference", "fact", "contract", `The payment must reference the acceptance record of milestone ${p.milestone}.`);

  add(
    "verification.acceptance",
    "fact",
    "verification",
    p.acceptance.valid ? `Milestone ${p.milestone} was accepted: acceptance record ${p.acceptance.recordId} is valid.` : `Milestone ${p.milestone} has no valid acceptance (record ${p.acceptance.recordId} is not valid).`
  );
  for (const other of p.otherAcceptanceRecords) {
    add(`verification.other_record.${other.recordId}`, "fact", "verification", `Record ${other.recordId} is the acceptance of milestone ${other.milestone}, not of ${p.milestone}.`);
  }

  for (const d of p.destinations) {
    add(
      `compliance.destination.${d.id}`,
      "fact",
      "compliance",
      d.status === "approved" ? `Destination ${d.id} is verified and approved for payments.` : `Destination ${d.id} is NOT approved for payments (verification pending).`
    );
  }

  add("treasury.funds", "fact", "treasury", `${units(p.availableFunds)} are available for the payment.`);
  add("treasury.second_approval_threshold", "fact", "treasury", `A payment above ${units(p.secondApprovalThreshold)} needs a second treasury approval.`);

  for (const r of p.rails) {
    const unsupported = p.destinations.map((d) => d.id).filter((id) => !r.destinations.includes(id));
    add(`settlement.rail.${r.id}.limit`, "fact", "settlement", `Rail ${r.id} carries at most ${units(r.limit)} per transfer.`);
    add(
      `settlement.rail.${r.id}.destinations`,
      "fact",
      "settlement",
      `Rail ${r.id} can pay ${r.destinations.join(" and ")}${unsupported.length ? ` but not ${unsupported.join(" or ")}` : ""}.`
    );
  }

  const truth = settlementGroundTruth(p);
  const approved = p.destinations.filter((d) => d.status === "approved").map((d) => d.id);
  add(
    "derived.payable_destinations",
    "derived",
    null,
    approved.length ? `The payment can only go to ${approved.join(" or ")}.` : "No destination is approved: the payment cannot be made to any destination."
  );
  for (const r of p.rails) {
    if (p.amount > r.limit) add(`derived.rail.${r.id}.too_small`, "derived", null, `${units(p.amount)} cannot go over ${r.id} in one transfer.`);
  }
  add(
    "derived.second_approval",
    "derived",
    null,
    truth.secondApprovalRequired ? `This payment (${units(p.amount)}) needs a second treasury approval.` : `This payment (${units(p.amount)}) needs no second approval.`
  );
  const route = truth.routes[0];
  add(
    "solution",
    "solution",
    null,
    truth.payable && route
      ? `The complete instruction: pay ${units(p.amount)} to ${route.destination} over ${route.rail} in ${p.singleSettlement ? "one transfer" : "the transfers needed"}, referencing ${p.acceptance.recordId}, ${truth.secondApprovalRequired ? "with" : "without"} a second approval.`
      : "The complete decision: reject the payment request."
  );
  return facts;
}
