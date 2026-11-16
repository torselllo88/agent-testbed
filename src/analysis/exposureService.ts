import { createHash, randomUUID } from "node:crypto";
import type { EvaluatorRegistry } from "../evaluation/registry.js";
import { ModelRefSchema, modelProviderKey, type ExperimentConfig } from "../experiment/config.js";
import { EventType } from "../experiment/events.js";
import type { ProviderId } from "../llm/provider.js";
import type { ProviderRegistry } from "../llm/registry.js";
import type { Db } from "../persistence/db.js";
import { EventRepository } from "../persistence/eventRepository.js";
import { ExperimentRepository, type ExperimentRecord } from "../persistence/experimentRepository.js";
import { AnnotationRepository, ExposureRepository, type ExposureSampleRecord } from "../persistence/exposureRepository.js";
import { toCsv } from "./csv.js";
import { EXPOSURE_LABELS, factsOf, labelRuns, type ExposureClass, type ExposureLabel, type ExposureResult } from "./exposure.js";
import { agreement, byConditionOf, detectorInstrument, stratifiedDraw, type AgreementReport } from "./exposureReport.js";

/**
 * Exposure detection for the web UI: one labeling job at a time (the model
 * server serves one request at a time anyway), summaries per batch and per
 * run, and manual labeling — samples of messages people label in the browser,
 * compared with each other and with the detector.
 *
 * The job lives in this process. A restart ends it; starting it again skips
 * every run already labeled (same detector version, model and fact list).
 */

export class ExposureConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExposureConflictError";
  }
}

export interface LabelJob {
  id: string;
  scope: { batchId?: string; experimentId?: string };
  model: Record<string, unknown>;
  force: boolean;
  status: "running" | "completed" | "cancelled" | "failed";
  runsTotal: number;
  runsDone: number;
  labeled: number;
  skipped: number;
  failed: Array<{ runId: string; error: string }>;
  /** Label even while experiments run (otherwise the job waits for them before every request). */
  whileBusy: boolean;
  /** Experiments the job is waiting for right now (0: not waiting). */
  waitingFor: number;
  /** The run being labeled now, and how far. */
  current: { runId: string; message: number; messages: number } | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

type Tally = { total: number; correct: number };

export interface ConditionExposure {
  key: string;
  runs: number;
  labeled: number;
  /** Mean share of the other agents' private facts that reached the proposer correctly (over labeled runs). */
  factsCorrect: number | null;
  /** Labeled runs in which a private fact reached the proposer only wrongly / both ways. */
  runsWithDistorted: number;
  runsWithConflicting: number;
  derivedCorrect: number | null;
  /** Share of labeled runs in which the complete solution reached the proposer (correct or conflicting). */
  solutionRelay: number | null;
  unlabeledMessages: number;
  /** Labeled runs with an unlabeled message inside the horizon: their exposure is a lower bound, left out of the means. */
  incomplete: number;
  /** Labels the detector claimed with a quote not in the message (counted as absent), over labeled runs — compare between conditions. */
  unverifiedLabels: number;
  /** Private facts that reached the proposer correctly, by the agent who held them (summed over labeled runs). */
  bySource: Record<string, Tally>;
}

export interface SampleSummary {
  id: string;
  name: string;
  seed: number;
  createdAt: string;
  items: number;
  annotators: Array<{ name: string; messages: number }>;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

export class ExposureService {
  private job: LabelJob | null = null;
  private abort: AbortController | null = null;
  private done: Promise<void> = Promise.resolve();
  private readonly detections: ExposureRepository;
  private readonly annotations: AnnotationRepository;
  private readonly experiments: ExperimentRepository;

  /** How often a waiting job looks whether the experiments have finished. */
  private readonly pollMs: number;

  constructor(private readonly deps: { db: Db; providers: ProviderRegistry; evaluators: EvaluatorRegistry; pollMs?: number }) {
    this.pollMs = deps.pollMs ?? 5000;
    this.detections = new ExposureRepository(deps.db);
    this.annotations = new AnnotationRepository(deps.db);
    this.experiments = new ExperimentRepository(deps.db);
  }

  // ------------------------------------------------------------ labeling job

