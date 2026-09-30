import { describe, expect, it } from "vitest";
import { BatchService } from "../../src/batch/service.js";
import { ExperimentService } from "../../src/experiment/service.js";
import { ConcurrencyGate } from "../../src/llm/concurrencyGate.js";
import { ProviderError, type CompletionRequest, type LlmProvider } from "../../src/llm/provider.js";
import { ProviderRegistry } from "../../src/llm/registry.js";
import { StubProvider } from "../../src/llm/stubProvider.js";
import { createInMemoryDb, openDb, sqliteSynchronousMode } from "../../src/persistence/db.js";
import { createEvaluatorRegistry, registerBuiltinStubs } from "../../src/scenarios/index.js";
import { createHarness, ofType, script, testConfig } from "../helpers/harness.js";

describe("ConcurrencyGate", () => {
  it("never exceeds its limit and hands slots out FIFO", async () => {
    const gate = new ConcurrencyGate(2);
    const order: number[] = [];
    const releases = await Promise.all([gate.acquire(), gate.acquire()]);
    const waiting = [3, 4].map((n) => gate.acquire().then((release) => (order.push(n), release)));
    expect(gate.stats()).toMatchObject({ inFlight: 2, queued: 2 });

    releases[0]!();
    const r3 = await waiting[0]!;
    expect(order).toEqual([3]);
    releases[1]!();
    await waiting[1];
    expect(order).toEqual([3, 4]);
    r3();
    expect(gate.stats()).toMatchObject({ inFlight: 1, queued: 0, peak: 2 });
  });

  it("a waiter whose signal aborts leaves the queue", async () => {
    const gate = new ConcurrencyGate(1);
    const release = await gate.acquire();
    const controller = new AbortController();
    const waiting = gate.acquire(controller.signal);
    controller.abort(new Error("stop"));
    await expect(waiting).rejects.toThrow("stop");
    expect(gate.stats().queued).toBe(0);
    release();
    expect(gate.stats().inFlight).toBe(0);
  });
});

/** A fake remote provider that records how many requests are in flight at once. */
function trackingProvider(latencyMs = 10, failWhen?: (req: CompletionRequest) => boolean) {
  const state = { inFlight: 0, peak: 0, calls: 0 };
  const respond = script({});
  const provider: LlmProvider = {
    id: "openrouter",
    async complete(req) {
      state.calls += 1;
      state.inFlight += 1;
      state.peak = Math.max(state.peak, state.inFlight);
      try {
        const t0 = Date.now();
        await new Promise((r) => setTimeout(r, latencyMs));
        if (failWhen?.(req)) throw new ProviderError("503 upstream overloaded", false, 503);
        // innerMs: the time this call really spent in the provider, timer jitter included.
        return { text: respond(req), requestedModel: req.model, servedModel: req.model, usage: { promptTokens: 10, completionTokens: 5 }, providerMeta: { innerMs: Date.now() - t0 } };
      } finally {
        state.inFlight -= 1;
      }
    },
  };
  return { provider, state };
}

const realModelConfig = (model = "vendor/model") => {
  const config = testConfig();
  for (const agent of config.agents) agent.model = { provider: "openrouter", model, structuredOutput: "native" };
  return config;
};

