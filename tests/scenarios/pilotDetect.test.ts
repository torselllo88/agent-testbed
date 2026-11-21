import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detect, ExtractionSchema, messagesOfLog, renderExtractionPrompt } from "../../src/scenarios/pilotSettlement/detector/detect.js";

/**
 * The detector runner against a scripted server: run logs in the run-log shape, a /api/chat that
 * answers an extraction per message (bound to the schema), the cache of extractions, the
 * post-processing output per run and the summary (§8.3 hedged share).
 */

const MODEL = "qwen-fake:27b";
const ALL = ["Contract", "Settlement", "Treasury", "Compliance", "Operations", "Verification"];
const others = (s: string) => ALL.filter((r) => r !== s);

function runLog(runId: string, instanceId: string, topology: "complete" | "ring", messages: Array<{ turn: number; speaker: string; recipients: string[]; text: string }>, correct: boolean) {
  return {
    run_id: runId,
    instance_id: instanceId,
    condition: "discussion",
    topology,
    calls: [
      ...messages.map((m) => ({ call_type: "discussion", turn: m.turn, round: Math.ceil(m.turn / 6), speaker: m.speaker, recipients: m.recipients, accepted_text: m.text })),
      { call_type: "discussion", turn: 99, speaker: "Treasury", recipients: ["Operations"], accepted_text: null }, // a silent turn: no message
      { call_type: "final", turn: null, speaker: "Operations", recipients: [] },
    ],
    final: { correct_exact: correct },
  };
}

const factItem = (span: string, o: Record<string, unknown>) => ({ span, kind: "fact", hedged: false, role_named: null, first_person: false, relay_marker: false, predicate: null, polarity: "positive", objects: [], exhaustive: false, scope_destination: null, status_value: null, derived: null, proposal: null, ...o });

/** The scripted extractor: a fixed extraction keyed on the message text. */
const EXTRACTIONS: Record<string, unknown> = {
  "Contract permits D2 only.": { items: [factItem("Contract permits D2 only.", { role_named: "Contract", first_person: true, predicate: "permits", objects: [{ type: "destination", destination: "D2", rail: null }], exhaustive: true })] },
  "Settlement supports D2 / Rail A. I think D1 / Rail B is supported too.": {
    items: [
      factItem("Settlement supports D2 / Rail A.", { role_named: "Settlement", first_person: true, predicate: "supports", objects: [{ type: "route", destination: "D2", rail: "A" }] }),
      factItem("I think D1 / Rail B is supported too.", { hedged: true, first_person: true, predicate: "supported", objects: [{ type: "route", destination: "D1", rail: "B" }] }),
    ],
  },
  "Compliance authorizes D2.": { items: [factItem("Compliance authorizes D2.", { role_named: "Compliance", first_person: true, predicate: "authorizes", objects: [{ type: "destination", destination: "D2", rail: null }] })] },
  "Verification of M-204: accepted.": { items: [factItem("Verification of M-204: accepted.", { role_named: "Verification", first_person: true, predicate: "accepted", objects: [{ type: "milestone", destination: null, rail: null }], status_value: "accepted" })] },
  "Treasury approval: approved.": { items: [factItem("Treasury approval: approved.", { role_named: "Treasury", first_person: true, predicate: "approved", objects: [{ type: "approval", destination: null, rail: null }], status_value: "approved" })] },
  "So we execute D2 via Rail A.": { items: [{ span: "So we execute D2 via Rail A.", kind: "proposal", hedged: false, role_named: null, first_person: false, relay_marker: false, predicate: null, polarity: null, objects: [], exhaustive: false, scope_destination: null, status_value: null, derived: null, proposal: { action: "execute", destination: "D2", rail: "A", reason: null } }] },
  BROKEN: "not json at all",
};

function scripted() {
  const seen: Array<Record<string, unknown>> = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/ps")) return json(200, { models: [{ name: MODEL, model: MODEL, size: 10, size_vram: 10, context_length: 8192, digest: "d" }] });
    if (!url.endsWith("/api/chat")) return json(404, { error: "not found" });
    const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
    seen.push(body);
    const prompt = (body.messages as Array<{ content: string }>)[0]!.content;
    const text = prompt.slice(prompt.indexOf("MESSAGE:\n") + "MESSAGE:\n".length).trim();
    const ext = EXTRACTIONS[text] ?? { items: [] };
    const content = typeof ext === "string" ? ext : JSON.stringify(ext);
    return json(200, { model: MODEL, message: { role: "assistant", content }, done: true, done_reason: "stop", prompt_eval_count: 300, eval_count: 50, total_duration: 1e9, load_duration: 1e6 });
  };
  return { fetch: fetchFn, seen };
}

