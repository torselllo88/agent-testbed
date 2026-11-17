# Batch specs

Put the group's batch specs here, one `*.batch.json` per batch — pilot,
calibration, real runs. Commit them: a spec in git is what a batch was meant
to be, reviewable and repeatable.

The web UI lists every `*.batch.json` in `specs/`, `examples/` and
`experiments/pilot-settlement/` (the pilot's own specs) under
**Batches → New batch → Start from a spec file**; the CLI runs the same file:
`npm run batch -- specs/<file>.batch.json`. A form can be downloaded as a spec
(**Download spec JSON**) and saved here. Format: [docs/batches.md](../docs/batches.md).
