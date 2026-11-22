import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BatchService } from "../../src/batch/service.js";
import { ExperimentService } from "../../src/experiment/service.js";
import { HumanInteractionService } from "../../src/interaction/service.js";
import { ProviderRegistry } from "../../src/llm/registry.js";
import { StubProvider } from "../../src/llm/stubProvider.js";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { PilotLiveRepository } from "../../src/persistence/pilotLiveRepository.js";
import { createEvaluatorRegistry, registerBuiltinStubs } from "../../src/scenarios/index.js";
import { PilotSettlementAdapter, approximateCounter } from "../../src/scenarios/pilotSettlement/adapter.js";
import { estimateSessionUsd, exploratoryRunConfig, LiveDemoService, type LiveModels } from "../../src/scenarios/pilotSettlement/liveDemo.js";
import { createApp } from "../../src/server/app.js";

/**
 * The research demo's live run on the stub provider: the exploratory config, the session's stages
 * (Complete, Ring, detector, done), persistence in the database with cost and outcomes, cancelling,
 * recovery after a restart, and the API. The stub's probe script answers every extraction prompt
 * with PROBE text, so every extraction fails and is recorded as such — the orchestration is what is
 * tested here.
 */

const MODELS: LiveModels = {
  agents: { provider: "stub", model: "pilot-settlement/probe", structuredOutput: "prompt" },
  extraction: { provider: "stub", model: "pilot-settlement/probe", structuredOutput: "prompt" },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function services() {
  const db = createInMemoryDb();
  const providers = new ProviderRegistry([], registerBuiltinStubs(new StubProvider()));
  const evaluators = createEvaluatorRegistry();
  const service = new ExperimentService({ db, providers, evaluators });
  return { db, providers, evaluators, service };
}
async function settled(live: LiveDemoService, id: string, ms = 90_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const s = live.get(id)!;
    if (["done", "failed", "cancelled"].includes(s.stage) && s.finishedAt) return s;
    await sleep(100);
  }
  throw new Error("session did not settle");
}

