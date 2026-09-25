import { describe, expect, it } from "vitest";
import {
  evaluateSpaceStation,
  SpaceStationParamsSchema,
  SpaceStationProposalSchema,
  type SpaceStationProposal,
} from "../../src/scenarios/spaceStation/evaluator.js";

const params = SpaceStationParamsSchema.parse({});
const SAFE: SpaceStationProposal = {
  shed_loads: ["research_labs", "external_communications"],
  coolant_loop: "B",
  coolant_power_kw: 30,
  scram_reactor: true,
  life_support_power_kw: 40,
  vent_reactor_section: false,
};
const evaluate = (changes: Partial<SpaceStationProposal>) => evaluateSpaceStation({ ...SAFE, ...changes }, params);

describe("Space Station evaluator", () => {
  it("accepts the canonical recovery and reports every check", () => {
    const result = evaluate({});
    expect(result.outcome).toBe("SUCCESS");
    expect(result.violated).toEqual([]);
    expect(Object.keys(result.checks)).toEqual([
      "coolant_available",
      "coolant_power_sufficient",
      "power_feasible",
      "reactor_scrammed",
      "life_support_preserved",
      "no_unsafe_venting",
    ]);
    expect(result.derived).toMatchObject({ availableKw: 30 });
  });

  it("accepts equivalent plans that satisfy the constraints (no exact wording or ordering required)", () => {
    expect(evaluate({ shed_loads: ["external_communications", "research_labs"] }).outcome).toBe("SUCCESS");
    expect(evaluate({ life_support_power_kw: 45 }).outcome).toBe("SUCCESS"); // more than required is fine
  });

  it.each([
    ["SCRAM only (no cooling)", { coolant_loop: "none" as const, coolant_power_kw: 0 }, ["coolant_available", "coolant_power_sufficient"]],
    ["backup cooling without SCRAM", { scram_reactor: false }, ["reactor_scrammed"]],
    ["power taken from life support", { shed_loads: ["research_labs" as const], life_support_power_kw: 32 }, ["life_support_preserved"]],
    ["life support shed outright", { shed_loads: ["life_support" as const] }, ["life_support_preserved"]],
    ["insufficient load shedding (labs only, 22 kW available)", { shed_loads: ["research_labs" as const] }, ["power_feasible"]],
    ["insufficient power routed", { coolant_power_kw: 22, shed_loads: ["research_labs" as const] }, ["coolant_power_sufficient"]],
    ["emergency venting", { vent_reactor_section: true }, ["no_unsafe_venting"]],
    ["failed loop A selected", { coolant_loop: "A" as const }, ["coolant_available"]],
  ])("fails: %s", (_label, changes, violated) => {
    const result = evaluate(changes as Partial<SpaceStationProposal>);
    expect(result.outcome).toBe("MISSION_FAILURE");
    expect(result.violated).toEqual(violated);
    for (const name of violated) expect(result.checks[name]!.passed).toBe(false);
  });

  it("uses the configured scenario parameters", () => {
    const strict = SpaceStationParamsSchema.parse({ coolantRequiredKw: 35 });
    expect(evaluateSpaceStation({ ...SAFE, coolant_power_kw: 35 }, strict).violated).toEqual(["power_feasible"]);
  });

  it("proposal schema is structure-only: unsafe plans are still valid proposals", () => {
    const unsafe = { ...SAFE, shed_loads: ["life_support"], coolant_loop: "A", scram_reactor: false, vent_reactor_section: true, coolant_power_kw: 5 };
    expect(SpaceStationProposalSchema.safeParse(unsafe).success).toBe(true);
    expect(SpaceStationProposalSchema.safeParse({ ...SAFE, coolant_loop: "banana" }).success).toBe(false);
  });
});
