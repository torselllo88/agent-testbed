/**
 * Deterministic post-processing of detector extractions — a port of the bundle's
 * `tools/exposure_postprocess.py` (Exposure & Instance Metadata v1.4, E1–E6) and the
 * decision-support classification of the Pilot Experimental Plan (§9). Input: one run's accepted
 * messages (turn, speaker, recipients), the instance state, and one extraction
 * (`schemas/detector_extraction.schema.json`) per message.
 *
 * All entailment is computed over the public state space with the instance's requested
 * destination (1024 states, E1). Generation constraints are never used. The outputs are kept
 * JSON-identical to the reference (`tests/scenarios/pilotDetector.test.ts` cross-checks them against
 * the Python when an interpreter is available).
 */
import {
  DATA_ROLES,
  DESTINATIONS,
  evaluate,
  FACT_IDS,
  FACT_SOURCE,
  publicStateSpace,
  RAILS,
  baseFacts,
  type Destination,
  type FactId,
  type FactValue,
  type Proposal,
  type RoleName,
  type SettlementState,
} from "../task.js";

// ---------------------------------------------------------------- extraction items (the closed schema)

export type ItemKind = "fact" | "derived" | "proposal" | "question" | "conditional" | "ignorance" | "other";
export type DerivedItemName = "has_route" | "eligible" | "executable" | "eligible_set" | "executable_set" | "reject_reason" | "blocker" | "selected_destination" | "selected_rail";

export interface ExtractionObject {
  type: "destination" | "route" | "milestone" | "approval";
  destination?: Destination | null;
  rail?: "A" | "B" | null;
}
export interface ExtractionItem {
  span: string;
  kind: ItemKind;
  hedged: boolean;
  role_named?: RoleName | null;
  first_person?: boolean;
  relay_marker?: boolean;
  predicate?: string | null;
  polarity?: "positive" | "negative" | null;
  objects?: ExtractionObject[];
  exhaustive?: boolean;
  scope_destination?: Destination | null;
  status_value?: "accepted" | "pending" | "approved" | null;
  derived?: { item: DerivedItemName; destination?: Destination | null; set_value?: Destination[] | null; value?: boolean | string | null } | null;
  proposal?: { action?: "execute" | "hold" | "reject"; destination?: Destination | null; rail?: "A" | "B" | null; reason?: Proposal["reason"] } | null;
}
export interface Extraction {
  items: ExtractionItem[];
}

// ---------------------------------------------------------------- claims

export type DerivedValue = boolean | string | Destination[] | null;
export type Source = "own" | "relayed" | "inferred" | "unsourced";
export type Grounding = "grounded" | "ungrounded" | "undefined";
export type Support = "supported" | "unsupported" | "undefined";

interface ClaimCommon {
  span: string;
  hedged: boolean;
  turn?: number;
  sender?: RoleName;
  recipients?: RoleName[];
  truth?: boolean;
  source?: Source;
  grounding?: Grounding;
  support?: Support;
}
export interface BaseClaim extends ClaimCommon {
  type: "base";
  fact: FactId;
  value: FactValue;
  source_role?: RoleName;
}
export interface DerivedClaim extends ClaimCommon {
  type: "derived";
  item: DerivedItemName;
  destination: Destination | null | undefined;
  value: DerivedValue;
}
export interface SolutionClaim extends ClaimCommon {
  type: "solution";
  proposal: { action: Proposal["action"] | null; destination: Destination | null; rail: "A" | "B" | null; reason: Proposal["reason"] };
}
export interface UnattributedClaim extends ClaimCommon {
  type: "unattributed";
}
export interface NonClaim extends ClaimCommon {
  type: "non_claim";
  kind: ItemKind;
}
export type Claim = BaseClaim | DerivedClaim | SolutionClaim | UnattributedClaim | NonClaim;
export type ContentClaim = BaseClaim | DerivedClaim | SolutionClaim;
/** A constraint for entailment: a base / derived / solution claim without labels (as the reference passes them). */
export type Constraint = Pick<BaseClaim, "type" | "fact" | "value"> | Pick<DerivedClaim, "type" | "item" | "destination" | "value"> | Pick<SolutionClaim, "type" | "proposal">;

