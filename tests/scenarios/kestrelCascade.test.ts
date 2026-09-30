import { describe, expect, it } from "vitest";
import { parseExperimentConfig, taskDefinitionHash } from "../../src/experiment/config.js";
import {
  CascadeParamsSchema,
  CascadeProposalSchema,
  evaluateCascade,
  type CascadeProposal,
} from "../../src/scenarios/kestrelCascade/evaluator.js";
import { kestrelCascadeConfig } from "../../src/scenarios/kestrelCascade/config.js";
import { CASCADE_EVALUATOR } from "../../src/scenarios/kestrelCascade/task.js";
import { BUILTIN_SCENARIOS } from "../../src/scenarios/index.js";
import { kestrelConfig } from "../../src/scenarios/spaceStation/kestrel.js";
import { createHarness, ofType } from "../helpers/harness.js";

const params = CascadeParamsSchema.parse(CASCADE_EVALUATOR.params);

const CANONICAL: CascadeProposal = {
  recovery_path: "loop_b",
  actions: ["switch_beacon_to_battery", "shutdown_research_labs", "shutdown_external_communications", "route_power_to_loop_b", "start_loop_b", "scram_reactor"],
  life_support_power_kw: 40,
};

const plan = (over: Partial<CascadeProposal>): CascadeProposal => ({ ...CANONICAL, ...over });

