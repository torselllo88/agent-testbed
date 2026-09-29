import type { Db } from "./db.js";

export type DebriefStatus = "OPEN" | "CLOSED" | "INTERRUPTED";

export interface DebriefUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  /** Calls whose cost could not be determined — costUsd is then a lower bound. */
  callsWithUnknownCost: number;
  llmCalls: number;
  answered: number;
  failed: number;
  rejected: number;
}

export const EMPTY_DEBRIEF_USAGE: DebriefUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  callsWithUnknownCost: 0,
  llmCalls: 0,
  answered: 0,
  failed: 0,
  rejected: 0,
};

export interface DebriefSessionRecord {
  id: string;
  experimentId: string;
  number: number;
  status: DebriefStatus;
  openedBy: "auto" | "operator";
  openedAt: string;
  closedAt: string | null;
  closeReason: string | null;
  usage: DebriefUsage;
}

export interface InteractionEvent {
  seq: number;
  ts: string;
  sessionId: string | null;
  type: string;
  agentId: string | null;
  payload: Record<string, unknown>;
}

interface SessionRow {
  id: string;
  experiment_id: string;
  number: number;
  status: string;
  opened_by: string;
  opened_at: string;
  closed_at: string | null;
  close_reason: string | null;
  usage_json: string;
}

interface EventRow {
  seq: number;
  ts: string;
  session_id: string | null;
  type: string;
  agent_id: string | null;
  payload_json: string;
}

function toSession(row: SessionRow): DebriefSessionRecord {
  return {
    id: row.id,
    experimentId: row.experiment_id,
    number: row.number,
    status: row.status as DebriefStatus,
    openedBy: row.opened_by as "auto" | "operator",
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    closeReason: row.close_reason,
    usage: { ...EMPTY_DEBRIEF_USAGE, ...(JSON.parse(row.usage_json) as Partial<DebriefUsage>) },
  };
}

const SESSION_COLUMNS = "id, experiment_id, number, status, opened_by, opened_at, closed_at, close_reason, usage_json";

/** Human-interaction persistence: debrief sessions and the interaction event log (never the experiment's own events). */
export class InteractionRepository {
  constructor(private readonly db: Db) {}

  createSession(input: { id: string; experimentId: string; openedBy: "auto" | "operator"; openedAt: string }): DebriefSessionRecord {
    const row = this.db.prepare(`SELECT MAX(number) AS n FROM debrief_sessions WHERE experiment_id = ?`).get(input.experimentId) as { n: number | null };
    const number = (row.n ?? 0) + 1;
    this.db
      .prepare(`INSERT INTO debrief_sessions (${SESSION_COLUMNS}) VALUES (?, ?, ?, 'OPEN', ?, ?, NULL, NULL, ?)`)
      .run(input.id, input.experimentId, number, input.openedBy, input.openedAt, JSON.stringify(EMPTY_DEBRIEF_USAGE));
    return this.getSession(input.id)!;
  }

  getSession(id: string): DebriefSessionRecord | null {
    const row = this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM debrief_sessions WHERE id = ?`).get(id) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  listSessions(experimentId: string): DebriefSessionRecord[] {
    const rows = this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM debrief_sessions WHERE experiment_id = ? ORDER BY number`).all(experimentId) as unknown as SessionRow[];
    return rows.map(toSession);
  }

  openSessions(): DebriefSessionRecord[] {
    const rows = this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM debrief_sessions WHERE status = 'OPEN'`).all() as unknown as SessionRow[];
    return rows.map(toSession);
  }

  updateUsage(id: string, usage: DebriefUsage): void {
    this.db.prepare(`UPDATE debrief_sessions SET usage_json = ? WHERE id = ?`).run(JSON.stringify(usage), id);
  }

  /** OPEN -> CLOSED / INTERRUPTED, once; a closed session is history and never changes status again. */
  closeSession(id: string, status: Exclude<DebriefStatus, "OPEN">, reason: string, closedAt: string): boolean {
    const result = this.db
      .prepare(`UPDATE debrief_sessions SET status = ?, close_reason = ?, closed_at = ? WHERE id = ? AND status = 'OPEN'`)
      .run(status, reason, closedAt, id);
    return Number(result.changes) > 0;
  }

  /** `serializedPayload` is passed in already redacted. */
  appendEvent(experimentId: string, event: Omit<InteractionEvent, "seq" | "payload">, serializedPayload: string): number {
    const row = this.db.prepare(`SELECT MAX(seq) AS s FROM interaction_events WHERE experiment_id = ?`).get(experimentId) as { s: number | null };
    const seq = (row.s ?? 0) + 1;
    this.db
      .prepare(`INSERT INTO interaction_events (experiment_id, seq, ts, session_id, type, agent_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(experimentId, seq, event.ts, event.sessionId, event.type, event.agentId, serializedPayload);
    return seq;
  }

  listEvents(experimentId: string, afterSeq = 0): InteractionEvent[] {
    const rows = this.db
      .prepare(`SELECT seq, ts, session_id, type, agent_id, payload_json FROM interaction_events WHERE experiment_id = ? AND seq > ? ORDER BY seq`)
      .all(experimentId, afterSeq) as unknown as EventRow[];
    return rows.map((r) => ({
      seq: r.seq,
      ts: r.ts,
      sessionId: r.session_id,
      type: r.type,
      agentId: r.agent_id,
      payload: JSON.parse(r.payload_json) as Record<string, unknown>,
    }));
  }
}
