import { spawnSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import { ConfigValidationError, parseExperimentConfig } from "../../src/experiment/config.js";
import { ProviderRegistry } from "../../src/llm/registry.js";
import { StubProvider } from "../../src/llm/stubProvider.js";
import { createInMemoryDb, forgetLeaseObservations, FROZEN_OWNER_TTL_MS, setLeaseClockForTests } from "../../src/persistence/db.js";
import { ExperimentRepository } from "../../src/persistence/experimentRepository.js";
import { InteractionRepository } from "../../src/persistence/interactionRepository.js";
import { RoomRepository } from "../../src/persistence/roomRepository.js";
import { ScenarioRepository } from "../../src/persistence/scenarioRepository.js";
import { BUILTIN_SCENARIOS, createEvaluatorRegistry, registerBuiltinStubs } from "../../src/scenarios/index.js";
import { kestrelConfig } from "../../src/scenarios/spaceStation/kestrel.js";
import { createApp } from "../../src/server/app.js";
import { composeTestbed } from "../../src/server/compose.js";

/** Regression tests for the review findings in the interaction, rooms and server layers. */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The pid of a process that has just exited. */
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;

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
  it("recovery: a crashed owner's rows at once; a silent one's after a lease (another host) or the freeze timeout (its pid lives on); a live one's never", () => {
    const t = testbed();
    const repo = new ExperimentRepository(t.db);
    let mono = 1_000_000;
    setLeaseClockForTests(t.db, () => mono);
    let wall = Date.now();
    const iso = (msAgo: number) => new Date((wall += 1) - msAgo).toISOString(); // every beat a distinct timestamp
    const lease = t.db.prepare(`INSERT INTO process_leases (owner_id, pid, host, heartbeat_at) VALUES (?, ?, ?, ?)`);
    lease.run("proc_live", process.pid, os.hostname(), iso(0));
    lease.run("proc_crashed", deadPid(), os.hostname(), iso(0)); // restarted within its lease: the pid is gone
    lease.run("proc_silent", process.pid, os.hostname(), iso(10 * 60_000)); // stale — but its pid lives on (frozen, or reused)
    lease.run("proc_remote", 4242, "another-host", iso(10 * 60_000)); // stale, and no pid to check here
    lease.run("proc_jumped", process.pid, os.hostname(), iso(10 * 60_000)); // looks stale after a clock jump, still beating
    const ids = { live: "run-live", crashed: "run-crashed", silent: "run-silent", remote: "run-remote", jumped: "run-jumped", unknown: "run-without-owner" };
    for (const id of Object.values(ids)) repo.create({ id, config: kestrelConfig(), configHash: "h", testbedVersion: { version: "test" } as never });
    const own = t.db.prepare(`UPDATE experiments SET owner_id = ? WHERE id = ?`);
    own.run("proc_live", ids.live);
    own.run("proc_crashed", ids.crashed);
    own.run("proc_silent", ids.silent);
    own.run("proc_remote", ids.remote);
    own.run("proc_jumped", ids.jumped);
    own.run(null, ids.unknown); // rows from before owners existed

    expect(t.service.recoverInterrupted().sort()).toEqual([ids.crashed, ids.unknown].sort());

    const beat = t.db.prepare(`UPDATE process_leases SET heartbeat_at = ? WHERE owner_id = ?`);
    mono += 61_000;
    beat.run(iso(0), "proc_live");
    beat.run(iso(9 * 60_000), "proc_jumped"); // moved: alive, whatever the wall clock says
    // This process was suspended meanwhile: what it saw before says nothing — everyone gets a whole lease again.
    forgetLeaseObservations(t.db);
    expect(t.service.recoverInterrupted()).toEqual([]);

    mono += 61_000;
    beat.run(iso(0), "proc_live");
    beat.run(iso(8 * 60_000), "proc_jumped");
    // Another host: a whole lease without a beat is enough. Here, a pid that still exists holds out much longer.
    expect(t.service.recoverInterrupted()).toEqual([ids.remote]);

    mono += FROZEN_OWNER_TTL_MS - 2 * 61_000; // the silent owner has been watched since the reset, 61 s ago
    beat.run(iso(0), "proc_live");
    beat.run(iso(7 * 60_000), "proc_jumped");
    expect(t.service.recoverInterrupted()).toEqual([]); // still within the freeze timeout
    mono += 61_000;
    beat.run(iso(0), "proc_live");
    beat.run(iso(6 * 60_000), "proc_jumped");
    expect(t.service.recoverInterrupted()).toEqual([ids.silent]);
    for (const id of [ids.live, ids.jumped]) expect(repo.getOrThrow(id).finishedAt).toBeNull();
  });

  it("a batch left running by a crashed owner can be closed as interrupted through cancel", async () => {
    const t = testbed();
    t.db.prepare(`INSERT INTO process_leases (owner_id, pid, host, heartbeat_at) VALUES ('proc_gone', ?, ?, ?)`).run(deadPid(), os.hostname(), new Date().toISOString());
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

describe("third review round", () => {
  const outbox = (t: ReturnType<typeof testbed>, bindingId: string) => new RoomRepository(t.db).listOutbox(bindingId, 0, 10_000);
  const interruptedStates = (t: ReturnType<typeof testbed>, bindingId: string) =>
    outbox(t, bindingId).filter((o) => o.type === "run.state" && o.payload.state === "interrupted").length;

  it("a binding is told once that its run was interrupted — whatever followed — and a closed one never", async () => {
    const t = testbed();
    const binding = t.rooms.start({ scenarioId: t.fast.id, room: { provider: "test", roomId: "!int" }, participants: PARTICIPANTS });
    await t.service.settle();
    await t.interaction.settle();
    t.interaction.closeDebrief(binding.experimentId);
    new ExperimentRepository(t.db).update(binding.experimentId, { outcome: "INTERRUPTED" });
    expect(t.rooms.recoverInterrupted()).toBe(1);
    // The operator debriefs the interrupted run afterwards: the last run.state is no longer "interrupted".
    await t.interaction.openDebrief(binding.experimentId, "operator");
    t.interaction.closeDebrief(binding.experimentId);
    expect(t.rooms.recoverInterrupted()).toBe(0);
    expect(t.rooms.recoverInterrupted()).toBe(0);
    expect(interruptedStates(t, binding.bindingId)).toBe(1);

    const closed = t.rooms.start({ scenarioId: t.fast.id, room: { provider: "test", roomId: "!closed" }, participants: PARTICIPANTS });
    await t.service.settle();
    await t.interaction.settle();
    t.rooms.close(closed.bindingId);
    const before = t.rooms.view(closed.bindingId).delivery.lastSeq;
    new ExperimentRepository(t.db).update(closed.experimentId, { outcome: "INTERRUPTED" });
    expect(t.rooms.recoverInterrupted()).toBe(0);
    expect(t.rooms.view(closed.bindingId).delivery.lastSeq).toBe(before);
  });

  it("a notice that cannot be posted never fails the message that caused it, nor makes a retry count twice", async () => {
    const t = testbed();
    const binding = t.rooms.start({ scenarioId: t.fast.id, room: { provider: "test", roomId: "!notice" }, participants: PARTICIPANTS });
    await t.service.settle();
    await t.interaction.settle();
    t.interaction.closeDebrief(binding.experimentId);
    const post = t.rooms.post.bind(t.rooms);
    t.rooms.post = (async (experimentId, message) => {
      if (message.sender.kind === "notice") throw new Error("room unavailable");
      return post(experimentId, message);
    }) as typeof t.rooms.post;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const message = { externalEventId: "$late", sender: { externalUserId: "@bob:example.org", displayName: "Bob" }, body: "Hello?" };
    expect(await t.rooms.inbound(binding.bindingId, message)).toMatchObject({ status: "accepted", disposition: "spectator" });
    expect((await t.rooms.inbound(binding.bindingId, message)).status).toBe("duplicate");
    quiet.mockRestore();
    const humans = new InteractionRepository(t.db).listEvents(binding.experimentId).filter((e) => e.type === "human_message");
    expect(humans).toHaveLength(1);
  });

  it("after every debrief session, people are told again that it is closed", async () => {
    const t = testbed();
    const { runner, done } = t.service.start({ config: t.fast.config });
    await done;
    await t.interaction.settle();
    const say = (text: string) => t.interaction.receive(runner.id, { senderId: "u1", displayName: "Nikita", text, replyTo: null, mentions: [] });
    const unavailable = () => new InteractionRepository(t.db).listEvents(runner.id).filter((e) => e.type === "notice_posted" && e.payload.kind === "debriefUnavailable").length;
    t.interaction.closeDebrief(runner.id);
    await say("one");
    await say("two");
    expect(unavailable()).toBe(1);
    await t.interaction.openDebrief(runner.id, "operator");
    t.interaction.closeDebrief(runner.id);
    await say("three");
    expect(unavailable()).toBe(2);
  });

  it("a huge idle timeout does not close the session at once (setTimeout overflow)", async () => {
    const t = testbed();
    const config = structuredClone(t.fast.config) as ReturnType<typeof kestrelConfig>;
    config.humanInteraction!.debrief.idleTimeoutMinutes = 1e9;
    const { runner, done } = t.service.start({ config });
    await done;
    await t.interaction.settle();
    await sleep(30);
    expect(t.interaction.isDebriefOpen(runner.id)).toBe(true);
    t.interaction.closeDebrief(runner.id);
  });

  it("a question whose routing fails still ends as failed, with the reason on record", async () => {
    const t = testbed();
    const { runner, done } = t.service.start({ config: t.fast.config });
    await done;
    await t.interaction.settle();
    (t.interaction as unknown as { messageOf: () => never }).messageOf = () => {
      throw new Error("database unavailable");
    };
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await t.interaction.receive(runner.id, { senderId: "u1", displayName: "Nikita", text: "Why?", replyTo: "some-message", mentions: [] });
    await t.interaction.settle();
    quiet.mockRestore();
    const failed = new InteractionRepository(t.db).listEvents(runner.id).filter((e) => e.type === "debrief_question_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ reason: "error", error: "database unavailable" });
  });
});

describe("final focused review", () => {
  const outbox = (t: ReturnType<typeof testbed>, bindingId: string) => new RoomRepository(t.db).listOutbox(bindingId, 0, 10_000);
  it("an operator may reopen a debrief on a finished binding only while it is still the room's latest open binding", async () => {
    const t = testbed();
    const a = t.rooms.start({ scenarioId: t.fast.id, room: { provider: "test", roomId: "!reopen" }, participants: PARTICIPANTS });
    await t.service.settle();
    await t.interaction.settle();
    t.rooms.stop(a.bindingId);
    expect(t.rooms.view(a.bindingId).state).toBe("COMPLETED");

    // The room is still A's: the operator may reopen, and A goes back to DEBRIEF (adapters poll until CLOSED).
    await t.interaction.openDebrief(a.experimentId, "operator");
    expect(t.rooms.view(a.bindingId).state).toBe("DEBRIEF");
    t.interaction.closeDebrief(a.experimentId);

    // Drained and acked, the room takes a new binding: A may no longer come back to life in it.
    t.rooms.ack(a.bindingId, outbox(t, a.bindingId).map((o) => ({ messageId: o.messageId, externalEventId: `$ext-${o.seq}` })));
    const b = t.rooms.start({ scenarioId: t.fast.id, room: { provider: "test", roomId: "!reopen" }, participants: PARTICIPANTS });
    await t.service.settle();
    await t.interaction.settle();
    const before = t.rooms.view(a.bindingId).delivery.lastSeq;
    await expect(t.interaction.openDebrief(a.experimentId, "operator")).rejects.toThrow("already held by a newer binding");
    expect(t.rooms.view(a.bindingId).delivery.lastSeq).toBe(before);
    expect(t.rooms.find("test", "!reopen", true).map((v) => v.bindingId)).toEqual([b.bindingId]);

    // A closed binding detached the experiment from its room: an operator debrief is local only.
    t.rooms.close(a.bindingId);
    await t.interaction.openDebrief(a.experimentId, "operator");
    expect(t.rooms.view(a.bindingId).delivery.lastSeq).toBe(before);
    t.interaction.closeDebrief(a.experimentId);
  });

  it("the local viewer may watch an externally bound experiment but not talk in it (409 EXTERNAL_ROOM_ACTIVE) until the binding is closed", async () => {
    const t = testbed();
    const binding = t.rooms.start({ scenarioId: t.fast.id, room: { provider: "test", roomId: "!local" }, participants: PARTICIPANTS });
    await t.service.settle();
    await t.interaction.settle();
    const server = createApp({ db: t.db, providers: t.providers, evaluators: createEvaluatorRegistry(), service: t.service, batches: t.batches, interaction: t.interaction, rooms: t.rooms });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    const base = `/api/experiments/${binding.experimentId}`;
    const message = { senderId: "local-1", displayName: "Operator", text: "Viktor, why?" };

    const view = await call("GET", base);
    expect(view.status).toBe(200);
    expect(view.body.externalRoom).toMatchObject({ bindingId: binding.bindingId, provider: "test", roomId: "!local" });
    const refused = await call("POST", `${base}/room/messages`, message);
    expect(refused).toMatchObject({ status: 409, body: { code: "EXTERNAL_ROOM_ACTIVE" } });
    expect(new InteractionRepository(t.db).listEvents(binding.experimentId).filter((e) => e.type === "human_message")).toHaveLength(0);

    t.rooms.close(binding.bindingId);
    expect((await call("GET", base)).body.externalRoom).toBeNull();
    expect((await call("POST", `${base}/room/messages`, message)).status).toBe(201);
    await t.interaction.settle();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
