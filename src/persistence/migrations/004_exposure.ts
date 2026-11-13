/**
 * Exposure detection (src/analysis/exposure.ts): an analysis pass over a
 * finished run, never part of it. One row per pass — a run may be labeled
 * again with another detector version or model; the latest pass is used.
 */
export const EXPOSURE_SQL = `
CREATE TABLE IF NOT EXISTS exposure_detections (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  detector_version TEXT NOT NULL,
  -- the model reference that labeled the messages
  model_json TEXT NOT NULL,
  -- sha256 of the canonical fact list: a changed list is a different measurement
  facts_hash TEXT NOT NULL,
  -- { facts, messages (with every label and the raw detector call), summary }
  result_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exposure_detections_experiment ON exposure_detections(experiment_id, created_at);
`;
