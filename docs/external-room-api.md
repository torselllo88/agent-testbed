# External Room API

This contract connects a testbed run to a chat room that the testbed does not
own, such as a Matrix room in a chat product. It is written for the team
implementing the **room adapter**. You should not need to read the testbed's
code.

The API knows nothing about scenarios or vendors. Participants come from the
scenario, and `room.provider` is an opaque string. A scenario with six agents,
or a different chat system, needs no change to this API.

---

## 1. The model

```
 testbed                                         your adapter                room
 ───────────────────────────────────             ─────────────────           ─────
 scenario run (agents, routing, proposal,        reads the outbox ─────────► posts as the mapped
 voting, evaluation, narration, pacing,          (strictly in order)          identity
 human-interaction policy, debrief)              acknowledges ◄───────────── gets the event id
        │                                        
        ├─ visible messages ─► OUTBOX (persistent, ordered, per binding)
        │                                        
        └─ human-interaction layer ◄──── INBOUND ◄── new human text messages ◄── people
```

- **The testbed is authoritative.** Agents coordinate inside the testbed. The
  external room is an asynchronous **projection**: agents never read it, and a
  slow or disconnected adapter never blocks the experiment.
- **The adapter** owns everything about the room system: connectivity, room
  lifecycle, identities, authentication, encryption, and sending and receiving
  events. The testbed never receives room credentials.

| Testbed owns | Adapter owns |
|---|---|
| scenario execution, agent reasoning, routing, proposal and voting, evaluation, outcome | room connectivity and room lifecycle |
| presentation: narration and pacing (messages arrive already paced) | participant identities and their authentication |
| what human messages mean: spectator chat during a run, debrief questions after | encryption, publishing and receiving events, rendering |

## 2. Setup (testbed side)

The API runs on its **own listener**, which serves only `/api/external/*`. The
operator UI stays on loopback.

| Variable | Default | Meaning |
|---|---|---|
| `EXTERNAL_API_TOKEN` | *(unset → API disabled)* | Bearer token the adapter must send. Use a long random value. |
| `EXTERNAL_API_PORT` | `3940` | Port of the external listener. |
| `EXTERNAL_API_HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` or a private interface to reach it from another host. |
| `EXTERNAL_SCENARIOS` | *(empty → nothing startable)* | Comma-separated scenarios that may be started externally: built-in ids (`station-kestrel`) or library scenario ids. **Default-deny**, because starting a run can spend money on LLM calls. |

> **Transport security.** A bearer token is not encryption. For a remote
> adapter, put the listener behind TLS (a reverse proxy) or keep it on a
> private network.

**Models and costs are set by the operator, not by the adapter.** The operator
prepares scenarios in the testbed's library (for example "Kestrel Demo —
mixed crew") and allows their ids. The adapter chooses only the scenario, the
room and the allowed launch options. The built-in `station-kestrel` runs on
scripted stub agents, which is free and useful for integration testing.

## 3. Authentication

Every request needs:

```
Authorization: Bearer <EXTERNAL_API_TOKEN>
Content-Type: application/json        (POST requests)
```

Missing or wrong token → `401 {"error":{"code":"UNAUTHORIZED",…}}`.

## 4. Concepts

| Term | Meaning |
|---|---|
| **Scenario** | A runnable configuration. `GET /scenarios` lists the ones you may start, with their participants and allowed launch options. |
| **Participant** | Someone who speaks in the room. `kind: "agent"` is a character. `kind: "system"` (id `system`) is the single system voice: narration, protocol notices and room notices. Every declared participant is required. |
| **Binding** | One run projected into one room. It has an id (`rb_…`), an experiment id, a state and an outbox. |
| **Outbox** | The ordered, persistent list of events for one binding. Each event has a `seq` (1, 2, 3, … with no gaps) and a globally unique `messageId`. |
| **Cursor** | The last `seq` you have processed. You keep it; the server also reports delivery progress. |
| **Ack** | You tell the testbed that you published (or deliberately skipped) an event, and which room event id it produced. |
| **Inbound** | A new human text message from the room that you forward to the testbed. |

