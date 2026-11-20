/**
 * Gate G2 calibration against the real server (Pilot Experimental Plan §4, steps 1–4 and 6):
 *
 *   1. model record — /api/version, /api/show, the digest from /api/tags, compared with the frozen
 *      record in experiments/pilot-settlement/model/show.json;
 *   2. tokenizer count — every system prompt (all 50 instances × 2 topologies × 6 roles) with the
 *      model's tokenizer, all must be ≤ 1200;
 *   3. counting semantics — three fixed pilot prompts through /api/chat with the plan's settings,
 *      each cold (after a cache buster) and warm: prompt_eval_count / prompt_eval_cached_count
 *      against the local count, eval_count against thinking + visible tokens → prompt_count_rule;
 *   4. truncation canary — a prompt of about 9000 tokens with num_ctx 8192: the reported count must
 *      fall below the local count (or the server must refuse), else truncation is undetectable;
 *   6. (optional, --worst-case) the synthetic worst case: a final call with 18 visible messages of
 *      200 tokens each through the real model, which must finish within num_predict.
 *
 * `npm run pilot -- calibrate` runs it and writes the report; nothing here touches the database.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatMessage } from "../../llm/provider.js";
import type { AdapterLogEntry } from "../../experiment/protocolAdapter.js";
import { callSeed, finalUser, lastJsonObject, oracleMessages, PILOT_GENERATION, publicRules, systemPrompt, turnUser } from "./adapter.js";
import { pilotSettlementConfig } from "./config.js";
import { bundleInstances } from "./family.js";
import { AGENT_ID, AGENTS, ROLE_OF_ID, type RoleName } from "./task.js";
import { GgufBpeTokenizer, PILOT_MODEL_SHOW_FILE } from "./tokenizer.js";
import { parseExperimentConfig, type ExperimentConfig } from "../../experiment/config.js";

export const PILOT_MODEL_RECORD_FILE = fileURLToPath(new URL("../../../experiments/pilot-settlement/model/show.json", import.meta.url));
const SYSTEM_PROMPT_CAP = 1200;
const CANARY_TARGET_TOKENS = 9000;
const WORST_CASE_MESSAGE_TOKENS = 200;
const DEFAULT_STEP3_NUM_PREDICT = 512;
const names = (id: string) => ROLE_OF_ID[id] ?? id;

export interface CalibrateOptions {
  baseUrl: string;
  model: string;
  /** num_predict of the step-3 calls (default 512: enough thinking to compare eval_count, not a full generation). */
  step3NumPredict?: number;
  /** Also run the synthetic worst case (step 6, one full generation with num_predict 2560). */
  worstCase?: boolean;
  /** The frozen record to compare the server's /api/show with (default: the experiment's model/show.json). */
  recordFile?: string;
  /** The verbose record the tokenizer is built from (default: model/show-verbose.json). */
  showVerboseFile?: string;
  fetch?: typeof fetch;
  /** Progress lines. */
  log?: (line: string) => void;
  /** Per-call timeout in milliseconds (default 15 minutes). */
  timeoutMs?: number;
}

interface ChatResponse {
  model?: string;
  message?: { role?: string; content?: string; thinking?: string };
  done_reason?: string;
  prompt_eval_count?: number;
  prompt_eval_cached_count?: number;
  eval_count?: number;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
}

export interface CountedCall {
  label: string;
  cache: "cold" | "warm";
  seed: number;
  /** The messages counted one by one with the tokenizer and summed (the adapter's count). */
  localPromptTokens: number;
  localPerMessage: number[];
  promptEvalCount: number | null;
  promptEvalCachedCount: number | null;
  /** prompt_eval_count − localPromptTokens: the chat template's own tokens if counting is of the full prompt. */
  overhead: number | null;
  evalCount: number | null;
  doneReason: string | null;
  thinkingTokens: number;
  contentTokens: number;
  /** eval_count − (thinking + content tokens): the tokens the model spent on the think markup / stop token. */
  evalExtra: number | null;
  contentSha256: string;
  thinkingSha256: string;
  loadDurationMs: number | null;
  promptEvalDurationMs: number | null;
  evalDurationMs: number | null;
  totalDurationMs: number | null;
}

