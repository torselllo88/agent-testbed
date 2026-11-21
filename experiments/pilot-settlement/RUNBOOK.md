# Pilot Settlement — runbook for the node

What to run on the pilot node, gate by gate, and what to bring back. Every
command is run in the testbed checkout on the node (`~/opt/agent-testbed`),
with the Ollama server up on the same node. Nothing here is run from the
laptop.

## 0. Before any gate

```sh
cd ~/opt/agent-testbed
git pull
npm ci                      # only after a pull that changed package-lock.json
npm run build               # type-check; must end without errors
curl -s localhost:11434/api/version        # the Ollama server answers
nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv
```

Python for the bundle's tools (the validator): the node's system Python is
3.6 and is not to be used. Once, install `uv` in the home directory and let
it bring a current Python:

```sh
curl -LsSf https://astral.sh/uv/install.sh | sh
source ~/.local/bin/env            # or open a new shell
uv python install 3.12
uv run --no-project --with jsonschema python -c "import sys, jsonschema; print(sys.version)"
```

`npm run pilot -- validate` runs the validator through
`uv run --no-project --with jsonschema python` by default, so after this no
`--python` option is needed.

The endpoint the batch specs name is `lab-ollama`; `.env` on the node must
have:

```
OPENAI_COMPATIBLE_ENDPOINTS=lab-ollama
OPENAI_COMPATIBLE_LAB_OLLAMA_BASE_URL=http://localhost:11434
OPENAI_COMPATIBLE_LAB_OLLAMA_API=ollama
OPENAI_COMPATIBLE_LAB_OLLAMA_MAX_CONCURRENT=1
```

## 1. Gate G1 — the delivery probe (no model)

```sh
npm test -- tests/scenarios/pilotSettlement.test.ts      # the probe over all 50 instances × 2 topologies
npm run batch -- experiments/pilot-settlement/pilot-probe.batch.json --out /tmp/probe.json
npm run pilot -- export --batch <batch id printed above> --out /tmp/probe-logs
npm run pilot -- validate /tmp/probe-logs/*.json
```

Expected: every test green; every exported log passes the validator's
schema check. Nothing to bring back.

## 2. Gate G2 — calibration against the server (plan §4, steps 1–4 and 6)

One command, about 5–8 minutes of GPU (model load, 6 short thinking calls of
up to 512 tokens, the canary, and with `--worst-case` one full final call of
up to 2560 tokens):

```sh
mkdir -p experiments/pilot-settlement/calibration
npm run pilot -- calibrate --base-url http://localhost:11434 --model qwen3.8:27b \
  --out experiments/pilot-settlement/calibration/$(date +%F)-g2.json --worst-case
```

Progress goes to stderr, the summary to stdout, the report to `--out`. Exit
code 0: every step passed; 1: a step failed or the server refused (the
message says which). The steps:

1. model record — Ollama version, digest, `/api/show` compared with the
   frozen `model/show.json`; a difference means the server does not serve
   the recorded model (stop and tell);
2. every system prompt (50 instances × 2 topologies × 6 roles) counted with
   the model's tokenizer, all ≤ 1200;
