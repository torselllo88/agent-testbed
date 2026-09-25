import type { ExperimentEvent, EventType } from "../experiment/events.js";
import type { Phase } from "../experiment/phases.js";
import type { Db } from "./db.js";

interface EventRow {
  seq: number;
  ts: string;
  phase: string | null;
  type: string;
  agent_id: string | null;
  payload_json: string;
}

function rowToEvent(row: EventRow): ExperimentEvent {
  return {
    seq: row.seq,
    ts: row.ts,
    phase: row.phase as Phase | null,
    type: row.type as EventType,
    agentId: row.agent_id,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  };
}

export class EventRepository {
  constructor(private readonly db: Db) {}

  /** `serializedPayload` is passed in already redacted — see EventLog.append(). */
  insert(experimentId: string, event: ExperimentEvent, serializedPayload: string): void {
    this.db
      .prepare(
        `INSERT INTO events (experiment_id, seq, ts, phase, type, agent_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(experimentId, event.seq, event.ts, event.phase, event.type, event.agentId, serializedPayload);
  }

  list(experimentId: string, afterSeq = 0): ExperimentEvent[] {
    const rows = this.db
      .prepare(`SELECT seq, ts, phase, type, agent_id, payload_json FROM events WHERE experiment_id = ? AND seq > ? ORDER BY seq`)
      .all(experimentId, afterSeq) as unknown as EventRow[];
    return rows.map(rowToEvent);
  }
}
