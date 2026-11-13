# Batch experiments

A batch runs one base configuration under every combination of variable values,
N times each, through the normal engine. Every run is an ordinary experiment,
tagged with its batch, condition and repetition.

```json
{
  "name": "Scheduler × consensus",
  "base": { "scenarioId": "…" },
  "variables": [
    { "path": "scheduler.type", "label": "scheduler", "values": ["round_robin", "hybrid"] },
    { "path": "consensus.rule", "label": "consensus", "values": ["unanimity", "majority"] },
    { "path": "agents.*.model.model", "label": "model", "values": ["anthropic/claude-sonnet-5", "openai/gpt-5.5"] }
  ],
  "repetitions": 10,
  "concurrency": 2,
  "stubLatencyMs": 0,
  "order": "interleaved"
}
```

A runnable example: [examples/space-station-batch.json](../examples/space-station-batch.json),
12 conditions × 3 repetitions on stub agents:

```bash
npm run batch -- examples/space-station-batch.json --csv runs.csv
```

## Spec

- **`base`:** `{ "scenarioId" }` (a saved scenario; its version is recorded),
  `{ "builtin": "space-station" }`, `{ "config": {…} }`, or, in the CLI only,
  `{ "configPath": "…" }`. The base is resolved and stored when the batch is
  created, so later scenario edits never change a batch.
- **Paths:** a dotted field; `*` for every array element
  (`agents.*.model.model`); a whole object as the value (`"scheduler"`); or the
  virtual `$agents`, whose value is the list of agent ids to keep (to vary the
  number of agents). The conversation language is an ordinary variable:
  `{ "path": "conversation.language", "values": ["en", "ru"] }`.
