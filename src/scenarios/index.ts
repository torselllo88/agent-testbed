import type { ExperimentConfig } from "../experiment/config.js";
import { EvaluatorRegistry } from "../evaluation/registry.js";
import type { StubProvider } from "../llm/stubProvider.js";
import { spaceStationConfig } from "./spaceStation/config.js";
import { spaceStationEvaluator } from "./spaceStation/evaluator.js";
import { registerSpaceStationStubs } from "./spaceStation/stubScripts.js";

/**
 * Everything scenario-specific the generic runtime can be given: evaluators
 * (by id), stub scripts (by stub model name), and ready-made configs. A new
 * scenario adds one folder next to spaceStation/ and one line per registry
 * here — nothing in experiment/, scheduling/ or transport/ changes.
 */

export interface BuiltinScenario {
  id: string;
  name: string;
  /**
   * Bumped whenever the built-in definition changes in a way that affects
   * runs. Saved copies in a database are never updated automatically — they
   * keep the version they were created from.
   *   v1: original wording
   *   v2: Power's private information states explicitly that the 40 kW life-support
   *       allocation is existing load (not extra demand) and the 10 kW reserve is free
   */
  version: number;
  config: () => ExperimentConfig;
}

export const BUILTIN_SCENARIOS: BuiltinScenario[] = [
  { id: "space-station", name: "Space Station Benchmark", version: 2, config: () => spaceStationConfig() },
];

export function createEvaluatorRegistry(): EvaluatorRegistry {
  return new EvaluatorRegistry().register(spaceStationEvaluator);
}

export function registerBuiltinStubs(stub: StubProvider): StubProvider {
  registerSpaceStationStubs(stub);
  return stub;
}
