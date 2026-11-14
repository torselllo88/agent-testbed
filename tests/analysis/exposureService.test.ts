import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { ExposureConflictError, ExposureService } from "../../src/analysis/exposureService.js";
import type { ExposureResult } from "../../src/analysis/exposure.js";
import { BatchService } from "../../src/batch/service.js";
import { ExperimentService } from "../../src/experiment/service.js";
import { HumanInteractionService } from "../../src/interaction/service.js";
import { ProviderRegistry } from "../../src/llm/registry.js";
import { StubProvider } from "../../src/llm/stubProvider.js";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { ExposureRepository } from "../../src/persistence/exposureRepository.js";
import { createEvaluatorRegistry, registerBuiltinStubs } from "../../src/scenarios/index.js";
import { createApp } from "../../src/server/app.js";

/** Exposure in the web UI: the labeling job, summaries, manual labeling and agreement. */

const DETECTOR = { provider: "stub", model: "detector/keywords", structuredOutput: "native" };

async function setup() {
  const db = createInMemoryDb();
  const providers = new ProviderRegistry([], registerBuiltinStubs(new StubProvider()));
  const evaluators = createEvaluatorRegistry();
  const service = new ExperimentService({ db, providers, evaluators });
  const batches = new BatchService({ db, providers, evaluators, service });
  const batch = batches.start({
    name: "graphs",
    base: { builtin: "service-settlement" },
    repetitions: 1,
    variables: [
      { path: "communication", label: "graph", values: [{ topology: { type: "complete" } }, { topology: { type: "ring" } }] },
      { path: "consensus", values: [{ rule: "none" }] },
    ],
  });
  await batches.settle(batch.id);
  const exposure = new ExposureService({ db, providers, evaluators });
  return { db, providers, evaluators, service, batches, batchId: batch.id, exposure };
}

describe("the labeling job", () => {
  it("labels every finished run of a batch, skips them the next time, and summarizes by condition", async () => {
    const { exposure, batchId, db, batches } = await setup();
    const job = exposure.start({ batchId }, DETECTOR);
    expect(job).toMatchObject({ status: "running", runsTotal: 2 });
    expect(() => exposure.start({ batchId }, DETECTOR)).toThrow(ExposureConflictError);
    await exposure.settle();
    expect(exposure.status()).toMatchObject({ status: "completed", labeled: 2, skipped: 0, failed: [], runsDone: 2, current: null });

    exposure.start({ batchId }, DETECTOR);
    await exposure.settle();
    expect(exposure.status()).toMatchObject({ status: "completed", labeled: 0, skipped: 2 });

    const view = exposure.batchExposure(batchId);
    expect(view).toMatchObject({ runs: 2, labeled: 2, models: ["stub/detector/keywords"] });
    const [complete, ring] = view.conditions;
    expect(complete!.key).toMatch(/complete/);
    // The keyword stub finds the ids each function names; in a ring fewer of them reach Operations.
    expect(complete!.factsCorrect!).toBeGreaterThan(ring!.factsCorrect!);
    // Only Work Verification names ACR-5512 and ACR-5390, and it is not Operations' neighbour in the ring.
    expect(complete!.bySource.verification).toEqual({ total: 2, correct: 2 });
    expect(ring!.bySource.verification).toEqual({ total: 2, correct: 0 });

    const run = batches.runs(batchId)[0]!;
    const { latest, passes } = exposure.runExposure(run.id);
    expect(passes).toHaveLength(1);
    expect((latest!.result as ExposureResult).messages.length).toBeGreaterThan(0);
    expect(new ExposureRepository(db).list(run.id)).toHaveLength(1);
  });

  it("can be cancelled — nothing is stored for the run it stopped in; refuses what it cannot do", async () => {
    const { exposure, batchId, batches, db } = await setup();
    exposure.start({ batchId }, DETECTOR);
    expect(exposure.cancel()).toBe(true);
    await exposure.settle();
    expect(exposure.status()!.status).toBe("cancelled");
    for (const run of batches.runs(batchId)) expect(new ExposureRepository(db).list(run.id)).toHaveLength(0);
    expect(exposure.cancel()).toBe(false);

    expect(() => exposure.start({ batchId }, { provider: "openrouter", model: "x/y" })).toThrow(/not configured/);
    expect(() => exposure.start({ batchId: "nope" }, DETECTOR)).toThrow(/No finished runs/);
    expect(() => exposure.start({}, DETECTOR)).toThrow(/which batch or experiment/);
  });
});

