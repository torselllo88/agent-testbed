# Configuration

Two kinds of configuration: the **experiment config** (one JSON document per
scenario or run, stored and hashed with every run) and the **process
environment** (`.env`: credentials, ports, limits of this installation).

## Experiment config

A config is one serializable JSON document, validated by the zod schema in
[src/experiment/config.ts](../src/experiment/config.ts). It is stored fully
resolved, with all defaults filled in, and hashed canonically. The complete
reference is [src/scenarios/spaceStation/config.ts](../src/scenarios/spaceStation/config.ts).

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
               // self-hosted endpoints only: "think": false, "contextLength": 8192 (see below)
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
  "decision": { "proposerId": "operations", "maxProposalAttempts": 2, "maxProposalFormatRetries": 1,
                "proposalRequired": false },             // true: the proposer may not decline
  "discussion": { "fixedRounds": 3 },                      // optional: fixed-length discussion (round_robin only)
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
  "presentation": { "narrator": null, "strings": {}, "pacing": { "minVisibleIntervalMs": 0 } },
  "humanInteraction": { "profile": "OBSERVE" },            // optional; see people-in-the-room.md
  "runtime": { "maxParseRetries": 1, "maxProviderRetries": 2, "providerRetryDelayMs": 2000, "callTimeoutSeconds": 120 },
  "evaluator": { "id": "space-station", "params": { "baseReserveKw": 10, "…": "…" } },
  "transport": { "type": "local" }
}
```

`presentation` is described in [scenarios/README.md](scenarios/README.md#building-blocks),
`humanInteraction` in [people-in-the-room.md](people-in-the-room.md).

Notes:

- **Credentials never appear in configs.** A model names a provider id; the key
  lives only in `.env`.
- **The agent id `system` is reserved** for the room's system voice (moderator
  and narrator) in external rooms.
- **`evaluator.params`** are checked against the evaluator's own strict schema:
  an unknown key (a typo such as `loopBRequiredKW`) is an error, never silently
  replaced by a default. A run snapshots and hashes the params *as the
  evaluator reads them*, defaults applied.
- **`agentVisibility.discussionBudget` is off by default** because it changes
  behavior: an agent that sees "21 of 24 turns used" hurries and agrees sooner.
  Turn it on for demos, keep it off for baseline research runs. The runtime and
  the UI always know these numbers.
- **`discussion.fixedRounds`** makes every discussion segment last exactly
  that many rounds of every agent (rounds × agents turns, round-robin order).
  Readiness is still asked and recorded (`discussionTurnsToAllReady`), but
  neither ends the discussion nor adds re-check turns — so conditions that
  converge at different speeds still talk equally long. Needs the
  `round_robin` scheduler; agents are told the discussion has a fixed number
  of rounds (not how many). Omitted: the default — discussion ends when every
  agent's readiness is current, or at the turn limit.
- **`decision.proposalRequired: true`** takes declining away from the
  proposer: the prompt and the response schema offer no `null`, and a null
  proposal is answered like a format error (`proposal_rejected_format`, kind
  `declined_not_allowed`) with another try while `maxProposalFormatRetries`
  allow. `false` is the default and hashes like an omitted field.
- **Every frozen proposal is judged** by the evaluator once the outcome is
  decided — committed or not (`proposal_evaluated`; `metrics.proposals.first`
  is first-proposal correctness). Only the committed proposal decides the
  outcome. Both protocol options above change agent-facing texts, so they have
  their own [protocol fingerprint](reproducibility.md#hashes).
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

**Per-run overrides.** A run may override, without editing or versioning the
saved scenario:

- the conversation language — `{ "language": "ru" }` (the run dialog,
  `--language` in the CLI);
- the models — `{ "models": { "agents": {…}, "orchestration": {…} } }`, each
  `{ provider, endpoint?, model, structuredOutput?, think?, contextLength? }`
  (the run dialog). `agents` sets every agent; `orchestration` sets the
  router classifier and the debrief router the scenario has (none is switched
  on). Only provider, model, (when given) the output mode and a self-hosted
  endpoint's serving options change: temperature, seed and output caps belong
  to the scenario; OpenRouter `routing` is dropped, and so are `think` and
  `contextLength` when the new provider is not a self-hosted endpoint.

The run's snapshot and `configHash` are those of the overridden config; the
run environment records `languageOverridden` and `modelsOverridden`. The
External Room API does not offer model overrides: the operator chooses models
in the saved scenario.

## Self-hosted models (OpenAI-compatible endpoints)

Any server speaking the OpenAI chat-completions API — vLLM, TGI, LM Studio,
llama.cpp server, an internal gateway — can serve agents. The experiment
config names only a logical **endpoint**; where it is and how to reach it is
set in the environment of the machine the run executes on, so one scenario
runs unchanged on a laptop or a cluster node.

```jsonc
"model": { "provider": "openai-compatible", "endpoint": "lab-vllm", "model": "Qwen/Qwen2.5-72B-Instruct", "structuredOutput": "native" }
```

```bash
OPENAI_COMPATIBLE_ENDPOINTS=lab-vllm,lab-tgi
OPENAI_COMPATIBLE_LAB_VLLM_BASE_URL=http://gpu-node-3:8000/v1
OPENAI_COMPATIBLE_LAB_VLLM_API_KEY=…            # optional
OPENAI_COMPATIBLE_LAB_VLLM_MAX_CONCURRENT=16    # optional: size it to the server
```

The name is upper-cased with `-` → `_` in the variable names. Each endpoint
is its own provider (`openai-compatible:<name>` in the trace and on the
Overview page) with its own request limit. In the editor it appears in every
provider list, and the model field offers the models the server lists
(`GET /v1/models`).

- **Structured output:** `native` sends `response_format: json_schema`
  (supported by recent vLLM and TGI). For a server without it, use
  `"structuredOutput": "prompt"` — the schema is then described in the prompt,
  and every response is parsed and validated either way.
- **Cost** is not reported by such servers and is recorded as unknown; token
  usage is recorded as the server reports it.
- **Keys** live only in the environment and are scrubbed from every trace.
- A run naming an endpoint that is not configured where it runs is refused
  before it starts, saying which variable to set.
- **`think`** (`true` / `false`; omitted = the server's default) switches a
  model's thinking mode, e.g. Qwen3's. On an OpenAI-API server it is sent as
  `chat_template_kwargs.enable_thinking` (the vLLM / SGLang convention; other
  servers ignore it — check the raw responses in the trace).

### Ollama

Ollama is served through **its own API** (`/api/chat`), not its
OpenAI-compatible one: only the native API takes thinking control, the
context window and the seed per request reliably, and a run should record
these instead of depending on how the server happens to be configured.

```bash
OPENAI_COMPATIBLE_ENDPOINTS=lab-ollama
OPENAI_COMPATIBLE_LAB_OLLAMA_BASE_URL=http://localhost:11434   # a trailing /v1 is ignored
OPENAI_COMPATIBLE_LAB_OLLAMA_API=ollama
OPENAI_COMPATIBLE_LAB_OLLAMA_MAX_CONCURRENT=1                  # = the server's OLLAMA_NUM_PARALLEL
```

```jsonc
"model": { "provider": "openai-compatible", "endpoint": "lab-ollama", "model": "qwen3:14b",
           "structuredOutput": "native", "temperature": 0, "seed": 1, "maxOutputTokens": 400,
           "think": false, "contextLength": 8192 }
