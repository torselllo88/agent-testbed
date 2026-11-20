import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExperimentService } from "../../src/experiment/service.js";
import { OllamaProvider } from "../../src/llm/ollamaProvider.js";
import { ProviderRegistry } from "../../src/llm/registry.js";
import { StubProvider } from "../../src/llm/stubProvider.js";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { createEvaluatorRegistry, registerBuiltinStubs } from "../../src/scenarios/index.js";
import { PROMPT_COUNT_RULE } from "../../src/scenarios/pilotSettlement/adapter.js";
import { judgeSnapshot, pairRunConfig, PilotStopped, runPairs, type FreezeRecord } from "../../src/scenarios/pilotSettlement/pairRunner.js";
import { GgufBpeTokenizer } from "../../src/scenarios/pilotSettlement/tokenizer.js";
import { FAKE_OLLAMA_MODELS, startFakeOllamaServer, type FakeOllamaServer } from "../helpers/fakeOllamaServer.js";

/**
 * The pair runner (plan §3.2, §11) against the scripted Ollama server: preload, the three
 * snapshots, both runs, the run logs with the snapshots in them; a deviated pair re-executed
 * after the environment is normal again; a digest change that stops the pilot.
 */

const MODEL = FAKE_OLLAMA_MODELS[0]!;
const RECORD: FreezeRecord = { model: MODEL, digest: "sha256-fake-digest", ollama_version: "0.33.2", context_length: 8192 };
const tokenizer = GgufBpeTokenizer.fromShowJson();

