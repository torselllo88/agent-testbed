import type { BatchCondition, BatchSpec } from "../batch/spec.js";
import type { ExperimentConfig } from "../experiment/config.js";
import { processAlive, type Db } from "./db.js";

export type BatchStatus = "running" | "completed" | "cancelled" | "interrupted";

/** What a batch actually ran with — resolved at creation so later scenario edits never change it. */
export interface ResolvedBatch {
  spec: BatchSpec;
  baseConfig: ExperimentConfig;
  scenarioId: string | null;
  scenarioVersion: number | null;
  conditions: BatchCondition[];
  totalRuns: number;
}

export interface BatchRecord {
  id: string;
  name: string;
  status: BatchStatus;
  resolved: ResolvedBatch;
  createdAt: string;
  finishedAt: string | null;
}

interface BatchRow {
  id: string;
  name: string;
  spec_json: string;
  status: string;
  created_at: string;
  finished_at: string | null;
}

function rowToRecord(row: BatchRow): BatchRecord {
  return {
    id: row.id,
    name: row.name,
    status: row.status as BatchStatus,
    resolved: JSON.parse(row.spec_json) as ResolvedBatch,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

export class BatchRepository {
  constructor(private readonly db: Db) {}

  create(id: string, resolved: ResolvedBatch): BatchRecord {
    this.db
      .prepare(`INSERT INTO batches (id, name, spec_json, status, created_at, owner_pid) VALUES (?, ?, ?, 'running', ?, ?)`)
      .run(id, resolved.spec.name, JSON.stringify(resolved), new Date().toISOString(), process.pid);
    return this.getOrThrow(id);
  }

  get(id: string): BatchRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM batches WHERE id = ?`).get(id) as unknown as BatchRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  getOrThrow(id: string): BatchRecord {
    const record = this.get(id);
    if (!record) throw new Error(`Batch not found: ${id}`);
    return record;
  }

  list(): BatchRecord[] {
    const rows = this.db.prepare(`SELECT * FROM batches ORDER BY created_at DESC, rowid DESC`).all() as unknown as BatchRow[];
    return rows.map(rowToRecord);
  }

  finish(id: string, status: Exclude<BatchStatus, "running">): void {
    this.db.prepare(`UPDATE batches SET status = ?, finished_at = ? WHERE id = ?`).run(status, new Date().toISOString(), id);
  }

  /** Batches still marked running whose owning process is gone. */
  listRunningIds(): string[] {
    const rows = this.db.prepare(`SELECT id, owner_pid FROM batches WHERE status = 'running'`).all() as Array<{ id: string; owner_pid: number | null }>;
    return rows.filter((r) => !processAlive(r.owner_pid)).map((r) => r.id);
  }
}
