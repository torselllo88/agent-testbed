import { describe, expect, it } from "vitest";
import { parseExperimentConfig, type ExperimentConfig } from "../../src/experiment/config.js";
import { createEvaluatorRegistry } from "../../src/scenarios/index.js";
import { kestrelCascadeConfig } from "../../src/scenarios/kestrelCascade/config.js";
import { kestrelConfig } from "../../src/scenarios/spaceStation/kestrel.js";
import { SAFE_PLAN } from "../helpers/harness.js";

/** A new evaluator check must not land without its ending: every check has a narrated failure in each language, and a priority slot. */

const CASCADE_PLAN = {
  recovery_path: "loop_b",
  actions: ["switch_beacon_to_battery", "shutdown_research_labs", "shutdown_external_communications", "route_power_to_loop_b", "start_loop_b", "scram_reactor"],
  life_support_power_kw: 40,
};

const cases: Array<[string, () => ExperimentConfig, unknown]> = [
  ["Station Kestrel", kestrelConfig, SAFE_PLAN],
  ["Station Kestrel: Cascade", kestrelCascadeConfig, CASCADE_PLAN],
];

describe("narrated scenarios cover every evaluator check", () => {
  for (const [name, make, proposal] of cases) {
    it(name, () => {
      const config = parseExperimentConfig(make());
      const evaluator = createEvaluatorRegistry().get(config.evaluator.id);
      const checks = Object.keys(evaluator.evaluate(evaluator.proposalSchema.parse(proposal), evaluator.paramsSchema.parse(config.evaluator.params)).checks);
      expect(checks.length).toBeGreaterThan(0);
      for (const language of ["en", "ru"]) {
        const missing = checks.filter((c) => !config.presentation.strings[language]?.missionFailure?.[c]);
        expect(missing, `missing ${language} missionFailure narration`).toEqual([]);
      }
      expect(checks.filter((c) => !config.presentation.missionFailurePriority.includes(c)), "missing from missionFailurePriority").toEqual([]);
    });
  }
});
