/**
 * Gate G6 — determinism (Pilot Experimental Plan §9): 3 discussion, 2 final and 1 public-only dev
 * call, each repeated 3 times with identical input and seed under normal snapshots, in both
 * prompt-cache states, must return identical content. The server (Ollama 0.33.2) does not report
 * `prompt_eval_cached_count`, so the cache state is set and classified by call order (author's
 * decision, 2026-11-20): a cold call follows a cache-busting prompt, a warm call follows the same
 * prompt without one.
 *
 * The discussion and final calls are taken from dev run logs (their system and user texts and
 * seeds, as sent); the public-only call is rendered for an instance. Snapshots are taken before
 * and after, judged against the freeze record; an abnormal one fails the gate as "not under normal
 * snapshots", whatever the contents did.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChatMessage } from "../../llm/provider.js";
import { PILOT_GENERATION, publicOnlyMessages, publicOnlySeed } from "./adapter.js";
import { bundleInstances } from "./family.js";
import { judgeSnapshot, loadFreezeRecord, nvidiaSmiText, type FreezeRecord, type PsModel } from "./pairRunner.js";
import type { EnvironmentSnapshot } from "./runLog.js";

export interface DeterminismOptions {
  baseUrl: string;
  model: string;
  /** Directory of dev run logs (`<run_id>.json`) the discussion and final calls are taken from. */
  logsDir: string;
  /** The instance whose public-only call is used (default DEV-01). */
  publicOnlyInstance?: string;
  /** How many discussion / final calls (plan: 3 and 2) and repeats (plan: 3). */
  discussionCalls?: number;
  finalCalls?: number;
  repeats?: number;
  record?: FreezeRecord;
  fetch?: typeof fetch;
  nvidiaSmi?: () => string;
  log?: (line: string) => void;
  timeoutMs?: number;
}

export interface DeterminismCall {
  id: string;
  kind: "discussion" | "final" | "public_only";
  source: string;
  seed: number;
  promptTokensReported: number | null;
  results: Array<{ cache: "cold" | "warm"; repeat: number; contentSha256: string; thinkingSha256: string; evalCount: number | null; doneReason: string | null; promptEvalCount: number | null; loadDurationMs: number | null; totalDurationMs: number | null }>;
  identical: { cold: boolean; warm: boolean; acrossStates: boolean };
}

export interface DeterminismReport {
  schema: "pilot-settlement/determinism/1";
  startedAt: string;
  finishedAt: string;
  baseUrl: string;
  model: string;
  classification: "by call order (cache buster before every cold call; a warm call repeats the previous prompt)";
  snapshots: EnvironmentSnapshot[];
  snapshotsNormal: boolean;
  calls: DeterminismCall[];
  pass: boolean;
  summary: string[];
}

const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const ms = (ns: number | undefined): number | null => (typeof ns === "number" ? Math.round(ns / 1e6) : null);

interface LogCall {
  call_index: number;
  call_type: string;
  speaker: string;
  system_text: string;
  user_text: string;
  seed: number | null;
  attempts: Array<{ kind: string; accepted: boolean; prompt_eval_count: number | null; error: string | null }>;
}

/** The calls to repeat: the discussion and final calls with the largest reported prompts in the logs (initial attempts only). */
export function pickCalls(logsDir: string, discussionCalls: number, finalCalls: number): Array<{ source: string; call: LogCall }> {
  const files = fs.readdirSync(logsDir).filter((f) => /^DEV-\d\d-(COMPLETE|RING)(-rep\d+)?\.json$/.test(f)).sort();
  const all: Array<{ source: string; call: LogCall; size: number }> = [];
  for (const f of files) {
    const log = JSON.parse(fs.readFileSync(path.join(logsDir, f), "utf8")) as { run_id: string; calls: LogCall[] };
    for (const c of log.calls) {
      const initial = c.attempts.find((a) => a.kind === "initial" && a.error === null);
      if (!initial || typeof c.seed !== "number") continue;
      all.push({ source: `${log.run_id} call ${c.call_index} (${c.speaker})`, call: c, size: initial.prompt_eval_count ?? 0 });
    }
  }
  const largest = (type: string, n: number) => all.filter((x) => x.call.call_type === type).sort((a, b) => b.size - a.size || a.source.localeCompare(b.source)).slice(0, n);
  return [...largest("discussion", discussionCalls), ...largest("final", finalCalls)].map(({ source, call }) => ({ source, call }));
}

