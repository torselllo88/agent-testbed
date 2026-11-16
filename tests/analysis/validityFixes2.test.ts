import { afterEach, describe, expect, it } from "vitest";
import { detectRun, evidenceInMessage, type ExposureResult } from "../../src/analysis/exposure.js";
import { detectorInstrument, LABELING_HEADER, stratifiedDraw } from "../../src/analysis/exposureReport.js";
import { ExposureConflictError, ExposureService } from "../../src/analysis/exposureService.js";
import { BatchService } from "../../src/batch/service.js";
import { getTestbedVersion } from "../../src/config/version.js";
import { configHash, parseExperimentConfig } from "../../src/experiment/config.js";
import { renderSystemPrompt } from "../../src/experiment/protocol.js";
import { ExperimentRunner } from "../../src/experiment/runner.js";
import { ExperimentService } from "../../src/experiment/service.js";
import type { CompletionRequest } from "../../src/llm/provider.js";
import { OllamaProvider } from "../../src/llm/ollamaProvider.js";
import { ProviderRegistry } from "../../src/llm/registry.js";
import { StubProvider } from "../../src/llm/stubProvider.js";
import { keywordExposureDetector } from "../../src/llm/stubRouters.js";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { ExperimentRepository } from "../../src/persistence/experimentRepository.js";
import { createEvaluatorRegistry, registerBuiltinStubs } from "../../src/scenarios/index.js";
import { serviceSettlementConfig } from "../../src/scenarios/serviceSettlement/config.js";
import { spaceStationConfig } from "../../src/scenarios/spaceStation/config.js";
import { FAKE_OLLAMA_MODELS, startFakeOllamaServer, type FakeOllamaServer } from "../helpers/fakeOllamaServer.js";

/** Fixes from the second validity audit: conditions may differ only in delivery, and the measures must not depend on anything else. */

const servers: FakeOllamaServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

function settlement(mutate: (c: Record<string, any>) => void = () => {}) {
  const raw = structuredClone(serviceSettlementConfig()) as Record<string, any>;
  raw.runtime.providerRetryDelayMs = 0;
  raw.consensus = { rule: "none" };
  mutate(raw);
  return parseExperimentConfig(raw);
}

function setup(extraStubs: Record<string, (req: CompletionRequest) => string> = {}) {
  const db = createInMemoryDb();
  const stub = registerBuiltinStubs(new StubProvider());
  for (const [name, fn] of Object.entries(extraStubs)) stub.register(name, fn);
  const providers = new ProviderRegistry([], stub);
  const evaluators = createEvaluatorRegistry();
  const batches = new BatchService({ db, providers, evaluators, service: new ExperimentService({ db, providers, evaluators }) });
  return { db, providers, evaluators, batches, exposure: new ExposureService({ db, providers, evaluators }) };
}

const PAIRED = {
  name: "pairs",
  base: { builtin: "service-settlement" },
  repetitions: 1,
  variables: [
    { path: "$instance", label: "instance", values: ["dev-01", { id: "dev-01b", seed: 7, params: (serviceSettlementConfig().evaluator.params as object) }] },
    { path: "communication", label: "graph", values: [{ topology: { type: "complete" } }, { topology: { type: "ring" } }] },
    { path: "consensus", values: [{ rule: "none" }] },
  ],
};

describe("one protocol for every condition of a fixed-rounds design", () => {
  it("complete and ring get the same conciseness rule; the default protocol keeps its own", () => {
    const complete = settlement();
    const ring = settlement((c) => (c.communication = { topology: { type: "ring" } }));
    for (const config of [complete, ring]) {
      const prompt = renderSystemPrompt(config, config.agents[0]!);
      expect(prompt).toContain("- Be concise.");
      expect(prompt).not.toContain("Do not repeat information");
    }
    const plain = settlement((c) => delete c.discussion);
    expect(renderSystemPrompt(plain, plain.agents[0]!)).toContain("Do not repeat information that has already been established.");
  });
});

