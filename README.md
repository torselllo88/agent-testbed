# Agent Testbed

A small, configurable testbed for **multi-agent LLM coordination experiments**.

Several independent LLM agents each get only part of the information needed to
solve a task. They talk in a shared room, decide who speaks next, agree on one
formal proposal and vote on it. A deterministic evaluator then checks whether
the committed proposal actually solves the task:

```
distributed information → communication → collective decision → objectively verifiable outcome
```

The same engine serves three purposes: an interactive demo, manual
experimentation and debugging, and reproducible batch experiments. Every run
leaves a complete, persistent, machine-readable event trace.

The repository is an evolution of [RoleCase](https://github.com/torselllo88/rolecase).
The unmodified starting point is tagged `rolecase-baseline`; `git diff rolecase-baseline`
shows the whole transformation.

---

## Contents

- [Quick start](#quick-start)
- [Core ideas](#core-ideas)
- [The reference scenario: Space Station Benchmark](#the-reference-scenario-space-station-benchmark)
- [Scenarios: task, behavior and presentation](#scenarios-task-behavior-and-presentation)
- [People in the room: spectators and debrief](#people-in-the-room-spectators-and-debrief)
- [Using the web UI](#using-the-web-ui)
- [Command line](#command-line)
- [Experiment configuration](#experiment-configuration)
- [Experiment lifecycle](#experiment-lifecycle)
- [Outcomes](#outcomes)
- [Batch experiments](#batch-experiments)
- [Trace, metrics and reproducibility](#trace-metrics-and-reproducibility)
- [Architecture](#architecture)
- [Extending the testbed](#extending-the-testbed)
- [HTTP API](#http-api)
- [Configuration (.env)](#configuration-env)
- [Development](#development)
- [Known limitations](#known-limitations)

---

## Quick start

Requires **Node.js ≥ 22.5** (the built-in `node:sqlite` is used; no database server).

```bash
npm install
npm run gui          # → http://localhost:3939
```

That is all that is needed for a first look. Without any API key, every agent
runs on the built-in **stub provider**: scripted, deterministic stand-ins for
the Space Station officers. The scenarios then run end-to-end, free and
offline (stub agents always speak English). The **Scenarios** library already
contains three built-ins: the neutral **Space Station Benchmark**, the
humanized live demo **Station Kestrel**, and its harder sibling **Station
Kestrel: Cascade**.

To run real LLM agents:

1. `cp .env.example .env` and set `OPENROUTER_API_KEY` (or the Azure OpenAI variables).
2. Restart `npm run gui`. The Overview page shows which providers are configured.
3. Built-ins are read-only: open **Scenarios**, press **Duplicate** on a
   built-in, and in the copy's **Agents** tab set provider `openrouter` and a
   model for each agent, e.g. `anthropic/claude-sonnet-5`. Different agents can
   use different models. Point the router classifier (**Protocol** tab) at a
   real model too, or turn it off.
4. **Save**, then **Run**. Pick a conversation language, then **Start** (control
   view) or **Start & watch** (viewer mode).

Real LLM calls cost money. Every run reports its token usage and cost; batches
can be capped (`limits.totalCostCapUsd`, `limits.totalTokenCap`).

---

## Core ideas

- **The orchestrator manages the lifecycle, not the task.** It decides phases,
  turn order, budgets and the proposal → vote → commit sequence. All reasoning
  about the task is done by the agents.
- **The router decides who speaks, never what is right.** Schedulers, including
  the LLM classifier, see only the public room: the task, the roster and the
  recent conversation. They never see private context or the evaluator.
- **Agreement is not correctness.** Agents can unanimously approve an unsafe
  plan. Consensus decides whether a proposal is *committed*; the independent,
  deterministic evaluator decides whether it *works*.
- **Visible messages and control metadata are separate.** An agent's turn has a
  room message plus internal metadata (target, intent, pass, readiness). Other
  agents see only the message; the metadata appears in the trace and in the
  UI's debug mode.
- **One engine.** Interactive runs, CLI runs and batch runs all go through
  `ExperimentRunner`. There is no separate research implementation.
- **Append-only trace.** Every run writes its events to SQLite as they happen,
  so a run stays inspectable after a restart. Every reported metric is derived
  from the events.

---

## The reference scenario: Space Station Benchmark

Reactor cooling loop A has failed. Four officers must agree on a recovery
procedure. Each one knows only part of the picture:

| Agent | Knows |
|---|---|
| **Reactor Engineering** | Loop B works but needs ≥ 30 kW; a SCRAM is required; SCRAM alone is not enough |
| **Power Systems** | Only 10 kW is free; the labs (12 kW) and external comms (8 kW) can be shed; life support must not be touched without confirmation |
| **Life Support** | Life support must stay at 40 kW; the labs and comms can go; venting is unacceptable |
| **Station Operations** | The validated procedure (power → route ≥ 30 kW to B → start B → SCRAM → keep life support) |

The committed proposal is structured data:

```json
{
  "shed_loads": ["research_labs", "external_communications"],
  "coolant_loop": "B",
  "coolant_power_kw": 30,
  "scram_reactor": true,
  "life_support_power_kw": 40,
  "vent_reactor_section": false
}
```

The evaluator ([src/scenarios/spaceStation/evaluator.ts](src/scenarios/spaceStation/evaluator.ts))
checks six constraints and reports each one:

- `coolant_available`
- `coolant_power_sufficient`
- `power_feasible` — the routed power must actually be available, i.e. the
  reserve plus the loads that were shed
- `reactor_scrammed`
- `life_support_preserved`
- `no_unsafe_venting`

The station's numbers are editable evaluator parameters. If you change them,
keep the agents' private context consistent with them.

**Versions.** v2 of the built-in scenario states explicitly, in Power's private
information, that the 40 kW life-support allocation is existing load (not
additional demand) and that the 10 kW reserve is free for the coolant system.
In live runs, cheap models read the v1 wording as "40 kW + 30 kW must be
covered" and gave up. Saved copies of a built-in scenario keep the version they
were created from; nothing is updated automatically.

**Stub agents.** Three scripted variants exercise distinct outcomes without any
API key:

| Stub model | What happens | Outcome |
|---|---|---|
| `space-station/cooperative` | Full information exchange | `SUCCESS` |
| `space-station/insufficient-power` | Only the labs are shed; everyone approves | `MISSION_FAILURE` (consensus ≠ correctness) |
| `space-station/life-support-veto` | The plan draws on life support; Life Support rejects | `CONSENSUS_FAILURE` under unanimity, `MISSION_FAILURE` under majority |

---

## Scenarios: task, behavior and presentation

A scenario is one saved, reusable config. It holds two separate concerns:

```
                    Scenario
                       │
          ┌────────────┴─────────────┐
   Task / protocol              Behavior & presentation
   shared facts, roles,         names, personas,
   objectives, private info,    conversation language,
   decision rules, evaluator    narration, viewer pacing
```

The presentation side never changes protocol semantics: consensus, proposal
immutability, voting, evaluation, routing, budgets and the event log behave
identically with or without it.

**Station Kestrel** runs the same Space Station task as the benchmark: the
same shared facts, roles, objectives, private information, decision rules and
evaluator, and therefore the same `taskDefinitionHash`. On top it adds:

- **Named officers with personas:** Sarah Okafor (commander, the proposer),
  John Mercer (reactor, impatient under pressure), Viktor Hale (power, fast and
  overconfident), Maya Chen (life support, protective of the crew), with light
  interpersonal priors. A persona shapes how an agent talks, never what it
  knows. Nothing steers the room toward success: a believable coordination
  failure is as valid an ending as a rescue.
- **Spoken, short dialogue** (v4, v5). A shared speech style in each officer's
  `systemPrompt`: one point per turn, usually one or two short sentences, no
  restating, no politeness formulas. Since v5 two more rules apply. An officer
  PASSes instead of repeating a point or question that has already been
  answered; this is scoped to the mission discussion, because the same prompt
  also reaches the debrief, where there is no PASS. Officers also talk about
  what should be done instead of reporting actions as done before the vote,
  so the ending's "Decision locked — executing" is the moment things happen. The personas give each character a
  concrete reason to push back. This is part of the behavior layer, so it
  changes agent behavior (and `configHash`), but not the task.
- **A narrator** (MISSION CONTROL): the opening, a few observer-only
  escalation beats during the run, and an ending revealed step by step (vote
  tally → procedure starts → grounded result).
- **Viewer pacing**, so a live audience can follow the conversation.

The building blocks are generic, and Kestrel is simply the first scenario to
use all of them:

| Config | What it does |
|---|---|
| `agents[].objective` | What the agent is responsible for. Part of the task definition. |
| `agents[].persona` | Personality, tendencies, interpersonal priors. Behavior layer. |
| `conversation.language` | Language of everything participants and viewers read: messages, proposal rationale, vote reasons, moderator notices, narration. JSON field names, ids and enum values are never translated. A run can override it without editing the scenario. |
| `presentation.narrator` | `{ displayName }`, or `null` for no narration. |
| `presentation.strings.<lang>` | Authored per language: `title`, `narratorName`, `opening`, `outcomes.<OUTCOME>` (plus `default`), `missionFailure.<check>` — each either one text or a **list of parts** revealed one by one — and `beats.<id>`; for viewers only, `agents.<id>` (`{ name, role }` display labels) and `proposal` (`{ template, values }`, a human-readable rendering of the submitted proposal). Agents and the protocol notices they read keep the config's names and the raw proposal. |
| `presentation.fallbackLanguage` | Used for any string missing in the conversation language. |
| `presentation.missionFailurePriority` | Evaluator checks in narrative order; the first violated one picks the `MISSION_FAILURE` ending. All violated checks stay in the technical results. |
| `presentation.pacing` | `minVisibleIntervalMs`, `perCharMs`, `maxGapMs`, optional `sequencePauseMs` (minimum pause between the parts of an ending) (see below). |
| `presentation.beats` | Optional observer-only narration during the run: `[{ id, when }]` with `when` = `{ discussionProgress: 0.4 }` (the first time a discussion round has used that fraction of its turn limit) or `{ planRejected: true }` (after each "not approved" notice). A due beat is shown just before the next visible message, so it never interrupts one. Texts: `strings.<lang>.beats.<id>`. |

**Narration is for observers only.** Narrator messages are published to the
room, but they are filtered out of every agent's and the router's context.
Everything agents need comes from the task, their role, objective, persona and
private information, so the literary text can never become an extra
information channel.

**Endings are deterministic.** No model is called to write them. The ending
is chosen by outcome (and, for `MISSION_FAILURE`, by the primary violated
check), then filled from real values: `{{derived.availableKw}}`,
`{{params.coolantRequiredKw}}`, `{{checks.<name>.detail}}`, `{{reason}}`, …
A plan with 22 kW of 30 therefore yields "22 kW available, 30 kW required".
The vote tally is available as `{{votes.approvals}}` / `{{votes.eligible}}`.
Beats are deliberately qualitative ("reactor conditions are deteriorating"):
there is no reactor simulation behind them, so they never state numbers the
run does not have. Atmosphere may be literary, but facts stay grounded.
Technical outcomes (`PROVIDER_ERROR`, `ERROR`, `INTERRUPTED`,
`STOPPED_BY_OPERATOR`) get a short neutral message instead of an in-universe
disaster.

**Languages.** Kestrel's narration is authored in `en` and `ru`, and the
runtime's own moderator notices exist in the same two. For any other code
(e.g. `sr-Latn`), agents still write in that language, while narration and
notices fall back to English. Machine values stay unchanged: the trace keeps
`APPROVE`/`REJECT` even when the room shows «за» / «против».

**Pacing** holds each visible message until the previous one has been on
screen for `min(maxGapMs, minVisibleIntervalMs + previousLength × perCharMs)`.
The interval is measured from when the previous message appeared, so a slow
provider reply needs little or no extra wait. The wait is recorded as
`presentation_delay` and counts neither as provider latency nor as experiment
time: `wall = active + paused + presentation`, and only `active` drives
`timeLimitSeconds`. Stop interrupts the wait immediately. The benchmark uses
0; Kestrel uses 2 s + 10 ms per character, capped at 6 s, 2.5 s between the
parts of the ending, a 20-turn discussion limit (v4: short turns need more of
them) and 300 output tokens per turn (a safety cap; brevity comes from the
prompt, because a lower cap would truncate the proposal JSON, not the prose). A demo should not
run long, and v1's 2.5 s / 20 ms / 9 s made a verbose live run take about
5 minutes. Tune these by watching real runs.

**Station Kestrel: Cascade** is a harder demo with the same crew, personas,
speech style, narrator, pacing and debrief. It is a *different task* (its
own facts, evaluator `kestrel-cascade` and `taskDefinitionHash`), built so
that no single officer can find the safe procedure alone. Two recovery paths
look plausible, and the facts that decide between them are split up:

| Officer | Holds |
|---|---|
| John (engineering) | Loop B needs 30 kW; thermal dump C needs only 18 kW but vents through service ring R3, which must be evacuated and isolated first; the reactor window is about 4 minutes |
| Viktor (power) | 10 kW reserve + 12 labs = 22 kW, enough for C; loop B also needs communications (8 kW), and cutting them powers down the service craft's approach beacon |
| Maya (life support) | Six crew in R3; evacuating them takes about 6 minutes |
| Sarah (operations) | The beacon has an emergency battery, safe only if it is switched over *before* comms go off |

Only when these facts are combined does it become clear that C cannot be made
safe in time (6 min > 4 min), and that B works only as: beacon to battery →
labs off → comms off → 30 kW to loop B → start → SCRAM, with life support kept
at 40 kW. The 4-minute figure is deliberately not in the shared context, so it
has to be communicated.

The proposal is `{ recovery_path, actions[] (ordered), life_support_power_kw }`.
Every unsafe plan stays expressible. The evaluator requires only one ordering:
beacon before comms (and, for C, R3 evacuated and isolated before the dump).
Each failure mode is its own check, with its own grounded ending: C chosen,
B with 22 kW, beacon unprotected, life support diverted, no SCRAM. Stub
variants `cascade/cooperative` (success) and `cascade/dump-c` (failure) let it
run keyless.

**Two hashes.** `configHash` identifies the exact configuration.
`taskDefinitionHash` identifies the underlying problem: task text, each
agent's id, role, objective and private context, the decision protocol and
the evaluator with its parameters. Runs of Kestrel in English, Kestrel in
Russian and the benchmark share a `taskDefinitionHash`, but they are **not**
the same experimental condition: persona, models and language change
behavior.

---

## People in the room: spectators and debrief

A room can have people in it: in a live demo they type while the agents work.
The testbed's answer is conservative. **Humans never take part in an active
experiment.** What they can do is set by `humanInteraction.profile`:

| Profile | During the run | After the outcome |
| --- | --- | --- |
| `OBSERVE` (default when absent) | spectator chat | spectator chat |
| `DEBRIEF` (Station Kestrel) | spectator chat | a separate **debrief session**: people question the characters |
| `ADVISORY`, `TAKE_ROLE` | *not implemented*; refused before a run exists | |

**During the run** a human message is recorded and shown to other people in the
room, and nothing else. It never enters an agent's prompt, readiness,
routing, turns, proposal, votes, evaluator, budget or the experiment trace.
Text that looks like a command ("STOP", "/force-decision") is just chat:
operator controls exist only as API/UI actions. So that nobody thinks the
system is broken, one localized notice explains that the crew will be
available after the mission. It goes out at most once per person, and not
within 30 s of the previous one: that one is on screen for everyone.
Messages written during the mission are **not** queued for the debrief.

**The debrief** opens automatically after the ending narration, as its own
event (`debrief_started`) and a visible notice. It is never a continuation of
the runner: the outcome, metrics, proposal, votes and evaluation are frozen.

- **Queue.** Several people may ask. Questions form one FIFO queue and are
  answered **strictly one at a time**, one character per question, with at
  most one LLM call in flight. When something is already in progress, the
  asker is told their question is queued (with position).
- **Who answers.** In order: an explicit reply to a character's message; an
  explicit mention; a character's name in the text (either language,
  including Russian case forms: *Виктору*, *Саре*); the scenario's router
  model (hybrid scheduler classifier), if confident; the scenario's
  `debrief.defaultAgentId` (Kestrel: Sarah), else the proposer.
- **Perspective.** A character answers with its own mission model
  (`debrief.maxOutputTokens` caps the answer). It gets its persona and role,
  **its own** private information and votes, the public transcript, the
  committed decision, the outcome as announced, and the debrief so far. It
  does **not** get another character's unrevealed private context. The
  evaluator's check results are included only with `debrief.revealEvaluation`,
  because they can reveal facts only another character knew. The prompt states
  that the mission is recorded history that cannot be rewritten, and that
  hindsight should be marked as hindsight.
- **Limits.** `maxPendingPerUser` (default 3) and `maxPendingTotal` (20)
  reject extra questions with a deterministic notice, rate-limited per
  person. `costCapUsd` closes the session once reached. It is idle-closed
  after `idleTimeoutMinutes` (15).
- **Separate accounting.** Debrief tokens, cost and LLM calls are counted per
  session, never in experiment metrics: a run still says "17 turns, $0.18,
  SUCCESS" however long people talk to the crew afterwards.
- **Lifecycle.** An operator can close a session, and can open a **new** one.
  Closed and interrupted sessions are immutable history. On server restart an
  open session becomes `INTERRUPTED`, and its unanswered questions are marked
  failed. Nothing is replayed. Batch runs never open a debrief. Only new text
  messages count: edits, reactions and attachments are ignored.

Everything is persisted outside the experiment, cross-referenced by
experiment id: `debrief_sessions` holds status, usage and who opened each
session; `interaction_events` holds human messages, notices, queueing, routing
decisions, every debrief LLM call with its prompt, answers and failures. The
experiment page shows these derived counts separately, under *People in the
room*: spectator messages (with "human assistance: none"), sessions with
their usage, and the debrief conversation.

Notice texts have built-in en/ru defaults. A scenario can override any of them
in `presentation.strings.<lang>.interaction`; Kestrel's are crew-voiced.

---

## Using the web UI

`npm run gui` serves a vanilla-JS single-page app with no build step.

**Scenario library.** Built-in scenarios come first, then your own. Each card
has **Run**, **Edit** (**View** for built-ins) and **Duplicate**. Built-ins
are read-only and kept in sync with the code: when a built-in's version is
bumped, its library entry is updated in place; your own scenarios are never
touched. **+ Create scenario** copies a built-in; **Import JSON** accepts a
bare config, a scenario export or an experiment export.

**Run dialog.** Choose the conversation language for this run only; the saved
scenario is neither edited nor versioned. Then **Start** opens the control
view, **Start & watch** opens viewer mode.

**Editor tabs:**

- **Task:** name, description, task text, shared context.
- **Agents:** id, name, role, objective, persona, provider/model/temperature/seed/max
  tokens, structured-output mode, OpenRouter routing (advanced), extra system
  prompt, private context. For `openrouter`, the model field offers
  OpenRouter's current model list: type to search by the stable model id.
  Below it you see the model's name, context size and price per million
  tokens. There is a warning when the model does not list structured outputs
  but the mode is `native`, or when the id is not in the list. The list comes
  from OpenRouter's public `/models` endpoint (no key sent) and is cached on
  the server for 6 hours. Offline, the field is plain text.
- **Protocol:** scheduler, start agent, router classifier, consensus rule,
  proposer, attempts, agent visibility, transport.
- **Limits:** soft discussion limits, hard limits, runtime retries and timeouts.
- **Evaluator:** evaluator and its parameters; the proposal schema for reference.
- **Presentation:** narration (narrator, per-language strings,
  mission-failure priority, beats), pacing.
- **People in the room:** the human-interaction profile and debrief settings.

The tabs come in two groups, mirroring the architecture:

- **Experiment** (Task, Agents, Protocol, Limits, Evaluator) defines what
  agents know and do and how the result is judged. Each agent card separates
  its *task definition* (id, role, objective, private context) from its
  *behavior & model* (name, model, persona, extra prompt). The conversation
  language sits under Protocol, because it changes what agents write.
- **Presentation & demo** (Presentation, People in the room) holds everything
  only viewers and people in the room experience. None of it reaches agents,
  the protocol or the result.
- **Raw JSON:** the complete config, editable.

Actions: **Save** (the version goes up only when something changed),
**Validate**, **Run**, **Duplicate**, **Export**, **Delete**.

**Viewer mode** (`#/watch/<experiment-id>`, or **Viewer mode** on an
experiment page) is for people watching a run rather than controlling it: a
clean full-screen room with the narrator, agent names and roles, moderator
notices, auto-scroll, a subtle "… is thinking" hint and a live/ended status.
It has no debug metadata, technical panels or operator controls. It is a
projection of the run's event stream plus the room's human side (the
interaction log), useful for rehearsals, screen recordings and live demos.
People can type into it (name + message): spectator chat during the run,
questions once the debrief is open. Clicking a character's message replies to
that character. Several browser tabs act as several people.

**Experiment view.** The live room plus a runtime-state panel:

- phase, current agent, turns used against limits, discussion round, proposal attempt;
- agent and orchestration tokens, cost, active time;
- per-agent readiness (ready, stale, not ready) and the last routing decision
  with its source and reason.

Operator controls:

- **Pause** / **Resume**.
- **Force next turn:** while paused, runs exactly one more activation.
- **Select next agent.**
- **Force decision.**
- **Stop.**

Select, force-decision and stop change the course of the run, so they mark it
as a *manual intervention*. Every command is recorded in the trace. The
**debug** toggle shows the control metadata inline in the room.

After the run the view shows the outcome, the final proposal (id and hash), the
votes, every evaluator check, per-agent usage, routing statistics and the full
chronological event trace with expandable payloads. Buttons: **Rerun same
config**, **Export JSON**.

**Batches.** A form to define variables × repetitions with a preview of the
resulting conditions, and a results page with per-condition aggregates plus CSV
and JSON export. Batch runs are hidden from the Experiments list by default;
a toggle shows them.

---

## Command line

```bash
npm run experiment -- [space-station | station-kestrel | path/to/config.json] [--db <dataDir>] [--language ru]
npm run batch -- path/to/batch-spec.json [--db <dataDir>] [--out results.json] [--csv runs.csv]
```

Both use the same engine and database as the UI, so CLI runs appear in the UI
as well. `--language` overrides the conversation language for that run. CLI
runs are headless, so viewer pacing is off unless you pass `--pacing scenario`. `Ctrl+C` stops the experiment, or cancels the batch. The summary JSON
goes to stdout and progress to stderr; add `-s` (`npm run -s experiment …`) so
npm's own banner does not mix into the JSON.

For automation, invoke Node directly, e.g. `node --import tsx src/cli/batch.ts spec.json`.
A process supervisor that kills the process then actually stops it; through an
`npm`/`npx` wrapper, only the wrapper may be killed.

---

## Experiment configuration

A config is one serializable JSON document, validated by the zod schema in
[src/experiment/config.ts](src/experiment/config.ts). It is stored fully resolved,
with all defaults filled in, and hashed canonically. The complete reference is
[src/scenarios/spaceStation/config.ts](src/scenarios/spaceStation/config.ts).

```jsonc
{
  "schemaVersion": 1,
  "name": "Space Station Emergency",
  "task": { "description": "…", "sharedContext": "…" },   // given to every agent
  "agents": [{
    "id": "power", "name": "Power Systems", "role": "…",
    "model": { "provider": "openrouter", "model": "anthropic/claude-sonnet-5",
               "temperature": 0.7, "seed": 1, "maxOutputTokens": 800,
               "structuredOutput": "native",              // or "prompt"
               "routing": { "only": ["together"] } },      // optional, OpenRouter only (see below)
    "objective": "…",                                      // task definition
    "persona": "…",                                        // behavior layer
    "systemPrompt": "…",                                   // optional extra instructions
    "privateContext": "…",                                 // only this agent sees it
    "tools": []                                            // reserved
  }],
  "scheduler": { "type": "hybrid", "startAgentId": "operations",
                 "classifier": { "provider": "openrouter", "model": "…" },  // or null
                 "classifierWindow": 12 },                 // or { "type": "round_robin" }
  "consensus": { "rule": "unanimity" },                    // or "majority"
  "decision": { "proposerId": "operations", "maxProposalAttempts": 2, "maxProposalFormatRetries": 1 },
  "limits": {
    "discussionTurnLimit": 24,        // soft: ends discussion, not the run
    "rediscussionTurnLimit": 8,       // soft: per return to discussion after a failed attempt
    "globalTurnLimit": 80,            // hard safety fuse over all activations
    "agentTokenLimit": null,          // hard experimental budget
    "countOrchestrationTokens": false,// include router tokens in agentTokenLimit?
    "totalTokenCap": null,            // hard absolute cap: agents + orchestration
    "totalCostCapUsd": null,          // hard emergency brake
    "timeLimitSeconds": 900           // hard; active time, operator pauses excluded
  },
  "agentVisibility": { "discussionBudget": false },
  "conversation": { "language": "en" },                    // a run may override it
  "presentation": { "narrator": null, "strings": {}, "pacing": { "minVisibleIntervalMs": 0 } },  // see Scenarios section
  "runtime": { "maxParseRetries": 1, "maxProviderRetries": 2, "providerRetryDelayMs": 2000, "callTimeoutSeconds": 120 },
  "evaluator": { "id": "space-station", "params": { "baseReserveKw": 10, "…": "…" } },
  "transport": { "type": "local" }
}
```

Notes:

- **Credentials never appear in configs.** A model names a provider id; the key
  lives only in `.env`.
- **`agentVisibility.discussionBudget` is off by default** because it changes
  behavior: an agent that sees "21 of 24 turns used" hurries and agrees sooner.
  Turn it on for demos, keep it off for baseline research runs. The runtime and
  the UI always know these numbers.
- **`structuredOutput: "native"`** asks the provider to enforce the response
  JSON schema. Use `"prompt"` for model routes that reject `response_format`.
  The schema is always included in the prompt, and every response is parsed and
  validated either way.
- **`routing`** (OpenRouter only; rejected for other providers) constrains
  which upstream backend serves the model: `order`, `only`, `ignore` (provider
  slugs, e.g. `"deepinfra"`), `allowFallbacks`, `requireParameters`, `sort`
  (`price` / `throughput` / `latency`), `quantizations`, `dataCollection`.
  Omitted means OpenRouter chooses automatically. One effective default:
  **`requireParameters: true` whenever `structuredOutput` is `"native"`**,
  because routing to a backend without `response_format` support contradicts
  that mode (seen live: the same Llama model degenerated on one backend). An
  explicit `false` overrides it, and the editor warns about it. The same model
  can behave materially differently per backend, so every `llm_call` records
  both the requested and the effective routing, plus the backend that actually
  served it (`providerMeta.upstreamProvider`, a display name rather than a
  slug). In a batch, vary it like any field: `agents.*.model.routing`.

---

## Experiment lifecycle

```
INITIALIZING → DISCUSSION → PROPOSAL → VOTING → COMMITTED → EVALUATION → FINISHED
                   ↑           │          │
                   └───────────┴──────────┘   failed attempt, attempts left
```

**Turn.** A turn is one agent activation in any phase: discussion, proposal or
vote. A PASS is a turn. A router/classifier call is **not** a turn. Turns and
public messages are counted separately. Parse retries inside one activation
belong to the same turn; a proposal re-request with schema errors fed back is a
new turn.

**Discussion** ends when:

- every agent's readiness is valid;
- `discussionTurnLimit` is reached (or `rediscussionTurnLimit` after a failed attempt);
- or the operator forces the decision.

**Readiness goes stale.** Readiness is tied to a position in the conversation.
When another agent posts a substantive, non-PASS message after a declaration,
that declaration becomes stale. The decision phase is never entered on stale
readiness. If everyone has declared ready but some declarations are stale, the
runtime re-asks exactly those agents; this is routing source
`readiness_recheck`. A re-checked agent is told why it is asked (which messages
arrived after its declaration) and that it should PASS if they do not change
its view. Without that note, live models answered every re-check with a
restated confirmation, which invalidated the others' readiness in turn and
looped until the discussion limit.

**Routing** (`hybrid`):

1. Use the explicit target named by the speaker, if it is valid.
2. Otherwise ask the LLM classifier.
3. Otherwise, or if the classifier fails, fall back deterministically to the
   agent who has waited longest.

Every decision is traced with its source and reason. A classifier outage never
ends a run. `round_robin` follows the config order and ignores targets.

**Proposal.** The configured proposer submits `{ rationale, proposal }`.
Validation checks the scenario's proposal schema only, i.e. structure. It never
checks success constraints, which would leak the evaluator. A valid proposal is
frozen into an immutable artifact with an id and a sha256 hash of its canonical
JSON, and published to the room. The proposer may decline (`proposal: null`).

**Voting.** Every agent votes on exactly that frozen artifact, blind and in
parallel against the same transcript snapshot. An unparseable vote is `INVALID`
and never counts as approval. After voting closes, rejection reasons are
published to the room for the next discussion round.

**Evaluation** runs only on a committed proposal.

---

## Outcomes

A run ends with one outcome. Each outcome has a category and a coarse status.
The fine-grained outcome is always preserved, because a malformed proposal, a
provider outage, a failure to agree and an agreed plan that fails the evaluator
are different research results.

| Category | Outcome | Status |
|---|---|---|
| task | `SUCCESS`, `MISSION_FAILURE` | SUCCESS / FAILURE |
| coordination | `CONSENSUS_FAILURE`, `NO_PROPOSAL` | FAILURE |
| protocol | `PROPOSAL_PARSE_FAILED`, `PROPOSAL_INVALID` | FAILURE |
| budget | `TOKEN_BUDGET_EXCEEDED`, `COST_LIMIT_EXCEEDED`, `TIMEOUT`, `TURN_LIMIT_EXCEEDED` | FAILURE |
| infrastructure | `PROVIDER_ERROR`, `ERROR`, `INTERRUPTED` | ABORTED |
| operator | `STOPPED_BY_OPERATOR` | ABORTED |

Recoverable problems do not end the run. Unparseable turns, invalid votes,
router failures and schema-rejected proposals are recorded as
`protocol_incident` or `proposal_rejected_format` events.

**Limit semantics.** Token and cost limits are checked at step boundaries; an
in-flight call is never cut short for tokens. A limit can therefore be
overshot by one step, and a step is not always one call: the voting step is N
parallel calls. The overshoot is recorded in the outcome detail. The cost cap
is an emergency brake, not a guarantee: cost is known only after a call
returns, so per-call `maxOutputTokens` is what bounds the worst case. The time
limit is the exception: it also aborts an in-flight call.

---

## Batch experiments

A batch runs one base configuration under every combination of variable values,
N times each, through the normal engine. Every run is an ordinary experiment,
tagged with its batch, condition and repetition.

```json
{
  "name": "Scheduler × consensus",
  "base": { "scenarioId": "…" },
  "variables": [
    { "path": "scheduler.type", "label": "scheduler", "values": ["round_robin", "hybrid"] },
    { "path": "consensus.rule", "label": "consensus", "values": ["unanimity", "majority"] },
    { "path": "agents.*.model.model", "label": "model", "values": ["anthropic/claude-sonnet-5", "openai/gpt-5.5"] }
  ],
  "repetitions": 10,
  "concurrency": 2,
  "stubLatencyMs": 0,
  "order": "interleaved"
}
```

- **`base`:** `{ "scenarioId" }` (a saved scenario; its version is recorded),
  `{ "builtin": "space-station" }`, `{ "config": {…} }`, or, in the CLI only,
  `{ "configPath": "…" }`. The base is resolved and stored when the batch is
  created, so later scenario edits never change a batch.
- **Paths:** a dotted field; `*` for every array element
  (`agents.*.model.model`); a whole object as the value (`"scheduler"`); or the
  virtual `$agents`, whose value is the list of agent ids to keep (to vary the
  number of agents).
- **Validation up front:** every condition is validated before anything runs.
  One broken condition rejects the whole batch, naming the condition. The limit
  is 2000 runs per batch.
- **`order: "interleaved"`** (the default) runs repetition 1 of every condition,
  then repetition 2, and so on, so provider drift over time spreads evenly
  across conditions.
- **`stubLatencyMs`** defaults to 0. Batches never inherit the web demo's
  `STUB_LATENCY_MS`.
- **`pacing`** is `"off"` by default: batch runs are headless, so a scenario's
  viewer pacing (e.g. Kestrel's) is disabled for them and recorded as
  `pacingDisabled` in the run environment. Use `"scenario"` to keep it.
  Narration is still posted and traced either way.
- **`concurrency`** limits simultaneous *experiments*. What limits simultaneous
  *provider requests* is the process-wide `LLM_MAX_CONCURRENT_REQUESTS`,
  because one experiment's voting step alone issues one request per agent.

**Aggregates** (per condition and overall):

- success rate with a 95% Wilson interval, and consensus rate;
- outcome and category counts;
- mean, median, min and max of total, agent and orchestration tokens, turns,
  public messages and active duration;
- total and mean cost, and the number of calls of unknown cost.

Success and consensus rates are computed over **evaluable** runs only.
**Excluded** runs (`PROVIDER_ERROR`, `ERROR`, `INTERRUPTED`,
`STOPPED_BY_OPERATOR`) are always reported next to them, broken down by
outcome. Provider errors get their own warning in the UI and the CLI, so
provider instability is never hidden by the denominator.

**Export:** CSV with one row per run (a column per variable, outcome, category,
consensus, turns, messages, tokens, cost, duration, intervention flag, config
hash), or JSON (the resolved spec, aggregates and per-run summaries).

A runnable example: [examples/space-station-batch.json](examples/space-station-batch.json),
12 conditions × 3 repetitions on stub agents.

---

## Trace, metrics and reproducibility

Every run stores:

- **the config snapshot** (fully resolved, with per-run overrides applied), its
  canonical `configHash`, the `taskDefinitionHash`, and the scenario id and
  version it came from;
- **the testbed version:** package version, git commit and a dirty-working-tree
  flag (a dirty run cannot be reproduced from the commit alone), Node version;
- **the run environment:** origin (`interactive` / `batch` / `cli`), stub
  latency, the effective SQLite durability mode, the provider request limit,
  the effective conversation language, the scenario's default language and
  whether the language was overridden for this run;
- **the evaluator id and version.**

Event types, in the order they typically appear:

| Event | Contents |
|---|---|
| `experiment_started` | config, hash, versions, environment, agents with models |
| `phase_changed` | from, to, why (e.g. `discussionEnd: all_ready`) |
| `routing_decision` | chosen agent, source, reason, details (invalid target, classifier failure) |
| `turn_started` / `turn_completed` | turn number, kind, result |
| `llm_call` | **every** provider attempt, including retries, failed and aborted ones: full rendered prompt, raw response, requested **and served** model, requested and effective OpenRouter routing plus the backend that served the call, usage, cost and its source (reported / estimated / unknown), duration, request-queue wait, parse result, temperature, seed |
| `message_posted` | a public room message: agent, moderator notice, or narration (with its source template and language; never shown to agents) |
| `presentation_delay` | a viewer-pacing wait before a visible message: waited, target gap, time since the previous message |
| `agent_meta` | the hidden control metadata of a turn |
| `readiness_changed` / `readiness_invalidated` | readiness transitions |
| `proposal_requested` / `proposal_rejected_format` / `proposal_declined` / `proposal_frozen` | the proposal sequence; `proposal_frozen` is the immutable artifact with its hash |
| `vote_cast` / `consensus_result` | each vote references the proposal id and hash |
| `evaluation_result` | outcome, every check with detail, derived values |
| `operator_intervention` | every operator command; `flowAltering` marks the ones that make the run non-autonomous |
| `protocol_incident` / `error` | recoverable protocol problems / unexpected errors |
| `experiment_finished` | termination (outcome, category, status, reason, detail), usage totals |

**Credentials never enter the trace.** Configured keys are scrubbed from every
payload before it is written, as defense in depth; keys are never part of
prompts or configs to begin with.

**What reproducibility means here.** LLM outputs are not deterministic. The
testbed records everything needed to re-run and compare the same configuration
(**Rerun same config** in the UI; the config hash is in every run). It does not
promise identical outputs. `seed` is best-effort metadata: providers honor it
very differently. Prefer exact model ids over aliases (e.g. `~…-latest`); the
served model is recorded either way.

**Durability.** SQLite runs in WAL mode with `synchronous = NORMAL` by default:
safe across process crashes and restarts, with only an OS crash or power loss
able to drop the latest commits. `SQLITE_SYNCHRONOUS=FULL` fsyncs every event.
On startup, runs cut off by a restart are closed as `INTERRUPTED` with a final
event, and batches cut off the same way are marked `interrupted`.

---

## Architecture

```
src/
  experiment/   config schema · state machine (phases) · ExperimentRunner (lifecycle loop, operator controls)
                LlmCaller (every model call: retries, parsing, tracing, budget) · protocol (prompts, response schemas)
                readiness · budget · outcome taxonomy · event log · metrics · ExperimentService (running experiments)
                protocolStrings (moderator notices agents read, en/ru) · RunExtension interface (extensions.ts)
  scheduling/   Scheduler interface · round-robin · hybrid (explicit → classifier → fallback)
  consensus/    ConsensusRule interface · unanimity · majority
  transport/    Transport interface · LocalTransport · ChumsTransport (extension point)
  evaluation/   ScenarioEvaluator interface · registry
  scenarios/    scenario packages (config + evaluator + stub scripts) · registries
  presentation/ run extensions: narrator (opening / grounded endings) · PacedTransport (viewer pacing)
  interaction/  HumanInteractionService (people in the room) · DebriefSession (FIFO queue) · addressing · debrief prompts
  batch/        spec & condition expansion · BatchService · aggregates
  llm/          provider interface · OpenRouter · Azure OpenAI · stub · registry · concurrency gate · pricing
  persistence/  SQLite (node:sqlite) · scenarios · experiments · events · batches · debrief sessions · interaction events
  server/       HTTP API on node:http (no framework)
  gui/public/   vanilla-JS SPA (no build step)
  cli/          run.ts · batch.ts
```

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

**Core vs. add-ons.** `ExperimentRunner` contains only experiment semantics.
That includes everything that can change what agents do or what the run
records as its result: turns, routing, readiness, proposal, voting,
evaluation, budgets, and the protocol notices agents read. Persona and
conversation language belong here too, as run configuration, because they
change behavior.

Everything for human observers is outside the core and attaches through one
interface, `RunExtension` ([src/experiment/extensions.ts](src/experiment/extensions.ts)):

- `wrapTransport` — e.g. `PacedTransport`;
- `onRoomOpened` / `onRunEnded` — e.g. the narrator;
- a context that can post observer-only messages, append trace events,
  observe the trace as it is written (read-only; e.g. narration beats), hold
  the experiment clock (excluded from active time, like a pause) and see the
  stop signal.

Extensions cannot touch turns, proposals, votes, evaluation or the outcome. A
failing extension is logged and changes nothing. The composition roots
(server, CLI, batch) attach `presentationExtensions`; without extensions the
runner is the bare core.

Viewer-only features (viewer mode, localized agent labels, the readable
proposal card) do not even need an extension. They are projections of the
event log.

**People in the room** (`src/interaction/`) sit *around* runs, not inside
them. The layer consists of:

- `HumanInteractionService`, which receives new human text messages from any
  source (the local viewer over HTTP now, a Chums adapter later);
- a `RoomOutlet` for posting;
- `ExperimentService.onRunFinished`, which starts the debrief.

The runner never receives a human message; `Transport.history()` holds only
the experiment's own messages. Agents see a transcript numbered over those
messages alone, so narration or human chat cannot shift what they read. The
debrief reuses `LlmCaller` with its own log and budget (`CallLog`,
`CallBudget`), so its calls never enter the experiment's trace or usage.
Future profiles that *would* change experiment semantics (advisory input,
a human taking a role) must come in through an explicit core interface, not
through branches in the runner.

A test enforces the boundary: no core module imports `src/presentation/` or
`src/interaction/`.

---

## Extending the testbed

**A new scenario.** Add a folder next to [src/scenarios/spaceStation/](src/scenarios/spaceStation/):

1. `evaluator.ts` — a `ScenarioEvaluator` with a `proposalSchema` (zod; *structure
   only*, so that unsafe plans remain expressible), a `paramsSchema` and a
   deterministic `evaluate()` that returns per-check results.
2. `config.ts` — the default experiment config (pure data). Keep the task
   definition in shared constants (see `spaceStation/task.ts`) if several
   scenarios should share one underlying task, as the benchmark and Kestrel do.
3. Optionally, personas and `presentation` (narrator, per-language strings,
   mission-failure priority, pacing) for a viewer-oriented variant.
4. Optionally, stub scripts for keyless runs and tests.
5. Register them in [src/scenarios/index.ts](src/scenarios/index.ts) with an id,
   a one-line summary and a version. Bump the version whenever the definition
   changes in a way that affects runs.

Nothing in `experiment/`, `scheduling/`, `presentation/` or `transport/` changes.

**A new scheduling strategy** (leader-based, expertise-based, random, …):
implement `Scheduler.next(ctx)` in [src/scheduling/](src/scheduling/) and add
it to `createScheduler` and to the config's scheduler union. Schedulers receive
the public room only.

**A new decision rule** (leader decision, weighted expertise, domain veto):
implement `ConsensusRule.decide(votes, eligible)` in
[src/consensus/index.ts](src/consensus/index.ts).

**Chums Chat transport.** [src/transport/chumsTransport.ts](src/transport/chumsTransport.ts)
is the adapter point. It currently throws "not implemented", and the runner
refuses `"transport": { "type": "chums" }` up front. To implement it, fill in
`open` (create or join the room), `publish` (post as an agent or as the
moderator) and `history` (the ordered room history), and drop the up-front
refusal in `checkRunnable()` ([src/experiment/runner.ts](src/experiment/runner.ts)).
Agents, scheduling and the runner only ever talk to the `Transport` interface.
People's messages in a Chums room are not the transport's business. The
adapter hands each new text message
([`HumanRoomMessage`](src/transport/humans.ts)) to
`HumanInteractionService.receive()`, and implements a `RoomOutlet` so notices
and debrief answers are posted to the real room. The adapter must keep its own
bots' messages out of the human stream, and humans' messages out of
`history()`.

**A new LLM provider:** implement `LlmProvider.complete()` in [src/llm/](src/llm/)
and register it in `createProviderRegistryFromEnv`.

---

## HTTP API

The UI uses exactly this API, and so can scripts. JSON in, JSON out; `POST` and
`PUT` require `Content-Type: application/json`.

| Method & path | Purpose |
|---|---|
| `GET /api/meta` | versions, providers (with request-gate state), stub models, evaluators (with proposal schemas), schedulers, consensus rules, outcomes, builtin scenarios |
| `GET /api/providers/openrouter/models` | OpenRouter's model catalog for the editor: id, name, context, price per M tokens, structured-output support (cached 6 h; 502 if unreachable) |
| `GET/POST /api/scenarios` | library (built-ins first, read-only) / create a user scenario (`{config}` or `{builtin}`) |
| `POST /api/scenarios/validate` | schema and runnability check, without saving |
| `GET/PUT/DELETE /api/scenarios/:id` | read / update (version bump on change) / delete |
| `POST /api/scenarios/:id/duplicate` | copy (the way to edit a built-in) |
| `POST /api/scenarios/:id/run` | start a run; optional `{overrides: {language}}` applies to this run only |
| `GET /api/experiments?scenarioId=&batchId=&taskDefinitionHash=&batches=exclude` | list |
| `POST /api/experiments` | start an ad-hoc run from `{config, overrides?}` |
| `GET /api/experiments/:id` | record + live state |
| `GET /api/experiments/:id/events?after=N` | incremental event stream (the UI polls it) |
| `POST /api/experiments/:id/control` | `{type: pause \| resume \| step \| select_next (agentId) \| force_decision \| stop}` |
| `POST /api/experiments/:id/rerun` | same config snapshot, new run |
| `GET /api/experiments/:id/export` | record + every event |
| `DELETE /api/experiments/:id` | delete a finished run (and its debrief data) |
| `GET /api/experiments/:id/interaction?after=N` | the room's human side: profile, mode (mission / debrief / closed / observe), open session with queue state, all sessions, derived counts, interaction events |
| `POST /api/experiments/:id/room/messages` | a person's text message `{senderId, displayName, text, replyTo?, mentions?}`; chat only, never a command |
| `POST /api/experiments/:id/debrief` | operator: `{action: open}` (always a new session) or `{action: close}` |
| `POST /api/batches/preview` | expand and validate a spec without running |
| `GET/POST /api/batches` | list / start (`{spec}`) |
| `GET /api/batches/:id` | progress + aggregates |
| `POST /api/batches/:id/cancel` | stop in-flight runs, start no more |
| `GET /api/batches/:id/export?format=csv` | per-run CSV (default: JSON) |

Status codes: 400 for an invalid or non-runnable config or spec (with a
`problems` list), 404 for an unknown id, 409 for an action that is invalid in
the current state (including editing or deleting a built-in scenario).

In a batch, the conversation language is an ordinary variable:
`{ "path": "conversation.language", "values": ["en", "ru"] }`.

---

## Configuration (.env)

See [.env.example](.env.example). All variables are optional.

| Variable | Default | Meaning |
|---|---|---|
| `OPENROUTER_API_KEY` | — | Enables the OpenRouter provider (the main path: many vendors, one key) |
| `OPENROUTER_SITE_URL`, `OPENROUTER_SITE_NAME` | — | Optional attribution headers |
| `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_VERSION` | — | Enables Azure OpenAI (an agent's `model` is then the deployment name) |
| `LLM_MAX_CONCURRENT_REQUESTS` | `8` | Simultaneous in-flight requests per real provider, process-wide |
| `SQLITE_SYNCHRONOUS` | `NORMAL` | Trace durability: `NORMAL`, `FULL`, `EXTRA`, `OFF` |
| `STUB_LATENCY_MS` | `300` | Stub latency in the web UI only, so stub runs can be watched live |
| `DATA_DIR` | `./data` | Where the SQLite database lives |
| `GUI_PORT` / `PORT` | `3939` | Web UI port |
| `GUI_HOST` | `127.0.0.1` | Bind address. **There is no authentication**; only use `0.0.0.0` deliberately |

---

## Development

```bash
npm test         # vitest — hermetic: never reads your .env, never calls a real provider
npm run build    # tsc type-check + compile to dist/
```

The tests cover:

- the evaluator, including every failure example from the scenario;
- the lifecycle end to end on stub agents;
- routing, readiness invalidation, budgets and limits;
- proposal validation and immutability, and blind parallel voting;
- operator controls, parse and provider retries, secret redaction;
- the request gate;
- batch expansion, execution, cancellation and aggregates;
- the HTTP API and restart recovery.

CI (`.github/workflows/ci.yml`) runs the build and the tests.

---

## Known limitations

- **Single process, in-memory scheduling.** Running experiments live in the
  server process; a restart ends them (they are recorded as `INTERRUPTED`).
  There is no distributed runtime.
- **The Chums transport is an interface only** (see above).
- **The request gate is a semaphore**, not RPM/TPM rate limiting. If limits
  are exceeded anyway, provider retries with backoff are the fallback, and runs
  that still fail end as `PROVIDER_ERROR` (reported separately in batches).
- **No authentication.** The server binds to loopback by default. In the
  viewer, a person is whatever display name they type; operator actions
  (including opening and closing a debrief) are unauthenticated API calls
  like every other control.
- **Human interaction:** only `OBSERVE` and `DEBRIEF` exist. One question gets
  one character's answer; there are no multi-character debrief exchanges. The
  stub characters' debrief answers are canned, one line per officer.
- **Tools** are reserved in the agent config but not implemented.
- **Live view and viewer mode** poll every second rather than streaming.
- **Stub agents speak English only.** The conversation language only takes
  effect with real models.
- **Authored presentation languages:** Kestrel's narration and the runtime's
  moderator notices exist in `en` and `ru`; other languages fall back to
  English for those texts (agents still use the requested language). The
  viewer page's own few labels exist in the same two languages.
- **Cost** comes from OpenRouter's reported per-call cost when available,
  otherwise from a small built-in pricing table; for other models it is unknown
  and counted as such.

## License

Apache-2.0 — see [LICENSE](LICENSE).