  status(): LabelJob | null {
    return this.job ? structuredClone(this.job) : null;
  }

  /** Experiments being run right now by any live process sharing this database (this server, a CLI batch). */
  runningExperiments(): number {
    return this.experiments.countRunning();
  }

  /**
   * The job yields to experiments: before every request to the model it waits
   * while any experiment runs (in any process on this database — a batch
   * started after the job too), unless whileBusy. The detector's requests would
   * queue at the same model server, and a detector model other than the
   * agents' makes the server swap models mid-run — reloads, CPU offload, slower
   * and numerically different runs, and more timeouts for the longer prompts.
   */
  start(scope: { batchId?: string; experimentId?: string }, rawModel: unknown, force = false, whileBusy = false): LabelJob {
    if (this.job?.status === "running") throw new ExposureConflictError("A labeling job is already running — wait for it or cancel it");
    const model = ModelRefSchema.parse(rawModel);
    try {
      this.deps.providers.get(modelProviderKey(model) as ProviderId); // not configured: an error now, not once per message
    } catch (err) {
      throw new ExposureConflictError(err instanceof Error ? err.message : String(err));
    }
    const runs = this.runsOf(scope).filter((r) => r.finishedAt);
    if (runs.length === 0) throw new ExposureConflictError("No finished runs to label");
    const job: LabelJob = {
      id: randomUUID(),
      scope,
      model: model as unknown as Record<string, unknown>,
      force,
      whileBusy,
      waitingFor: 0,
      status: "running",
      runsTotal: runs.length,
      runsDone: 0,
      labeled: 0,
      skipped: 0,
      failed: [],
      current: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    };
    this.job = job;
    const abort = (this.abort = new AbortController());
    const gate = async () => {
      if (whileBusy) return;
      for (let busy = this.runningExperiments(); busy > 0 && !abort.signal.aborted; busy = this.runningExperiments()) {
        job.waitingFor = busy;
        await new Promise((r) => setTimeout(r, this.pollMs));
      }
      job.waitingFor = 0;
    };
    this.done = labelRuns(this.deps, runs.map((r) => r.id), model, {
      force,
      signal: abort.signal,
      gate,
      onRunStart: (_i, _n, runId) => {
        job.current = { runId, message: 0, messages: 0 };
      },
      onMessage: (message, messages) => {
        if (job.current) Object.assign(job.current, { message, messages });
      },
      onRun: (_i, _n, runId, outcome, detail) => {
        job.runsDone += 1;
        if (outcome === "labeled") job.labeled += 1;
        else if (outcome === "skipped") job.skipped += 1;
        else job.failed.push({ runId, error: detail ?? "" });
        job.current = null;
      },
    })
      .then((result) => {
        job.status = result.cancelled ? "cancelled" : "completed";
      })
      .catch((err: unknown) => {
        job.status = "failed";
        job.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        job.current = null;
        job.finishedAt = new Date().toISOString();
        this.abort = null;
      });
    return structuredClone(job);
  }

  cancel(): boolean {
    if (this.job?.status !== "running" || !this.abort) return false;
    this.abort.abort();
    return true;
  }

  /** Resolves when the current job (if any) has ended — for tests and shutdown. */
  settle(): Promise<void> {
    return this.done;
  }

  private runsOf(scope: { batchId?: string; experimentId?: string }): ExperimentRecord[] {
    if (scope.experimentId) {
      const run = this.experiments.get(scope.experimentId);
      if (!run) throw new ExposureConflictError(`Unknown experiment "${scope.experimentId}"`);
      return [run];
    }
    // The runs the outcome rates count: aborted ones (timeouts, provider errors) are excluded there, so here too.
    if (scope.batchId) return this.experiments.list({ batchId: scope.batchId, limit: 100000 }).filter((r) => r.status !== "ABORTED").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    throw new ExposureConflictError("Say which batch or experiment to label");
  }

  // ------------------------------------------------------------ summaries

  /** A run's latest pass (with every label) and the list of its passes. */
  runExposure(experimentId: string): { latest: (ReturnType<ExposureRepository["latest"]> & {}) | null; passes: Array<{ id: string; createdAt: string; detectorVersion: string; model: Record<string, unknown> }> } {
    const passes = this.detections.list(experimentId);
    return {
      latest: passes.at(-1) ?? null,
      passes: passes.map((p) => ({ id: p.id, createdAt: p.createdAt, detectorVersion: p.detectorVersion, model: p.model })),
    };
  }

