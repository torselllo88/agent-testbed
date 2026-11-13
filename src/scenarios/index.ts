import type { ExperimentConfig } from "../experiment/config.js";
import { EvaluatorRegistry } from "../evaluation/registry.js";
import type { StubProvider } from "../llm/stubProvider.js";
import { registerGenericStubs } from "../llm/stubRouters.js";
import { spaceStationConfig } from "./spaceStation/config.js";
import { spaceStationEvaluator } from "./spaceStation/evaluator.js";
import { kestrelConfig } from "./spaceStation/kestrel.js";
import { kestrelCascadeConfig } from "./kestrelCascade/config.js";
import { kestrelCascadeEvaluator } from "./kestrelCascade/evaluator.js";
import { registerCascadeStubs } from "./kestrelCascade/stubScripts.js";
import { registerSpaceStationStubs } from "./spaceStation/stubScripts.js";
import { serviceSettlementConfig } from "./serviceSettlement/config.js";
import { serviceSettlementEvaluator } from "./serviceSettlement/evaluator.js";
import { registerSettlementStubs } from "./serviceSettlement/stubScripts.js";
import { settlementFamily } from "./serviceSettlement/family.js";
import type { TaskFamily } from "../batch/taskFamily.js";

export { DEMO, demoFacts, type DemoContent, type DemoSection } from "./demo.js";

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
    // v6: the debrief has its own router model (humanInteraction.debrief.router) instead of borrowing the scheduler's.
    // v7: name aliases for the debrief (humanInteraction.aliases: Russian case forms); whole-word keyword routing.
    version: 7,
    config: () => kestrelConfig(),
  },
  {
    id: "station-kestrel-cascade",
    name: "Station Kestrel: Cascade",
    summary: "Harder demo with the Kestrel crew — two recovery paths, facts split across all four officers (en, ru)",
    // v1: initial. v2: evaluator v2 (judges what the plan does, not only its declared path); own debrief router.
    // v3: evaluator v3 (physical order: power before start, shutdowns before routing, evacuate before isolate).
    // v4: evaluator v4 (powered-before-use for every system the plan runs; each failure narrates its own figures);
    //     name aliases for the debrief (Russian case forms).
    // v5: evaluator v5 — "R3 clear before the dump" split into evacuated-before and isolated-before, each with a
    //     truthful ending of its own.
    // v6: evaluator v6 — evacuation before loop B consumes the reactor window; grounded deadline ending.
    version: 6,
    config: () => kestrelCascadeConfig(),
  },
  {
    id: "service-settlement",
    name: "Service Settlement",
    summary: "Research task — six functions decide a contractor's milestone payment; hidden-profile facts, fixed rounds, outcome classes",
    // v1: initial — instance dev-01, 3 fixed rounds, required proposal, one attempt.
    // v2: no scheduler.startAgentId (the rotation still starts with Operations, first in config order),
    //     so a batch can draw the speaking order from a seed (randomization, $instance).
    version: 2,
    config: () => serviceSettlementConfig(),
  },
];

/** Task families by evaluator id: what a batch's `$instance` variable can draw on. */
export const TASK_FAMILIES: ReadonlyMap<string, TaskFamily> = new Map([[settlementFamily.evaluatorId, settlementFamily]]);

export function createEvaluatorRegistry(): EvaluatorRegistry {
  return new EvaluatorRegistry().register(spaceStationEvaluator).register(kestrelCascadeEvaluator).register(serviceSettlementEvaluator);
}

export function registerBuiltinStubs(stub: StubProvider): StubProvider {
  registerGenericStubs(stub);
  registerSpaceStationStubs(stub);
  registerCascadeStubs(stub);
  registerSettlementStubs(stub);
  return stub;
}
