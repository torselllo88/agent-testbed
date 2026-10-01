# Extending the testbed

## A new scenario

Add a folder next to [src/scenarios/spaceStation/](../src/scenarios/spaceStation/):

1. `evaluator.ts` — a `ScenarioEvaluator` with a `proposalSchema` (zod; *structure
   only*, so that unsafe plans remain expressible), a `.strict()` `paramsSchema`
   (an unknown key must be an error, not silently replaced by a default) and a
   deterministic `evaluate()` that returns per-check results. One check per
   fact an ending can state truthfully. Bump its `version` whenever a proposal
   could be judged differently — the version is part of the
   `taskDefinitionHash`.
2. `config.ts` — the default experiment config (pure data). Keep the task
   definition in shared constants (see `spaceStation/task.ts`) if several
   scenarios should share one underlying task, as the benchmark and Kestrel do.
3. Optionally, personas and `presentation` (narrator, per-language strings,
   mission-failure priority, pacing) and `humanInteraction` for a
   viewer-oriented variant. See [scenarios](scenarios/README.md#building-blocks).
   A narrated scenario needs a `missionFailure` ending in every authored
   language and a priority slot for every check;
   [tests/scenarios/narrationCoverage.test.ts](../tests/scenarios/narrationCoverage.test.ts)
   checks the built-ins.
4. Optionally, stub scripts for keyless runs and tests.
5. Register them in [src/scenarios/index.ts](../src/scenarios/index.ts) with an
   id, a one-line summary and a version. Bump the version whenever the
   definition changes in a way that affects runs, and note the change.

Nothing in `experiment/`, `scheduling/`, `presentation/` or `transport/`
changes; generic code must not name the scenario (a test enforces it).

## A new scheduling strategy

Leader-based, expertise-based, random, …: implement `Scheduler.next(ctx)` in
[src/scheduling/](../src/scheduling/) and add it to `createScheduler` and to
the config's scheduler union. Schedulers receive the public room only.

## A new decision rule

Leader decision, weighted expertise, domain veto: implement
`ConsensusRule.decide(votes, eligible)` in
[src/consensus/index.ts](../src/consensus/index.ts).

## A new LLM provider

Implement `LlmProvider.complete()` in [src/llm/](../src/llm/) and register it in
`createProviderRegistryFromEnv`. A failed but billed response should carry its
usage (`ProviderError.billed`), so cost accounting stays complete.

## A new run extension

An add-on for observers (another narrator, an overlay, a recorder) implements
`RunExtension` ([src/experiment/extensions.ts](../src/experiment/extensions.ts))
and is attached by the composition roots; see
[architecture](architecture.md#core-vs-add-ons) for what it may and may not do.

## An external chat room

Write an adapter against the [External Room API](external-room-api.md); nothing
in the testbed changes. [src/cli/roomMock.ts](../src/cli/roomMock.ts)
(`npm run room:mock`) is a runnable reference adapter.
