import type { ExperimentMetrics } from "../experiment/metrics.js";
import type { ExperimentRecord } from "../persistence/experimentRepository.js";

export interface Stat {
  n: number;
  mean: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
}

export interface ConditionAggregate {
  key: string;
  runs: number;
  finished: number;
  /** Finished runs that were not ABORTED (infrastructure/operator) — the denominator of successRate. */
  evaluable: number;
  /**
   * Finished runs left out of successRate/consensusRate, by outcome
   * (PROVIDER_ERROR, ERROR, INTERRUPTED, STOPPED_BY_OPERATOR). Always reported
   * next to the rates so provider instability is never hidden by the denominator.
   */
  excluded: { total: number; byOutcome: Record<string, number> };
  /** Shorthand for excluded.byOutcome.PROVIDER_ERROR. */
  providerErrors: number;
  success: number;
  successRate: number | null;
  /** Wilson score interval, 95%. */
  successRateCI95: [number, number] | null;
  /** Over evaluable runs that had a vote; null when none had (consensus rule "none"). */
  consensusRate: number | null;
  /**
   * First-proposal correctness: among evaluable runs whose first proposal was
   * frozen (and judged — runs recorded before this metric are left out), how
   * many first proposals passed every check, whatever the vote made of them.
   */
  firstProposal: { n: number; success: number; rate: number | null; ci95: [number, number] | null };
  /** The scenario's outcome classes of committed outcomes (evaluators that report one), e.g. { correct: 7, unsafe: 2 }. */
  classifications: Record<string, number>;
  /** Calls whose prompt probably did not fit the context window, over all runs — should be 0. */
  contextOverflowSuspected: number;
  /**
   * Finished runs with at least one call served while the model was partly in
   * CPU memory (Ollama) — should be 0: such runs are slower and not
   * numerically comparable to the others. Find them by the CSV's
   * calls_partial_gpu_offload.
   */
  runsWithPartialGpuOffload: number;
  outcomes: Record<string, number>;
  categories: Record<string, number>;
  intervened: number;
  tokens: { total: Stat; agent: Stat; orchestration: Stat };
  turns: Stat;
  publicMessages: Stat;
  durationMs: Stat;
  costUsd: { total: number; mean: number | null; callsWithUnknownCost: number };
  /** Structural communication (runs recorded before these metrics existed are left out). */
  communication: { addressedShare: Stat; evenness: Stat; turnsToFirstProposal: Stat };
}

const numbers = (values: Array<number | null | undefined>): number[] => values.filter((v): v is number => typeof v === "number");

export function stat(values: number[]): Stat {
  if (values.length === 0) return { n: 0, mean: null, median: null, min: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    n: sorted.length,
    mean: sorted.reduce((s, v) => s + v, 0) / sorted.length,
    median: sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2,
    min: sorted[0]!,
    max: sorted.at(-1)!,
  };
}

export function wilson(successes: number, n: number, z = 1.96): [number, number] | null {
  if (n === 0) return null;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

const inc = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
const rate = <T>(items: T[], hit: (item: T) => boolean): number | null => (items.length ? items.filter(hit).length / items.length : null);

/**
 * Aggregates finished runs. Aborted runs (provider errors, interruptions,
 * operator stops) are counted and listed but excluded from success and
 * consensus rates — they say nothing about coordination. Token/turn/duration
 * statistics cover every finished run.
 */
export function aggregate(key: string, runs: ExperimentRecord[]): ConditionAggregate {
  const finished = runs.filter((r) => r.finishedAt && r.summary);
  const metrics = finished.map((r) => r.summary as unknown as ExperimentMetrics);
  const evaluable = finished.filter((r) => r.status !== "ABORTED");
  const evaluableMetrics = evaluable.map((r) => r.summary as unknown as ExperimentMetrics);
  const success = evaluable.filter((r) => r.outcome === "SUCCESS").length;
  const excludedByOutcome: Record<string, number> = {};
  for (const r of finished) if (r.status === "ABORTED") inc(excludedByOutcome, r.outcome ?? "UNKNOWN");

  const outcomes: Record<string, number> = {};
  const categories: Record<string, number> = {};
  for (const m of metrics) {
    if (m.termination) {
      inc(outcomes, m.termination.outcome);
      inc(categories, m.termination.category);
    }
  }

  const firsts = evaluableMetrics.map((m) => m.proposals?.first).filter((f) => f != null);
  const firstSuccess = firsts.filter((f) => f.outcome === "SUCCESS").length;
  const classifications: Record<string, number> = {};
  for (const m of metrics) {
    const c = (m.evaluation as { classification?: unknown } | null)?.classification;
    if (typeof c === "string") inc(classifications, c);
  }

  return {
    key,
    runs: runs.length,
    finished: finished.length,
    evaluable: evaluable.length,
    excluded: { total: finished.length - evaluable.length, byOutcome: excludedByOutcome },
    providerErrors: excludedByOutcome.PROVIDER_ERROR ?? 0,
    success,
    successRate: evaluable.length ? success / evaluable.length : null,
    successRateCI95: wilson(success, evaluable.length),
    consensusRate: rate(evaluableMetrics.filter((m) => m.consensusRule !== "none"), (m) => m.consensusReached),
    firstProposal: { n: firsts.length, success: firstSuccess, rate: firsts.length ? firstSuccess / firsts.length : null, ci95: wilson(firstSuccess, firsts.length) },
    classifications,
    contextOverflowSuspected: metrics.reduce((s, m) => s + (m.llmCalls?.contextOverflowSuspected ?? 0), 0),
    runsWithPartialGpuOffload: metrics.filter((m) => (m.llmCalls?.partialGpuOffload ?? 0) > 0).length,
    outcomes,
    categories,
    intervened: finished.filter((r) => r.intervened).length,
    tokens: {
      total: stat(metrics.map((m) => m.tokens.total)),
      agent: stat(metrics.map((m) => m.tokens.agent)),
      orchestration: stat(metrics.map((m) => m.tokens.orchestration)),
    },
    turns: stat(metrics.map((m) => m.turns.total)),
    publicMessages: stat(metrics.map((m) => m.messages.public)),
    durationMs: stat(metrics.map((m) => m.durationMs.active).filter((v): v is number => v !== null)),
    costUsd: {
      total: metrics.reduce((s, m) => s + m.costUsd.total, 0),
      mean: metrics.length ? metrics.reduce((s, m) => s + m.costUsd.total, 0) / metrics.length : null,
      callsWithUnknownCost: metrics.reduce((s, m) => s + m.costUsd.callsWithUnknownCost, 0),
    },
    communication: {
      addressedShare: stat(numbers(metrics.map((m) => m.communication?.addressedShare))),
      evenness: stat(numbers(metrics.map((m) => m.communication?.participation.evenness))),
      turnsToFirstProposal: stat(numbers(metrics.map((m) => m.communication?.timeline.turnsToFirstProposal))),
    },
  };
}