export async function determinism(opts: DeterminismOptions): Promise<DeterminismReport> {
  const log = opts.log ?? (() => {});
  const fetchFn = opts.fetch ?? fetch;
  const nvidia = opts.nvidiaSmi ?? nvidiaSmiText;
  const record = opts.record ?? loadFreezeRecord();
  const root = opts.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const repeats = opts.repeats ?? 3;
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const gen = PILOT_GENERATION;
  const startedAt = new Date().toISOString();

  async function api<T>(method: "GET" | "POST", route: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T | null; text: string }> {
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
    return { ok: res.ok, status: res.status, data, text };
  }

  async function snapshot(when: EnvironmentSnapshot["when"]): Promise<EnvironmentSnapshot> {
    const [version, ps] = await Promise.all([api<{ version?: string }>("GET", "/api/version"), api<{ models?: PsModel[] }>("GET", "/api/ps")]);
    const v = version.data?.version ?? null;
    const judged = judgeSnapshot(ps.data, v, record);
    const snap: EnvironmentSnapshot = { when, taken_at: new Date().toISOString(), ollama_version: v ?? "unknown", ollama_ps: (ps.data as Record<string, unknown> | null) ?? { error: `HTTP ${ps.status}` }, nvidia_smi: nvidia(), normal: judged.normal, deviation: judged.deviation };
    log(`snapshot ${when}: ${snap.normal ? "normal" : `ABNORMAL — ${snap.deviation}`}`);
    return snap;
  }

  let busters = 0;
  async function bust(): Promise<void> {
    busters += 1;
    const r = await api("POST", "/api/generate", { model: opts.model, prompt: `determinism cache buster ${busters} ${Math.random().toString(36).slice(2)}`, raw: true, stream: false, keep_alive: gen.keepAlive, options: { num_predict: 1, num_ctx: gen.contextLength } });
    if (!r.ok) throw new Error(`cache buster failed: HTTP ${r.status}: ${r.text.slice(0, 200)}`);
  }

  interface ChatResponse {
    message?: { content?: string; thinking?: string };
    done_reason?: string;
    eval_count?: number;
    prompt_eval_count?: number;
    load_duration?: number;
    total_duration?: number;
  }
  const options = { num_ctx: gen.contextLength, num_predict: gen.maxOutputTokens, temperature: gen.temperature, top_p: gen.sampling.topP, top_k: gen.sampling.topK, min_p: gen.sampling.minP, presence_penalty: gen.sampling.presencePenalty, repeat_penalty: gen.sampling.repeatPenalty };
  async function chat(messages: ChatMessage[], seed: number): Promise<ChatResponse> {
    const r = await api<ChatResponse>("POST", "/api/chat", { model: opts.model, messages, stream: false, think: true, keep_alive: gen.keepAlive, options: { ...options, seed } });
    if (!r.ok || !r.data) throw new Error(`/api/chat failed: HTTP ${r.status}: ${r.text.slice(0, 300)}`);
    return r.data;
  }

  // The calls.
  const picked = pickCalls(opts.logsDir, opts.discussionCalls ?? 3, opts.finalCalls ?? 2);
  const items: Array<{ id: string; kind: DeterminismCall["kind"]; source: string; seed: number; messages: ChatMessage[]; promptTokensReported: number | null }> = picked.map(({ source, call }) => ({
    id: `${call.call_type}:${source}`,
    kind: call.call_type as DeterminismCall["kind"],
    source,
    seed: call.seed as number,
    messages: [
      { role: "system", content: call.system_text },
      { role: "user", content: call.user_text },
    ],
    promptTokensReported: call.attempts.find((a) => a.kind === "initial")?.prompt_eval_count ?? null,
  }));
  const instanceId = opts.publicOnlyInstance ?? "DEV-01";
  const instance = bundleInstances()[instanceId];
  if (!instance) throw new Error(`unknown instance "${instanceId}"`);
  const pub = publicOnlyMessages(instance.state);
  items.push({ id: `public_only:${instanceId}`, kind: "public_only", source: `${instanceId} public-only, replicate 0`, seed: publicOnlySeed(pub, 0), messages: pub, promptTokensReported: null });
  if (picked.length < (opts.discussionCalls ?? 3) + (opts.finalCalls ?? 2)) log(`WARNING: only ${picked.length} discussion / final calls found in ${opts.logsDir}`);

  const snapshots: EnvironmentSnapshot[] = [await snapshot("before_pair")];
  const calls: DeterminismCall[] = [];
  for (const item of items) {
    log(`${item.id}: ${repeats} cold + ${repeats} warm`);
    const results: DeterminismCall["results"] = [];
    for (let i = 0; i < repeats; i++) {
      await bust();
      const r = await chat(item.messages, item.seed);
      results.push({ cache: "cold", repeat: i, contentSha256: sha256(r.message?.content ?? ""), thinkingSha256: sha256(r.message?.thinking ?? ""), evalCount: r.eval_count ?? null, doneReason: r.done_reason ?? null, promptEvalCount: r.prompt_eval_count ?? null, loadDurationMs: ms(r.load_duration), totalDurationMs: ms(r.total_duration) });
      log(`  cold ${i}: eval ${r.eval_count} (${r.done_reason}), content ${results[results.length - 1]!.contentSha256.slice(0, 12)}`);
    }
    // Warm: the prompt is already in the cache from the last cold call; each warm call repeats it.
    for (let i = 0; i < repeats; i++) {
      const r = await chat(item.messages, item.seed);
      results.push({ cache: "warm", repeat: i, contentSha256: sha256(r.message?.content ?? ""), thinkingSha256: sha256(r.message?.thinking ?? ""), evalCount: r.eval_count ?? null, doneReason: r.done_reason ?? null, promptEvalCount: r.prompt_eval_count ?? null, loadDurationMs: ms(r.load_duration), totalDurationMs: ms(r.total_duration) });
      log(`  warm ${i}: eval ${r.eval_count} (${r.done_reason}), content ${results[results.length - 1]!.contentSha256.slice(0, 12)}`);
    }
    const same = (xs: typeof results) => new Set(xs.map((x) => x.contentSha256)).size === 1;
    const cold = results.filter((x) => x.cache === "cold");
    const warm = results.filter((x) => x.cache === "warm");
    const identical = { cold: same(cold), warm: same(warm), acrossStates: same(results) };
    calls.push({ id: item.id, kind: item.kind, source: item.source, seed: item.seed, promptTokensReported: item.promptTokensReported, results, identical });
    log(`  identical: cold ${identical.cold}, warm ${identical.warm}, across ${identical.acrossStates}`);
  }
  snapshots.push(await snapshot("after_pair"));
  const snapshotsNormal = snapshots.every((s) => s.normal);
  const allIdentical = calls.every((c) => c.identical.cold && c.identical.warm);
  const pass = snapshotsNormal && allIdentical && calls.length === items.length;
  const summary = [
    `G6 determinism: ${calls.length} calls × ${repeats} cold + ${repeats} warm; content identical within state: ${calls.filter((c) => c.identical.cold && c.identical.warm).length}/${calls.length}; across states: ${calls.filter((c) => c.identical.acrossStates).length}/${calls.length}; snapshots ${snapshotsNormal ? "normal" : "ABNORMAL"}: ${pass ? "pass" : "FAIL"}`,
    ...calls.map((c) => `  ${c.id}: cold ${c.identical.cold ? "same" : "DIFFERS"}, warm ${c.identical.warm ? "same" : "DIFFERS"}, across ${c.identical.acrossStates ? "same" : "differs"}; eval ${c.results.map((r) => r.evalCount).join("/")}`),
  ];
  for (const line of summary) log(line);
  return { schema: "pilot-settlement/determinism/1", startedAt, finishedAt: new Date().toISOString(), baseUrl: opts.baseUrl, model: opts.model, classification: "by call order (cache buster before every cold call; a warm call repeats the previous prompt)", snapshots, snapshotsNormal, calls, pass, summary };
}

export function writeDeterminism(report: DeterminismReport, file: string): string {
  const out = path.resolve(file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 1) + "\n");
  return out;
}