## 5. Lifecycle

| State | Meaning | Room busy? |
|---|---|---|
| `ACTIVE` | The run is in progress. | yes |
| `DEBRIEF` | The run is over and its debrief is open: people can question the characters. | yes |
| `COMPLETED` | Nothing is live any more. The outbox is still readable and must still be drained and acked. | only while events are unacked |
| `INTERRUPTED` | The process running it stopped (a crash or restart) during the run. The outbox gets exactly one `run.state interrupted` (an operator may still debrief the finished run after it). | only while events are unacked |
| `CLOSED` | The binding was explicitly closed. Inbound is refused; the outbox stays readable. | no |

Transitions: `ACTIVE` → `DEBRIEF` (if the scenario has a debrief) → `COMPLETED`.
`POST …/stop` ends whatever is live. `POST …/close` goes to `CLOSED`.

The testbed's operator may open a new debrief on a finished run: `COMPLETED`
or `INTERRUPTED` → `DEBRIEF` again (with `run.state debrief_open`) — but only
while this binding is still the latest open binding of its room; once a newer
binding holds the room, the old one never comes back to life. So keep polling
a binding until it is `CLOSED` (or until you have started a newer one in its
room), and close bindings you are done with.

While a binding is open, the room is the only place people talk to the run:
the testbed's own viewer only watches it (its message box is disabled, and its
API answers `409 EXTERNAL_ROOM_ACTIVE`). After `close`, the experiment is
detached from the room; anything done locally from then on stays local.

**One run per room.** Starting a new binding in a room fails with
`409 ROOM_BUSY` while another binding there is `ACTIVE` or `DEBRIEF`
(`reason: "active"`), or is finished but not fully acknowledged
(`reason: "undelivered"`). To start again, either drain and ack everything the old
binding has — `stop` alone is not enough, it only adds its final events — or
`close` it. There is no implicit replace.

## 6. Endpoints

All paths are relative to `/api/external`. The examples use the built-in Kestrel scenario; its participants and texts are scenario data, not part of the API.

### `GET /scenarios`

```json
{
  "scenarios": [
    {
      "id": "station-kestrel",
      "name": "Station Kestrel",
      "description": "…",
      "version": 5,
      "participants": [
        { "id": "operations", "kind": "agent", "displayName": "Sarah Okafor", "role": "Executes station-wide emergency procedures", "required": true },
        { "id": "engineering", "kind": "agent", "displayName": "John Mercer", "role": "…", "required": true },
        { "id": "power", "kind": "agent", "displayName": "Viktor Hale", "role": "…", "required": true },
        { "id": "life_support", "kind": "agent", "displayName": "Maya Chen", "role": "…", "required": true },
        { "id": "system", "kind": "system", "displayName": "MISSION CONTROL", "role": "Narration and room notices", "required": true }
      ],
      "allowedOverrides": {
        "conversationLanguage": { "type": "enum", "values": ["en", "ru"], "default": "en" }
      },
      "humanInteraction": { "profile": "DEBRIEF" }
    }
  ]
}
```

Only scenarios that are both allowed and runnable in this deployment are listed.
`allowedOverrides` is the complete set of launch options. Anything else is
rejected.

### `POST /bindings` — bind a room and start the run

```json
{
  "scenarioId": "station-kestrel",
  "room": { "provider": "matrix", "roomId": "!abc:example.org" },
  "participants": [
    { "participantId": "operations",   "externalUserId": "@sarah:example.org" },
    { "participantId": "engineering",  "externalUserId": "@john:example.org" },
    { "participantId": "power",        "externalUserId": "@viktor:example.org" },
    { "participantId": "life_support", "externalUserId": "@maya:example.org" },
    { "participantId": "system",       "externalUserId": "@mission-control:example.org" }
  ],
  "overrides": { "conversationLanguage": "ru" }
}
```

