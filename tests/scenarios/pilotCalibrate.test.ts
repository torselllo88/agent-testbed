import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../src/llm/provider.js";
import { calibrate, fillerOfTokens, PILOT_MODEL_RECORD_FILE } from "../../src/scenarios/pilotSettlement/calibrate.js";
import { GgufBpeTokenizer } from "../../src/scenarios/pilotSettlement/tokenizer.js";

/**
 * The G2 calibration (plan §4) against a scripted server: the fake answers /api/version, /api/show
 * (the frozen record itself), /api/tags, /api/generate (cache busters) and /api/chat, counting every
 * prompt with the same tokenizer plus a fixed template overhead, and truncating silently at the
 * window as Ollama does. The report must derive the rule and the verdicts from that behaviour.
 */

const tokenizer = GgufBpeTokenizer.fromShowJson();
const TEMPLATE_OVERHEAD = 11;

interface Seen {
  chat: Array<{ messages: ChatMessage[]; options: Record<string, number>; think: unknown; keep_alive: unknown }>;
  generate: number;
}

function fakeServer(opts: { cachedField?: boolean; truncate?: boolean; overheadFor?: (local: number) => number; worstDone?: string }): { fetch: typeof fetch; seen: Seen } {
  const seen: Seen = { chat: [], generate: 0 };
  const record = fs.readFileSync(PILOT_MODEL_RECORD_FILE, "utf8");
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (url.endsWith("/api/version")) return json(200, { version: "0.33.2" });
    if (url.endsWith("/api/show")) return json(200, JSON.parse(record));
    if (url.endsWith("/api/tags")) return json(200, { models: [{ name: "qwen3.8:27b", model: "qwen3.8:27b", digest: "abc123" }] });
    if (url.endsWith("/api/generate")) {
      seen.generate += 1;
      return json(200, { done: true, done_reason: "length", prompt_eval_count: tokenizer.count(String(body.prompt)), eval_count: 1 });
    }
    if (url.endsWith("/api/chat")) {
      const messages = body.messages as ChatMessage[];
      const options = body.options as Record<string, number>;
      seen.chat.push({ messages, options, think: body.think, keep_alive: body.keep_alive });
      const local = messages.reduce((n, m) => n + tokenizer.count(m.content), 0);
      const overhead = opts.overheadFor ? opts.overheadFor(local) : TEMPLATE_OVERHEAD;
      let promptEval = local + overhead;
      if (promptEval > options.num_ctx! && opts.truncate !== false) promptEval = options.num_ctx! - 64; // silent truncation, as Ollama does
      const numPredict = options.num_predict ?? 2560;
      const thinking = numPredict > 1 ? "Let me check the rules. Contract permits D1. Treasury is pending, so hold." : "";
      const content = numPredict >= 2560 ? '{"action": "hold", "destination": null, "rail": null, "reason": "Treasury approval pending"}' : numPredict > 1 ? "HOLD: Treasury approval is pending." : "OK";
      const evalCount = tokenizer.count(thinking) + tokenizer.count(content) + 2;
      return json(200, {
        model: "qwen3.8:27b",
        message: { role: "assistant", content, thinking },
        done: true,
        done_reason: numPredict >= 2560 ? (opts.worstDone ?? "stop") : numPredict > 1 ? "stop" : "length",
        prompt_eval_count: promptEval,
        ...(opts.cachedField ? { prompt_eval_cached_count: 0 } : {}),
        eval_count: evalCount,
        total_duration: 1_000_000_000,
        load_duration: 5_000_000,
        prompt_eval_duration: 300_000_000,
        eval_duration: 600_000_000,
      });
    }
    return json(404, { error: "not found" });
  };
  return { fetch: fetchFn, seen };
}

