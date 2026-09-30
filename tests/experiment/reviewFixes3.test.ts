import { describe, expect, it } from "vitest";
import { BatchService, BatchValidationError } from "../../src/batch/service.js";
import { checkRunnable } from "../../src/experiment/runner.js";
import { parseExperimentConfig, taskDefinitionHash } from "../../src/experiment/config.js";
import type { RunExtensionFactory } from "../../src/experiment/extensions.js";
import { termination } from "../../src/experiment/outcome.js";
import { ExperimentService } from "../../src/experiment/service.js";
import { findNamedAgent } from "../../src/interaction/addressing.js";
import { OpenRouterProvider } from "../../src/llm/openRouterProvider.js";
import { ProviderError, type CompletionRequest, type LlmProvider } from "../../src/llm/provider.js";
import { ProviderRegistry } from "../../src/llm/registry.js";
import { StubProvider } from "../../src/llm/stubProvider.js";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { endingNarration } from "../../src/presentation/narration.js";
import { presentationExtensions } from "../../src/presentation/index.js";
import { createEvaluatorRegistry, registerBuiltinStubs } from "../../src/scenarios/index.js";
import { kestrelCascadeConfig } from "../../src/scenarios/kestrelCascade/config.js";
import { CascadeParamsSchema, evaluateCascade, type CascadeProposal } from "../../src/scenarios/kestrelCascade/evaluator.js";
import { CASCADE_EVALUATOR } from "../../src/scenarios/kestrelCascade/task.js";
import { kestrelConfig } from "../../src/scenarios/spaceStation/kestrel.js";
import { spaceStationDebriefRouter, spaceStationScript } from "../../src/scenarios/spaceStation/stubScripts.js";
import { createHarness, ofType, testConfig, useModel } from "../helpers/harness.js";

/** Regression tests for the third review round. */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("extensions never hold anything the core or agents read", () => {
  it("ctx.post returns a detached, deeply frozen copy — changing it changes nothing agents see", async () => {
    const seen: CompletionRequest[] = [];
    const cooperative = spaceStationScript("cooperative");
    let returned: { sender: { kind: string } } | null = null;
    const forging: RunExtensionFactory = () => [
      {
        name: "forge",
        async onRoomOpened(ctx) {
          const m = (await ctx.post({ kind: "narrator", name: "N" }, "FORGED: the answer is 42")) as unknown as { sender: { kind: string; agentId?: string } };
          returned = m;
          expect(() => ((m as { sender: unknown }).sender = { kind: "agent", agentId: "power" })).toThrow(TypeError);
          expect(() => (m.sender.kind = "agent")).toThrow(TypeError);
        },
      },
    ];
    const h = createHarness({ extensions: forging, scripts: { "test/rec": (req) => (seen.push(req), cooperative(req)) } });
    const config = testConfig();
    useModel(config, "test/rec");
    const runner = h.runner(config);
    expect((await runner.run()).termination?.outcome).toBe("SUCCESS");
    expect(returned).not.toBeNull();
    expect(Object.isFrozen(returned) && Object.isFrozen(returned!.sender)).toBe(true);
    for (const req of seen) expect(JSON.stringify(req.messages)).not.toContain("FORGED");
    expect(ofType(h.events(runner.id), "extension_error")).toHaveLength(0);
  });

  it("holdClock works only inside a hook; a hold its hook did not await ends with the hook", async () => {
    const outside: string[] = [];
    const holding: RunExtensionFactory = () => [
      {
        name: "hold",
        attach(ctx) {
          // A listener runs while agents' calls are in flight: holding the clock there would move the time limit.
          ctx.subscribe((event) => {
            if (event.type === "llm_call" && outside.length === 0) ctx.holdClock(async () => undefined).catch((err: Error) => outside.push(err.message));
          });
        },
        async beforePublish(_m, ctx) {
          void ctx.holdClock(() => sleep(400)); // not awaited
        },
      },
    ];
    const h = createHarness({ extensions: holding });
    const runner = h.runner(testConfig());
    const metrics = await runner.run();
    expect(metrics.termination?.outcome).toBe("SUCCESS");
    expect(outside).toEqual(["holdClock may only be used inside an extension hook"]);
    const errors = ofType(h.events(runner.id), "extension_error").map((e) => String(e.payload.message));
    expect(errors.some((m) => m.includes("a clock hold outlived its hook"))).toBe(true);
    expect(metrics.durationMs.presentation).toBeLessThan(400); // the stray holds did not keep the clock stopped
  });

  it("the experiment's duration and usage are fixed at the outcome: add-on work at the ending is not experiment time", async () => {
    const slowEnding: RunExtensionFactory = () => [{ name: "slow-ending", async onRunEnded() { await sleep(300); } }];
    const h = createHarness({ extensions: slowEnding });
    const runner = h.runner(testConfig());
    const metrics = await runner.run();
    expect(metrics.durationMs.wall).toBeGreaterThanOrEqual(290);
    expect(metrics.durationMs.active).toBeLessThan(250);
  });
});