Every declared participant must be mapped exactly once. Several participants
may share one `externalUserId` (see section 10).

`201 {"binding": <binding view>}`. The binding exists before the run starts,
so the run's first visible message is always outbox `seq` 1.

Errors: `SCENARIO_NOT_ALLOWED` (403), `SCENARIO_NOT_FOUND` (404),
`INVALID_PARTICIPANTS` (400, with `missing` / `unknown` / `duplicates`),
`OVERRIDE_NOT_ALLOWED` (400, with `allowed`), `INVALID_REQUEST` (400),
`ROOM_BUSY` (409, with `reason` and `bindingId`), `SCENARIO_NOT_RUNNABLE` (422).

**Binding view** (returned by most endpoints):

```json
{
  "bindingId": "rb_…",
  "experimentId": "…",
  "room": { "provider": "matrix", "roomId": "!abc:example.org" },
  "participants": [ … as sent … ],
  "state": "ACTIVE",
  "scenario": { "id": "…", "version": 5, "name": "Station Kestrel" },
  "conversationLanguage": "ru",
  "outcome": null,
  "createdAt": "…", "closedAt": null,
  "delivery": { "lastSeq": 12, "ackedThroughSeq": 10, "unacked": [ { "seq": 11, "messageId": "om_…" }, { "seq": 12, "messageId": "om_…" } ] }
}
```

- `ackedThroughSeq` is the **contiguous** acknowledged prefix: every event up
  to it is acked.
- `unacked` lists everything after it that is not acked yet.

### `GET /bindings?provider=…&roomId=…[&active=true]`

The bindings of a room. With `active=true`, only `ACTIVE` and `DEBRIEF`
bindings are returned. Use this to ask "is this room under external control
right now?" — for example, to suppress your own bots' autonomous replies
(section 10).

### `GET /bindings/:id`

The binding view.

### `GET /bindings/:id/events?after=<seq>&limit=<n>&waitMs=<ms>`

The outbox after your cursor, oldest first.

- `limit` defaults to 100 (maximum 500).
- `waitMs` makes it a **long poll**: if nothing is there yet, the request waits
  up to `waitMs` (maximum 25000) and returns as soon as something arrives.

```json
{ "events": [ …outbox events… ], "nextAfter": 14, "state": "ACTIVE" }
```

### `POST /bindings/:id/acks`

```json
{ "acks": [ { "messageId": "om_…", "externalEventId": "$event1" }, { "messageId": "os_…", "externalEventId": null } ] }
```

Returns one result per ack, plus `delivery`:

| Result | Meaning |
|---|---|
| `acked` | Recorded. |
| `duplicate` | Already acked with the same id. Harmless. |
| `conflict` | Already acked with a *different* `externalEventId`; the stored one is returned. |
| `unknown` | No such `messageId` in this binding. |

Ack **every** event, including the ones you do not publish (for example
`run.state`, with `externalEventId: null`). Otherwise `ackedThroughSeq` stops
advancing.

### `POST /bindings/:id/inbound`

```json
{
  "externalEventId": "$human-event",
  "sender": { "externalUserId": "@nikita:example.org", "displayName": "Nikita" },
  "body": "Viktor, where did it go wrong?",
  "replyToExternalEventId": "$viktor-message-event",
  "mentions": ["@viktor:example.org"],
  "timestamp": "2026-09-30T12:00:00Z"
}
```

`replyToExternalEventId`, `mentions` and `timestamp` are optional. The
testbed orders messages by the time it receives them.

Limits — a message outside them is rejected whole with `400 INVALID_REQUEST`
(`problems` says why). A 400 is final: do not retry it.

