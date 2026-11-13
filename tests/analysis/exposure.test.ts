import { describe, expect, it } from "vitest";
import { parseCsv, parseCsvObjects, toCsv } from "../../src/analysis/csv.js";
import { detectRun, ExposureDetectionError, summarizeExposure, type ExposureResult, type LabeledMessage } from "../../src/analysis/exposure.js";
import { agreement, agreementFromCsv, exposureFactsCsv, exposureRunsCsv, labelingSampleCsv } from "../../src/analysis/exposureReport.js";
import { parseExperimentConfig, type ExperimentConfig } from "../../src/experiment/config.js";
import type { TaskFact } from "../../src/evaluation/types.js";
import type { CompletionRequest } from "../../src/llm/provider.js";
import { ExperimentRepository } from "../../src/persistence/experimentRepository.js";
import { ExposureRepository } from "../../src/persistence/exposureRepository.js";
import { createEvaluatorRegistry } from "../../src/scenarios/index.js";
import { serviceSettlementConfig } from "../../src/scenarios/serviceSettlement/config.js";
import { settlementFacts } from "../../src/scenarios/serviceSettlement/facts.js";
import { SETTLEMENT_DEV_01 } from "../../src/scenarios/serviceSettlement/task.js";
import { createHarness } from "../helpers/harness.js";

/**
 * Exposure detection: what reached whom. A scripted detector labels by
 * keywords, so the aggregation over audiences can be checked exactly.
 */

const KEYWORDS: Record<string, RegExp> = {
  "compliance.destination.ACC-7720": /ACC-7720 is still pending/,
  "compliance.destination.ACC-3148": /ACC-3148 is verified/,
  "settlement.rail.RAIL-X.limit": /RAIL-X caps a transfer at 10,000/,
  "treasury.funds": /12,000 units are available/,
};
const keywordDetector = (req: CompletionRequest) => {
  const ids = req.context!.factIds as string[];
  const text = String(req.context!.messageText);
  return JSON.stringify({ labels: Object.fromEntries(ids.map((id) => [id, KEYWORDS[id]?.test(text) ? { label: "correct", evidence: text.match(KEYWORDS[id]!)![0] } : { label: "absent", evidence: null }])) });
};
const DETECTOR = { provider: "stub", model: "detector/keywords", structuredOutput: "native" };

function settlement(topology: "complete" | "ring"): ExperimentConfig {
  const raw = structuredClone(serviceSettlementConfig()) as Record<string, any>;
  raw.runtime.providerRetryDelayMs = 0;
  raw.consensus = { rule: "none" };
  if (topology === "ring") raw.communication = { topology: { type: "ring" } };
  return parseExperimentConfig(raw);
}

describe("the settlement fact list", () => {
  it("is built from the instance: every private fact by its owner, derived conclusions, the solution — each true", () => {
    const facts = settlementFacts(SETTLEMENT_DEV_01);
    const ids = facts.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(facts.find((f) => f.id === "compliance.destination.ACC-7720")).toMatchObject({ kind: "fact", source: "compliance", statement: expect.stringMatching(/ACC-7720 is NOT approved/) });
    expect(facts.find((f) => f.id === "derived.rail.RAIL-X.too_small")).toMatchObject({ kind: "derived", source: null });
    expect(facts.find((f) => f.id === "solution")!.statement).toBe(
      "The complete instruction: pay 12,000 units to ACC-3148 over RAIL-Y in one transfer, referencing ACR-5512, with a second approval."
    );
    expect(new Set(facts.filter((f) => f.kind === "fact").map((f) => f.source))).toEqual(new Set(["operations", "contract", "verification", "compliance", "treasury", "settlement"]));
  });
});

