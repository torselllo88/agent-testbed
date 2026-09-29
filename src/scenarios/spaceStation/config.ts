import type { ExperimentConfig } from "../../experiment/config.js";
import {
  SPACE_STATION_CONSENSUS,
  SPACE_STATION_DECISION,
  SPACE_STATION_EVALUATOR,
  SPACE_STATION_ROLES,
  SPACE_STATION_TASK,
  stubModel,
  type SpaceStationRoleId,
} from "./task.js";

/**
 * Space Station Benchmark — the neutral, research-oriented scenario on the
 * Space Station task: functional roles, no persona, no narration, no pacing.
 * Pure data — the same thing the UI's raw JSON editor shows. Agents default
 * to the scripted stub models so it runs end-to-end with no API key; point
 * `model` at e.g. { "provider": "openrouter", "model": "anthropic/claude-sonnet-5" }
 * to run real LLM agents.
 */

const NAMES: Record<SpaceStationRoleId, string> = {
  operations: "Station Operations",
  engineering: "Reactor Engineering",
  power: "Power Systems",
  life_support: "Life Support",
};

export function spaceStationConfig(agentModel = "space-station/cooperative"): ExperimentConfig {
  // Deep copy: callers may mutate the result; the shared task constants must stay intact.
  return structuredClone({
    schemaVersion: 1,
    name: "Space Station Benchmark",
    description:
      "Four station officers each hold part of the information needed to recover from a reactor-cooling failure. They must share it, agree on one recovery plan, and commit to it; the plan is then checked against the station's physical constraints.",
    task: SPACE_STATION_TASK,
    agents: (Object.keys(SPACE_STATION_ROLES) as SpaceStationRoleId[]).map((id) => ({
      id,
      name: NAMES[id],
      ...SPACE_STATION_ROLES[id],
      model: stubModel(agentModel),
      persona: "",
      systemPrompt: "",
      tools: [],
    })),
    scheduler: {
      type: "hybrid",
      startAgentId: "operations",
      classifier: stubModel("router/next-in-order"),
      classifierWindow: 12,
    },
    consensus: SPACE_STATION_CONSENSUS,
    decision: SPACE_STATION_DECISION,
    limits: {
      discussionTurnLimit: 24,
      rediscussionTurnLimit: 8,
      globalTurnLimit: 80,
      agentTokenLimit: null,
      countOrchestrationTokens: false,
      totalTokenCap: null,
      totalCostCapUsd: null,
      timeLimitSeconds: 900,
    },
    agentVisibility: { discussionBudget: false },
    conversation: { language: "en" },
    presentation: {
      narrator: null,
      fallbackLanguage: "en",
      strings: {},
      missionFailurePriority: [],
      pacing: { minVisibleIntervalMs: 0, perCharMs: 0, maxGapMs: 10000 },
    },
    runtime: { maxParseRetries: 1, maxProviderRetries: 2, providerRetryDelayMs: 2000, callTimeoutSeconds: 120 },
    evaluator: SPACE_STATION_EVALUATOR,
    transport: { type: "local" },
  } satisfies ExperimentConfig);
}
