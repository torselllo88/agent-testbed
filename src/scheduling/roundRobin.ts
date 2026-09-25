import { startAgentId, type RoutingDecision, type Scheduler, type SchedulingContext } from "./types.js";

/** Fixed rotation in config order, starting from startAgentId; agents may respond or PASS. Ignores explicit targets. */
export class RoundRobinScheduler implements Scheduler {
  readonly type = "round_robin";

  async next(ctx: SchedulingContext): Promise<RoutingDecision> {
    const order = ctx.config.agents.map((a) => a.id);
    if (!ctx.lastTurn) {
      return { agentId: startAgentId(ctx.config), source: "start", reason: "configured start agent" };
    }
    const lastIndex = order.indexOf(ctx.lastTurn.agentId);
    const agentId = order[(lastIndex + 1) % order.length]!;
    return { agentId, source: "round_robin", reason: `next after ${ctx.lastTurn.agentId}` };
  }
}
