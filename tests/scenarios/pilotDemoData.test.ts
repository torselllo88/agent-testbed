import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BatchService } from "../../src/batch/service.js";
import { ExperimentService } from "../../src/experiment/service.js";
import { HumanInteractionService } from "../../src/interaction/service.js";
import { ProviderRegistry } from "../../src/llm/registry.js";
import { StubProvider } from "../../src/llm/stubProvider.js";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { createEvaluatorRegistry, registerBuiltinStubs } from "../../src/scenarios/index.js";
import { batchSummary, DEMO_DATA_DIR, demoRun, detectorView, instanceOverviews, instanceView, loadDemoDataset, receivedBefore, resetDemoDatasetCache, type DetectorFile } from "../../src/scenarios/pilotSettlement/demoData.js";
import { bundleInstances } from "../../src/scenarios/pilotSettlement/family.js";
import { labelRun, decisionSupport, type Extraction } from "../../src/scenarios/pilotSettlement/detector/postprocess.js";
import { metadata } from "../../src/scenarios/pilotSettlement/task.js";
import { createApp } from "../../src/server/app.js";

/**
 * The research demo's replay dataset: the dev runs shipped in experiments/pilot-settlement/demo/,
 * the derived views (paired runs, what an agent had received, the batch summary) and the API that
 * serves them. The detector's fact view is checked on a synthetic detector output, since the
 * dataset may ship without detector files.
 */

describe("pilot settlement research demo: the replay dataset", () => {
  const ds = loadDemoDataset();

  it("ships the 10 dev instances as Complete/Ring pairs that passed the gates", () => {
    expect(ds.instances).toEqual(Array.from({ length: 10 }, (_, i) => `DEV-${String(i + 1).padStart(2, "0")}`));
    expect(ds.runs.size).toBe(20);
    for (const id of ds.instances) {
      for (const topo of ["COMPLETE", "RING"]) {
        const log = ds.runs.get(`${id}-${topo}`)!;
        expect(log.validity.status).toBe("valid");
        expect(log.calls.filter((c) => c.call_type === "discussion")).toHaveLength(18);
        expect(log.environment_snapshots.every((s) => s.normal)).toBe(true);
        expect(fs.existsSync(path.join(DEMO_DATA_DIR, "dev-runs", `${id}-${topo}.thinking.json`))).toBe(false); // thinking stays out of the repo
      }
    }
  });

  it("derives a run view with the turns, recipients, token counts and the final verdict", () => {
    const run = demoRun(ds.runs.get("DEV-01-RING")!);
    expect(run.topology).toBe("ring");
    expect(run.calls).toHaveLength(18);
    expect(run.calls[0]).toMatchObject({ turn: 1, round: 1, speaker: "Contract" });
    expect(run.calls[0]!.recipients).toHaveLength(2);
    expect(run.calls.every((c) => typeof c.text === "string" || c.text === null)).toBe(true);
    expect(run.final.correct).toBe(true);
    expect(run.final.canonical).toEqual({ action: "execute", destination: "D2", rail: "A", reason: null });
    expect(run.neighbours.Operations).toHaveLength(2);
    expect(run.stats.messages + run.stats.silent_turns).toBe(18);
    expect(run.stats.prompt_tokens_max).toBeGreaterThan(500);
    // What Operations had received before its first turn: only what its two neighbours sent so far, none of its own.
    const opsTurn = run.calls.find((c) => c.speaker === "Operations")!.turn;
    const seen = receivedBefore(run, "Operations", opsTurn);
    expect(seen.every((c) => c.recipients.includes("Operations"))).toBe(true);
    expect(seen.length).toBeLessThanOrEqual(opsTurn - 1);
    const complete = demoRun(ds.runs.get("DEV-01-COMPLETE")!);
    expect(receivedBefore(complete, "Operations", opsTurn)).toHaveLength(opsTurn - 1); // the complete graph delivers everything
  });

  it("summarises the batch: pair transitions, classes, per-topology technical context", () => {
    const b = batchSummary(ds);
    expect(b.pairs).toBe(10);
    expect(b.transitions.both_correct + b.transitions.complete_only + b.transitions.ring_only + b.transitions.both_incorrect).toBe(10);
    expect(Object.values(b.by_class).reduce((n, c) => n + c.n, 0)).toBe(10);
    expect(b.per_topology.complete.runs).toBe(10);
    expect(b.per_topology.ring.calls).toBe(190);
    expect(b.per_topology.ring.message_tokens_median).toBeGreaterThan(0);
    expect(b.environment).toEqual({ snapshots: 60, snapshots_normal: 60, deviations: 0 });
    const overviews = instanceOverviews(ds);
    expect(overviews).toHaveLength(10);
    expect(overviews[0]).toMatchObject({ id: "DEV-01", class: "A", requested: "D2" });
    const view = instanceView(ds, "DEV-03")!;
    expect(view.runs.complete.run_id).toBe("DEV-03-COMPLETE");
    expect(view.facts).toHaveLength(10);
    expect(view.role_cards.Operations).toBe("You hold no private task information.");
    expect(instanceView(ds, "P-01")).toBeNull();
  });

  it("follows a fact through the graph from a detector output: path, exposure turn, stop", () => {
    const state = bundleInstances()["DEV-01"]!.state;
    const fact = (span: string, role: string, objs: unknown[], extra: Record<string, unknown> = {}) => ({ span, kind: "fact", hedged: false, role_named: role, first_person: false, relay_marker: false, predicate: null, polarity: "positive", objects: objs, exhaustive: false, scope_destination: null, status_value: null, derived: null, proposal: null, ...extra });
    const d2 = [{ type: "destination", destination: "D2", rail: null }];
    // Ring DEV-01: Contract → (Settlement, Compliance); Settlement → (Operations, Contract); Compliance → (Contract, Verification).
    const messages = [
      { turn: 1, speaker: "Contract" as const, recipients: ["Settlement", "Compliance"] as const, text: "" },
      { turn: 2, speaker: "Settlement" as const, recipients: ["Operations", "Contract"] as const, text: "" },
      { turn: 3, speaker: "Compliance" as const, recipients: ["Contract", "Verification"] as const, text: "" },
    ].map((m) => ({ ...m, recipients: [...m.recipients] }));
    const extractions: Record<number, Extraction> = {
      1: { items: [fact("Contract permits D2.", "Contract", d2)] as Extraction["items"] },
      2: { items: [fact("Contract permits D2.", "Contract", d2), fact("I think D1 / Rail B is supported.", "Settlement", [{ type: "route", destination: "D1", rail: "B" }], { hedged: true })] as Extraction["items"] },
      3: { items: [fact("Compliance authorizes D2.", "Compliance", d2)] as Extraction["items"] },
    };
    const claims = labelRun(state, messages, extractions);
    const output: DetectorFile = { run_id: "DEV-01-RING", detector_version: "t", extraction_model: "m", claims, operations: decisionSupport(state, metadata(state).minimal_fact_sets, claims, true), extraction_failures: [] };
    const view = detectorView(output, state);
    const permitsD2 = view.facts.find((f) => f.fact === "contract.permits.D2")!;
    expect(permitsD2).toMatchObject({ holder: "Contract", exposure: "correct", exposed_at: 2, stated_at: 1, stop: null });
    expect(permitsD2.chain.map((s) => [s.turn, s.sender, s.source, s.support])).toEqual([
      [1, "Contract", "own", "supported"],
      [2, "Settlement", "relayed", "supported"],
    ]);
    const authorizesD2 = view.facts.find((f) => f.fact === "compliance.authorizes.D2")!;
    expect(authorizesD2).toMatchObject({ exposure: "absent", exposed_at: null, stated_at: 3, received_not_relayed: ["Contract", "Verification"] });
    expect(authorizesD2.stop).toBe("received by Contract, Verification and not passed on");
    const route = view.facts.find((f) => f.fact === "settlement.supports.D1.B")!;
    expect(route).toMatchObject({ exposure: "absent", stated_at: null }); // hedged: not a statement that counts
    expect(route.chain[0]!.hedged).toBe(true);
    const never = view.facts.find((f) => f.fact === "treasury.status")!;
    expect(never.stop).toBe("never stated by Treasury");
    expect(view.category).toBe("insufficient");
  });
});

