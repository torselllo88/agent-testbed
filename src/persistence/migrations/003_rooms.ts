/**
 * External room bindings (External Room API): a run projected into a room
 * the testbed does not own. The outbox is persistent so a consumer that
 * disconnects can resume from a cursor and still deliver everything —
 * including the ending and the debrief opening. Nothing here is read back
 * into the experiment.
 */
export const ROOMS_SQL = `
CREATE TABLE IF NOT EXISTS room_bindings (
  id TEXT PRIMARY KEY,
  -- No foreign key: the binding is created BEFORE its run, so that the run's very first
  -- visible message is already projected. Deleting an experiment deletes its binding explicitly.
  experiment_id TEXT NOT NULL UNIQUE,
  -- opaque to the testbed (e.g. "matrix"), plus the room id in that system
  provider TEXT NOT NULL,
  room_id TEXT NOT NULL,
  -- [{ participantId, externalUserId }]
  participants_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_room_bindings_room ON room_bindings(provider, room_id);

-- Everything the consumer must publish or may react to, in one ordered stream per binding.
CREATE TABLE IF NOT EXISTS room_outbox (
  binding_id TEXT NOT NULL REFERENCES room_bindings(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  -- stable, globally unique; a consumer can derive its own idempotency key from it
  message_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  -- the experiment's / interaction layer's own id for this message, for reply mapping
  internal_message_id TEXT,
  created_at TEXT NOT NULL,
  acked_at TEXT,
  external_event_id TEXT,
  PRIMARY KEY (binding_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_room_outbox_external ON room_outbox(binding_id, external_event_id);

-- Inbound events already handled, keyed by the external event id: a retried POST has no second effect.
CREATE TABLE IF NOT EXISTS room_inbound (
  binding_id TEXT NOT NULL REFERENCES room_bindings(id) ON DELETE CASCADE,
  external_event_id TEXT NOT NULL,
  internal_message_id TEXT,
  received_at TEXT NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY (binding_id, external_event_id)
);
`;
