# Pilot Settlement — testbed change log

The pilot's frozen inputs are the bundle in `bundle/` (`pilot_bundle_v0.3.1.zip`,
manifest verified 27/27 on import). This file records every decision the
testbed implementation took on top of the Pilot Experimental Plan (internal
v0.3.1) and every deviation it proposes to the authors — the change-log the
plan's §1 asks for. Dates are the date of the entry.

## 2026-11-17 — first delivery: task family, protocol adapter, probe, run logs

Implemented in the testbed (`src/scenarios/pilotSettlement/`, docs in
`docs/scenarios/pilot-settlement.md`):

- The task (Task Definition v1.4) ported from `tools/settlement_task.py`:
  evaluator, classes, E7 metadata, role cards. Checked against the
  reference for all 50 instances (`tests/fixtures/pilot-settlement-reference.json`).
- The pilot protocol as a protocol adapter (`config.protocol.adapter:
  "pilot-settlement"`, version 0.3.1): every model input rendered
  byte-identically to `tools/render_prompts.py`; per-call seeds from
  `tools/seeds.py`; the visible-message cap with one regeneration and the
  deterministic truncation; the last-JSON final parser; silent turns; the
  preflight context budget. The testbed's own protocol is untouched.
- The delivery probe (plan §7.3) as the scripted agent
  `pilot-settlement/probe`; gate G1 is a unit test over all 50 instances ×
  both topologies, plus the batch specs `dev-probe.batch.json` /
  `pilot-probe.batch.json` and `npm run pilot -- export` / `validate`
  for the reference validator.
- Run logs per `schemas/run_log.schema.json`, exported from the trace.

