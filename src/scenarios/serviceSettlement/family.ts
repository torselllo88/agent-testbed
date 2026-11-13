import type { TaskFamily } from "../../batch/taskFamily.js";
import { SettlementParamsSchema } from "./evaluator.js";
import { SETTLEMENT_DEV_01, settlementTask } from "./task.js";

/**
 * The settlement task family: an instance is a SettlementParams set; facts and
 * ground truth both come from it. Named instances so far: dev-01. More are
 * written into a batch spec inline ({ "id", "params", "seed" }) or added here.
 */
export const settlementFamily: TaskFamily = {
  evaluatorId: "service-settlement",
  instances: {
    "dev-01": { params: SETTLEMENT_DEV_01, seed: 1 },
  },
  apply(config, raw) {
    const params = SettlementParamsSchema.parse(raw);
    const { task, roles } = settlementTask(params);
    return {
      ...config,
      task,
      agents: config.agents.map((a) => (a.id in roles ? { ...a, ...roles[a.id as keyof typeof roles] } : a)),
      evaluator: { ...config.evaluator, params: params as unknown as Record<string, unknown> },
    };
  },
};
