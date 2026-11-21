# Research demo dataset

The replay data of the web UI's **Research demo** (`#/research`,
`docs/web-ui.md`): the pilot's development runs, served read-only by
`GET /api/pilot-demo`. Derived copies — the research record is the author's
archive of the node's output folders; nothing here is used by a gate.

| Folder | Content | Source |
|---|---|---|
| `dev-runs/` | 20 run logs (`schemas/run_log.schema.json`): the 10 dev instances × Complete / Ring of the 2026-11-20 rerun on config_version 0.3.2-draft; thinking files left out | `pilot -- pairs --instances dev` on the pilot node, 2026-11-20 17:54–22:04 |
| `dev-runs/pairs/` | the pair runner's record per instance (preload, snapshots, decision) | same |
| `detector/` | `<run_id>.detector.json` per run (`schemas/detector_output.schema.json`), read when present; the information-flow tab needs them | `pilot -- detect --logs <dev logs>` on the node (RUNBOOK §7); copy the `*.detector.json` files here |

One edit to the copies: `config_version` is set to `0.3.2-draft`. The logs
were written with `"unknown"` because of a testbed defect of that day (the
config reader did not accept a comment on the line); the bundle's value was
0.3.2-draft throughout (manifest). The originals are kept as written.

To refresh: replace the files, restart the server (the dataset is read once);
`tests/scenarios/pilotDemoData.test.ts` and the `research` e2e suite check the
dataset's shape. The folder can be deleted without touching anything else:
the page then says no dataset is installed.
