import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BatchService } from "../../src/batch/service.js";
import { ExperimentService } from "../../src/experiment/service.js";
import { HumanInteractionService } from "../../src/interaction/service.js";
import { ProviderRegistry } from "../../src/llm/registry.js";
import { StubProvider } from "../../src/llm/stubProvider.js";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { createEvaluatorRegistry, registerBuiltinStubs } from "../../src/scenarios/index.js";
import { PilotSettlementAdapter, approximateCounter } from "../../src/scenarios/pilotSettlement/adapter.js";
import { exploratoryRunConfig, LiveDemoService, type LiveModels } from "../../src/scenarios/pilotSettlement/liveDemo.js";
import { createApp } from "../../src/server/app.js";

/**
 * The research demo's live run on the stub provider: the exploratory config, the session's stages
 * (Complete, Ring, detector, done), the replay-shaped view with its exploratory validity, and the API.
 * The stub's probe script answers every extraction prompt with PROBE text, so every extraction fails
 * and is recorded as such — the orchestration is what is tested here.
 */

const MODELS: LiveModels = {
  agents: { provider: "stub", model: "pilot-settlement/probe", structuredOutput: "prompt" },
  extraction: { provider: "stub", model: "pilot-settlement/probe", structuredOutput: "prompt" },
};

function services() {
  const db = createInMemoryDb();
  const providers = new ProviderRegistry([], registerBuiltinStubs(new StubProvider()));
  const evaluators = createEvaluatorRegistry();
  const service = new ExperimentService({ db, providers, evaluators });
  return { db, providers, evaluators, service };
}

describe("pilot settlement research demo: the live run", () => {
  it("builds an exploratory config the adapter accepts without the plan's endpoint settings", () => {
    const cfg = exploratoryRunConfig("DEV-02", "ring", { provider: "openrouter", model: "anthropic/claude-haiku-4.5", structuredOutput: "prompt" });
    expect(cfg.protocol?.params.exploratory).toBe(true);
    expect(cfg.agents.every((a) => a.model.provider === "openrouter" && a.model.temperature === 1 && a.model.maxOutputTokens === 2560 && a.model.think === undefined)).toBe(true);
    expect(cfg.communication?.topology.type).toBe("ring");
    // The strict adapter (approximate counter) would refuse a real endpoint; the exploratory flag lifts both checks.
    expect(new PilotSettlementAdapter(approximateCounter).checkConfig(cfg)).toEqual([]);
    const strict = { ...cfg, protocol: { ...cfg.protocol!, params: { ...cfg.protocol!.params, exploratory: false } } };
    expect(new PilotSettlementAdapter(approximateCounter).checkConfig(strict as typeof cfg).join("\n")).toMatch(/tokenizer|generation settings/);
  });

  it("runs Complete, then Ring, then the detector, and hands back the replay-shaped view marked exploratory", async () => {
    const { db, providers, service } = services();
    const live = new LiveDemoService({ db, service, providers });
    const session = live.start("DEV-01", MODELS);
    expect(session.stage).toBe("complete");
    expect(() => live.start("DEV-01", MODELS)).toThrow(/already in progress/);
    const deadline = Date.now() + 60_000;
    while (!["done", "failed"].includes(live.get(session.id)!.stage) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const s = live.get(session.id)!;
    expect(s.error).toBeNull();
    expect(s.stage).toBe("done");
    expect(s.runs.complete).toMatchObject({ status: "finished", outcome: "MISSION_FAILURE" }); // the probe's fixed proposal is wrong for DEV-01: finished, not aborted
    expect(s.runs.ring.status).toBe("finished");
    expect(s.runs.complete.experimentId).not.toBe(s.runs.ring.experimentId);
    expect(s.detector).toMatchObject({ messages: 36, done: 36, failures: 36 });
    const v = s.view!;
    expect(v.id).toBe("DEV-01");
    expect(v.runs.complete.calls).toHaveLength(18);
    expect(v.runs.ring.calls[0]!.text).toMatch(/^PROBE/);
    expect(v.runs.complete.validity.status).toBe("exploratory");
    expect(v.runs.ring.validity.detail).toMatch(/n = 1/);
    expect(v.detector!.complete.extraction_failures).toHaveLength(18);
    expect(v.detector!.complete.facts).toHaveLength(10);
    expect(v.detector!.complete.category).toBe("insufficient");
    // After the first session another can start.
    expect(live.list()).toHaveLength(1);
    const second = live.start("DEV-02", MODELS);
    expect(second.id).not.toBe(session.id);
    while (!["done", "failed"].includes(live.get(second.id)!.stage) && Date.now() < deadline + 60_000) await new Promise((r) => setTimeout(r, 100));
    expect(live.get(second.id)!.stage).toBe("done");
  }, 150_000);

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

    it("offers the live run, starts a session and reports it until the view is ready", async () => {
      const overview = (await (await fetch(`${baseUrl}/api/pilot-demo`)).json()) as { live: { available: boolean; agents: string; sessions: unknown[] } };
      expect(overview.live).toMatchObject({ available: true, agents: "pilot-settlement/probe", sessions: [] });
      const bad = await fetch(`${baseUrl}/api/pilot-demo/live`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instance: "P-01" }) });
      expect(bad.status).toBe(404);
      const started = await fetch(`${baseUrl}/api/pilot-demo/live`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instance: "DEV-03" }) });
      expect(started.status).toBe(202);
      const session = (await started.json()) as { id: string; stage: string; view?: unknown };
      expect(session.stage).toBe("complete");
      expect(session).not.toHaveProperty("view");
      const busy = await fetch(`${baseUrl}/api/pilot-demo/live`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instance: "DEV-04" }) });
      expect(busy.status).toBe(409);
      const deadline = Date.now() + 120_000;
      let last: { stage: string; view: { runs: { ring: { validity: { status: string } } } } | null; runs: { complete: { turn: number } } } | null = null;
      while (Date.now() < deadline) {
        last = (await (await fetch(`${baseUrl}/api/pilot-demo/live/${session.id}`)).json()) as typeof last;
        if (last!.stage === "done" || last!.stage === "failed") break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(last!.stage).toBe("done");
      expect(last!.view!.runs.ring.validity.status).toBe("exploratory");
      expect(await (await fetch(`${baseUrl}/api/pilot-demo/live/nope`)).status).toBe(404);
      const again = (await (await fetch(`${baseUrl}/api/pilot-demo`)).json()) as { live: { sessions: Array<{ stage: string }> } };
      expect(again.live.sessions.map((s) => s.stage)).toEqual(["done"]);
    }, 150_000);

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
