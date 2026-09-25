import type { ModelRef } from "../experiment/config.js";
import type { LlmCaller } from "../experiment/llmCaller.js";
import { TerminateRun } from "../experiment/outcome.js";
import { renderRouterPrompt, ROUTER_JSON_SCHEMA, RouterResponseSchema } from "../experiment/protocol.js";
import {
  leastRecentlyActivated,
  resolveAgentRef,
  startAgentId,
  type RoutingDecision,
  type Scheduler,
  type SchedulingContext,
} from "./types.js";

/**
 * 1. an explicit, valid target named by the last speaker;
 * 2. otherwise an LLM classifier choosing from the public conversation;
 * 3. otherwise (no classifier, classifier failed, or chose someone invalid)
 *    deterministic fallback: least recently activated agent.
 * Classifier calls are orchestration usage, never agent turns.
 */
export class HybridScheduler implements Scheduler {
  readonly type = "hybrid";

  constructor(
    private readonly classifier: ModelRef | null,
    private readonly classifierWindow: number,
    private readonly llm: LlmCaller
  ) {}

  async next(ctx: SchedulingContext): Promise<RoutingDecision> {
    const { lastTurn, config } = ctx;
    if (!lastTurn) return { agentId: startAgentId(config), source: "start", reason: "configured start agent" };

    const details: Record<string, unknown> = {};
    if (lastTurn.target) {
      const target = resolveAgentRef(lastTurn.target, config.agents);
      if (target && target !== lastTurn.agentId) {
        return { agentId: target, source: "explicit", reason: `${lastTurn.agentId} addressed ${target}` };
      }
      details.invalidExplicitTarget = lastTurn.target;
    }

    if (this.classifier) {
      const classified = await this.classify(ctx);
      if (classified.agentId) {
        return { agentId: classified.agentId, source: "classifier", reason: classified.reason, details };
      }
      details.classifierFailure = classified.reason;
    }

    const agentId = leastRecentlyActivated(ctx);
    return {
      agentId,
      source: "fallback",
      reason: this.classifier ? "classifier gave no usable choice" : "no explicit target; least recently activated",
      details,
    };
  }

  private async classify(ctx: SchedulingContext): Promise<{ agentId: string | null; reason: string }> {
    const lastSpeaker = ctx.lastTurn?.agentId ?? null;
    const candidates = ctx.config.agents.map((a) => a.id).filter((id) => id !== lastSpeaker);
    const prompt = renderRouterPrompt(ctx.config, ctx.transcript.slice(-this.classifierWindow), lastSpeaker, candidates);

    let result;
    try {
      result = await this.llm.call({
        category: "orchestration",
        purpose: "router",
        agentId: null,
        modelRef: this.classifier!,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        response: { name: "next_speaker", schema: RouterResponseSchema, jsonSchema: ROUTER_JSON_SCHEMA },
        context: { purpose: "router", candidates, lastSpeakerId: lastSpeaker, order: ctx.config.agents.map((a) => a.id) },
        turn: ctx.turn,
      });
    } catch (err) {
      // A router outage must not end the experiment: that is exactly what the
      // deterministic fallback is for. Operator stop still propagates.
      if (err instanceof TerminateRun && err.termination.outcome === "PROVIDER_ERROR") {
        return { agentId: null, reason: `classifier provider error: ${err.termination.reason}` };
      }
      throw err;
    }

    if (!result.ok) return { agentId: null, reason: `classifier response unparseable: ${result.parseError}` };
    const agentId = resolveAgentRef(result.value.nextAgentId, ctx.config.agents);
    if (!agentId || !candidates.includes(agentId)) {
      return { agentId: null, reason: `classifier chose invalid agent "${result.value.nextAgentId}"` };
    }
    return { agentId, reason: result.value.reason || "classifier choice" };
  }
}
