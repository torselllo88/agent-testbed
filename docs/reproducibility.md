# Trace, metrics and reproducibility

## What every run stores

- **the config snapshot** (fully resolved, with per-run overrides applied and
  evaluator params as the evaluator reads them), its canonical `configHash`,
  the `taskDefinitionHash`, and the scenario id and version it came from;
- **the testbed version:** package version, git commit and a dirty-working-tree
  flag (a dirty run cannot be reproduced from the commit alone), Node version;
- **the run environment:** origin (`interactive` / `batch` / `cli`), stub
  latency, the effective SQLite durability mode, the provider request limit,
  the effective conversation language, the scenario's default language,
  whether the language was overridden for this run, and `headless`;
- **the evaluator id and version.**

## Hashes

- **`configHash`** identifies the exact effective configuration — the one the
  run snapshots and executes, with evaluator params as the evaluator reads them
  (schema defaults applied: `{}` and every default written out are one
  configuration).
- **`taskDefinitionHash`** identifies the underlying problem: task text, each
  agent's id, role, objective and private context, the decision protocol and
  the evaluator — its id, **version** and parameters. It excludes identity
  (display names), persona and free-form system prompts, models, language,
  presentation, scheduling, limits and runtime settings. Two evaluator versions
  that judge one proposal differently are two tasks, so equal hashes always
  mean equal rules of success.
- **`evaluatorVersion`** is runtime metadata recorded with every run
  (`metrics.evaluatorVersion`, and a batch CSV column).

For analysis, `configHash` + `evaluatorVersion` identify a condition,
`taskDefinitionHash` the task. Runs of Kestrel in English, Kestrel in Russian
and the benchmark share a `taskDefinitionHash`, but they are **not** the same
experimental condition: persona, models and language change behavior.

## Event trace

Event types, in the order they typically appear:

| Event | Contents |
|---|---|
| `experiment_started` | config, hashes, versions, environment, evaluator, agents with models |
| `phase_changed` | from, to, why (e.g. `discussionEnd: all_ready`) |
| `routing_decision` | chosen agent, source, reason, details (invalid target, classifier failure) |
| `turn_started` / `turn_completed` | turn number, kind, result |
| `llm_call` | **every** provider attempt, including retries, failed and aborted ones: full rendered prompt, raw response, requested **and served** model, requested and effective OpenRouter routing plus the backend that served the call, usage, cost and its source (reported / estimated / unknown) — for a failed attempt too, when the provider billed it (e.g. an upstream failure mid-response), duration, request-queue wait, parse result, temperature, seed |
| `message_posted` | a public room message: agent, moderator notice, or narration (with its source template and language; never shown to agents) |
| `presentation_delay` | a viewer-pacing wait before a visible message: waited, target gap, time since the previous message |
| `extension_note` | something an add-on put on record (e.g. pacing skipped for a headless run) |
| `agent_meta` | the hidden control metadata of a turn |
| `readiness_changed` / `readiness_invalidated` | readiness transitions |
| `proposal_requested` / `proposal_rejected_format` / `proposal_declined` / `proposal_frozen` | the proposal sequence; `proposal_frozen` is the immutable artifact with its hash |
| `vote_cast` / `consensus_result` | each vote references the proposal id and hash |
| `evaluation_result` | outcome, every check with detail, derived values |
| `operator_intervention` | every operator command; `flowAltering` marks the ones that make the run non-autonomous |
| `protocol_incident` / `error` | recoverable protocol problems / unexpected errors (`metrics.errors`) |
| `extension_error` | an add-on (narration, pacing, …) failed; the run goes on unchanged. Counted apart, in `metrics.extensionErrors` — an integration problem, not an experiment error |
| `experiment_finished` | termination (outcome, category, status, reason, detail), usage totals, active / paused / presentation time |

Human interaction (spectators, debrief) is stored outside the experiment
trace; see [people in the room](people-in-the-room.md#persistence-and-notices).

## Metrics

Every metric is derived from the events. Durations: `wall = active + paused +
presentation`. The experiment's active time, usage and turns are fixed when
the outcome is decided, so add-on work at the ending (narration) is never
experiment time. Add-on failures are counted in `extensionErrors`, never in
`errors`.

**Credentials never enter the trace.** Configured keys are scrubbed from every
payload before it is written, as defense in depth; keys are never part of
prompts or configs to begin with.

## What reproducibility means here

LLM outputs are not deterministic. The testbed records everything needed to
re-run and compare the same configuration (**Rerun same config** in the UI;
the config hash is in every run). It does not promise identical outputs.
`seed` is best-effort metadata: providers honor it very differently. Prefer
exact model ids over aliases (e.g. `~…-latest`); the served model is recorded
either way.

## Durability and recovery

SQLite runs in WAL mode with `synchronous = NORMAL` by default: safe across
process crashes and restarts, with only an OS crash or power loss able to drop
the latest commits. `SQLITE_SYNCHRONOUS=FULL` fsyncs every event.

Running experiments live in one process; a run cut off by a dead process is
closed as `INTERRUPTED` with a final event, a batch cut off the same way is
marked `interrupted`, an open debrief session becomes `INTERRUPTED`, and an
external room binding gets one `run.state interrupted`. This happens at
startup and every minute while the server runs.

Each run, batch and debrief records the process that owns it, and every
process renews a lease in the database every 15 s. Recovery touches only rows
whose owner is gone:

- its pid no longer exists on this host — so a crash or restart is recovered
  at once; or
- its heartbeat has stood still, as measured on the recovering process's own
  monotonic clock, for a whole lease (60 s; another host) or for 10 minutes
  when its pid still exists here. A live process can freeze for minutes (a
  Windows console in QuickEdit selection mode blocks it), and interrupting it
  would kill a paid run; an orphan whose pid was reused only waits longer.

A clock jump or a machine waking from sleep cannot make a live owner look dead
either: after its own timers ran late, the server skips a recovery pass. Each
recovered row is closed atomically (the final event and the terminal row in
one transaction), so a pass that fails half-way is simply retried; a failed
startup recovery never keeps the server from starting. So a server started
next to a running CLI batch on the same database leaves that batch alone.
