/**
 * The research demo's live runs (src/scenarios/pilotSettlement/liveDemo.ts): one row per session —
 * an instance run as Complete, then Ring, then the detector, on another provider. The two
 * experiments are ordinary rows of `experiments`; the session keeps the pair together with the
 * detector's output, the cost and the page's view. `owner_id` names the process that runs it, so a
 * session cut off by a restart can be closed as interrupted (see processOwnerId).
 */
export const PILOT_LIVE_SQL = `
CREATE TABLE IF NOT EXISTS pilot_live_sessions (
  id TEXT PRIMARY KEY,
  instance TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  stage TEXT NOT NULL,
  owner_id TEXT,
  -- { agents, extraction }: the model ids
  models_json TEXT NOT NULL,
  -- { complete, ring }: experiment ids, status, outcome, turn
  runs_json TEXT NOT NULL,
  -- { messages, done, failures } or null
  detector_json TEXT,
  -- { agentsUsd, detectorUsd, totalUsd, tokens: { agentsIn, agentsOut, detectorIn, detectorOut }, unknownCalls }
  cost_json TEXT,
  error TEXT,
  -- the page's InstanceView once the session is done (large; read only when asked for)
  view_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_pilot_live_sessions_started ON pilot_live_sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_pilot_live_sessions_instance ON pilot_live_sessions(instance, started_at);
`;
