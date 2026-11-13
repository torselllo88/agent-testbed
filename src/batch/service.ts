import { randomUUID } from "node:crypto";
import { ConfigValidationError, configHash, parseExperimentConfig, type ExperimentConfig } from "../experiment/config.js";
import { checkRunnable, ConfigNotRunnableError, withEffectiveEvaluatorParams, type RunnerDeps } from "../experiment/runner.js";
import type { ExperimentService } from "../experiment/service.js";
import type { ProviderRegistry } from "../llm/registry.js";
import { BatchRepository, type BatchRecord, type ResolvedBatch } from "../persistence/batchRepository.js";
import { ExperimentRepository, type ExperimentRecord } from "../persistence/experimentRepository.js";
import { ScenarioRepository } from "../persistence/scenarioRepository.js";
import { BUILTIN_SCENARIOS } from "../scenarios/index.js";
import { aggregate, type ConditionAggregate } from "./aggregate.js";
import { BatchSpecSchema, conditionConfig, droppedVariable, expandConditions, planRuns, variableLabel, type BatchSpec } from "./spec.js";

export class BatchValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Batch cannot run: ${problems.length} problem(s)`);
    this.name = "BatchValidationError";
  }
}

export interface BatchProgress {
  total: number;
  finished: number;
  running: number;
  pending: number;
}

export interface BatchView {
  batch: BatchRecord;
  progress: BatchProgress;
  aggregates: ConditionAggregate[];
  overall: ConditionAggregate;
}

/** Hard cap on runs per batch — a typo in `repetitions` or a large variable grid should not queue thousands of paid runs. */
export const MAX_RUNS_PER_BATCH = 2000;

/**
 * Batch experiments on the same engine as interactive runs: every run is an
 * ordinary ExperimentRunner started through ExperimentService, stored as an
 * ordinary experiment (tagged with batch id, condition key, repetition).
 *
 * Batch runs get their own stub-provider instance with the batch's own
 * latency (0 unless the spec sets it), so they never inherit the web demo's
 * STUB_LATENCY_MS.
 */
export class BatchService {
  private readonly batches: BatchRepository;
  private readonly experiments: ExperimentRepository;
  private readonly scenarios: ScenarioRepository;
  private readonly active = new Map<string, { cancelled: boolean; running: Set<string>; done: Promise<void> }>();

  constructor(
    private readonly deps: RunnerDeps & { service: ExperimentService }
  ) {
    this.batches = new BatchRepository(deps.db);
    this.experiments = new ExperimentRepository(deps.db);
    this.scenarios = new ScenarioRepository(deps.db);
  }

  private providersFor(spec: BatchSpec): ProviderRegistry {
    return this.deps.providers.withStub(this.deps.providers.stub.withLatency(spec.stubLatencyMs));
  }

  /**
   * Resolves the base config and expands + validates every condition up
   * front; nothing is started if any condition is invalid.
   */
  resolve(rawSpec: unknown): ResolvedBatch & { conditionConfigs: Map<string, ExperimentConfig> } {
    const parsed = BatchSpecSchema.safeParse(rawSpec);
    if (!parsed.success) throw new BatchValidationError(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
    const spec = parsed.data;

    let rawBase: unknown;
    let scenarioId: string | null = null;
    let scenarioVersion: number | null = null;
    if ("scenarioId" in spec.base) {
      const scenario = this.scenarios.get(spec.base.scenarioId);
      if (!scenario) throw new BatchValidationError([`Unknown scenario "${spec.base.scenarioId}"`]);
      rawBase = scenario.config;
      scenarioId = scenario.id;
      scenarioVersion = scenario.version;
    } else if ("builtin" in spec.base) {
      const builtinId = spec.base.builtin;
      const builtin = BUILTIN_SCENARIOS.find((s) => s.id === builtinId);
      if (!builtin) throw new BatchValidationError([`Unknown builtin scenario "${builtinId}"`]);
      // Prefer the library row, so runs record which scenario (and version) they came from.
      const managed = this.scenarios.getBuiltin(builtinId);
      rawBase = managed?.config ?? builtin.config();
      scenarioId = managed?.id ?? null;
      scenarioVersion = managed?.version ?? null;
    } else {
      rawBase = spec.base.config;
    }

    let baseConfig: ExperimentConfig;
    try {
      baseConfig = parseExperimentConfig(rawBase);
    } catch (err) {
      throw new BatchValidationError(problemsOf(err, "base config"));
    }

    // Conditions are keyed by variable label and formatted value: both must be unambiguous,
    // or two variables would share one value / two conditions one config and one aggregate.
    const labels = spec.variables.map(variableLabel);
    const duplicateLabels = [...new Set(labels.filter((l, i) => labels.indexOf(l) !== i))];
    if (duplicateLabels.length) {
      throw new BatchValidationError(duplicateLabels.map((l) => `two variables share the label "${l}" — give each a distinct label`));
    }
    // The size cap before anything is built: a large cartesian product must not exhaust the process.
    let conditionCount = 1;
    for (const variable of spec.variables) {
      if (conditionCount > MAX_RUNS_PER_BATCH / (variable.values.length * spec.repetitions)) {
        const requested = spec.variables.reduce((n, v) => n * v.values.length, 1);
        throw new BatchValidationError([`${requested} conditions × ${spec.repetitions} repetitions requested; the limit is ${MAX_RUNS_PER_BATCH} runs`]);
      }
      conditionCount *= variable.values.length;
    }
    const conditions = expandConditions(spec.variables);
    const seenKeys = new Set<string>();
    const duplicateKeys = new Set<string>();
    for (const { key } of conditions) (seenKeys.has(key) ? duplicateKeys : seenKeys).add(key);
    if (duplicateKeys.size) {
      throw new BatchValidationError([...duplicateKeys].map((k) => `two conditions have the same key "${k}" — a variable lists the same value twice (e.g. 1 and "1")`));
    }
    const totalRuns = conditions.length * spec.repetitions;

    const providers = this.providersFor(spec);
    const problems: string[] = [];
    const conditionConfigs = new Map<string, ExperimentConfig>();
    const byHash = new Map<string, string>();
    for (const condition of conditions) {
      try {
        const raw = conditionConfig(baseConfig, spec.variables, condition);
        const parsed = parseExperimentConfig(raw);
        const dropped = spec.variables.map((v) => droppedVariable(raw, parsed, v)).filter((p): p is string => p !== null);
        if (dropped.length) {
          problems.push(...dropped.map((p) => `condition "${condition.key}": ${p}`));
          continue;
        }
        const { evaluatorParams } = checkRunnable({ providers, evaluators: this.deps.evaluators }, parsed);
        // As the run will snapshot and hash it: evaluator defaults applied.
        const config = withEffectiveEvaluatorParams(parsed, evaluatorParams);
        conditionConfigs.set(condition.key, config);
        // The last line of defence: two conditions that are one config would compare a thing with itself.
        const hash = configHash(config);
        const same = byHash.get(hash);
        if (same !== undefined) problems.push(`conditions "${same}" and "${condition.key}" produce the same config — they would measure the same thing`);
        else byHash.set(hash, condition.key);
      } catch (err) {
        problems.push(...problemsOf(err, `condition "${condition.key}"`));
      }
    }
    if (problems.length) throw new BatchValidationError([...new Set(problems)]);

    return { spec, baseConfig, scenarioId, scenarioVersion, conditions, totalRuns, conditionConfigs };
  }

  /** Validates, stores and starts a batch; returns immediately. */
  start(rawSpec: unknown): BatchRecord {
    const { conditionConfigs, ...resolved } = this.resolve(rawSpec);
    const id = randomUUID();
    const record = this.batches.create(id, resolved);

    const state = { cancelled: false, running: new Set<string>(), done: Promise.resolve() };
    this.active.set(id, state);
    state.done = this.execute(record, conditionConfigs, state).finally(() => this.active.delete(id));
    state.done.catch((err: unknown) => console.error(`Batch ${id} failed:`, err));
    return record;
  }

  private async execute(
    batch: BatchRecord,
    configs: Map<string, ExperimentConfig>,
    state: { cancelled: boolean; running: Set<string> }
  ): Promise<void> {
    const { spec, scenarioId, scenarioVersion, conditions } = batch.resolved;
    const providers = this.providersFor(spec);
    const queue = planRuns(conditions, spec.repetitions, spec.order);

    let failure: unknown = null;
    const worker = async () => {
      for (;;) {
        if (state.cancelled || failure) return;
        const next = queue.shift();
        if (!next) return;
        let started: ReturnType<ExperimentService["start"]>;
        try {
          started = this.deps.service.start({
          config: configs.get(next.condition.key)!,
          providers,
          scenarioId,
          scenarioVersion,
          batchId: batch.id,
          conditionKey: next.condition.key,
          repetition: next.repetition,
          origin: "batch",
          headless: spec.headless,
          });
        } catch (err) {
          // A run that cannot even be created (e.g. the database is locked): stop starting more — the batch ends interrupted.
          failure = err;
          console.error(`Batch ${batch.id}: could not start a run for "${next.condition.key}" #${next.repetition}:`, err);
          return;
        }
        state.running.add(started.runner.id);
        // A failure to persist a terminal result is an interrupted batch, not a completed one.
        await started.done.catch((err: unknown) => { failure = err; });
        state.running.delete(started.runner.id);
      }
    };

    try {
      await Promise.all(Array.from({ length: spec.concurrency }, worker));
    } finally {
      // Always leave the batch in a terminal state — never "running" with nothing behind it.
      this.batches.finish(batch.id, failure ? "interrupted" : state.cancelled ? "cancelled" : "completed");
    }
  }

  /**
   * A batch still marked running that no live process owns (its owner crashed):
   * marks it interrupted. Returns false when it is not such an orphan.
   */
  closeOrphan(id: string): boolean {
    if (this.active.has(id)) return false;
    if (!this.batches.listRunningIds().includes(id)) return false;
    this.batches.finish(id, "interrupted");
    return true;
  }

  /** Starts no further runs and stops the ones in flight (they end as STOPPED_BY_OPERATOR and are excluded from rates). */
  cancel(id: string): void {
    const state = this.active.get(id);
    if (!state) throw new BatchValidationError(["Batch is not running"]);
    state.cancelled = true;
    for (const experimentId of state.running) {
      try {
        this.deps.service.control(experimentId, { type: "stop" });
      } catch {
        // already finished
      }
    }
  }

  isRunning(id: string): boolean {
    return this.active.has(id);
  }

  async settle(id?: string): Promise<void> {
    const states = id ? [this.active.get(id)].filter(Boolean) : [...this.active.values()];
    await Promise.allSettled(states.map((s) => s!.done));
  }

  runs(id: string): ExperimentRecord[] {
    return this.experiments.list({ batchId: id, limit: MAX_RUNS_PER_BATCH });
  }

  view(id: string): BatchView {
    const batch = this.batches.getOrThrow(id);
    const runs = this.runs(id);
    const finished = runs.filter((r) => r.finishedAt).length;
    const running = runs.length - finished;
    const aggregates = batch.resolved.conditions.map((c) => aggregate(c.key, runs.filter((r) => r.conditionKey === c.key)));
    return {
      batch,
      progress: { total: batch.resolved.totalRuns, finished, running, pending: Math.max(0, batch.resolved.totalRuns - runs.length) },
      aggregates,
      overall: aggregate("all conditions", runs),
    };
  }

  list(): Array<{ batch: BatchRecord; progress: BatchProgress }> {
    return this.batches.list().map((batch) => {
      const runs = this.runs(batch.id);
      const finished = runs.filter((r) => r.finishedAt).length;
      return {
        batch,
        progress: {
          total: batch.resolved.totalRuns,
          finished,
          running: runs.length - finished,
          pending: Math.max(0, batch.resolved.totalRuns - runs.length),
        },
      };
    });
  }

  /** On server start: a batch still marked running was cut off by the restart (its unfinished runs are recovered by ExperimentService). */
  recoverInterrupted(): string[] {
    const ids = this.batches.listRunningIds().filter((id) => !this.active.has(id));
    for (const id of ids) this.batches.finish(id, "interrupted");
    return ids;
  }

  /** One row per run — the format for analysis outside the testbed. */
  csv(id: string): string {
    const batch = this.batches.getOrThrow(id);
    const labels = batch.resolved.spec.variables.map((v) => v.label ?? v.path);
    const conditionsByKey = new Map(batch.resolved.conditions.map((c) => [c.key, c]));
    const header = [
      "batch_id",
      "experiment_id",
      "condition_key",
      ...labels.map((l) => `var:${l}`),
      "repetition",
      "outcome",
      "category",
      "status",
      "consensus_reached",
      // The scenario's class of the committed outcome, and the failed checks; then the same for the first proposal.
      "outcome_class",
      "violated",
      "first_proposal_outcome",
      "first_proposal_class",
      "first_proposal_violated",
      "turns",
      "discussion_turns",
      "public_messages",
      "proposal_attempts",
      "agent_tokens",
      "orchestration_tokens",
      "total_tokens",
      "cost_usd",
      "calls_unknown_cost",
      "context_overflow_suspected",
      "calls_with_thinking",
      // Ollama: where the model was loaded (GET /api/ps after each call). Partly in CPU memory = not comparable.
      "calls_partial_gpu_offload",
      "calls_serving_unknown",
      "min_gpu_fraction",
      "duration_active_ms",
      "addressed_share",
      "interaction_density",
      "interaction_reciprocity",
      "participation_evenness",
      "silent_agents",
      "turns_to_first_proposal",
      "intervened",
      "config_hash",
      // configHash is the effective configuration; the evaluator version judging it is runtime metadata beside it.
      "evaluator_version",
      "protocol_fingerprint",
      "task_definition_hash",
    ];
    const rows = this.runs(id)
      .slice()
      .sort((a, b) => (a.conditionKey ?? "").localeCompare(b.conditionKey ?? "") || (a.repetition ?? 0) - (b.repetition ?? 0))
      .map((r) => {
        const m = (r.summary ?? {}) as any;
        const values = conditionsByKey.get(r.conditionKey ?? "")?.values ?? {};
        return [
          id,
          r.id,
          r.conditionKey,
          ...labels.map((l) => (typeof values[l] === "string" ? values[l] : JSON.stringify(values[l]))),
          r.repetition,
          r.outcome,
          m.termination?.category,
          r.status,
          m.consensusReached,
          m.evaluation?.classification,
          Array.isArray(m.evaluation?.violated) ? m.evaluation.violated.join(";") : undefined,
          m.proposals?.first?.outcome,
          m.proposals?.first?.classification,
          m.proposals?.first ? m.proposals.first.violated.join(";") : undefined,
          m.turns?.total,
          m.turns?.byKind?.discussion ?? 0,
          m.messages?.public,
          m.proposals?.attempts,
          m.tokens?.agent,
          m.tokens?.orchestration,
          m.tokens?.total,
          m.costUsd?.total,
          m.costUsd?.callsWithUnknownCost,
          m.llmCalls?.contextOverflowSuspected,
          m.llmCalls?.withThinking,
          m.llmCalls?.partialGpuOffload,
          m.llmCalls?.servingUnknown,
          m.llmCalls?.minGpuFraction,
          m.durationMs?.active,
          m.communication?.addressedShare,
          m.communication?.interactionDensity,
          m.communication?.interactionReciprocity,
          m.communication?.participation?.evenness,
          m.communication?.participation?.silentAgents,
          m.communication?.timeline?.turnsToFirstProposal,
          r.intervened,
          r.configHash,
          m.evaluatorVersion,
          m.protocolFingerprint,
          r.taskDefinitionHash,
        ];
      });
    return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
  }
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function problemsOf(err: unknown, where: string): string[] {
  if (err instanceof ConfigValidationError) return err.issues.map((i) => `${where}: ${i.path.join(".") || "(root)"}: ${i.message}`);
  if (err instanceof ConfigNotRunnableError) return err.problems.map((p) => `${where}: ${p}`);
  return [`${where}: ${err instanceof Error ? err.message : String(err)}`];
}
