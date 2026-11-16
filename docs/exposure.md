# Exposure detection

*What* reached whom — not only who talked to whom. An analysis pass over
finished runs: it never runs during an experiment, agents never see it, it
cannot change an outcome, and it can be repeated with another model or
detector version. Results live next to the runs in the database
(`exposure_detections`, one row per pass; the latest pass counts).

## How it works

1. **A closed list of propositions per instance.** The scenario's evaluator
   supplies it (`ScenarioEvaluator.facts(params)`), from the same parameters as
   the agents' facts and the ground truth. Every proposition is **true** for
   the instance. Kinds:
   - `fact` — someone's private fact (`source`: the agent who holds it);
   - `derived` — a conclusion that combines facts (e.g. "12,000 units cannot go
     over RAIL-X in one transfer");
   - `solution` — the complete decision (solution relay).

   Service Settlement has one ([facts.ts](../src/scenarios/serviceSettlement/facts.ts));
   a new task family needs its own.
2. **Every agent message is labeled** by an LLM against every proposition:
   - `correct` — the message asserts it, or something that implies it
     (paraphrase, summary, passing on what someone else said);
   - `incorrect` — it asserts something that contradicts it (a different value,
     status, limit, the opposite);
   - `absent` — it asserts nothing about it (asking about it is absent).

   One call per message; the labels come back as JSON with every proposition
   (native structured output where the model has it), with the shortest quote
   as evidence. The detector sees the message, **not who wrote it** — a label
   must not depend on whether the holder of a fact or a relay says it (in a
   ring, facts reach the proposer through others far more often). A
   `correct` or `incorrect` whose quote is **not in the message** is kept as
   `absent`. A quote counts when its words appear as one contiguous run in
   the message, at least two words — formatting ignored (markdown, bullets,
   dash variants, quote marks, case, line breaks), words not: "10,000" does not
   match "100,000", and pieces stitched with "…" are no quote. Kept as `absent`,
   with the claimed label as `unverified` (counted: `unverified_labels`):
   a claim the detector cannot point to is a guess, and guesses add up with
   the number of messages that reach the proposer — more in a complete graph. A message the detector could not answer is kept as
   *unlabeled* and counts as saying nothing — so the pass is marked **incomplete**
   (`exposure_complete = false`; the batch summary leaves such runs out of its
   means): relabel with a larger output cap. An answer cut at `maxOutputTokens`
   is a failed call, never a label set.
3. **Labels × audiences → exposure.** From the trace's audiences (who received
   each message) up to the **decision horizon** — the first proposal request —
   every agent's exposure per proposition:

   | Class | Meaning |
   |---|---|
   | `absent` | nothing about it reached the agent |
   | `correct` | only correct mentions reached it |
   | `distorted` | only incorrect mentions reached it |
   | `conflicting` | both reached it |
   | `own` | it is the agent's own private fact |

   An agent's own messages are not something it received. The proposer's
   exposure is the pilot's mechanism measure, with the turn and sender of the
   first correct mention (timing); the `solution` proposition's class is
   solution relay. Everyone's exposure is kept too (`byAgent`), for
   propagation.

Not done by the detector: whether a derived proposition was *valid* for its
sender (did it have the premises?). The labels say what was asserted; the
trace says what the sender had seen — that check belongs to the analysis.

## In the web UI

**Batch page → Exposure.**
- **Label this batch's messages:** choose the detector's model (provider, model,
  thinking, context window; temperature 0, seed 1, 1500 output tokens), then
  **Start labeling**. It is a job on the server, one at a time, with progress
  (run, message) and **Cancel**. A run cut off by a cancel or a restart keeps
  no partial pass; starting again skips every run already labeled with that
  model (tick *relabel* to redo them). **The job yields to experiments:**
  before every request to the model it waits while any experiment runs in any
  process on the database — a CLI batch, or one started after the job — and
  says so ("waiting for N running experiment(s)"). Otherwise the detector's
  requests would queue at the same model server, and a detector model other
  than the agents' makes the server swap models mid-run — reloads, CPU
  offload, slower and numerically different runs, more timeouts for the longer
  prompts. To label anyway: `whileBusy` in the API, `--while-busy` in the CLI. Only runs the
  outcome rates count are labeled: aborted ones (timeouts, provider errors)
  are skipped, as there.
- **The summary per condition:** labeled runs; the share of the other agents'
  private facts that reached the proposer correctly (mean per run); runs with
  a distorted or conflicting fact; derived propositions reached; solution
  relay; messages the detector could not label; and **by source** — of the
  facts each agent held, how many reached the proposer correctly. Both CSVs
  (runs, facts) download from there. Over the same runs as the outcome rates
  (not aborted). If the runs were labeled with different instruments —
  detector version, model, or any of its settings (temperature, thinking,
  output cap, …; a short hash in the instrument name) — it says so: relabel
  with one before comparing. **Unverified labels** per condition: claims whose
  quote is not in the message; if they differ much between conditions, check
  the detector before comparing.
