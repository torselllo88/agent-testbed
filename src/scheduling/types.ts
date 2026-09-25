import type { AgentConfig, ExperimentConfig } from "../experiment/config.js";
import type { RoomMessage } from "../transport/transport.js";

/** Where a turn assignment came from — stored on every routing_decision event and aggregated in routing statistics. */
export type RoutingSource =
  | "start"
  | "round_robin"
  | "explicit"
  | "classifier"
  | "fallback"
  | "readiness_recheck"
  | "operator";

export interface RoutingDecision {
  agentId: string;
  source: RoutingSource;
  reason: string;
  /** Extra specifics, e.g. an invalid explicit target or why the classifier result was rejected. */
  details?: Record<string, unknown>;
}

export interface LastTurn {
  agentId: string;
  pass: boolean;
  /** The target the agent asked for, as written (may be invalid). */
  target: string | null;
}

export interface SchedulingContext {
  config: ExperimentConfig;
  transcript: RoomMessage[];
  lastTurn: LastTurn | null;
  /** Global turn number at which each agent was last activated (absent = never). */
  lastActivatedTurn: ReadonlyMap<string, number>;
  turn: number;
}

/**
 * Picks the next speaker during DISCUSSION. Only decides WHO speaks, never
 * what is correct — schedulers see the public room only. New strategies
 * (leader-based, expertise-based, random, ...) plug in here without touching
 * the runner.
 */
export interface Scheduler {
  readonly type: string;
  next(ctx: SchedulingContext): Promise<RoutingDecision>;
}

export function startAgentId(config: ExperimentConfig): string {
  return config.scheduler.startAgentId ?? config.agents[0]!.id;
}

/** Resolves an agent reference as a model might write it: exact id, id in any case, or display name. */
export function resolveAgentRef(ref: string | null | undefined, agents: AgentConfig[]): string | null {
  if (!ref) return null;
  const needle = ref.trim().replace(/^@/, "").toLowerCase();
  if (!needle) return null;
  const match = agents.find((a) => a.id.toLowerCase() === needle) ?? agents.find((a) => a.name.toLowerCase() === needle);
  return match?.id ?? null;
}

/** Deterministic fallback: whoever has waited longest (never-activated first), ties broken by config order; never the last speaker. */
export function leastRecentlyActivated(ctx: SchedulingContext): string {
  const candidates = ctx.config.agents.filter((a) => a.id !== ctx.lastTurn?.agentId);
  const pool = candidates.length > 0 ? candidates : ctx.config.agents;
  let best = pool[0]!;
  for (const agent of pool) {
    const a = ctx.lastActivatedTurn.get(agent.id) ?? -1;
    const b = ctx.lastActivatedTurn.get(best.id) ?? -1;
    if (a < b) best = agent;
  }
  return best.id;
}