describe("batch variables", () => {
  function setup() {
    const db = createInMemoryDb();
    const providers = new ProviderRegistry([], registerBuiltinStubs(new StubProvider()));
    const evaluators = createEvaluatorRegistry();
    const service = new ExperimentService({ db, providers, evaluators, extensions: presentationExtensions });
    return new BatchService({ db, providers, evaluators, service });
  }
  const problems = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      if (err instanceof BatchValidationError) return err.problems;
      throw err;
    }
    return [];
  };

  it("a typo in a path's last segment is a path error, not two identical conditions", () => {
    const found = problems(() => setup().resolve({ name: "typo", base: { builtin: "space-station" }, repetitions: 1, variables: [{ path: "agents.*.model.temprature", values: [0, 1.5] }] }));
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((p) => p.includes('"agents.*.model.temprature" is not a setting of this config'))).toBe(true);
  });

  it("two conditions that come out as one config are rejected", () => {
    // Two variables on one setting: the later one wins, so "a=10 | b=20" and "a=20 | b=20" are the same config.
    const found = problems(() =>
      setup().resolve({
        name: "same",
        base: { builtin: "space-station" },
        repetitions: 1,
        variables: [
          { path: "limits.globalTurnLimit", label: "a", values: [10, 20] },
          { path: "limits.globalTurnLimit", label: "b", values: [20] },
        ],
      })
    );
    expect(found).toEqual([`conditions "a=10 | b=20" and "a=20 | b=20" produce the same config — they would measure the same thing`]);
  });

  it("the size cap is checked before the cartesian product is built", () => {
    const values = Array.from({ length: 50 }, (_, i) => i);
    const variables = Array.from({ length: 6 }, (_, i) => ({ path: `limits.globalTurnLimit`, label: `v${i}`, values }));
    const t0 = Date.now();
    const found = problems(() => setup().resolve({ name: "huge", base: { builtin: "space-station" }, repetitions: 1, variables }));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(found[0]).toContain("the limit is");
  });
});

describe("Cascade evaluator v4", () => {
  const params = CascadeParamsSchema.parse(CASCADE_EVALUATOR.params);
  const lenient = CascadeParamsSchema.parse({ ...CASCADE_EVALUATOR.params, r3EvacuationMinutes: 3, baseReserveKw: 50 });
  const plan = (over: Partial<CascadeProposal>): CascadeProposal => ({
    recovery_path: "loop_b",
    actions: ["switch_beacon_to_battery", "shutdown_research_labs", "shutdown_external_communications", "route_power_to_loop_b", "start_loop_b", "scram_reactor"],
    life_support_power_kw: 40,
    ...over,
  });

  it("powered before use applies to a system run on the side, not only the declared path", () => {
    const sideDump = plan({ actions: ["route_power_to_loop_b", "start_loop_b", "evacuate_r3", "isolate_r3", "activate_thermal_dump_c", "route_power_to_thermal_dump_c", "scram_reactor"] });
    expect(evaluateCascade(sideDump, lenient).violated).toContain("dump_c_activated");
    const sideLoop = plan({
      recovery_path: "thermal_dump_c",
      actions: ["evacuate_r3", "isolate_r3", "route_power_to_thermal_dump_c", "activate_thermal_dump_c", "start_loop_b", "route_power_to_loop_b", "scram_reactor"],
    });
    expect(evaluateCascade(sideLoop, lenient).violated).toContain("loop_b_started");
  });

  it("each failure narrates its own figures: never 'X available, X required' for a system that was never powered", () => {
    const config = parseExperimentConfig(kestrelCascadeConfig());
    const ending = (p: CascadeProposal) => {
      const evaluation = evaluateCascade(p, params);
      return { evaluation, text: endingNarration(config, "en", termination("MISSION_FAILURE", "x"), evaluation, params)!.text };
    };
    const unrouted = ending(plan({ actions: ["switch_beacon_to_battery", "shutdown_research_labs", "shutdown_external_communications", "start_loop_b", "scram_reactor"] }));
    expect(unrouted.evaluation.violated).toEqual(["loop_b_started"]);
    expect(unrouted.text).toContain("does not power it before starting it");
    expect(unrouted.text).not.toMatch(/kW available/);

    // Shortfall at loop B's routing (comms still on): 22 kW available when 30 are needed — not the path total.
    const short = ending(plan({ actions: ["switch_beacon_to_battery", "shutdown_research_labs", "route_power_to_loop_b", "shutdown_external_communications", "route_power_to_thermal_dump_c", "start_loop_b", "scram_reactor"] }));
    expect(short.evaluation.violated).toContain("loop_b_power_sufficient");
    expect(short.text).toContain("22 kW available at that moment, 30 kW needed");
  });

  it("unknown evaluator params are errors, not silently replaced by defaults", () => {
    const config = kestrelCascadeConfig();
    (config.evaluator.params as Record<string, unknown>).loopBRequiredKW = 40;
    const providers = new ProviderRegistry([], registerBuiltinStubs(new StubProvider()));
    expect(() => checkRunnable({ providers, evaluators: createEvaluatorRegistry() }, parseExperimentConfig(config))).toThrow(/loopBRequiredKW/);
  });

  it("the evaluator version is part of the task definition", () => {
    const config = parseExperimentConfig(kestrelCascadeConfig());
    expect(taskDefinitionHash(config, "3")).not.toBe(taskDefinitionHash(config, "4"));
  });
});

