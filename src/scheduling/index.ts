import type { SchedulerConfig } from "../experiment/config.js";
import type { LlmCaller } from "../experiment/llmCaller.js";
import { HybridScheduler } from "./hybrid.js";
import { RoundRobinScheduler } from "./roundRobin.js";
import type { Scheduler } from "./types.js";

export type { RoutingDecision, RoutingSource, Scheduler, SchedulingContext } from "./types.js";

export const SCHEDULER_TYPES = ["round_robin", "hybrid"] as const;

export function createScheduler(config: SchedulerConfig, deps: { llm: LlmCaller }): Scheduler {
  switch (config.type) {
    case "round_robin":
      return new RoundRobinScheduler();
    case "hybrid":
      return new HybridScheduler(config.classifier, config.classifierWindow, deps.llm);
  }
}
