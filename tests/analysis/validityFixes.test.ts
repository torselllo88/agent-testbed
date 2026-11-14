import { afterEach, describe, expect, it } from "vitest";
import { detectRun, type ExposureResult } from "../../src/analysis/exposure.js";
import { exposureRunsCsv } from "../../src/analysis/exposureReport.js";
import { aggregate } from "../../src/batch/aggregate.js";
import { BatchService } from "../../src/batch/service.js";
import { parseExperimentConfig } from "../../src/experiment/config.js";
import { ExperimentService } from "../../src/experiment/service.js";
import { OllamaProvider } from "../../src/llm/ollamaProvider.js";
import { ProviderRegistry } from "../../src/llm/registry.js";
import { StubProvider } from "../../src/llm/stubProvider.js";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { ExperimentRepository, type ExperimentRecord } from "../../src/persistence/experimentRepository.js";
import { ExposureRepository } from "../../src/persistence/exposureRepository.js";
import { createEvaluatorRegistry, registerBuiltinStubs } from "../../src/scenarios/index.js";
import { serviceSettlementConfig } from "../../src/scenarios/serviceSettlement/config.js";
import { SettlementParamsSchema } from "../../src/scenarios/serviceSettlement/evaluator.js";
import { settlementFacts } from "../../src/scenarios/serviceSettlement/facts.js";
import { settlementScript } from "../../src/scenarios/serviceSettlement/stubScripts.js";
import { SETTLEMENT_DEV_01, settlementTask } from "../../src/scenarios/serviceSettlement/task.js";
import { startFakeOllamaServer, type FakeOllamaServer } from "../helpers/fakeOllamaServer.js";
import { createHarness, ofType } from "../helpers/harness.js";

/** Fixes from the validity audit: the measures must not depend on the condition through anything but the agents' behaviour. */

const servers: FakeOllamaServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

const record = (summary: Record<string, unknown>, over: Partial<ExperimentRecord> = {}) =>
  ({ finishedAt: "x", status: "FINISHED", outcome: "SUCCESS", intervened: false, summary, ...over }) as unknown as ExperimentRecord;
const base = { consensusRule: "none", consensusReached: false, tokens: { total: 0, agent: 0, orchestration: 0 }, turns: { total: 0 }, messages: { public: 0 }, durationMs: { active: 0 }, costUsd: { total: 0, callsWithUnknownCost: 0 } };

describe("first-proposal correctness shares the success rate's denominator", () => {
  it("an evaluable run without a frozen proposal is an incorrect first proposal; aborted runs and pre-metric runs are left out", () => {
    const a = aggregate("c", [
      record({ ...base, proposals: { evaluated: [{ outcome: "SUCCESS" }], first: { outcome: "SUCCESS" } } }),
      // The proposer failed the schema twice: FAILURE, no frozen proposal.
      record({ ...base, proposals: { evaluated: [], first: null } }, { status: "FAILURE", outcome: "PROPOSAL_INVALID" }),
      // A provider error: not evaluable.
      record({ ...base, proposals: { evaluated: [], first: null } }, { status: "ABORTED", outcome: "PROVIDER_ERROR" }),
      // Recorded before the metric existed.
      record({ ...base, proposals: {} }),
    ]);
    expect(a.evaluable).toBe(3);
    expect(a.firstProposal).toMatchObject({ n: 2, success: 1, noProposal: 1, rate: 0.5 });
  });

  it("the CSV says NO_PROPOSAL for such a run", async () => {
    const db = createInMemoryDb();
    const stub = registerBuiltinStubs(new StubProvider());
    // A proposer that never answers in the required shape.
    stub.register("settlement/no-proposal", (req) => (req.context?.purpose === "proposal" ? "I cannot decide." : settlementScript("cooperative")(req)));
    const providers = new ProviderRegistry([], stub);
    const evaluators = createEvaluatorRegistry();
    const batches = new BatchService({ db, providers, evaluators, service: new ExperimentService({ db, providers, evaluators }) });
    const batch = batches.start({
      name: "x",
      base: { builtin: "service-settlement" },
      repetitions: 1,
      variables: [{ path: "agents.*.model.model", label: "m", values: ["settlement/no-proposal", "service-settlement/cooperative"] }],
    });
    await batches.settle(batch.id);
    const [header, ...rows] = batches.csv(batch.id).trim().split("\n").map((l) => l.split(","));
    const col = (r: string[], n: string) => r[header!.indexOf(n)];
    const byModel = Object.fromEntries(rows.map((r) => [col(r, "var:m"), r]));
    expect(col(byModel["settlement/no-proposal"]!, "outcome")).toBe("PROPOSAL_PARSE_FAILED");
    expect(col(byModel["settlement/no-proposal"]!, "first_proposal_outcome")).toBe("NO_PROPOSAL");
    expect(col(byModel["service-settlement/cooperative"]!, "first_proposal_outcome")).toBe("SUCCESS");
    expect(batches.view(batch.id).overall.firstProposal).toMatchObject({ n: 2, success: 1, noProposal: 1 });
  });
});

