import { describe, expect, it } from "vitest";
import { BatchService } from "../../src/batch/service.js";
import { EventLog } from "../../src/experiment/events.js";
import { ExperimentService } from "../../src/experiment/service.js";
import { EventRepository } from "../../src/persistence/eventRepository.js";
import { createEvaluatorRegistry } from "../../src/scenarios/index.js";
import { createHarness, ofType, testConfig } from "../helpers/harness.js";

const failFinalWrite = (db: ReturnType<typeof createHarness>["db"]) => db.exec(
  "CREATE TEMP TRIGGER fail_final BEFORE UPDATE OF finished_at ON experiments BEGIN SELECT RAISE(ABORT, 'injected terminal failure'); END"
);
const serviceFor = (h: ReturnType<typeof createHarness>) => new ExperimentService({ db: h.db, providers: h.providers, evaluators: createEvaluatorRegistry() });

describe("atomic terminal persistence", () => {
  it("rolls back the final event, phase and row together, and never notifies observers about the rolled-back result", async () => {
    const observed: string[] = [];
    const h = createHarness({ extensions: () => [{ name: "observer", attach(ctx) {
      ctx.subscribe(e => {
        if (e.type === "experiment_finished" || (e.type === "phase_changed" && e.payload.to === "FINISHED")) observed.push(e.type);
      });
    } }] });
    try {
      const runner = h.runner(testConfig());
      failFinalWrite(h.db);
      await expect(runner.run()).rejects.toThrow("injected terminal failure");
      expect(observed).toEqual([]);
      expect(ofType(h.events(runner.id), "experiment_finished")).toEqual([]);
      expect(h.record(runner.id)).toMatchObject({ phase: "EVALUATION", outcome: null, finishedAt: null });
      expect(runner.isFinished()).toBe(false);
      h.db.exec("DROP TRIGGER fail_final");
      const service = serviceFor(h);
      expect(service.recoverInterrupted()).toEqual([runner.id]);
      expect(service.recoverInterrupted()).toEqual([]);
      expect(ofType(h.events(runner.id), "experiment_finished")).toHaveLength(1);
      expect(h.record(runner.id).outcome).toBe("INTERRUPTED");
    } finally { h.db.close(); }
  });

  it("only exposes terminal events after their summary and row are committed", async () => {
    const observations: unknown[] = [];
    const h = createHarness({ extensions: () => [{ name: "observer", attach(ctx) {
      ctx.subscribe(e => {
        if (e.type === "experiment_finished") observations.push(h.record(ctx.experimentId));
      });
    } }] });
    try {
      await h.runner(testConfig()).run();
      expect(observations).toHaveLength(1);
      expect(observations[0]).toMatchObject({ outcome: "SUCCESS", phase: "FINISHED", finishedAt: expect.any(String), summary: { termination: { outcome: "SUCCESS" } } });
    } finally { h.db.close(); }
  });

  it("repairs legacy terminal-event-only rows from the existing result, preserving metrics and timestamp", async () => {
    const h = createHarness({ extensions: null });
    try {
      const runner = h.runner(testConfig());
      const metrics = await runner.run();
      const final = ofType(h.events(runner.id), "experiment_finished")[0]!;
      h.db.prepare("UPDATE experiments SET finished_at = NULL, outcome = NULL, status = NULL, summary_json = NULL WHERE id = ?").run(runner.id);
      const service = serviceFor(h);
      expect(service.recoverInterrupted()).toEqual([runner.id]);
      expect(service.recoverInterrupted()).toEqual([]);
      expect(ofType(h.events(runner.id), "experiment_finished")).toEqual([final]);
      expect(h.record(runner.id)).toMatchObject({ outcome: "SUCCESS", finishedAt: final.ts, summary: metrics });
    } finally { h.db.close(); }
  });

  it("restores the event sequence after rollback and delivers no phantom events", () => {
    const h = createHarness({ extensions: null });
    try {
      const runner = h.runner(testConfig());
      const log = new EventLog(runner.id, new EventRepository(h.db), [], () => null);
      const seen: number[] = [];
      log.subscribe(e => seen.push(e.seq));
      expect(() => log.atomic(() => { log.append("extension_note", { attempt: 1 }); throw new Error("rollback"); })).toThrow("rollback");
      log.append("extension_note", { attempt: 2 });
      expect(seen).toEqual([1]);
      expect(h.events(runner.id)).toHaveLength(1);
      expect(h.events(runner.id)[0]!.payload).toEqual({ attempt: 2 });
    } finally { h.db.close(); }
  });

  it("does not mark a batch completed when terminal persistence fails", async () => {
    const h = createHarness({ extensions: null });
    try {
      const deps = { db: h.db, providers: h.providers, evaluators: createEvaluatorRegistry() };
      const service = new ExperimentService(deps);
      const batches = new BatchService({ ...deps, service });
      failFinalWrite(h.db);
      const batch = batches.start({ name: "write failure", base: { config: testConfig() }, repetitions: 2 });
      await batches.settle(batch.id);
      expect(batches.view(batch.id).batch.status).toBe("interrupted");
      expect(batches.runs(batch.id)).toHaveLength(1);
      h.db.exec("DROP TRIGGER fail_final");
      service.recoverInterrupted();
    } finally { h.db.close(); }
  });
});
