import type { ExperimentConfig } from "../experiment/config.js";
import { EvaluatorRegistry } from "../evaluation/registry.js";
import type { StubProvider } from "../llm/stubProvider.js";
import { spaceStationConfig } from "./spaceStation/config.js";
import { spaceStationEvaluator } from "./spaceStation/evaluator.js";
import { kestrelConfig } from "./spaceStation/kestrel.js";
import { kestrelCascadeConfig } from "./kestrelCascade/config.js";
import { kestrelCascadeEvaluator } from "./kestrelCascade/evaluator.js";
import { registerCascadeStubs } from "./kestrelCascade/stubScripts.js";
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
  /** One line for the scenario library card. */
  summary: string;
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
  {
    id: "space-station",
    name: "Space Station Benchmark",
    summary: "Neutral coordination scenario — functional roles, no narration, no pacing",
    version: 2,
    config: () => spaceStationConfig(),
  },
  {
    id: "station-kestrel",
    name: "Station Kestrel",
    summary: "Humanized live demo — named officers, narration, paced for viewers (en, ru)",
    // v1: initial. v2: shorter demo (discussion 16 turns, maxOutputTokens 300, pacing 2000/10/6000),
    //     localized viewer labels for agents, human-readable proposal rendering.
    // v3: human interaction profile DEBRIEF (crew debrief after the mission), crew-voiced room notices.
    // v4: dramaturgy pass — short spoken dialogue (shared speech style), sharper personas, discussion 20 turns,
    //     observer-only escalation beats, the ending revealed as a paced sequence with the vote tally.
    // v5: speech style asks to PASS rather than repeat a point or question already answered, and to
    //     discuss what to do rather than report actions as done before the vote.
    version: 5,
    config: () => kestrelConfig(),
  },
  {
    id: "station-kestrel-cascade",
    name: "Station Kestrel: Cascade",
    summary: "Harder demo with the Kestrel crew — two recovery paths, facts split across all four officers (en, ru)",
    // v1: initial.
    version: 1,
    config: () => kestrelCascadeConfig(),
  },
];

export function createEvaluatorRegistry(): EvaluatorRegistry {
  return new EvaluatorRegistry().register(spaceStationEvaluator).register(kestrelCascadeEvaluator);
}

export function registerBuiltinStubs(stub: StubProvider): StubProvider {
  registerSpaceStationStubs(stub);
  registerCascadeStubs(stub);
  return stub;
}
