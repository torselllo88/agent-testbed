import { z } from "zod";
import { canonicalJson, sha256 } from "../../experiment/config.js";

/**
 * Distributed Settlement Decision — Task Definition v1.4 (the pilot task): the
 * state, the canonical evaluator (§9), the classes (§10), the canonical facts
 * and role cards (§5, §6) and the minimal-sufficiency metadata (Exposure &
 * Instance Metadata v1.4, E7). A port of the bundle's reference
 * tools/settlement_task.py; where the two disagree, the Task Definition wins
 * and this file is the bug (tests/scenarios/pilotSettlement.test.ts compares
 * every instance with the reference outputs).
 */

export const DESTINATIONS = ["D1", "D2"] as const;
export const RAILS = ["A", "B"] as const;
export const ROUTES = ["D1/A", "D1/B", "D2/A", "D2/B"] as const;
export const DATA_ROLES = ["Contract", "Compliance", "Settlement", "Verification", "Treasury"] as const;
export const AGENTS = ["Operations", ...DATA_ROLES] as const;
export type Destination = (typeof DESTINATIONS)[number];
export type Rail = (typeof RAILS)[number];
export type Route = (typeof ROUTES)[number];
export type RoleName = (typeof AGENTS)[number];
export const AMOUNT = 12000;
export const MILESTONE = "M-204";

/** Testbed agent ids are lowercase slugs; the task's role names are the display names. */
export const AGENT_ID: Record<RoleName, string> = {
  Operations: "operations",
  Contract: "contract",
  Compliance: "compliance",
  Settlement: "settlement",
  Verification: "verification",
  Treasury: "treasury",
};
export const ROLE_OF_ID: Record<string, RoleName> = Object.fromEntries(Object.entries(AGENT_ID).map(([role, id]) => [id, role as RoleName]));

export const StateSchema = z
  .object({
    requested_destination: z.enum(DESTINATIONS),
    permitted_destinations: z.array(z.enum(DESTINATIONS)),
    authorized_destinations: z.array(z.enum(DESTINATIONS)),
    supported_routes: z.array(z.enum(ROUTES)),
    verification_status: z.enum(["accepted", "pending"]),
    approval_status: z.enum(["approved", "pending"]),
  })
  .strict()
  .transform((s) => ({
    ...s,
    permitted_destinations: [...new Set(s.permitted_destinations)].sort(),
    authorized_destinations: [...new Set(s.authorized_destinations)].sort(),
    supported_routes: [...new Set(s.supported_routes)].sort((a, b) => ROUTES.indexOf(a) - ROUTES.indexOf(b)),
  }));
export type SettlementState = z.infer<typeof StateSchema>;

export const FACT_IDS = [
  "contract.permits.D1",
  "contract.permits.D2",
  "compliance.authorizes.D1",
  "compliance.authorizes.D2",
  "settlement.supports.D1.A",
  "settlement.supports.D1.B",
  "settlement.supports.D2.A",
  "settlement.supports.D2.B",
  "verification.status",
  "treasury.status",
] as const;
export type FactId = (typeof FACT_IDS)[number];
export type FactValue = boolean | "accepted" | "pending" | "approved";
export const FACT_SOURCE: Record<FactId, RoleName> = {
  "contract.permits.D1": "Contract",
  "contract.permits.D2": "Contract",
  "compliance.authorizes.D1": "Compliance",
  "compliance.authorizes.D2": "Compliance",
  "settlement.supports.D1.A": "Settlement",
  "settlement.supports.D1.B": "Settlement",
  "settlement.supports.D2.A": "Settlement",
  "settlement.supports.D2.B": "Settlement",
  "verification.status": "Verification",
  "treasury.status": "Treasury",
};

export interface Proposal {
  action: "execute" | "hold" | "reject";
  destination: Destination | null;
  rail: Rail | null;
  reason: "NO_ELIGIBLE_DESTINATION" | "NO_ROUTE" | "VERIFICATION_PENDING" | "APPROVAL_PENDING" | null;
}

/** sha256 of the state as the bundle hashes it (json.dumps, sorted keys, no spaces). */
export function stateHash(s: SettlementState): string {
  return `sha256:${sha256(canonicalJson(s))}`;
}

export function baseFacts(s: SettlementState): Record<FactId, FactValue> {
  const f = {} as Record<FactId, FactValue>;
  for (const d of DESTINATIONS) {
    f[`contract.permits.${d}`] = s.permitted_destinations.includes(d);
    f[`compliance.authorizes.${d}`] = s.authorized_destinations.includes(d);
    for (const r of RAILS) f[`settlement.supports.${d}.${r}`] = s.supported_routes.includes(`${d}/${r}`);
  }
  f["verification.status"] = s.verification_status;
  f["treasury.status"] = s.approval_status;
  return f;
}

const hasRoute = (s: SettlementState, d: Destination) => s.supported_routes.includes(`${d}/A`) || s.supported_routes.includes(`${d}/B`);
export const eligible = (s: SettlementState) => DESTINATIONS.filter((d) => s.permitted_destinations.includes(d) && s.authorized_destinations.includes(d));
export const executable = (s: SettlementState) => eligible(s).filter((d) => hasRoute(s, d));

