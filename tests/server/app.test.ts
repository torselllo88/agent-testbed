import type { AddressInfo } from "node:net";
import type http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BatchService } from "../../src/batch/service.js";
import { ExperimentService } from "../../src/experiment/service.js";
import { HumanInteractionService } from "../../src/interaction/service.js";
import { OpenRouterModelCatalog } from "../../src/llm/openRouterModels.js";
import { ProviderRegistry } from "../../src/llm/registry.js";
import { StubProvider } from "../../src/llm/stubProvider.js";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { ExperimentRepository } from "../../src/persistence/experimentRepository.js";
import { createEvaluatorRegistry, registerBuiltinStubs } from "../../src/scenarios/index.js";
import { createApp } from "../../src/server/app.js";
import { spaceStationConfig } from "../../src/scenarios/spaceStation/config.js";
import { kestrelConfig } from "../../src/scenarios/spaceStation/kestrel.js";
import { script, turnJson } from "../helpers/harness.js";

let server: http.Server;
let baseUrl: string;
let service: ExperimentService;
let batches: BatchService;
let interaction: HumanInteractionService;
const db = createInMemoryDb();

beforeAll(async () => {
  const stub = registerBuiltinStubs(new StubProvider());
  stub.register("test/chatty", script({ discussion: () => turnJson({ message: "talking" }) }));
  const providers = new ProviderRegistry([], stub);
  const evaluators = createEvaluatorRegistry();
  service = new ExperimentService({ db, providers, evaluators });
  batches = new BatchService({ db, providers, evaluators, service });
  interaction = new HumanInteractionService({ db, providers, experiments: service });
  const catalogBody = { data: [{ id: "google/gemini-2.5-flash-lite", name: "Gemini Flash Lite", context_length: 1048576, pricing: { prompt: "0.0000001", completion: "0.0000004" }, supported_parameters: ["structured_outputs"] }] };
  const openRouterModels = new OpenRouterModelCatalog("https://openrouter.test/api/v1", (async () => new Response(JSON.stringify(catalogBody))) as unknown as typeof fetch);
  server = createApp({ db, providers, evaluators, service, batches, interaction, openRouterModels });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await service.settle();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe("HTTP basics", () => {
  it("serves /api/meta with providers, registries and builtin scenarios", async () => {
    const { status, body } = await call("GET", "/api/meta");
    expect(status).toBe(200);
    expect(body.providers.map((p: { id: string }) => p.id)).toEqual(["openrouter", "azure", "stub"]);
    expect(body.evaluators[0]).toMatchObject({ id: "space-station", version: "1" });
    expect(body.evaluators[0].proposalSchema.properties).toHaveProperty("coolant_loop");
    expect(body.schedulers).toEqual(["round_robin", "hybrid"]);
    expect(body.builtinScenarios.map((b: { id: string }) => b.id)).toEqual(["space-station", "station-kestrel", "station-kestrel-cascade"]);
    expect(body.builtinScenarios.every((b: { version: number }) => b.version >= 1)).toBe(true);
  });

  it("serves the OpenRouter model list for the editor", async () => {
    const { status, body } = await call("GET", "/api/providers/openrouter/models");
    expect(status).toBe(200);
    expect(body.models).toEqual([expect.objectContaining({ id: "google/gemini-2.5-flash-lite", promptPerM: 0.1, structuredOutputs: true })]);
  });

  it("serves the SPA shell and JSON 404s for unknown API routes", async () => {
    const page = await fetch(`${baseUrl}/`);
    expect(await page.text()).toContain("<title>Agent Testbed</title>");
    expect((await call("GET", "/api/nope")).status).toBe(404);
  });

  it("refuses POST without a JSON content type (no preflight-free cross-origin writes)", async () => {
    const res = await fetch(`${baseUrl}/api/scenarios`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" });
    expect(res.status).toBe(415);
  });
});

describe("scenarios API", () => {
  it("creates from a builtin, updates with version bump, duplicates, deletes", async () => {
    const created = await call("POST", "/api/scenarios", { builtin: "space-station" });
    expect(created.status).toBe(201);
    const id = created.body.scenario.id;
    expect(created.body.scenario.version).toBe(1);

    const config = { ...created.body.scenario.config, name: "Renamed" };
    const updated = await call("PUT", `/api/scenarios/${id}`, { config });
    expect(updated.body.scenario).toMatchObject({ name: "Renamed", version: 2 });
    // Saving identical content is a no-op, not a new version.
    expect((await call("PUT", `/api/scenarios/${id}`, { config })).body.scenario.version).toBe(2);

    const dup = await call("POST", `/api/scenarios/${id}/duplicate`, {});
    expect(dup.body.scenario.name).toBe("Renamed (copy)");

    expect((await call("DELETE", `/api/scenarios/${dup.body.scenario.id}`)).status).toBe(200);
    expect((await call("GET", `/api/scenarios/${dup.body.scenario.id}`)).status).toBe(404);
  });

  it("rejects invalid configs with every problem listed", async () => {
    const config = spaceStationConfig();
    config.decision.proposerId = "nobody";
    const res = await call("POST", "/api/scenarios", { config });
    expect(res.status).toBe(400);
    expect(res.body.problems).toEqual(expect.arrayContaining([expect.stringContaining("decision.proposerId")]));
  });

  it("validate reports schema and runnability problems without saving anything", async () => {
    const ok = await call("POST", "/api/scenarios/validate", { config: spaceStationConfig() });
    expect(ok.body).toMatchObject({ ok: true, problems: [] });

    const config = spaceStationConfig();
    config.agents[0]!.model = { provider: "openrouter", model: "x/y", structuredOutput: "native" };
    const bad = await call("POST", "/api/scenarios/validate", { config });
    expect(bad.body.ok).toBe(false);
    expect(bad.body.problems[0]).toMatch(/openrouter.*not configured/);
  });
});

describe("experiments API", () => {
  it("runs a saved scenario, streams events incrementally, exports, and reruns with the same config", async () => {
    const { body: created } = await call("POST", "/api/scenarios", { builtin: "space-station" });
    const run = await call("POST", `/api/scenarios/${created.scenario.id}/run`, {});
    expect(run.status).toBe(201);
    const id = run.body.id;
    await service.settle();

    const { body } = await call("GET", `/api/experiments/${id}`);
    expect(body.running).toBe(false);
    expect(body.experiment).toMatchObject({ outcome: "SUCCESS", scenarioId: created.scenario.id, scenarioVersion: 1 });

    const all = (await call("GET", `/api/experiments/${id}/events`)).body.events;
    const tail = (await call("GET", `/api/experiments/${id}/events?after=${all.length - 3}`)).body.events;
    expect(tail.map((e: { seq: number }) => e.seq)).toEqual([all.length - 2, all.length - 1, all.length]);

    const exported = await call("GET", `/api/experiments/${id}/export`);
    expect(exported.body.events).toHaveLength(all.length);
    expect(exported.body.experiment.config.name).toBe("Space Station Benchmark");

    const rerun = await call("POST", `/api/experiments/${id}/rerun`, {});
    await service.settle();
    const rerunRecord = (await call("GET", `/api/experiments/${rerun.body.id}`)).body.experiment;
    expect(rerunRecord.configHash).toBe(body.experiment.configHash);

    const list = (await call("GET", `/api/experiments?scenarioId=${created.scenario.id}`)).body.experiments;
    expect(list.map((e: { id: string }) => e.id).sort()).toEqual([id, rerun.body.id].sort());
  });

  it("controls a running experiment; control of a finished one is a 409", async () => {
    const config = spaceStationConfig();
    for (const agent of config.agents) agent.model = { provider: "stub", model: "test/chatty", structuredOutput: "native" };
    config.limits.discussionTurnLimit = 500;
    config.limits.globalTurnLimit = 500;
    const { body } = await call("POST", "/api/experiments", { config });
    const id = body.id;

    const paused = await call("POST", `/api/experiments/${id}/control`, { type: "pause" });
    expect(paused.body.live.paused).toBe(true);
    expect((await call("POST", `/api/experiments/${id}/control`, { type: "select_next", agentId: "nobody" })).status).toBe(409);
    expect((await call("POST", `/api/experiments/${id}/control`, { type: "bogus" })).status).toBe(400);
    expect((await call("DELETE", `/api/experiments/${id}`)).status).toBe(409);

    await call("POST", `/api/experiments/${id}/control`, { type: "stop" });
    await service.settle();
    const record = (await call("GET", `/api/experiments/${id}`)).body.experiment;
    expect(record).toMatchObject({ outcome: "STOPPED_BY_OPERATOR", intervened: true });
    expect((await call("POST", `/api/experiments/${id}/control`, { type: "resume" })).status).toBe(409);
  });

  it("rejects a non-runnable config with 400 before creating a run", async () => {
    const config = spaceStationConfig();
    config.agents[0]!.model = { provider: "stub", model: "does/not-exist", structuredOutput: "native" };
    const before = new ExperimentRepository(db).list().length;
    const res = await call("POST", "/api/experiments", { config });
    expect(res.status).toBe(400);
    expect(res.body.problems[0]).toMatch(/unknown stub model/);
    expect(new ExperimentRepository(db).list().length).toBe(before);
  });
});

describe("batches API", () => {
  const spec = {
    name: "api batch",
    base: { builtin: "space-station" },
    repetitions: 2,
    variables: [{ path: "consensus.rule", label: "consensus", values: ["unanimity", "majority"] }],
  };

  it("previews conditions without running anything, and reports problems", async () => {
    const ok = await call("POST", "/api/batches/preview", { spec });
    expect(ok.body).toMatchObject({ ok: true, totalRuns: 4 });
    expect(ok.body.conditions.map((c: { key: string }) => c.key)).toEqual(["consensus=unanimity", "consensus=majority"]);

    const bad = await call("POST", "/api/batches/preview", { spec: { ...spec, variables: [{ path: "consensus.rule", values: ["dictator"] }] } });
    expect(bad.body.ok).toBe(false);
    expect(bad.body.problems[0]).toMatch(/consensus.rule/);
    expect((await call("POST", "/api/batches", { spec: { ...spec, repetitions: 0 } })).status).toBe(400);
  });

  it("runs a batch and serves aggregates, CSV and JSON export", async () => {
    const created = await call("POST", "/api/batches", { spec });
    expect(created.status).toBe(201);
    const id = created.body.batch.id;
    await batches.settle(id);

    const view = (await call("GET", `/api/batches/${id}`)).body;
    expect(view.batch.status).toBe("completed");
    expect(view.aggregates.map((a: { key: string; success: number }) => [a.key, a.success])).toEqual([
      ["consensus=unanimity", 2],
      ["consensus=majority", 2],
    ]);
    expect((await call("GET", "/api/batches")).body.batches.find((b: { id: string }) => b.id === id)).toMatchObject({
      progress: { total: 4, finished: 4 },
    });

    const csv = await fetch(`${baseUrl}/api/batches/${id}/export?format=csv`);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect((await csv.text()).trim().split("\n")).toHaveLength(5);
    const json = (await call("GET", `/api/batches/${id}/export`)).body;
    expect(json.runs).toHaveLength(4);
    expect(json.batch.resolved.baseConfig.name).toBe("Space Station Benchmark");

    expect((await call("POST", `/api/batches/${id}/cancel`, {})).status).toBe(409);
    expect((await call("GET", `/api/batches/nope`)).status).toBe(404);
  });
});

describe("restart recovery", () => {
  it("closes runs cut off by a restart as INTERRUPTED, with a final event", async () => {
    const repo = new ExperimentRepository(db);
    const config = spaceStationConfig();
    const { parseExperimentConfig } = await import("../../src/experiment/config.js");
    repo.create({
      id: "orphan-1",
      config: parseExperimentConfig(config),
      configHash: "h",
      testbedVersion: { packageVersion: "0", gitCommit: null, gitDirty: null, nodeVersion: "x" },
    });
    expect(service.recoverInterrupted()).toContain("orphan-1");
    expect(repo.getOrThrow("orphan-1")).toMatchObject({ outcome: "INTERRUPTED", status: "ABORTED", phase: "FINISHED" });
    const events = (await call("GET", "/api/experiments/orphan-1/events")).body.events;
    expect(events.at(-1)).toMatchObject({ type: "experiment_finished", payload: { recovered: true } });
  });
});

describe("scenario library + run overrides", () => {
  it("lists managed built-ins first as read-only, refuses edits/deletes, allows duplicate and run with a language override", async () => {
    const { ScenarioRepository } = await import("../../src/persistence/scenarioRepository.js");
    const { BUILTIN_SCENARIOS } = await import("../../src/scenarios/index.js");
    new ScenarioRepository(db).syncBuiltins(BUILTIN_SCENARIOS);

    const list = (await call("GET", "/api/scenarios")).body.scenarios;
    const kestrel = list.find((s: { name: string }) => s.name === "Station Kestrel");
    expect(list[0]).toMatchObject({ readOnly: true, name: "Space Station Benchmark" });
    expect(kestrel).toMatchObject({ readOnly: true, narrated: true, paced: true, language: "en", presentationLanguages: ["en", "ru"] });
    expect(kestrel.taskDefinitionHash).toBe(list[0].taskDefinitionHash);

    const full = (await call("GET", `/api/scenarios/${kestrel.id}`)).body.scenario;
    expect((await call("PUT", `/api/scenarios/${kestrel.id}`, { config: full.config })).status).toBe(409);
    expect((await call("DELETE", `/api/scenarios/${kestrel.id}`)).status).toBe(409);
    expect((await call("POST", `/api/scenarios/${kestrel.id}/duplicate`, {})).body.scenario).toMatchObject({ builtin: null });

    expect((await call("POST", `/api/scenarios/${kestrel.id}/run`, { overrides: { language: "not a code!" } })).status).toBe(400);
    const run = await call("POST", `/api/scenarios/${kestrel.id}/run`, { overrides: { language: "ru" } });
    expect(run.status).toBe(201);
    await call("POST", `/api/experiments/${run.body.id}/control`, { type: "stop" });
    await service.settle();
    const experiment = (await call("GET", `/api/experiments/${run.body.id}`)).body.experiment;
    expect(experiment.config.conversation.language).toBe("ru");
    expect(experiment.scenarioId).toBe(kestrel.id);
    // The saved scenario is untouched.
    expect((await call("GET", `/api/scenarios/${kestrel.id}`)).body.scenario.config.conversation.language).toBe("en");
    const byTask = (await call("GET", `/api/experiments?taskDefinitionHash=${kestrel.taskDefinitionHash}`)).body.experiments;
    expect(byTask.map((e: { id: string }) => e.id)).toContain(run.body.id);
  });
});

describe("human interaction API", () => {
  it("room messages are chat only, the debrief is operated through its own endpoint, and it all stays out of the experiment", async () => {
    const config = kestrelConfig();
    config.presentation.pacing = { minVisibleIntervalMs: 0, perCharMs: 0, maxGapMs: 0 };
    const run = await call("POST", "/api/experiments", { config });
    const id = run.body.id;
    // Text that looks like an operator command, posted as a person in the room.
    const posted = await call("POST", `/api/experiments/${id}/room/messages`, { senderId: "u1", displayName: "Nikita", text: "STOP" });
    expect(posted.status).toBe(201);
    await service.settle();
    await interaction.settle();

    const { body } = await call("GET", `/api/experiments/${id}`);
    expect(body.experiment).toMatchObject({ outcome: "SUCCESS", intervened: false });
    const events = (await call("GET", `/api/experiments/${id}/events`)).body.events;
    expect(events.some((e: { type: string }) => e.type === "operator_intervention")).toBe(false);

    const view = (await call("GET", `/api/experiments/${id}/interaction`)).body;
    expect(view).toMatchObject({ profile: "DEBRIEF", mode: "debrief", session: { number: 1, status: "OPEN" } });
    expect(view.events.map((e: { type: string }) => e.type)).toContain("debrief_started");

    const question = await call("POST", `/api/experiments/${id}/room/messages`, { senderId: "u1", displayName: "Nikita", text: "Viktor, what happened?" });
    expect(question.body).toMatchObject({ disposition: "question", queued: { position: 1 } });
    await interaction.settle();

    expect((await call("POST", `/api/experiments/${id}/debrief`, { action: "open" })).status).toBe(409); // already open
    expect((await call("POST", `/api/experiments/${id}/debrief`, { action: "close" })).body.session).toMatchObject({ status: "CLOSED" });
    expect((await call("POST", `/api/experiments/${id}/debrief`, { action: "open" })).body.session).toMatchObject({ number: 2, openedBy: "operator" });
    expect((await call("POST", `/api/experiments/${id}/room/messages`, { senderId: "u1", displayName: "", text: "x" })).status).toBe(400);
    expect((await call("GET", `/api/experiments/nope/interaction`)).status).toBe(404);

    const meta = (await call("GET", "/api/meta")).body;
    expect(meta.humanInteraction.profiles).toMatchObject({ DEBRIEF: { supported: true }, TAKE_ROLE: { supported: false } });
    expect((await call("DELETE", `/api/experiments/${id}`)).status).toBe(200);
  });
});
