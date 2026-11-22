/**
 * The research demo's live run: one dev instance, Complete then Ring, on a provider other than the
 * pilot's (OpenRouter, or the stub in tests), then the detector with the same provider, shown in the
 * replay's own view. Exploratory by construction (plan §3.3 settings not enforced, counts
 * approximate, n = 1), and labelled so everywhere: the adapter's `exploratory` flag, the run log's
 * testbed block, the view's validity. Never a pilot or development run.
 *
 * Sessions are rows of `pilot_live_sessions` (the two experiments are ordinary experiment rows);
 * a session cut off by a restart is closed as interrupted on the next start. One session runs at a
 * time; a running one can be cancelled (its current experiment is stopped).
 */
import { randomUUID } from "node:crypto";
import { parseExperimentConfig, type ExperimentConfig, type ModelRef } from "../../experiment/config.js";
import { computeMetrics } from "../../experiment/metrics.js";
import type { ExperimentService } from "../../experiment/service.js";
import { estimateCostUsd } from "../../llm/pricing.js";
import type { ProviderRegistry } from "../../llm/registry.js";
import { processOwnerId, type Db } from "../../persistence/db.js";
import { EventRepository } from "../../persistence/eventRepository.js";
import { ExperimentRepository } from "../../persistence/experimentRepository.js";
import { PilotLiveRepository, type PilotLiveRow } from "../../persistence/pilotLiveRepository.js";
import { pilotSettlementConfig } from "./config.js";
import { bundleInstances } from "./family.js";
import { buildRunLog } from "./runLog.js";
import { createExtractor, detectRun, type DetectorOutput, type RunLogLike } from "./detector/detect.js";
import { instanceViewFromLogs, type DetectorFile, type InstanceView, type RunLogFile } from "./demoData.js";
import { AGENT_ID, type RoleName } from "./task.js";

export interface LiveModels {
  /** The agents' model (OpenRouter in the demo). */
  agents: ModelRef;
  /** The detector's extraction model; the provider must give JSON (natively or in the prompt). */
  extraction: ModelRef;
}

export type LiveStage = "complete" | "ring" | "detector" | "done" | "failed" | "cancelling" | "cancelled";

export interface LiveRunState {
  topology: "complete" | "ring";
  experimentId: string | null;
  status: "pending" | "running" | "finished" | "failed";
  turn: number;
  outcome: string | null;
  correct: boolean | null;
  category: string | null;
  costUsd: number | null;
  tokens: number | null;
}

export interface LiveCost {
  agentsUsd: number;
  detectorUsd: number;
  totalUsd: number;
  tokens: { agents: number; detectorIn: number; detectorOut: number };
  /** Calls whose price is unknown (the model is not in the price table): the total is a floor. */
  unknownCalls: number;
}

export interface LiveSession {
  id: string;
  instance: string;
  models: { agents: string; extraction: string };
  startedAt: string;
  finishedAt: string | null;
  stage: LiveStage;
  runs: { complete: LiveRunState; ring: LiveRunState };
  detector: { messages: number; done: number; failures: number } | null;
  cost: LiveCost | null;
  error: string | null;
  /** The replay-shaped view once both runs and the detector are done (only on single reads). */
  view?: InstanceView | null;
}

/** The rough price of one session on the demo's model: what the page shows before the button. */
export function estimateSessionUsd(models: LiveModels): number | null {
  // From the dev logs: ~46 000 prompt tokens and ~4 300 visible output tokens for the two runs; ~25 000 in and ~42 000 out for 36 extractions.
  const agents = estimateCostUsd(models.agents.model, { promptTokens: 46_000, completionTokens: 4_300 });
  const detector = estimateCostUsd(models.extraction.model, { promptTokens: 25_000, completionTokens: 42_000 });
  if (agents === undefined || detector === undefined) return null;
  return Math.round((agents + detector) * 100) / 100;
}

/** The exploratory config of an instance under a topology on the given model (plan settings where the provider takes them). */
export function exploratoryRunConfig(instance: string, topology: "complete" | "ring", agents: ModelRef): ExperimentConfig {
  const base = pilotSettlementConfig(instance);
  const ring = (base.protocol!.params.ringPositions as RoleName[]).map((r) => AGENT_ID[r]);
  const model: ModelRef = { ...agents, structuredOutput: "prompt", temperature: agents.temperature ?? 1, maxOutputTokens: agents.maxOutputTokens ?? 2560 };
  return parseExperimentConfig({
    ...base,
    name: `${base.name} · live demo (${topology})`,
    protocol: { ...base.protocol!, params: { ...base.protocol!.params, exploratory: true } },
    communication: topology === "ring" ? { topology: { type: "ring", order: ring } } : { topology: { type: "complete" } },
    agents: base.agents.map((a) => ({ ...a, model })),
  });
}

