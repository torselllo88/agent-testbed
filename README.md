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
the Space Station officers. The whole scenario then runs end-to-end, free and
offline. The first start saves a copy of the built-in Space Station Benchmark scenario in the database.

To run real LLM agents:

1. `cp .env.example .env` and set `OPENROUTER_API_KEY` (or the Azure OpenAI variables).
2. Restart `npm run gui`. The Overview page shows which providers are configured.
3. Open **Scenarios → Space Station Benchmark → Agents**. For each agent set
   provider `openrouter` and a model, e.g. `anthropic/claude-sonnet-5`.
   Different agents can use different models. Point the router classifier
   (**Protocol** tab) at a real model too, or turn it off.
4. **Save**, then **Run**.

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

## Using the web UI

`npm run gui` serves a vanilla-JS single-page app with no build step.

**Scenarios.** Create a scenario from a template or import a JSON config (a
bare config, a scenario export or an experiment export). The editor tabs:

- **Task:** name, description, task text, shared context.
- **Agents:** id, name, role, provider/model/temperature/seed/max tokens,
  structured-output mode, system prompt, private context.
- **Protocol:** scheduler, start agent, router classifier, consensus rule,
  proposer, attempts, agent visibility, transport.
- **Limits:** soft discussion limits, hard limits, runtime retries and timeouts.
- **Evaluator:** evaluator and its parameters; the proposal schema for reference.
- **Raw JSON:** the complete config, editable.

Actions: **Save** (the version goes up only when something changed),
**Validate**, **Run**, **Duplicate**, **Export**, **Delete**.

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
npm run experiment -- [space-station | path/to/config.json] [--db <dataDir>]
npm run batch -- path/to/batch-spec.json [--db <dataDir>] [--out results.json] [--csv runs.csv]
```

Both use the same engine and database as the UI, so CLI runs appear in the UI
as well. `Ctrl+C` stops the experiment, or cancels the batch. The summary JSON
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
    "systemPrompt": "…",
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

- **the config snapshot** (fully resolved) and its canonical sha256 hash, plus
  the scenario id and version it came from;
- **the testbed version:** package version, git commit and a dirty-working-tree
  flag (a dirty run cannot be reproduced from the commit alone), Node version;
- **the run environment:** origin (`interactive` / `batch` / `cli`), stub
  latency, the effective SQLite durability mode, the provider request limit;
- **the evaluator id and version.**

Event types, in the order they typically appear:

| Event | Contents |
|---|---|
| `experiment_started` | config, hash, versions, environment, agents with models |
| `phase_changed` | from, to, why (e.g. `discussionEnd: all_ready`) |
| `routing_decision` | chosen agent, source, reason, details (invalid target, classifier failure) |
| `turn_started` / `turn_completed` | turn number, kind, result |
| `llm_call` | **every** provider attempt, including retries, failed and aborted ones: full rendered prompt, raw response, requested **and served** model, requested and effective OpenRouter routing plus the backend that served the call, usage, cost and its source (reported / estimated / unknown), duration, request-queue wait, parse result, temperature, seed |
| `message_posted` | a public room message (agent or moderator) |
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
  scheduling/   Scheduler interface · round-robin · hybrid (explicit → classifier → fallback)
  consensus/    ConsensusRule interface · unanimity · majority
  transport/    Transport interface · LocalTransport · ChumsTransport (extension point)
  evaluation/   ScenarioEvaluator interface · registry
  scenarios/    scenario packages (config + evaluator + stub scripts) · registries
  batch/        spec & condition expansion · BatchService · aggregates
  llm/          provider interface · OpenRouter · Azure OpenAI · stub · registry · concurrency gate · pricing
  persistence/  SQLite (node:sqlite) · scenarios · experiments · events · batches
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

---

## Extending the testbed

**A new scenario.** Add a folder next to [src/scenarios/spaceStation/](src/scenarios/spaceStation/):

1. `evaluator.ts` — a `ScenarioEvaluator` with a `proposalSchema` (zod; *structure
   only*, so that unsafe plans remain expressible), a `paramsSchema` and a
   deterministic `evaluate()` that returns per-check results.
2. `config.ts` — the default experiment config (pure data).
3. Optionally, stub scripts for keyless runs and tests.
4. Register the three in [src/scenarios/index.ts](src/scenarios/index.ts).

Nothing in `experiment/`, `scheduling/` or `transport/` changes.

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

**A new LLM provider:** implement `LlmProvider.complete()` in [src/llm/](src/llm/)
and register it in `createProviderRegistryFromEnv`.

---

## HTTP API

The UI uses exactly this API, and so can scripts. JSON in, JSON out; `POST` and
`PUT` require `Content-Type: application/json`.

| Method & path | Purpose |
|---|---|
| `GET /api/meta` | versions, providers (with request-gate state), stub models, evaluators (with proposal schemas), schedulers, consensus rules, outcomes, builtin scenarios |
| `GET/POST /api/scenarios` | list / create (`{config}` or `{builtin}`) |
| `POST /api/scenarios/validate` | schema and runnability check, without saving |
| `GET/PUT/DELETE /api/scenarios/:id` | read / update (version bump on change) / delete |
| `POST /api/scenarios/:id/duplicate`, `…/run` | copy / start a run |
| `GET /api/experiments?scenarioId=&batchId=&batches=exclude` | list |
| `POST /api/experiments` | start an ad-hoc run from `{config}` |
| `GET /api/experiments/:id` | record + live state |
| `GET /api/experiments/:id/events?after=N` | incremental event stream (the UI polls it) |
| `POST /api/experiments/:id/control` | `{type: pause \| resume \| step \| select_next (agentId) \| force_decision \| stop}` |
| `POST /api/experiments/:id/rerun` | same config snapshot, new run |
| `GET /api/experiments/:id/export` | record + every event |
| `DELETE /api/experiments/:id` | delete a finished run |
| `POST /api/batches/preview` | expand and validate a spec without running |
| `GET/POST /api/batches` | list / start (`{spec}`) |
| `GET /api/batches/:id` | progress + aggregates |
| `POST /api/batches/:id/cancel` | stop in-flight runs, start no more |
| `GET /api/batches/:id/export?format=csv` | per-run CSV (default: JSON) |

Status codes: 400 for an invalid or non-runnable config or spec (with a
`problems` list), 404 for an unknown id, 409 for an action that is invalid in
the current state.

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
- **No authentication.** The server binds to loopback by default.
- **Tools** are reserved in the agent config but not implemented.
- **Live view** polls every second rather than streaming.
- **Cost** comes from OpenRouter's reported per-call cost when available,
  otherwise from a small built-in pricing table; for other models it is unknown
  and counted as such.

## License

Apache-2.0 — see [LICENSE](LICENSE).
