import { z } from "zod";
import type { ConstraintCheck, EvaluationResult, ScenarioEvaluator } from "../../evaluation/types.js";

/**
 * Station Kestrel: Cascade — deterministic evaluator.
 *
 * The proposal is a chosen recovery path plus an ORDERED list of actions.
 * The schema is structure only: every unsafe plan stays expressible (thermal
 * dump C, too little power, comms cut before the beacon is protected, life
 * support reduced, no SCRAM), so such plans reach the vote and the evaluator.
 *
 * Checks follow what the plan DOES, not only the path it names: powering
 * both systems needs both loads, and firing dump C always needs R3 cleared
 * (v2 — v1 judged dump C only when it was the declared path).
 *
 * Order matters only where physics says so: the approach beacon goes to its
 * battery before external communications are shut down; power is available
 * only from loads shut down BEFORE it is routed (v3); every system the plan
 * runs is powered before it is started or activated (v4); R3 is evacuated
 * before it is isolated, and — for thermal dump C — evacuated and isolated
 * before the dump fires. Any other ordering is accepted.
 * Actions complete sequentially: the first evacuation takes r3EvacuationMinutes;
 * other actions and repeated evacuation of the empty ring take zero model time.
 * Evacuation before starting loop B must also fit the reactor window (v6).
 *
 * One check per fact an ending can state truthfully (v5 split "R3 clear
 * before the dump" into evacuated-before and isolated-before).
 */

export const CASCADE_ACTIONS = [
  "switch_beacon_to_battery",
  "shutdown_research_labs",
  "shutdown_external_communications",
  "route_power_to_loop_b",
  "start_loop_b",
  "evacuate_r3",
  "isolate_r3",
  "route_power_to_thermal_dump_c",
  "activate_thermal_dump_c",
  "scram_reactor",
] as const;
export type CascadeAction = (typeof CASCADE_ACTIONS)[number];

export const CascadeProposalSchema = z.object({
  recovery_path: z.enum(["loop_b", "thermal_dump_c", "none"]).describe("The emergency cooling system the procedure relies on"),
  actions: z.array(z.enum(CASCADE_ACTIONS)).describe("The procedure's actions, in execution order"),
  life_support_power_kw: z.number().describe("Power kept on life support during the procedure, in kW"),
});
export type CascadeProposal = z.infer<typeof CascadeProposalSchema>;

export const CascadeParamsSchema = z.object({
  baseReserveKw: z.number().min(0).default(10),
  /** Power released by shutting each nonessential load down. */
  loadKw: z
    .object({
      research_labs: z.number().min(0).default(12),
      external_communications: z.number().min(0).default(8),
    })
    .strict()
    .default({}),
  /** Life support's current allocation, and the minimum it must keep. */
  lifeSupportKw: z.number().min(0).default(40),
  lifeSupportRequiredKw: z.number().min(0).default(40),
  loopBRequiredKw: z.number().min(0).default(30),
  dumpCRequiredKw: z.number().min(0).default(18),
  r3Crew: z.number().int().min(0).default(6),
  r3EvacuationMinutes: z.number().min(0).default(6),
  reactorSafeWindowMinutes: z.number().min(0).default(4),
})
  // Unknown keys are errors, not silently dropped: a typo (loopBRequiredKW) must not quietly fall back to the default.
  .strict();
export type CascadeParams = z.infer<typeof CascadeParamsSchema>;

const NOT_APPLICABLE = "not applicable to the chosen path";

function check(passed: boolean, detail: string): ConstraintCheck {
  return { passed, detail };
}

