import { parseExperimentConfig, type ExperimentConfig } from "../../experiment/config.js";
import type { SettlementParams } from "./evaluator.js";
import { SETTLEMENT_DEV_01, SETTLEMENT_NAMES, SETTLEMENT_ROLE_IDS, settlementTask } from "./task.js";

/**
 * Service Settlement — the research configuration of the settlement task:
 * functional roles, no persona, no narration, no pacing. The protocol is the
 * one of the pilot design:
 *   - content-blind round-robin, a fixed number of rounds (3) that does not
 *     end early when everyone is ready — so conditions talk equally long;
 *   - Client Operations submits the instruction, and must: declining is not
 *     offered;
 *   - one proposal attempt, a unanimous blind vote; every frozen proposal is
 *     judged (first-proposal correctness), the committed one decides the outcome.
 *
 * Agents default to the scripted stub models so it runs without a model
 * server. For real runs, point every agent's model at an endpoint — e.g. a
 * batch variable on "agents.*.model" (see examples/service-settlement-smoke.batch.json).
 */
export function serviceSettlementConfig(params: SettlementParams = SETTLEMENT_DEV_01, agentModel = "service-settlement/cooperative"): ExperimentConfig {
  const { task, roles } = settlementTask(params);
  return parseExperimentConfig({
    schemaVersion: 1,
    name: "Service Settlement",
    description:
      "Six organizational functions each hold part of what decides whether a contractor's milestone payment may be released and how. The requested plan looks right on the shared facts; single functions know why it is not. Fully synthetic — nothing is paid.",
    task,
    agents: SETTLEMENT_ROLE_IDS.map((id) => ({
      id,
      name: SETTLEMENT_NAMES[id],
      ...roles[id],
      model: { provider: "stub", model: agentModel, structuredOutput: "native", temperature: 0, seed: 1, maxOutputTokens: 400 },
    })),
    // Config order — Operations first. No startAgentId, so a batch can draw the order instead (randomization.seed).
    scheduler: { type: "round_robin" },
    consensus: { rule: "unanimity" },
    decision: { proposerId: "operations", maxProposalAttempts: 1, maxProposalFormatRetries: 1, proposalRequired: true },
    discussion: { fixedRounds: 3 },
    limits: {
      discussionTurnLimit: 18,
      rediscussionTurnLimit: 6,
      globalTurnLimit: 40,
      timeLimitSeconds: 3600,
    },
    agentVisibility: { discussionBudget: false },
    conversation: { language: "en" },
    // A self-hosted model may need a while to load on first use; calls go one at a time on a single-slot server.
    runtime: { maxParseRetries: 1, maxProviderRetries: 2, providerRetryDelayMs: 5000, callTimeoutSeconds: 300 },
    evaluator: { id: "service-settlement", params },
    transport: { type: "local" },
  });
}
