# Scenarios

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
identically with or without it. Two scenarios with the same task side share a
`taskDefinitionHash` (see [reproducibility](../reproducibility.md#hashes)).

## Built-in scenarios

| Scenario | Task | Page |
|---|---|---|
| Space Station Benchmark (`space-station`) | Space Station (evaluator `space-station`) | [space-station.md](space-station.md) |
| Station Kestrel (`station-kestrel`) | the same Space Station task | [kestrel.md](kestrel.md) |
| Station Kestrel: Cascade (`station-kestrel-cascade`) | a different, harder task (evaluator `kestrel-cascade`) | [kestrel-cascade.md](kestrel-cascade.md) |

Built-ins are read-only in the library and kept in sync with the code: when a
built-in's version is bumped, its library entry is updated in place. Saved
copies keep the version they were created from; your own scenarios are never
touched.

## Building blocks

These are generic; Kestrel is simply the first scenario to use all of them.

| Config | What it does |
|---|---|
| `agents[].objective` | What the agent is responsible for. Part of the task definition. |
| `agents[].persona` | Personality, tendencies, interpersonal priors. Behavior layer. |
| `conversation.language` | Language of everything participants and viewers read: messages, proposal rationale, vote reasons, moderator notices, narration. JSON field names, ids and enum values are never translated. A run can override it without editing the scenario. |
| `presentation.narrator` | `{ displayName }`, or `null` for no narration. |
| `presentation.strings.<lang>` | Authored per language: `title`, `narratorName`, `opening`, `outcomes.<OUTCOME>` (plus `default`), `missionFailure.<check>` — each either one text or a **list of parts** revealed one by one — and `beats.<id>`; for viewers only, `agents.<id>` (`{ name, role }` display labels) and `proposal` (`{ template, values }`, a human-readable rendering of the submitted proposal); `interaction` (room notices, see [people in the room](../people-in-the-room.md)). Agents and the protocol notices they read keep the config's names and the raw proposal. |
| `presentation.fallbackLanguage` | Used for any string missing in the conversation language. |
| `presentation.missionFailurePriority` | Evaluator checks in narrative order; the first violated one picks the `MISSION_FAILURE` ending. All violated checks stay in the technical results. |
| `presentation.pacing` | `minVisibleIntervalMs`, `perCharMs`, `maxGapMs`, optional `sequencePauseMs` (minimum pause between the parts of an ending). See [pacing](#pacing). |
| `presentation.beats` | Optional observer-only narration during the run: `[{ id, when }]` with `when` = `{ discussionProgress: 0.4 }` (the first time a discussion round has used that fraction of its turn limit) or `{ planRejected: true }` (after each "not approved" notice). A due beat is shown just before the next visible message, so it never interrupts one. Texts: `strings.<lang>.beats.<id>`. |
| `humanInteraction` | Spectators and the post-run debrief; see [people in the room](../people-in-the-room.md). |

## Narration

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
there is no simulation behind them, so they never state numbers the run does
not have. Atmosphere may be literary, but facts stay grounded. Technical
outcomes (`PROVIDER_ERROR`, `ERROR`, `INTERRUPTED`, `STOPPED_BY_OPERATOR`) get a
short neutral message instead of an in-universe disaster.

**One failure check, one truthful statement.** An evaluator check should
correspond to exactly one fact the ending can state. A check meaning "A or B
went wrong" eventually gets an ending that lies about which one.

**Languages.** Narration is authored per language. The runtime's own moderator
notices exist in `en` and `ru`. For any other code (e.g. `sr-Latn`), agents
still write in that language, while narration and notices fall back to
`presentation.fallbackLanguage` / English. Machine values stay unchanged: the
trace keeps `APPROVE`/`REJECT` even when the room shows «за» / «против».

## Pacing

Pacing holds each visible message until the previous one has been on screen
for `min(maxGapMs, minVisibleIntervalMs + previousLength × perCharMs)`. The
interval is measured from when the previous message appeared, so a slow
provider reply needs little or no extra wait. The wait is recorded as
`presentation_delay` and counts neither as provider latency nor as experiment
time: `wall = active + paused + presentation`, and only `active` drives
`timeLimitSeconds`. Stop interrupts the wait immediately. Headless runs (CLI,
batches) skip pacing and reveal pauses; the trace records an `extension_note`.
Research scenarios use `minVisibleIntervalMs: 0`.

## Authoring a scenario

See [extending.md](../extending.md#a-new-scenario): an evaluator, a default
config, optionally personas and presentation, optionally stub scripts, and a
registry entry with a version.
