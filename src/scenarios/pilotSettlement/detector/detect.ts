/**
 * The pilot's exposure detector (Pilot Experimental Plan §8): stage 1, the LLM extraction of every
 * accepted discussion message into the closed schema (`prompts/detector_extraction.txt`,
 * `schemas/detector_extraction.schema.json`) — input: the message's text and its sender's role only;
 * stage 2, the deterministic post-processing (`postprocess.ts`). One record per run in the form of
 * `schemas/detector_output.schema.json`.
 *
 * Extraction model (§8.2): the pilot model with thinking off, temperature 0, seed 20261122 and
 * Ollama's structured output bound to the extraction schema. Extractions are cached per run
 * (`<out>/extractions/<run_id>.json`), so a rerun of the post-processing never calls the model again.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { OllamaProvider } from "../../../llm/ollamaProvider.js";
import type { ChatMessage } from "../../../llm/provider.js";
import { BUNDLE_DIR, PILOT_GENERATION } from "../adapter.js";
import { bundleInstances } from "../family.js";
import { AGENTS, type RoleName } from "../task.js";
import { decisionSupport, labelRun, type Claim, type DecisionSupport, type Extraction, type RunMessage } from "./postprocess.js";

export const DETECTOR_VERSION = "pilot-settlement/detector 1.0";
export const EXTRACTION_SEED = 20261122;
export const EXTRACTION_MAX_TOKENS = 4096;
export const PROMPT_FILE = path.join(BUNDLE_DIR, "prompts", "detector_extraction.txt");
export const EXTRACTION_SCHEMA_FILE = path.join(BUNDLE_DIR, "schemas", "detector_extraction.schema.json");

const Role = z.enum(AGENTS);
const Dest = z.enum(["D1", "D2"]);
/** The closed extraction schema, as zod (the JSON schema is what the server is bound to). */
export const ExtractionItemSchema = z
  .object({
    span: z.string(),
    kind: z.enum(["fact", "derived", "proposal", "question", "conditional", "ignorance", "other"]),
    hedged: z.boolean(),
    role_named: Role.nullable().optional(),
    first_person: z.boolean().optional(),
    relay_marker: z.boolean().optional(),
    predicate: z.string().nullable().optional(),
    polarity: z.enum(["positive", "negative"]).nullable().optional(),
    objects: z.array(z.object({ type: z.enum(["destination", "route", "milestone", "approval"]), destination: Dest.nullable().optional(), rail: z.enum(["A", "B"]).nullable().optional() }).strict()).optional(),
    exhaustive: z.boolean().optional(),
    scope_destination: Dest.nullable().optional(),
    status_value: z.enum(["accepted", "pending", "approved"]).nullable().optional(),
    derived: z
      .object({
        item: z.enum(["has_route", "eligible", "executable", "eligible_set", "executable_set", "reject_reason", "blocker", "selected_destination", "selected_rail"]),
        destination: Dest.nullable().optional(),
        set_value: z.array(Dest).nullable().optional(),
        value: z.union([z.boolean(), z.string()]).nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    proposal: z
      .object({
        action: z.enum(["execute", "hold", "reject"]).optional(),
        destination: Dest.nullable().optional(),
        rail: z.enum(["A", "B"]).nullable().optional(),
        reason: z.enum(["NO_ELIGIBLE_DESTINATION", "NO_ROUTE", "VERIFICATION_PENDING", "APPROVAL_PENDING"]).nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
export const ExtractionSchema = z.object({ items: z.array(ExtractionItemSchema) }).strict();

export function renderExtractionPrompt(sender: RoleName, message: string, template: string = fs.readFileSync(PROMPT_FILE, "utf8")): string {
  const out = template.replace("{{sender}}", sender).replace("{{message}}", message);
  if (out.includes("{{")) throw new Error("detector prompt: unfilled placeholder");
  return out;
}

export interface ExtractedMessage {
  turn: number;
  speaker: RoleName;
  recipients: RoleName[];
  text: string;
  extraction: Extraction | null;
  /** The model's raw answer when it did not parse or validate (the message then counts as having no items). */
  error: string | null;
  raw: string | null;
  done_reason: string | null;
  eval_count: number | null;
  prompt_eval_count: number | null;
  attempts: number;
}

export interface ExtractionRecord {
  run_id: string;
  instance_id: string;
  detector_version: string;
  extraction_model: string;
  seed: number;
  prompt_sha256: string;
  schema_sha256: string;
  extracted_at: string;
  messages: ExtractedMessage[];
}

export interface DetectorOutput {
  run_id: string;
  detector_version: string;
  extraction_model: string;
  topology: string;
  instance_id: string;
  claims: Claim[];
  operations: DecisionSupport;
  /** Messages whose extraction failed (no items used), by turn. */
  extraction_failures: number[];
}

interface RunLogLike {
  run_id: string;
  instance_id: string;
  condition: string;
  topology: string;
  calls: Array<{ call_type: string; turn: number | null; speaker: string; recipients?: string[]; accepted_text?: string | null }>;
  final: { correct_exact?: boolean };
}

/** The accepted discussion messages of a run log, in turn order. */
export function messagesOfLog(log: RunLogLike): RunMessage[] {
  return log.calls
    .filter((c) => c.call_type === "discussion" && typeof c.turn === "number" && typeof c.accepted_text === "string" && c.accepted_text.length > 0)
    .map((c) => ({ turn: c.turn as number, speaker: c.speaker as RoleName, recipients: (c.recipients ?? []) as RoleName[], text: c.accepted_text as string }))
    .sort((a, b) => a.turn - b.turn);
}

export interface DetectOptions {
  logsDir: string;
  outDir: string;
  baseUrl: string;
  model: string;
  /** Only these run ids (default: every discussion log in the directory). */
  runs?: string[];
  /** Skip the model: post-process the cached extractions only. */
  postprocessOnly?: boolean;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export interface DetectSummary {
  runs: number;
  messages: number;
  extracted: number;
  extraction_failures: number;
  cached: number;
  /** §8.3: the share of fact claims marked hedged (spec issue S1 above 10 %). */
  fact_items: number;
  hedged_fact_items: number;
  hedged_share: number | null;
  categories: Record<string, Record<string, number>>;
  claim_types: Record<string, number>;
  sources: Record<string, number>;
  supports: Record<string, number>;
}

const sha256File = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const inc = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);

export async function detect(opts: DetectOptions): Promise<DetectSummary> {
  const log = opts.log ?? (() => {});
  const template = fs.readFileSync(PROMPT_FILE, "utf8");
  const schema = JSON.parse(fs.readFileSync(EXTRACTION_SCHEMA_FILE, "utf8")) as Record<string, unknown>;
  const promptSha = sha256File(PROMPT_FILE);
  const schemaSha = sha256File(EXTRACTION_SCHEMA_FILE);
  const provider = new OllamaProvider({ name: "detector", baseUrl: opts.baseUrl, fetch: opts.fetch });
  const instances = bundleInstances();
  const extractionsDir = path.join(opts.outDir, "extractions");
  fs.mkdirSync(extractionsDir, { recursive: true });

  const files = fs
    .readdirSync(opts.logsDir)
    .filter((f) => f.endsWith(".json") && !f.includes(".thinking.") && !f.includes(".detector."))
    .sort();
  const summary: DetectSummary = { runs: 0, messages: 0, extracted: 0, extraction_failures: 0, cached: 0, fact_items: 0, hedged_fact_items: 0, hedged_share: null, categories: {}, claim_types: {}, sources: {}, supports: {} };

  async function extractOne(sender: RoleName, text: string): Promise<Omit<ExtractedMessage, "turn" | "speaker" | "recipients" | "text">> {
    const messages: ChatMessage[] = [{ role: "user", content: renderExtractionPrompt(sender, text, template) }];
    let lastError = "";
    let raw: string | null = null;
    let doneReason: string | null = null;
    let evalCount: number | null = null;
    let promptEval: number | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const r = await provider.complete({
        model: opts.model,
        messages,
        temperature: 0,
        seed: EXTRACTION_SEED,
        maxOutputTokens: EXTRACTION_MAX_TOKENS,
        contextLength: PILOT_GENERATION.contextLength,
        keepAlive: PILOT_GENERATION.keepAlive,
        think: false,
        responseFormat: { name: "detector_extraction", schema },
      });
      raw = r.text;
      doneReason = r.finishReason ?? null;
      evalCount = r.usage?.completionTokens ?? null;
      promptEval = r.usage?.promptTokens ?? null;
      try {
        const parsed = ExtractionSchema.safeParse(JSON.parse(r.text));
        if (parsed.success) return { extraction: parsed.data as Extraction, error: null, raw: null, done_reason: doneReason, eval_count: evalCount, prompt_eval_count: promptEval, attempts: attempt };
        lastError = `schema: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 500)}`;
      } catch (err) {
        lastError = `parse: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    return { extraction: null, error: lastError, raw, done_reason: doneReason, eval_count: evalCount, prompt_eval_count: promptEval, attempts: 2 };
  }

  for (const f of files) {
    const runLog = JSON.parse(fs.readFileSync(path.join(opts.logsDir, f), "utf8")) as RunLogLike;
    if (runLog.condition !== "discussion") continue;
    if (opts.runs && !opts.runs.includes(runLog.run_id)) continue;
    const instance = instances[runLog.instance_id];
    if (!instance) throw new Error(`${f}: unknown instance ${runLog.instance_id}`);
    const messages = messagesOfLog(runLog);
    const cacheFile = path.join(extractionsDir, `${runLog.run_id}.json`);
    let record: ExtractionRecord | null = fs.existsSync(cacheFile) ? (JSON.parse(fs.readFileSync(cacheFile, "utf8")) as ExtractionRecord) : null;
    const cacheValid = record !== null && record.extraction_model === opts.model && record.seed === EXTRACTION_SEED && record.prompt_sha256 === promptSha && record.schema_sha256 === schemaSha && record.messages.length === messages.length && record.messages.every((m, i) => m.turn === messages[i]!.turn && m.text === messages[i]!.text);
    if (!cacheValid) {
      if (opts.postprocessOnly) throw new Error(`${runLog.run_id}: no valid cached extraction in ${extractionsDir} (postprocess-only)`);
      log(`${runLog.run_id}: extracting ${messages.length} messages`);
      const extracted: ExtractedMessage[] = [];
      for (const m of messages) {
        const r = await extractOne(m.speaker, m.text);
        extracted.push({ turn: m.turn, speaker: m.speaker, recipients: m.recipients, text: m.text, ...r });
        log(`  turn ${m.turn} ${m.speaker}: ${r.extraction ? `${r.extraction.items.length} items` : `FAILED (${r.error})`}${r.attempts > 1 ? ` after ${r.attempts} attempts` : ""}`);
      }
      record = { run_id: runLog.run_id, instance_id: runLog.instance_id, detector_version: DETECTOR_VERSION, extraction_model: opts.model, seed: EXTRACTION_SEED, prompt_sha256: promptSha, schema_sha256: schemaSha, extracted_at: new Date().toISOString(), messages: extracted };
      fs.writeFileSync(cacheFile, JSON.stringify(record, null, 1) + "\n");
    } else {
      summary.cached += 1;
      log(`${runLog.run_id}: cached extraction`);
    }
    const rec = record as ExtractionRecord;
    const extractions: Record<number, Extraction> = {};
    const failures: number[] = [];
    for (const m of rec.messages) {
      if (m.extraction) extractions[m.turn] = m.extraction;
      else failures.push(m.turn);
      for (const item of m.extraction?.items ?? []) {
        if (item.kind === "fact") {
          summary.fact_items += 1;
          if (item.hedged) summary.hedged_fact_items += 1;
        }
      }
    }
    const claims = labelRun(instance.state, messages, extractions);
    const mfs = ((instance as unknown as { metadata?: { minimal_fact_sets?: string[][] } }).metadata?.minimal_fact_sets ?? []) as string[][];
    const operations = decisionSupport(instance.state, mfs, claims, runLog.final?.correct_exact === true);
    const output: DetectorOutput = { run_id: runLog.run_id, detector_version: DETECTOR_VERSION, extraction_model: opts.model, topology: runLog.topology, instance_id: runLog.instance_id, claims, operations, extraction_failures: failures };
    fs.writeFileSync(path.join(opts.outDir, `${runLog.run_id}.detector.json`), JSON.stringify(output, null, 1) + "\n");
    summary.runs += 1;
    summary.messages += messages.length;
    summary.extracted += rec.messages.filter((m) => m.extraction).length;
    summary.extraction_failures += failures.length;
    summary.categories[runLog.topology] ??= {};
    inc(summary.categories[runLog.topology]!, operations.category);
    for (const c of claims) {
      inc(summary.claim_types, c.type);
      if (c.source) inc(summary.sources, c.source);
      if (c.support) inc(summary.supports, c.support);
    }
    log(`${runLog.run_id}: ${claims.length} claims, category ${operations.category}, minimal fact set exposed ${operations.minimal_fact_set_exposed}${failures.length ? `, ${failures.length} extraction failure(s)` : ""}`);
  }
  summary.hedged_share = summary.fact_items ? summary.hedged_fact_items / summary.fact_items : null;
  fs.writeFileSync(path.join(opts.outDir, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
  return summary;
}
