# Web UI

`npm run gui` serves a vanilla-JS single-page app with no build step, on top of
the [operator HTTP API](http-api.md).

## Scenario library

Built-in scenarios come first, then your own. Each card has **Run**, **Edit**
(**View** for built-ins) and **Duplicate**. Built-ins are read-only and kept in
sync with the code: when a built-in's version is bumped, its library entry is
updated in place; your own scenarios are never touched. **+ Create scenario**
copies a built-in; **Import JSON** accepts a bare config, a scenario export or
an experiment export.

**Run dialog.** Choose the conversation language for this run only; the saved
scenario is neither edited nor versioned. Then **Start** opens the control
view, **Start & watch** opens viewer mode.

## Scenario editor

The tabs come in two groups, mirroring the architecture:

- **Experiment** — defines what agents know and do and how the result is judged:
  - **Task:** name, description, task text, shared context.
  - **Agents:** id, name, role, objective, persona, provider/model/temperature/seed/max
    tokens, structured-output mode, OpenRouter routing (advanced), extra system
    prompt, private context. Each agent card separates its *task definition*
    (id, role, objective, private context) from its *behavior & model* (name,
    model, persona, extra prompt). For `openrouter`, the model field offers
    OpenRouter's current model list: type to search by the stable model id.
    Below it you see the model's name, context size and price per million
    tokens. There is a warning when the model does not list structured outputs
    but the mode is `native`, or when the id is not in the list. The list comes
    from OpenRouter's public `/models` endpoint (no key sent) and is cached on
    the server for 6 hours. Offline, the field is plain text.
  - **Protocol:** scheduler, start agent, router classifier, consensus rule,
    proposer, attempts, conversation language (it changes what agents write),
    agent visibility.
  - **Limits:** soft discussion limits, hard limits, runtime retries and timeouts.
  - **Evaluator:** evaluator and its parameters; the proposal schema for reference.
- **Presentation & demo** — everything only viewers and people in the room
  experience; none of it reaches agents, the protocol or the result:
  - **Presentation:** narration (narrator, per-language strings,
    mission-failure priority, beats), pacing.
  - **People in the room:** the human-interaction profile, debrief settings,
    the debrief router and name aliases.
- **Raw JSON:** the complete config, editable.

Actions: **Save** (the version goes up only when something changed),
**Validate**, **Run**, **Duplicate**, **Export**, **Delete**. A field whose
text does not parse (e.g. invalid JSON) is marked and keeps what you typed;
Save, Validate and leaving the tab are blocked until it is fixed.

## Experiment view

The live room plus a runtime-state panel:

- phase, current agent, turns used against limits, discussion round, proposal attempt;
- agent and orchestration tokens, cost, active time;
- per-agent readiness (ready, stale, not ready) and the last routing decision
  with its source and reason.

Operator controls: **Pause** / **Resume**, **Force next turn** (while paused),
**Select next agent**, **Force decision**, **Stop** (see
[concepts](concepts.md#operator-controls)). The **debug** toggle shows the
control metadata inline in the room.

After the run the view shows the outcome, the final proposal (id and hash), the
votes, every evaluator check, per-agent usage, routing statistics and the full
chronological event trace with expandable payloads. Buttons: **Rerun same
config**, **Export JSON**. Under *People in the room*: spectator messages,
debrief sessions with their usage, and operator open/close.

## Viewer mode

`#/watch/<experiment-id>`, or **Viewer mode** on an experiment page: a clean
full-screen room for people watching a run rather than controlling it — the
narrator, agent names and roles, moderator notices, auto-scroll, a subtle
"… is thinking" hint and a live/ended status. It has no debug metadata,
technical panels or operator controls. It is a projection of the run's event
stream plus the room's human side (the interaction log), useful for
rehearsals, screen recordings and live demos.

People can type into it (name + message): spectator chat during the run,
questions once the debrief is open. Clicking a character's message replies to
that character. Several browser tabs act as several people. While the
experiment is bound to an open external room, the message box is replaced by
a note: people talk in that room.

## Batches

A form to define variables × repetitions with a preview of the resulting
conditions, and a results page with per-condition aggregates plus CSV and JSON
export. Batch runs are hidden from the Experiments list by default; a toggle
shows them. See [batches](batches.md).