| Field | Limit |
|---|---|
| `externalEventId` | 1–500 characters |
| `sender.externalUserId`, `replyToExternalEventId`, each mention | up to 500 characters |
| `sender.displayName` | required, 1–100 characters (fall back to the user id if the room has none) |
| `body` | 1–4000 characters after trimming (split or truncate longer messages yourself) |
| `mentions` | at most 20 |

| Response | Meaning |
|---|---|
| `202 {"status":"accepted","messageId":"h_…","disposition":"spectator"}` | Shown to people only. The run is in progress, there is no debrief, or the debrief is closed. |
| `202 {"status":"accepted","disposition":"question","queued":{"position":1}}` | A debrief question. It will be answered in order. |
| `202 {"status":"accepted","disposition":"question","rejected":"user_limit"}` | Too many pending questions from this person; the room gets a notice. |
| `202 {"status":"accepted","disposition":"question","rejected":"queue_full"}` | Too many pending questions in total; the room gets a notice. |
| `200 {"status":"duplicate", …first result…}` | You sent this `externalEventId` before. No second effect. |
| `202 {"status":"ignored","reason":"bound_identity" \| "own_event"}` | Echo of one of the binding's own identities or events. Never treated as human input. |
| `409 BINDING_CLOSED` | The binding is closed. |

### `POST /bindings/:id/stop` and `POST /bindings/:id/close`

- `stop` ends whatever is live: it stops the run (no debrief follows) or
  closes the debrief. The run may need a moment to wind down, so the returned
  state can still be `ACTIVE`. It becomes `COMPLETED` once the run has ended.
  Keep draining the outbox.
- `close` marks the binding `CLOSED` first, then stops. Nothing that follows — the
  end of the run, a debrief, an `interrupted` after a crash — is added to its
  outbox, and no automatic debrief opens for it.

## 7. Outbox events

Every event has `seq`, `messageId`, `type` and `createdAt`. Two types exist
today. **Ignore types you do not know, but ack them.**

### `type: "message"` — publish it

```json
{
  "seq": 12,
  "messageId": "om_7c1…",
  "type": "message",
  "createdAt": "…",
  "kind": "protocol_notice",
  "sender": { "participantId": "system", "externalUserId": "@mission-control:example.org", "displayName": "MISSION CONTROL" },
  "body": "Sarah Okafor puts the recovery plan to the vote:\n• shut down: research labs, external communications\n…",
  "replyToMessageId": null,
  "replyToExternalEventId": null,
  "data": { "noticeType": "proposal_submitted", "proposalId": "…:p1", "attempt": 1, "proposerId": "operations", "proposal": { "shed_loads": ["research_labs", "external_communications"], "coolant_loop": "B" } }
}
```

- **Required behavior:** publish `body` as a text message from
  `sender.externalUserId`. If `replyToExternalEventId` is set, publish it as a
  reply to that room event.
- **`kind` is only a rendering hint.** Show an unknown kind as a plain text
  message. Current values:

  | `kind` | What it is |
  |---|---|
  | `agent_message` | A character speaking during the run. |
  | `narration` | The narrator. `data.source` says which part: `opening`, `beats.<id>`, `outcomes.<OUTCOME>`, … Endings may come in parts (`data.part` / `data.of`). |
  | `protocol_notice` | The run's own notices: a proposal was submitted, or a vote failed. |
  | `room_notice` | Notices for people: "the participants cannot answer now", "your question is queued", "debrief open/closed", … |
  | `debrief_answer` | A character answering a human question. It is a reply to the question. |

- **`data` is optional structure** for richer UI. For `protocol_notice`,
  `data.noticeType` is `proposal_submitted` (with the proposal exactly as the
  scenario defines it) or `proposal_not_approved` (with `approvals`,
  `eligible`, `required`, `rule` and `votes`). You never receive the internal
  protocol text agents read — only `body`.

### `type: "run.state"` — optional, never required

