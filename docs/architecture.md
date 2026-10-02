# Architecture

## Source layout

```
src/
  experiment/   config schema · state machine (phases) · ExperimentRunner (lifecycle loop, operator controls)
                LlmCaller (every model call: retries, parsing, tracing, budget) · protocol (prompts, response schemas)
                readiness · budget · outcome taxonomy · event log · metrics · ExperimentService (running experiments)
                protocolStrings (moderator notices agents read, en/ru) · RunExtension interface (extensions.ts)
  scheduling/   Scheduler interface · round-robin · hybrid (explicit → classifier → fallback)
  consensus/    ConsensusRule interface · unanimity · majority
  transport/    Transport interface · LocalTransport (the experiment's own room) · HumanRoomMessage
  evaluation/   ScenarioEvaluator interface · registry
  scenarios/    scenario packages (config + evaluator + stub scripts) · registries
  presentation/ run extensions: narrator (opening · beats · grounded endings) · viewer pacing
  interaction/  HumanInteractionService (people in the room) · DebriefSession (FIFO queue) · addressing · debrief prompts
  rooms/        ExternalRoomService — External Room API: bindings, persistent outbox, inbound
  batch/        spec & condition expansion · BatchService · aggregates
  llm/          provider interface · OpenRouter · Azure OpenAI · stub · registry · concurrency gate · pricing
  persistence/  SQLite (node:sqlite) · scenarios · experiments · events · batches · debrief sessions · interaction events · rooms · process leases
  server/       operator HTTP API and External Room API listener on node:http (no framework) · composition root
  gui/public/   vanilla-JS SPA (no build step)
  cli/          run.ts · batch.ts · roomMock.ts
```

## Data flow

```
Experiment config ──► ExperimentRunner ──► Scheduler ──► who speaks
                         │   │                             (public room only)
                         │   ├──► LlmCaller ──► ProviderRegistry ──► OpenRouter / Azure / stub
                         │   │                     (process-wide request gate)
                         │   ├──► Transport (room) ◄── agents' visible messages
                         │   ├──► ConsensusRule ──► committed?
                         │   └──► ScenarioEvaluator ──► SUCCESS / MISSION_FAILURE
                         └──► EventLog ──► SQLite (append-only) ──► metrics · UI · exports
```

Agents are data, not classes: one generic runtime renders each agent's prompt
from the config and parses its JSON response. The runner never solves anything,
and every decision point is an interface: `Scheduler`, `ConsensusRule`,
`Transport`, `ScenarioEvaluator`, `LlmProvider`.

## Core vs. add-ons

`ExperimentRunner` contains only experiment semantics. That includes everything
that can change what agents do or what the run records as its result: turns,
routing, readiness, proposal, voting, evaluation, budgets, and the protocol
notices agents read. Persona and conversation language belong here too, as run
configuration, because they change behavior.

Everything for human observers is outside the core and attaches through one
interface, `RunExtension` ([src/experiment/extensions.ts](../src/experiment/extensions.ts)):

- `attach` — once, before anything is published;
- `beforePublish` / `afterPublish` — around each room message, which the
  extension receives only as a **frozen copy**. It can wait (viewer pacing)
  or post narration first (beats), but it can never change a message or
  what agents read: the room itself is never handed out.
- `onRoomOpened` / `onRunEnded` — for example, the narrator's opening and ending;
- a context that can:
  - post observer-only messages;
  - append trace events;
  - observe the trace as it is written (read-only; a throwing listener is
    isolated);
  - hold the experiment clock (excluded from active time, like a pause) —
    only inside a hook, while the core waits on it;
  - see the stop signal;
  - read the run's add-on options (`headless`).

This is enforced at runtime, not only by the types:

- the run's config is frozen;
- the ending snapshot (termination, evaluation and consensus) is detached and
  deeply frozen, as are trace events handed to subscribers;
- `post` accepts only narrator messages, and caller metadata cannot overwrite
  the message's own fields; what it returns (like every message an extension
  gets) is a detached, deeply frozen copy;
- `log` accepts only add-on events (`presentation_delay`, `extension_note`);
- `holdClock` outside a hook throws, and a hold its hook did not await ends
  with the hook;
- runaway posting from a publish hook is cut off;
- the experiment's duration, usage and turns are fixed when the outcome is
  decided: whatever an extension does at the ending is not experiment time.

Extensions cannot touch turns, proposals, votes, evaluation or the outcome. A
failing extension is logged as `extension_error` and changes nothing — not
even `metrics.errors`. The composition roots (server, CLI, batch) attach
`presentationExtensions`; without extensions the runner is the bare core.

Viewer-only features (viewer mode, localized agent labels, the readable
proposal card) do not even need an extension. They are projections of the
event log.

## People in the room

`src/interaction/` sits *around* runs, not inside them. The layer consists of:

- `HumanInteractionService`, which receives new human text messages from any
  source (the local viewer over HTTP, or an external room through the External
  Room API);
- a `RoomOutlet` for posting;
- `ExperimentService.onRunFinished`, which starts the debrief.

The runner never receives a human message; `Transport.history()` holds only
the experiment's own messages. Agents see a transcript numbered over those
messages alone, so narration or human chat cannot shift what they read. The
debrief reuses `LlmCaller` with its own log, budget and provider slots
(`CallLog`, `CallBudget`, pool `debrief`), so its calls never enter the
experiment's trace or usage. Future profiles that *would* change experiment
semantics (advisory input, a human taking a role) must come in through an
explicit core interface, not through branches in the runner.

## External rooms

`src/rooms/` implements the [External Room API](external-room-api.md). An
external chat room is not a transport: agents coordinate in the testbed's own
room, and an external room gets a **projection** of the run — a persistent,
ordered outbox per binding, and inbound human messages deduplicated by
external event id. The layer attaches to runs as one more extension (the
projection), and to the interaction layer as its `RoomOutlet`. Nothing in the
core or in `src/interaction/` knows it exists. It is served on its own listener
with a bearer token.

## Boundaries enforced by tests

[tests/experiment/boundaries.test.ts](../tests/experiment/boundaries.test.ts):

- no core module imports `src/presentation/`, `src/interaction/` or `src/rooms/`,
  and `src/interaction/` does not import `src/rooms/`;
- generic code (everything outside `src/scenarios/`) contains no scenario
  vocabulary or chat-vendor names, and imports scenarios only through the
  registry (`src/scenarios/index.ts`);
- without extensions the runner is the bare core, and a failing extension
  never changes the outcome.
