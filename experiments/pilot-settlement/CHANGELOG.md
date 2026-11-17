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

- Prompt tokens are counted with the planning estimate (4 characters per
  token, `token_counter: "approximate"`) until the model's tokenizer and
  chat template are in place (gate G2). The preflight guard uses this count.
- The pair runner (preload with `messages: []`, snapshots before / between
  / after, environment-deviation re-execution) is not there yet; a run
  served by the stub provider records snapshots that say so, a run on
  Ollama records none until the pair runner exists.
- The detector extraction and the TypeScript port of
  `tools/exposure_postprocess.py` (with its 15 tests and the Python
  cross-check) are not there yet.
