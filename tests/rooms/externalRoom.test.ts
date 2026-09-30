import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventRepository } from "../../src/persistence/eventRepository.js";
import { ExperimentRepository } from "../../src/persistence/experimentRepository.js";
import { ProviderRegistry } from "../../src/llm/registry.js";
import { StubProvider } from "../../src/llm/stubProvider.js";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { ScenarioRepository } from "../../src/persistence/scenarioRepository.js";
import { BUILTIN_SCENARIOS, createEvaluatorRegistry, registerBuiltinStubs } from "../../src/scenarios/index.js";
import { kestrelConfig } from "../../src/scenarios/spaceStation/kestrel.js";
import { composeTestbed } from "../../src/server/compose.js";
import { createExternalApp } from "../../src/server/externalApp.js";

/**
 * Contract test for the External Room API: a consumer that behaves like a
 * real external room adapter — bind, long-poll the outbox, publish strictly
 * in order, acknowledge, send human messages (with retries), reply in the
 * debrief — without any chat system behind it.
 */

const TOKEN = "test-token-0123456789abcdef";
const db = createInMemoryDb();
const scenarios = new ScenarioRepository(db);
scenarios.syncBuiltins(BUILTIN_SCENARIOS);
// A fast copy of Kestrel (no pacing) for the contract flow; the built-in stays whitelisted too.
const fastConfig = kestrelConfig();
fastConfig.name = "Kestrel · contract test";
fastConfig.presentation.pacing = { minVisibleIntervalMs: 0, perCharMs: 0, maxGapMs: 0 };
fastConfig.runtime.providerRetryDelayMs = 0;
const fast = scenarios.create(fastConfig);

const providers = new ProviderRegistry([], registerBuiltinStubs(new StubProvider(20)));
const composed = composeTestbed({ db, providers, evaluators: createEvaluatorRegistry(), externalScenarios: ["station-kestrel", fast.id, "space-station-not-a-scenario"] });
let server: http.Server;
let base: string;

