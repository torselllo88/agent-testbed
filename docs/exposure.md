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
   as evidence. A message the detector could not answer is kept as
   *unlabeled* and counts as saying nothing (reported).
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
| runs | `batch_id`, `experiment_id`, `condition_key`, `task_definition_hash`, `topology`, `outcome`, `first_proposal_outcome`, `first_proposal_class`, `detector_version`, `facts_hash`, `labeled_messages`, `unlabeled_messages`, `facts_*` (other agents' private facts: total, correct, distorted, conflicting, absent), `derived_*`, `solution_relay` |
| facts | `batch_id`, `experiment_id`, `condition_key`, `task_definition_hash`, `fact_id`, `kind`, `source`, `proposer_class`, `first_correct_turn`, `first_correct_from` |
| sample | `experiment_id`, `message_id`, `sender`, `message`, `fact_id`, `kind`, `statement`, `human_label`, `notes` |

Join with the batch CSV on `experiment_id`.

## Versioning

`DETECTOR_VERSION` (src/analysis/exposure.ts) changes with the prompt, the
label rules or the aggregation; `facts_hash` with the fact list; the model is
stored with each pass. Compare passes only when all three match.