describe("the detector (v2)", () => {
  it("accepts a claim only with a quote that is in the message", () => {
    expect(evidenceInMessage("ACC-7720 is still pending", "Note: acc-7720  is still pending verification.")).toBe(true);
    expect(evidenceInMessage("“RAIL-X caps a transfer at 10,000.”", "RAIL-X caps a transfer at 10,000, so…")).toBe(true);
    // Formatting does not matter; words do.
    expect(evidenceInMessage("ACC-7720 is still pending", "**ACC-7720** is still pending verification.")).toBe(true);
    expect(evidenceInMessage("RAIL-X - capped at 10,000", "RAIL-X — capped at 10,000")).toBe(true);
    expect(evidenceInMessage("ACC-7720: pending, RAIL-X: 10,000", "- ACC-7720: pending\n- RAIL-X: 10,000")).toBe(true);
    // Not a quote: stitched pieces, a different number, a single word, words not adjacent in the message.
    expect(evidenceInMessage("RAIL-X caps … 10,000", "RAIL-X caps a transfer at 10,000")).toBe(false);
    expect(evidenceInMessage("ACC-7720 … approved", "ACC-7720 is pending; ACC-7721 was approved.")).toBe(false);
    expect(evidenceInMessage("caps at 10,000", "caps at 10,000,000")).toBe(false);
    expect(evidenceInMessage("pending", "Is ACC-7720 still pending?")).toBe(false);
    expect(evidenceInMessage("ACC-7720 pending", "ACC-7720 is pending")).toBe(false);
    expect(evidenceInMessage("ACC-7720 is approved", "ACC-7720 is still pending")).toBe(false);
    expect(evidenceInMessage(null, "anything")).toBe(false);
    expect(evidenceInMessage("", "anything")).toBe(false);
  });

  it("does not show who wrote a message, and keeps a claim without its quote as absent (unverified)", async () => {
    const prompts: string[] = [];
    const s = setup({
      "detector/guessing": (req) => {
        prompts.push(req.messages.map((m) => m.content).join("\n"));
        const ids = req.context!.factIds as string[];
        const text = String(req.context!.messageText);
        // One claim with a real quote, one invented.
        return JSON.stringify({
          labels: Object.fromEntries(
            ids.map((id, i) => [id, i === 0 ? { label: "correct", evidence: text.split(/\s+/).slice(0, 3).join(" ") } : i === 1 ? { label: "correct", evidence: "words that are nowhere" } : { label: "absent", evidence: null }])
          ),
        });
      },
    });
    const runner = new ExperimentRunner({ db: s.db, providers: s.providers, evaluators: s.evaluators }, settlement());
    await runner.run();
    const record = await detectRun({ db: s.db, providers: s.providers, evaluators: s.evaluators }, runner.id, { provider: "stub", model: "detector/guessing", structuredOutput: "native" });
    const result = record.result as ExposureResult;
    expect(record.detectorVersion).toBe("2");
    const [first, second] = result.facts.map((f) => f.id);
    const labels = result.messages[0]!.labels!;
    expect(labels[first!]!.label).toBe("correct");
    expect(labels[second!]).toEqual({ label: "absent", evidence: "words that are nowhere", unverified: "correct" });
    expect(result.summary.unverifiedLabels).toBe(result.messages.length);
    expect(prompts[0]).toContain("MESSAGE from a participant:");
    for (const agent of serviceSettlementConfig().agents) expect(prompts.every((p) => !p.includes(`${agent.name} (`))).toBe(true);
  });
});

