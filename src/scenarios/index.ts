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
  config: () => ExperimentConfig;
}

export const BUILTIN_SCENARIOS: BuiltinScenario[] = [
  { id: "space-station", name: "Space Station Emergency", config: () => spaceStationConfig() },
];

export function createEvaluatorRegistry(): EvaluatorRegistry {
  return new EvaluatorRegistry().register(spaceStationEvaluator);
}

export function registerBuiltinStubs(stub: StubProvider): StubProvider {
  registerSpaceStationStubs(stub);
  return stub;
}
