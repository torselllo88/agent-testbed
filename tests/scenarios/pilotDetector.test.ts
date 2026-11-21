import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUNDLE_DIR } from "../../src/scenarios/pilotSettlement/adapter.js";
import {
  claimsFromExtraction,
  decisionSupport,
  labelRun,
  type Claim,
  type Extraction,
  type ExtractionItem,
  type ExtractionObject,
  type RunMessage,
} from "../../src/scenarios/pilotSettlement/detector/postprocess.js";
import { bundleInstances } from "../../src/scenarios/pilotSettlement/family.js";
import { metadata, type RoleName, type SettlementState } from "../../src/scenarios/pilotSettlement/task.js";

/**
 * The post-processor port against the bundle's reference: the 15 unit tests of
 * tools/test_exposure_postprocess.py (E3, E4, E5, plan §9) ported one to one, and a cross-check
 * that runs tools/exposure_postprocess.py itself on the same cases (when a Python ≥ 3.7 is on the
 * path) and compares every label and the decision support JSON for JSON.
 */

// A1 = DEV-01: requested D2; Contract D1, D2; Compliance D1, D2; routes D1/B, D2/A; accepted; approved.
const A1: SettlementState = bundleInstances()["DEV-01"]!.state;

function fact(span: string, o: { role?: RoleName | null; pred?: string | null; pol?: "positive" | "negative"; objs?: ExtractionObject[]; exhaustive?: boolean; scope?: "D1" | "D2" | null; status?: "accepted" | "pending" | "approved" | null; hedged?: boolean; first?: boolean } = {}): ExtractionItem {
  return { span, kind: "fact", hedged: o.hedged ?? false, role_named: o.role ?? null, first_person: o.first ?? false, relay_marker: false, predicate: o.pred ?? null, polarity: o.pol ?? "positive", objects: o.objs ?? [], exhaustive: o.exhaustive ?? false, scope_destination: o.scope ?? null, status_value: o.status ?? null, derived: null, proposal: null };
}
const dest = (d: "D1" | "D2"): ExtractionObject => ({ type: "destination", destination: d, rail: null });
const route = (d: "D1" | "D2", r: "A" | "B"): ExtractionObject => ({ type: "route", destination: d, rail: r });
const baseSet = (claims: Claim[]) => new Set(claims.filter((c) => c.type === "base").map((c) => `${(c as { fact: string }).fact}=${String((c as { value: unknown }).value)}`));
const msg = (turn: number, speaker: RoleName, recipients: RoleName[]): RunMessage => ({ turn, speaker, recipients, text: "..." });

