/**
 * The pair runner (Pilot Experimental Plan §3.2, §11, §12 step 8): an instance's Complete and Ring
 * runs as one pair on the shared GPU node —
 *
 *   preload → snapshot (before_pair) → first run → snapshot (between_runs) → second run → snapshot (after_pair)
 *
 * The preload is `/api/chat` with `messages: []`, `num_ctx` 8192 and `keep_alive` 30m and must answer
 * `done_reason: "load"`. A snapshot holds nvidia-smi, `/api/ps` and `/api/version`; it is normal when the
 * pilot model is fully in GPU memory (size_vram = size), loaded with the pilot's window, and version and
 * digest equal the freeze record (`model/record.json`). A failed preload, an abnormal snapshot or a
 * mid-run reload (load_duration > 1 s on any call) makes the pair an environment deviation: both runs
 * are kept (their logs under `deviations/`), the runner waits until a snapshot is normal and re-executes
 * the pair with the same seeds, at most twice. A version or digest change stops everything (§11).
 *
 * Every run goes through the ExperimentService like any other run; the run logs are written as soon as
 * the pair is done, with the pair's snapshots and preload in them.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseExperimentConfig, type ExperimentConfig } from "../../experiment/config.js";
import { decideAlone } from "../../batch/spec.js";
import type { ExperimentService } from "../../experiment/service.js";
import type { Db } from "../../persistence/db.js";
import { EventRepository } from "../../persistence/eventRepository.js";
import { ExperimentRepository } from "../../persistence/experimentRepository.js";
import { PILOT_GENERATION } from "./adapter.js";
import { pilotSettlementConfig } from "./config.js";
import { bundleInstances } from "./family.js";
import { buildRunLog, writeRunLog, type EnvironmentSnapshot, type SnapshotMoment } from "./runLog.js";
import { AGENT_ID, type RoleName } from "./task.js";

export type Topology = "complete" | "ring";
/** The two runs of a pair: a discussion pair (Complete and Ring) or a controls pair (oracle and public-only of Operations alone). */
export type RunKind = Topology | "oracle" | "public_only";
export type PairKind = "discussion" | "controls";

export interface FreezeRecord {
  model: string;
  digest: string;
  ollama_version: string;
  context_length: number;
}

export const PILOT_FREEZE_RECORD_FILE = fileURLToPath(new URL("../../../experiments/pilot-settlement/model/record.json", import.meta.url));

export function loadFreezeRecord(file: string = PILOT_FREEZE_RECORD_FILE): FreezeRecord {
  const r = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<FreezeRecord>;
  for (const k of ["model", "digest", "ollama_version", "context_length"] as const) {
    if (r[k] === undefined || r[k] === null) throw new Error(`freeze record ${file}: missing "${k}"`);
  }
  return r as FreezeRecord;
}

/** The pilot is stopped: a version or digest change (§11), never continued automatically. */
export class PilotStopped extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PilotStopped";
  }
}

export interface PsModel {
  name?: string;
  model?: string;
  size?: number;
  size_vram?: number;
  context_length?: number;
  digest?: string;
}

const withTag = (model: string) => (model.includes(":") ? model : `${model}:latest`);

/** The plan's normality rule for one snapshot; `stop` names a version or digest change. */
export function judgeSnapshot(ps: { models?: PsModel[] } | null, version: string | null, record: FreezeRecord): { normal: boolean; deviation: string | null; stop: string | null } {
  const problems: string[] = [];
  let stop: string | null = null;
  if (version === null) problems.push("/api/version not answered");
  else if (version !== record.ollama_version) stop = `Ollama version changed: ${version} (freeze record ${record.ollama_version})`;
  const entry = ps?.models?.find((m) => withTag(m.name ?? m.model ?? "") === withTag(record.model));
  if (!ps) problems.push("/api/ps not answered");
  else if (!entry) problems.push(`model ${record.model} not loaded`);
  else {
    if (typeof entry.size === "number" && typeof entry.size_vram === "number") {
      if (entry.size_vram < entry.size) problems.push(`model not fully in GPU memory (size_vram ${entry.size_vram} of ${entry.size})`);
    } else problems.push("size / size_vram not reported");
    if (typeof entry.context_length === "number" && entry.context_length !== record.context_length) problems.push(`context length ${entry.context_length}, not ${record.context_length}`);
    if (entry.digest && entry.digest !== record.digest) stop = `model digest changed: ${entry.digest} (freeze record ${record.digest})`;
  }
  if (stop) problems.unshift(stop);
  return { normal: problems.length === 0, deviation: problems.length ? problems.join("; ") : null, stop };
}