describe("validation and summaries", () => {
  it("samples spread over conditions", () => {
    const pool = [...Array(10)].map((_, i) => ({ condition: "A", key: `a${i}` })).concat([{ condition: "B", key: "b1" }, { condition: "B", key: "b0" }]);
    // Conditions in seeded order (by their first draw): a0 < b0.
    expect(stratifiedDraw(pool, 4).map((x) => x.key)).toEqual(["a0", "b0", "a1", "b1"]);
    expect(stratifiedDraw(pool, 6).filter((x) => x.condition === "B")).toHaveLength(2);
    expect(stratifiedDraw(pool, 6)).toHaveLength(6);
  });

  it("agreement per condition; mixed detector instruments are reported; pairs carry one key", async () => {
    const s = setup({ "detector/keywords-b": keywordExposureDetector });
    const batch = s.batches.start(PAIRED);
    await s.batches.settle(batch.id);

    s.exposure.start({ batchId: batch.id }, { provider: "stub", model: "detector/keywords", structuredOutput: "native" });
    await s.exposure.settle();
    const sample = s.exposure.createSample(batch.id, 4, 1);
    const conditions = new Set(sample.items.map((i) => new ExperimentRepository(s.db).getOrThrow(i.experimentId).conditionKey));
    expect(conditions.size).toBe(4); // 4 conditions × 1 message each
    for (const item of s.exposure.sampleForAnnotator(sample.id, "ana").items) {
      s.exposure.saveAnnotation(sample.id, { annotator: "ana", experimentId: item.experimentId, messageId: item.messageId, labels: Object.fromEntries(item.facts.map((f) => [f.id, "absent"])) });
    }
    expect(Object.keys(s.exposure.agreement(sample.id).detector[0]!.byCondition)).toHaveLength(4);

    expect(s.exposure.batchExposure(batch.id).instruments).toHaveLength(1);
    expect(s.exposure.batchExposure(batch.id).instruments[0]).toMatch(/^v2 stub\/detector\/keywords#[0-9a-f]{8}$/);
    const byCondition = s.exposure.agreement(sample.id).detector[0]!.byCondition;
    expect(Object.values(byCondition).every((c) => c.perLabel.correct !== undefined)).toBe(true);
    const one = s.batches.runs(batch.id)[0]!;
    s.exposure.start({ experimentId: one.id }, { provider: "stub", model: "detector/keywords-b", structuredOutput: "native" }, true);
    await s.exposure.settle();
    expect(s.exposure.batchExposure(batch.id).instruments).toHaveLength(2);

    const [header, ...rows] = s.batches.csv(batch.id).trim().split("\n").map((l) => l.split(","));
    const col = (r: string[], n: string) => r[header!.indexOf(n)]!;
    const keys = new Map<string, Set<string>>();
    for (const r of rows) (keys.get(col(r, "var:instance")) ?? keys.set(col(r, "var:instance"), new Set()).get(col(r, "var:instance"))!).add(col(r, "pair_key"));
    expect([...keys.values()].map((k) => k.size)).toEqual([1, 1]);
    expect(new Set([...keys.values()].map((k) => [...k][0])).size).toBe(2);
  });

  it("waits while experiments are running — also ones started after the job — unless told otherwise", async () => {
    const s = setup();
    const exposure = new ExposureService({ db: s.db, providers: s.providers, evaluators: s.evaluators, pollMs: 10 });
    const batch = s.batches.start({ ...PAIRED, variables: PAIRED.variables.slice(1) });
    await s.batches.settle(batch.id);
    const config = settlement();
    const repo = new ExperimentRepository(s.db);
    repo.create({ id: "live-run", config, configHash: configHash(config), testbedVersion: getTestbedVersion() });
    expect(exposure.runningExperiments()).toBe(1);
    exposure.start({ batchId: batch.id }, { provider: "stub", model: "detector/keywords", structuredOutput: "native" });
    await new Promise((r) => setTimeout(r, 50));
    expect(exposure.status()).toMatchObject({ status: "running", waitingFor: 1, labeled: 0 });
    repo.update("live-run", { finishedAt: new Date().toISOString() });
    await exposure.settle();
    expect(exposure.status()).toMatchObject({ status: "completed", waitingFor: 0, labeled: 2 });

    // whileBusy: labels at once.
    repo.create({ id: "live-run-2", config, configHash: configHash(config), testbedVersion: getTestbedVersion() });
    exposure.start({ batchId: batch.id }, { provider: "stub", model: "detector/keywords", structuredOutput: "native" }, true, true);
    await exposure.settle();
    expect(exposure.status()).toMatchObject({ status: "completed", labeled: 2, whileBusy: true });
    expect(() => exposure.start({}, { provider: "stub", model: "detector/keywords" })).toThrow(ExposureConflictError);
  });

  it("pairs: one key per task, seed and repetition; broken pairs are counted; instruments include their settings", async () => {
    const s = setup();
    const batch = s.batches.start({ ...PAIRED, repetitions: 2 });
    await s.batches.settle(batch.id);
    const [header, ...rows] = s.batches.csv(batch.id).trim().split("\n").map((l) => l.split(","));
    const col = (r: string[], n: string) => r[header!.indexOf(n)]!;
    const byKey = new Map<string, string[]>();
    for (const r of rows) (byKey.get(col(r, "pair_key")) ?? byKey.set(col(r, "pair_key"), []).get(col(r, "pair_key"))!).push(col(r, "var:graph"));
    expect(byKey.size).toBe(4); // 2 instances × 2 repetitions
    expect([...byKey.values()].every((g) => g.length === 2 && g[0] !== g[1])).toBe(true);
    expect(s.batches.view(batch.id).pairs).toEqual({ groups: 4, broken: 0 });
    // One run of a pair aborted: that pair is broken.
    new ExperimentRepository(s.db).update(s.batches.runs(batch.id)[0]!.id, { status: "ABORTED", outcome: "TIMEOUT" });
    expect(s.batches.view(batch.id).pairs).toEqual({ groups: 4, broken: 1 });

    expect(detectorInstrument({ detectorVersion: "2", model: { provider: "stub", model: "m", temperature: 0 } })).not.toBe(
      detectorInstrument({ detectorVersion: "2", model: { provider: "stub", model: "m", temperature: 0.7 } })
    );
  });

  it("annotators do not see who wrote a message", async () => {
    const s = setup();
    const batch = s.batches.start({ ...PAIRED, variables: PAIRED.variables.slice(1) });
    await s.batches.settle(batch.id);
    const sample = s.exposure.createSample(batch.id, 2, 1);
    const view = s.exposure.sampleForAnnotator(sample.id, "ana");
    expect(view.items.every((i) => !("sender" in i))).toBe(true);
    expect(LABELING_HEADER).not.toContain("sender");
  });
});

describe("length artifacts on a self-hosted model", () => {
  it("checks overflow against the window the model is served with when none is set, and records the digest", async () => {
    const server = await startFakeOllamaServer();
    servers.push(server);
    const provider = new OllamaProvider({ name: "lab-ollama", baseUrl: server.url });
    // No contextLength: the fake serves the default 4096 tokens — a ~6000-token prompt cannot fit.
    const result = await provider.complete({ model: FAKE_OLLAMA_MODELS[0]!, messages: [{ role: "user", content: "x".repeat(24_000) }] });
    expect(result.providerMeta).toMatchObject({ contextLength: null, contextOverflowSuspected: true, serving: { contextLength: 4096, digest: "sha256-fake-digest" } });
  });

  it("counts calls cut at the output-token limit", async () => {
    const server = await startFakeOllamaServer();
    servers.push(server);
    server.respondWith({ extra: { done_reason: "length" } });
    const db = createInMemoryDb();
    const providers = new ProviderRegistry([new OllamaProvider({ name: "lab-ollama", baseUrl: server.url })], registerBuiltinStubs(new StubProvider()));
    const config = spaceStationConfig();
    config.runtime.providerRetryDelayMs = 0;
    config.scheduler = { type: "round_robin", startAgentId: "operations" };
    for (const agent of config.agents) agent.model = { provider: "openai-compatible", endpoint: "lab-ollama", model: FAKE_OLLAMA_MODELS[0]!, structuredOutput: "native", maxOutputTokens: 300 };
    const metrics = await new ExperimentRunner({ db, providers, evaluators: createEvaluatorRegistry() }, config).run();
    expect(metrics.llmCalls.cutAtOutputCap).toBe(1);
  });
});