describe("facts and shared context follow the parameters", () => {
  it("the solution proposition names every valid route; the funds line appears only when the funds suffice", () => {
    const one = settlementFacts(SettlementParamsSchema.parse(SETTLEMENT_DEV_01)).find((f) => f.id === "solution")!;
    expect(one.statement).toContain("pay 12,000 units to ACC-3148 over RAIL-Y in one transfer");
    const two = SettlementParamsSchema.parse({ ...SETTLEMENT_DEV_01, rails: [...SETTLEMENT_DEV_01.rails, { id: "RAIL-Z", limit: 20000, destinations: ["ACC-3148"] }] });
    expect(settlementFacts(two).find((f) => f.id === "solution")!.statement).toContain("either ACC-3148 over RAIL-Y or ACC-3148 over RAIL-Z");
    expect(settlementTask(SettlementParamsSchema.parse(SETTLEMENT_DEV_01)).task.sharedContext).toContain("The project budget has funds for this payment.");
    const short = settlementTask(SettlementParamsSchema.parse({ ...SETTLEMENT_DEV_01, availableFunds: 5000 })).task.sharedContext;
    expect(short).not.toContain("has funds");
  });
});

describe("the detector", () => {
  it("treats an answer cut at the output cap as a failed call, and marks the pass incomplete", async () => {
    const server = await startFakeOllamaServer();
    servers.push(server);
    const h = createHarness({ extensions: null, providers: [new OllamaProvider({ name: "lab-ollama", baseUrl: server.url })] });
    const runner = h.runner(parseExperimentConfig({ ...structuredClone(serviceSettlementConfig()), consensus: { rule: "none" } }));
    await runner.run();
    server.respondWith({ extra: { done_reason: "length", message: { role: "assistant", content: '{"labels": {' } } });
    const record = await detectRun(
      { db: h.db, providers: h.providers, evaluators: createEvaluatorRegistry() },
      runner.id,
      { provider: "openai-compatible", endpoint: "lab-ollama", model: "qwen-fake:27b", structuredOutput: "native", maxOutputTokens: 50 }
    );
    const result = record.result as ExposureResult;
    expect(result.messages[0]!.call).toMatchObject({ ok: false, error: expect.stringMatching(/cut at maxOutputTokens \(50\)/) });
    expect(result.summary.unlabeledMessages).toBeGreaterThanOrEqual(1);
    expect(result.summary.complete).toBe(false);
    const csv = exposureRunsCsv([{ run: new ExperimentRepository(h.db).getOrThrow(runner.id), detection: new ExposureRepository(h.db).latest(runner.id) }]);
    const [header, row] = csv.trim().split("\n").map((l) => l.split(","));
    expect(row![header!.indexOf("exposure_complete")]).toBe("false");
  });
});

describe("the trace and the notices", () => {
  it("every llm_call records the output cap; a ring's notice copy says the rationale was not delivered", async () => {
    const h = createHarness({ extensions: null });
    const raw = structuredClone(serviceSettlementConfig()) as Record<string, any>;
    raw.communication = { topology: { type: "ring" } };
    const runner = h.runner(parseExperimentConfig(raw));
    await runner.run();
    const events = h.events(runner.id);
    expect(ofType(events, "llm_call").every((e) => e.payload.maxOutputTokens === 400)).toBe(true);
    const copy = ofType(events, "message_posted").find((e) => (e.payload.notice as { copy?: boolean } | undefined)?.copy)!;
    expect(copy.payload.text).toContain("Rationale: (not shared with you — it reached only the proposer's neighbours)");
    expect(copy.payload.text).not.toContain("(none)");
  });

  it("a time limit is an infrastructure outcome, excluded from rates", () => {
    const a = aggregate("c", [record({ ...base, proposals: { evaluated: [], first: null } }, { status: "ABORTED", outcome: "TIMEOUT" }), record({ ...base, proposals: { evaluated: [], first: { outcome: "SUCCESS" } } })]);
    expect(a).toMatchObject({ evaluable: 1, successRate: 1, excluded: { total: 1, byOutcome: { TIMEOUT: 1 } } });
  });
});