- **Manual labeling:** **Create sample** draws a fixed, seeded set of messages
  from the batch's runs (no detector pass needed), **spread evenly over the
  conditions**, so the detector's errors are checked in each — agreement is
  also reported per condition. **Label** opens it in the
  browser: one message at a time, every proposition *absent / correct /
  incorrect*, under your name — several people label the same sample
  independently, and nobody sees the detector's or anyone else's labels, nor
  who wrote the message (the detector does not see it either).
  "Rest → absent" fills what is still empty. **Agreement**: every pair of
  people, and the detector against each person (agreement, Cohen's κ,
  precision and recall per label). **CSV**: every manual label.

**Run page → Exposure** (once the run has finished): the latest pass —
every proposition with what reached the proposer and the first correct
mention (turn, sender), every message with what it asserted and the quoted
evidence — and **Label this run's messages** / **Label again**.

`stub · detector/keywords` is a crude stand-in that counts a proposition as
asserted when a message contains every id and number it names: for trying the
pipeline without a model, never for measuring.

## Commands

```bash
# 1. Label every finished run of a batch (skips runs already labeled with this
#    detector version, model and fact list; --force relabels)
npm run detect -- label --batch <id> --model '{"provider":"openai-compatible","endpoint":"lab-ollama","model":"qwen3.8:27b","structuredOutput":"native","temperature":0,"seed":1,"maxOutputTokens":1500,"think":false,"contextLength":8192}'

# 2. Export: one row per run (proposer exposure next to the outcome) and one per run × proposition
npm run detect -- export --batch <id> --runs exposure-runs.csv --facts exposure-facts.csv

# 3. Validation: a blind sample for manual labeling (n messages × every proposition, human_label empty)
npm run detect -- sample --batch <id> --n 40 --seed 1 --out sample.csv
#    … fill in human_label: absent / correct / incorrect …
npm run detect -- agree --labels sample.csv --out agreement.json
```

`--experiment <id>` instead of `--batch` works for `label` and `export`; every
command takes `--db <dir>`. `label` can run while a batch runs on the same
model server — the requests simply queue there.

The model is a model reference as in a config. Ideally not the model under
study; on a single shared GPU it may have to be. Each message takes a prompt
of roughly the fact list plus the message, and an answer of ~40 tokens per
proposition — set `maxOutputTokens` accordingly (1500 for ~25 propositions).

## Validation

In the browser (above) or with files: `agree` also reports agreement and
precision/recall of `correct` and `incorrect` **per condition** of the runs.
`agree` compares the filled-in sample with the detector's labels (the latest
pass of each run): agreement, **Cohen's kappa** over the three labels, a
confusion matrix (`confusion[human][detector]`), precision and recall per
label, the same by kind (fact / derived / solution), and every disagreement
(with `--out`). The sample file never contains the detector's labels, so
labeling is blind. Draw it with a fixed `--seed`; label it independently by
two people to have a human–human baseline. A sample of ~40 messages × ~20
propositions is ~800 labels — mostly `absent`, so look at the `correct` and
`incorrect` precision/recall, not only at overall agreement.

## Files

| CSV | Columns |
|---|---|
| runs | `batch_id`, `experiment_id`, `condition_key`, `task_definition_hash`, `topology`, `status`, `outcome`, `first_proposal_outcome`, `first_proposal_class`, `detector_version`, `facts_hash`, `labeled_messages`, `unlabeled_messages`, `facts_*` (other agents' private facts: total, correct, distorted, conflicting, absent), `derived_*`, `solution_relay` |
| facts | `batch_id`, `experiment_id`, `condition_key`, `task_definition_hash`, `fact_id`, `kind`, `source`, `proposer_class`, `first_correct_turn`, `first_correct_from` |
| sample | `experiment_id`, `message_id`, `message`, `fact_id`, `kind`, `statement`, `human_label`, `notes` (no sender: blind, as the detector) |
| manual labels (web UI) | `sample_id`, `annotator`, `experiment_id`, `message_id`, `fact_id`, `label`, `updated_at` |

Join with the batch CSV on `experiment_id`.

## A known limit: exposure is a union

A proposition counts as reached if **any** message that reached the proposer
asserts it. Over three rounds the proposer receives up to 15 messages in a
complete graph of six and up to 6 in a ring, so a detector error on single
messages becomes a larger error per run in the complete graph (with 2% false
"correct" per message: about 26% against 11%). The quote check removes the
guesses; the rest has to be measured. Report the detector's precision and
recall **per condition** (the agreement page does), and before comparing
conditions on exposure, check a few whole runs per condition by hand — the
per-message sample does not see this.

## Versioning

`DETECTOR_VERSION` (src/analysis/exposure.ts; now 2: no sender in the prompt, quotes checked) changes with the prompt, the
label rules or the aggregation; `facts_hash` with the fact list; the model is
stored with each pass. Compare passes only when all three match.