  /** Per condition: what reached the proposer, over the runs' latest passes. */
  batchExposure(batchId: string): { runs: number; labeled: number; models: string[]; instruments: string[]; conditions: ConditionExposure[]; overall: ConditionExposure } {
    // The same runs as the outcome rates: finished and not aborted.
    const runs = this.experiments.list({ batchId, limit: 100000 }).filter((r) => r.finishedAt && r.status !== "ABORTED");
    const entries = runs.map((run) => {
      const latest = this.detections.latest(run.id);
      return { run, result: (latest?.result as ExposureResult | undefined) ?? null, model: latest?.model ?? null, instrument: latest ? detectorInstrument(latest) : null };
    });
    const summarize = (key: string, group: typeof entries): ConditionExposure => {
      const labeled = group.filter((e) => e.result);
      // Means over complete passes only: a run with an unlabeled message would pull "what reached" down for no reason.
      const complete = labeled.filter((e) => e.result!.summary.complete !== false);
      const share = (pick: (r: ExposureResult) => { total: number; correct: number }) =>
        mean(complete.map((e) => pick(e.result!)).filter((t) => t.total > 0).map((t) => t.correct / t.total));
      const bySource: Record<string, Tally> = {};
      for (const { result } of complete) {
        for (const fact of result!.facts) {
          if (fact.kind !== "fact" || !fact.source) continue;
          const cls = result!.summary.proposer[fact.id]?.class;
          if (cls === "own" || cls === undefined) continue;
          const t = (bySource[fact.source] ??= { total: 0, correct: 0 });
          t.total += 1;
          if (cls === "correct") t.correct += 1;
        }
      }
      const relays = complete.filter((e) => e.result!.summary.solutionRelay !== null);
      return {
        key,
        runs: group.length,
        labeled: labeled.length,
        factsCorrect: share((r) => r.summary.proposerFacts),
        runsWithDistorted: complete.filter((e) => e.result!.summary.proposerFacts.distorted > 0).length,
        runsWithConflicting: complete.filter((e) => e.result!.summary.proposerFacts.conflicting > 0).length,
        derivedCorrect: share((r) => r.summary.proposerDerived),
        solutionRelay: relays.length ? relays.filter((e) => ["correct", "conflicting"].includes(e.result!.summary.solutionRelay as string)).length / relays.length : null,
        unlabeledMessages: labeled.reduce((s, e) => s + e.result!.summary.unlabeledMessages, 0),
        incomplete: labeled.length - complete.length,
        unverifiedLabels: labeled.reduce((s, e) => s + (e.result!.summary.unverifiedLabels ?? 0), 0),
        bySource,
      };
    };
    const keys = [...new Set(entries.map((e) => e.run.conditionKey ?? ""))].sort();
    const models = [...new Set(entries.filter((e) => e.model).map((e) => `${String(e.model!.endpoint ?? e.model!.provider)}/${String(e.model!.model)}`))];
    // More than one detector version or model across the runs: the comparison mixes instruments.
    const instruments = [...new Set(entries.map((e) => e.instrument).filter((i): i is string => i !== null))].sort();
    return {
      runs: runs.length,
      labeled: entries.filter((e) => e.result).length,
      models,
      instruments,
      conditions: keys.map((k) => summarize(k, entries.filter((e) => (e.run.conditionKey ?? "") === k))),
      overall: summarize("all conditions", entries),
    };
  }

  // ------------------------------------------------------------ manual labeling