/** The canonical evaluator (Task Definition §9). */
export function evaluate(s: SettlementState): Proposal {
  if (!eligible(s).length) return { action: "reject", destination: null, rail: null, reason: "NO_ELIGIBLE_DESTINATION" };
  const ex = executable(s);
  if (!ex.length) return { action: "reject", destination: null, rail: null, reason: "NO_ROUTE" };
  if (s.verification_status === "pending") return { action: "hold", destination: null, rail: null, reason: "VERIFICATION_PENDING" };
  if (s.approval_status === "pending") return { action: "hold", destination: null, rail: null, reason: "APPROVAL_PENDING" };
  const q = s.requested_destination;
  const d = ex.includes(q) ? q : ex.find((x) => x !== q)!;
  return { action: "execute", destination: d, rail: s.supported_routes.includes(`${d}/A`) ? "A" : "B", reason: null };
}

export type TaskClass = "A" | "B" | "C" | "R-ELIG" | "R-ROUTE" | "excluded";

/** The task class and subtype (§10); "excluded" with the reason for states the generator does not produce. */
export function classify(s: SettlementState): { cls: TaskClass; subtype: string | null } {
  if (!s.permitted_destinations.length || !s.authorized_destinations.length || !s.supported_routes.length) return { cls: "excluded", subtype: "empty_set" };
  const vP = s.verification_status === "pending";
  const tP = s.approval_status === "pending";
  if (vP && tP) return { cls: "excluded", subtype: "double_pending" };
  const el = eligible(s);
  const ex = executable(s);
  const clean = !vP && !tP;
  if (!el.length) return clean ? { cls: "R-ELIG", subtype: null } : { cls: "excluded", subtype: "reject_with_pending" };
  if (!ex.length) return clean ? { cls: "R-ROUTE", subtype: null } : { cls: "excluded", subtype: "reject_with_pending" };
  if (!clean) return { cls: "C", subtype: vP ? "verification" : "approval" };
  const q = s.requested_destination;
  if (ex.includes(q)) return { cls: "A", subtype: `rail_${evaluate(s).rail}` };
  const fails: string[] = [];
  if (!s.permitted_destinations.includes(q)) fails.push("contract");
  if (!s.authorized_destinations.includes(q)) fails.push("compliance");
  if (!hasRoute(s, q)) fails.push("route");
  return fails.length === 1 ? { cls: "B", subtype: fails[0]! } : { cls: "excluded", subtype: "B_multiple_reasons" };
}

// ---------------------------------------------------------------- public state space and minimal sufficient sets (E1, E7)

function subsets<T>(items: readonly T[], allowEmpty: boolean): T[][] {
  const out: T[][] = [];
  for (let m = 0; m < 1 << items.length; m++) {
    const set = items.filter((_, i) => m & (1 << i));
    if (set.length || allowEmpty) out.push(set);
  }
  return out;
}

/** Orders sets as itertools.combinations enumerates them: shorter first, then lexicographically by element index. */
function byCombination<T>(index: (item: T) => number): (a: T[], b: T[]) => number {
  return (a, b) => {
    if (a.length !== b.length) return a.length - b.length;
    for (let i = 0; i < a.length; i++) {
      const d = index(a[i]!) - index(b[i]!);
      if (d) return d;
    }
    return 0;
  };
}

const spaceCache = new Map<Destination, Array<{ facts: Record<FactId, FactValue>; outcome: string }>>();

/** Every state the public semantics allow (§3.1) with this requested destination: 1024 states, as facts and outcome. */
export function publicStateSpace(requested: Destination) {
  let space = spaceCache.get(requested);
  if (!space) {
    space = [];
    for (const permitted of subsets(DESTINATIONS, true))
      for (const authorized of subsets(DESTINATIONS, true))
        for (const routes of subsets(ROUTES, true))
          for (const verification of ["accepted", "pending"] as const)
            for (const approval of ["approved", "pending"] as const) {
              const s: SettlementState = { requested_destination: requested, permitted_destinations: permitted, authorized_destinations: authorized, supported_routes: routes, verification_status: verification, approval_status: approval };
              space.push({ facts: baseFacts(s), outcome: JSON.stringify(evaluate(s)) });
            }
    spaceCache.set(requested, space);
  }
  return space;
}

export interface InstanceMetadata {
  class: TaskClass;
  subtype: string | null;
  canonical_outcome: Proposal;
  b_failure_reason: string | null;
  minimal_fact_sets: string[][];
  min_fact_set_size: number;
  relevant_facts: FactId[];
  core_facts: FactId[];
  minimal_role_sets: RoleName[][];
}

const fmt = (v: FactValue) => (typeof v === "boolean" ? String(v) : v);