3. three pilot prompts cold and warm: the `prompt_count_rule` (how
   `prompt_eval_count` relates to the adapter's count), whether
   `prompt_eval_cached_count` is reported, whether `eval_count` equals
   thinking + visible tokens;
4. the truncation canary (about 9000 tokens at `num_ctx` 8192): the server
   must refuse or report fewer tokens than counted;
6. (`--worst-case`) the final call with 18 messages of 200 tokens through
   the real model: must end with `done_reason: stop` and a parsable proposal.

**Bring back** the JSON report (it is small; it contains no prompt texts,
only counts, digests and durations). From it the rule is written into the
adapter and the change log. If step 3 or 4 fails, bring the report back all
the same — it says what the server did.

To rerun step 3 at the plan's output cap instead of 512 tokens:
`--num-predict 2560` (six full generations, about 10 more minutes).

## 3. Development runs (plan §4 step 5; gates G2, G5, G6)

The 10 dev instances, each as one pair (plan §3.2): preload → snapshot →
first run → snapshot → second run → snapshot. The topology order alternates
per instance (DEV-01 complete first, DEV-02 ring first, …). An abnormal
snapshot, a failed preload or a mid-run reload makes the pair an environment
deviation: both runs are re-executed with the same seeds once the environment
is normal again (at most twice; the deviated logs are kept under
`deviations/`). A version or digest change stops the run (exit code 3): tell
me before anything else is done.

```sh
mkdir -p ~/pilot-logs
npm run pilot -- pairs --instances dev --endpoint lab-ollama --base-url http://localhost:11434 \
  --model qwen3.8:27b --out ~/pilot-logs/dev-$(date +%F)
```

Progress goes to stderr (pair, preload, snapshots, each run's outcome, each
log written). Budget: 20 runs × 19 calls with thinking up to 2560 tokens;
with the ~30 s per call seen at calibration, about 3–4 hours of the GPU.
`nohup … > ~/pilot-logs/dev.log 2>&1 &` keeps it running after a
disconnect; `tail -f ~/pilot-logs/dev.log` follows it. The command can be
re-run for single instances (`--instances DEV-07,DEV-08`): every run is a
new experiment in the database, the logs are overwritten per run id.

When it is done:

```sh
npm run pilot -- validate ~/pilot-logs/dev-<date>/*.json
```

Expected: 20 logs `OK`; `pairs/<instance>.json` next to them with the
snapshots and the decision per pair. **Bring back** the whole output folder
(logs, thinking files, `pairs/`, `deviations/` if any) — about 1–2 MB; keep it
outside the repository on the laptop (`scp -r pvgpu1:~/pilot-logs/dev-<date>
./pilot-logs/`).

## 4. Controls on the dev instances (gates G3, G4)

The oracle and the public-only call of Operations alone, as one pair per
instance (preload, three snapshots, the same deviation rule), three
replicates (plan: replicate index 0, 1, 2 — `-rep1` / `-rep2` in the run
ids). About 20 × 3 single calls, roughly 40 minutes of the GPU in all:

```sh
for r in 0 1 2; do
  npm run pilot -- pairs --kind controls --instances dev --replicate $r \
    --endpoint lab-ollama --base-url http://localhost:11434 --model qwen3.8:27b \
    --out ~/pilot-logs/controls-$(date +%F)
done
npm run pilot -- validate ~/pilot-logs/controls-<date>/*.json
```

Expected: 60 logs `OK` (`DEV-xx-ORACLE[-repN].json`, `DEV-xx-PUBLIC_ONLY[-repN].json`),
`pairs/DEV-xx-controls[-repN].json`. **Bring back** the folder.

## 5. Determinism (gate G6, hard gate)

After the dev runs: the 3 discussion and 2 final calls with the largest
prompts in the dev logs, plus the public-only call of DEV-01, each 3 times
cold (after a cache-busting prompt) and 3 times warm, with the same seed,
under snapshots before and after. 36 calls, about 20 minutes:

```sh
npm run pilot -- determinism --logs ~/pilot-logs/dev-<date> \
  --base-url http://localhost:11434 --model qwen3.8:27b \
  --out ~/pilot-logs/g6-$(date +%F).json
```

Exit code 0 and `pass` in the summary: identical content in every repeat
and both snapshots normal. **Bring back** the JSON. A `FAIL` with
`DIFFERS` is the hard-gate failure of the plan (§9): no freeze; tell me
with the report, nothing else is to be run.

## 7. The exposure detector (gate G7, plan §8)

Extraction of every accepted discussion message of the dev logs with the
pilot model (thinking off, temperature 0, seed 20261122, structured output),
then the post-processing. 360 short calls, about 30–40 minutes; the
extractions are cached under `<out>/extractions/`, so a second run with
`--postprocess-only` takes seconds and never touches the model:

```sh
npm run pilot -- detect --logs ~/pilot-logs/dev-<date> \
  --base-url http://localhost:11434 --model qwen3.8:27b \
  --out ~/pilot-logs/detector-<date>
```

Exit code 1 means an extraction failed twice (the message is then treated
as having no items; its raw answer is in the cache file). **Bring back** the
whole output folder (`*.detector.json`, `extractions/`, `summary.json`). The
summary prints the hedged share of fact items: above 10 % is spec issue S1
(§8.3), to be raised, not fixed.

## 6. The rerun after the 2026-11-20 prompt change (config_version 0.3.2-draft)

In this order, each after a `git pull` and `npm run build`:

1. §1 — G1 on the new wording (tests, probe batch, validate): no GPU.
2. §3 — dev pairs, into a new folder (`~/pilot-logs/dev-<date>`); validate; bring back.
3. §4 — controls, three replicates; validate; bring back.
4. §5 — determinism on the new dev logs; bring back.

The G2 calibration (§2) need not be repeated: the tokenizer and the
counting rule do not depend on the wording; the system-prompt count is
checked by the tests and again by the pairs (budget guard).

## 4. Bringing logs back

```sh
npm run pilot -- export --batch <id> --out ~/pilot-logs/<batch name>
npm run pilot -- validate ~/pilot-logs/<batch name>/*.json
```

Then from the laptop: `scp -r pvgpu1:~/pilot-logs ./pilot-logs` (outside the
repository). Thinking texts are in `<run_id>.thinking.json` next to each log.