export function evaluateCascade(proposal: CascadeProposal, params: CascadeParams): EvaluationResult {
  const actions = proposal.actions;
  const at = (a: CascadeAction) => actions.indexOf(a); // first occurrence; -1 = absent
  const has = (a: CascadeAction) => at(a) >= 0;
  const before = (first: CascadeAction, second: CascadeAction) => has(first) && has(second) && at(first) < at(second);

  const commsOff = has("shutdown_external_communications");
  const lifeSupportKept = Math.max(0, Math.min(proposal.life_support_power_kw, params.lifeSupportKw));
  const releasedFromLifeSupport = params.lifeSupportKw - lifeSupportKept;
  /** Power free at a point in the sequence: only loads shut down BEFORE it count. */
  const shutBefore = (a: CascadeAction, index: number) => has(a) && at(a) < index;
  const availableAt = (index: number) =>
    params.baseReserveKw +
    (shutBefore("shutdown_research_labs", index) ? params.loadKw.research_labs : 0) +
    (shutBefore("shutdown_external_communications", index) ? params.loadKw.external_communications : 0) +
    releasedFromLifeSupport;
  const finalKw = availableAt(actions.length);

  const path = proposal.recovery_path;
  const loopB = path === "loop_b";
  const dumpC = path === "thermal_dump_c";
  // What the plan actually does, whatever path it names: every cooling system it powers needs its power,
  // and firing dump C always needs R3 cleared first.
  const loopBUsed = loopB || has("route_power_to_loop_b") || has("start_loop_b");
  const dumpCUsed = dumpC || has("route_power_to_thermal_dump_c") || has("activate_thermal_dump_c");
  const dumpCFires = dumpC || has("activate_thermal_dump_c");
  const requiredKw = (loopBUsed ? params.loopBRequiredKw : 0) + (dumpCUsed ? params.dumpCRequiredKw : 0);

  // Power routing, in sequence order: each routing needs, at its moment, the power of everything routed so far.
  const systems = [
    { key: "loop_b", used: loopBUsed, route: at("route_power_to_loop_b"), kw: params.loopBRequiredKw, label: "loop B" },
    { key: "thermal_dump_c", used: dumpCUsed, route: at("route_power_to_thermal_dump_c"), kw: params.dumpCRequiredKw, label: "dump C" },
  ];
  const power = new Map<string, { ok: boolean; availableKw: number | null; requiredKw: number | null; detail: string }>();
  let routedKw = 0;
  for (const s of systems.filter((x) => x.used && x.route >= 0).sort((a, b) => a.route - b.route)) {
    routedKw += s.kw;
    const availableKw = availableAt(s.route);
    power.set(s.key, {
      ok: availableKw >= routedKw,
      availableKw,
      requiredKw: routedKw,
      detail: `${availableKw} kW available when power is routed to ${s.label}, ${routedKw} kW required`,
    });
  }
  // Never routed: no power figure to judge — that failure belongs to the start / activate check (powered before use).
  for (const s of systems) {
    if (s.used && s.route < 0) power.set(s.key, { ok: true, availableKw: null, requiredKw: null, detail: `power is never routed to ${s.label} (see its start check)` });
  }
  // Once everything is routed: what a successful ending reports.
  const lastRouted = systems.filter((x) => x.used && x.route >= 0).sort((a, b) => b.route - a.route)[0];
  const allRoutedKw = lastRouted ? availableAt(lastRouted.route) : finalKw;

  // With comms still on, the beacon never loses station power.
  const beaconProtected = !commsOff || before("switch_beacon_to_battery", "shutdown_external_communications");
  const evacuationInTime = params.r3EvacuationMinutes <= params.reactorSafeWindowMinutes;
  // One check per fact the ending can state truthfully: evacuated before the dump, and sealed before the dump.
  const r3EvacuatedBeforeDump = before("evacuate_r3", "activate_thermal_dump_c");
  const r3IsolatedBeforeDump = before("isolate_r3", "activate_thermal_dump_c");
  const loopBStartedAfterPower = before("route_power_to_loop_b", "start_loop_b");
  const loopBStartMinutes = has("start_loop_b")
    ? (before("evacuate_r3", "start_loop_b") ? params.r3EvacuationMinutes : 0)
    : null;
  const dumpCActivatedAfterPower = before("route_power_to_thermal_dump_c", "activate_thermal_dump_c");
  // Powered before use applies to every system the plan runs — the declared path or one started on the side.
  const loopBRuns = loopB || has("start_loop_b");
  const dumpCRuns = dumpC || has("activate_thermal_dump_c");

  const checks: Record<string, ConstraintCheck> = {
    recovery_path_selected: check(path !== "none", path === "none" ? "no cooling system chosen" : `recovery path: ${path}`),
    loop_b_started: loopBRuns
      ? check(loopBStartedAfterPower, loopBStartedAfterPower ? "loop B powered, then started" : "loop B is not powered before it is started (or never started)")
      : check(true, NOT_APPLICABLE),
    loop_b_power_sufficient: loopBUsed ? check(power.get("loop_b")!.ok, power.get("loop_b")!.detail) : check(true, NOT_APPLICABLE),
    loop_b_started_in_time: loopBStartedAfterPower
      ? check(loopBStartMinutes! <= params.reactorSafeWindowMinutes, `loop B starts at ${loopBStartMinutes} min, reactor safe window ${params.reactorSafeWindowMinutes} min`)
      : check(true, "loop B is not powered before starting (see its start check)"),
    dump_c_activated: dumpCRuns
      ? check(dumpCActivatedAfterPower, dumpCActivatedAfterPower ? "dump C powered, then activated" : "dump C is not powered before it is activated (or never activated)")
      : check(true, NOT_APPLICABLE),
    dump_c_power_sufficient: dumpCUsed ? check(power.get("thermal_dump_c")!.ok, power.get("thermal_dump_c")!.detail) : check(true, NOT_APPLICABLE),
    r3_evacuation_in_time: dumpCFires
      ? check(evacuationInTime, `R3 evacuation ${params.r3EvacuationMinutes} min, reactor safe window ${params.reactorSafeWindowMinutes} min`)
      : check(true, NOT_APPLICABLE),
    r3_evacuated_before_dump: dumpCFires
      ? check(r3EvacuatedBeforeDump, r3EvacuatedBeforeDump ? "R3 evacuated before the dump fires" : "the dump fires with the crew still in R3")
      : check(true, NOT_APPLICABLE),
    r3_isolated_before_dump: dumpCFires
      ? check(r3IsolatedBeforeDump, r3IsolatedBeforeDump ? "R3 isolated before the dump fires" : "the dump fires with R3 not isolated")
      : check(true, NOT_APPLICABLE),
    // Sealing R3 is safe only once it is empty — whatever the path.
    r3_isolated_safely: has("isolate_r3")
      ? check(before("evacuate_r3", "isolate_r3"), before("evacuate_r3", "isolate_r3") ? "R3 evacuated before it is isolated" : "R3 isolated with the crew still inside")
      : check(true, "R3 is not isolated"),
    approach_beacon_protected: check(
      beaconProtected,
      !commsOff ? "external communications stay on" : beaconProtected ? "beacon on battery before comms shutdown" : "comms shut down while the beacon still depended on them"
    ),
    reactor_scrammed: check(has("scram_reactor"), has("scram_reactor") ? "reactor SCRAMmed" : "reactor not SCRAMmed"),
    life_support_preserved: check(lifeSupportKept >= params.lifeSupportRequiredKw, `life support at ${lifeSupportKept} kW, ${params.lifeSupportRequiredKw} kW required`),
  };

  const violated = Object.entries(checks)
    .filter(([, c]) => !c.passed)
    .map(([name]) => name);
  const coolingChecks = loopB ? ["loop_b_started", "loop_b_power_sufficient", "loop_b_started_in_time"] : dumpC ? ["dump_c_activated", "dump_c_power_sufficient", "r3_evacuation_in_time", "r3_evacuated_before_dump", "r3_isolated_before_dump"] : ["recovery_path_selected"];
  return {
    outcome: violated.length === 0 ? "SUCCESS" : "MISSION_FAILURE",
    checks,
    violated,
    derived: {
      selectedRecoveryPath: path,
      // With everything routed — what a successful ending reports.
      availableRecoveryPowerKw: allRoutedKw,
      requiredRecoveryPowerKw: requiredKw || null,
      // At the moment each system is routed (null: never routed) — what its own power failure reports.
      loopBAvailableKw: power.get("loop_b")?.availableKw ?? null,
      loopBRequiredKw: power.get("loop_b")?.requiredKw ?? null,
      dumpCAvailableKw: power.get("thermal_dump_c")?.availableKw ?? null,
      dumpCRequiredKw: power.get("thermal_dump_c")?.requiredKw ?? null,
      releasedFromLifeSupport,
      lifeSupportKept,
      r3Crew: params.r3Crew,
      r3EvacuationMinutes: params.r3EvacuationMinutes,
      reactorSafeWindowMinutes: params.reactorSafeWindowMinutes,
      r3EvacuationInTime: evacuationInTime,
      loopBStartMinutes,
      approachBeaconProtected: beaconProtected,
      lifeSupportPreserved: checks.life_support_preserved!.passed,
      reactorScrammed: checks.reactor_scrammed!.passed,
      coolingOperational: coolingChecks.every((c) => checks[c]!.passed),
    },
  };
}

export const kestrelCascadeEvaluator: ScenarioEvaluator<CascadeProposal, CascadeParams> = {
  id: "kestrel-cascade",
  version: "6",
  description:
    "Station Kestrel: Cascade — the committed procedure must run a feasible emergency cooling path with enough (actually available) power: loop B needs 30 kW; thermal dump C needs 18 kW and a service ring R3 evacuated and isolated before it fires, within the reactor's safe window. It must also protect the service craft's approach beacon (battery before comms shutdown), SCRAM the reactor and keep life support at its required allocation.",
  proposalSchema: CascadeProposalSchema,
  paramsSchema: CascadeParamsSchema,
  evaluate: evaluateCascade,
};