- **Task instances: `$instance`.** A scenario with a task family (today:
  Service Settlement) has instances — parameter sets from which both the facts
  agents get and the evaluator's ground truth are built. Values are instance
  ids (`"dev-01"`) or inline instances
  `{ "id": "dev-02", "params": { …the evaluator's parameters… }, "seed": 5 }`.
  The instance is applied **first** — task, roles, objectives, private facts
  and evaluator parameters replaced; models, protocol and topology kept — and
  every other variable layers on top. An instance's `seed` becomes
  `randomization.seed`: all conditions of one instance share speaking order
  and ring, so **conditions are paired within an instance**
  ([communication topology](configuration.md#communication-topology)). Keys
  and the CSV show an instance by its id; the run's name gets ` · <id>`, and
  `task_definition_hash` tells instances apart. Invalid parameters, unknown
  ids and a base without a family are refused before anything runs.

  ```jsonc
  "variables": [
    { "path": "$instance", "label": "instance", "values": ["dev-01", { "id": "dev-02", "seed": 5, "params": { … } }] },
    { "path": "communication", "label": "graph", "values": [{ "topology": { "type": "complete" } }, { "topology": { "type": "ring" } }] }
  ]
  ```
- **Calibration: `$solo`.** `"full"` or `"public"`: the proposer **alone**,
  asked once — no discussion (`discussion.fixedRounds: 0`), no vote
  (`consensus.rule: "none"`). With `"full"` its private information is
  followed by every other agent's, each headed "What <name> (<role>) knows:";
  with `"public"` it keeps only its own (plus the shared context everyone
  has). Task, model and evaluator stay, so the answer is judged exactly as a
  group's. It answers the calibration questions *can the task be solved with
  all the information* and *does it depend on the private information*. Applied
  **last** (it removes the other agents, the graph and the seed), so a batch
  that also varies the topology makes identical configs and is refused — run
  calibration as its own batch, e.g. `$instance` × `$solo`. A single agent
  has its own system prompt ("You decide alone: there is no discussion and no
  vote") and its own protocol fingerprint. Scenario texts that speak of "the
  group" or "the vote" (objectives, private notes) are the scenario's to
  phrase neutrally.
- **Validation up front:** every condition is validated before anything runs.
  One broken condition rejects the whole batch, naming the condition. A path
  whose value the validated config does not carry (a typo such as
  `model.temprature`, or a setting the configuration does not use) is an
  error: every field a value sets must survive exactly, while fields the
  schema adds to a whole-object value (defaults) are fine. Two conditions
  that come out as the same effective config are an error too. The limit
  is 2000 runs per batch, checked before any condition is built.
- **`order: "interleaved"`** (the default) runs repetition 1 of every condition,
  then repetition 2, and so on, so provider drift over time spreads evenly
  across conditions.
- **`stubLatencyMs`** defaults to 0. Batches never inherit the web demo's
  `STUB_LATENCY_MS`.
- **`headless`** is `true` by default: nobody watches batch runs live, so
  add-ons skip what only matters to a live viewer. Viewer pacing and reveal
  pauses are skipped; the trace records an `extension_note`, and the run
  environment has `headless: true`. Set `false` to keep them. Narration is
  posted and traced either way. This is an add-on option, never part of the
  experiment config, so `configHash` does not change. (Older specs with
  `pacing: "scenario"` are read as `headless: false`.)
- **`concurrency`** limits simultaneous *experiments*. What limits simultaneous
  *provider requests* is the process-wide `LLM_MAX_CONCURRENT_REQUESTS`,
  because one experiment's voting step alone issues one request per agent.

Batch runs never open a debrief.

## Aggregates

Per condition and overall:

- success rate with a 95% Wilson interval, and consensus rate (over runs with a vote; null under `consensus.rule: "none"`);
- first-proposal correctness (`firstProposal`): how many first proposals
  passed every check, whatever the vote made of them, with its own Wilson
  interval;
- outcome and category counts, and the scenario's outcome classes
  (`classifications`, e.g. `{ correct: 31, unsafe: 6, overcautious: 3 }`)
  where the evaluator reports them;
- prompts that probably did not fit a self-hosted model's context window
  (`contextOverflowSuspected`, should be 0);
- runs with calls served while a self-hosted model was partly in CPU memory
  (`runsWithPartialGpuOffload`, should be 0 — the batch page warns);
- mean, median, min and max of total, agent and orchestration tokens, turns,
  public messages and active duration;
- total and mean cost, and the number of calls of unknown cost;
- communication: addressed share, participation evenness and turns to the
  first proposal (runs recorded before these metrics existed are left out).

Success and consensus rates are computed over **evaluable** runs only.
**Excluded** runs (`PROVIDER_ERROR`, `ERROR`, `INTERRUPTED`,
`STOPPED_BY_OPERATOR`) are always reported next to them, broken down by
outcome. Provider errors get their own warning in the UI and the CLI, so
provider instability is never hidden by the denominator.

## Export

- **CSV**, one row per run: a column per variable, outcome, category,
  consensus, the outcome class and the failed checks (`outcome_class`,
  `violated`, `;`-separated), the same for the first proposal
  (`first_proposal_outcome`, `first_proposal_class`,
  `first_proposal_violated`), turns, messages, tokens, cost, serving warnings
  (`context_overflow_suspected`, `calls_with_thinking`, `calls_partial_gpu_offload`,
  `calls_serving_unknown`, `min_gpu_fraction`), duration, communication
  (`addressed_share`, `interaction_density`, `interaction_reciprocity`,
  `participation_evenness`, `silent_agents`, `turns_to_first_proposal`),
  who spoke when and who heard whom (`topology`, `randomization_seed`,
  `speaking_order`, `ring_order` — ids joined by `>` —, `mean_reach`,
  `reach_max_round`, `reach_unreachable`),
  intervention flag,
  `config_hash`, `evaluator_version`, `protocol_fingerprint`,
  `task_definition_hash`.
- **JSON:** the resolved spec, aggregates and per-run summaries.

For analysis, `config_hash` + `evaluator_version` + `protocol_fingerprint`
identify a condition and `task_definition_hash` the task (see
[reproducibility](reproducibility.md#hashes)).