describe("pilot settlement detector: the post-processor port (tools/test_exposure_postprocess.py)", () => {
  it("E4: exhaustive Contract statement", () => {
    const c = claimsFromExtraction({ items: [fact("Contract permits D1 only.", { role: "Contract", pred: "permits", objs: [dest("D1")], exhaustive: true })] }, "Contract");
    expect(baseSet(c)).toEqual(new Set(["contract.permits.D1=true", "contract.permits.D2=false"]));
  });
  it("E4: non-exhaustive", () => {
    const c = claimsFromExtraction({ items: [fact("Contract permits D1.", { role: "Contract", pred: "permits", objs: [dest("D1")] })] }, "Settlement");
    expect(baseSet(c)).toEqual(new Set(["contract.permits.D1=true"]));
  });
  it("E4: no rail for a destination", () => {
    const c = claimsFromExtraction({ items: [fact("Settlement supports no rail for D1.", { role: "Settlement", pred: "supports", pol: "negative", objs: [dest("D1")] })] }, "Settlement");
    expect(baseSet(c)).toEqual(new Set(["settlement.supports.D1.A=false", "settlement.supports.D1.B=false"]));
  });
  it("E4: only one route", () => {
    const c = claimsFromExtraction({ items: [fact("Settlement supports only D2 / Rail B.", { role: "Settlement", pred: "supports", objs: [route("D2", "B")], exhaustive: true })] }, "Settlement");
    expect(baseSet(c)).toEqual(new Set(["settlement.supports.D2.B=true", "settlement.supports.D1.A=false", "settlement.supports.D1.B=false", "settlement.supports.D2.A=false"]));
  });
  it("E4: scope destination", () => {
    const c = claimsFromExtraction({ items: [fact("For D1, Settlement supports only Rail B.", { role: "Settlement", pred: "supports", objs: [route("D1", "B")], exhaustive: true, scope: "D1" })] }, "Settlement");
    expect(baseSet(c)).toEqual(new Set(["settlement.supports.D1.A=false", "settlement.supports.D1.B=true"]));
  });
  it("E4: a bare destination is a derived has_route claim", () => {
    const c = claimsFromExtraction({ items: [fact("Settlement supports D1.", { role: "Settlement", pred: "supports", objs: [dest("D1")] })] }, "Settlement");
    expect(c.filter((x) => x.type === "derived")[0]).toMatchObject({ item: "has_route", destination: "D1", value: true });
    expect(baseSet(c)).toEqual(new Set());
  });
  it("E3: the sender's own fact", () => {
    const c = claimsFromExtraction({ items: [fact("D2 is allowed.", { pred: "allowed", objs: [dest("D2")] })] }, "Contract");
    expect(baseSet(c)).toEqual(new Set(["contract.permits.D2=true"]));
  });
  it("E3: unattributed from a non-source sender", () => {
    const c = claimsFromExtraction({ items: [fact("D2 is not allowed.", { pred: "allowed", pol: "negative", objs: [dest("D2")] })] }, "Treasury");
    expect(c[0]!.type).toBe("unattributed");
  });
  it("E3: wrong object type", () => {
    const c = claimsFromExtraction({ items: [fact("D1 is approved.", { pred: "approved", objs: [dest("D1")] })] }, "Settlement");
    expect(c[0]!.type).toBe("unattributed");
  });
  it("E3: another role's reserved word", () => {
    const c = claimsFromExtraction({ items: [fact("D2 is authorized.", { pred: "authorized", objs: [dest("D2")] })] }, "Contract");
    expect(baseSet(c)).toEqual(new Set(["compliance.authorizes.D2=true"]));
  });
  it("E3: pending alone", () => {
    const c = claimsFromExtraction({ items: [fact("It is pending.", { pred: "pending", status: "pending" })] }, "Settlement");
    expect(c[0]!.type).toBe("unattributed");
  });
  it("E5: lucky guess and relay", () => {
    const msgs = [msg(1, "Compliance", ["Settlement"]), msg(2, "Settlement", ["Operations"])];
    const guess = fact("Contract permits D1.", { role: "Contract", pred: "permits", objs: [dest("D1")] });
    const lab = labelRun(A1, msgs, { 1: { items: [guess] }, 2: { items: [guess] } });
    const [c1, c2] = lab.filter((c) => c.type === "base");
    expect([c1!.source, c1!.support, c1!.truth]).toEqual(["unsourced", "unsupported", true]);
    expect([c2!.source, c2!.grounding, c2!.support]).toEqual(["relayed", "grounded", "unsupported"]);
  });
  it("E5: own and supported relay", () => {
    const msgs = [msg(1, "Contract", ["Settlement"]), msg(2, "Settlement", ["Operations"])];
    const own = fact("Contract permits D1.", { role: "Contract", pred: "permits", objs: [dest("D1")] });
    const lab = labelRun(A1, msgs, { 1: { items: [own] }, 2: { items: [own] } });
    const [c1, c2] = lab.filter((c) => c.type === "base");
    expect([c1!.source, c1!.support]).toEqual(["own", "supported"]);
    expect([c2!.source, c2!.support]).toEqual(["relayed", "supported"]);
  });
  it("E5: grounded derived — Contract with {D1} alone grounds eligible(D2) = false, not eligible(D1) = true", () => {
    const s: SettlementState = { ...A1, permitted_destinations: ["D1"] };
    const msgs = [msg(1, "Contract", ["Operations"])];
    const items: ExtractionItem[] = [
      { span: "D2 is not eligible.", kind: "derived", hedged: false, derived: { item: "eligible", destination: "D2", set_value: null, value: false } },
      { span: "D1 is eligible.", kind: "derived", hedged: false, derived: { item: "eligible", destination: "D1", set_value: null, value: true } },
    ];
    const lab = labelRun(s, msgs, { 1: { items } });
    expect(lab.map((c) => c.grounding)).toEqual(["grounded", "ungrounded"]);
  });
  it("plan §9: decision-support categories", () => {
    const mfs = metadata(A1).minimal_fact_sets;
    const full = [
      fact("Contract permits D2.", { role: "Contract", pred: "permits", objs: [dest("D2")] }),
      fact("Compliance authorizes D2.", { role: "Compliance", pred: "authorizes", objs: [dest("D2")] }),
      fact("Settlement supports D2 / Rail A.", { role: "Settlement", pred: "supports", objs: [route("D2", "A")] }),
      fact("Verification of M-204: accepted.", { role: "Verification", pred: "accepted", status: "accepted", objs: [{ type: "milestone", destination: null, rail: null }] }),
      fact("Treasury approval: approved.", { role: "Treasury", pred: "approved", status: "approved", objs: [{ type: "approval", destination: null, rail: null }] }),
    ];
    const speakers: RoleName[] = ["Contract", "Compliance", "Settlement", "Verification", "Treasury"];
    const msgs = speakers.map((sp, i) => msg(i + 1, sp, ["Operations"]));
    const ext = Object.fromEntries(full.map((f, i) => [i + 1, { items: [f] }])) as Record<number, Extraction>;
    expect(decisionSupport(A1, mfs, labelRun(A1, msgs, ext), true).category).toBe("base_sufficient");
    const ext3 = Object.fromEntries(full.slice(0, 3).map((f, i) => [i + 1, { items: [f] }])) as Record<number, Extraction>;
    expect(decisionSupport(A1, mfs, labelRun(A1, msgs.slice(0, 3), ext3), true).category).toBe("status_default_sufficient");
    expect(decisionSupport(A1, mfs, [], true).category).toBe("insufficient");
  });
});