export interface LiveDemoDeps {
  db: Db;
  service: ExperimentService;
  providers: ProviderRegistry;
}

const runState = (topology: "complete" | "ring"): LiveRunState => ({ topology, experimentId: null, status: "pending", turn: 0, outcome: null, correct: null, category: null, costUsd: null, tokens: null });

export class LiveDemoService {
  private readonly repo: PilotLiveRepository;
  private readonly active = new Map<string, { session: LiveSession; cancel: () => void }>();

  constructor(private readonly deps: LiveDemoDeps) {
    this.repo = new PilotLiveRepository(deps.db);
  }

  /** On start-up: sessions a previous process left running are closed as interrupted. */
  recoverInterrupted(): string[] {
    return this.repo.recoverInterrupted();
  }

  get(id: string): LiveSession | null {
    const live = this.active.get(id)?.session;
    if (live) return this.refresh(live);
    const row = this.repo.get(id, true);
    return row ? (row as unknown as LiveSession) : null;
  }

  /** Every session, newest first, without the views. */
  list(instance?: string): LiveSession[] {
    return this.repo.list(instance).map((row) => {
      const live = this.active.get(row.id)?.session;
      if (!live) return row as unknown as LiveSession;
      const { view: _view, ...rest } = this.refresh(live);
      return rest;
    });
  }

  /** Starts a session; one at a time (the demo shares the provider budget with everything else). */
  start(instance: string, models: LiveModels): LiveSession {
    if (!bundleInstances()[instance]) throw new Error(`unknown instance "${instance}"`);
    if (this.active.size || this.repo.anyRunning()) throw new Error("a live run is already in progress; wait for it to finish or cancel it");
    const session: LiveSession = {
      id: randomUUID(),
      instance,
      models: { agents: models.agents.model, extraction: models.extraction.model },
      startedAt: new Date().toISOString(),
      finishedAt: null,
      stage: "complete",
      runs: { complete: runState("complete"), ring: runState("ring") },
      detector: null,
      cost: null,
      error: null,
    };
    this.repo.insert({ ...this.toRow(session), ownerId: processOwnerId(this.deps.db), view: null });
    let cancelled = false;
    const entry = { session, cancel: () => undefined as void };
    entry.cancel = () => {
      cancelled = true;
      session.stage = "cancelling";
      this.save(session);
      for (const run of [session.runs.complete, session.runs.ring]) {
        if (run.experimentId && run.status === "running") {
          try {
            this.deps.service.control(run.experimentId, { type: "stop" });
          } catch {
            // already finished
          }
        }
      }
    };
    this.active.set(session.id, entry);
    void this.run(session, models, () => cancelled)
      .catch((err: unknown) => {
        session.stage = cancelled ? "cancelled" : "failed";
        session.error = cancelled ? "cancelled by the operator" : err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        session.finishedAt = new Date().toISOString();
        this.save(session, true);
        this.active.delete(session.id);
      });
    return { ...session };
  }

  /** Stops a running session: the current experiment is stopped, nothing further runs. */
  cancel(id: string): LiveSession {
    const entry = this.active.get(id);
    if (!entry) throw new Error("that live run is not running");
    entry.cancel();
    return this.refresh(entry.session);
  }

  /** The turn counter of a running experiment, for the progress line. */
  private refresh(session: LiveSession): LiveSession {
    for (const run of [session.runs.complete, session.runs.ring]) {
      if (run.experimentId && run.status === "running") {
        const live = this.deps.service.liveState(run.experimentId);
        if (live) run.turn = live.turn;
      }
    }
    return session;
  }

  private toRow(s: LiveSession): PilotLiveRow {
    return { id: s.id, instance: s.instance, startedAt: s.startedAt, finishedAt: s.finishedAt, stage: s.stage, ownerId: null, models: s.models, runs: s.runs as unknown as Record<string, unknown>, detector: s.detector as unknown as Record<string, unknown> | null, cost: s.cost as unknown as Record<string, unknown> | null, error: s.error };
  }

  private save(s: LiveSession, withView = false): void {
    const row = this.toRow(s);
    if (withView) row.view = (s.view ?? null) as unknown as Record<string, unknown> | null;
    this.repo.update(row);
  }