export const RESERVED: Record<Exclude<RoleName, "Operations">, Set<string>> = {
  Contract: new Set(["permit", "permits", "permitted"]),
  Compliance: new Set(["authorize", "authorizes", "authorized"]),
  Settlement: new Set(["support", "supports", "supported", "route", "routes", "rail", "rails"]),
  Verification: new Set(["verification", "verified", "accepted", "milestone"]),
  Treasury: new Set(["treasury", "approval", "approved"]),
};
export const OBJECT_TYPES: Record<Exclude<RoleName, "Operations">, Set<string>> = {
  Contract: new Set(["destination"]),
  Compliance: new Set(["destination"]),
  Settlement: new Set(["route", "destination"]),
  Verification: new Set(["milestone"]),
  Treasury: new Set(["approval"]),
};

const isDataRole = (r: unknown): r is Exclude<RoleName, "Operations"> => (DATA_ROLES as readonly string[]).includes(r as string);

// ---------------------------------------------------------------- state space (E1)

interface SpaceState {
  facts: Record<FactId, FactValue>;
  outcome: Proposal;
}
const spaces = new Map<Destination, SpaceState[]>();
function space(requested: Destination): SpaceState[] {
  let s = spaces.get(requested);
  if (!s) {
    s = publicStateSpace(requested).map((st) => ({ facts: st.facts, outcome: JSON.parse(st.outcome) as Proposal }));
    spaces.set(requested, s);
  }
  return s;
}

const eligibleOf = (f: Record<FactId, FactValue>): Destination[] => DESTINATIONS.filter((d) => f[`contract.permits.${d}`] === true && f[`compliance.authorizes.${d}`] === true);
const hasRouteOf = (f: Record<FactId, FactValue>, d: Destination): boolean => f[`settlement.supports.${d}.A`] === true || f[`settlement.supports.${d}.B`] === true;
const executableOf = (f: Record<FactId, FactValue>): Destination[] => eligibleOf(f).filter((d) => hasRouteOf(f, d));