describe("provider request gate in real runs", () => {
  it("caps simultaneous provider requests below the voting fan-out, and records queue wait separately", async () => {
    const LATENCY_MS = 60;
    const { provider, state } = trackingProvider(LATENCY_MS);
    const h = createHarness({ providers: [provider], maxConcurrentRequests: 2 });
    const runner = h.runner(realModelConfig());
    const metrics = await runner.run();

    expect(metrics.termination?.outcome).toBe("SUCCESS");
    expect(state.peak).toBe(2); // voting alone would fire 4 at once
    const votes = ofType(h.events(runner.id), "llm_call").filter((e) => e.payload.purpose === "vote");
    expect(votes.some((e) => (e.payload.queueWaitMs as number) > 0)).toBe(true);
    // durationMs is provider time only — queueing is not counted as provider latency. Compared with the time the
    // provider itself measured (so timer jitter under load cancels out): counting a queued vote's wait would add
    // a whole call (≥ LATENCY_MS) on top.
    const queued = votes.filter((v) => (v.payload.queueWaitMs as number) >= LATENCY_MS / 2);
    expect(queued.length).toBeGreaterThan(0);
    for (const e of votes) {
      const inner = (e.payload.providerMeta as { innerMs: number }).innerMs;
      expect((e.payload.durationMs as number) - inner).toBeLessThan(LATENCY_MS / 2);
    }

    const started = ofType(h.events(runner.id), "experiment_started")[0]!;
    expect(started.payload.environment).toMatchObject({ maxConcurrentRequests: 2 });
  });

  it("is process-wide: several batch experiments share one limit", async () => {
    const { provider, state } = trackingProvider(10);
    const db = createInMemoryDb();
    const providers = new ProviderRegistry([provider], registerBuiltinStubs(new StubProvider()), { maxConcurrentRequests: 3 });
    const evaluators = createEvaluatorRegistry();
    const service = new ExperimentService({ db, providers, evaluators });
    const batches = new BatchService({ db, providers, evaluators, service });
    const batch = batches.start({ name: "gated", base: { config: realModelConfig() }, repetitions: 4, concurrency: 4 });
    await batches.settle(batch.id);

    expect(batches.view(batch.id).overall.success).toBe(4);
    expect(state.peak).toBeLessThanOrEqual(3); // 4 experiments × up to 4 votes each, still ≤ 3 in flight
  });

  it("the stub provider is never gated", () => {
    const providers = new ProviderRegistry([], new StubProvider(), { maxConcurrentRequests: 1 });
    expect(providers.gate("stub")).toBeNull();
  });
});

describe("provider errors in batch aggregates", () => {
  it("are counted and reported separately, never folded into the success-rate denominator silently", async () => {
    const { provider } = trackingProvider(1, (req) => req.model === "vendor/flaky");
    const db = createInMemoryDb();
    const providers = new ProviderRegistry([provider], registerBuiltinStubs(new StubProvider()), {});
    const evaluators = createEvaluatorRegistry();
    const service = new ExperimentService({ db, providers, evaluators });
    const batches = new BatchService({ db, providers, evaluators, service });
    const base = realModelConfig();
    base.runtime.providerRetryDelayMs = 0;
    const batch = batches.start({
      name: "flaky",
      base: { config: base },
      repetitions: 2,
      variables: [{ path: "agents.*.model.model", label: "model", values: ["vendor/model", "vendor/flaky"] }],
    });
    await batches.settle(batch.id);
    const { aggregates, overall } = batches.view(batch.id);

    const flaky = aggregates.find((a) => a.key === "model=vendor/flaky")!;
    expect(flaky).toMatchObject({ runs: 2, evaluable: 0, successRate: null, providerErrors: 2, excluded: { total: 2, byOutcome: { PROVIDER_ERROR: 2 } } });
    expect(overall).toMatchObject({ runs: 4, evaluable: 2, success: 2, successRate: 1, providerErrors: 2 });
    expect(batches.csv(batch.id)).toContain("PROVIDER_ERROR");
  });
});

describe("SQLite durability setting", () => {
  it("defaults to NORMAL on disk, is configurable, and the effective mode is recorded on every run", async () => {
    const dir = `${process.env.DATA_DIR}/sync-test-${Date.now()}`;
    expect(sqliteSynchronousMode(openDb(`${dir}/a`))).toBe("NORMAL");
    expect(sqliteSynchronousMode(openDb(`${dir}/b`, "FULL"))).toBe("FULL");

    const h = createHarness();
    const runner = h.runner(testConfig());
    await runner.run();
    const started = ofType(h.events(runner.id), "experiment_started")[0]!;
    // In-memory test DBs keep SQLite's own default (FULL) — the point is that the effective value is read back.
    expect(started.payload.environment).toMatchObject({ sqliteSynchronous: sqliteSynchronousMode(h.db) });
  });
});