export interface CalibrationReport {
  schema: "pilot-settlement/calibration/1";
  startedAt: string;
  finishedAt: string;
  baseUrl: string;
  model: string;
  generation: typeof PILOT_GENERATION;
  step1: {
    version: string | null;
    digest: string | null;
    capabilities: string[] | null;
    details: Record<string, unknown> | null;
    modifiedAt: string | null;
    thinkingLevels: unknown;
    /** Differences from the frozen record (empty: the server serves the recorded model). */
    recordDifferences: string[];
    tokenizerSourceSha256: string;
  };
  step2: {
    cap: number;
    maxTokens: number;
    maxAt: string;
    devMaxTokens: number;
    over: string[];
    pass: boolean;
  };
  step3: {
    numPredict: number;
    calls: CountedCall[];
    /** The overheads of every call, de-duplicated. One value: the rule holds. */
    overheads: number[];
    cachedCountReported: boolean;
    promptCountRule: string;
    evalCountIncludesThinking: boolean;
    warmEqualsCold: boolean;
    pass: boolean;
  };
  step4: {
    localPromptTokens: number;
    contextLength: number;
    promptEvalCount: number | null;
    httpError: string | null;
    doneReason: string | null;
    /** The shortfall was visible: the server refused, or reported fewer tokens than counted. */
    detectable: boolean;
    pass: boolean;
  };
  step6: null | {
    numPredict: number;
    call: CountedCall;
    proposalParsed: boolean;
    finishedWithinBudget: boolean;
    pass: boolean;
  };
  summary: string[];
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
const ms = (ns: number | undefined): number | null => (typeof ns === "number" ? Math.round(ns / 1e6) : null);

function configFor(id: string, topology: "complete" | "ring"): ExperimentConfig {
  const base = pilotSettlementConfig(id);
  if (topology === "complete") return base;
  const ring = (base.protocol!.params.ringPositions as RoleName[]).map((r) => AGENT_ID[r]);
  return parseExperimentConfig({ ...base, communication: { topology: { type: "ring", order: ring } } });
}

/** A text of exactly `tokens` tokens: plausible discussion sentences, cut by the tokenizer. */
export function fillerOfTokens(tokenizer: GgufBpeTokenizer, tokens: number, seed: number): string {
  const sentences = [
    "Contract permits D1 and does not permit D2, so the requested destination is covered on my side.",
    "Compliance has authorized D1; nothing is authorized for D2, which matters only if Operations changes the destination.",
    "Settlement supports D1 over Rail A and Rail B; D2 is not supported on either rail at the moment.",
    "Verification of M-204 is accepted, so rule three is satisfied and the milestone can be settled.",
    "Treasury approval is still pending; under rule four the correct action would be hold until it arrives.",
    "I hold no private information and will collect every fact before proposing an action for the settlement.",
  ];
  let text = "";
  let i = seed;
  while (tokenizer.count(text) < tokens + 8) {
    text += (text ? " " : "") + sentences[i % sentences.length];
    i++;
  }
  const ids = tokenizer.encode(text).slice(0, tokens);
  const cut = tokenizer.decode(ids);
  if (tokenizer.count(cut) !== tokens) throw new Error(`filler: cut text re-tokenizes to ${tokenizer.count(cut)} tokens, not ${tokens}`);
  return cut;
}

export async function calibrate(opts: CalibrateOptions): Promise<CalibrationReport> {
  const log = opts.log ?? (() => {});
  const fetchFn = opts.fetch ?? fetch;
  const root = opts.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const tokenizer = GgufBpeTokenizer.fromShowJson(opts.showVerboseFile ?? PILOT_MODEL_SHOW_FILE);
  const gen = PILOT_GENERATION;
  const startedAt = new Date().toISOString();
  const summary: string[] = [];

  async function call<T>(method: "GET" | "POST", route: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T | null; text: string }> {
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

  const options = { num_ctx: gen.contextLength, temperature: gen.temperature, top_p: gen.sampling.topP, top_k: gen.sampling.topK, min_p: gen.sampling.minP, presence_penalty: gen.sampling.presencePenalty, repeat_penalty: gen.sampling.repeatPenalty };

  async function chat(messages: ChatMessage[], seed: number, numPredict: number): Promise<{ res: Awaited<ReturnType<typeof call<ChatResponse>>> }> {
    const body = { model: opts.model, messages, stream: false, think: true, keep_alive: gen.keepAlive, options: { ...options, num_predict: numPredict, seed } };
    return { res: await call<ChatResponse>("POST", "/api/chat", body) };
  }

  let busters = 0;
  async function bust(): Promise<void> {
    busters += 1;
    const prompt = `calibration cache buster ${busters} ${Math.random().toString(36).slice(2)} ${"z".repeat(busters % 5)}`;
    const r = await call<ChatResponse>("POST", "/api/generate", { model: opts.model, prompt, raw: true, stream: false, keep_alive: gen.keepAlive, options: { num_predict: 1, num_ctx: gen.contextLength } });
    if (!r.ok) throw new Error(`cache buster failed: HTTP ${r.status}: ${r.text.slice(0, 200)}`);
  }

  function counted(label: string, cache: "cold" | "warm", seed: number, messages: ChatMessage[], r: Awaited<ReturnType<typeof call<ChatResponse>>>): CountedCall {
    if (!r.ok || !r.data) throw new Error(`${label} (${cache}) failed: HTTP ${r.status}: ${r.text.slice(0, 300)}`);
    const d = r.data;
    const perMessage = messages.map((m) => tokenizer.count(m.content));
    const local = perMessage.reduce((a, b) => a + b, 0);
    const thinking = d.message?.thinking ?? "";
    const content = d.message?.content ?? "";
    const thinkingTokens = tokenizer.count(thinking);
    const contentTokens = tokenizer.count(content);
    return {
      label,
      cache,
      seed,
      localPromptTokens: local,
      localPerMessage: perMessage,
      promptEvalCount: d.prompt_eval_count ?? null,
      promptEvalCachedCount: d.prompt_eval_cached_count ?? null,
      overhead: typeof d.prompt_eval_count === "number" ? d.prompt_eval_count - local : null,
      evalCount: d.eval_count ?? null,
      doneReason: d.done_reason ?? null,
      thinkingTokens,
      contentTokens,
      evalExtra: typeof d.eval_count === "number" ? d.eval_count - thinkingTokens - contentTokens : null,
      contentSha256: sha256(content),
      thinkingSha256: sha256(thinking),
      loadDurationMs: ms(d.load_duration),
      promptEvalDurationMs: ms(d.prompt_eval_duration),
      evalDurationMs: ms(d.eval_duration),
      totalDurationMs: ms(d.total_duration),
    };
  }

  // ---- step 1: model record
  log("step 1: model record");
  const version = await call<{ version?: string }>("GET", "/api/version");
  const show = await call<{ capabilities?: string[]; details?: Record<string, unknown>; modified_at?: string; model_info?: Record<string, unknown>; parameters?: string; template?: string; thinking_levels?: unknown }>("POST", "/api/show", { model: opts.model });
  const tags = await call<{ models?: Array<{ name?: string; model?: string; digest?: string }> }>("GET", "/api/tags");
  if (!show.ok || !show.data) throw new Error(`/api/show failed: HTTP ${show.status}: ${show.text.slice(0, 300)}`);
  const digest = tags.data?.models?.find((m) => m.name === opts.model || m.model === opts.model)?.digest ?? null;
  const recordDifferences: string[] = [];
  const recordFile = opts.recordFile ?? PILOT_MODEL_RECORD_FILE;
  if (fs.existsSync(recordFile)) {
    const record = JSON.parse(fs.readFileSync(recordFile, "utf8")) as { capabilities?: string[]; details?: Record<string, unknown>; modified_at?: string; parameters?: string; template?: string; model_info?: Record<string, unknown> };
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    if (!same(record.capabilities, show.data.capabilities)) recordDifferences.push(`capabilities: record ${JSON.stringify(record.capabilities)}, server ${JSON.stringify(show.data.capabilities)}`);
    if (!same(record.details, show.data.details)) recordDifferences.push(`details differ: record ${JSON.stringify(record.details)}, server ${JSON.stringify(show.data.details)}`);
    if (record.modified_at !== show.data.modified_at) recordDifferences.push(`modified_at: record ${record.modified_at}, server ${show.data.modified_at}`);
    if (record.parameters !== show.data.parameters) recordDifferences.push(`parameters differ (record: ${JSON.stringify(record.parameters)}, server: ${JSON.stringify(show.data.parameters)})`);
    if (record.template !== show.data.template) recordDifferences.push(`template: record ${JSON.stringify(record.template)}, server ${JSON.stringify(show.data.template)}`);
    for (const key of ["general.parameter_count", "general.file_type", "tokenizer.ggml.pre", "tokenizer.ggml.model", "qwen35.context_length"]) {
      if (!same(record.model_info?.[key], show.data.model_info?.[key])) recordDifferences.push(`model_info.${key}: record ${JSON.stringify(record.model_info?.[key])}, server ${JSON.stringify(show.data.model_info?.[key])}`);
    }
  } else recordDifferences.push(`no frozen record at ${recordFile}`);
  const step1: CalibrationReport["step1"] = {
    version: version.data?.version ?? null,
    digest,
    capabilities: show.data.capabilities ?? null,
    details: show.data.details ?? null,
    modifiedAt: show.data.modified_at ?? null,
    thinkingLevels: show.data.thinking_levels ?? null,
    recordDifferences,
    tokenizerSourceSha256: tokenizer.info.sourceSha256,
  };
  summary.push(`step 1: Ollama ${step1.version ?? "?"}, model ${opts.model} digest ${digest ?? "?"}; ${recordDifferences.length ? `record differences: ${recordDifferences.join("; ")}` : "the server serves the recorded model"}`);
  log(summary[summary.length - 1]!);

  // ---- step 2: tokenizer count of every system prompt
  log("step 2: tokenizer count of every system prompt");
  let maxTokens = 0;
  let maxAt = "";
  let devMaxTokens = 0;
  const over: string[] = [];
  const instances = bundleInstances();
  for (const id of Object.keys(instances)) {
    for (const topology of ["complete", "ring"] as const) {
      const config = configFor(id, topology);
      for (const role of AGENTS) {
        const n = tokenizer.count(systemPrompt(config, AGENT_ID[role]));
        const at = `${id} ${topology} ${role}`;
        if (n > maxTokens) {
          maxTokens = n;
          maxAt = at;
        }
        if (id.startsWith("DEV-")) devMaxTokens = Math.max(devMaxTokens, n);
        if (n > SYSTEM_PROMPT_CAP) over.push(`${at}: ${n}`);
      }
    }
  }
  const step2: CalibrationReport["step2"] = { cap: SYSTEM_PROMPT_CAP, maxTokens, maxAt, devMaxTokens, over, pass: over.length === 0 };
  summary.push(`step 2: largest system prompt ${maxTokens} tokens (${maxAt}), dev max ${devMaxTokens}, cap ${SYSTEM_PROMPT_CAP}: ${step2.pass ? "pass" : `FAIL (${over.length} over)`}`);
  log(summary[summary.length - 1]!);

  // ---- step 3: counting semantics
  const numPredict = opts.step3NumPredict ?? DEFAULT_STEP3_NUM_PREDICT;
  log(`step 3: counting semantics (3 prompts × cold / warm, num_predict ${numPredict})`);
  const dev01 = instances["DEV-01"]!;
  const complete = configFor("DEV-01", "complete");
  const prompts: Array<{ label: string; messages: ChatMessage[]; seed: number }> = [
    {
      label: "DEV-01 complete, discussion round 1, Operations",
      messages: [
        { role: "system", content: systemPrompt(complete, AGENT_ID.Operations) },
        { role: "user", content: turnUser([], AGENT_ID.Operations, 1, names) },
      ],
      seed: callSeed("DEV-01", "discussion", 1, "Operations"),
    },
    {
      label: "DEV-01 complete, final, empty history",
      messages: [
        { role: "system", content: systemPrompt(complete, AGENT_ID.Operations) },
        { role: "user", content: finalUser([], names) },
      ],
      seed: callSeed("DEV-01", "final", null, "Operations"),
    },
    { label: "DEV-01 oracle", messages: oracleMessages(dev01.state), seed: callSeed("DEV-01", "oracle", null, "Operations") },
  ];
  const calls: CountedCall[] = [];
  for (const p of prompts) {
    await bust();
    const cold = counted(p.label, "cold", p.seed, p.messages, (await chat(p.messages, p.seed, numPredict)).res);
    calls.push(cold);
    log(`  ${p.label} cold: local ${cold.localPromptTokens}, prompt_eval_count ${cold.promptEvalCount}, cached ${cold.promptEvalCachedCount}, eval ${cold.evalCount} (${cold.doneReason}), thinking ${cold.thinkingTokens} + content ${cold.contentTokens}`);
    const warm = counted(p.label, "warm", p.seed, p.messages, (await chat(p.messages, p.seed, numPredict)).res);
    calls.push(warm);
    log(`  ${p.label} warm: local ${warm.localPromptTokens}, prompt_eval_count ${warm.promptEvalCount}, cached ${warm.promptEvalCachedCount}, eval ${warm.evalCount} (${warm.doneReason}), thinking ${warm.thinkingTokens} + content ${warm.contentTokens}`);
  }
  const overheads = [...new Set(calls.map((c) => c.overhead).filter((o): o is number => o !== null))].sort((a, b) => a - b);
  const cachedCountReported = calls.some((c) => c.promptEvalCachedCount !== null);
  const evalCountIncludesThinking = calls.every((c) => c.evalExtra !== null && c.evalExtra >= 0 && c.evalExtra <= 4);
  const warmEqualsCold = prompts.every((_, i) => calls[2 * i]!.promptEvalCount === calls[2 * i + 1]!.promptEvalCount);
  let promptCountRule: string;
  if (overheads.length === 1 && overheads[0]! >= 0 && warmEqualsCold) {
    promptCountRule = `prompt_eval_count = local_count + ${overheads[0]} (the chat template's tokens), cached or not; prompt_eval_cached_count ${cachedCountReported ? "is reported separately and is not added" : "is not reported by this server version"}`;
  } else if (!warmEqualsCold) {
    promptCountRule = `UNRESOLVED: prompt_eval_count differs between cold and warm cache (overheads ${JSON.stringify(overheads)}); cached tokens are left out of prompt_eval_count on this server — see the calls`;
  } else {
    promptCountRule = `UNRESOLVED: the overhead is not constant across prompts (${JSON.stringify(overheads)})`;
  }
  const step3: CalibrationReport["step3"] = { numPredict, calls, overheads, cachedCountReported, promptCountRule, evalCountIncludesThinking, warmEqualsCold, pass: overheads.length === 1 && warmEqualsCold && evalCountIncludesThinking };
  summary.push(`step 3: ${promptCountRule}; eval_count ${evalCountIncludesThinking ? "includes" : "does NOT match"} thinking + visible tokens (extra ${JSON.stringify([...new Set(calls.map((c) => c.evalExtra))])}): ${step3.pass ? "pass" : "CHECK"}`);
  log(summary[summary.length - 1]!);

  // ---- step 4: truncation canary
  log("step 4: truncation canary");
  const system = systemPrompt(complete, AGENT_ID.Operations);
  const rules = publicRules(dev01.state);
  let canaryUser = "The following is the full record of every earlier settlement discussion, for reference.\n";
  let k = 1;
  while (tokenizer.count(system) + tokenizer.count(canaryUser) < CANARY_TARGET_TOKENS) {
    canaryUser += `\nRecord ${k}. ${rules.split("\n").join(" ")}`;
    k++;
  }
  const canaryMessages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: canaryUser + "\n\nReply with the single word OK." },
  ];
  const canaryLocal = canaryMessages.reduce((n, m) => n + tokenizer.count(m.content), 0);
  await bust();
  const canary = (await chat(canaryMessages, 1, 1)).res;
  const canaryCount = canary.ok && canary.data ? (canary.data.prompt_eval_count ?? null) : null;
  const httpError = canary.ok ? null : `HTTP ${canary.status}: ${canary.text.slice(0, 300)}`;
  const detectable = httpError !== null || (canaryCount !== null && canaryCount < canaryLocal);
  const step4: CalibrationReport["step4"] = { localPromptTokens: canaryLocal, contextLength: gen.contextLength, promptEvalCount: canaryCount, httpError, doneReason: canary.data?.done_reason ?? null, detectable, pass: detectable };
  summary.push(`step 4: canary of ${canaryLocal} local tokens at num_ctx ${gen.contextLength}: ${httpError ? `server refused (${httpError.slice(0, 80)})` : `prompt_eval_count ${canaryCount}`} → truncation ${detectable ? "detectable: pass" : "NOT detectable: FAIL"}`);
  log(summary[summary.length - 1]!);