describe("pilot settlement: gate G2 calibration", () => {
  it("fillerOfTokens makes a text of exactly the asked number of tokens", () => {
    for (const n of [200, 37]) expect(tokenizer.count(fillerOfTokens(tokenizer, n, 3))).toBe(n);
    expect(fillerOfTokens(tokenizer, 200, 1)).not.toBe(fillerOfTokens(tokenizer, 200, 2));
  });

  it("derives the prompt_count_rule, checks eval_count, the canary and the worst case, and sends the plan's settings", async () => {
    const server = fakeServer({ cachedField: true });
    const lines: string[] = [];
    const report = await calibrate({ baseUrl: "http://fake:11434", model: "qwen3.8:27b", worstCase: true, fetch: server.fetch, log: (l) => lines.push(l) });

    expect(report.step1).toMatchObject({ version: "0.33.2", digest: "abc123", capabilities: ["completion", "vision", "tools", "thinking"], recordDifferences: [], thinkingLevels: null });
    expect(report.step1.tokenizerSourceSha256).toBe(tokenizer.info.sourceSha256);

    expect(report.step2.pass).toBe(true);
    expect(report.step2.maxTokens).toBeLessThanOrEqual(1200);
    expect(report.step2.devMaxTokens).toBeGreaterThan(600); // 630 with the v0.3.1 wording, a few tokens more since 0.3.2-draft
    expect(report.step2.over).toEqual([]);

    expect(report.step3.calls).toHaveLength(6);
    expect(report.step3.calls.map((c) => c.cache)).toEqual(["cold", "warm", "cold", "warm", "cold", "warm"]);
    expect(report.step3.overheads).toEqual([TEMPLATE_OVERHEAD]);
    expect(report.step3.cachedCountReported).toBe(true);
    expect(report.step3.evalCountIncludesThinking).toBe(true);
    expect(report.step3.warmEqualsCold).toBe(true);
    expect(report.step3.promptCountRule).toBe(`prompt_eval_count = local_count + ${TEMPLATE_OVERHEAD} (the chat template's tokens), cached or not; prompt_eval_cached_count is reported separately and is not added`);
    expect(report.step3.pass).toBe(true);
    // The step-3 prompts are pilot prompts: a discussion turn, the final call, the oracle — with the paired seeds.
    expect(report.step3.calls[0]!.localPerMessage).toHaveLength(2);
    expect(report.step3.calls[4]!.label).toBe("DEV-01 oracle");
    expect(report.step3.calls[0]!.seed).toBe(report.step3.calls[1]!.seed);
    expect(report.step3.calls[0]!.evalExtra).toBe(2);

    expect(report.step4.localPromptTokens).toBeGreaterThanOrEqual(9000);
    expect(report.step4.promptEvalCount).toBe(8192 - 64);
    expect(report.step4.detectable).toBe(true);
    expect(report.step4.pass).toBe(true);

    expect(report.step6).not.toBeNull();
    expect(report.step6!.call.localPerMessage[1]).toBeGreaterThan(18 * 200);
    expect(report.step6!.proposalParsed).toBe(true);
    expect(report.step6!.finishedWithinBudget).toBe(true);
    expect(report.step6!.pass).toBe(true);
    const worst = server.seen.chat[server.seen.chat.length - 1]!;
    expect(worst.messages[1]!.content.split("[Round ").length - 1).toBe(18); // 18 history lines
    expect(worst.options.num_predict).toBe(2560);

    // Every chat call carries the plan's settings; every cold call followed a cache buster.
    for (const c of server.seen.chat) {
      expect(c.think).toBe(true);
      expect(c.keep_alive).toBe("30m");
      expect(c.options).toMatchObject({ num_ctx: 8192, temperature: 1, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0, repeat_penalty: 1 });
      expect(typeof c.options.seed).toBe("number");
    }
    expect(server.seen.generate).toBe(3 + 1 + 1);
    expect(report.summary).toHaveLength(5);
    expect(lines.length).toBeGreaterThan(5);
  });

  it("reports an unresolved rule when the warm count leaves cached tokens out, and a failed canary when truncation is silent", async () => {
    let n = 0;
    const server = fakeServer({ overheadFor: () => (n++ % 2 === 0 ? TEMPLATE_OVERHEAD : -500), truncate: false });
    const report = await calibrate({ baseUrl: "http://fake:11434", model: "qwen3.8:27b", fetch: server.fetch });
    expect(report.step3.warmEqualsCold).toBe(false);
    expect(report.step3.promptCountRule).toMatch(/^UNRESOLVED: prompt_eval_count differs between cold and warm/);
    expect(report.step3.pass).toBe(false);
    expect(report.step4.detectable).toBe(false);
    expect(report.step4.pass).toBe(false);
    expect(report.step6).toBeNull();
  });

  it("fails loudly when the server refuses", async () => {
    const fetchFn: typeof fetch = async (input) => new Response(JSON.stringify({ error: "model not found" }), { status: 404 });
    await expect(calibrate({ baseUrl: "http://fake:11434", model: "nope", fetch: fetchFn })).rejects.toThrow(/\/api\/show failed: HTTP 404/);
  });
});