/** nvidia-smi: GPU memory and utilisation, then the compute processes; the error text when it cannot run. */
export function nvidiaSmiText(): string {
  const run = (args: string[]) => {
    const r = spawnSync("nvidia-smi", args, { encoding: "utf8", timeout: 20_000 });
    if (r.error) return `(nvidia-smi: ${r.error.message})`;
    if (r.status !== 0) return `(nvidia-smi exit ${r.status}: ${(r.stderr ?? "").trim()})`;
    return (r.stdout ?? "").trim();
  };
  return `${run(["--query-gpu=index,name,memory.used,memory.total,utilization.gpu", "--format=csv"])}\n${run(["--query-compute-apps=pid,process_name,used_memory", "--format=csv"])}`;
}

export interface PairRunnerOptions {
  instances: string[];
  /** Discussion pairs (Complete, Ring — the default) or controls pairs (oracle, public-only; plan §12 step 9, gates G3 / G4). */
  kind?: PairKind;
  /** The endpoint name of the Ollama server in the provider registry (e.g. "lab-ollama") and its URL for preload and snapshots. */
  endpoint: string;
  baseUrl: string;
  model: string;
  outDir: string;
  record?: FreezeRecord;
  replicate?: number;
  /** Which run comes first: alternating per instance (the plan's pilot order), or always the same (for controls: "complete" = oracle first, "ring" = public-only first). */
  first?: "alternating" | "complete" | "ring";
  /** Re-executions of a deviated pair (default 2, the plan's "at most twice"). */
  maxReexecutions?: number;
  /** Waiting for a normal environment before a re-execution: poll interval and give-up time (defaults 60 s, 2 h). */
  waitPollMs?: number;
  waitTimeoutMs?: number;
  fetch?: typeof fetch;
  nvidiaSmi?: () => string;
  log?: (line: string) => void;
  /** Called after every snapshot (tests). */
  onSnapshot?: (snapshot: EnvironmentSnapshot) => void;
}

export interface PairRun {
  topology: RunKind;
  experimentId: string;
  runId: string;
  logPath: string;
  outcome: string | null;
  validity: { status: string; detail: string };
}

export interface PairExecution {
  attempt: number;
  startedAt: string;
  finishedAt: string;
  preload: { request: Record<string, unknown>; response: Record<string, unknown> | null; status: number; ok: boolean };
  snapshots: EnvironmentSnapshot[];
  runs: PairRun[];
  deviation: string | null;
}

export interface PairRecord {
  instance: string;
  kind: PairKind;
  replicate: number;
  order: [RunKind, RunKind];
  executions: PairExecution[];
  outcome: "valid" | "environment_deviation";
}

/** The pilot config of an instance under a topology — or as a control call (`$solo` full / public) — on the Ollama endpoint, as the batch specs build it. */
export function pairRunConfig(instance: string, run: RunKind, endpoint: string, model: string, replicate = 0): ExperimentConfig {
  const base = pilotSettlementConfig(instance);
  const ring = (base.protocol!.params.ringPositions as RoleName[]).map((r) => AGENT_ID[r]);
  const withModel = {
    ...base,
    protocol: { ...base.protocol!, replicate },
    communication: run === "ring" ? { topology: { type: "ring", order: ring } } : { topology: { type: "complete" } },
    agents: base.agents.map((a) => ({
      ...a,
      model: { ...a.model, provider: "openai-compatible", endpoint, model, structuredOutput: "prompt", think: true, contextLength: PILOT_GENERATION.contextLength },
    })),
  };
  if (run === "oracle" || run === "public_only") return parseExperimentConfig(decideAlone(withModel as unknown as Record<string, unknown>, run === "oracle" ? "full" : "public"));
  return parseExperimentConfig(withModel);
}