```

- **`contextLength`** (`num_ctx`) — set it. Ollama's default window can be
  shorter than a long discussion, and **Ollama truncates an over-long prompt
  silently, from the start** — the system prompt and the agent's private facts
  go first. Each call records the window it was sent with; a call whose prompt
  probably did not fit is flagged (`providerMeta.contextOverflowSuspected`,
  counted in `metrics.llmCalls.contextOverflowSuspected` and the batch CSV —
  a heuristic: the prompt is longer than the window even at 4 characters per
  token, or the reported prompt all but fills it). A larger window needs more
  GPU memory: check it fits next to the model before a long batch.
- `structuredOutput: "native"` sends the schema as Ollama's `format`.
- **Thinking** the model did anyway is kept apart from the answer
  (`providerMeta.thinking`) and counted (`metrics.llmCalls.withThinking`);
  with `think: false` it should be 0.
- Ollama's timings are recorded per call (`providerMeta.durationsMs`: total,
  model load, prompt evaluation, generation) — a cold model load shows there.
- `contextLength` on an endpoint that speaks the OpenAI API is refused before
  the run starts (that server's window is fixed when the model is served).

Running the testbed itself next to such a server on a shared machine without
root: [remote server](remote-server.md).

## Environment (`.env`)

See [.env.example](../.env.example). All variables are optional.

| Variable | Default | Meaning |
|---|---|---|
| `OPENROUTER_API_KEY` | — | Enables the OpenRouter provider (the main path: many vendors, one key) |
| `OPENROUTER_SITE_URL`, `OPENROUTER_SITE_NAME` | — | Optional attribution headers |
| `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_VERSION` | — | Enables Azure OpenAI (an agent's `model` is then the deployment name) |
| `OPENAI_COMPATIBLE_ENDPOINTS` | — | Comma-separated names of self-hosted OpenAI-compatible model servers (see [below](#self-hosted-models-openai-compatible-endpoints)) |
| `OPENAI_COMPATIBLE_<NAME>_BASE_URL`, `_API_KEY`, `_MAX_CONCURRENT`, `_API` | — | Per endpoint: server URL (required), key (optional), request limit (default `LLM_MAX_CONCURRENT_REQUESTS`), API: `openai` (default) or `ollama` (see [Ollama](#ollama)) |
| `LLM_MAX_CONCURRENT_REQUESTS` | `8` | Simultaneous in-flight requests per real provider, process-wide |
| `LLM_MAX_CONCURRENT_DEBRIEF_REQUESTS` | `2` | The debrief's own slots per real provider, separate from the experiments' slots. People asking questions never delay a running experiment; this adds to the provider's total concurrency |
| `SQLITE_SYNCHRONOUS` | `NORMAL` | Trace durability: `NORMAL`, `FULL`, `EXTRA`, `OFF` |
| `STUB_LATENCY_MS` | `300` | Stub latency in the web UI only, so stub runs can be watched live |
| `DATA_DIR` | `./data` | Where the SQLite database lives |
| `GUI_PORT` / `PORT` | `3939` | Web UI port |
| `GUI_HOST` | `127.0.0.1` | Bind address. Without `OPERATOR_TOKEN` **there is no authentication**; only use `0.0.0.0` deliberately |
| `OPERATOR_TOKEN` | — | When set, the UI and the operator API require it: HTTP Basic auth with any user name and the token as the password, or `Authorization: Bearer <token>`. Required on any public host |
| `GUI_ALLOWED_HOSTS` | — | Host names the operator UI answers to besides loopback. Requests for any other `Host` get `421`, a DNS-rebinding guard. Needed only when you reach the UI under another name |
| `EXTERNAL_API_TOKEN` | — | Enables the [External Room API](external-room-api.md) on its own listener (bearer token) |
| `EXTERNAL_API_PORT` / `EXTERNAL_API_HOST` | `3940` / `127.0.0.1` | External Room API listener. For remote adapters, put TLS or a private network in front of it |
| `EXTERNAL_API_LISTENER` | `separate` | `main` serves `/api/external/*` on the UI's listener instead (one public port per service); the API's own bearer token applies either way |
| `EXTERNAL_SCENARIOS` | — | Comma-separated built-in or library scenario ids that may be started externally (default-deny) |

## Deploying on a platform (Railway and similar)

The port comes from `PORT` (the platform injects it), the bind address and
served host names from the environment. On **Railway** (detected by its own
`RAILWAY_*` variables) the server binds to `0.0.0.0` by default and serves the
generated `RAILWAY_PUBLIC_DOMAIN` without further setup — but only with
`OPERATOR_TOKEN` set: without it, it refuses to start and says why in the
deploy log. Elsewhere, the default stays loopback.

| Setting | Value | Why |
|---|---|---|
| `OPERATOR_TOKEN` | a long random value | without it, anyone with the URL can run experiments on your provider keys, read every trace and delete data (on Railway, the server does not start without it) |
| `GUI_HOST` (or `HOST`) | `0.0.0.0` — automatic on Railway | the default `127.0.0.1` is unreachable for the platform's proxy |
| `GUI_ALLOWED_HOSTS` | any custom domain — Railway's generated domain is automatic | other `Host` headers get `421` (DNS-rebinding guard) |
| `PORT` | leave it to the platform | if you set it yourself, the domain's target port (Railway: Settings → Networking) must be the same |
| a volume, `DATA_DIR` | e.g. mount at `/data`, `DATA_DIR=/data` | the container's filesystem is wiped on every deploy; the SQLite database holds scenarios and all traces |
| start command | `node --import tsx src/server/main.ts` | not `npm start` (it reinstalls on every start); the UI is served from `src/gui/public`, so `node dist/…` does not serve it |
| Node | ≥ 22.13 (`.node-version`: 24) | `node:sqlite` needs a flag before 22.13 |
| replicas | 1 | SQLite and the in-memory scheduler are single-process |
| health check path | `/healthz` | answers `200 {"ok":true}` for any `Host` and without the operator token |
| `OPENROUTER_API_KEY` | your key | as locally |

The deploy log shows what was resolved: `Agent testbed listening on 0.0.0.0:<port> (railway)`,
`Public URL: …` and `Operator authentication: on`. `listening on 127.0.0.1`
there means the platform was not detected and no `GUI_HOST` / `HOST` is set.

For the [External Room API](external-room-api.md): set `EXTERNAL_API_TOKEN`,
`EXTERNAL_SCENARIOS` and either `EXTERNAL_API_LISTENER=main` (served on the
public URL under `/api/external/*`) or, for an adapter inside the same
private network, `EXTERNAL_API_HOST=0.0.0.0` on its own port.

A redeploy ends running experiments; they are recovered as `INTERRUPTED` by
the new process ([recovery](reproducibility.md#durability-and-recovery)).

For a shared research machine (a GPU node without root, reached over SSH),
see [remote server](remote-server.md).