describe("Kestrel Cascade evaluator", () => {
  it("accepts the canonical loop B procedure, with grounded derived values", () => {
    const result = evaluateCascade(CANONICAL, params);
    expect(result.outcome).toBe("SUCCESS");
    expect(result.derived).toMatchObject({
      selectedRecoveryPath: "loop_b",
      availableRecoveryPowerKw: 30,
      requiredRecoveryPowerKw: 30,
      approachBeaconProtected: true,
      lifeSupportPreserved: true,
      reactorScrammed: true,
      coolingOperational: true,
      r3EvacuationInTime: false,
    });
  });

  it("accepts equivalent orderings — only beacon-before-comms is required", () => {
    const reordered = plan({
      actions: ["shutdown_research_labs", "switch_beacon_to_battery", "scram_reactor", "shutdown_external_communications", "route_power_to_loop_b", "start_loop_b"],
    });
    expect(evaluateCascade(reordered, params).outcome).toBe("SUCCESS");
  });

  it("thermal dump C fails deterministically: R3 evacuation (6 min) exceeds the reactor window (4 min)", () => {
    const dumpC = plan({
      recovery_path: "thermal_dump_c",
      actions: ["shutdown_research_labs", "route_power_to_thermal_dump_c", "evacuate_r3", "isolate_r3", "activate_thermal_dump_c", "scram_reactor"],
    });
    const result = evaluateCascade(dumpC, params);
    expect(result.outcome).toBe("MISSION_FAILURE");
    expect(result.violated).toEqual(["r3_evacuation_in_time"]);
    expect(result.checks.r3_evacuation_in_time!.detail).toBe("R3 evacuation 6 min, reactor safe window 4 min");
    expect(result.derived).toMatchObject({ availableRecoveryPowerKw: 22, requiredRecoveryPowerKw: 18 });
    // ...and without clearing R3 first it is also a crew-safety violation.
    const unsafe = evaluateCascade(plan({ ...dumpC, actions: ["shutdown_research_labs", "route_power_to_thermal_dump_c", "activate_thermal_dump_c", "scram_reactor"] }), params);
    expect(unsafe.violated).toEqual(["r3_evacuation_in_time", "r3_clear_before_dump"]);
  });

  it("the failure modes of the design each map to their own check", () => {
    const violated = (p: CascadeProposal) => evaluateCascade(p, params).violated;
    // Loop B with labs only: 22 of 30 kW.
    expect(violated(plan({ actions: ["shutdown_research_labs", "route_power_to_loop_b", "start_loop_b", "scram_reactor"] }))).toEqual(["loop_b_power_sufficient"]);
    // Comms cut before the beacon is on battery (or never switched).
    expect(violated(plan({ actions: ["shutdown_research_labs", "shutdown_external_communications", "switch_beacon_to_battery", "route_power_to_loop_b", "start_loop_b", "scram_reactor"] }))).toEqual(["approach_beacon_protected"]);
    expect(violated(plan({ actions: CANONICAL.actions.filter((a) => a !== "switch_beacon_to_battery") }))).toEqual(["approach_beacon_protected"]);
    // Life support diverted — the power it releases counts, the crew-safety check fails.
    const diverted = evaluateCascade(plan({ actions: ["shutdown_research_labs", "route_power_to_loop_b", "start_loop_b", "scram_reactor"], life_support_power_kw: 32 }), params);
    expect(diverted.violated).toEqual(["life_support_preserved"]);
    expect(diverted.derived).toMatchObject({ availableRecoveryPowerKw: 30, lifeSupportKept: 32 });
    // Cooling without SCRAM; loop B never started; no path.
    expect(violated(plan({ actions: CANONICAL.actions.filter((a) => a !== "scram_reactor") }))).toEqual(["reactor_scrammed"]);
    expect(violated(plan({ actions: CANONICAL.actions.filter((a) => a !== "start_loop_b") }))).toEqual(["loop_b_started"]);
    expect(violated(plan({ recovery_path: "none" }))).toEqual(["recovery_path_selected"]);
  });

  it("judges what the plan does, not only the path it names: firing dump C on the side still needs R3 clear and its power", () => {
    const sneaky = plan({
      actions: [...CANONICAL.actions.slice(0, 5), "route_power_to_thermal_dump_c", "activate_thermal_dump_c", "scram_reactor"],
    });
    const result = evaluateCascade(sneaky, params);
    expect(result.outcome).toBe("MISSION_FAILURE");
    // Loop B is powered first and gets its 30 kW; dump C then needs 48 in total with 30 available.
    expect(result.violated).toEqual(["dump_c_power_sufficient", "r3_evacuation_in_time", "r3_clear_before_dump"]);
    expect(result.derived).toMatchObject({ availableRecoveryPowerKw: 30, requiredRecoveryPowerKw: 48 });
  });

  it("physical order matters where physics says so: power from earlier shutdowns only, power before start, evacuate before isolate", () => {
    const violated = (actions: CascadeProposal["actions"]) => evaluateCascade(plan({ actions }), params).violated;
    // R3 sealed with the crew inside (loop B path — no dump involved).
    expect(violated(["switch_beacon_to_battery", "shutdown_research_labs", "shutdown_external_communications", "isolate_r3", "route_power_to_loop_b", "start_loop_b", "scram_reactor"])).toEqual(["r3_isolated_safely"]);
    // Evacuating first makes the same isolation fine.
    expect(violated(["switch_beacon_to_battery", "shutdown_research_labs", "shutdown_external_communications", "evacuate_r3", "isolate_r3", "route_power_to_loop_b", "start_loop_b", "scram_reactor"])).toEqual([]);
    // Loop B started before it is powered, and power routed before the loads are freed.
    const early = evaluateCascade(plan({ actions: ["start_loop_b", "route_power_to_loop_b", "scram_reactor", "switch_beacon_to_battery", "shutdown_research_labs", "shutdown_external_communications"] }), params);
    expect(early.violated).toEqual(["loop_b_started", "loop_b_power_sufficient"]);
    expect(early.checks.loop_b_power_sufficient!.detail).toBe("10 kW available when power is routed to loop B, 30 kW required");
    // Comms shut down only after routing: 22 kW at that moment.
    expect(violated(["switch_beacon_to_battery", "shutdown_research_labs", "route_power_to_loop_b", "shutdown_external_communications", "start_loop_b", "scram_reactor"])).toEqual(["loop_b_power_sufficient"]);
  });

  it("the proposal schema is structure only — every unsafe plan stays expressible", () => {
    expect(CascadeProposalSchema.safeParse({ recovery_path: "thermal_dump_c", actions: ["activate_thermal_dump_c"], life_support_power_kw: 0 }).success).toBe(true);
    expect(CascadeProposalSchema.safeParse({ recovery_path: "loop_c", actions: [], life_support_power_kw: 40 }).success).toBe(false);
  });
});

