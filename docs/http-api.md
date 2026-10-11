# Operator HTTP API

The web UI uses exactly this API, and so can scripts. JSON in, JSON out; `POST`
and `PUT` require `Content-Type: application/json`. It is served by
`npm run gui` (default `http://127.0.0.1:3939`) and answers only to loopback
host names and `GUI_ALLOWED_HOSTS` (other `Host` headers get `421`). With
`OPERATOR_TOKEN` set, every request needs it (HTTP Basic password, any user
name, or `Authorization: Bearer <token>`; otherwise `401`); without it there
is no authentication. `GET /healthz` answers `200 {"ok":true}` for any host
and without a token, for platform health checks. The separate API for
external chat rooms is the [External Room API](external-room-api.md).

| Method & path | Purpose |
|---|---|
| `GET /api/meta` | versions (incl. the current `protocolFingerprint`), providers (with request-gate state), stub models, evaluators (with proposal schemas), schedulers, consensus rules, outcomes, builtin scenarios |
| `GET /api/providers/openrouter/models` | OpenRouter's model catalog for the editor: id, name, context, price per M tokens, structured-output support (cached 6 h; 502 if unreachable) |
| `GET/POST /api/scenarios` | library (built-ins first, read-only) / create a user scenario (`{config}` or `{builtin}`) |
| `POST /api/scenarios/validate` | schema and runnability check, without saving |
| `GET/PUT/DELETE /api/scenarios/:id` | read / update (version bump on change) / delete |
| `POST /api/scenarios/:id/duplicate` | copy (the way to edit a built-in) |
| `POST /api/scenarios/:id/run` | start a run; optional `{overrides: {language?, models?: {agents?, orchestration?}}}` applies to this run only (see [configuration](configuration.md#experiment-config)) |
| `GET /api/experiments?scenarioId=&batchId=&taskDefinitionHash=&batches=exclude` | list |
| `POST /api/experiments` | start an ad-hoc run from `{config, overrides?}` |
| `GET /api/experiments/:id` | record, live state, and `externalRoom` (the open external room binding, or null) |
| `GET /api/experiments/:id/events?after=N` | incremental event stream (the UI polls it) |
| `POST /api/experiments/:id/control` | `{type: pause \| resume \| step \| select_next (agentId) \| force_decision \| stop}` |
| `POST /api/experiments/:id/rerun` | same config snapshot, new run |
| `GET /api/experiments/:id/export` | record + every event |
| `DELETE /api/experiments/:id` | delete a finished run (and its debrief data) |
| `GET /api/experiments/:id/interaction?after=N` | the room's human side: profile, mode (active / debrief / closed / observe), open session with queue state, all sessions, derived counts, interaction events |
| `POST /api/experiments/:id/room/messages` | a person's text message `{senderId, displayName, text, replyTo?, mentions?}`; chat only, never a command. `409 EXTERNAL_ROOM_ACTIVE` while the experiment is bound to an open external room |
| `POST /api/experiments/:id/debrief` | operator: `{action: open}` (always a new session) or `{action: close}` |
| `POST /api/batches/preview` | expand and validate a spec without running |
| `GET/POST /api/batches` | list / start (`{spec}`) |
| `GET /api/batches/:id` | progress + aggregates |
| `POST /api/batches/:id/cancel` | stop in-flight runs, start no more; closes a batch whose owning process is gone as `interrupted` |
| `GET /api/batches/:id/export?format=csv` | per-run CSV (default: JSON) |

Status codes: 400 for an invalid or non-runnable config or spec (with a
`problems` list), 404 for an unknown id, 409 for an action that is invalid in
the current state (including editing or deleting a built-in scenario). Some
409s carry a machine-readable `code`.