  private async run(session: LiveSession, models: LiveModels, isCancelled: () => boolean): Promise<void> {
    const experiments = new ExperimentRepository(this.deps.db);
    const events = new EventRepository(this.deps.db);
    const logs: Partial<Record<"complete" | "ring", RunLogFile>> = {};
    const cost: LiveCost = { agentsUsd: 0, detectorUsd: 0, totalUsd: 0, tokens: { agents: 0, detectorIn: 0, detectorOut: 0 }, unknownCalls: 0 };
    session.cost = cost;
    for (const topology of ["complete", "ring"] as const) {
      if (isCancelled()) throw new Error("cancelled");
      session.stage = topology;
      const state = session.runs[topology];
      const config = exploratoryRunConfig(session.instance, topology, models.agents);
      const { runner, done } = this.deps.service.start({ config });
      state.experimentId = runner.id;
      state.status = "running";
      this.save(session);
      await done;
      const record = experiments.getOrThrow(runner.id);
      const metrics = computeMetrics(events.list(runner.id), { intervened: record.intervened });
      state.outcome = record.outcome ?? null;
      state.status = record.status === "ABORTED" ? "failed" : "finished";
      state.costUsd = metrics.costUsd.total;
      state.tokens = metrics.tokens.total;
      cost.agentsUsd += metrics.costUsd.total;
      cost.unknownCalls += metrics.costUsd.callsWithUnknownCost;
      cost.tokens.agents += state.tokens;
      cost.totalUsd = cost.agentsUsd + cost.detectorUsd;
      const { runLog } = buildRunLog(record, events.list(runner.id));
      logs[topology] = runLog as unknown as RunLogFile;
      state.correct = (runLog.final as { correct_exact?: boolean }).correct_exact ?? null;
      this.save(session);
      if (isCancelled()) throw new Error("cancelled");
      if (state.status === "failed") throw new Error(`the ${topology} run ended as ${record.outcome ?? "aborted"}: ${String((record.outcomeDetail as { reason?: string } | null)?.reason ?? "")}`.trim());
    }
    session.stage = "detector";
    const providerId = models.extraction.provider === "openai-compatible" ? `openai-compatible:${models.extraction.endpoint}` : models.extraction.provider;
    const provider = this.deps.providers.get(providerId as Parameters<ProviderRegistry["get"]>[0]);
    const extractor = createExtractor(provider, models.extraction.model, { structured: models.extraction.structuredOutput !== "prompt" });
    const total = [logs.complete!, logs.ring!].reduce((n, l) => n + l.calls.filter((c) => c.call_type === "discussion" && typeof c.accepted_text === "string").length, 0);
    session.detector = { messages: total, done: 0, failures: 0 };
    this.save(session);
    const outputs: Partial<Record<"complete" | "ring", DetectorOutput>> = {};
    for (const topology of ["complete", "ring"] as const) {
      const { record, output } = await detectRun(logs[topology] as unknown as RunLogLike, extractor, {
        extractionModel: models.extraction.model,
        log: (line) => {
          if (isCancelled()) throw new Error("cancelled");
          if (line.includes("turn ")) session.detector!.done += 1;
          if (line.includes("FAILED")) session.detector!.failures += 1;
          if (session.detector!.done % 6 === 0) this.save(session);
        },
      });
      for (const m of record.messages) {
        const usage = { promptTokens: m.prompt_eval_count ?? 0, completionTokens: m.eval_count ?? 0 };
        cost.tokens.detectorIn += usage.promptTokens;
        cost.tokens.detectorOut += usage.completionTokens;
        const usd = estimateCostUsd(models.extraction.model, usage);
        if (usd === undefined) cost.unknownCalls += 1;
        else cost.detectorUsd += usd;
      }
      cost.totalUsd = cost.agentsUsd + cost.detectorUsd;
      outputs[topology] = output;
      session.runs[topology].category = output.operations.category;
    }
    const view = instanceViewFromLogs(session.instance, logs.complete!, logs.ring!, outputs.complete as unknown as DetectorFile, outputs.ring as unknown as DetectorFile);
    for (const run of [view.runs.complete, view.runs.ring]) run.validity = { status: "exploratory", detail: `live run on ${models.agents.model}: the plan's endpoint settings not enforced, token counts approximate, no environment record; n = 1`, flags: run.validity.flags };
    session.view = view;
    session.stage = "done";
  }
}
