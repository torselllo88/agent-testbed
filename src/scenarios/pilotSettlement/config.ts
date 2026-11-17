import { parseExperimentConfig, type ExperimentConfig } from "../../experiment/config.js";
import { PILOT_GENERATION } from "./adapter.js";
import { applyInstance, bundleInstances } from "./family.js";
import { AGENT_ID, AGENTS, ROLE_DESCRIPTION } from "./task.js";

/**
 * Pilot Settlement — the built-in configuration of the pilot (Plan §2, §3):
 * six agents in the task's order, K = 3 fixed rounds, Operations the required
 * proposer, no vote, no format retries; the pilot protocol adapter renders
 * every model input. Instance DEV-01 by default; a batch's `$instance` sets
 * any of the 50. Agents default to the probe stub (gate G1); real runs set
 * `$models` to the Ollama endpoint — the sampling settings of Plan §3.3
 * (temperature 1.0, top_p 0.95, top_k 20, min_p 0, num_predict 2560) belong
 * to the scenario and stay.
 */
export const PILOT_MODEL_DEFAULTS = {
  temperature: PILOT_GENERATION.temperature,
  maxOutputTokens: PILOT_GENERATION.maxOutputTokens,
  keepAlive: PILOT_GENERATION.keepAlive,
  sampling: PILOT_GENERATION.sampling,
} as const;

export function pilotSettlementConfig(instanceId = "DEV-01", agentModel = "pilot-settlement/probe"): ExperimentConfig {
  const base = parseExperimentConfig({
    schemaVersion: 1,
    name: "Pilot Settlement",
    description:
      "Distributed Settlement Decision (Task Definition v1.4, Plan v0.3.1): six roles, three fixed rounds, Operations returns the final proposal; Complete vs Ring. A research task.",
    task: { description: "Distributed settlement decision", sharedContext: "" },
    agents: AGENTS.map((role) => ({
      id: AGENT_ID[role],
      name: role,
      role: ROLE_DESCRIPTION[role],
      model: { provider: "stub", model: agentModel, structuredOutput: "prompt", ...PILOT_MODEL_DEFAULTS },
    })),
    scheduler: { type: "round_robin" },
    consensus: { rule: "none" },
    decision: { proposerId: AGENT_ID.Operations, maxProposalAttempts: 1, maxProposalFormatRetries: 0, proposalRequired: true },
    discussion: { fixedRounds: 3 },
    limits: { discussionTurnLimit: 18, rediscussionTurnLimit: 6, globalTurnLimit: 19, timeLimitSeconds: 7200 },
    agentVisibility: { discussionBudget: false },
    conversation: { language: "en" },
    runtime: { maxParseRetries: 0, maxProviderRetries: 2, providerRetryDelayMs: 5000, callTimeoutSeconds: 900 },
    evaluator: { id: "pilot-settlement", params: {} },
    protocol: { adapter: "pilot-settlement", params: {} },
    transport: { type: "local" },
  });
  const instance = bundleInstances()[instanceId];
  if (!instance) throw new Error(`pilot-settlement: unknown instance "${instanceId}"`);
  return parseExperimentConfig(applyInstance(base, instance));
}