describe("pilot settlement research demo: the API", () => {
  let server: ReturnType<typeof createApp>;
  let baseUrl: string;
  let emptyDir: string;
  beforeAll(async () => {
    const db = createInMemoryDb();
    const providers = new ProviderRegistry([], registerBuiltinStubs(new StubProvider()));
    const evaluators = createEvaluatorRegistry();
    const service = new ExperimentService({ db, providers, evaluators });
    const batches = new BatchService({ db, providers, evaluators, service });
    const interaction = new HumanInteractionService({ db, providers, experiments: service });
    server = createApp({ db, providers, evaluators, service, batches, interaction });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-demo-empty-"));
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(emptyDir, { recursive: true, force: true });
    resetDemoDatasetCache();
  });

  it("serves the overview, the batch summary, the methods and one instance's pair", async () => {
    const overview = (await (await fetch(`${baseUrl}/api/pilot-demo`)).json()) as { available: boolean; instances: Array<{ id: string }>; batch: { pairs: number }; methods: { gates: unknown[] } };
    expect(overview.available).toBe(true);
    expect(overview.instances.map((i) => i.id)).toContain("DEV-07");
    expect(overview.batch.pairs).toBe(10);
    expect(overview.methods.gates).toHaveLength(6);
    const view = (await (await fetch(`${baseUrl}/api/pilot-demo/instances/DEV-07`)).json()) as { runs: { complete: { calls: unknown[] }; ring: { calls: unknown[] } }; detector: unknown };
    expect(view.runs.complete.calls).toHaveLength(18);
    expect(view.runs.ring.calls).toHaveLength(18);
    expect(await (await fetch(`${baseUrl}/api/pilot-demo/instances/P-01`)).status).toBe(404);
  });

  it("says so when no dataset is installed", async () => {
    const ds = loadDemoDataset(emptyDir);
    expect(ds.instances).toEqual([]);
    expect(batchSummary(ds).pairs).toBe(0);
  });
});
