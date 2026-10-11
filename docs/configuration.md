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

**Per-run overrides.** A run may override the conversation language without
editing or versioning the saved scenario (`{ "overrides": { "language": "ru" } }`
in the API, the run dialog in the UI, `--language` in the CLI). The run's
snapshot and `configHash` are those of the overridden config.

## Environment (`.env`)

See [.env.example](../.env.example). All variables are optional.

| Variable | Default | Meaning |
|---|---|---|
| `OPENROUTER_API_KEY` | — | Enables the OpenRouter provider (the main path: many vendors, one key) |
| `OPENROUTER_SITE_URL`, `OPENROUTER_SITE_NAME` | — | Optional attribution headers |
| `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_VERSION` | — | Enables Azure OpenAI (an agent's `model` is then the deployment name) |
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
