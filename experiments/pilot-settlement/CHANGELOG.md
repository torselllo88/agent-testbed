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