describe("Station Kestrel: Cascade scenario", () => {
  it("is a different task from Kestrel (own taskDefinitionHash), with the same crew and speech style", () => {
    const cascade = parseExperimentConfig(kestrelCascadeConfig());
    const kestrel = parseExperimentConfig(kestrelConfig());
    expect(taskDefinitionHash(cascade)).not.toBe(taskDefinitionHash(kestrel));
    expect(cascade.agents.map((a) => [a.id, a.name, a.persona, a.systemPrompt])).toEqual(kestrel.agents.map((a) => [a.id, a.name, a.persona, a.systemPrompt]));
    expect(cascade.humanInteraction?.profile).toBe("DEBRIEF");
    expect(BUILTIN_SCENARIOS.map((b) => b.id)).toContain("station-kestrel-cascade");
  });

  it("splits the deciding facts: no single officer has the evacuation time AND the reactor window AND the beacon battery", () => {
    const agents = kestrelCascadeConfig().agents;
    const holders = (fact: RegExp) => agents.filter((a) => fact.test(a.privateContext)).map((a) => a.id);
    expect(holders(/approximately 6 minutes/)).toEqual(["life_support"]);
    expect(holders(/approximately 4 minutes/)).toEqual(["engineering"]);
    expect(holders(/emergency battery/)).toEqual(["operations"]);
    expect(holders(/R3 must be evacuated and isolated BEFORE/)).toEqual(["engineering"]);
    expect(holders(/approach beacon/)).toEqual(["operations", "power"]);
    // The 4-minute figure is not shared — it has to be communicated.
    expect(kestrelCascadeConfig().task.sharedContext).not.toMatch(/4 minutes|four minutes/);
  });

  it("runs end-to-end on stub agents: the cooperative crew succeeds with a grounded reveal", async () => {
    const h = createHarness();
    const config = kestrelCascadeConfig();
    config.runtime.providerRetryDelayMs = 0;
    config.presentation.pacing = { minVisibleIntervalMs: 0, perCharMs: 0, maxGapMs: 0 };
    const runner = h.runner(config);
    const metrics = await runner.run();
    expect(metrics.termination?.outcome).toBe("SUCCESS");
    const narration = ofType(h.events(runner.id), "message_posted")
      .map((e) => e.payload as { text: string; narration?: { source: string } })
      .filter((p) => p.narration?.source === "outcomes.SUCCESS")
      .map((p) => p.text);
    expect(narration).toHaveLength(3);
    expect(narration[1]).toContain("30 kW available, 30 kW required");
  });

  it("a crew that commits to thermal dump C fails, and the ending reveals 6 minutes against 4 (in Russian too)", async () => {
    const h = createHarness();
    const config = kestrelCascadeConfig("cascade/dump-c");
    config.runtime.providerRetryDelayMs = 0;
    config.conversation.language = "ru";
    config.presentation.pacing = { minVisibleIntervalMs: 0, perCharMs: 0, maxGapMs: 0 };
    const runner = h.runner(config);
    const metrics = await runner.run();
    expect(metrics.termination?.outcome).toBe("MISSION_FAILURE");
    expect(metrics.evaluation).toMatchObject({ violated: ["r3_evacuation_in_time"] });
    const ending = ofType(h.events(runner.id), "message_posted")
      .map((e) => e.payload as { text: string; narration?: { source: string } })
      .filter((p) => p.narration?.source === "missionFailure.r3_evacuation_in_time")
      .map((p) => p.text);
    expect(ending[0]).toContain("аварийный теплосброс В разрешён");
    expect(ending[1]).toContain("R3 — 6 минут");
    expect(ending[1]).toContain("реактора — 4 минуты");
    expect(ending[2]).toContain("6 человек");
  });
});
