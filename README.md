# Agent Testbed

A small, configurable testbed for **multi-agent LLM coordination experiments**.

Several independent LLM agents each get only part of the information needed to
solve a task. They talk in a shared room, decide who speaks next, agree on one
formal proposal and vote on it. A deterministic evaluator then checks whether
the committed proposal actually solves the task:

```
distributed information → communication → collective decision → objectively verifiable outcome
```

The same engine serves interactive runs, manual experimentation and debugging,
and reproducible batch experiments. Every run leaves a complete, persistent,
machine-readable event trace.

The repository is an evolution of [RoleCase](https://github.com/torselllo88/rolecase).
The unmodified starting point is tagged `rolecase-baseline`; `git diff rolecase-baseline`
shows the whole transformation.

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
- **One engine.** Interactive, CLI and batch runs all go through
  `ExperimentRunner`. There is no separate research implementation.
- **Append-only trace.** Every run writes its events to SQLite as they happen,
  and every reported metric is derived from those events.
- **A bare experimental core.** Narration, viewer pacing, people in the room
  and external chat rooms are add-ons around the runner. They never change
  what agents read, the outcome or the metrics.

The full experiment model — turns, routing, readiness, proposal, voting,
outcomes and limits — is in [docs/concepts.md](docs/concepts.md).

---

## Quick start

Requires **Node.js ≥ 22.13** (the built-in `node:sqlite` is used, unflagged since 22.13; no database server).

```bash
npm install
npm run gui          # → http://localhost:3939
```

Without any API key, every agent runs on the built-in **stub provider**:
scripted, deterministic stand-ins. All built-in scenarios then run end to end,
free and offline (stub agents always speak English).

To run real LLM agents:

1. `cp .env.example .env` and set `OPENROUTER_API_KEY` (or the Azure OpenAI variables).
2. Restart `npm run gui`. The Overview page shows which providers are configured.
3. Press **Run** on any scenario, built-ins included. In the run dialog, pick
   a conversation language and, under **Models → Choose for this run**, a
   provider and model for all agents (e.g. `openrouter` ·
   `anthropic/claude-haiku-4.5`) and a cheap one for the routers. This applies
   to that run only; the run records the models it used.
4. To keep models in a scenario: **Duplicate** a built-in, and in the copy's
   **Agents** tab use the **Models** panel (all agents, and all routers, in one
   step); adjust single agents afterwards if you want a mixed crew. **Save**.

Real LLM calls cost money. Every run reports its token usage and cost; runs and
batches can be capped (`limits.totalCostCapUsd`, `limits.totalTokenCap`).

---

## Built-in scenarios

| Scenario | What it tests | Evaluator | Languages |
|---|---|---|---|
| [Space Station Benchmark](docs/scenarios/space-station.md) | Four functional roles must pool their facts to route enough power to a backup coolant loop. Neutral: no names, narration or pacing. The research baseline. | `space-station` | any (agents); stubs: en |
| [Station Kestrel](docs/scenarios/kestrel.md) | The same task and evaluator (the same `taskDefinitionHash`) with named officers, personas, a narrator, viewer pacing and a post-run debrief. | `space-station` | en, ru authored |
| [Station Kestrel: Cascade](docs/scenarios/kestrel-cascade.md) | A harder task with the Kestrel crew: two plausible recovery paths, an ordered action list and facts split so that no officer can find the safe plan alone. | `kestrel-cascade` | en, ru authored |

A scenario separates the task (facts, roles, private information, decision
rules, evaluator) from behavior and presentation (names, personas, language,
narration, pacing). How that works, and how to author one:
[docs/scenarios/README.md](docs/scenarios/README.md).

---

## Running experiments

**Web UI** — `npm run gui`: an About & demo page (`#/demo`: a one-screen introduction and a one-click demo run), scenario library and editor, a live control view
with operator controls, a clean viewer mode for audiences, batches, exports.
See [docs/web-ui.md](docs/web-ui.md).

**Command line:**

```bash
npm run experiment -- [space-station | station-kestrel | path/to/config.json] [--db <dataDir>] [--language ru]
npm run batch -- path/to/batch-spec.json [--db <dataDir>] [--out results.json] [--csv runs.csv]
```

Both use the same engine and database as the UI, so CLI runs appear there too.
CLI runs are headless (viewer pacing and reveal pauses are skipped unless you
pass `--watch`). `Ctrl+C` stops the experiment, or cancels the batch. The
summary JSON goes to stdout and progress to stderr; add `-s`
(`npm run -s experiment …`) so npm's own banner does not mix into the JSON.
For automation, invoke Node directly (`node --import tsx src/cli/batch.ts spec.json`):
a supervisor that kills the process then actually stops it.

**Batches** run one base configuration under every combination of variable
values, N times each, and aggregate per condition (success rate with a Wilson
interval, tokens, cost, duration). See [docs/batches.md](docs/batches.md);
a runnable example is [examples/space-station-batch.json](examples/space-station-batch.json).

**People in the room.** A run can have human spectators; after the outcome,
people can question the characters in a separate debrief. Humans never take
part in an active experiment. See [docs/people-in-the-room.md](docs/people-in-the-room.md).

**External chat rooms** get a projection of a run through the
[External Room API](docs/external-room-api.md), a vendor- and scenario-agnostic
contract for a room adapter. `npm run room:mock` is a runnable reference adapter.

---

## Architecture

```
Experiment config ──► ExperimentRunner ──► Scheduler ──► who speaks
                         │   │                             (public room only)
                         │   ├──► LlmCaller ──► ProviderRegistry ──► OpenRouter / Azure / stub
                         │   │                     (process-wide request gate)
                         │   ├──► Transport (room) ◄── agents' visible messages
                         │   ├──► ConsensusRule ──► committed?
                         │   └──► ScenarioEvaluator ──► SUCCESS / MISSION_FAILURE
                         └──► EventLog ──► SQLite (append-only) ──► metrics · UI · exports

Add-ons, outside the core:  presentation (narration, pacing) · interaction (spectators, debrief) · rooms (External Room API)
```

Agents are data, not classes: one generic runtime renders each agent's prompt
from the config and parses its JSON response. Every decision point is an
interface (`Scheduler`, `ConsensusRule`, `Transport`, `ScenarioEvaluator`,
`LlmProvider`), and add-ons attach through one `RunExtension` interface whose
isolation is enforced at runtime and by tests. See
[docs/architecture.md](docs/architecture.md) and
[docs/extending.md](docs/extending.md).

---

## Documentation

| Topic | |
|---|---|
| Experiment model: lifecycle, turns, routing, readiness, voting, outcomes, limits | [docs/concepts.md](docs/concepts.md) |
| Experiment config reference and `.env` variables | [docs/configuration.md](docs/configuration.md) |
| Scenarios: task vs. presentation, narration, pacing, authoring | [docs/scenarios/README.md](docs/scenarios/README.md) |
| Trace, metrics, hashes, reproducibility, durability and recovery | [docs/reproducibility.md](docs/reproducibility.md) |
| Batch experiments | [docs/batches.md](docs/batches.md) |
| People in the room: spectators and debrief | [docs/people-in-the-room.md](docs/people-in-the-room.md) |
| Web UI | [docs/web-ui.md](docs/web-ui.md) |
| Architecture | [docs/architecture.md](docs/architecture.md) |
| Extending: scenarios, schedulers, decision rules, providers | [docs/extending.md](docs/extending.md) |
| Operator HTTP API | [docs/http-api.md](docs/http-api.md) |
| External Room API (contract for room adapters) | [docs/external-room-api.md](docs/external-room-api.md) |

---

## Development

```bash
npm test           # vitest — hermetic: never reads your .env, never calls a real provider
npm run build      # tsc type-check + compile to dist/
npm run test:e2e   # browser end-to-end checks in a headless Chrome (keyless; see tests/e2e/README.md)
```

CI (`.github/workflows/ci.yml`) runs the build, the tests and the browser checks.

## Known limitations

- **Single process, in-memory scheduling.** Running experiments live in the
  server process; a restart ends them (recorded as `INTERRUPTED`). There is no
  distributed runtime; see [recovery](docs/reproducibility.md#durability-and-recovery).
- **Authentication is one shared operator token** (`OPERATOR_TOKEN`); without
  it there is none, which is why the server binds to loopback by default. There
  are no user accounts: in the viewer, a person is whatever display name they
  type. Deploying on a platform: see
  [configuration](docs/configuration.md#deploying-on-a-platform-railway-and-similar).
- **The request gate is a semaphore**, not RPM/TPM rate limiting. Provider
  retries with backoff are the fallback; runs that still fail end as
  `PROVIDER_ERROR` (reported separately in batches).
- **Human interaction:** only `OBSERVE` and `DEBRIEF` exist; one question gets
  one character's answer.
- **External rooms (v1)** assume the room already exists and the identities are
  in it. Delivery is by long-polling; there are no typing indicators, and the
  bearer token is not encryption.
- **Tools** are reserved in the agent config but not implemented.
- **Live view and viewer mode** poll every second rather than streaming.
- **Stub agents speak English only**; the conversation language only takes
  effect with real models. Authored narration and moderator notices exist in
  `en` and `ru`; other languages fall back to English for those texts.
- **Cost** comes from OpenRouter's reported per-call cost when available,
  otherwise from a small built-in pricing table; for other models it is unknown
  and counted as such.

## License

Apache-2.0 — see [LICENSE](LICENSE).
