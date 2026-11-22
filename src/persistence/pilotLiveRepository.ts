import { currentOwnerId, ownerAlive, type Db } from "./db.js";

/** A live session's row, as the service keeps it (src/scenarios/pilotSettlement/liveDemo.ts). */
export interface PilotLiveRow {
  id: string;
  instance: string;
  startedAt: string;
  finishedAt: string | null;
  stage: string;
  ownerId: string | null;
  models: { agents: string; extraction: string };
  runs: Record<string, unknown>;
  detector: Record<string, unknown> | null;
  cost: Record<string, unknown> | null;
  error: string | null;
  /** Absent from list reads. */
  view?: Record<string, unknown> | null;
}

interface Raw {
  id: string;
  instance: string;
  started_at: string;
  finished_at: string | null;
  stage: string;
  owner_id: string | null;
  models_json: string;
  runs_json: string;
  detector_json: string | null;
  cost_json: string | null;
  error: string | null;
  view_json?: string | null;
}

const RUNNING_STAGES = new Set(["complete", "ring", "detector", "cancelling"]);

export class PilotLiveRepository {
  constructor(private readonly db: Db) {}

  private row(r: Raw, withView: boolean): PilotLiveRow {
    const out: PilotLiveRow = {
      id: r.id,
      instance: r.instance,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      stage: r.stage,
      ownerId: r.owner_id,
      models: JSON.parse(r.models_json) as PilotLiveRow["models"],
      runs: JSON.parse(r.runs_json) as Record<string, unknown>,
      detector: r.detector_json ? (JSON.parse(r.detector_json) as Record<string, unknown>) : null,
      cost: r.cost_json ? (JSON.parse(r.cost_json) as Record<string, unknown>) : null,
      error: r.error,
    };
    if (withView) out.view = r.view_json ? (JSON.parse(r.view_json) as Record<string, unknown>) : null;
    return out;
  }

  insert(s: PilotLiveRow): void {
    this.db
      .prepare(`INSERT INTO pilot_live_sessions (id, instance, started_at, finished_at, stage, owner_id, models_json, runs_json, detector_json, cost_json, error, view_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(s.id, s.instance, s.startedAt, s.finishedAt, s.stage, s.ownerId, JSON.stringify(s.models), JSON.stringify(s.runs), s.detector ? JSON.stringify(s.detector) : null, s.cost ? JSON.stringify(s.cost) : null, s.error, s.view ? JSON.stringify(s.view) : null);
  }

  /** Writes the whole session state (small except the view, written once at the end). */
  update(s: PilotLiveRow): void {
    this.db
      .prepare(`UPDATE pilot_live_sessions SET finished_at = ?, stage = ?, runs_json = ?, detector_json = ?, cost_json = ?, error = ?${s.view !== undefined ? ", view_json = ?" : ""} WHERE id = ?`)
      .run(...([s.finishedAt, s.stage, JSON.stringify(s.runs), s.detector ? JSON.stringify(s.detector) : null, s.cost ? JSON.stringify(s.cost) : null, s.error, ...(s.view !== undefined ? [s.view ? JSON.stringify(s.view) : null] : []), s.id] as (string | null)[]));
  }

  get(id: string, withView = true): PilotLiveRow | null {
    const cols = withView ? "*" : "id, instance, started_at, finished_at, stage, owner_id, models_json, runs_json, detector_json, cost_json, error";
    const r = this.db.prepare(`SELECT ${cols} FROM pilot_live_sessions WHERE id = ?`).get(id) as Raw | undefined;
    return r ? this.row(r, withView) : null;
  }

  /** Every session, newest first, without the views. */
  list(instance?: string): PilotLiveRow[] {
    const cols = "id, instance, started_at, finished_at, stage, owner_id, models_json, runs_json, detector_json, cost_json, error";
    const rows = (instance
      ? this.db.prepare(`SELECT ${cols} FROM pilot_live_sessions WHERE instance = ? ORDER BY started_at DESC`).all(instance)
      : this.db.prepare(`SELECT ${cols} FROM pilot_live_sessions ORDER BY started_at DESC`).all()) as unknown as Raw[];
    return rows.map((r) => this.row(r, false));
  }

  /** Whether a session is still in a running stage and owned by a live process (this one included). */
  anyRunning(): boolean {
    const own = currentOwnerId(this.db);
    const rows = this.db.prepare(`SELECT owner_id, stage FROM pilot_live_sessions WHERE finished_at IS NULL`).all() as Array<{ owner_id: string | null; stage: string }>;
    return rows.some((r) => RUNNING_STAGES.has(r.stage) && ((own !== undefined && r.owner_id === own) || ownerAlive(this.db, r.owner_id)));
  }

  /** On start-up: sessions in a running stage whose process is gone are closed as interrupted. Returns their ids. */
  recoverInterrupted(): string[] {
    const rows = this.db.prepare(`SELECT id, owner_id, stage FROM pilot_live_sessions WHERE finished_at IS NULL`).all() as Array<{ id: string; owner_id: string | null; stage: string }>;
    const gone = rows.filter((r) => RUNNING_STAGES.has(r.stage) && !ownerAlive(this.db, r.owner_id));
    const now = new Date().toISOString();
    for (const r of gone) {
      this.db.prepare(`UPDATE pilot_live_sessions SET stage = 'failed', finished_at = ?, error = ? WHERE id = ?`).run(now, `interrupted by a server restart during the ${r.stage} stage`, r.id);
    }
    return gone.map((r) => r.id);
  }
}
