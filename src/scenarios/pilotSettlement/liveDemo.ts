/**
 * The research demo's live run: one dev instance, Complete then Ring, on a provider other than the
 * pilot's (OpenRouter, or the stub in tests), then the detector with the same provider, shown in the
 * replay's own view. Exploratory by construction (plan §3.3 settings not enforced, counts
 * approximate, n = 1), and labelled so everywhere: the adapter's `exploratory` flag, the run log's
 * testbed block, the view's validity. Never a pilot or development run.
 *
 * Sessions live in memory: a restart forgets them (the runs themselves stay in the database).
 */
import { randomUUID } from "node:crypto";
import { parseExperimentConfig, type ExperimentConfig, type ModelRef } from "../../experiment/config.js";
import type { ExperimentService } from "../../experiment/service.js";
import type { ProviderRegistry } from "../../llm/registry.js";
import type { Db } from "../../persistence/db.js";
import { EventRepository } from "../../persistence/eventRepository.js";
import { ExperimentRepository } from "../../persistence/experimentRepository.js";
import { pilotSettlementConfig } from "./config.js";
import { bundleInstances } from "./family.js";
import { buildRunLog } from "./runLog.js";
import { createExtractor, detectRun, type DetectorOutput, type RunLogLike } from "./detector/detect.js";
import { instanceViewFromLogs, type DetectorFile, type InstanceView, type RunLogFile } from "./demoData.js";
import { AGENT_ID, type RoleName } from "./task.js";

export interface LiveModels {
  /** The agents' model (OpenRouter in the demo). */
  agents: ModelRef;
  /** The detector's extraction model; the provider must offer JSON output. */
  extraction: ModelRef;
}

export type LiveStage = "complete" | "ring" | "detector" | "done" | "failed";

export interface LiveRunState {
  topology: "complete" | "ring";
  experimentId: string | null;
  status: "pending" | "running" | "finished" | "failed";
  turn: number;
  outcome: string | null;
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
  error: string | null;
  /** The replay-shaped view once both runs and the detector are done. */
  view: InstanceView | null;
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

export class LiveDemoService {
  private readonly sessions = new Map<string, LiveSession>();
  private busy = false;

  constructor(private readonly deps: LiveDemoDeps) {}

  get(id: string): LiveSession | null {
    return this.sessions.get(id) ?? null;
  }

  list(): LiveSession[] {
    return [...this.sessions.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Starts a session; one at a time (the demo shares the provider budget with everything else). */
  start(instance: string, models: LiveModels): LiveSession {
    if (!bundleInstances()[instance]) throw new Error(`unknown instance "${instance}"`);
    if (this.busy) throw new Error("a live run is already in progress; wait for it to finish");
    const session: LiveSession = {
      id: randomUUID(),
      instance,
      models: { agents: models.agents.model, extraction: models.extraction.model },
      startedAt: new Date().toISOString(),
      finishedAt: null,
      stage: "complete",
      runs: { complete: { topology: "complete", experimentId: null, status: "pending", turn: 0, outcome: null }, ring: { topology: "ring", experimentId: null, status: "pending", turn: 0, outcome: null } },
      detector: null,
      error: null,
      view: null,
    };
    this.sessions.set(session.id, session);
    this.busy = true;
    void this.run(session, models)
      .catch((err: unknown) => {
        session.stage = "failed";
        session.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        session.finishedAt = new Date().toISOString();
        this.busy = false;
      });
    return session;
  }

  /** The turn counter of a running experiment, for the progress line. */
  refresh(session: LiveSession): LiveSession {
    for (const run of [session.runs.complete, session.runs.ring]) {
      if (run.experimentId && run.status === "running") {
        const live = this.deps.service.liveState(run.experimentId);
        if (live) run.turn = live.turn;
      }
    }
    return session;
  }

  private async run(session: LiveSession, models: LiveModels): Promise<void> {
    const experiments = new ExperimentRepository(this.deps.db);
    const events = new EventRepository(this.deps.db);
    const logs: Partial<Record<"complete" | "ring", RunLogFile>> = {};
    for (const topology of ["complete", "ring"] as const) {
      session.stage = topology;
      const state = session.runs[topology];
      const config = exploratoryRunConfig(session.instance, topology, models.agents);
      const { runner, done } = this.deps.service.start({ config });
      state.experimentId = runner.id;
      state.status = "running";
      await done;
      const record = experiments.getOrThrow(runner.id);
      state.outcome = record.outcome ?? null;
      state.status = record.status === "ABORTED" ? "failed" : "finished";
      const { runLog } = buildRunLog(record, events.list(runner.id));
      logs[topology] = runLog as unknown as RunLogFile;
      if (state.status === "failed") throw new Error(`the ${topology} run ended as ${record.outcome ?? "aborted"}: ${String((record.outcomeDetail as { reason?: string } | null)?.reason ?? "")}`.trim());
    }
    session.stage = "detector";
    const providerId = models.extraction.provider === "openai-compatible" ? `openai-compatible:${models.extraction.endpoint}` : models.extraction.provider;
    const provider = this.deps.providers.get(providerId as Parameters<ProviderRegistry["get"]>[0]);
    const extractor = createExtractor(provider, models.extraction.model, { structured: models.extraction.structuredOutput !== "prompt" });
    const total = [logs.complete!, logs.ring!].reduce((n, l) => n + l.calls.filter((c) => c.call_type === "discussion" && typeof c.accepted_text === "string").length, 0);
    session.detector = { messages: total, done: 0, failures: 0 };
    const outputs: Partial<Record<"complete" | "ring", DetectorOutput>> = {};
    for (const topology of ["complete", "ring"] as const) {
      const { output } = await detectRun(logs[topology] as unknown as RunLogLike, extractor, {
        extractionModel: models.extraction.model,
        log: (line) => {
          if (line.includes("turn ")) session.detector!.done += 1;
          if (line.includes("FAILED")) session.detector!.failures += 1;
        },
      });
      outputs[topology] = output;
    }
    const view = instanceViewFromLogs(session.instance, logs.complete!, logs.ring!, outputs.complete as unknown as DetectorFile, outputs.ring as unknown as DetectorFile);
    for (const run of [view.runs.complete, view.runs.ring]) run.validity = { status: "exploratory", detail: `live run on ${models.agents.model}: the plan's endpoint settings not enforced, token counts approximate, no environment record; n = 1`, flags: run.validity.flags };
    session.view = view;
    session.stage = "done";
  }
}