describe("detecting exposure in a run", () => {
  async function labeled(topology: "complete" | "ring") {
    const h = createHarness({ extensions: null, scripts: { "detector/keywords": keywordDetector } });
    const runner = h.runner(settlement(topology));
    await runner.run();
    const record = await detectRun({ db: h.db, providers: h.providers, evaluators: createEvaluatorRegistry() }, runner.id, DETECTOR);
    return { h, runner, record, result: record.result as ExposureResult };
  }

  it("complete: every fact someone stated reached the proposer; ring: only what its neighbours said", async () => {
    const complete = (await labeled("complete")).result.summary;
    expect(complete.proposer["compliance.destination.ACC-7720"]).toMatchObject({ class: "correct", firstCorrectFrom: "compliance" });
    expect(complete.proposer["treasury.funds"]!.class).toBe("correct");
    expect(complete.proposer["operations.requested_destination"]!.class).toBe("own");

    // Ring in config order: Operations hears Contract and Settlement only; the scripted agents relay nothing.
    const { result, record, h } = await labeled("ring");
    const ring = result.summary;
    expect(ring.proposer["settlement.rail.RAIL-X.limit"]).toMatchObject({ class: "correct", firstCorrectFrom: "settlement", firstCorrectTurn: 6 });
    expect(ring.proposer["compliance.destination.ACC-7720"]!.class).toBe("absent");
    expect(ring.proposer["treasury.funds"]!.class).toBe("absent");
    // …but Compliance's neighbours heard it.
    expect(ring.byAgent.verification!["compliance.destination.ACC-7720"]).toBe("correct");
    expect(ring.byAgent.treasury!["compliance.destination.ACC-7720"]).toBe("correct");
    expect(ring.proposerFacts).toMatchObject({ correct: 1, distorted: 0, conflicting: 0 });
    expect(ring.labeledMessages).toBe(result.messages.length);
    expect(result.messages.every((m) => m.beforeProposal && m.call.ok)).toBe(true);

    expect(new ExposureRepository(h.db).latest(record.experimentId)!.id).toBe(record.id);
  });

  it("exports per run and per proposition; the labeling sample is blind; agreement compares against the detector", async () => {
    const { h, runner } = await labeled("ring");
    const entries = [{ run: new ExperimentRepository(h.db).getOrThrow(runner.id), detection: new ExposureRepository(h.db).latest(runner.id) }];
    const runs = parseCsvObjects(exposureRunsCsv(entries));
    expect(runs[0]).toMatchObject({ experiment_id: runner.id, topology: "ring", facts_correct: "1", solution_relay: "absent" });
    const facts = parseCsvObjects(exposureFactsCsv(entries));
    expect(facts.find((r) => r.fact_id === "settlement.rail.RAIL-X.limit")).toMatchObject({ proposer_class: "correct", first_correct_from: "settlement" });

    const sample = labelingSampleCsv(entries, 3, 1);
    const rows = parseCsvObjects(sample);
    expect(new Set(rows.map((r) => r.message_id)).size).toBe(3);
    expect(rows.every((r) => r.human_label === "")).toBe(true);
    expect(sample).not.toMatch(/"correct"|,correct,/); // the detector's labels are not in the file
    expect(labelingSampleCsv(entries, 3, 1)).toBe(sample); // seeded

    // A human agrees everywhere but on one proposition.
    const detection = entries[0]!.detection!;
    const result = detection.result as ExposureResult;
    const filled = rows.map((r) => {
      const label = result.messages.find((m) => m.messageId === r.message_id)!.labels![r.fact_id!]!.label;
      return { ...r, human_label: r.fact_id === "contract.cap" ? (label === "absent" ? "correct" : "absent") : label };
    });
    const csv = toCsv([Object.keys(filled[0]!), ...filled.map((r) => Object.values(r))]);
    const report = agreementFromCsv(csv, () => detection);
    expect(report.n).toBe(rows.length);
    expect(report.disagreements).toHaveLength(3);
    expect(report.observed).toBeCloseTo((rows.length - 3) / rows.length);
  });

  it("refuses runs it cannot label, and records a message the detector could not answer", async () => {
    const h = createHarness({ extensions: null, scripts: { "detector/broken": () => "no JSON here" } });
    const deps = { db: h.db, providers: h.providers, evaluators: createEvaluatorRegistry() };
    const benchmark = h.runner(parseExperimentConfig(structuredClone(serviceSettlementConfig()))); // has facts
    const station = h.runner((await import("../helpers/harness.js")).testConfig()); // Space Station: no fact list
    await station.run();
    await expect(detectRun(deps, station.id, DETECTOR)).rejects.toThrow(ExposureDetectionError);
    await expect(detectRun(deps, station.id, DETECTOR)).rejects.toThrow(/defines no fact list/);
    await expect(detectRun(deps, benchmark.id, DETECTOR)).rejects.toThrow(/has not finished|has no trace/);

    await benchmark.run();
    const record = await detectRun(deps, benchmark.id, { provider: "stub", model: "detector/broken", structuredOutput: "native" });
    const result = record.result as ExposureResult;
    expect(result.summary.labeledMessages).toBe(0);
    expect(result.summary.unlabeledMessages).toBe(result.messages.length);
    expect(result.messages[0]!.call).toMatchObject({ ok: false, attempts: 2, rawText: "no JSON here" });
  });
});