```json
{ "seq": 20, "messageId": "os_…", "type": "run.state", "state": "run_finished", "data": { "outcome": "SUCCESS", "status": "SUCCESS" } }
```

`state` is a free-form string. Not every scenario emits every state, and new
ones may appear: **ignore states you do not know.** Current values are
`run_started`, the run's phases (`discussion`, `proposal`, `voting`,
`committed`, `evaluation`), `run_finished`, `debrief_open`,
`debrief_closed` and `interrupted`. The room experience never depends on these
events, because narrator messages already tell the story. Use them for UI
state only, for example to show a "LIVE" or "DEBRIEF OPEN" badge.

## 8. Delivery rules

1. **Strictly in order.** Publish events one after another in `seq` order,
   never in parallel. Parallel sends reorder narration and answers.
2. **Pacing is already applied.** During a live run, events appear in the
   outbox at viewing pace. Publish them as soon as you get them, without adding
   delays of your own.
3. **Catch-up after a disconnect:** same order, but no historical pauses.
   Drain the backlog as fast as you can, still sequentially.
4. **Idempotent publishing.** `messageId` is stable and globally unique. Derive
   your room system's idempotency key from it, for example the Matrix
   transaction id. A resend after a crash between "sent" and "ack" then does
   not create a duplicate.
   *Matrix caveat:* transaction ids are scoped to the sending access token /
   device. If a bot logs in again with a new token, retransmission is no
   longer recognized.
5. **Ack after publishing,** with the room's event id. The testbed uses it to
   map room replies back to the message they answer.
6. **Reconnect algorithm:**
   - `GET /bindings/:id` → `delivery.ackedThroughSeq` and `unacked`;
   - republish the `unacked` events (your idempotency key prevents duplicates)
     and ack them;
   - continue with `events?after=<lastSeq>&waitMs=20000`.
7. **Retention.** The outbox is kept with the experiment. A binding that
   finished while you were offline can still be delivered completely,
   including the ending and the debrief opening.

## 9. Inbound rules

- Send **new text messages only**. Do not send edits, redactions, reactions,
  attachments or other event types. Editing a message never rewrites a
  question already asked.
- **Never send the binding's own messages back.** Those are messages from any
  bound `externalUserId`, or events you produced for outbox messages. The
  testbed ignores them anyway (`ignored`), but do not rely on that for
  correctness.
- **Retries are safe.** `externalEventId` is the deduplication key within a
  binding. The same human message never becomes two questions, even when two
  identical POSTs race.
- **Replies are the best addressing.** A reply to a character's message
  (`replyToExternalEventId` = that message's room event id, known from your
  ack) goes to that character in the debrief, deterministically. `mentions`
  (bound `externalUserId`s) and names in the text are fallbacks. A mention of
  an identity shared by several participants names nobody in particular, so it
  is ignored.
- **Timing decides the meaning.** During a run, human messages are spectator
  chat: they never reach the agents, and one notice explains that the
  participants will be available after the run. Messages sent during the run are
  not queued for the debrief.
- Human text is **never a command**. "STOP" is just chat. Controls are the
  `stop` and `close` endpoints.

## 10. Adapter responsibilities (room side)

- **Identities.** Best: each participant has its own identity that posts as
  itself. Replies, mentions and the room UX then work naturally. If your room
  system can post only as one bot, you may map several participants to the
  same `externalUserId`. Use `sender.displayName` to show who speaks; replies
  still map correctly, because they go by event id.
- **Suppress autonomous behavior.** While a binding is `ACTIVE` or `DEBRIEF`,
  the bound identities must not generate replies of their own in that room —
  not to messages, and not to mentions. Otherwise a character answers twice:
  once from the testbed, once from its own bot. Check
  `GET /bindings?provider=…&roomId=…&active=true`, or keep your own flag while
  the binding is live.
- Keep the room itself (creation, invites, permissions) on your side. v1
  assumes the room exists and the identities are in it.

## 11. Errors