describe("pilot settlement: the pair runner", () => {
  let server: FakeOllamaServer;
  let outRoot: string;
  beforeAll(async () => {
    server = await startFakeOllamaServer();
    server.promptEvalCount = (body) => body.messages.reduce((n, m) => n + tokenizer.count(m.content), 0) + PROMPT_COUNT_RULE.templateTokens;
    outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-pairs-"));
  });
  afterAll(async () => {
    await server.close();
    fs.rmSync(outRoot, { recursive: true, force: true });
  });

  function deps() {
    const db = createInMemoryDb();
    const providers = new ProviderRegistry([new OllamaProvider({ name: "lab-ollama", baseUrl: server.url })], registerBuiltinStubs(new StubProvider()));
    const evaluators = createEvaluatorRegistry();
    return { db, service: new ExperimentService({ db, providers, evaluators }) };
  }
  const base = (outDir: string) => ({ endpoint: "lab-ollama", baseUrl: server.url, model: MODEL, outDir, record: RECORD, nvidiaSmi: () => "0, Fake GPU, 18000 MiB, 24576 MiB, 90 %", waitPollMs: 10, waitTimeoutMs: 5_000 });

  it("judges a snapshot by the plan's rule", () => {
    const ps = { models: [{ name: MODEL, size: 100, size_vram: 100, context_length: 8192, digest: RECORD.digest }] };
    expect(judgeSnapshot(ps, "0.33.2", RECORD)).toEqual({ normal: true, deviation: null, stop: null });
    expect(judgeSnapshot({ models: [] }, "0.33.2", RECORD).deviation).toBe(`model ${MODEL} not loaded`);
    expect(judgeSnapshot({ models: [{ ...ps.models[0]!, size_vram: 60 }] }, "0.33.2", RECORD).deviation).toBe("model not fully in GPU memory (size_vram 60 of 100)");
    expect(judgeSnapshot({ models: [{ ...ps.models[0]!, context_length: 4096 }] }, "0.33.2", RECORD).deviation).toBe("context length 4096, not 8192");
    expect(judgeSnapshot(ps, "0.34.0", RECORD).stop).toBe("Ollama version changed: 0.34.0 (freeze record 0.33.2)");
    expect(judgeSnapshot({ models: [{ ...ps.models[0]!, digest: "x" }] }, "0.33.2", RECORD).stop).toBe(`model digest changed: x (freeze record ${RECORD.digest})`);
    expect(judgeSnapshot(null, null, RECORD)).toMatchObject({ normal: false, stop: null });
  });

  it("builds the pilot config of an instance under a topology on the endpoint, as the batch specs do", () => {
    const ring = pairRunConfig("DEV-03", "ring", "lab-ollama", MODEL, 2);
    expect(ring.communication?.topology.type).toBe("ring");
    expect(ring.protocol?.replicate).toBe(2);
    expect(ring.agents.every((a) => a.model.provider === "openai-compatible" && a.model.think === true && a.model.contextLength === 8192 && a.model.maxOutputTokens === 2560)).toBe(true);
    expect(pairRunConfig("DEV-03", "complete", "lab-ollama", MODEL).communication).toBeUndefined(); // the complete graph is the default, normalized away
  });

  it("runs a pair: preload, three snapshots, both runs, the logs with the snapshots in them", async () => {
    const outDir = path.join(outRoot, "normal");
    const lines: string[] = [];
    const pairs = await runPairs(deps(), { ...base(outDir), instances: ["DEV-01"], log: (l) => lines.push(l) });
    expect(pairs).toHaveLength(1);
    const pair = pairs[0]!;
    expect(pair).toMatchObject({ instance: "DEV-01", replicate: 0, order: ["complete", "ring"], outcome: "valid" });
    expect(pair.executions).toHaveLength(1);
    const exec = pair.executions[0]!;
    expect(exec.preload.ok).toBe(true);
    expect(exec.preload.request).toMatchObject({ model: MODEL, messages: [], keep_alive: "30m", options: { num_ctx: 8192 } });
    expect(exec.snapshots.map((s) => s.when)).toEqual(["before_pair", "between_runs", "after_pair"]);
    expect(exec.snapshots.every((s) => s.normal && s.ollama_version === "0.33.2" && s.nvidia_smi.includes("Fake GPU"))).toBe(true);
    expect(exec.runs.map((r) => r.runId)).toEqual(["DEV-01-COMPLETE", "DEV-01-RING"]);
    expect(exec.runs.every((r) => r.validity.status === "valid")).toBe(true);
    for (const run of exec.runs) {
      const log = JSON.parse(fs.readFileSync(run.logPath, "utf8")) as Record<string, unknown>;
      expect(path.dirname(run.logPath)).toBe(outDir);
      expect((log.environment_snapshots as unknown[]).length).toBe(3);
      expect((log.preload as { response: { done_reason: string }; ok: boolean }).response.done_reason).toBe("load");
      expect(log.attempt).toBe(0);
      expect((log.validity as { status: string }).status).toBe("valid");
    }
    const recordFile = path.join(outDir, "pairs", "DEV-01.json");
    expect(JSON.parse(fs.readFileSync(recordFile, "utf8"))).toMatchObject({ instance: "DEV-01", outcome: "valid" });
    expect(lines.some((l) => l.startsWith("pair DEV-01: valid"))).toBe(true);
    // The second instance would start with the ring (alternating order).
  });

  it("re-executes a deviated pair once the environment is normal, keeping the deviated logs apart", async () => {
    const outDir = path.join(outRoot, "deviation");
    server.placement.gpuFraction = 0.5;
    let snapshots = 0;
    const pairs = await runPairs(deps(), {
      ...base(outDir),
      instances: ["DEV-02"],
      first: "ring",
      onSnapshot: () => {
        snapshots += 1;
        if (snapshots === 3) server.placement.gpuFraction = 1; // the GPU is ours again after the first execution
      },
    });
    const pair = pairs[0]!;
    expect(pair.order).toEqual(["ring", "complete"]);
    expect(pair.outcome).toBe("valid");
    expect(pair.executions).toHaveLength(2);
    const [first, second] = pair.executions as [typeof pair.executions[0], typeof pair.executions[0]];
    expect(first.deviation).toMatch(/not fully in GPU memory/);
    expect(first.snapshots.every((s) => !s.normal)).toBe(true);
    expect(first.runs.every((r) => r.validity.status === "environment_deviation" && path.dirname(r.logPath) === path.join(outDir, "deviations", "DEV-02-attempt0"))).toBe(true);
    expect(second.deviation).toBeNull();
    expect(second.attempt).toBe(1);
    expect(second.runs.every((r) => r.validity.status === "valid" && path.dirname(r.logPath) === outDir)).toBe(true);
    expect(second.runs.map((r) => r.runId)).toEqual(["DEV-02-RING", "DEV-02-COMPLETE"]);
    const log = JSON.parse(fs.readFileSync(second.runs[0]!.logPath, "utf8")) as { attempt: number };
    expect(log.attempt).toBe(1);
    // The same seeds in both executions (the runs are re-executed, not re-drawn).
    const seedsOf = (p: string) => (JSON.parse(fs.readFileSync(p, "utf8")) as { calls: Array<{ seed: number }> }).calls.map((c) => c.seed);
    expect(seedsOf(second.runs[0]!.logPath)).toEqual(seedsOf(first.runs[0]!.logPath));
  });

  it("a failed preload is an environment deviation; without re-executions left the pair is excluded", async () => {
    const outDir = path.join(outRoot, "preload");
    server.respondWith({ status: 500, body: { error: "server busy" } });
    const pairs = await runPairs(deps(), { ...base(outDir), instances: ["DEV-03"], maxReexecutions: 0 });
    const pair = pairs[0]!;
    expect(pair.outcome).toBe("environment_deviation");
    expect(pair.executions).toHaveLength(1);
    expect(pair.executions[0]!.preload.ok).toBe(false);
    expect(pair.executions[0]!.deviation).toMatch(/preload did not answer done_reason "load"/);
    expect(pair.executions[0]!.runs.every((r) => r.validity.status === "environment_deviation" && path.dirname(r.logPath) === outDir)).toBe(true);
    expect((pair.executions[0]!.runs[0]!.validity as { detail: string }).detail).toMatch(/preload/);
  });

  it("runs a controls pair: the oracle and the public-only call of Operations alone, with the replicate in the run ids", async () => {
    const outDir = path.join(outRoot, "controls");
    const pairs = await runPairs(deps(), { ...base(outDir), instances: ["DEV-05"], kind: "controls", replicate: 1 });
    const pair = pairs[0]!;
    expect(pair).toMatchObject({ instance: "DEV-05", kind: "controls", replicate: 1, order: ["oracle", "public_only"], outcome: "valid" });
    const exec = pair.executions[0]!;
    expect(exec.runs.map((r) => r.runId)).toEqual(["DEV-05-ORACLE-rep1", "DEV-05-PUBLIC_ONLY-rep1"]);
    for (const run of exec.runs) {
      const log = JSON.parse(fs.readFileSync(run.logPath, "utf8")) as { condition: string; topology: string; replicate: number; calls: unknown[]; environment_snapshots: unknown[]; validity: { status: string } };
      expect(log.condition).toBe(run.topology === "oracle" ? "oracle" : "public_only");
      expect(log.topology).toBe("none");
      expect(log.replicate).toBe(1);
      expect(log.calls).toHaveLength(1);
      expect(log.environment_snapshots).toHaveLength(3);
      expect(log.validity.status).toBe("valid");
    }
    expect(fs.existsSync(path.join(outDir, "pairs", "DEV-05-controls-rep1.json"))).toBe(true);
    const cfg = pairRunConfig("DEV-05", "public_only", "lab-ollama", MODEL, 2);
    expect(cfg.agents.map((a) => a.id)).toEqual(["operations"]);
    expect(cfg.protocol?.control).toBe("public_only");
    expect(cfg.protocol?.replicate).toBe(2);
  });

  it("stops the pilot on a digest change", async () => {
    const outDir = path.join(outRoot, "stop");
    server.placement.digest = "sha256-other-weights";
    try {
      await expect(runPairs(deps(), { ...base(outDir), instances: ["DEV-04"] })).rejects.toThrow(PilotStopped);
      await expect(runPairs(deps(), { ...base(outDir), instances: ["DEV-04"] })).rejects.toThrow(/model digest changed: sha256-other-weights/);
    } finally {
      server.placement.digest = undefined;
    }
  });
});
