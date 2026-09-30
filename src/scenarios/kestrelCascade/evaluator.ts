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
 * Only one ordering is required: the approach beacon must be switched to its
 * battery before external communications are shut down (and, for thermal
 * dump C, R3 evacuated and isolated before the dump fires). Any other
 * physically valid ordering is accepted.
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
    .default({}),
  /** Life support's current allocation, and the minimum it must keep. */
  lifeSupportKw: z.number().min(0).default(40),
  lifeSupportRequiredKw: z.number().min(0).default(40),
  loopBRequiredKw: z.number().min(0).default(30),
  dumpCRequiredKw: z.number().min(0).default(18),
  r3Crew: z.number().int().min(0).default(6),
  r3EvacuationMinutes: z.number().min(0).default(6),
  reactorSafeWindowMinutes: z.number().min(0).default(4),
});
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

  const labsOff = has("shutdown_research_labs");
  const commsOff = has("shutdown_external_communications");
  const lifeSupportKept = Math.max(0, Math.min(proposal.life_support_power_kw, params.lifeSupportKw));
  const releasedFromLifeSupport = params.lifeSupportKw - lifeSupportKept;
  const availableKw =
    params.baseReserveKw +
    (labsOff ? params.loadKw.research_labs : 0) +
    (commsOff ? params.loadKw.external_communications : 0) +
    releasedFromLifeSupport;

  const path = proposal.recovery_path;
  const loopB = path === "loop_b";
  const dumpC = path === "thermal_dump_c";
  // What the plan actually does, whatever path it names: every cooling system it powers needs its power,
  // and firing dump C always needs R3 cleared first.
  const loopBUsed = loopB || has("route_power_to_loop_b") || has("start_loop_b");
  const dumpCUsed = dumpC || has("route_power_to_thermal_dump_c") || has("activate_thermal_dump_c");
  const dumpCFires = dumpC || has("activate_thermal_dump_c");
  const requiredKw = (loopBUsed ? params.loopBRequiredKw : 0) + (dumpCUsed ? params.dumpCRequiredKw : 0);
  const powerDetail = `${availableKw} kW available, ${requiredKw} kW required${loopBUsed && dumpCUsed ? " (loop B and dump C together)" : ""}`;

  // With comms still on, the beacon never loses station power.
  const beaconProtected = !commsOff || before("switch_beacon_to_battery", "shutdown_external_communications");
  const evacuationInTime = params.r3EvacuationMinutes <= params.reactorSafeWindowMinutes;
  const r3ClearBeforeDump = before("evacuate_r3", "activate_thermal_dump_c") && before("isolate_r3", "activate_thermal_dump_c") && before("evacuate_r3", "isolate_r3");

  const checks: Record<string, ConstraintCheck> = {
    recovery_path_selected: check(path !== "none", path === "none" ? "no cooling system chosen" : `recovery path: ${path}`),
    loop_b_started: loopB
      ? check(has("route_power_to_loop_b") && has("start_loop_b"), `route power to loop B: ${has("route_power_to_loop_b") ? "yes" : "no"}, start loop B: ${has("start_loop_b") ? "yes" : "no"}`)
      : check(true, NOT_APPLICABLE),
    loop_b_power_sufficient: loopBUsed ? check(availableKw >= requiredKw, powerDetail) : check(true, NOT_APPLICABLE),
    dump_c_activated: dumpC
      ? check(has("route_power_to_thermal_dump_c") && has("activate_thermal_dump_c"), `route power to dump C: ${has("route_power_to_thermal_dump_c") ? "yes" : "no"}, activate dump C: ${has("activate_thermal_dump_c") ? "yes" : "no"}`)
      : check(true, NOT_APPLICABLE),
    dump_c_power_sufficient: dumpCUsed ? check(availableKw >= requiredKw, powerDetail) : check(true, NOT_APPLICABLE),
    r3_evacuation_in_time: dumpCFires
      ? check(evacuationInTime, `R3 evacuation ${params.r3EvacuationMinutes} min, reactor safe window ${params.reactorSafeWindowMinutes} min`)
      : check(true, NOT_APPLICABLE),
    r3_clear_before_dump: dumpCFires
      ? check(r3ClearBeforeDump, r3ClearBeforeDump ? "R3 evacuated, then isolated, before the dump fires" : "R3 not evacuated and isolated before the dump fires")
      : check(true, NOT_APPLICABLE),
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
  const coolingChecks = loopB ? ["loop_b_started", "loop_b_power_sufficient"] : dumpC ? ["dump_c_activated", "dump_c_power_sufficient", "r3_evacuation_in_time", "r3_clear_before_dump"] : ["recovery_path_selected"];
  return {
    outcome: violated.length === 0 ? "SUCCESS" : "MISSION_FAILURE",
    checks,
    violated,
    derived: {
      selectedRecoveryPath: path,
      availableRecoveryPowerKw: availableKw,
      requiredRecoveryPowerKw: requiredKw || null,
      releasedFromLifeSupport,
      lifeSupportKept,
      r3Crew: params.r3Crew,
      r3EvacuationMinutes: params.r3EvacuationMinutes,
      reactorSafeWindowMinutes: params.reactorSafeWindowMinutes,
      r3EvacuationInTime: evacuationInTime,
      approachBeaconProtected: beaconProtected,
      lifeSupportPreserved: checks.life_support_preserved!.passed,
      reactorScrammed: checks.reactor_scrammed!.passed,
      coolingOperational: coolingChecks.every((c) => checks[c]!.passed),
    },
  };
}

export const kestrelCascadeEvaluator: ScenarioEvaluator<CascadeProposal, CascadeParams> = {
  id: "kestrel-cascade",
  version: "2",
  description:
    "Station Kestrel: Cascade — the committed procedure must run a feasible emergency cooling path with enough (actually available) power: loop B needs 30 kW; thermal dump C needs 18 kW and a service ring R3 evacuated and isolated before it fires, within the reactor's safe window. It must also protect the service craft's approach beacon (battery before comms shutdown), SCRAM the reactor and keep life support at its required allocation.",
  proposalSchema: CascadeProposalSchema,
  paramsSchema: CascadeParamsSchema,
  evaluate: evaluateCascade,
};
