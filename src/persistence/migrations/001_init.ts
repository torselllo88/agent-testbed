/**
 * A plain string run idempotently on startup (CREATE ... IF NOT EXISTS),
 * rather than a .sql asset file — tsc does not copy non-.ts files into
 * dist/, and a schema this small doesn't warrant a migration framework.
 */
export const INIT_SQL = `
-- Saved, editable experiment configurations. version increments on every
-- save; config_hash is the sha256 of the canonical config JSON, so a run can
-- always be matched to the exact configuration it used.
CREATE TABLE IF NOT EXISTS scenarios (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  config_json TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  -- Set for managed built-in scenarios (synced from code, read-only); null for user scenarios.
  builtin_id TEXT,
  builtin_version INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

-- One row per run. config_snapshot_json is the full resolved config the run
-- executed with — a later edit to the scenario never changes what a past run
-- says it used. summary_json is a cache of metrics computed from events
-- (events stay the single source of truth).
CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  scenario_id TEXT REFERENCES scenarios(id) ON DELETE SET NULL,
  scenario_version INTEGER,
  config_snapshot_json TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  -- Hash of the underlying task definition only (see experiment/config.ts taskDefinitionHash):
  -- equal for runs of the same problem even when persona, models, language or presentation differ.
  task_definition_hash TEXT,
  batch_id TEXT REFERENCES batches(id) ON DELETE SET NULL,
  condition_key TEXT,
  -- 1-based repetition index within its batch condition (null outside batches).
  repetition INTEGER,
  phase TEXT NOT NULL,
  status TEXT,
  outcome TEXT,
  outcome_detail_json TEXT,
  intervened INTEGER NOT NULL DEFAULT 0,
  testbed_version_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  summary_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_experiments_batch ON experiments(batch_id);

-- Append-only event log, written as events happen (not buffered), so a live
-- view can follow a run and a crashed run still has everything up to the crash.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  phase TEXT,
  type TEXT NOT NULL,
  agent_id TEXT,
  payload_json TEXT NOT NULL,
  UNIQUE (experiment_id, seq)
);
`;
