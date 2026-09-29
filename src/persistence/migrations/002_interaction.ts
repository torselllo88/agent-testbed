/**
 * Human interaction around a run (spectator chat, post-run debrief) — kept
 * entirely outside the experiment's own event log. Rows reference the
 * experiment by id; nothing here is ever read into experiment metrics.
 */
export const INTERACTION_SQL = `
-- One row per debrief session; a finished experiment may have several
-- (an operator re-opening a debrief creates a new session, never reopens one).
CREATE TABLE IF NOT EXISTS debrief_sessions (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  -- 1-based, per experiment
  number INTEGER NOT NULL,
  -- OPEN | CLOSED | INTERRUPTED
  status TEXT NOT NULL,
  opened_by TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT,
  -- tokens, cost and counts of this session's own LLM calls
  usage_json TEXT NOT NULL,
  UNIQUE (experiment_id, number)
);

-- Append-only log of everything human-facing in an experiment's room that is
-- not part of the experiment: human messages, notices, debrief questions,
-- routing, LLM calls and answers.
CREATE TABLE IF NOT EXISTS interaction_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  session_id TEXT,
  type TEXT NOT NULL,
  agent_id TEXT,
  payload_json TEXT NOT NULL,
  UNIQUE (experiment_id, seq)
);
`;