describe("manual labeling", () => {
  it("a seeded sample; blind items; every proposition required; agreement between people and with the detector", async () => {
    const { exposure, batchId } = await setup();
    const sample = exposure.createSample(batchId, 3, 7, "pilot check");
    expect(sample.items).toHaveLength(3);
    expect(exposure.createSample(batchId, 3, 7).items).toEqual(sample.items); // same seed, same messages

    const view = exposure.sampleForAnnotator(sample.id, "ana");
    expect(view.items).toHaveLength(3);
    const item = view.items[0]!;
    expect(item.facts.length).toBeGreaterThan(10);
    expect(item.labels).toEqual({});
    expect(item.text).not.toBe("(message not found)");

    const allAbsent = Object.fromEntries(item.facts.map((f) => [f.id, "absent"]));
    expect(() => exposure.saveAnnotation(sample.id, { annotator: "ana", experimentId: item.experimentId, messageId: item.messageId, labels: { [item.facts[0]!.id]: "absent" } })).toThrow(
      /Label every proposition/
    );
    expect(() => exposure.saveAnnotation(sample.id, { annotator: " ", experimentId: item.experimentId, messageId: item.messageId, labels: allAbsent })).toThrow(/Give your name/);

    exposure.saveAnnotation(sample.id, { annotator: "ana", experimentId: item.experimentId, messageId: item.messageId, labels: allAbsent });
    const otherLabels = { ...allAbsent, [item.facts[0]!.id]: "correct" };
    exposure.saveAnnotation(sample.id, { annotator: "boris", experimentId: item.experimentId, messageId: item.messageId, labels: otherLabels });
    // Saving again replaces.
    exposure.saveAnnotation(sample.id, { annotator: "ana", experimentId: item.experimentId, messageId: item.messageId, labels: allAbsent });
    expect(exposure.sampleForAnnotator(sample.id, "ana").items[0]!.labels).toEqual(allAbsent);

    expect(exposure.samples(batchId).find((s) => s.id === sample.id)).toMatchObject({ name: "pilot check", items: 3, annotators: [{ name: "ana", messages: 1 }, { name: "boris", messages: 1 }] });

    // Before any detector pass: people agree with each other; nothing to compare the detector with.
    let report = exposure.agreement(sample.id);
    expect(report.annotators).toEqual(["ana", "boris"]);
    expect(report.pairs[0]).toMatchObject({ a: "ana", b: "boris", n: item.facts.length });
    expect(report.pairs[0]!.observed).toBeCloseTo((item.facts.length - 1) / item.facts.length);
    expect(report.detector[0]).toMatchObject({ annotator: "ana", n: 0, unmatched: item.facts.length });

    exposure.start({ batchId }, DETECTOR);
    await exposure.settle();
    report = exposure.agreement(sample.id);
    expect(report.detector[0]).toMatchObject({ annotator: "ana", n: item.facts.length, unmatched: 0 });

    const csv = exposure.annotationsCsv(sample.id).trim().split("\n");
    expect(csv[0]).toBe("sample_id,annotator,experiment_id,message_id,fact_id,label,updated_at");
    expect(csv).toHaveLength(1 + 2 * item.facts.length);
  });
});

describe("exposure API", () => {
  it("starts and reports a job, serves summaries, samples, annotations and agreement", async () => {
    const { db, providers, evaluators, service, batches, batchId } = await setup();
    const interaction = new HumanInteractionService({ db, providers, experiments: service });
    const server = createApp({ db, providers, evaluators, service, batches, interaction });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
    };
    try {
      expect((await call("GET", "/api/exposure")).body).toMatchObject({ job: null, busy: { runningExperiments: 0 } });
      expect((await call("POST", "/api/exposure/label", { batchId, model: { provider: "stub" } })).status).toBe(400);
      expect((await call("POST", "/api/exposure/label", { batchId, model: DETECTOR })).status).toBe(202);
      for (let i = 0; i < 100 && (await call("GET", "/api/exposure")).body.job.status === "running"; i++) await new Promise((r) => setTimeout(r, 20));
      expect((await call("GET", "/api/exposure")).body.job).toMatchObject({ status: "completed", labeled: 2 });

      const summary = (await call("GET", `/api/batches/${batchId}/exposure`)).body;
      expect(summary).toMatchObject({ runs: 2, labeled: 2, samples: [] });
      const csv = (await call("GET", `/api/batches/${batchId}/exposure/export?kind=facts`)).body as string;
      expect(csv.split("\n")[0]).toContain("proposer_class");
      const runId = batches.runs(batchId)[0]!.id;
      expect((await call("GET", `/api/experiments/${runId}/exposure`)).body.passes).toHaveLength(1);

      const { sample } = (await call("POST", `/api/batches/${batchId}/exposure/samples`, { n: 2, seed: 1 })).body;
      const items = (await call("GET", `/api/exposure/samples/${sample.id}?annotator=ana`)).body.items;
      expect(JSON.stringify(items)).not.toContain('"detector"');
      const labels = Object.fromEntries(items[0].facts.map((f: { id: string }) => [f.id, "absent"]));
      expect((await call("PUT", `/api/exposure/samples/${sample.id}/annotations`, { annotator: "ana", experimentId: items[0].experimentId, messageId: items[0].messageId, labels })).status).toBe(200);
      expect((await call("PUT", `/api/exposure/samples/${sample.id}/annotations`, { annotator: "ana", experimentId: items[0].experimentId, messageId: items[0].messageId, labels: {} })).status).toBe(409);
      expect((await call("GET", `/api/exposure/samples/${sample.id}/agreement`)).body.detector[0]).toMatchObject({ annotator: "ana" });
      expect(((await call("GET", `/api/exposure/samples/${sample.id}/annotations.csv`)).body as string).split("\n")[0]).toContain("annotator");
      expect((await call("GET", `/api/exposure/samples/nope`)).status).toBe(409);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