describe("debrief addressing", () => {
  const config = parseExperimentConfig(kestrelConfig());
  const named = (text: string) => findNamedAgent(config, text)?.agentId ?? null;

  it("names match as whole words or aliases only — ordinary words never name anyone", () => {
    expect(named("Maybe, Viktor, why did you vote no?")).toBe("power");
    expect(named("Why did half the crew reject it?")).toBeNull();
    expect(named("Товарищ майор, что случилось?")).toBeNull();
    expect(named("Что было в сарае?")).toBeNull();
    expect(named("Вопрос Виктору: почему нет?")).toBe("power"); // an alias (Russian dative)
    expect(named("Спросите Майю")).toBe("life_support");
    expect(named("Maya Chen, hi")).toBe("life_support");
  });

  it("the keyword router matches whole words: 'fair' is not 'air', 'awkward' is not 'kw'", () => {
    const route = (q: string) => JSON.parse(spaceStationDebriefRouter({ model: "x", messages: [], context: { question: q } })).agentId;
    expect(route("Was that a fair decision?")).toBeNull();
    expect(route("That was awkward.")).toBeNull();
    expect(route("Was the air safe?")).toBe("life_support");
    expect(route("Сколько было мощности?")).toBe("power");
  });
});

describe("billed failures count", () => {
  it("an OpenRouter response that failed mid-way carries what it billed", async () => {
    const response = new Response(
      JSON.stringify({
        id: "gen-9",
        object: "chat.completion",
        created: 0,
        model: "m",
        choices: [{ index: 0, message: { role: "assistant", content: "{" }, finish_reason: "error" }],
        usage: { prompt_tokens: 120, completion_tokens: 7, total_tokens: 127, cost: 0.0004 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
    const provider = new OpenRouterProvider({ apiKey: "k", baseUrl: "https://example.test/v1", fetch: async () => response });
    const err = (await provider.complete({ model: "m", messages: [] }).catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(true);
    expect(err.billed).toMatchObject({ usage: { promptTokens: 120, completionTokens: 7 }, reportedCostUsd: 0.0004 });
  });

  it("the attempt's usage and cost are recorded and budgeted", async () => {
    const cooperative = spaceStationScript("cooperative");
    let failed = false;
    const flaky: LlmProvider = {
      id: "openrouter",
      async complete(req) {
        if (!failed) {
          failed = true;
          throw new ProviderError("upstream failed mid-response", true, undefined, {
            text: "{",
            requestedModel: req.model,
            servedModel: req.model,
            usage: { promptTokens: 100, completionTokens: 3 },
            reportedCostUsd: 0.002,
          });
        }
        return { text: String(cooperative(req)), requestedModel: req.model, servedModel: req.model, usage: { promptTokens: 1, completionTokens: 1 }, reportedCostUsd: 0 };
      },
    };
    const h = createHarness({ providers: [flaky] });
    const config = testConfig();
    for (const a of config.agents) a.model = { provider: "openrouter", model: "vendor/model", structuredOutput: "native" };
    const runner = h.runner(config);
    const metrics = await runner.run();
    expect(metrics.termination?.outcome).toBe("SUCCESS");
    const first = ofType(h.events(runner.id), "llm_call")[0]!.payload;
    expect(first).toMatchObject({ usage: { promptTokens: 100, completionTokens: 3 }, costUsd: 0.002, costSource: "reported" });
    expect(metrics.costUsd.total).toBeGreaterThanOrEqual(0.002);
  });
});