Decisions confirmed by the author (recorded as the plan's PD items):

- **PD3** — think on, temperature 1.0, `num_predict` 2560; thinking logged
  apart (`<run_id>.thinking.json`, sha256 and length in the log) and never
  returned to any history. A lower thinking level may be chosen before the
  freeze if `/api/show` offers one.
- **PD5** — the final call carries no Ollama `format`; the last top-level
  JSON object is parsed; a schema failure is a valid run scored incorrect,
  with no retry.
- **PD7** — the detector extractor starts as the same model with thinking
  off; a stronger extractor may replace it before the freeze.
- **PD11** — one run per instance × topology once G6 passes; the replicate
  index is in every seed key from the start (`config.protocol.replicate`).

Proposed to the authors (not in the bundle; the testbed already does it):

- `run_log.schema.json`: add `replicate` (integer ≥ 0) at the top level.
  The run id gets the suffix `-rep<n>` for replicate > 0 (`P-01-RING-rep1`);
  replicate 0 keeps `<instance>-<COMPLETE|RING>`. Controls use
  `<instance>-ORACLE` and `<instance>-PUBLIC_ONLY`.
- The run log also carries `testbed` (experiment id, batch id, config hash,
  task-definition hash, protocol fingerprint, testbed outcome) and
  `token_counter` per call — the way back from a log to the trace.

Audit of the first delivery (same day; an independent read of the code
against the plan), fixed:

- A discussion answer cut at `num_predict` was treated as over-length
  (regenerated, truncated, delivered); the plan makes it a model failure.
  Now a silent turn (`thinking_overflow`). A final answer cut at
  `num_predict` before a complete object was a schema failure; now
  `final_model_failure`.
- The plan's generation settings were not enforced on a real endpoint; a
  model choice without `contextLength` would have run with Ollama's default
  window, the budget guard off and `budget_ok: true` in the log. The adapter
  now refuses a real endpoint that is not configured as the plan says
  (think on, `num_ctx` 8192, `num_predict` 2560, temperature 1.0, the
  sampling settings, `keep_alive` 30m, no fixed seed).
- `keep_alive` is now sent on every Ollama call (`model.keepAlive`).
- Run logs: flags outside the schema's enums are no longer written; `K` is
  3 for control logs too (the schema's constant); a run ended by a testbed
  budget limit exports as `technical_failure`, not `valid`; `extra_text` is
  recorded for a rejected final object too; probe run ids end in `-PROBE`.
- `checkConfig` refuses `scheduler.startAgentId`, parameters that are not
  the bundle's record of the instance, and a state that is not the
  instance's.

Known gaps of this delivery (next deliveries):

- ~~Prompt tokens are counted with the planning estimate (4 characters per
  token, `token_counter: "approximate"`) until the model's tokenizer and
  chat template are in place (gate G2). The preflight guard uses this count.~~
  Done below (same day).
- The pair runner (preload with `messages: []`, snapshots before / between
  / after, environment-deviation re-execution) is not there yet; a run
  served by the stub provider records snapshots that say so, a run on
  Ollama records none until the pair runner exists.
- The detector extraction and the TypeScript port of
  `tools/exposure_postprocess.py` (with its 15 tests and the Python
  cross-check) are not there yet.

## 2026-11-17 — model record and the model's tokenizer (plan §4 steps 1–3)

- **Model record** (§4 step 1, freeze record): `model/show.json` and
  `model/show-verbose.json` — `/api/show` of `qwen3.8:27b` on the pilot node,
  Ollama 0.33.2 (`/api/version`). Provenance, original digests and what the
  record says are in `model/README.md`. Findings that touch the plan:
  - capabilities `completion, vision, tools, thinking`; **no thinking levels**
    are listed, so the G2 fallback "a lower thinking level" (§4) is not
    available for this model — `think` is on or off (PD3 stays as agreed).
  - the chat template is Ollama's built-in renderer (`RENDERER qwen3.8`,
    template `{{ .Prompt }}`), not a text template: the template's own tokens
    are not reproducible from the record and are measured as part of
    `prompt_count_rule` (§3.7), not derived.
  - the model's own sampling defaults equal the plan's settings (temperature
    1, top_k 20, top_p 0.95, min_p 0, presence 0, repeat 1); the adapter still
    sends them explicitly.
- **Tokenizer** (§4 step 2): `src/scenarios/pilotSettlement/tokenizer.ts`
  rebuilds the model's tokenizer from the verbose record (byte-level BPE,
  llama.cpp's `qwen35` pre-tokenizer regex, special tokens matched
  literally). Checked against the server: 179 texts (all 120 dev system
  prompts, oracle / public-only prompts, empty-history turn and final texts,
  probe strings with numbers, apostrophes, newlines, unicode, special tokens)
  sent raw to `/api/generate` on the node, `prompt_eval_count` compared with
  the local count — **179 of 179 equal**, every text decodes back to itself
  (`tests/scenarios/pilotTokenizer.test.ts`, fixture
  `tests/fixtures/pilot-tokenizer-counts.json`).
  - Dev system prompts: 573 – 630 tokens (plan's estimate about 680, cap
    1200); all 50 instances × both topologies are under the cap (the test
    asserts it).
  - The adapter now counts every prompt and every visible message with the
    tokenizer (`token_counter: "tokenizer"` in the logs); the prompt count is
    the two messages counted separately and summed. The visible cap of 200
    tokens and the sentence-boundary truncation are therefore the model's
    tokens from now on.
  - **Decision (testbed):** a run on a real endpoint is refused when the
    adapter only has the approximate counter (the record file missing) — the
    budget guard and the cap must use the model's tokens (§3.4, §3.7).
- **Counting semantics, first observations** (§4 step 3, not yet the rule):
  on Ollama 0.33.2 `prompt_eval_count` of a raw prompt equals its full token
  count whether the prefix is cached or not (every text measured cold and
  warm: identical counts, the warm `prompt_eval_duration` about ten times
  shorter), and `prompt_eval_cached_count` is **not reported** by this
  version. The three-prompt cold / warm comparison through `/api/chat` with
  the template, and the truncation canary (step 4), remain to be run before
  `prompt_count_rule` is written into the config.
- Ollama 0.33.2 has no `/api/tokenize`; raw `/api/generate` with
  `num_predict` 1 is the server-side count used for the check.

## 2026-11-20 — G2 calibration command; the node is operated by the author

- From now on every action on the pilot node (calibration, dev and pilot
  runs, exports) is done by the author; the testbed delivers commands and
  the steps in `RUNBOOK.md`.
