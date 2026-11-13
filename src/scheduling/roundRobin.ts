import { resolveLayout, rotation } from "../experiment/topology.js";
import type { RoutingDecision, Scheduler, SchedulingContext } from "./types.js";

/**
 * Fixed rotation — the speaking order: config order from startAgentId, an
 * explicit scheduler.order, or one drawn from randomization.seed (see
 * experiment/topology.ts). Agents may respond or PASS. Ignores explicit targets.
 */
export class RoundRobinScheduler implements Scheduler {
  readonly type = "round_robin";

  async next(ctx: SchedulingContext): Promise<RoutingDecision> {
    // A config whose own scheduler is another one (e.g. a direct call in tests) still rotates from its start agent.
    const order = resolveLayout(ctx.config).speakingOrder ?? rotation(ctx.config);
    if (!ctx.lastTurn) {
      const drawn = ctx.config.randomization?.speakingOrder === true;
      return { agentId: order[0]!, source: "start", reason: drawn ? "first in the drawn speaking order" : "configured start agent" };
    }
    const lastIndex = order.indexOf(ctx.lastTurn.agentId);
    const agentId = order[(lastIndex + 1) % order.length]!;
    return { agentId, source: "round_robin", reason: `next after ${ctx.lastTurn.agentId}` };
  }
}