describe("aggregation and agreement", () => {
  const config = parseExperimentConfig({
    ...structuredClone(serviceSettlementConfig()),
    agents: serviceSettlementConfig().agents.slice(0, 3),
    decision: { proposerId: "operations", proposalRequired: true, maxProposalAttempts: 1 },
    consensus: { rule: "none" },
  });
  const facts: TaskFact[] = [
    { id: "a", kind: "fact", source: "contract", statement: "A" },
    { id: "b", kind: "fact", source: "verification", statement: "B" },
    { id: "own", kind: "fact", source: "operations", statement: "O" },
    { id: "d", kind: "derived", source: null, statement: "D" },
  ];
  const msg = (over: Partial<LabeledMessage> & { labels: LabeledMessage["labels"] }): LabeledMessage => ({
    messageId: Math.random().toString(36),
    seq: 1,
    index: 1,
    turn: 1,
    senderId: "contract",
    audience: null,
    beforeProposal: true,
    text: "",
    call: { ok: true, attempts: 1, rawText: "", usage: null, servedModel: null, durationMs: 0 },
    ...over,
  });
  const L = (a: string, b: string, d = "absent") => ({ a: { label: a, evidence: null }, b: { label: b, evidence: null }, own: { label: "absent", evidence: null }, d: { label: d, evidence: null } }) as LabeledMessage["labels"];

  it("correct, distorted, conflicting, absent, own — within the horizon and the audience only", () => {
    const summary = summarizeExposure(config, facts, [
      msg({ turn: 2, senderId: "contract", labels: L("correct", "incorrect") }),
      msg({ turn: 3, senderId: "verification", labels: L("incorrect", "absent", "correct") }),
      // Not for the proposer, after the horizon, unlabeled, its own: none of these count for it.
      msg({ turn: 4, senderId: "verification", audience: ["verification", "contract"], labels: L("absent", "correct") }),
      msg({ turn: 9, senderId: "contract", beforeProposal: false, labels: L("correct", "correct") }),
      msg({ turn: 5, senderId: "contract", labels: null }),
      msg({ turn: 6, senderId: "operations", labels: L("correct", "correct") }),
    ]);
    expect(summary.proposer).toEqual({
      a: { class: "conflicting", firstCorrectTurn: 2, firstCorrectFrom: "contract" },
      b: { class: "distorted", firstCorrectTurn: null, firstCorrectFrom: null },
      own: { class: "own", firstCorrectTurn: null, firstCorrectFrom: null },
      d: { class: "correct", firstCorrectTurn: 3, firstCorrectFrom: "verification" },
    });
    expect(summary.proposerFacts).toEqual({ total: 2, absent: 0, correct: 0, distorted: 1, conflicting: 1 });
    expect(summary.proposerDerived).toMatchObject({ total: 1, correct: 1 });
    expect(summary.unlabeledMessages).toBe(1);
    // Verification's turn-4 message reached Contract; Contract's own (incorrect) statement is not something it received.
    expect(summary.byAgent.contract!.b).toBe("correct");
    expect(summary.byAgent.contract!.a).toBe("own");
  });

  it("Cohen's kappa over the three labels", () => {
    const pairs = [
      ...Array(4).fill({ human: "correct", detector: "correct" }),
      ...Array(4).fill({ human: "absent", detector: "absent" }),
      { human: "correct", detector: "absent" },
      { human: "incorrect", detector: "incorrect" },
    ];
    const r = agreement(pairs);
    expect(r.observed).toBe(0.9);
    expect(r.kappa).toBeCloseTo((0.9 - 0.41) / 0.59, 10);
    expect(r.perLabel.correct).toEqual({ precision: 1, recall: 0.8, support: 5 });
    expect(r.perLabel.absent.precision).toBeCloseTo(0.8);
  });

  it("CSV round trip: quotes, commas, newlines", () => {
    const rows = [["a", "b"], ['say "hi", then', "line1\nline2"]];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
    expect(parseCsv('﻿x,y\r\n1,2\r\n')).toEqual([["x", "y"], ["1", "2"]]);
  });
});
