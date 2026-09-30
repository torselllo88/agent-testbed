import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { ConfigValidationError, parseExperimentConfig } from "../../src/experiment/config.js";
import { ProviderRegistry } from "../../src/llm/registry.js";
import { StubProvider } from "../../src/llm/stubProvider.js";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { ExperimentRepository } from "../../src/persistence/experimentRepository.js";
import { InteractionRepository } from "../../src/persistence/interactionRepository.js";
import { ScenarioRepository } from "../../src/persistence/scenarioRepository.js";
import { BUILTIN_SCENARIOS, createEvaluatorRegistry, registerBuiltinStubs } from "../../src/scenarios/index.js";
import { kestrelConfig } from "../../src/scenarios/spaceStation/kestrel.js";
import { createApp } from "../../src/server/app.js";
import { composeTestbed } from "../../src/server/compose.js";

/** Regression tests for the review findings in the interaction, rooms and server layers. */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function testbed(latencyMs = 0) {
  const db = createInMemoryDb();
  const scenarios = new ScenarioRepository(db);
  scenarios.syncBuiltins(BUILTIN_SCENARIOS);
  const config = kestrelConfig();
  config.presentation.pacing = { minVisibleIntervalMs: 0, perCharMs: 0, maxGapMs: 0 };
  config.runtime.providerRetryDelayMs = 0;
  const fast = scenarios.create(config);
  const providers = new ProviderRegistry([], registerBuiltinStubs(new StubProvider(latencyMs)));
  const composed = composeTestbed({ db, providers, evaluators: createEvaluatorRegistry(), externalScenarios: [fast.id] });
  return { db, providers, fast, ...composed };
}

const PARTICIPANTS = ["operations", "engineering", "power", "life_support", "system"].map((id) => ({ participantId: id, externalUserId: `@${id}:example.org` }));

describe("interaction review fixes", () => {
  it("deleting an experiment while a debrief answer is in flight does not crash the process", async () => {
    const t = testbed(40);
    const { runner, done } = t.service.start({ config: t.fast.config });
    await done;
    await t.interaction.settle();
    await t.interaction.receive(runner.id, { senderId: "u1", displayName: "Nikita", text: "Viktor, why?", replyTo: null, mentions: [] });
    // The answer's LLM call is now in flight; delete the experiment as the operator API does.
    t.interaction.forget(runner.id);
    new ExperimentRepository(t.db).delete(runner.id);
    await sleep(120);
    await t.interaction.settle(); // an unhandled rejection would fail this test
    expect(new InteractionRepository(t.db).listSessions(runner.id)).toEqual([]);
  });
});

describe("rooms review fixes", () => {
  it("an inbound message whose processing failed is processed again on retry (the reservation is released)", async () => {
    const t = testbed();
    const binding = t.rooms.start({ scenarioId: t.fast.id, room: { provider: "test", roomId: "!r1" }, participants: PARTICIPANTS });
    await t.service.settle();
    await t.interaction.settle();
    const original = t.interaction.receive.bind(t.interaction);
    let calls = 0;
    t.interaction.receive = (async (...args: Parameters<typeof original>) => {
      calls += 1;
      if (calls === 1) throw new Error("transient failure");
      return original(...args);
    }) as typeof original;
    const message = { externalEventId: "$q1", sender: { externalUserId: "@alice:example.org", displayName: "Alice" }, body: "Viktor, why?" };
    await expect(t.rooms.inbound(binding.bindingId, message)).rejects.toThrow("transient failure");
    const retry = await t.rooms.inbound(binding.bindingId, message);
    expect(retry).toMatchObject({ status: "accepted", disposition: "question" });
    expect((await t.rooms.inbound(binding.bindingId, message)).status).toBe("duplicate");
    await t.interaction.settle();
  });

  it("a closed binding gets nothing more: no automatic debrief, no outbox writes", async () => {
    const t = testbed();
    const binding = t.rooms.start({ scenarioId: t.fast.id, room: { provider: "test", roomId: "!r2" }, participants: PARTICIPANTS });
    await t.service.settle();
    await t.interaction.settle();
    t.rooms.close(binding.bindingId);
    const before = t.rooms.view(binding.bindingId).delivery.lastSeq;
    expect(t.rooms.mayOpenDebrief(binding.experimentId)).toBe(false);
    await t.rooms.post(binding.experimentId, { sender: { kind: "notice", name: "X" }, text: "late notice" });
    expect(t.rooms.view(binding.bindingId).delivery.lastSeq).toBe(before);
    expect(t.interaction.isDebriefOpen(binding.experimentId)).toBe(false);
  });

  it("several participants may share one external identity (a room system with a single bot)", async () => {
    const t = testbed();
    const shared = PARTICIPANTS.map((p) => ({ ...p, externalUserId: "@bot:example.org" }));
    const binding = t.rooms.start({ scenarioId: t.fast.id, room: { provider: "test", roomId: "!r3" }, participants: shared });
    expect(binding.state).toBe("ACTIVE");
    await t.service.settle();
    await t.interaction.settle();
  });

  it('the agent id "system" is reserved for the room\'s system voice', () => {
    const config = kestrelConfig();
    config.agents[0]!.id = "system";
    config.decision.proposerId = "system";
    expect(() => parseExperimentConfig(config)).toThrow(ConfigValidationError);
  });
});