  // ---- step 6: synthetic worst case
  let step6: CalibrationReport["step6"] = null;
  if (opts.worstCase) {
    log(`step 6: synthetic worst case (final call, 18 messages × ${WORST_CASE_MESSAGE_TOKENS} tokens, num_predict ${gen.maxOutputTokens})`);
    // The longest Operations system prompt under the complete graph among the dev instances.
    let worstId = "DEV-01";
    let worstSys = 0;
    for (const id of Object.keys(instances).filter((i) => i.startsWith("DEV-"))) {
      const n = tokenizer.count(systemPrompt(configFor(id, "complete"), AGENT_ID.Operations));
      if (n > worstSys) {
        worstSys = n;
        worstId = id;
      }
    }
    const config = configFor(worstId, "complete");
    const order = config.scheduler.type === "round_robin" ? (config.scheduler.order ?? config.agents.map((a) => a.id)) : config.agents.map((a) => a.id);
    const entries: AdapterLogEntry[] = [];
    for (let turn = 1; turn <= 18; turn++) {
      entries.push({ turn, round: Math.ceil(turn / 6), speakerId: order[(turn - 1) % 6]!, audience: null, text: fillerOfTokens(tokenizer, WORST_CASE_MESSAGE_TOKENS, turn) });
    }
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt(config, AGENT_ID.Operations) },
      { role: "user", content: finalUser(entries, names) },
    ];
    const seed = callSeed(worstId, "final", null, "Operations");
    await bust();
    const r = (await chat(messages, seed, gen.maxOutputTokens)).res;
    const c = counted(`${worstId} complete, final, worst case`, "cold", seed, messages, r);
    const parsed = lastJsonObject(r.data?.message?.content ?? "");
    const finishedWithinBudget = c.doneReason === "stop";
    step6 = { numPredict: gen.maxOutputTokens, call: c, proposalParsed: parsed !== null, finishedWithinBudget, pass: finishedWithinBudget && (c.promptEvalCount ?? 0) + (c.evalCount ?? 0) <= gen.contextLength - 200 };
    summary.push(`step 6: worst-case final call: local ${c.localPromptTokens}, prompt_eval_count ${c.promptEvalCount}, eval ${c.evalCount} (${c.doneReason}), thinking ${c.thinkingTokens}, proposal ${parsed ? "parsed" : "NOT parsed"}: ${step6.pass ? "pass" : "FAIL"}`);
    log(summary[summary.length - 1]!);
  }

  return {
    schema: "pilot-settlement/calibration/1",
    startedAt,
    finishedAt: new Date().toISOString(),
    baseUrl: opts.baseUrl,
    model: opts.model,
    generation: gen,
    step1,
    step2,
    step3,
    step4,
    step6,
    summary,
  };
}

export function writeCalibration(report: CalibrationReport, file: string): string {
  const out = path.resolve(file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 1) + "\n");
  return out;
}