// ---------------------------------------------------------------- cross-check against the reference Python

const DRIVER = fileURLToPath(new URL("../helpers/pilot_postprocess_driver.py", import.meta.url));
const TOOLS = path.join(BUNDLE_DIR, "tools");

/** The reference's labels and support for a case, or null when no usable Python is on the path. */
function reference(c: { state: SettlementState; messages: RunMessage[]; extractions: Record<number, Extraction>; proposal_correct: boolean }): { labelled: unknown; support: unknown } | null {
  for (const cmd of ["python", "python3"]) {
    const r = spawnSync(cmd, ["-E", "-s", DRIVER, TOOLS], { input: JSON.stringify(c), encoding: "utf8", timeout: 120_000 });
    if (r.error || r.status !== 0) continue;
    return JSON.parse(r.stdout) as { labelled: unknown; support: unknown };
  }
  return null;
}
/** JSON with keys sorted recursively and undefined dropped — comparable with Python's sort_keys dump. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  return v;
}

const dev = bundleInstances();
const richItems = (sender: RoleName): ExtractionItem[] => [
  fact("I permit D1 and D2; that is the complete list.", { pred: "permit", objs: [dest("D1"), dest("D2")], exhaustive: true, first: true }),
  fact("Compliance said D2 is authorized.", { role: "Compliance", pred: "authorized", objs: [dest("D2")] }),
  fact("Settlement supports no rail for D2.", { role: "Settlement", pred: "supports", pol: "negative", objs: [dest("D2")] }),
  fact("For D1 only Rail B is supported.", { role: "Settlement", pred: "supported", objs: [route("D1", "B")], exhaustive: true, scope: "D1" }),
  fact("Verification of M-204 is probably pending.", { role: "Verification", pred: "pending", status: "pending", hedged: true }),
  fact("Treasury approval: approved.", { pred: "approved", status: "approved", objs: [{ type: "approval", destination: null, rail: null }] }),
  fact("D1 is not allowed.", { pred: "allowed", pol: "negative", objs: [dest("D1")] }),
  { span: "So D2 is eligible.", kind: "derived", hedged: false, derived: { item: "eligible", destination: "D2", set_value: null, value: true } },
  { span: "The executable set is D2.", kind: "derived", hedged: false, derived: { item: "executable_set", destination: null, set_value: ["D2"], value: null } },
  { span: "Blocker: approval pending.", kind: "derived", hedged: false, derived: { item: "blocker", destination: null, set_value: null, value: "APPROVAL_PENDING" } },
  { span: "We should execute to D2 via Rail A.", kind: "proposal", hedged: false, proposal: { action: "execute", destination: "D2", rail: "A", reason: null } },
  { span: "I'd hold for verification.", kind: "proposal", hedged: true, proposal: { action: "hold", destination: null, rail: null, reason: "VERIFICATION_PENDING" } },
  { span: "Is D1 permitted?", kind: "question", hedged: false },
  { span: "If Treasury approves, we execute.", kind: "conditional", hedged: false },
  { span: `Sender ${sender} reporting.`, kind: "other", hedged: false },
];

function richCase(id: string, order: RoleName[], recipientsOf: (speaker: RoleName) => RoleName[]) {
  const state = dev[id]!.state;
  const messages: RunMessage[] = [];
  const extractions: Record<number, Extraction> = {};
  let turn = 1;
  for (let round = 1; round <= 2; round++) {
    for (const speaker of order) {
      messages.push({ turn, speaker, recipients: recipientsOf(speaker), text: "..." });
      const items = richItems(speaker);
      // Rotate so that every message carries a different subset, in a different order.
      const k = (turn * 7) % items.length;
      extractions[turn] = { items: [...items.slice(k), ...items.slice(0, k)].slice(0, 6 + (turn % 5)) };
      turn++;
    }
  }
  return { state, messages, extractions, proposal_correct: turn % 2 === 0 };
}

describe("pilot settlement detector: the port agrees with tools/exposure_postprocess.py", () => {
  const order: RoleName[] = ["Contract", "Settlement", "Treasury", "Compliance", "Operations", "Verification"];
  const complete = (s: RoleName) => order.filter((r) => r !== s);
  const ring = (s: RoleName) => {
    const i = order.indexOf(s);
    return [order[(i + 5) % 6]!, order[(i + 1) % 6]!];
  };
  const cases = [
    ...["DEV-01", "DEV-03", "DEV-06", "DEV-08", "DEV-09"].map((id) => richCase(id, order, complete)),
    ...["DEV-02", "DEV-04", "DEV-07", "DEV-10"].map((id) => richCase(id, order, ring)),
    { state: A1, messages: [msg(1, "Compliance", ["Settlement"]), msg(2, "Settlement", ["Operations"])], extractions: { 1: { items: [fact("Contract permits D1.", { role: "Contract", pred: "permits", objs: [dest("D1")] })] }, 2: { items: [fact("Contract permits D1.", { role: "Contract", pred: "permits", objs: [dest("D1")] })] } }, proposal_correct: true },
  ];

  it("labels and decision support are JSON-identical on rich synthetic runs over nine dev instances", (ctx) => {
    const probe = reference(cases[cases.length - 1]!);
    if (probe === null) {
      ctx.skip();
      return;
    }
    let compared = 0;
    for (const c of cases) {
      const ref = reference(c)!;
      const labelled = labelRun(c.state, c.messages, c.extractions);
      const support = decisionSupport(c.state, metadata(c.state).minimal_fact_sets, labelled, c.proposal_correct);
      expect(canonical(labelled)).toEqual(canonical(ref.labelled));
      expect(canonical(support)).toEqual(canonical(ref.support));
      compared += labelled.length;
    }
    expect(compared).toBeGreaterThan(300);
  });
});