- `npm run pilot -- calibrate` (`src/scenarios/pilotSettlement/calibrate.ts`):
  plan §4 steps 1–4 and, with `--worst-case`, step 6 in one command against
  the server — the `/api/show` record compared with the frozen one, all 600
  system prompts counted, three pilot prompts (DEV-01 discussion round 1,
  final with empty history, oracle; the pilot's seeds) cold and warm through
  `/api/chat` with the plan's settings, the truncation canary (about 9000
  local tokens at `num_ctx` 8192), the synthetic worst-case final call. It
  derives `prompt_count_rule` from the observed overheads, checks that
  `eval_count` equals thinking + visible tokens (plus the think markup), and
  writes a JSON report with pass / fail per step. Tested against a scripted
  server (`tests/scenarios/pilotCalibrate.test.ts`). The step-3 calls use
  `num_predict` 512 by default (enough thinking to compare `eval_count`
  without a full generation); `--num-predict 2560` runs them at the plan's cap.
- The rule found will be recorded here and in the adapter (the bundle's
  `pilot_config.yaml` is frozen by the manifest; the filled value is proposed
  to the authors rather than written into the bundle).

## 2026-11-20 — gate G2 calibration run (plan §4 steps 1–4 and 6): passed

Report: `calibration/2026-11-20-g2.json` (run by the author on the node,
Ollama 0.33.2, `qwen3.8:27b` digest `aaee06c3…7813`, 3.5 minutes).

- **Step 1** — the server serves the recorded model: no difference from
  `model/show.json` (capabilities, details, parameters, template, model
  info); no thinking levels.
- **Step 2** — largest system prompt 630 tokens (DEV-04, complete,
  Settlement) over all 50 instances × 2 topologies × 6 roles; cap 1200.
- **Step 3** — `prompt_count_rule` (written into the adapter as
  `PROMPT_COUNT_RULE`): **`prompt_eval_count = count of the two messages +
  15`** (the chat template's tokens: `<|im_start|>`, roles, newlines, the
  thinking prefix), identical cold and warm for all three prompts;
  `prompt_eval_cached_count` is not reported by 0.33.2. `eval_count` =
  thinking tokens + visible tokens + 4 (the think markup and the stop
  token; 0 when the answer is cut inside the thinking). Also observed: with
  the same seed the cold and the warm call returned byte-identical thinking
  and content on all three prompts (a first look at G6; the gate itself is
  run as the plan says).
- **Step 4** — canary of 9033 counted tokens at `num_ctx` 8192:
  `prompt_eval_count` 4098 (the server shifted the context silently, no
  error) — the shortfall is visible, so the post-call check can be trusted.
- **Step 6** — worst-case final call (593 + 3909 message tokens = 4502,
  reported 4517): `done_reason` stop after 442 generated tokens (413 of
  thinking), the proposal parsed; prompt + eval 4959 ≤ 7992.
- **Post-call check implemented** (plan §3.7, `postcall_checks`): on every
  Ollama call counted with the tokenizer, the run-log export compares
  `prompt_eval_count` with the count + 15; a shortfall of more than 1 %
  makes the run `context_truncation` and names the call in
  `validity.detail`. The provider's character heuristic stays as a second
  net. Tested on the scripted server (exact, within tolerance, 2 % short).
- Proposed to the authors: `pilot_config.yaml` → `prompt_count_rule:
  "prompt_eval_count = local_count + 15; cached prefix not subtracted;
  prompt_eval_cached_count absent"`, `think_level: n/a (no levels listed)`.
- Still open before the freeze: step 5 (the 20 dev runs with environment
  snapshots, replicates of the three largest Complete final calls) — needs
  the pair runner; gates G3–G6.

## 2026-11-20 — the pair runner (plan §3.2, §11, PD13)

- `npm run pilot -- pairs` (`src/scenarios/pilotSettlement/pairRunner.ts`):
  per instance the preload (`messages: []`, `num_ctx` 8192, `keep_alive`
  30m, `done_reason` must be `load`), snapshots before, between and after
  (nvidia-smi, `/api/ps`, `/api/version`), the two runs through the
  `ExperimentService`, the run logs written with the snapshots and the
  preload as the pair finishes. Normality as the plan says, against the new
  freeze record `model/record.json` (model, digest, Ollama version, context
  length — from the G2 calibration; update only at a freeze).