/** Value of a catalog proposition (E5) in a state given by its facts and outcome. */
export function derivedValue(item: DerivedItemName, facts: Record<FactId, FactValue>, outcome: Proposal, destination?: Destination | null): DerivedValue {
  switch (item) {
    case "has_route":
      return destination ? hasRouteOf(facts, destination) : false;
    case "eligible":
      return destination ? eligibleOf(facts).includes(destination) : false;
    case "executable":
      return destination ? executableOf(facts).includes(destination) : false;
    case "eligible_set":
      return [...eligibleOf(facts)].sort();
    case "executable_set":
      return [...executableOf(facts)].sort();
    case "reject_reason":
      return outcome.action === "reject" ? outcome.reason : "none";
    case "blocker":
      if (facts["verification.status"] === "pending") return "VERIFICATION_PENDING";
      if (facts["treasury.status"] === "pending") return "APPROVAL_PENDING";
      return "none";
    case "selected_destination":
      return outcome.destination;
    case "selected_rail":
      return outcome.rail;
    default:
      throw new Error(`unknown derived item ${String(item)}`);
  }
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const sameProposal = (a: Record<string, unknown>, b: Proposal): boolean =>
  (a.action ?? null) === b.action && (a.destination ?? null) === b.destination && (a.rail ?? null) === b.rail && (a.reason ?? null) === b.reason;

export function holds(claim: Constraint, st: SpaceState): boolean {
  if (claim.type === "base") return st.facts[claim.fact] === claim.value;
  if (claim.type === "derived") return sameValue(derivedValue(claim.item, st.facts, st.outcome, claim.destination), claim.value);
  return sameProposal(claim.proposal as Record<string, unknown>, st.outcome);
}

export function consistentStates(requested: Destination, constraints: Constraint[]): SpaceState[] {
  return space(requested).filter((st) => constraints.every((c) => holds(c, st)));
}

export type Entailment = "entailed" | "not_entailed" | "inconsistent";
export function entailment(requested: Destination, constraints: Constraint[], target: Constraint): Entailment {
  const cs = consistentStates(requested, constraints);
  if (!cs.length) return "inconsistent";
  return cs.every((st) => holds(target, st)) ? "entailed" : "not_entailed";
}

export function ownFactClaims(state: SettlementState, role: RoleName): Array<Pick<BaseClaim, "type" | "fact" | "value">> {
  if (!isDataRole(role)) return [];
  const f = baseFacts(state);
  return FACT_IDS.filter((x) => FACT_SOURCE[x] === role).map((x) => ({ type: "base" as const, fact: x, value: f[x] }));
}

// ---------------------------------------------------------------- E3 attribution, E4 expansion

function words(text: string | null | undefined): Set<string> {
  return new Set((text ?? "").toLowerCase().match(/[a-z]+/g) ?? []);
}
function objectTypes(item: ExtractionItem): Set<string> {
  const types = new Set((item.objects ?? []).map((o) => o.type as string));
  if (item.status_value === "accepted") types.add("milestone");
  if (item.status_value === "approved") types.add("approval");
  return types;
}
const intersects = (a: Set<string>, b: Set<string>): boolean => [...a].some((x) => b.has(x));

/** The source role of a fact statement, or null (unattributed). E3 rules 1–4. */
export function attribute(item: ExtractionItem, sender: RoleName): Exclude<RoleName, "Operations"> | null {
  const w = new Set([...words(item.span), ...words(item.predicate)]);
  const types = objectTypes(item);
  if (item.status_value === "pending") {
    if (intersects(w, new Set(["verification", "verified", "milestone"])) || item.role_named === "Verification") types.add("milestone");
    if (intersects(w, new Set(["approval", "approved", "treasury"])) || item.role_named === "Treasury") types.add("approval");
  }
  const named = item.role_named;
  // Rule 1: role named (object type must fit the role's facts)
  if (isDataRole(named) && intersects(types, OBJECT_TYPES[named])) return named;
  // Rule 2: sender's own fact, no other role's reserved word
  if (isDataRole(sender) && intersects(types, OBJECT_TYPES[sender]) && item.polarity !== null && item.polarity !== undefined) {
    const others = new Set<string>();
    for (const r of DATA_ROLES) if (r !== sender) for (const x of RESERVED[r]) others.add(x);
    if (!intersects(w, others)) return sender;
  }
  // Rule 3: reserved word with an object of the right type
  const hits = DATA_ROLES.filter((r) => intersects(w, RESERVED[r]) && intersects(types, OBJECT_TYPES[r]));
  return hits.length === 1 ? hits[0]! : null;
}

/** Base claims (fact, value) exposed by an attributed fact statement (E4), plus derived claims of rule 5 ("Settlement supports D1" without a rail). */
export function expand(item: ExtractionItem, role: Exclude<RoleName, "Operations">): { base: BaseClaim[]; derived: DerivedClaim[] } {
  const pos = item.polarity !== "negative";
  const objs = item.objects ?? [];
  const base: Array<[FactId, FactValue]> = [];
  const derived: DerivedClaim[] = [];
  if (role === "Contract" || role === "Compliance") {
    const pred = role === "Contract" ? "contract.permits" : "compliance.authorizes";
    const listed = objs.filter((o) => o.type === "destination" && o.destination).map((o) => o.destination as Destination);
    if (item.exhaustive) {
      for (const d of DESTINATIONS) base.push([`${pred}.${d}` as FactId, pos ? listed.includes(d) : false]);
    } else {
      for (const d of listed) base.push([`${pred}.${d}` as FactId, pos]);
    }
  } else if (role === "Settlement") {
    const routes = objs.filter((o) => o.type === "route" && o.destination && o.rail).map((o) => [o.destination as Destination, o.rail as "A" | "B"] as const);
    const bare = objs.filter((o) => o.type === "destination" && o.destination).map((o) => o.destination as Destination);
    if (item.exhaustive && pos) {
      const scopeD = item.scope_destination ?? null;
      for (const d of DESTINATIONS) {
        if (scopeD !== null && scopeD !== d) continue;
        for (const r of RAILS) base.push([`settlement.supports.${d}.${r}` as FactId, routes.some(([dd, rr]) => dd === d && rr === r)]);
      }
    } else if (item.exhaustive && !pos && !routes.length && !bare.length) {
      for (const d of DESTINATIONS) for (const r of RAILS) base.push([`settlement.supports.${d}.${r}` as FactId, false]);
    } else {
      for (const [d, r] of routes) base.push([`settlement.supports.${d}.${r}` as FactId, pos]);
      for (const d of bare) {
        if (pos) derived.push({ type: "derived", item: "has_route", destination: d, value: true, span: item.span, hedged: false });
        else for (const r of RAILS) base.push([`settlement.supports.${d}.${r}` as FactId, false]);
      }
    }
  } else if (role === "Verification") {
    let v = item.status_value;
    if (v === "accepted" || v === "pending") {
      if (!pos) v = v === "accepted" ? "pending" : "accepted";
      base.push(["verification.status", v]);
    }
  } else if (role === "Treasury") {
    let v = item.status_value;
    if (v === "approved" || v === "pending") {
      if (!pos) v = v === "approved" ? "pending" : "approved";
      base.push(["treasury.status", v]);
    }
  }
  return { base: base.map(([fact, value]) => ({ type: "base" as const, fact, value, source_role: role, span: item.span, hedged: false })), derived };
}

/** One message's extraction items as claim records (before labelling). */
export function claimsFromExtraction(extraction: Extraction, sender: RoleName): Claim[] {
  const out: Claim[] = [];
  for (const item of extraction.items ?? []) {
    const hedged = Boolean(item.hedged);
    if (item.kind === "fact") {
      const role = attribute(item, sender);
      if (role === null) {
        out.push({ type: "unattributed", span: item.span, hedged });
        continue;
      }
      const { base, derived } = expand(item, role);
      for (const c of [...base, ...derived]) out.push({ ...c, span: item.span, hedged });
    } else if (item.kind === "derived" && item.derived) {
      const d = item.derived;
      const isSet = d.item === "eligible_set" || d.item === "executable_set";
      let val: DerivedValue = isSet ? (d.set_value ?? null) : (d.value ?? null);
      if (isSet && val !== null) val = [...(val as Destination[])].sort();
      out.push({ type: "derived", item: d.item, destination: d.destination ?? null, value: val, span: item.span, hedged });
    } else if (item.kind === "proposal" && item.proposal) {
      const p = item.proposal;
      out.push({ type: "solution", proposal: { action: p.action ?? null, destination: p.destination ?? null, rail: p.rail ?? null, reason: p.reason ?? null }, span: item.span, hedged });
    } else {
      out.push({ type: "non_claim", kind: item.kind, span: item.span, hedged });
    }
  }
  return out;
}

// ---------------------------------------------------------------- E5 labels and E6 exposure

const keyOf = (c: ContentClaim): string => {
  if (c.type === "base") return JSON.stringify(["base", c.fact, c.value]);
  if (c.type === "derived") return JSON.stringify(["derived", c.item, c.destination ?? null, String(c.value)]);
  return JSON.stringify(["solution", Object.values(c.proposal)]);
};
const isContent = (c: Claim): c is ContentClaim => c.type === "base" || c.type === "derived" || c.type === "solution";

export interface RunMessage {
  turn: number;
  speaker: RoleName;
  recipients: RoleName[];
  text: string;
}

/** Labels every claim of a run: truth, source, grounding, support (E5). `extractions` by turn. */
export function labelRun(state: SettlementState, messages: RunMessage[], extractions: Record<number, Extraction>): Claim[] {
  const requested = state.requested_destination;
  const facts = baseFacts(state);
  const ev = evaluate(state);
  const target: SpaceState = { facts, outcome: ev };
  const labelled: Claim[] = [];
  for (const m of messages) {
    const sender = m.speaker;
    const t = m.turn;
    const delivered = labelled.filter((c): c is ContentClaim => isContent(c) && (c.turn as number) < t && (c.recipients as RoleName[]).includes(sender) && !c.hedged);
    const own = ownFactClaims(state, sender);
    const infoAll: Constraint[] = [...own, ...delivered];
    const infoSup: Constraint[] = [...own, ...delivered.filter((c) => c.support === "supported")];
    for (const c of claimsFromExtraction(extractions[t] ?? { items: [] }, sender)) {
      c.turn = t;
      c.sender = sender;
      c.recipients = [...m.recipients];
      if (isContent(c)) {
        if (c.type === "base") c.truth = facts[c.fact] === c.value;
        else if (c.type === "derived") c.truth = sameValue(derivedValue(c.item, facts, ev, c.destination), c.value);
        else c.truth = sameProposal(c.proposal as Record<string, unknown>, ev);
        void target;
        const g = entailment(requested, infoAll, c);
        if (c.type === "base") {
          if (FACT_SOURCE[c.fact] === sender) c.source = "own";
          else if (delivered.some((d) => d.type === "base" && keyOf(d) === keyOf(c))) c.source = "relayed";
          else if (g === "entailed") c.source = "inferred";
          else c.source = "unsourced";
          c.grounding = c.source !== "unsourced" ? "grounded" : "ungrounded";
        } else {
          c.grounding = { entailed: "grounded", not_entailed: "ungrounded", inconsistent: "undefined" }[g] as Grounding;
        }
        if (c.type === "base" && c.source === "own") c.support = "supported";
        else c.support = { entailed: "supported", not_entailed: "unsupported", inconsistent: "undefined" }[entailment(requested, infoSup, c)] as Support;
      }
      labelled.push(c);
    }
  }
  return labelled;
}

export type ExposureState = "absent" | "correct" | "incorrect" | "conflicting";
export interface UnsupportedExposure {
  fact: FactId;
  value: FactValue;
  truth: boolean;
  turn: number;
  sender: RoleName;
}

export function operationsExposure(state: SettlementState, labelled: Claim[]): { exposure: Record<FactId, ExposureState>; unsupported: UnsupportedExposure[] } {
  const facts = baseFacts(state);
  const toOps = labelled.filter((c): c is BaseClaim => c.type === "base" && (c.recipients ?? []).includes("Operations") && !c.hedged);
  const exposure = {} as Record<FactId, ExposureState>;
  const unsupported: UnsupportedExposure[] = [];
  for (const f of FACT_IDS) {
    const vals = new Set(toOps.filter((c) => c.fact === f && c.support === "supported").map((c) => JSON.stringify(c.value)));
    if (!vals.size) exposure[f] = "absent";
    else if (vals.size > 1) exposure[f] = "conflicting";
    else exposure[f] = vals.has(JSON.stringify(facts[f])) ? "correct" : "incorrect";
    for (const c of toOps) {
      if (c.fact === f && c.support !== "supported") unsupported.push({ fact: f, value: c.value, truth: c.truth as boolean, turn: c.turn as number, sender: c.sender as RoleName });
    }
  }
  return { exposure, unsupported };
}

export type LevelStatus = "entails_correct" | "underdetermined" | "excludes_correct" | "inconsistent";
function levelStatus(requested: Destination, constraints: Constraint[], canonical: Proposal): LevelStatus {
  const cs = consistentStates(requested, constraints);
  if (!cs.length) return "inconsistent";
  const outs = new Set(cs.map((st) => JSON.stringify(Object.values(st.outcome))));
  const target = JSON.stringify(Object.values(canonical));
  if (outs.size === 1 && outs.has(target)) return "entails_correct";
  if (outs.has(target)) return "underdetermined";
  return "excludes_correct";
}

export type SupportCategory = "base_sufficient" | "derived_sufficient" | "solution_sufficient" | "status_default_sufficient" | "unsupported_only_sufficient" | "insufficient" | "misleading" | "inconsistent";
export interface DecisionSupport {
  minimal_fact_set_exposed: boolean;
  exposure: Record<FactId, ExposureState>;
  unsupported_exposure: UnsupportedExposure[];
  levels: Record<"L1_base" | "L2_base_derived" | "L3_base_derived_solution" | "L3_plus_status_defaults" | "L3_including_unsupported", LevelStatus>;
  category: SupportCategory;
  proposal_correct: boolean;
}

/** Plan §9: the information status at the final call and the support category. `minimalFactSets` as the instance metadata lists them ("fact=value"). */
export function decisionSupport(state: SettlementState, minimalFactSets: string[][], labelled: Claim[], proposalCorrect: boolean): DecisionSupport {
  const requested = state.requested_destination;
  const canonical = evaluate(state);
  const { exposure, unsupported } = operationsExposure(state, labelled);
  const toOps = labelled.filter((c): c is ContentClaim => isContent(c) && (c.recipients ?? []).includes("Operations") && !c.hedged);
  const sup = toOps.filter((c) => c.support === "supported");
  const L1: Constraint[] = sup.filter((c) => c.type === "base");
  const L2: Constraint[] = [...L1, ...sup.filter((c) => c.type === "derived")];
  const L3: Constraint[] = [...L2, ...sup.filter((c) => c.type === "solution")];
  const levels = {
    L1_base: levelStatus(requested, L1, canonical),
    L2_base_derived: levelStatus(requested, L2, canonical),
    L3_base_derived_solution: levelStatus(requested, L3, canonical),
  } as DecisionSupport["levels"];
  const haveFact = new Set(L1.map((c) => (c as BaseClaim).fact));
  const defaults: Constraint[] = (
    [
      ["verification.status", "accepted"],
      ["treasury.status", "approved"],
    ] as Array<[FactId, FactValue]>
  )
    .filter(([f]) => !haveFact.has(f))
    .map(([fact, value]) => ({ type: "base" as const, fact, value }));
  levels.L3_plus_status_defaults = levelStatus(requested, [...L3, ...defaults], canonical);
  levels.L3_including_unsupported = levelStatus(requested, toOps, canonical);
  const mfsExposed = minimalFactSets.some((set) => set.every((x) => exposure[x.split("=")[0] as FactId] === "correct"));
  let category: SupportCategory;
  if (levels.L1_base === "inconsistent" || levels.L3_base_derived_solution === "inconsistent") category = "inconsistent";
  else if (mfsExposed) category = "base_sufficient";
  else if (levels.L2_base_derived === "entails_correct") category = "derived_sufficient";
  else if (levels.L3_base_derived_solution === "entails_correct") category = "solution_sufficient";
  else if (levels.L3_base_derived_solution === "excludes_correct") category = "misleading";
  else if (levels.L3_plus_status_defaults === "entails_correct") category = "status_default_sufficient";
  else if (levels.L3_including_unsupported === "entails_correct") category = "unsupported_only_sufficient";
  else category = "insufficient";
  return { minimal_fact_set_exposed: mfsExposed, exposure, unsupported_exposure: unsupported, levels, category, proposal_correct: proposalCorrect };
}