describe("persistence and server review fixes", () => {
  it("recovery leaves rows of another live process alone and closes those of a silent one (pid reuse cannot fool it)", () => {
    const t = testbed();
    const repo = new ExperimentRepository(t.db);
    const now = new Date().toISOString();
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    t.db.prepare(`INSERT INTO process_leases (owner_id, pid, heartbeat_at) VALUES ('proc_live', ?, ?), ('proc_dead', ?, ?)`).run(process.pid, now, process.pid, stale);
    const ids = { live: "run-of-a-live-cli", dead: "run-of-a-crashed-process", unknown: "run-without-owner" };
    for (const id of Object.values(ids)) repo.create({ id, config: kestrelConfig(), configHash: "h", testbedVersion: { version: "test" } as never });
    t.db.prepare(`UPDATE experiments SET owner_id = 'proc_live' WHERE id = ?`).run(ids.live);
    t.db.prepare(`UPDATE experiments SET owner_id = 'proc_dead' WHERE id = ?`).run(ids.dead); // same pid, but a stale heartbeat
    t.db.prepare(`UPDATE experiments SET owner_id = NULL WHERE id = ?`).run(ids.unknown); // rows from before owners existed
    expect(t.service.recoverInterrupted().sort()).toEqual([ids.dead, ids.unknown].sort());
    expect(repo.getOrThrow(ids.live).finishedAt).toBeNull();
  });

  it("a batch left running by a crashed owner can be closed as interrupted through cancel", async () => {
    const t = testbed();
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    t.db.prepare(`INSERT INTO process_leases (owner_id, pid, heartbeat_at) VALUES ('proc_gone', 1, ?)`).run(stale);
    const { BatchRepository } = await import("../../src/persistence/batchRepository.js");
    const record = new BatchRepository(t.db).create("orphan", t.batches.resolve({ name: "orphan", base: { config: t.fast.config }, repetitions: 1 }));
    t.db.prepare(`UPDATE batches SET owner_id = 'proc_gone' WHERE id = ?`).run(record.id);
    expect(t.batches.closeOrphan(record.id)).toBe(true);
    expect(new BatchRepository(t.db).get(record.id)?.status).toBe("interrupted");
  });

  it("the operator API refuses requests for a foreign Host (DNS rebinding)", async () => {
    const t = testbed();
    const server = createApp({ db: t.db, providers: t.providers, evaluators: createEvaluatorRegistry(), service: t.service, batches: t.batches, interaction: t.interaction });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const get = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, path: "/api/meta", headers: { Host: host } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
    expect(await get(`127.0.0.1:${port}`)).toBe(200);
    expect(await get(`localhost:${port}`)).toBe(200);
    expect(await get(`attacker.example:${port}`)).toBe(421);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe("second review round", () => {
  it("a mention of a shared identity names nobody: the question is routed by the text instead", async () => {
    const t = testbed();
    const shared = PARTICIPANTS.map((p) => ({ ...p, externalUserId: "@bot:example.org" }));
    const binding = t.rooms.start({ scenarioId: t.fast.id, room: { provider: "test", roomId: "!shared" }, participants: shared });
    await t.service.settle();
    await t.interaction.settle();
    await t.rooms.inbound(binding.bindingId, {
      externalEventId: "$q-shared",
      sender: { externalUserId: "@alice:example.org", displayName: "Alice" },
      body: "Viktor, why did it work?",
      mentions: ["@bot:example.org"],
    });
    await t.interaction.settle();
    const route = new InteractionRepository(t.db).listEvents(binding.experimentId).find((e) => e.type === "debrief_route_decided")!;
    expect(route.payload).toMatchObject({ agentId: "power", source: "name" });
  });

  it("a scenario saved before debrief.router existed still routes with its scheduler's classifier; an explicit null does not", async () => {
    const routerCalls = async (router: "absent" | null) => {
      const t = testbed();
      const config = structuredClone(t.fast.config) as ReturnType<typeof kestrelConfig>;
      if (router === "absent") delete (config.humanInteraction!.debrief as { router?: unknown }).router;
      else config.humanInteraction!.debrief.router = null;
      const { runner, done } = t.service.start({ config });
      await done;
      await t.interaction.settle();
      await t.interaction.receive(runner.id, { senderId: "u1", displayName: "Nikita", text: "What do you all think?", replyTo: null, mentions: [] });
      await t.interaction.settle();
      return new InteractionRepository(t.db).listEvents(runner.id).filter((e) => e.type === "debrief_llm_call" && e.payload.purpose === "debrief_router");
    };
    const legacy = await routerCalls("absent");
    expect(legacy).toHaveLength(1);
    expect(legacy[0]!.payload.requestedModel).toBe("router/next-in-order"); // Kestrel's scheduler classifier
    expect(await routerCalls(null)).toHaveLength(0);
  });
});