- Deviation rule: a failed preload, an abnormal snapshot or a mid-run reload
  → both runs re-executed with the same seeds after the environment is
  normal again (polled every 60 s, up to 2 h), at most twice; the deviated
  logs are kept under `deviations/<instance>-attempt<n>/`, the pair record
  `pairs/<instance>.json` holds every execution. The decision is taken from
  the preload, the snapshots and `load_duration` before the outcomes are
  looked at (PD13). A version or digest change stops the run (exit 3).
- Run log: a failed preload now makes the run `environment_deviation` (the
  `preload` block carries `ok`); `attempt` is the execution index.
- Topology order: alternating per instance (DEV-01 complete first, DEV-02
  ring first, …) as the plan's pilot order; `--first complete|ring` for a
  fixed order. The pilot's fixed random instance order (seed 20261121) is
  not implemented yet: `--instances` takes the explicit list.
- Scripted-server tests: a normal pair, a deviated pair re-executed after
  recovery with identical seeds, a failed preload without re-executions
  left, a digest change (`tests/scenarios/pilotPairs.test.ts`).
- Dev runs can now be made: `RUNBOOK.md` §3.

## 2026-11-20 — fix: a second process on the database (the GUI next to the pair runner)

- `ownerAlive` (`src/persistence/db.ts`) called `performance.now` unbound,
  which Node 24 rejects (`ERR_INVALID_THIS`); the branch runs only when
  another live process holds a lease on the database — exactly the GUI
  started on the node while `pilot -- pairs` runs. The startup recovery then
  failed every minute, harmlessly: the exception came before any row was
  touched, so the running pair experiments were never marked interrupted.
  Fixed (the clock is bound); regression test in `tests/persistence/db.test.ts`.
  With the fix the GUI sees the pair runner's runs as live (heartbeat) and
  leaves them alone.

## 2026-11-20 — dev runs (plan §4 step 5): 20 of 20 valid; G2 fails on regenerations

Run by the author with `pilot -- pairs --instances dev` (10:59–14:43 on the
node, 10 pairs, no environment deviation, no re-execution, every preload
`load`, all 60 snapshots normal). Every log passes `validate_run_log.py`
and the schema (G1 part 2). The technical report of §10.3, per topology:

| | Complete | Ring |
|---|---|---|
| runs valid / correct (exact) / schema-valid | 10 / 10 / 10 | 10 / 10 / 10 |
| calls; technical retries; silent turns; thinking overflow | 190; 0; 0; 0 | 190; 0; 0; 0 |
| `done_reason: length` attempts; context truncation | 0; 0 | 0; 0 |
| peak prompt + eval (cap 7992) | 3237 (DEV-02 final) | 2745 |
| prompt tokens max / median | 3089 / 1692 | 1949 / 1120 |
| accepted message tokens median / p90 / max | 93 / 161 / 193 | 114 / 171 / 195 |
| thinking tokens, discussion, median / p90 / max | 128 / 272 / 354 | 271 / 564 / 1216 |
| over_length_regenerated (of 180 discussion calls) | 4 (2.2 %) | 18 (10.0 %) |
| over_length_truncated | 0 | 0 |
| call duration median / max; total | 22 s / 61 s; 79 min | 36 s / 146 s; 145 min |

- **G2**: every criterion holds except the regeneration rate — ≤ 2 % is
  at most 3 of 180; Complete has 4, Ring 18. All 22 over-length drafts were
  202–322 tokens (median 230) and every second draft came in well under the
  cap (49–134 tokens); nothing was truncated. 13 of the 22 are Operations
  (who summarises everyone), 14 of 22 in round 2. The 10 % vs 2.2 %
  difference is a technical-rate gap above 5 points — §10.3 would flag it
  as a possible confound; it fits the longer messages and the much longer
  thinking under the ring (agents hold less and reason more).
- **G5** (schema failures ≤ 5 %): 0 in both topologies — passes for dev
  runs; the oracle part waits for the controls.
- **G6** cannot be classified "by the observed prompt_eval_cached_count"
  on this server: 0.33.2 does not report the field (calibration). Proposed
  to the authors: classify the cache state by call order with a
  cache-busting prompt between cold calls, as `pilot -- calibrate` does.