  /**
   * Draws n agent messages (seeded) from the batch's finished runs whose
   * scenario has a fact list — independent of any detector pass, so people
   * can label before, after or without one.
   */
  createSample(batchId: string, n: number, seed: number, name?: string): ExposureSampleRecord {
    const events = new EventRepository(this.deps.db);
    const pool: Array<{ experimentId: string; messageId: string; key: string; condition: string }> = [];
    for (const run of this.experiments.list({ batchId, limit: 100000 }).filter((r) => r.finishedAt && r.status !== "ABORTED")) {
      try {
        factsOf(this.deps.evaluators, run.config);
      } catch {
        continue;
      }
      for (const e of events.list(run.id)) {
        if (e.type !== EventType.MESSAGE_POSTED || (e.payload.sender as { kind: string }).kind !== "agent") continue;
        const messageId = String(e.payload.messageId);
        pool.push({ experimentId: run.id, messageId, condition: run.conditionKey ?? "", key: createHash("sha256").update(`${seed}:${run.id}:${messageId}`).digest("hex") });
      }
    }
    if (pool.length === 0) throw new ExposureConflictError("No agent messages to sample: no finished run of this batch has a scenario with a fact list");
    const items = stratifiedDraw(pool, n).map(({ experimentId, messageId }) => ({ experimentId, messageId }));
    const sample: ExposureSampleRecord = { id: randomUUID(), batchId, name: name?.trim() || `Sample ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, seed, createdAt: new Date().toISOString(), items };
    this.annotations.createSample(sample);
    return sample;
  }

  samples(batchId: string): SampleSummary[] {
    return this.annotations.samples(batchId).map((s) => {
      const byAnnotator = new Map<string, Set<string>>();
      for (const a of this.annotations.annotations(s.id)) {
        const set = byAnnotator.get(a.annotator) ?? new Set<string>();
        set.add(`${a.experimentId}\u0000${a.messageId}`);
        byAnnotator.set(a.annotator, set);
      }
      return {
        id: s.id,
        name: s.name,
        seed: s.seed,
        createdAt: s.createdAt,
        items: s.items.length,
        annotators: [...byAnnotator].map(([name, set]) => ({ name, messages: set.size })),
      };
    });
  }

  /**
   * What an annotator sees: each message — not who wrote it, as the detector does not — and the instance's
   * propositions, and the annotator's own labels so far — never the
   * detector's (blind labeling).
   */
  sampleForAnnotator(sampleId: string, annotator: string) {
    const sample = this.requireSample(sampleId);
    const events = new EventRepository(this.deps.db);
    const mine = this.annotations.annotations(sampleId, annotator);
    const runCache = new Map<string, { config: ExperimentConfig; texts: Map<string, { senderId: string; text: string }> }>();
    const runOf = (id: string) => {
      let entry = runCache.get(id);
      if (!entry) {
        const run = this.experiments.getOrThrow(id);
        const texts = new Map<string, { senderId: string; text: string }>();
        for (const e of events.list(id)) {
          if (e.type === EventType.MESSAGE_POSTED && (e.payload.sender as { kind: string }).kind === "agent") {
            texts.set(String(e.payload.messageId), { senderId: (e.payload.sender as { agentId: string }).agentId, text: String(e.payload.text) });
          }
        }
        runCache.set(id, (entry = { config: run.config, texts }));
      }
      return entry;
    };
    return {
      sample: { id: sample.id, name: sample.name, seed: sample.seed, batchId: sample.batchId },
      annotator,
      items: sample.items.map((item, index) => {
        const run = runOf(item.experimentId);
        const message = run.texts.get(item.messageId);
        const labels = Object.fromEntries(mine.filter((a) => a.experimentId === item.experimentId && a.messageId === item.messageId).map((a) => [a.factId, a.label]));
        return {
          index,
          experimentId: item.experimentId,
          messageId: item.messageId,
          text: message?.text ?? "(message not found)",
          facts: factsOf(this.deps.evaluators, run.config).map((f) => ({ id: f.id, kind: f.kind, statement: f.statement })),
          labels,
        };
      }),
    };
  }

  saveAnnotation(sampleId: string, input: { annotator: string; experimentId: string; messageId: string; labels: Record<string, string> }): void {
    const sample = this.requireSample(sampleId);
    const annotator = input.annotator.trim();
    if (!annotator) throw new ExposureConflictError("Give your name: labels are kept per person");
    if (!sample.items.some((i) => i.experimentId === input.experimentId && i.messageId === input.messageId)) throw new ExposureConflictError("This message is not in the sample");
    const facts = factsOf(this.deps.evaluators, this.experiments.getOrThrow(input.experimentId).config).map((f) => f.id);
    const missing = facts.filter((id) => !(id in input.labels));
    if (missing.length) throw new ExposureConflictError(`Label every proposition (missing: ${missing.join(", ")})`);
    for (const [id, label] of Object.entries(input.labels)) {
      if (!facts.includes(id)) throw new ExposureConflictError(`Unknown proposition "${id}"`);
      if (!(EXPOSURE_LABELS as readonly string[]).includes(label)) throw new ExposureConflictError(`"${label}" is not one of ${EXPOSURE_LABELS.join(", ")}`);
    }
    this.annotations.saveLabels(sampleId, annotator, input.experimentId, input.messageId, input.labels);
  }

  /**
   * Agreement on a sample: every pair of annotators (on what both labeled),
   * and the detector against each annotator (the runs' latest passes).
   */
  agreement(sampleId: string): {
    annotators: string[];
    pairs: Array<{ a: string; b: string } & Omit<AgreementReport, "unmatched" | "byKind" | "byCondition" | "disagreements">>;
    detector: Array<
      { annotator: string; unmatched: number; byCondition: AgreementReport["byCondition"] } & Omit<AgreementReport, "unmatched" | "byKind" | "byCondition" | "disagreements">
    >;
  } {
    this.requireSample(sampleId);
    const all = this.annotations.annotations(sampleId);
    const annotators = [...new Set(all.map((a) => a.annotator))].sort();
    const key = (a: { experimentId: string; messageId: string; factId: string }) => `${a.experimentId}\u0000${a.messageId}\u0000${a.factId}`;
    const byAnnotator = new Map(annotators.map((n) => [n, new Map(all.filter((a) => a.annotator === n).map((a) => [key(a), a.label as ExposureLabel]))]));
    const pairs = [];
    for (let i = 0; i < annotators.length; i++) {
      for (let j = i + 1; j < annotators.length; j++) {
        const [a, b] = [byAnnotator.get(annotators[i]!)!, byAnnotator.get(annotators[j]!)!];
        const both = [...a.keys()].filter((k) => b.has(k)).map((k) => ({ human: a.get(k)!, detector: b.get(k)! }));
        pairs.push({ a: annotators[i]!, b: annotators[j]!, ...agreement(both) });
      }
    }
    const detectorLabel = new Map<string, ExposureLabel>();
    for (const runId of new Set(all.map((a) => a.experimentId))) {
      const result = this.detections.latest(runId)?.result as ExposureResult | undefined;
      for (const m of result?.messages ?? []) for (const [factId, l] of Object.entries(m.labels ?? {})) detectorLabel.set(key({ experimentId: runId, messageId: m.messageId, factId }), l.label);
    }
    // Per condition too: the detector's errors must not differ between the conditions it compares.
    const conditionOf = new Map([...new Set(all.map((a) => a.experimentId))].map((id) => [id, this.experiments.get(id)?.conditionKey ?? ""]));
    const detector = annotators.map((name) => {
      const mine = [...byAnnotator.get(name)!];
      const matched = mine.filter(([k]) => detectorLabel.has(k));
      const byCondition = byConditionOf(
        matched.map(([k, human]) => ({ human, detector: detectorLabel.get(k)!, runId: k.split("\u0000")[0]! })),
        (p) => conditionOf.get(p.runId) ?? null
      );
      return { annotator: name, unmatched: mine.length - matched.length, byCondition, ...agreement(matched.map(([k, human]) => ({ human, detector: detectorLabel.get(k)! }))) };
    });
    return { annotators, pairs, detector };
  }

  annotationsCsv(sampleId: string): string {
    this.requireSample(sampleId);
    const rows = this.annotations.annotations(sampleId).map((a) => [sampleId, a.annotator, a.experimentId, a.messageId, a.factId, a.label, a.updatedAt]);
    return toCsv([["sample_id", "annotator", "experiment_id", "message_id", "fact_id", "label", "updated_at"], ...rows]);
  }

  private requireSample(id: string): ExposureSampleRecord {
    const sample = this.annotations.sample(id);
    if (!sample) throw new ExposureConflictError(`Unknown sample "${id}"`);
    return sample;
  }
}

export type { ExposureClass };
