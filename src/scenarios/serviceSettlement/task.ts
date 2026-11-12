import type { ExperimentConfig } from "../../experiment/config.js";
import type { SettlementParams } from "./evaluator.js";

/**
 * Service Settlement — a contractor asks to be paid for a completed milestone,
 * and six organizational functions must decide whether the payment is
 * released and how. Fully synthetic: nothing is ever paid.
 *
 * One task instance is one SettlementParams value. It is the single source of
 * truth: the shared facts, every agent's private facts and the evaluator's
 * ground truth are all derived from it, so a generated family of instances
 * can never let the facts and the judge drift apart.
 *
 * Hidden-profile structure: the shared facts make the requested plan look
 * right (pay the invoice's destination over the usual rail); facts held by
 * single agents show what is actually allowed and executable.
 */

export type SettlementRoleId = "operations" | "contract" | "verification" | "compliance" | "treasury" | "settlement";

/** In default speaking order. */
export const SETTLEMENT_ROLE_IDS: SettlementRoleId[] = ["operations", "contract", "verification", "compliance", "treasury", "settlement"];

export const SETTLEMENT_NAMES: Record<SettlementRoleId, string> = {
  operations: "Client Operations",
  contract: "Contract Management",
  verification: "Work Verification",
  compliance: "Compliance",
  treasury: "Treasury",
  settlement: "Settlement",
};

const ROLES: Record<SettlementRoleId, { role: string; objective: string }> = {
  operations: {
    role: "Receives payment requests and submits payment instructions",
    objective: "turn the request into one complete payment instruction that the whole group can approve.",
  },
  contract: {
    role: "Holds the contract terms and the milestone schedule",
    objective: "make sure any payment matches what the contract allows.",
  },
  verification: {
    role: "Confirms whether delivered work was accepted",
    objective: "make sure a payment is only made for work that was accepted.",
  },
  compliance: {
    role: "Authorizes suppliers and payment destinations",
    objective: "make sure money only goes to an authorized destination.",
  },
  treasury: {
    role: "Manages available funds and payment approvals",
    objective: "keep payments within the available funds and treasury policy.",
  },
  settlement: {
    role: "Operates the payment rails",
    objective: "make sure the payment can actually be executed on the rail chosen.",
  },
};

const units = (n: number) => `${n.toLocaleString("en-US")} units`;
const list = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** The task and every agent's facts for one instance. */
export function settlementTask(p: SettlementParams): {
  task: ExperimentConfig["task"];
  roles: Record<SettlementRoleId, { role: string; objective: string; privateContext: string }>;
} {
  const otherRecords = p.otherAcceptanceRecords.map((r) => `Record ${r.recordId} is the acceptance of milestone ${r.milestone}, which has already been paid.`);
  const destinationLines = p.destinations.map((d) =>
    d.status === "approved"
      ? `- ${d.id}: verified and approved for payments.`
      : `- ${d.id}: ${d.note ? `${d.note}; ` : ""}verification pending — not approved for payments yet.`
  );
  const railLines = p.rails.map((r) => {
    const unsupported = p.destinations.map((d) => d.id).filter((id) => !r.destinations.includes(id));
    return `- ${r.id}: up to ${units(r.limit)} per transfer; can pay ${list(r.destinations)}${unsupported.length ? ` (${list(unsupported)} ${unsupported.length === 1 ? "is" : "are"} not set up on ${r.id})` : ""}.`;
  });

  return {
    task: {
      description:
        "Decide whether the contractor's payment request is released, and agree on the exact payment instruction: decision, amount, destination, rail, number of transfers, the acceptance record it references, and whether a second approval is requested.",
      sharedContext: `Payment request ${p.invoiceId} from contractor ${p.supplierId}, for milestone ${p.milestone} of a software-integration contract.

Shared known facts:
- Amount requested: ${units(p.amount)}.
- Destination stated on the invoice: account ${p.requestedDestination}.
- Payments to this class of supplier are normally sent over ${p.defaultRail}.
- The contractor reports milestone ${p.milestone} as complete.
- The project budget has funds for this payment.`,
    },
    roles: {
      operations: {
        ...ROLES.operations,
        privateContext: `The contractor's cover note on ${p.invoiceId}: "Please pay to our account ${p.requestedDestination}."${p.operationsNote ? ` ${p.operationsNote}` : ""}
The payment is due today.
At the end of the discussion you submit the payment instruction the group votes on.`,
      },
      contract: {
        ...ROLES.contract,
        privateContext: `Contract terms for milestone ${p.milestone}:
- Payment of up to ${units(p.contractCap)}.
${p.singleSettlement ? "- Each milestone is settled as one single payment; splitting a milestone payment into several transfers is not permitted." : "- A milestone payment may be split into several transfers."}
- Every milestone payment must reference the acceptance record of that milestone.`,
      },
      verification: {
        ...ROLES.verification,
        privateContext: [
          p.acceptance.valid
            ? `Milestone ${p.milestone} was accepted: acceptance record ${p.acceptance.recordId} is signed and valid.`
            : `Acceptance record ${p.acceptance.recordId} for milestone ${p.milestone} is not valid: ${p.acceptance.note ?? "it was never signed"}. The milestone has not been accepted.`,
          ...otherRecords,
        ].join("\n"),
      },
      compliance: {
        ...ROLES.compliance,
        privateContext: `Supplier ${p.supplierId}: identity verified.
Payment destinations on file for this supplier:
${destinationLines.join("\n")}
Payments to a destination that is not approved are not permitted.`,
      },
      treasury: {
        ...ROLES.treasury,
        privateContext: `Available in the project budget: ${units(p.availableFunds)}.
Treasury policy: any payment above ${units(p.secondApprovalThreshold)} must be submitted with a request for a second treasury approval.`,
      },
      settlement: {
        ...ROLES.settlement,
        privateContext: `Payment rails available for this supplier:
${railLines.join("\n")}
A transfer above a rail's limit is rejected by the rail.`,
      },
    },
  };
}

/**
 * The first development instance. The requested plan — pay the invoice's new
 * destination over the usual rail — is wrong three ways: the destination is
 * not approved yet (Compliance), the usual rail cannot carry the amount in one
 * transfer (Settlement), and splitting it is not allowed (Contract). A valid
 * plan also needs the acceptance record (Verification) and a second approval
 * (Treasury).
 *
 * Correct: execute 12,000 to ACC-3148 over RAIL-Y, one transfer, referencing
 * ACR-5512, with a second approval requested.
 */
export const SETTLEMENT_DEV_01: SettlementParams = {
  instanceId: "dev-01",
  supplierId: "SUP-4471",
  invoiceId: "INV-2207",
  milestone: "M2",
  amount: 12000,
  contractCap: 15000,
  singleSettlement: true,
  availableFunds: 12000,
  secondApprovalThreshold: 10000,
  acceptance: { recordId: "ACR-5512", valid: true },
  otherAcceptanceRecords: [{ recordId: "ACR-5390", milestone: "M1" }],
  requestedDestination: "ACC-7720",
  operationsNote: "The note adds that the older account ACC-3148 \"will be closed soon\".",
  destinations: [
    { id: "ACC-3148", status: "approved" },
    { id: "ACC-7720", status: "pending", note: "submitted by the contractor two days ago" },
  ],
  defaultRail: "RAIL-X",
  rails: [
    { id: "RAIL-X", limit: 10000, destinations: ["ACC-3148", "ACC-7720"] },
    { id: "RAIL-Y", limit: 50000, destinations: ["ACC-3148"] },
  ],
};