- Correctness on dev (not a gate, reported for the record): 20 of 20
  exact — every class incl. C (hold) and R-ELIG / R-ROUTE (reject).
- Offline cross-check: `prompt_eval_count` = counted + 15 on every
  initial attempt; on every length regeneration the attempt's own count +
  15 (+ 17 for the appended reminder on the call's initial count). The
  runtime post-call check flagged nothing.
- Export: `content_tokens` and `thinking_tokens` (= `eval_count` −
  visible tokens) are now filled with the model's tokenizer (§3.7); the
  dev logs above were produced before this and carry null there.

**Options for the regeneration criterion** (author's decision; every
prompt change reruns G2–G6; "comprehension fixes to prompt wording" and
"budget parameters" are the allowed kinds of change):

1. Make the length instruction concrete in `system_agent.txt` (now "Keep
   each message short: a few sentences."), e.g. "at most four sentences,
   under 100 words" — the accepted messages are 70–85 words on median, the
   over-length drafts 150–240 words.
2. Raise the visible cap to 256: the drafts would fit (2 of 360 left over,
   0.6 %), but the design worst case 1200 + 80 + 17 × (256 + 16) + 2560
   = 8464 exceeds 8192; it would need the system-prompt cap lowered to
   about 900 (measured max 630) to keep the formula under 7992.
3. Keep both and accept the rate as a documented deviation of the gate.

## 2026-11-20 — prompt change for gate G2: the length instruction (config_version 0.3.2-draft)

Decided by the author after the dev-run report above (option 1): a
comprehension fix to the prompt wording, the visible cap stays 200 tokens.

- `prompts/system_agent.txt`, MESSAGE FORMAT: "Keep each message short: a
  few sentences." → **"Keep each message concise: no more than four
  sentences and under 100 words."** The regeneration reminder (plan §3.5,
  `pilot_config.yaml`) is unchanged.
- `config/pilot_config.yaml`: `config_version` 0.3.1-draft → 0.3.2-draft
  (the file's own rule: any change → new version). `MANIFEST.sha256`
  recomputed for the two files (27/27 verify); `pilot_bundle_v0.3.1.zip`
  stays the original delivery, untouched.
- Testbed: `tests/fixtures/pilot-settlement-reference.json` regenerated
  from the bundle's own tools with the new wording (the condenser was
  first checked to reproduce the old fixture byte for byte); the
  tokenizer fixture keeps the 2026-11-17 server counts, its test puts the
  measured line back before comparing.
- Consequence (plan §9): gates G2–G6 are rerun on dev with the new wording;
  the 20 dev logs of 2026-11-20 (config_version 0.3.1-draft) stay as the
  record of the failed G2.
- G6 (decided by the author): the cache state is classified by call order
  with a cache-busting prompt between cold calls, since the server does not
  report `prompt_eval_cached_count`.

## 2026-11-20 — controls pairs and the G6 command; the rerun plan

- `pilot -- pairs --kind controls`: the oracle and the public-only call of an
  instance as one pair (preload, three snapshots, deviation rule,
  `--replicate n` → `-rep<n>`), so the controls of G3 / G4 carry the same
  environment data as the discussion runs (the schema requires the
  snapshots on every log). Configs built with the batch machinery's
  `$solo` (`decideAlone`).
- `pilot -- determinism` (`determinism.ts`): gate G6 as the plan states it,
  with the cache state set and classified by call order (author's decision):
  the 3 discussion and 2 final calls with the largest prompts in the dev
  logs — texts and seeds as sent — and the public-only call of DEV-01, each
  3× cold (cache buster before) and 3× warm; snapshots before and after;
  pass = identical content within each state and normal snapshots. The
  report also says whether cold and warm agree with each other.
- Rerun sequence after the wording change: `RUNBOOK.md` §6 (G1, dev pairs,
  controls × 3, determinism). The G2 calibration is not repeated: nothing in
  it depends on the wording.
- Watch in the rerun, besides the G2 criteria: thinking length and
  `thinking_overflow` (the config's earlier note that exact counts may
  trigger thinking loops), and the ring / complete regeneration gap.

## 2026-11-21 — the rerun with the 0.3.2-draft wording: G1–G5 pass, G6 to repeat

Run by the author (dev pairs 2026-11-20 17:54–22:04; controls replicates
0–1 on 2026-11-20, replicate 2 on 2026-11-21; determinism 2026-11-21
08:59–09:15). All 80 logs pass `validate_run_log.py` and the schema; all
40 pairs valid in one execution, every preload `load`, 120 of 120 snapshots
normal, no mid-run reload.

| | Complete | Ring |
|---|---|---|
| runs valid / correct / schema-valid | 10 / 10 / 10 | 10 / 10 / 10 |
| over_length_regenerated / truncated; silent turns; thinking overflow | 0 / 0; 0; 0 | 0 / 0; 0; 0 |
| peak prompt + eval (cap 7992) | 2781 | 3039 |
| accepted message tokens median / p90 / max | 72 / 93 / 128 | 86 / 109 / 143 |
| thinking tokens, discussion, median / p90 / max | 143 / 296 / 661 | 297 / 665 / 1674 |
| call duration median / max; total | 25 s / 71 s; 89 min | 44 s / 187 s; 162 min |

- **G2 passes** in both topologies: 0 regenerations of 180 (was 4 and 18),
  no truncation, no overflow, peak well under the cap. Messages shortened
  (median 93 → 72 and 114 → 86 tokens, max 143 < 200). Thinking did not
  loop: the longest discussion thinking rose from 1216 to 1674 tokens under
  the ring, still 900 under `num_predict`; `done_reason: length` never
  occurred. The ring / complete technical-rate gap of the first run is gone
  (both 0 %); the thinking-length difference remains and is reported, not a
  rate.
- **G3 passes**: oracle exact correctness 30 / 30 (every class 1.00, every
  replicate 10 / 10).
- **G4 passes**: public-only 3 / 30 = 0.10 overall (≤ 0.30), 0.10 in every
  replicate; per class A 0, B 0, C 0, Reject 0.5 (R-ELIG 1.0, R-ROUTE 0)
  against the ceilings of `public_policy_ceiling.py` on the dev set (A 1.0,
  B 0.67, C 0.67, Reject 1.0). Operations without the private facts
  rejects everything; the one class it gets right is the instance whose
  canonical answer is a reject for no eligible destination.
- **G5 passes**: 0 schema failures in 60 control calls and 20 dev runs.
- **G6**: all 36 calls (3 discussion, 2 final, 1 public-only; 3× cold, 3×
  warm, same seed) returned byte-identical content and thinking — within
  each cache state and across the two. The gate is nevertheless recorded
  as **not passed**: the "before" snapshot was abnormal ("model not
  loaded") because the determinism command took it before anything had
  loaded the model — a defect of the command, not of the environment (the
  first cache buster loaded the model with the pilot's window; the "after"
  snapshot is normal, fully on GPU, digest and version as recorded). Fixed:
  the command now preloads (`messages: []`, done_reason `load`) before the
  first snapshot and records it. The plan's hard gate wants a clean record:
  **repeat G6** (about 20 minutes).
- Defect in these 80 logs: `config_version` is `"unknown"` — the testbed's
  reader of `pilot_config.yaml` did not accept the comment appended to the
  `config_version` line on 2026-11-20. The value in the bundle was
  `0.3.2-draft` throughout (manifest). Fixed (the reader tolerates a
  trailing comment, with a test); the logs are left as written.
- Shared GPU during G6: another user's processes held the GPU at 99 %
  utilisation; the pilot model stayed fully in GPU memory and the contents
  were identical all the same.

## 2026-11-21 — G6 repeated with the preload: passed

Run by the author 09:37–09:52 (report `g6-2026-11-21-2.json`, kept by the
author with the logs): preload `load`; both snapshots normal (model fully in
GPU memory, 17.3 GB, context length 8192, digest and version as recorded;
another user's processes at 99 % GPU utilisation throughout). All 36 calls
— 3 discussion, 2 final, 1 public-only, each 3× cold and 3× warm with the
same seed — returned byte-identical content and thinking within each cache
state and across the states; `load_duration` ≤ 6 ms on every call. The
content and thinking digests equal those of the first G6 run 40 minutes
earlier, so the six outputs reproduced across two separate sessions as well.
**G6 passes.** With G1–G5 (previous entry) every development gate but G7
(detector) is passed on config_version 0.3.2-draft.

## 2026-11-21 — the exposure detector (plan §8), first delivery for G7

- `src/scenarios/pilotSettlement/detector/postprocess.ts`: the port of
  `tools/exposure_postprocess.py` — E3 attribution, E4 expansion, E5 truth /
  source / grounding / support by enumeration over the 1024 public states,
  E6 exposure, plan §9 levels and categories. The bundle's 15 unit tests are
  ported one to one, and a cross-check runs the reference Python itself on
  synthetic runs over nine dev instances (about 1 000 claims) and compares
  every label and the decision support JSON for JSON — identical.
- `detector/detect.ts`, `npm run pilot -- detect`: the extraction with the
  pilot model as §8.2 says (thinking off, temperature 0, seed 20261122,
  Ollama `format` bound to `detector_extraction.schema.json`, the message
  and the sender's role only), validated against the schema (one retry on a
  malformed answer, then recorded as a failure with the raw text), cached
  per run with the prompt and schema digests; the post-processing output per
  run as `detector_output.schema.json`, plus `summary.json` with the §8.3
  hedged share and the categories per topology.
- Not yet: the validation set of §8.4 (the draw of ≥ 60 messages with the
  12 phenomena, the annotation format for the two annotators, the §8.5
  metrics). It comes after the first detector pass over the dev logs, which
  shows which phenomena the dev messages contain.
- The extraction model is the pilot model (PD7 default); a stronger offline
  extractor stays an option if the held-out metrics fail.

## 2026-11-21 — four decisions confirmed by the author

Put to the co-authors in the gate report; confirmed on the author's side:

- **D1** — the length instruction of 0.3.2-draft ("no more than four
  sentences and under 100 words") is a comprehension fix under §7.5; the
  pilot runs on config_version 0.3.2-draft.
- **D2** — G6 is met with the cache state constructed and classified by
  call order (cache-busting prompt before every cold call), since the server
  reports no `prompt_eval_cached_count`.
- **D3** — `prompt_count_rule`: reported = local count + 15 template tokens,
  cached prefix never subtracted; post-call tolerance 1 %. To be written
  into `pilot_config.yaml` at the freeze, with `think_level` not applicable.
- **D4** — `replicate` and the `testbed` block go **into the run-log schema**
  rather than being stripped at export: provenance over cosmetic
  compatibility. Done now: `schemas/run_log.schema.json` gains the two
  optional top-level properties (additive; every existing log still
  validates), `MANIFEST.sha256` recomputed. config_version stays
  0.3.2-draft: the schema change alters no run.

## 2026-11-21 — pilot_config.yaml: the known freeze values filled (still 0.3.2-draft, frozen: false)

For the approval document to a colleague: `model_digest`, `quantization`,
`api_show_record`, `ollama_version`, `hardware_record` (GPU and memory;
driver, CUDA and host at the freeze), `think_level` (n/a), `prompt_count_rule`
(D3) and a `changes_0_3_2_draft` list of D1–D4; `G6_as_run` records D2 next
to the gate's own text, which already allowed the order-based arrangement
when the server does not report `prompt_eval_cached_count`. Left for the
freeze: `freeze_record`, `detector.version`, `frozen`. Manifest recomputed.

## 2026-11-21 — research demo (web UI `#/research`): the dev runs as a replay

For the demo to a colleague in agent-based energy systems (communication
topology effects on distributed heuristics): the pilot's own instrument,
shown on its own data, dry.

- `experiments/pilot-settlement/demo/`: derived copies of the 20 dev run
  logs of the 0.3.2-draft rerun (thinking files left out) and the pair
  records; `detector/` for the detector outputs when they come. The copies
  carry `config_version` 0.3.2-draft (the originals say "unknown", the
  defect recorded above); the folder's README says so. Deletable without
  side effects.
- `demoData.ts` + `GET /api/pilot-demo`, `/instances/<id>`: the paired runs
  with turns, recipients, token counts and verdicts; what an agent had
  received before a turn (immediate delivery, own messages included); per
  fact, from the detector output, the chain of claims (turn, sender,
  recipients, source, support, hedged), the exposure turn and where
  propagation stopped (never stated / received by X and not passed on /
  reached as incorrect); the batch summary (pair transitions, per class,
  per-graph technical context, categories when the detector ran).
- Page `#/research`: instance picker; compare tab with both runs and the
  "what it had received" panel; information-flow tab (ten facts, status per
  graph, a fact's path in both graphs); batch tab; methods tab (frozen
  configuration, the six gates). No live run and no graph editor (decided
  against: a new edge is a new condition and needs a model; n = 1 proves
  nothing). Checked in headless Chrome (`tests/e2e/suites/research.mjs`).
- Not in this delivery: the live run via OpenRouter in exploratory mode and
  the detector through OpenRouter — the next step once the replay is agreed.

## 2026-11-22 — first detector pass over the dev logs (G7 groundwork)

Run by the author on the node (`pilot -- detect`, qwen3.8:27b, thinking off,
seed 20261122): 360 messages, 359 extracted, 1 failure (DEV-02-COMPLETE turn
18: the model's JSON broke at 14 kB, both attempts), 3015 claims. Outputs in
`demo/detector/` for the research demo; the author keeps the full folder.

- **§8.3 hedges:** 3 of 1020 fact items hedged (0.3 %) — far under the 10 %
  that would raise spec issue S1. Not raised.
- **Decision-support categories:** Complete 8 base_sufficient, 2
  inconsistent; Ring 4 base_sufficient, 1 derived_sufficient, 1
  solution_sufficient, 2 insufficient, 2 inconsistent. Operations' exposure:
  Complete 95 of 100 fact states correct, 4 conflicting, 1 absent; Ring 70
  correct, 28 absent, 2 conflicting. All 20 proposals were exact, so an
  "inconsistent" or "insufficient" run is either the ring at work
  (Operations decided from derived or solution claims — DEV-02-RING,
  DEV-05-RING, DEV-06-RING, DEV-10-RING) or an extraction error.
- **Extraction error classes seen** (11 false "own" claims, 24 unsourced
  claims), the material of the §8.4 tuning half: (1) rail mis-pairing in
  route lists ("I support D1/Rail B and D2/Rail A" → D1/A); (2) negation
  scope ("No restrictions on my end for either destination" → permits =
  false; "Neither destination is supported on Rail B" → rail A); (3) a
  compound item not split ("D2 authorized, D1 not"; "D2 only, D1 excluded"
  → both true); (4) modal or hypothetical statements taken as facts
  ("Contract must permit D2", "pending Compliance authorization",
  "Settlement must confirm a supported route") → unsourced base claims.
  No change to the extraction prompt before the validation set exists
  (§8.5: revisions on the tuning half only).
- Research demo: the information-flow tab now carries a note that the
  detector is pre-validation and what a conflicting state on an exact run
  usually means.

## 2026-11-22 — research demo: the live run (OpenRouter, exploratory)

- `protocol.params.exploratory` on the pilot adapter: lifts the plan's
  endpoint-settings check and the tokenizer requirement for a run outside
  the plan; the run log's `testbed` block then carries `exploratory: true`
  with a note. Pilot and development runs never set it (the batch specs and
  the pair runner do not).
- `liveDemo.ts`: one dev instance, Complete then Ring through the
  `ExperimentService` on the demo's OpenRouter model (temperature 1.0,
  2560 output tokens, per-call seeds as always; thinking and the Ollama-only
  options have no meaning there), then the detector with the same provider
  (`createExtractor` now takes any provider; a fenced JSON answer is
  unwrapped), then the replay's own view with validity `exploratory`.
  Sessions in memory, one at a time. Routes `POST /api/pilot-demo/live`,
  `GET /api/pilot-demo/live/<id>`; the page shows progress (turn of 18 per
  run, detector messages) and a toggle between the live view and the replay,
  with a banner that one run proves nothing.
- Tests on the stub provider: the exploratory config passes the adapter's
  check where the strict one is refused; a session runs both topologies and
  the detector (every stub extraction fails and is recorded); the API offers,
  starts, reports and refuses as it should. The keyless e2e server shows
  "not offered".
- The demo for the colleague is complete: replay with the detector's view,
  batch, methods, and the live run where an OpenRouter key is set (Railway).
