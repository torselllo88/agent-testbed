# Pilot Settlement

The pilot's task — *Distributed Settlement Decision*, Task Definition v1.4 —
run under the pilot's own protocol (Pilot Experimental Plan, internal
v0.3.1). Built-in scenario `pilot-settlement`, evaluator `pilot-settlement`
(version 1.4), protocol adapter `pilot-settlement` (version 0.3.1). The frozen
inputs are the bundle in `experiments/pilot-settlement/bundle/` (prompts,
schemas, the 50 instances, the reference tools); every decision taken on top
of the plan is in `experiments/pilot-settlement/CHANGELOG.md`.

This scenario differs from every other built-in in one respect: the testbed's
own agent protocol (JSON turns, readiness, the proposal envelope, notices) is
not used. A **protocol adapter** renders every model input exactly as the
bundle's `tools/render_prompts.py` does and reads every answer by the plan's
rules; the runner keeps the lifecycle (round-robin turns, fixed rounds, the
audience of every message, the final call, the evaluator). See
[configuration — protocol adapter](../configuration.md#protocol-adapter).

## The task

Six agents — Operations, Contract, Compliance, Settlement, Verification,
Treasury (agent ids in lower case) — decide whether to execute, hold or reject
a settlement of 12 000 for milestone M-204 to the requested destination (D1
or D2). The public rules (five, applied in order) are in every system
prompt; the private facts are split by role: Contract permits, Compliance
authorizes, Settlement supports routes (destination / rail), Verification
accepted or pending, Treasury approved or pending. Operations holds nothing
and alone returns the final proposal `{action, destination, rail, reason}`.

The evaluator (`src/scenarios/pilotSettlement/task.ts`, a port of the
bundle's `settlement_task.py`) judges exact correctness: all four fields equal
the canonical outcome (classification `correct` / `incorrect`); per-field
correctness is in the checks (`action_correct`, …). The proposal schema
carries the field rules of the task definition (execute: destination and rail
set, reason null; hold / reject: destination and rail null, reason set), so a
violated rule is a schema failure. Instance classes (A, B, C, R-ELIG,
R-ROUTE with subtypes) and the E7 metadata (minimal fact and role sets) are
computed the same way as the reference and checked against it for all 50
instances in `tests/scenarios/pilotSettlement.test.ts`.

## The protocol (adapter `pilot-settlement`)

- Three fixed rounds (K = 3), eighteen discussion turns in the instance's
  speaking order, then one mandatory final call of Operations: nineteen calls,
  each `[system, user]` — no assistant turns are ever sent, an agent's own
  earlier messages appear in the user text as `You (Role)` lines.
- Histories: own accepted messages and the messages delivered to the agent,
  in turn order, as `[Round r] Speaker: text`; `(no messages yet)` when
  empty. Delivery is immediate (a message accepted at turn *t* is in every
  recipient's history from turn *t* + 1). Under the ring each agent's
  recipients are its two ring neighbours in the instance's `ring_positions`;
  under the complete graph, everyone else. The system prompt tells each agent
  whom it sends to and receives from, nothing more.
- Visible messages are capped at 200 tokens: an over-length answer is asked
  once more with the same seed and the reminder *"Your previous draft was too
  long. Write a shorter message of a few sentences."* appended to the user
  text; a second over-length answer is truncated at the last sentence boundary
  within the cap (`over_length_regenerated`, `over_length_truncated`).
- A model failure on a discussion turn — empty content, or an answer cut at
  `num_predict` (`done_reason: length`: unfinished content, a thinking
  overflow) — is a **silent turn**: nothing is delivered, nothing enters any
  history, the run goes on (`silent_turn_model_failure`). A final answer cut
  at `num_predict` before a complete JSON object is likewise a model failure
  (`final_model_failure`), not a schema failure.
- The final answer is parsed as the last top-level JSON object (one ``` fence
  stripped; text around it sets `extra_text`), without an Ollama `format`. A
  schema failure ends the run as `PROPOSAL_INVALID`, an empty final answer as
  `PROPOSAL_PARSE_FAILED` (`final_model_failure`) — both valid runs scored
  incorrect, no retry, no feedback.
- Seeds: every call has its own seed from `tools/seeds.py` —
  sha256(`master|instance|call_type|round|speaker|replicate`), first 31 bits,
  master seed 20261120; the paired Complete and Ring calls of an instance
  share seeds. Public-only calls are keyed on the public prompt instead.
- Generation settings of the plan (think on, temperature 1.0, top_p 0.95,
  top_k 20, min_p 0, presence 0, repeat 1.0, `num_predict` 2560, `num_ctx`
  8192, `keep_alive` 30m) are the scenario's: `temperature`,
  `maxOutputTokens`, `sampling` and `keepAlive` stay through a `$models`
  switch; `think: true` and `contextLength: 8192` are set in the model choice
  (see the batch specs in `experiments/pilot-settlement/`). The adapter
  **refuses** a real endpoint configured otherwise (a fixed `seed` included),
  so a run on a model is always under the plan's settings — change
  `PILOT_GENERATION` in `adapter.ts` when the plan changes.
- Preflight budget: the adapter counts every prompt (the two messages, each
  with the model's tokenizer, summed — `tokenCounter: "tokenizer"` on the
  call); a call whose count plus the output cap would not fit the window is
  not made, and the run ends as `CONTEXT_BUDGET_VIOLATION` (infrastructure,
  excluded from rates). The count leaves out the chat template's own tokens;
  the plan's `prompt_count_rule`, measured at gate G2 (`PROMPT_COUNT_RULE` in
  `adapter.ts`): Ollama 0.33.2 reports the count plus 15 template tokens,
  cached or not. After a call, the run-log export checks the reported
  `prompt_eval_count` against it; a shortfall of more than 1 % on any call
  makes the run `context_truncation` (the server shifts an over-long prompt
  silently and reports fewer tokens, as the G2 canary showed).
  Without the model record the adapter falls back to the planning estimate
  (4 characters per token, `"approximate"`) and **refuses a real endpoint**.

Thinking returned by the model is kept with the call (`providerMeta.thinking`)
and never re-sent; the run-log export moves it to a separate file.

## The model record and the tokenizer

`experiments/pilot-settlement/model/` holds the frozen `/api/show` record of
`qwen3.8:27b` from the pilot node (`show.json`, and `show-verbose.json` with the
vocabulary; see the README there for what it says). The tokenizer
(`src/scenarios/pilotSettlement/tokenizer.ts`) is rebuilt from the verbose
record: GPT-2 byte-level BPE over `tokenizer.ggml.tokens` / `merges`, the
`qwen35` pre-tokenizer regex of llama.cpp, control and user-defined tokens
(`<|im_start|>`, `<think>`, …) matched literally. It is checked token for
token against the server's own counts of 179 texts (every dev system prompt,
the control prompts, probe strings) in `tests/scenarios/pilotTokenizer.test.ts`
(fixture `tests/fixtures/pilot-tokenizer-counts.json`, measured with
`/api/generate` `raw: true` on Ollama 0.33.2). The adapter registered by
`createEvaluatorRegistry` uses it for the visible-message cap, the truncation
and the preflight count whenever the record file is present.

## Instances and batches

The 50 instances (DEV-01 … DEV-10, P-01 … P-40) come from the bundle's
instance files and are the task family of evaluator `pilot-settlement`: a
batch's `$instance` names them. Applying one sets the state (evaluator
params), the role cards, `scheduler.order` (the instance's speaking order)
and the adapter's `ringPositions`; when the condition's topology is a ring
without an explicit order, the instance's arrangement is used. Both
topologies of an instance are therefore paired: same state, same speaking
order, same seeds, same prompts except the communication block and what was
delivered. The adapter refuses a config whose rotation or ring differs from
the instance's.

Ready-made specs in `experiments/pilot-settlement/`:

| Spec | What it runs |
|---|---|
| `dev-probe.batch.json`, `pilot-probe.batch.json` | the delivery probe (gate G1): scripted agents, no model |
| `dev-discussion.batch.json` | the 10 dev instances × {complete, ring} on Ollama (gates G2, G5) |
| `dev-controls.batch.json` | oracle (`$solo` full) and public-only (`$solo` public) calls of Operations alone (gates G3, G4); set `protocol.replicate` for further replicates |

Under this adapter `$solo` asks the adapter for its control call: `full` is
the oracle (every role card in one prompt, `oracle_user.txt`), `public` the
public-only call (`public_only_user.txt`), both with
`system_operations_solo.txt`.

## The delivery probe (gate G1)

The scripted agent `pilot-settlement/probe` answers every discussion turn
with `PROBE` followed by the sorted tokens `<Role>-TOKEN` it holds — its own
if it is a data role, plus every token in its user text — and a fixed
proposal on the final call. The bundle's `validate_run_log.py
--simulate-probe` computes the exact expected texts; the unit test runs all
50 instances × both topologies through the batch service and compares every
user text and every accepted message (byte for byte for DEV-01 and P-01,
digests for the rest), the seeds, recipients and visible histories of the
exported run logs.

## Run logs

`npm run pilot -- export (--batch <id> | --experiment <id>) --out <dir>`
writes one `<run_id>.json` per finished run in the form of the bundle's
`schemas/run_log.schema.json` (calls with attempts, seeds, token counts,
`done_reason`, durations; the final block; validity and flags), built from
the trace alone. Thinking texts go to `<run_id>.thinking.json`; the log holds
their sha256 and length. `npm run pilot -- validate <logs…>` runs the bundle's
own `tools/validate_run_log.py` on each log (with `uv run --no-project --with
jsonschema python` by default — a current Python and the schema package from a
per-user `uv`; `--python <command>` for another interpreter of version ≥ 3.7)
— the independent check a run must pass to count as structurally valid.

`npm run pilot -- pairs --instances dev|<ids> --endpoint <name> --base-url <url>
--model <name> --out <dir> [--replicate <n>] [--first alternating|complete|ring]`
is the **pair runner** (plan §3.2, `src/scenarios/pilotSettlement/pairRunner.ts`):
per instance a preload (`/api/chat` with `messages: []`, `num_ctx` 8192,
`keep_alive` 30m, must answer `done_reason: "load"`), a snapshot, the first
run, a snapshot, the second run, a snapshot. A snapshot holds nvidia-smi,
`/api/ps` and `/api/version` and is normal when the model is fully in GPU
memory with context length 8192 and version and digest equal the freeze
record `experiments/pilot-settlement/model/record.json`. A failed preload, an
abnormal snapshot or a mid-run reload (`load_duration` > 1 s) is an
environment deviation: the pair's logs go under `deviations/`, the runner
waits for a normal snapshot and re-executes both runs with the same seeds, at
most twice. A version or digest change stops the run (`PilotStopped`, exit 3).
Each pair's run logs are written as soon as it finishes, with the snapshots,
the preload and the execution `attempt` in them; `pairs/<instance>.json`
records the pair. The runs themselves go through the `ExperimentService`
like any other run. `--kind controls` makes the pair the oracle and the
public-only call of Operations alone (`$solo` full / public, run ids
`-ORACLE` / `-PUBLIC_ONLY`, `-rep<n>` for `--replicate n`), with the same
preload, snapshots and deviation rule — the controls of gates G3 and G4
with environment data.

`npm run pilot -- determinism --logs <dev logs> --base-url <url> --model <name>
--out <file> [--instance <id>]` is gate G6 (`determinism.ts`): the 3
discussion and 2 final calls with the largest prompts in the dev logs (their
system and user texts and seeds as sent) and the public-only call of an
instance, each 3× cold (after a cache-busting prompt) and 3× warm with the
same seed, under snapshots before and after. Identical content in every
repeat, within each cache state, and normal snapshots pass; the cache state
is classified by call order because the server does not report
`prompt_eval_cached_count`.

`npm run pilot -- calibrate --base-url <url> --model <name> --out <file>
[--worst-case] [--num-predict <n>]` is gate G2 against the real server (plan
§4): the model record compared with the frozen one, every system prompt
counted, three pilot prompts cold and warm through `/api/chat` with the plan's
settings (the `prompt_count_rule`: how `prompt_eval_count` relates to the
adapter's count), the truncation canary, and with `--worst-case` the synthetic
final call with 18 messages of 200 tokens. The report (JSON, with a `summary`)
goes to `--out`; the exit code is 1 when a step fails. The steps to run on the
node are in `experiments/pilot-settlement/RUNBOOK.md`.

Validity (plan §11) is decided from the trace and the environment data,
never from the outcome: `context_truncation` (a budget violation or a
suspected overflow), `technical_failure` (a provider or runtime failure),
`environment_deviation` (an abnormal snapshot or a mid-run reload),
otherwise `valid`; a `prompt_eval_count` short of the counted prompt plus the
template's tokens by more than 1 % on an Ollama call is a `context_truncation`
too, and a pair whose preload did not answer `done_reason: "load"` is an
`environment_deviation`. Runs served by the stub provider record snapshots
that say no server was involved; runs of the pair runner carry the real ones.

Run ids: `<instance>-COMPLETE` / `<instance>-RING`, `-ORACLE`,
`-PUBLIC_ONLY`; replicate *n* > 0 adds `-rep<n>`; a probe run (scripted
agents) adds `-PROBE`, so its logs never stand in for a model's. Note that
the reference validator checks the schedule only for `condition:
"discussion"`: for probe logs it runs the schema check alone, and gate G1
itself is the unit test above.

## Files

| | |
|---|---|
| `src/scenarios/pilotSettlement/task.ts` | state, evaluator, classes, metadata, role cards (Task Definition v1.4) |
| `evaluator.ts` | the testbed evaluator (`pilot-settlement` 1.4), proposal schema with field rules, facts for the generic detector |
| `adapter.ts` | the protocol adapter: rendering, seeds, the cap, the final parser |
| `family.ts` | the 50 instances as a task family; `finalize` for the ring |
| `stubScripts.ts` | the probe |
| `config.ts` | the built-in config |
| `runLog.ts` | the run-log export |
| `src/cli/pilot.ts` | `npm run pilot -- export | validate | calibrate | pairs | determinism` |
| `tokenizer.ts` | the model's tokenizer from the show record; `tokenizerCounter` |
| `calibrate.ts` | gate G2 calibration against the server (`npm run pilot -- calibrate`) |
| `pairRunner.ts` | the pair runner: preload, snapshots, deviation re-execution (`npm run pilot -- pairs`), discussion and controls pairs |
| `determinism.ts` | gate G6 (`npm run pilot -- determinism`) |
| `experiments/pilot-settlement/` | the bundle, batch specs, change log, the model record (`model/`) |
| `tests/fixtures/pilot-tokenizer-counts.json` | the server's token counts the tokenizer is checked against |
| `tests/fixtures/pilot-settlement-reference.json` | the reference outputs the tests compare with |