export interface PairRunnerDeps {
  db: Db;
  service: ExperimentService;
}

export async function runPairs(deps: PairRunnerDeps, opts: PairRunnerOptions): Promise<PairRecord[]> {
  const log = opts.log ?? (() => {});
  const fetchFn = opts.fetch ?? fetch;
  const nvidia = opts.nvidiaSmi ?? nvidiaSmiText;
  const record = opts.record ?? loadFreezeRecord();
  const root = opts.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const replicate = opts.replicate ?? 0;
  const maxReexecutions = opts.maxReexecutions ?? 2;
  const waitPollMs = opts.waitPollMs ?? 60_000;
  const waitTimeoutMs = opts.waitTimeoutMs ?? 2 * 3_600_000;
  const experiments = new ExperimentRepository(deps.db);
  const events = new EventRepository(deps.db);
  const instances = bundleInstances();
  for (const id of opts.instances) if (!instances[id]) throw new Error(`unknown instance "${id}"`);
  fs.mkdirSync(opts.outDir, { recursive: true });
  fs.mkdirSync(path.join(opts.outDir, "pairs"), { recursive: true });

  async function api<T>(method: "GET" | "POST", route: string, body?: unknown, timeoutMs = 30_000): Promise<{ ok: boolean; status: number; data: T | null }> {
    try {
      const res = await fetchFn(`${root}${route}`, {
        method,
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let data: T | null = null;
      try {
        data = JSON.parse(text) as T;
      } catch {
        data = null;
      }
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: null };
    }
  }

  async function snapshot(when: SnapshotMoment): Promise<EnvironmentSnapshot> {
    const [version, ps] = await Promise.all([api<{ version?: string }>("GET", "/api/version"), api<{ models?: PsModel[] }>("GET", "/api/ps")]);
    const v = version.data?.version ?? null;
    const judged = judgeSnapshot(ps.data, v, record);
    const snap: EnvironmentSnapshot = {
      when,
      taken_at: new Date().toISOString(),
      ollama_version: v ?? "unknown",
      ollama_ps: (ps.data as Record<string, unknown> | null) ?? { error: `HTTP ${ps.status}` },
      nvidia_smi: nvidia(),
      normal: judged.normal,
      deviation: judged.deviation,
    };
    opts.onSnapshot?.(snap);
    log(`  snapshot ${when}: ${snap.normal ? "normal" : `ABNORMAL — ${snap.deviation}`}`);
    if (judged.stop) throw new PilotStopped(`${judged.stop} (snapshot ${when}, ${snap.taken_at}) — the pilot is stopped`);
    return snap;
  }

  async function preload(): Promise<PairExecution["preload"]> {
    const request = { model: opts.model, messages: [], stream: false, keep_alive: PILOT_GENERATION.keepAlive, options: { num_ctx: PILOT_GENERATION.contextLength } };
    const r = await api<Record<string, unknown>>("POST", "/api/chat", request, 10 * 60_000);
    const ok = r.ok && r.data?.done_reason === "load";
    log(`  preload: ${ok ? "loaded" : `FAILED (HTTP ${r.status}, done_reason ${String(r.data?.done_reason ?? "none")})`}`);
    return { request, response: r.data, status: r.status, ok };
  }

  async function runOne(instance: string, topology: RunKind): Promise<{ experimentId: string; outcome: string | null }> {
    const config = pairRunConfig(instance, topology, opts.endpoint, opts.model, replicate);
    const { runner, done } = deps.service.start({ config });
    log(`  run ${instance} ${topology}: experiment ${runner.id}`);
    await done;
    const rec = experiments.getOrThrow(runner.id);
    log(`  run ${instance} ${topology}: ${rec.outcome ?? "no outcome"}`);
    return { experimentId: runner.id, outcome: rec.outcome ?? null };
  }

  async function waitForNormal(): Promise<void> {
    const until = Date.now() + waitTimeoutMs;
    for (;;) {
      const s = await snapshot("before_pair");
      if (s.normal) return;
      if (Date.now() >= until) throw new Error(`the environment did not return to normal within ${Math.round(waitTimeoutMs / 60_000)} min: ${s.deviation}`);
      log(`  waiting ${Math.round(waitPollMs / 1000)} s for a normal environment…`);
      await new Promise((r) => setTimeout(r, waitPollMs));
    }
  }

  const kind: PairKind = opts.kind ?? "discussion";
  const runs: [RunKind, RunKind] = kind === "controls" ? ["oracle", "public_only"] : ["complete", "ring"];
  const records: PairRecord[] = [];
  opts.instances.forEach((instance, index) => {
    const firstIsA = opts.first === "complete" ? true : opts.first === "ring" ? false : index % 2 === 0;
    const order: [RunKind, RunKind] = firstIsA ? [runs[0], runs[1]] : [runs[1], runs[0]];
    records.push({ instance, kind, replicate, order, executions: [], outcome: "environment_deviation" });
  });

  for (const pair of records) {
    log(`pair ${pair.instance}${replicate ? ` (replicate ${replicate})` : ""}: ${pair.order.join(" then ")}`);
    for (let attempt = 0; attempt <= maxReexecutions; attempt++) {
      if (attempt > 0) {
        log(`  re-execution ${attempt} of ${maxReexecutions}: waiting for a normal environment`);
        await waitForNormal();
      }
      const startedAt = new Date().toISOString();
      const pre = await preload();
      const snapshots: EnvironmentSnapshot[] = [];
      snapshots.push(await snapshot("before_pair"));
      const first = await runOne(pair.instance, pair.order[0]);
      snapshots.push(await snapshot("between_runs"));
      const second = await runOne(pair.instance, pair.order[1]);
      snapshots.push(await snapshot("after_pair"));
      // Decide the pair from the preload, the snapshots and load_duration — before its outcomes are looked at (PD13).
      const preloadDeviation = pre.ok ? null : `preload did not answer done_reason "load" (HTTP ${pre.status}, ${String(pre.response?.done_reason ?? "no done_reason")})`;
      const runs: PairRun[] = [];
      let deviation: string | null = preloadDeviation;
      const logOptions = { snapshots, preload: { request: pre.request, response: pre.response, http_status: pre.status, ok: pre.ok }, attempt };
      const probe = [first, second].map((r, i) => {
        const rec = experiments.getOrThrow(r.experimentId);
        const built = buildRunLog(rec, events.list(r.experimentId), logOptions);
        const validity = built.runLog.validity as { status: string; detail: string };
        if (validity.status === "environment_deviation" && !deviation) deviation = validity.detail;
        return { rec, topology: pair.order[i]!, r };
      });
      const deviated = deviation !== null;
      const pairName = `${pair.instance}${kind === "controls" ? "-controls" : ""}${replicate ? `-rep${replicate}` : ""}`;
      const dir = deviated && attempt < maxReexecutions ? path.join(opts.outDir, "deviations", `${pairName}-attempt${attempt}`) : opts.outDir;
      for (const { rec, topology, r } of probe) {
        const written = writeRunLog(rec, events.list(r.experimentId), dir, logOptions);
        const validity = written.runLog.validity as { status: string; detail: string };
        runs.push({ topology, experimentId: r.experimentId, runId: String(written.runLog.run_id), logPath: written.path, outcome: r.outcome, validity });
        log(`  log ${written.path} (${validity.status}, ${r.outcome ?? "?"})`);
      }
      pair.executions.push({ attempt, startedAt, finishedAt: new Date().toISOString(), preload: pre, snapshots, runs, deviation });
      if (!deviated) {
        pair.outcome = "valid";
        break;
      }
      log(`  environment deviation: ${deviation}${attempt < maxReexecutions ? " — both runs will be re-executed" : " — no re-execution left, the pair is excluded"}`);
    }
    const file = path.join(opts.outDir, "pairs", `${pair.instance}${kind === "controls" ? "-controls" : ""}${replicate ? `-rep${replicate}` : ""}.json`);
    fs.writeFileSync(file, JSON.stringify(pair, null, 1) + "\n");
    log(`pair ${pair.instance}: ${pair.outcome} (${pair.executions.length} execution${pair.executions.length === 1 ? "" : "s"}), record ${file}`);
  }
  return records;
}