All errors look like `{"error": {"code": "…", "message": "…", …details}}`.

| HTTP | `code` | When |
|---|---|---|
| 400 | `INVALID_REQUEST` | Malformed body or query; `problems` lists the issues. |
| 400 | `INVALID_PARTICIPANTS` | Participants do not match the scenario (`missing`, `unknown`, `duplicates`). |
| 400 | `OVERRIDE_NOT_ALLOWED` | A launch option value the scenario does not offer (`allowed`). |
| 401 | `UNAUTHORIZED` | Missing or wrong bearer token. |
| 403 | `SCENARIO_NOT_ALLOWED` | The scenario is not in `EXTERNAL_SCENARIOS`. |
| 404 | `SCENARIO_NOT_FOUND`, `BINDING_NOT_FOUND`, `NOT_FOUND` | — |
| 409 | `ROOM_BUSY` | Another binding holds the room (`reason`: `active` / `undelivered`, `bindingId`). |
| 409 | `BINDING_CLOSED` | Inbound to a closed binding. |
| 409 | `CONFLICT` | A state conflict inside the testbed, for example a debrief action that no longer applies. |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | A POST without `Content-Type: application/json`. |
| 422 | `SCENARIO_NOT_RUNNABLE` | The scenario cannot run in this deployment (`problems`). |

## 12. End-to-end

```
Adapter                                             Testbed
   │ GET /scenarios                                    │
   │──────────────────────────────────────────────────►│
   │ POST /bindings {scenario, room, participants}     │
   │──────────────────────────────────────────────────►│  binding created, run starts
   │◄────────────────────────────── 201 {bindingId}    │
   │ GET /bindings/:id/events?after=0&waitMs=20000     │
   │──────────────────────────────────────────────────►│
   │◄──────── [1] narration (opening) as MISSION CONTROL│
   │ publish as @mission-control → $e1                 │
   │ POST /acks [{om_1, $e1}]                          │
   │──────────────────────────────────────────────────►│
   │ GET events?after=1&waitMs=20000                   │  (paced: messages arrive at viewing speed)
   │◄──────── [2] run.state run_started …           │
   │◄──────── [4] agent_message from @sarah             │
   │ …publish, ack…                                    │
   │                                                   │
   │ human message in the room                         │
   │ POST /inbound {$h1, @nikita, "STOP"}              │
   │──────────────────────────────────────────────────►│  spectator: never reaches the agents
   │◄──────── 202 accepted, spectator                   │
   │◄──────── [5] room_notice, reply to $h1             │
   │                                                   │
   │◄──────── … proposal, vote, ending in parts …       │
   │◄──────── run.state run_finished, debrief_open  │
   │◄──────── room_notice "debrief is open"             │
   │                                                   │
   │ Alice replies to Viktor's message ($e7)           │
   │ POST /inbound {$h2, @alice, reply to $e7}         │
   │──────────────────────────────────────────────────►│  routed to Viktor
   │◄──────── 202 accepted, question, position 1        │
   │◄──────── debrief_answer from @viktor, reply to $h2 │
   │ …                                                 │
   │ POST /bindings/:id/stop   (or the debrief idles out)│
   │ drain + ack the rest; POST /bindings/:id/close    │
```

## 13. Reference consumer

`npm run room:mock` runs this whole flow against a live testbed: bind, long
poll, "publish" (print) in order, ack, send a spectator message, ask a debrief
question as a reply to a character, receive the answer, stop, drain and close.
It prints what a real adapter would post. Its source,
`src/cli/roomMock.ts`, is short sample code, with comments that mark what a
real adapter must do.

```
# testbed (.env or environment)
EXTERNAL_API_TOKEN=<long random value>
EXTERNAL_SCENARIOS=station-kestrel      # stub agents: free
npm run gui

# in another terminal
npm run room:mock -- --language ru
```

The same contract is covered by `tests/rooms/externalRoom.test.ts`.
