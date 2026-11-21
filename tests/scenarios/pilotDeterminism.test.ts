import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { determinism, pickCalls } from "../../src/scenarios/pilotSettlement/determinism.js";
import type { FreezeRecord } from "../../src/scenarios/pilotSettlement/pairRunner.js";

/**
 * Gate G6 against a scripted server: the calls come from run logs (written here in the run-log
 * shape), the server answers deterministically per seed unless told to drift; the cache state is
 * set by call order (buster, then repeats). An abnormal snapshot fails the gate.
 */

const MODEL = "qwen-fake:27b";
const RECORD: FreezeRecord = { model: MODEL, digest: "d", ollama_version: "0.33.2", context_length: 8192 };

function fakeLog(runId: string, calls: Array<{ type: "discussion" | "final"; speaker: string; seed: number; prompt: number }>) {
  return {
    run_id: runId,
    calls: calls.map((c, i) => ({
      call_index: i,
      call_type: c.type,
      speaker: c.speaker,
      system_text: `SYSTEM of ${runId} ${i}`,
      user_text: `USER of ${runId} ${i}`,
      seed: c.seed,
      attempts: [{ kind: "initial", accepted: true, prompt_eval_count: c.prompt, error: null }],
    })),
  };
}

function scripted(opts: { drift?: (seed: number, n: number) => boolean; gpuFraction?: number }) {
  const seen: Array<{ route: string; body?: Record<string, unknown> }> = [];
  const counts = new Map<number, number>();
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    seen.push({ route: url.slice(url.indexOf("/api")), body });
    if (url.endsWith("/api/version")) return json(200, { version: "0.33.2" });
    if (url.endsWith("/api/ps")) return json(200, { models: [{ name: MODEL, size: 100, size_vram: Math.round(100 * (opts.gpuFraction ?? 1)), context_length: 8192, digest: "d" }] });
    if (url.endsWith("/api/generate")) return json(200, { done: true, done_reason: "length", prompt_eval_count: 5, eval_count: 1 });
    if (url.endsWith("/api/chat")) {
      if ((body!.messages as unknown[]).length === 0) return json(200, { message: { role: "assistant", content: "" }, done: true, done_reason: "load" });
      const seed = (body!.options as { seed: number }).seed;
      const n = (counts.get(seed) ?? 0) + 1;
      counts.set(seed, n);
      const drift = opts.drift?.(seed, n) ?? false;
      return json(200, { message: { role: "assistant", content: `answer for seed ${seed}${drift ? " (drifted)" : ""}`, thinking: "thought" }, done: true, done_reason: "stop", eval_count: 10, prompt_eval_count: 50, load_duration: 5_000_000, total_duration: 100_000_000 });
    }
    return json(404, { error: "not found" });
  };
  return { fetch: fetchFn, seen };
}

describe("pilot settlement: gate G6 determinism", () => {
  let logsDir: string;
  beforeAll(() => {
    logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-g6-"));
    fs.writeFileSync(path.join(logsDir, "DEV-01-COMPLETE.json"), JSON.stringify(fakeLog("DEV-01-COMPLETE", [
      { type: "discussion", speaker: "Contract", seed: 11, prompt: 700 },
      { type: "discussion", speaker: "Operations", seed: 12, prompt: 1500 },
      { type: "final", speaker: "Operations", seed: 13, prompt: 2000 },
    ])));
    fs.writeFileSync(path.join(logsDir, "DEV-02-RING.json"), JSON.stringify(fakeLog("DEV-02-RING", [
      { type: "discussion", speaker: "Treasury", seed: 21, prompt: 1200 },
      { type: "discussion", speaker: "Settlement", seed: 22, prompt: 900 },
      { type: "final", speaker: "Operations", seed: 23, prompt: 1800 },
    ])));
    fs.writeFileSync(path.join(logsDir, "DEV-02-RING.thinking.json"), "[]");
  });
  afterAll(() => fs.rmSync(logsDir, { recursive: true, force: true }));

  it("picks the discussion and final calls with the largest prompts from the logs", () => {
    const picked = pickCalls(logsDir, 3, 2);
    expect(picked.map((p) => p.source)).toEqual([
      "DEV-01-COMPLETE call 1 (Operations)",
      "DEV-02-RING call 0 (Treasury)",
      "DEV-02-RING call 1 (Settlement)",
      "DEV-01-COMPLETE call 2 (Operations)",
      "DEV-02-RING call 2 (Operations)",
    ]);
  });

  it("passes when every call repeats identically in both cache states under normal snapshots", async () => {
    const server = scripted({});
    const report = await determinism({ baseUrl: "http://fake:11434", model: MODEL, logsDir, record: RECORD, fetch: server.fetch, nvidiaSmi: () => "gpu" });
    expect(report.pass).toBe(true);
    expect(report.calls).toHaveLength(6);
    expect(report.calls.map((c) => c.kind)).toEqual(["discussion", "discussion", "discussion", "final", "final", "public_only"]);
    expect(report.calls.every((c) => c.results.length === 6 && c.identical.cold && c.identical.warm && c.identical.acrossStates)).toBe(true);
    expect(report.snapshots.map((s) => s.when)).toEqual(["before_pair", "after_pair"]);
    expect(report.preload.ok).toBe(true);
    expect(report.preload.request).toMatchObject({ messages: [], keep_alive: "30m", options: { num_ctx: 8192 } });
    // Call order sets the cache state: a buster before every cold call, none before the warm ones.
    const routes = server.seen.map((s) => s.route).filter((r) => r === "/api/generate" || r === "/api/chat");
    expect(routes.slice(0, 8)).toEqual(["/api/chat", "/api/generate", "/api/chat", "/api/generate", "/api/chat", "/api/generate", "/api/chat", "/api/chat"]); // preload, then buster + cold ×3, then warm
    const chats = server.seen.filter((s) => s.route === "/api/chat" && (s.body!.messages as unknown[]).length > 0);
    expect(chats).toHaveLength(36);
    expect(chats.every((c) => (c.body!.options as { num_predict: number; seed: number }).num_predict === 2560 && c.body!.think === true)).toBe(true);
    // The public-only call carries the pilot's public-only seed and the rendered messages.
    const pub = report.calls[5]!;
    expect(pub.source).toBe("DEV-01 public-only, replicate 0");
    expect(typeof pub.seed).toBe("number");
    expect(report.summary[0]).toMatch(/: pass$/);
  });

  it("fails when a warm repeat differs, and when a snapshot is abnormal", async () => {
    const drifting = scripted({ drift: (seed, n) => seed === 22 && n === 5 });
    const report = await determinism({ baseUrl: "http://fake:11434", model: MODEL, logsDir, record: RECORD, fetch: drifting.fetch, nvidiaSmi: () => "gpu" });
    expect(report.pass).toBe(false);
    const bad = report.calls.find((c) => c.seed === 22)!;
    expect(bad.identical).toEqual({ cold: true, warm: false, acrossStates: false });
    expect(report.calls.filter((c) => c.identical.warm)).toHaveLength(5);

    const busy = scripted({ gpuFraction: 0.5 });
    const report2 = await determinism({ baseUrl: "http://fake:11434", model: MODEL, logsDir, record: RECORD, fetch: busy.fetch, nvidiaSmi: () => "gpu", repeats: 1 });
    expect(report2.snapshotsNormal).toBe(false);
    expect(report2.calls.every((c) => c.identical.cold && c.identical.warm)).toBe(true);
    expect(report2.pass).toBe(false);
  });
});