beforeAll(async () => {
  server = createExternalApp({ rooms: composed.rooms, token: TOKEN });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/external`;
});

afterAll(async () => {
  await composed.service.settle();
  await composed.interaction.settle();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function call(method: string, path: string, body?: unknown, token: string | null = TOKEN) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const PARTICIPANTS = [
  { participantId: "operations", externalUserId: "@sarah:example.org" },
  { participantId: "engineering", externalUserId: "@john:example.org" },
  { participantId: "power", externalUserId: "@viktor:example.org" },
  { participantId: "life_support", externalUserId: "@maya:example.org" },
  { participantId: "system", externalUserId: "@mission-control:example.org" },
];

/** A minimal consumer: long-polls, "publishes" in seq order, acknowledges each event with a fake external event id. */
class Consumer {
  after = 0;
  readonly published: any[] = [];
  constructor(readonly bindingId: string) {}

  async pump(waitMs = 2000): Promise<any[]> {
    const { body } = await call("GET", `/bindings/${this.bindingId}/events?after=${this.after}&waitMs=${waitMs}`);
    const acks = [];
    for (const event of body.events) {
      expect(event.seq).toBe(this.after + 1); // strictly ordered, no gaps
      this.after = event.seq;
      this.published.push(event);
      acks.push({ messageId: event.messageId, externalEventId: event.type === "message" ? `$ev-${event.messageId}` : null });
    }
    if (acks.length) {
      const ack = await call("POST", `/bindings/${this.bindingId}/acks`, { acks });
      expect(ack.body.results.every((r: any) => r.status === "acked")).toBe(true);
    }
    return body.events;
  }

  async until(predicate: (e: any) => boolean, timeoutMs = 15000): Promise<any> {
    const start = Date.now();
    for (;;) {
      const hit = this.published.find(predicate);
      if (hit) return hit;
      if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for an outbox event");
      await this.pump(500);
    }
  }
}

describe("External Room API — access", () => {
  it("requires the bearer token and serves nothing but /api/external/*", async () => {
    expect((await call("GET", "/scenarios", undefined, null)).status).toBe(401);
    expect((await call("GET", "/scenarios", undefined, "wrong")).body.error.code).toBe("UNAUTHORIZED");
    const operator = await fetch(base.replace("/api/external", "/api/experiments"), { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(operator.status).toBe(404);
  });

  it("lists only whitelisted, runnable scenarios, with their participants and allowed launch options", async () => {
    const { body } = await call("GET", "/scenarios");
    expect(body.scenarios.map((s: any) => s.id)).toEqual(["station-kestrel", fast.id]);
    const kestrel = body.scenarios[0];
    expect(kestrel.participants.map((p: any) => [p.id, p.kind])).toEqual([
      ["operations", "agent"],
      ["engineering", "agent"],
      ["power", "agent"],
      ["life_support", "agent"],
      ["system", "system"],
    ]);
    expect(kestrel.participants.find((p: any) => p.id === "power").displayName).toBe("Viktor Hale");
    expect(kestrel.allowedOverrides).toEqual({ conversationLanguage: { type: "enum", values: ["en", "ru"], default: "en" } });
  });

  it("rejects starts it cannot honor, with stable error codes", async () => {
    const room = { provider: "test", roomId: "!validation" };
    expect((await call("POST", "/bindings", { scenarioId: "space-station", room, participants: PARTICIPANTS })).body.error.code).toBe("SCENARIO_NOT_ALLOWED");
    const missing = await call("POST", "/bindings", { scenarioId: fast.id, room, participants: PARTICIPANTS.slice(1) });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatchObject({ code: "INVALID_PARTICIPANTS", missing: ["operations"] });
    const language = await call("POST", "/bindings", { scenarioId: fast.id, room, participants: PARTICIPANTS, overrides: { conversationLanguage: "de" } });
    expect(language.body.error).toMatchObject({ code: "OVERRIDE_NOT_ALLOWED", allowed: ["en", "ru"] });
    const patch = await call("POST", "/bindings", { scenarioId: fast.id, room, participants: PARTICIPANTS, overrides: { "limits.totalCostCapUsd": 99 } });
    expect(patch.body.error.code).toBe("INVALID_REQUEST"); // no arbitrary config mutation
  });
});

describe("External Room API — contract flow", () => {
  it("bind → outbox (from the very first message) → acks → spectator → debrief question by reply → answer → busy/stop/close", async () => {
    const room = { provider: "test", roomId: "!kestrel-room" };
    const started = await call("POST", "/bindings", { scenarioId: fast.id, room, participants: PARTICIPANTS, overrides: { conversationLanguage: "en" } });
    expect(started.status).toBe(201);
    const binding = started.body.binding;
    expect(binding).toMatchObject({ state: "ACTIVE", room, conversationLanguage: "en" });
    const consumer = new Consumer(binding.bindingId);

    // The first visible message of the run is the first outbox event.
    const first = (await consumer.pump())[0];
    expect(first).toMatchObject({ seq: 1, type: "message", kind: "narration", sender: { participantId: "system", externalUserId: "@mission-control:example.org" } });
    expect(first.data.source).toBe("opening");

    // Spectator during the mission; a retried POST has no second effect.
    const agentMessage = await consumer.until((e) => e.kind === "agent_message");
    expect(agentMessage.sender.externalUserId).toMatch(/@\w+:example.org/);
    const spectator = { externalEventId: "$human-1", sender: { externalUserId: "@nikita:example.org", displayName: "Nikita" }, body: "STOP" };
    const firstPost = await call("POST", `/bindings/${binding.bindingId}/inbound`, spectator);
    expect(firstPost.status).toBe(202);
    expect(firstPost.body).toMatchObject({ status: "accepted", disposition: "spectator" });
    const retry = await call("POST", `/bindings/${binding.bindingId}/inbound`, spectator);
    expect(retry.body).toMatchObject({ status: "duplicate", disposition: "spectator", messageId: firstPost.body.messageId });
    const notice = await consumer.until((e) => e.kind === "room_notice" && e.data?.noticeType === "spectatorNotice");
    expect(notice.replyToExternalEventId).toBe("$human-1");

    // Echo protection: our own identities and our own published events are never human input.
    const echo = await call("POST", `/bindings/${binding.bindingId}/inbound`, { externalEventId: "$echo", sender: { externalUserId: "@viktor:example.org", displayName: "Viktor" }, body: "hi" });
    expect(echo.body).toMatchObject({ status: "ignored", reason: "bound_identity" });
    const ownEvent = await call("POST", `/bindings/${binding.bindingId}/inbound`, { externalEventId: `$ev-${agentMessage.messageId}`, sender: { externalUserId: "@relay:example.org", displayName: "Relay" }, body: agentMessage.body });
    expect(ownEvent.body).toMatchObject({ status: "ignored", reason: "own_event" });

    // The proposal arrives readable, with structured data — never as the protocol text agents read.
    const proposal = await consumer.until((e) => e.kind === "protocol_notice" && e.data?.noticeType === "proposal_submitted");
    expect(proposal.body).toContain("puts the recovery plan to the vote");
    expect(proposal.body).not.toContain("{");
    expect(proposal.data.proposal).toMatchObject({ coolant_loop: "B", coolant_power_kw: 30 });

    // Mission end, the reveal, then the debrief.
    await consumer.until((e) => e.type === "run.state" && e.state === "debrief_open");
    const states = consumer.published.filter((e) => e.type === "run.state").map((e) => e.state);
    expect(states).toEqual(expect.arrayContaining(["mission_started", "discussion", "proposal", "voting", "mission_finished", "debrief_open"]));
    expect(states.indexOf("mission_finished")).toBeLessThan(states.indexOf("debrief_open"));
    const reveal = consumer.published.filter((e) => e.kind === "narration" && e.data?.source === "outcomes.SUCCESS");
    expect(reveal.map((e) => e.data.part)).toEqual([1, 2, 3]);
    expect((await call("GET", `/bindings/${binding.bindingId}`)).body.binding.state).toBe("DEBRIEF");

    // A human replies to Viktor's message: routed to Viktor deterministically, answered as a reply to the question.
    const viktor = consumer.published.find((e) => e.kind === "agent_message" && e.sender.participantId === "power");
    const question = await call("POST", `/bindings/${binding.bindingId}/inbound`, {
      externalEventId: "$human-question",
      sender: { externalUserId: "@alice:example.org", displayName: "Alice" },
      body: "Why that number?",
      replyToExternalEventId: `$ev-${viktor.messageId}`,
    });
    expect(question.body).toMatchObject({ status: "accepted", disposition: "question", queued: { position: 1 } });
    const answer = await consumer.until((e) => e.kind === "debrief_answer");
    expect(answer).toMatchObject({ sender: { participantId: "power", externalUserId: "@viktor:example.org" }, replyToExternalEventId: "$human-question" });
    expect(answer.body).toMatch(/^Alice, /);

    // Acks are idempotent; a different external id for an acked event is a conflict.
    const again = await call("POST", `/bindings/${binding.bindingId}/acks`, { acks: [{ messageId: answer.messageId, externalEventId: `$ev-${answer.messageId}` }, { messageId: answer.messageId, externalEventId: "$other" }, { messageId: "om_nope" }] });
    expect(again.body.results.map((r: any) => r.status)).toEqual(["duplicate", "conflict", "unknown"]);

    // One run per room at a time: the debrief keeps the room busy.
    const busy = await call("POST", "/bindings", { scenarioId: fast.id, room, participants: PARTICIPANTS });
    expect(busy.status).toBe(409);
    expect(busy.body.error).toMatchObject({ code: "ROOM_BUSY", reason: "active", bindingId: binding.bindingId });
    const stopped = await call("POST", `/bindings/${binding.bindingId}/stop`, {});
    expect(stopped.body.binding.state).toBe("COMPLETED");
    // The "debrief closed" notice is not delivered yet: still busy, now as undelivered.
    const undelivered = await call("POST", "/bindings", { scenarioId: fast.id, room, participants: PARTICIPANTS });
    expect(undelivered.body.error).toMatchObject({ code: "ROOM_BUSY", reason: "undelivered" });
    await consumer.pump(0);
    const status = (await call("GET", `/bindings/${binding.bindingId}`)).body.binding;
    expect(status.delivery).toMatchObject({ ackedThroughSeq: status.delivery.lastSeq, unacked: [] });

    // Find by room; close; inbound refused afterwards; the outbox stays readable.
    const found = await call("GET", `/bindings?provider=test&roomId=${encodeURIComponent(room.roomId)}`);
    expect(found.body.bindings.map((b: any) => b.bindingId)).toEqual([binding.bindingId]);
    expect((await call("POST", `/bindings/${binding.bindingId}/close`, {})).body.binding.state).toBe("CLOSED");
    expect((await call("POST", `/bindings/${binding.bindingId}/inbound`, { ...spectator, externalEventId: "$late" })).body.error.code).toBe("BINDING_CLOSED");
    expect((await call("GET", `/bindings/${binding.bindingId}/events?after=0`)).body.events.length).toBe(consumer.after);

    // A new run in the same room is fine now.
    const next = await call("POST", "/bindings", { scenarioId: fast.id, room, participants: PARTICIPANTS, overrides: { conversationLanguage: "ru" } });
    expect(next.status).toBe(201);
    await composed.service.settle();
    await composed.interaction.settle();

    // Nothing the room did reached the experiment.
    const trace = new EventRepository(db).list(binding.experimentId);
    expect(trace.some((e) => e.type === "operator_intervention" && (e.payload.command as any).type !== "stop")).toBe(false);
    expect(new ExperimentRepository(db).getOrThrow(binding.experimentId)).toMatchObject({ outcome: "SUCCESS", intervened: false });
  });

  it("ackedThroughSeq is the contiguous acknowledged prefix, and long-poll returns as soon as something arrives", async () => {
    const room = { provider: "test", roomId: "!prefix-room" };
    const { body } = await call("POST", "/bindings", { scenarioId: fast.id, room, participants: PARTICIPANTS });
    const id = body.binding.bindingId;
    await composed.service.settle();
    await composed.interaction.settle();
    const { body: page } = await call("GET", `/bindings/${id}/events?after=0&limit=5`);
    expect(page.events.map((e: any) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    // Ack 1, 2 and 4 — not 3.
    await call("POST", `/bindings/${id}/acks`, { acks: [1, 2, 4].map((s) => ({ messageId: page.events[s - 1].messageId, externalEventId: `$x${s}` })) });
    const delivery = (await call("GET", `/bindings/${id}`)).body.binding.delivery;
    expect(delivery.ackedThroughSeq).toBe(2);
    expect(delivery.unacked[0]).toEqual({ seq: 3, messageId: page.events[2].messageId });

    // Long-poll at the end of the stream wakes up on a new event (here: the "debrief closed" state and notice).
    const t0 = Date.now();
    const waiting = call("GET", `/bindings/${id}/events?after=${delivery.lastSeq}&waitMs=10000`);
    setTimeout(() => void call("POST", `/bindings/${id}/stop`, {}), 150);
    const woke = await waiting;
    expect(woke.body.events.length).toBeGreaterThan(0);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("a run cut off by a restart ends its outbox with run.state interrupted", async () => {
    const room = { provider: "test", roomId: "!restart-room" };
    const { body } = await call("POST", "/bindings", { scenarioId: fast.id, room, participants: PARTICIPANTS });
    await composed.service.settle();
    await composed.interaction.settle();
    // What a restart leaves behind: the experiment recovered as INTERRUPTED (see ExperimentService.recoverInterrupted).
    new ExperimentRepository(db).update(body.binding.experimentId, { outcome: "INTERRUPTED" });
    composed.interaction.forget(body.binding.experimentId);
    expect(composed.rooms.recoverInterrupted()).toBe(1);
    expect(composed.rooms.recoverInterrupted()).toBe(0); // idempotent
    const { body: page } = await call("GET", `/bindings/${body.binding.bindingId}/events?after=0&limit=500`);
    expect(page.events.at(-1)).toMatchObject({ type: "run.state", state: "interrupted" });
    expect((await call("GET", `/bindings/${body.binding.bindingId}`)).body.binding.state).toBe("INTERRUPTED");
  });
});
