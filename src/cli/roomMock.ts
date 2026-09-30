#!/usr/bin/env node
/**
 * Reference consumer of the External Room API — a mock "room adapter" with
 * no chat system behind it. It runs the whole contract against a live server
 * and prints what a real adapter would publish:
 *
 *   discover → bind → long-poll the outbox → "publish" in seq order → ack
 *   → spectator message during the mission → debrief opens
 *   → question as a reply to a character's message → the character answers
 *   → stop → drain → close
 *
 *   npm run room:mock -- [--scenario <id>] [--language en|ru] [--room <roomId>] [--url http://127.0.0.1:3940]
 *
 * Needs the server running with EXTERNAL_API_TOKEN set and the scenario in
 * EXTERNAL_SCENARIOS (e.g. EXTERNAL_SCENARIOS=station-kestrel for a free stub run).
 * Read it as sample code: the comments mark what a real adapter must do.
 */
import { parseArgs } from "node:util";
import { env } from "../config/env.js";

const { values } = parseArgs({
  options: {
    scenario: { type: "string" },
    language: { type: "string" },
    room: { type: "string", default: `!mock-${Date.now()}:mock.local` },
    url: { type: "string", default: `http://127.0.0.1:${env.externalApi.port}` },
  },
});
const token = env.externalApi.token;
if (!token) {
  console.error("EXTERNAL_API_TOKEN is not set (.env) — the External Room API is disabled.");
  process.exit(2);
}
const api = `${values.url!.replace(/\/+$/, "")}/api/external`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.error?.code}: ${json.error?.message}`);
  return json;
}

// 1. Discover what may be started, who takes part and which launch options exist.
const { scenarios } = await call("GET", "/scenarios");
const scenario = values.scenario ? scenarios.find((s: any) => s.id === values.scenario) : scenarios[0];
if (!scenario) {
  console.error(`No such externally allowed scenario. Available: ${scenarios.map((s: any) => s.id).join(", ") || "(none — set EXTERNAL_SCENARIOS)"}`);
  process.exit(2);
}
const language = values.language ?? scenario.allowedOverrides.conversationLanguage?.default;
// A real adapter maps each declared participant to an identity in its room (e.g. a chat user id).
const participants = scenario.participants.map((p: any) => ({ participantId: p.id, externalUserId: `@${p.id}:mock.local` }));
console.log(`scenario ${scenario.id} (${scenario.name}), language ${language}, room ${values.room}`);

// 2. Bind the room and start the run.
const { binding } = await call("POST", "/bindings", {
  scenarioId: scenario.id,
  room: { provider: "mock", roomId: values.room },
  participants,
  overrides: { conversationLanguage: language },
});
const id = binding.bindingId;
console.log(`binding ${id} → experiment ${binding.experimentId}\n`);

const agents = scenario.participants.filter((p: any) => p.kind === "agent").map((p: any) => p.id);
const published: any[] = [];
let after = 0;
let spectatorSent = false;
let questionSent = false;
let answered = false;
let stopping = false;
const deadline = Date.now() + 10 * 60_000;

while (Date.now() < deadline) {
  // 3. Long-poll the outbox after the cursor. On a network error, retry with the SAME cursor — nothing is lost.
  let page: any;
  try {
    page = await call("GET", `/bindings/${id}/events?after=${after}&waitMs=20000`);
  } catch (err) {
    console.error(`  (poll failed: ${(err as Error).message} — retrying)`);
    await sleep(1000);
    continue;
  }

  const acks = [];
  // 4. Publish STRICTLY in seq order — never in parallel. Unknown types/kinds: show as text, or ignore — but ack them.
  for (const event of page.events) {
    if (event.type === "message") {
      const reply = event.replyToExternalEventId ? ` ↩ ${event.replyToExternalEventId}` : "";
      console.log(`[${event.seq}] ${event.sender.displayName} (${event.sender.externalUserId}, ${event.kind})${reply}:\n    ${String(event.body).replace(/\n/g, "\n    ")}`);
      // A real adapter sends the message as event.sender.externalUserId, using event.messageId as its idempotency key
      // (e.g. a transaction id), and acks with the event id the room assigned.
      acks.push({ messageId: event.messageId, externalEventId: `$mock-${event.messageId}` });
    } else {
      console.log(`[${event.seq}] · ${event.type} ${event.state ?? ""}${event.data ? ` ${JSON.stringify(event.data)}` : ""}`);
      acks.push({ messageId: event.messageId, externalEventId: null });
    }
    published.push(event);
    after = event.seq;
  }
  // 5. Acknowledge what was published (idempotent — safe to repeat after a crash).
  if (acks.length) await call("POST", `/bindings/${id}/acks`, { acks });

  // 6. Human messages: new text messages only, never our own identities' messages (echo).
  if (!spectatorSent && published.some((e) => e.kind === "agent_message")) {
    spectatorSent = true;
    const r = await call("POST", `/bindings/${id}/inbound`, {
      externalEventId: "$mock-human-1",
      sender: { externalUserId: "@spectator:mock.local", displayName: "Spectator" },
      body: "Is everyone all right up there?",
    });
    console.log(`  >> Spectator: "Is everyone all right up there?" → ${r.status}, ${r.disposition}`);
  }
  if (!questionSent && published.some((e) => e.type === "run.state" && e.state === "debrief_open")) {
    questionSent = true;
    // Reply to a character's message: the testbed routes the question to that character.
    const target = agents.map((a: string) => published.find((e) => e.kind === "agent_message" && e.sender.participantId === a)).filter(Boolean).at(-1);
    const r = await call("POST", `/bindings/${id}/inbound`, {
      externalEventId: "$mock-human-2",
      sender: { externalUserId: "@alice:mock.local", displayName: "Alice" },
      body: "Why did you say that?",
      replyToExternalEventId: target ? `$mock-${target.messageId}` : null,
    });
    console.log(`  >> Alice replies to ${target?.sender.displayName ?? "the room"}: "Why did you say that?" → ${r.status}, ${r.disposition}`);
  }
  if (!answered && published.some((e) => e.kind === "debrief_answer")) answered = true;
  if (answered && !stopping) {
    stopping = true;
    await call("POST", `/bindings/${id}/stop`, {});
  }
  // 7. Done when everything is delivered and nothing is live any more.
  const { binding: status } = await call("GET", `/bindings/${id}`);
  if (stopping && status.state === "COMPLETED" && status.delivery.unacked.length === 0 && page.events.length === 0) {
    await call("POST", `/bindings/${id}/close`, {});
    console.log(`\ndone: ${published.length} events delivered, outcome ${status.outcome}, binding closed.`);
    process.exit(0);
  }
  if (status.state === "INTERRUPTED") {
    console.log("\nthe run was interrupted (server restart).");
    process.exit(1);
  }
}
console.error("timed out");
process.exit(1);