/** E7: minimal fact sets and role sets that fix the canonical outcome over the public state space. */
export function metadata(s: SettlementState): InstanceMetadata {
  const space = publicStateSpace(s.requested_destination);
  const target = JSON.stringify(evaluate(s));
  const own = baseFacts(s);
  const sufficientFacts = (mask: number) => space.every((st) => FACT_IDS.some((f, i) => mask & (1 << i) && st.facts[f] !== own[f]) || st.outcome === target);
  const suff: number[] = [];
  for (let m = 0; m < 1 << FACT_IDS.length; m++) if (sufficientFacts(m)) suff.push(m);
  const minimalMasks = suff.filter((m) => !suff.some((o) => o !== m && (o & m) === o));
  // In the reference's order: by size, then lexicographically by fact index (itertools.combinations).
  const factSets = minimalMasks.map((m) => FACT_IDS.filter((_, i) => m & (1 << i))).sort(byCombination((f) => FACT_IDS.indexOf(f)));

  const sufficientRoles = (roles: readonly RoleName[]) => space.every((st) => FACT_IDS.some((f) => roles.includes(FACT_SOURCE[f]) && st.facts[f] !== own[f]) || st.outcome === target);
  const roleSuff = subsets(DATA_ROLES, true).filter(sufficientRoles);
  const roleSets = roleSuff.filter((r) => !roleSuff.some((o) => o.length < r.length && o.every((x) => r.includes(x)))).sort(byCombination((r) => DATA_ROLES.indexOf(r)));

  const { cls, subtype } = classify(s);
  return {
    class: cls,
    subtype,
    canonical_outcome: evaluate(s),
    b_failure_reason: cls === "B" ? subtype : null,
    minimal_fact_sets: factSets.map((set) => set.map((f) => `${f}=${fmt(own[f])}`)),
    min_fact_set_size: Math.min(...factSets.map((set) => set.length)),
    relevant_facts: FACT_IDS.filter((f) => factSets.some((set) => set.includes(f))),
    core_facts: FACT_IDS.filter((f) => factSets.every((set) => set.includes(f))),
    minimal_role_sets: roleSets.map((r) => [...r]),
  };
}

// ---------------------------------------------------------------- canonical sentences and role cards (§5, §6)

const routeText = (r: string) => `${r.slice(0, 2)} / Rail ${r.slice(3)}`;

/** Task Definition §6: every fact of the role as a canonical sentence, true first; "You hold no private task information." for Operations. */
export function roleCard(s: SettlementState, role: RoleName): string {
  const lines = [`Your private information (${role}):`];
  switch (role) {
    case "Contract": {
      const yes = DESTINATIONS.filter((d) => s.permitted_destinations.includes(d));
      const no = DESTINATIONS.filter((d) => !s.permitted_destinations.includes(d));
      lines.push(...yes.map((d) => `Contract permits ${d}.`), ...no.map((d) => `Contract does not permit ${d}.`), "This list is complete.");
      break;
    }
    case "Compliance": {
      const yes = DESTINATIONS.filter((d) => s.authorized_destinations.includes(d));
      const no = DESTINATIONS.filter((d) => !s.authorized_destinations.includes(d));
      lines.push(...yes.map((d) => `Compliance authorizes ${d}.`), ...no.map((d) => `Compliance does not authorize ${d}.`), "This list is complete.");
      break;
    }
    case "Settlement": {
      const yes = ROUTES.filter((r) => s.supported_routes.includes(r));
      const no = ROUTES.filter((r) => !s.supported_routes.includes(r));
      lines.push(...yes.map((r) => `Settlement supports ${routeText(r)}.`), ...no.map((r) => `Settlement does not support ${routeText(r)}.`), "This list is complete.");
      break;
    }
    case "Verification":
      lines.push(`Verification of ${MILESTONE}: ${s.verification_status}.`);
      break;
    case "Treasury":
      lines.push(`Treasury approval: ${s.approval_status}.`);
      break;
    case "Operations":
      return "You hold no private task information.";
  }
  return lines.join("\n");
}

/** The canonical sentence of a fact for a value (§5). */
export function factSentence(fact: FactId, value: FactValue): string {
  const [, , d, r] = fact.split(".");
  switch (FACT_SOURCE[fact]) {
    case "Contract":
      return value ? `Contract permits ${d}.` : `Contract does not permit ${d}.`;
    case "Compliance":
      return value ? `Compliance authorizes ${d}.` : `Compliance does not authorize ${d}.`;
    case "Settlement":
      return value ? `Settlement supports ${d} / Rail ${r}.` : `Settlement does not support ${d} / Rail ${r}.`;
    case "Verification":
      return `Verification of ${MILESTONE}: ${value}.`;
    case "Treasury":
      return `Treasury approval: ${value}.`;
    default:
      return "";
  }
}

/** Short role descriptions for the testbed's roster (not part of any model input of this protocol). */
export const ROLE_DESCRIPTION: Record<RoleName, string> = {
  Operations: "receives the public request; the fixed proposer; holds no private task state",
  Contract: "knows which destinations the contract permits",
  Compliance: "knows which destinations are authorized",
  Settlement: "knows which destination/rail routes are supported",
  Verification: `knows whether verification of milestone ${MILESTONE} is accepted or pending`,
  Treasury: "knows whether approval is approved or pending",
};