describe("pilot settlement detector: extraction and post-processing of run logs", () => {
  let dir: string;
  let out: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-detect-"));
    out = path.join(dir, "out");
    const logs = path.join(dir, "logs");
    fs.mkdirSync(logs);
    // DEV-01: requested D2; Contract D1, D2; Compliance D1, D2; routes D1/B, D2/A — canonical execute D2 / A.
    fs.writeFileSync(path.join(logs, "DEV-01-COMPLETE.json"), JSON.stringify(runLog("DEV-01-COMPLETE", "DEV-01", "complete", [
      { turn: 1, speaker: "Contract", recipients: others("Contract"), text: "Contract permits D2 only." },
      { turn: 2, speaker: "Settlement", recipients: others("Settlement"), text: "Settlement supports D2 / Rail A. I think D1 / Rail B is supported too." },
      { turn: 3, speaker: "Compliance", recipients: others("Compliance"), text: "Compliance authorizes D2." },
      { turn: 4, speaker: "Verification", recipients: others("Verification"), text: "Verification of M-204: accepted." },
      { turn: 5, speaker: "Treasury", recipients: others("Treasury"), text: "Treasury approval: approved." },
      { turn: 6, speaker: "Operations", recipients: others("Operations"), text: "So we execute D2 via Rail A." },
    ], true)));
    fs.writeFileSync(path.join(logs, "DEV-01-RING.json"), JSON.stringify(runLog("DEV-01-RING", "DEV-01", "ring", [
      { turn: 1, speaker: "Contract", recipients: ["Settlement", "Compliance"], text: "Contract permits D2 only." },
      { turn: 2, speaker: "Settlement", recipients: ["Operations", "Contract"], text: "BROKEN" },
    ], false)));
    fs.writeFileSync(path.join(logs, "DEV-01-ORACLE.json"), JSON.stringify({ run_id: "DEV-01-ORACLE", instance_id: "DEV-01", condition: "oracle", topology: "none", calls: [], final: {} }));
    fs.writeFileSync(path.join(logs, "DEV-01-COMPLETE.thinking.json"), "[]");
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("renders the bundle's prompt with the sender and the message only, and reads the accepted discussion messages of a log", () => {
    const p = renderExtractionPrompt("Contract", "Hello.");
    expect(p).toContain("Sender of the message: Contract");
    expect(p.trimEnd().endsWith("MESSAGE:\nHello.")).toBe(true);
    const log = JSON.parse(fs.readFileSync(path.join(dir, "logs", "DEV-01-COMPLETE.json"), "utf8"));
    expect(messagesOfLog(log).map((m) => m.turn)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ExtractionSchema.safeParse({ items: [{ span: "x", kind: "other", hedged: false, extra: 1 }] }).success).toBe(false);
  });

  it("extracts every message with the plan's settings, caches the extractions, post-processes and summarises", async () => {
    const server = scripted();
    const lines: string[] = [];
    const summary = await detect({ logsDir: path.join(dir, "logs"), outDir: out, baseUrl: "http://fake:11434", model: MODEL, fetch: server.fetch, log: (l) => lines.push(l) });
    // 6 fact items in the complete run (one hedged), 1 in the ring run; the ring's second message fails extraction.
    expect(summary).toMatchObject({ runs: 2, messages: 8, extracted: 7, extraction_failures: 1, cached: 0, fact_items: 7, hedged_fact_items: 1 });
    expect(summary.hedged_share).toBeCloseTo(1 / 7);
    // Every extraction call: thinking off, temperature 0, the seed, the schema as format, one user message, no topology or outcome in it.
    expect(server.seen).toHaveLength(8 + 1); // the broken message was retried once
    for (const b of server.seen) {
      expect(b.think).toBe(false);
      expect(b.format).toMatchObject({ type: "object", required: ["items"] });
      expect((b.options as { temperature: number; seed: number; num_ctx: number }).temperature).toBe(0);
      expect((b.options as { seed: number }).seed).toBe(20261122);
      expect((b.messages as unknown[]).length).toBe(1);
      expect((b.messages as Array<{ content: string }>)[0]!.content).not.toMatch(/topology|canonical|COMPLETE|RING/); // the prompt's own vocabulary says "complete list"; the run's topology, class and outcome never appear
    }
    const complete = JSON.parse(fs.readFileSync(path.join(out, "DEV-01-COMPLETE.detector.json"), "utf8"));
    expect(complete.operations.category).toBe("base_sufficient");
    expect(complete.operations.minimal_fact_set_exposed).toBe(true);
    expect(complete.operations.proposal_correct).toBe(true);
    // The hedged route claim is excluded from exposure; the exhaustive Contract statement exposes D1 = false as well.
    expect(complete.operations.exposure).toMatchObject({ "contract.permits.D2": "correct", "contract.permits.D1": "incorrect", "compliance.authorizes.D2": "correct", "settlement.supports.D2.A": "correct", "settlement.supports.D1.B": "absent", "verification.status": "correct", "treasury.status": "correct" });
    const types = complete.claims.map((c: { type: string }) => c.type);
    expect(types.filter((t: string) => t === "base")).toHaveLength(2 + 1 + 1 + 1 + 1 + 1); // D1 and D2 from the exhaustive statement, the route, the hedged route, compliance, verification, treasury
    const solution = complete.claims.find((c: { type: string }) => c.type === "solution");
    expect(solution).toMatchObject({ truth: true, sender: "Operations", support: "supported", grounding: "grounded" });
    const ring = JSON.parse(fs.readFileSync(path.join(out, "DEV-01-RING.detector.json"), "utf8"));
    expect(ring.extraction_failures).toEqual([2]);
    expect(ring.operations.proposal_correct).toBe(false);
    expect(ring.operations.category).toBe("insufficient");
    const cache = JSON.parse(fs.readFileSync(path.join(out, "extractions", "DEV-01-RING.json"), "utf8"));
    expect(cache.messages[1]).toMatchObject({ turn: 2, extraction: null, raw: "not json at all", attempts: 2 });
    expect(cache.messages[1].error).toMatch(/^parse:/);
    expect(cache).toMatchObject({ seed: 20261122, extraction_model: MODEL });
    expect(fs.existsSync(path.join(out, "DEV-01-ORACLE.detector.json"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(out, "summary.json"), "utf8")).categories).toEqual({ complete: { base_sufficient: 1 }, ring: { insufficient: 1 } });

    // A second pass uses the cache and never calls the model.
    const again = await detect({ logsDir: path.join(dir, "logs"), outDir: out, baseUrl: "http://fake:11434", model: MODEL, fetch: server.fetch, postprocessOnly: true });
    expect(again.cached).toBe(2);
    expect(server.seen).toHaveLength(9);
  });
});