describe("pilot settlement research demo: the live run", () => {
  it("builds an exploratory config the adapter accepts without the plan's endpoint settings, and prices a session", () => {
    const cfg = exploratoryRunConfig("DEV-02", "ring", { provider: "openrouter", model: "anthropic/claude-haiku-4.5", structuredOutput: "prompt" });
    expect(cfg.protocol?.params.exploratory).toBe(true);
    expect(cfg.agents.every((a) => a.model.provider === "openrouter" && a.model.temperature === 1 && a.model.maxOutputTokens === 2560 && a.model.think === undefined)).toBe(true);
    expect(cfg.communication?.topology.type).toBe("ring");
    expect(new PilotSettlementAdapter(approximateCounter).checkConfig(cfg)).toEqual([]);
    const strict = { ...cfg, protocol: { ...cfg.protocol!, params: { ...cfg.protocol!.params, exploratory: false } } };
    expect(new PilotSettlementAdapter(approximateCounter).checkConfig(strict as typeof cfg).join("\n")).toMatch(/tokenizer|generation settings/);
    const haiku: LiveModels = { agents: { provider: "openrouter", model: "anthropic/claude-haiku-4.5", structuredOutput: "prompt" }, extraction: { provider: "openrouter", model: "anthropic/claude-haiku-4.5", structuredOutput: "native" } };
    expect(estimateSessionUsd(haiku)).toBeGreaterThan(0.2);
    expect(estimateSessionUsd(haiku)).toBeLessThan(0.6);
    expect(estimateSessionUsd(MODELS)).toBeNull(); // the stub has no price
  });

  it("runs Complete, then Ring, then the detector; persists the session with outcomes and cost; hands back the view marked exploratory", async () => {
    const { db, providers, service } = services();
    const live = new LiveDemoService({ db, service, providers });
    const session = live.start("DEV-01", MODELS);
    expect(session.stage).toBe("complete");
    expect(() => live.start("DEV-01", MODELS)).toThrow(/already in progress/);
    const s = await settled(live, session.id);
    expect(s.error).toBeNull();
    expect(s.stage).toBe("done");
    expect(s.runs.complete).toMatchObject({ status: "finished", outcome: "MISSION_FAILURE", correct: false, category: "insufficient" }); // the probe's fixed proposal is wrong for DEV-01
    expect(s.runs.ring.status).toBe("finished");
    expect(s.runs.complete.experimentId).not.toBe(s.runs.ring.experimentId);
    expect(s.detector).toMatchObject({ messages: 36, done: 36, failures: 36 });
    expect(s.cost).toMatchObject({ agentsUsd: 0, detectorUsd: 0, totalUsd: 0 }); // the stub is free; its calls count as unpriced
    expect(s.cost!.unknownCalls).toBeGreaterThan(0);
    expect(s.cost!.tokens.agents).toBeGreaterThanOrEqual(0);
    const v = s.view!;
    expect(v.id).toBe("DEV-01");
    expect(v.runs.complete.calls).toHaveLength(18);
    expect(v.runs.ring.calls[0]!.text).toMatch(/^PROBE/);
    expect(v.runs.complete.validity.status).toBe("exploratory");
    expect(v.runs.ring.validity.detail).toMatch(/n = 1/);
    expect(v.detector!.complete.extraction_failures).toHaveLength(18);
    expect(v.detector!.complete.facts).toHaveLength(10);
    // Persisted: a fresh service over the same database lists it and reads the view back.
    const again = new LiveDemoService({ db, service, providers });
    expect(again.list().map((x) => [x.id, x.stage])).toEqual([[session.id, "done"]]);
    expect(again.list()[0]).not.toHaveProperty("view");
    expect(again.get(session.id)!.view!.runs.ring.validity.status).toBe("exploratory");
    expect(again.list("DEV-02")).toEqual([]);
    // After the first session another can start.
    const second = live.start("DEV-02", MODELS);
    expect(second.id).not.toBe(session.id);
    expect((await settled(live, second.id)).stage).toBe("done");
    expect(live.list().map((x) => x.instance)).toEqual(["DEV-02", "DEV-01"]);
  }, 200_000);

  it("cancels a running session: the current experiment is stopped, nothing further runs, the row says so", async () => {
    const { db, providers, service } = services();
    const live = new LiveDemoService({ db, service, providers });
    const session = live.start("DEV-03", MODELS);
    const deadline = Date.now() + 20_000;
    while (live.get(session.id)!.runs.complete.status !== "running" && Date.now() < deadline) await sleep(20);
    const cancelled = live.cancel(session.id);
    expect(cancelled.stage).toBe("cancelling");
    const s = await settled(live, session.id);
    expect(s.stage).toBe("cancelled");
    expect(s.error).toBe("cancelled by the operator");
    expect(s.runs.ring.status).toBe("pending");
    expect(s.detector).toBeNull();
    expect(s.view ?? null).toBeNull();
    expect(() => live.cancel(session.id)).toThrow(/not running/);
    expect(live.start("DEV-04", MODELS).stage).toBe("complete"); // free again
  }, 60_000);

  it("closes a session another process left running as interrupted, and leaves a live one alone", () => {
    const { db } = services();
    const repo = new PilotLiveRepository(db);
    const row = (id: string, stage: string, ownerId: string | null) => ({ id, instance: "DEV-01", startedAt: "2026-11-22T10:00:00Z", finishedAt: null, stage, ownerId, models: { agents: "m", extraction: "m" }, runs: {}, detector: null, cost: null, error: null, view: null });
    repo.insert(row("gone", "ring", "proc_gone"));
    repo.insert(row("finished", "done", "proc_gone"));
    expect(repo.recoverInterrupted()).toEqual(["gone"]);
    expect(repo.get("gone")).toMatchObject({ stage: "failed", error: "interrupted by a server restart during the ring stage" });
    expect(repo.get("gone")!.finishedAt).not.toBeNull();
    expect(repo.get("finished")!.stage).toBe("done");
    expect(repo.anyRunning()).toBe(false);
  });

  describe("the API", () => {
    let server: ReturnType<typeof createApp>;
    let baseUrl: string;
    beforeAll(async () => {
      const { db, providers, evaluators, service } = services();
      const batches = new BatchService({ db, providers, evaluators, service });
      const interaction = new HumanInteractionService({ db, providers, experiments: service });
      server = createApp({ db, providers, evaluators, service, batches, interaction, pilotDemoLive: MODELS });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const post = (path: string, body: unknown) => fetch(`${baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

    it("offers the live run with an estimate, starts, lists, cancels and reports sessions", async () => {
      const overview = (await (await fetch(`${baseUrl}/api/pilot-demo`)).json()) as { live: { available: boolean; agents: string; estimateUsd: number | null; sessions: unknown[] } };
      expect(overview.live).toMatchObject({ available: true, agents: "pilot-settlement/probe", estimateUsd: null, sessions: [] });
      expect((await post("/api/pilot-demo/live", { instance: "P-01" })).status).toBe(404);
      const started = await post("/api/pilot-demo/live", { instance: "DEV-03" });
      expect(started.status).toBe(202);
      const session = (await started.json()) as { id: string; stage: string };
      expect(session).not.toHaveProperty("view");
      expect((await post("/api/pilot-demo/live", { instance: "DEV-04" })).status).toBe(409);
      const listed = (await (await fetch(`${baseUrl}/api/pilot-demo/live`)).json()) as { sessions: Array<{ id: string; stage: string }> };
      expect(listed.sessions.map((s) => s.id)).toEqual([session.id]);
      const cancelled = await post(`/api/pilot-demo/live/${session.id}/cancel`, {});
      expect(cancelled.status).toBe(200);
      const deadline = Date.now() + 60_000;
      let last: { stage: string; finishedAt: string | null } | null = null;
      while (Date.now() < deadline) {
        last = (await (await fetch(`${baseUrl}/api/pilot-demo/live/${session.id}`)).json()) as typeof last;
        if (last!.finishedAt) break;
        await sleep(200);
      }
      expect(last!.stage).toBe("cancelled");
      expect((await post(`/api/pilot-demo/live/${session.id}/cancel`, {})).status).toBe(409);
      expect(await (await fetch(`${baseUrl}/api/pilot-demo/live/nope`)).status).toBe(404);
      // A whole session, to the view.
      const run = (await (await post("/api/pilot-demo/live", { instance: "DEV-05" })).json()) as { id: string };
      let done: { stage: string; view: { runs: { ring: { validity: { status: string } } } } | null; cost: { totalUsd: number } | null } | null = null;
      while (Date.now() < deadline + 120_000) {
        done = (await (await fetch(`${baseUrl}/api/pilot-demo/live/${run.id}`)).json()) as typeof done;
        if (done!.stage === "done" || done!.stage === "failed") break;
        await sleep(200);
      }
      expect(done!.stage).toBe("done");
      expect(done!.view!.runs.ring.validity.status).toBe("exploratory");
      expect(done!.cost!.totalUsd).toBe(0);
      const all = (await (await fetch(`${baseUrl}/api/pilot-demo/live`)).json()) as { sessions: Array<{ instance: string; stage: string }> };
      expect(all.sessions.map((s) => [s.instance, s.stage])).toEqual([["DEV-05", "done"], ["DEV-03", "cancelled"]]);
    }, 200_000);

    it("refuses the live run when no model is configured for it", async () => {
      const { db, providers, evaluators, service } = services();
      const batches = new BatchService({ db, providers, evaluators, service });
      const interaction = new HumanInteractionService({ db, providers, experiments: service });
      const keyless = createApp({ db, providers, evaluators, service, batches, interaction });
      await new Promise<void>((resolve) => keyless.listen(0, "127.0.0.1", resolve));
      const url = `http://127.0.0.1:${(keyless.address() as AddressInfo).port}`;
      try {
        const overview = (await (await fetch(`${url}/api/pilot-demo`)).json()) as { live: { available: boolean } };
        expect(overview.live.available).toBe(false);
        const r = await fetch(`${url}/api/pilot-demo/live`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instance: "DEV-01" }) });
        expect(r.status).toBe(409);
      } finally {
        await new Promise<void>((resolve) => keyless.close(() => resolve()));
      }
    });
  });
});
