import type { TokenUsage } from "../llm/provider.js";
import type { LimitsConfig } from "./config.js";
import { termination, type Termination } from "./outcome.js";

export type UsageCategory = "agent" | "orchestration";

export interface UsageTotals {
  agentTokens: number;
  orchestrationTokens: number;
  totalTokens: number;
  costUsd: number;
  /** Calls whose cost could not be determined — costUsd is then a lower bound. */
  callsWithUnknownCost: number;
  /** Calls where the provider reported no token usage (e.g. a failed request). */
  callsWithUnknownUsage: number;
  llmCalls: number;
}

/**
 * Counts every LLM call (retries and failed attempts included) and every
 * agent activation, and answers "has a hard limit been hit?".
 *
 * Token and cost limits are checked by the runner at step boundaries; an
 * in-flight call is never cut short for tokens. A limit can therefore be
 * overshot by one step's worth of usage — and a step is not always one call:
 * a discussion turn may include parse retries, and the VOTING step is N
 * parallel calls (one per agent). The overshoot is recorded in the
 * termination detail. The cost cap is an emergency brake, not a guarantee:
 * cost is only known after a call returns; per-call `maxOutputTokens` on a
 * model reference is what bounds the worst case. The time limit is the
 * exception — it also aborts an in-flight call (see LlmCaller).
 */
export class BudgetTracker {
  private agentTokens = 0;
  private orchestrationTokens = 0;
  private costUsd = 0;
  private callsWithUnknownCost = 0;
  private callsWithUnknownUsage = 0;
  private llmCalls = 0;
  private turns = 0;

  private startedAtMs: number | null = null;
  private pausedAtMs: number | null = null;
  private pausedTotalMs = 0;

  constructor(
    private readonly limits: LimitsConfig,
    private readonly now: () => number = Date.now
  ) {}

  start(): void {
    this.startedAtMs = this.now();
  }

  pause(): void {
    if (this.pausedAtMs === null) this.pausedAtMs = this.now();
  }

  resume(): void {
    if (this.pausedAtMs !== null) {
      this.pausedTotalMs += this.now() - this.pausedAtMs;
      this.pausedAtMs = null;
    }
  }

  /** Wall-clock time the run has been active, excluding operator pauses. */
  activeElapsedMs(): number {
    if (this.startedAtMs === null) return 0;
    const pausedNow = this.pausedAtMs !== null ? this.now() - this.pausedAtMs : 0;
    return this.now() - this.startedAtMs - this.pausedTotalMs - pausedNow;
  }

  /** Remaining active time before TIMEOUT, or null when there is no time limit. */
  remainingMs(): number | null {
    if (this.limits.timeLimitSeconds === null) return null;
    return this.limits.timeLimitSeconds * 1000 - this.activeElapsedMs();
  }

  recordCall(category: UsageCategory, usage: TokenUsage | null, costUsd: number | undefined): void {
    this.llmCalls += 1;
    const tokens = usage ? usage.promptTokens + usage.completionTokens : 0;
    if (!usage) this.callsWithUnknownUsage += 1;
    if (category === "agent") this.agentTokens += tokens;
    else this.orchestrationTokens += tokens;
    if (costUsd === undefined) this.callsWithUnknownCost += 1;
    else this.costUsd += costUsd;
  }

  recordTurn(): number {
    this.turns += 1;
    return this.turns;
  }

  turnsUsed(): number {
    return this.turns;
  }

  totals(): UsageTotals {
    return {
      agentTokens: this.agentTokens,
      orchestrationTokens: this.orchestrationTokens,
      totalTokens: this.agentTokens + this.orchestrationTokens,
      costUsd: this.costUsd,
      callsWithUnknownCost: this.callsWithUnknownCost,
      callsWithUnknownUsage: this.callsWithUnknownUsage,
      llmCalls: this.llmCalls,
    };
  }

  /** Tokens counted against agentTokenLimit — orchestration tokens only when countOrchestrationTokens. */
  experimentalBudgetTokens(): number {
    return this.agentTokens + (this.limits.countOrchestrationTokens ? this.orchestrationTokens : 0);
  }

  /** The time limit alone — also checked mid-activation, unlike token limits (see LlmCaller). */
  checkTimeLimit(): Termination | null {
    const remaining = this.remainingMs();
    if (remaining === null || remaining > 0) return null;
    return termination("TIMEOUT", `Time limit of ${this.limits.timeLimitSeconds}s reached`, {
      limit: "timeLimitSeconds",
      value: this.limits.timeLimitSeconds,
    });
  }

  /**
   * First hard limit that has been reached, or null. `turnsNeeded` lets the
   * caller check before a step that needs several activations at once
   * (voting) that they all fit.
   */
  checkHardLimits(turnsNeeded = 0): Termination | null {
    const { limits } = this;
    const timeout = this.checkTimeLimit();
    if (timeout) return timeout;
    if (this.turns + turnsNeeded > limits.globalTurnLimit) {
      return termination("TURN_LIMIT_EXCEEDED", `Global turn limit of ${limits.globalTurnLimit} reached`, {
        limit: "globalTurnLimit",
        value: limits.globalTurnLimit,
        turnsUsed: this.turns,
        turnsNeeded,
      });
    }
    if (limits.agentTokenLimit !== null && this.experimentalBudgetTokens() >= limits.agentTokenLimit) {
      return termination("TOKEN_BUDGET_EXCEEDED", `Agent token budget of ${limits.agentTokenLimit} reached`, {
        limit: "agentTokenLimit",
        value: limits.agentTokenLimit,
        used: this.experimentalBudgetTokens(),
        overshoot: this.experimentalBudgetTokens() - limits.agentTokenLimit,
        countOrchestrationTokens: limits.countOrchestrationTokens,
      });
    }
    const total = this.agentTokens + this.orchestrationTokens;
    if (limits.totalTokenCap !== null && total >= limits.totalTokenCap) {
      return termination("TOKEN_BUDGET_EXCEEDED", `Total token safety cap of ${limits.totalTokenCap} reached`, {
        limit: "totalTokenCap",
        value: limits.totalTokenCap,
        used: total,
        overshoot: total - limits.totalTokenCap,
      });
    }
    if (limits.totalCostCapUsd !== null && this.costUsd >= limits.totalCostCapUsd) {
      return termination("COST_LIMIT_EXCEEDED", `Total cost safety cap of $${limits.totalCostCapUsd} reached`, {
        limit: "totalCostCapUsd",
        value: limits.totalCostCapUsd,
        used: this.costUsd,
        overshoot: this.costUsd - limits.totalCostCapUsd,
        callsWithUnknownCost: this.callsWithUnknownCost,
      });
    }
    return null;
  }
}
