import type { ProviderRegistry } from "../llm/registry.js";
import { EventRepository } from "../persistence/eventRepository.js";
import { ExperimentRepository } from "../persistence/experimentRepository.js";
import { EventType, type ExperimentEvent } from "./events.js";
import { computeMetrics, type ExperimentMetrics } from "./metrics.js";
import { termination } from "./outcome.js";
import { Phase } from "./phases.js";
import { ExperimentRunner, InvalidCommandError, type LiveState, type OperatorCommand, type RunnerDeps, type RunOptions } from "./runner.js";

export interface StartInput extends RunOptions {
  config: unknown;
  /** Override the provider registry for this run (batch runs use their own stub latency). */
  providers?: ProviderRegistry;
}

/**
 * Owns the experiments running in this process. The HTTP API and the batch
 * runner both start runs through here, so there is exactly one engine.
 */
export class ExperimentService {
  private readonly running = new Map<string, { runner: ExperimentRunner; done: Promise<ExperimentMetrics> }>();
  private readonly experiments: ExperimentRepository;
  private readonly events: EventRepository;
  private readonly finishedListeners = new Set<(experimentId: string) => void>();

  constructor(private readonly deps: RunnerDeps) {
    this.experiments = new ExperimentRepository(deps.db);
    this.events = new EventRepository(deps.db);
  }

  /** Validates and starts a run in the background; returns once the run record exists. */
  start(input: StartInput): { runner: ExperimentRunner; done: Promise<ExperimentMetrics> } {
    const { config, providers, ...options } = input;
    const runner = new ExperimentRunner(providers ? { ...this.deps, providers } : this.deps, config, options);
    const done = runner.run().finally(() => this.running.delete(runner.id));
    void done.then(() => this.notifyFinished(runner.id), () => undefined);
    done.catch((err: unknown) => console.error(`Experiment ${runner.id} crashed while finishing:`, err));
    const entry = { runner, done };
    this.running.set(runner.id, entry);
    return entry;
  }

  /**
   * Called after a run has fully finished — outcome, final events and ending
   * narration all persisted. For subsystems that act on a finished run (e.g.
   * the debrief); nothing they do can reach the run itself.
   */
  onRunFinished(listener: (experimentId: string) => void): () => void {
    this.finishedListeners.add(listener);
    return () => this.finishedListeners.delete(listener);
  }

  private notifyFinished(id: string): void {
    for (const listener of this.finishedListeners) {
      try {
        listener(id);
      } catch (err) {
        console.error(`run-finished listener failed for experiment ${id}:`, err);
      }
    }
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  runningIds(): string[] {
    return [...this.running.keys()];
  }

  liveState(id: string): LiveState | null {
    return this.running.get(id)?.runner.state() ?? null;
  }

  control(id: string, command: OperatorCommand): LiveState {
    const entry = this.running.get(id);
    if (!entry) throw new InvalidCommandError("Experiment is not running");
    entry.runner.control(command);
    return entry.runner.state();
  }

  /** Resolves when every currently running experiment has finished (tests, graceful shutdown). */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.running.values()].map((e) => e.done));
  }

  /**
   * Called once at startup: a run with no finished_at was cut off by a
   * restart or crash. It is closed as INTERRUPTED — with a final event so its
   * trace ends explicitly — and stays fully inspectable.
   */
  recoverInterrupted(): string[] {
    const ids = this.experiments.listUnfinishedIds().filter((id) => !this.running.has(id));
    for (const id of ids) {
      const outcome = termination("INTERRUPTED", "The server stopped while this experiment was running");
      const event: ExperimentEvent = {
        seq: this.events.maxSeq(id) + 1,
        ts: new Date().toISOString(),
        phase: Phase.FINISHED,
        type: EventType.EXPERIMENT_FINISHED,
        agentId: null,
        payload: { termination: outcome, recovered: true },
      };
      this.events.insert(id, event, JSON.stringify(event.payload));
      const record = this.experiments.getOrThrow(id);
      const metrics = computeMetrics(this.events.list(id), { intervened: record.intervened });
      this.experiments.update(id, {
        phase: Phase.FINISHED,
        status: outcome.status,
        outcome: outcome.outcome,
        outcomeDetail: { category: outcome.category, reason: outcome.reason },
        finishedAt: event.ts,
        summary: metrics as unknown as Record<string, unknown>,
      });
    }
    return ids;
  }
}
