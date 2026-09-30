import { describe, expect, it, vi } from "vitest";
import type { RunExtensionFactory } from "../../src/experiment/extensions.js";
import { timerMs } from "../../src/experiment/llmCaller.js";
import { ProviderError, type CompletionRequest } from "../../src/llm/provider.js";
import { presentationExtensions } from "../../src/presentation/index.js";
import { kestrelConfig } from "../../src/scenarios/spaceStation/kestrel.js";
import { createHarness, ofType, SAFE_PLAN, script, testConfig, turnJson, useModel } from "../helpers/harness.js";

/** Regression tests for the issues found in the full code review. */

describe("core review fixes", () => {
  it("fractional time limits and call timeouts work (timers need whole milliseconds)", async () => {
    expect(timerMs(64.1 * 1000)).toBe(64100);
    expect(timerMs(0.2)).toBe(1);
    expect(timerMs(1e12)).toBe(2_147_483_647);
    const h = createHarness();
    const runner = h.runner(
      testConfig((c) => {
        c.limits.timeLimitSeconds = 64.1;
        c.runtime.callTimeoutSeconds = 16.1;
      })
    );
    expect((await runner.run()).termination?.outcome).toBe("SUCCESS");
  });

  it("a proposal answer without the envelope is a format error, not a decline; only an explicit null declines", async () => {
    const bare = createHarness({ scripts: { "test/bare": script({ proposal: () => JSON.stringify(SAFE_PLAN) }) } });
    const config = testConfig((c) => (c.decision.maxProposalFormatRetries = 0));
    useModel(config, "test/bare");
    const run = bare.runner(config);
    const metrics = await run.run();
    expect(metrics.termination?.outcome).toBe("PROPOSAL_PARSE_FAILED");
    expect(ofType(bare.events(run.id), "proposal_declined")).toHaveLength(0);

    const decline = createHarness({ scripts: { "test/decline": script({ proposal: () => JSON.stringify({ rationale: "not yet", proposal: null }) }) } });
    const c2 = testConfig((c) => (c.decision.maxProposalAttempts = 1));
    useModel(c2, "test/decline");
    const run2 = decline.runner(c2);
    expect((await run2.run()).termination?.outcome).toBe("NO_PROPOSAL");
  });

  it("a turn that is neither a message nor a pass is unparseable, not a silent PASS", async () => {
    const h = createHarness({
      scripts: { "test/odd": script({ discussion: (agentId, n) => (agentId === "operations" && n === 0 ? JSON.stringify({ reply: "hello" }) : turnJson({ pass: true, ready: true })) }) },
    });
    const config = testConfig((c) => (c.runtime.maxParseRetries = 0));
    useModel(config, "test/odd");
    const runner = h.runner(config);
    await runner.run();
    expect(ofType(h.events(runner.id), "protocol_incident").map((e) => e.payload.kind)).toContain("unparseable_turn");
  });

  it("an extension whose trace listener throws cannot change the run or its bookkeeping", async () => {
    const throwing: RunExtensionFactory = () => [
      {
        name: "throwing-listener",
        attach(ctx) {
          ctx.subscribe(() => {
            throw new Error("listener boom");
          });
        },
      },
    ];
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = createHarness({ extensions: throwing });
    const runner = h.runner(testConfig());
    const metrics = await runner.run();
    expect(quiet).toHaveBeenCalled(); // reported out of band, not into the run
    quiet.mockRestore();
    expect(metrics.termination?.outcome).toBe("SUCCESS");
    expect(h.record(runner.id)).toMatchObject({ outcome: "SUCCESS", phase: "FINISHED" });
  });

  it("extensions cannot change what agents read — messages reach them frozen, and all add-ons leave prompts unchanged", async () => {
    const tampering: RunExtensionFactory = (config, options) => [
      ...presentationExtensions(config, options),
      {
        name: "tamper",
        async beforePublish(message) {
          (message as { text: string }).text = "TAMPERED";
        },
        afterPublish(message) {
          (message as { text: string }).text = "TAMPERED";
        },
      },
    ];
    const prompts = async (extensions: RunExtensionFactory | null) => {
      const seen: CompletionRequest[] = [];
      const cooperative = (await import("../../src/scenarios/spaceStation/stubScripts.js")).spaceStationScript("cooperative");
      const h = createHarness({ extensions, scripts: { "test/rec": (req) => (seen.push(req), cooperative(req)) } });
      const config = kestrelConfig();
      config.presentation.pacing = { minVisibleIntervalMs: 0, perCharMs: 0, maxGapMs: 0 };
      config.runtime.providerRetryDelayMs = 0;
      useModel(config, "test/rec");
      const runner = h.runner(config);
      const metrics = await runner.run();
      return { metrics, seen: seen.map((r) => r.messages), events: h.events(runner.id) };
    };
    const tampered = await prompts(tampering);
    const bare = await prompts(null);
    expect(tampered.seen).toEqual(bare.seen);
    expect(tampered.metrics.termination?.outcome).toBe("SUCCESS");
    expect(ofType(tampered.events, "message_posted").some((e) => e.payload.text === "TAMPERED")).toBe(false);
    expect(ofType(tampered.events, "extension_error").some((e) => String(e.payload.message).startsWith('extension "tamper" failed in beforePublish'))).toBe(true);
  });

  it("a stop during the ending presentation cuts it short without counting as an intervention; other commands are refused", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowEnding: RunExtensionFactory = () => [{ name: "slow-ending", onRunEnded: () => gate }];
    const h = createHarness({ extensions: slowEnding });
    const runner = h.runner(testConfig());
    const done = runner.run();
    while (!ofType(h.events(runner.id), "evaluation_result").length) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 5));
    expect(() => runner.control({ type: "pause" })).toThrow(/already decided/);
    runner.control({ type: "stop" });
    release();
    const metrics = await done;
    expect(metrics.termination?.outcome).toBe("SUCCESS");
    expect(h.record(runner.id).intervened).toBe(false);
    expect(ofType(h.events(runner.id), "operator_intervention")[0]!.payload).toMatchObject({ flowAltering: false, afterOutcome: true });
  });

  it("credentials in a provider error never reach the experiments table", async () => {
    const secret = "sk-or-v1-leaked-in-an-error-message";
    const h = createHarness({
      secrets: [secret],
      scripts: {
        "test/fail": () => {
          throw new ProviderError(`upstream rejected key ${secret}`, false, 401);
        },
      },
    });
    const config = testConfig();
    useModel(config, "test/fail");
    const runner = h.runner(config);
    expect((await runner.run()).termination?.outcome).toBe("PROVIDER_ERROR");
    const row = h.db.prepare(`SELECT outcome_detail_json FROM experiments WHERE id = ?`).get(runner.id) as { outcome_detail_json: string };
    expect(row.outcome_detail_json).not.toContain(secret);
    expect(row.outcome_detail_json).toContain("[REDACTED]");
  });
});
