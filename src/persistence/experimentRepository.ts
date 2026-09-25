import type { TestbedVersion } from "../config/version.js";
import type { ExperimentConfig } from "../experiment/config.js";
import type { Outcome, RunStatus } from "../experiment/outcome.js";
import type { Phase } from "../experiment/phases.js";
import type { Db } from "./db.js";

export interface ExperimentRecord {
  id: string;
  scenarioId: string | null;
  scenarioVersion: number | null;
  config: ExperimentConfig;
  configHash: string;
  batchId: string | null;
  conditionKey: string | null;
  repetition: number | null;
  phase: Phase;
  status: RunStatus | null;
  outcome: Outcome | null;
  outcomeDetail: Record<string, unknown> | null;
  intervened: boolean;
  testbedVersion: TestbedVersion;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  summary: Record<string, unknown> | null;
}

interface ExperimentRow {
  id: string;
  scenario_id: string | null;
  scenario_version: number | null;
  config_snapshot_json: string;
  config_hash: string;
  batch_id: string | null;
  condition_key: string | null;
  repetition: number | null;
  phase: string;
  status: string | null;
  outcome: string | null;
  outcome_detail_json: string | null;
  intervened: number;
  testbed_version_json: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  summary_json: string | null;
}

function rowToRecord(row: ExperimentRow): ExperimentRecord {
  return {
    id: row.id,
    scenarioId: row.scenario_id,
    scenarioVersion: row.scenario_version,
    config: JSON.parse(row.config_snapshot_json) as ExperimentConfig,
    configHash: row.config_hash,
    batchId: row.batch_id,
    conditionKey: row.condition_key,
    repetition: row.repetition,
    phase: row.phase as Phase,
    status: row.status as RunStatus | null,
    outcome: row.outcome as Outcome | null,
    outcomeDetail: row.outcome_detail_json ? (JSON.parse(row.outcome_detail_json) as Record<string, unknown>) : null,
    intervened: row.intervened === 1,
    testbedVersion: JSON.parse(row.testbed_version_json) as TestbedVersion,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    summary: row.summary_json ? (JSON.parse(row.summary_json) as Record<string, unknown>) : null,
  };
}

export interface NewExperiment {
  id: string;
  scenarioId?: string | null;
  scenarioVersion?: number | null;
  config: ExperimentConfig;
  configHash: string;
  batchId?: string | null;
  conditionKey?: string | null;
  repetition?: number | null;
  testbedVersion: TestbedVersion;
}

export type ExperimentUpdate = Partial<{
  phase: Phase;
  status: RunStatus;
  outcome: Outcome;
  outcomeDetail: Record<string, unknown>;
  intervened: boolean;
  startedAt: string;
  finishedAt: string;
  summary: Record<string, unknown>;
}>;

const UPDATE_COLUMNS: Record<keyof ExperimentUpdate, { column: string; encode: (v: never) => unknown }> = {
  phase: { column: "phase", encode: (v) => v },
  status: { column: "status", encode: (v) => v },
  outcome: { column: "outcome", encode: (v) => v },
  outcomeDetail: { column: "outcome_detail_json", encode: (v) => JSON.stringify(v) },
  intervened: { column: "intervened", encode: (v: boolean) => (v ? 1 : 0) },
  startedAt: { column: "started_at", encode: (v) => v },
  finishedAt: { column: "finished_at", encode: (v) => v },
  summary: { column: "summary_json", encode: (v) => JSON.stringify(v) },
};

export class ExperimentRepository {
  constructor(private readonly db: Db) {}

  create(input: NewExperiment): ExperimentRecord {
    this.db
      .prepare(
        `INSERT INTO experiments
          (id, scenario_id, scenario_version, config_snapshot_json, config_hash, batch_id, condition_key, repetition,
           phase, intervened, testbed_version_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'INITIALIZING', 0, ?, ?)`
      )
      .run(
        input.id,
        input.scenarioId ?? null,
        input.scenarioVersion ?? null,
        JSON.stringify(input.config),
        input.configHash,
        input.batchId ?? null,
        input.conditionKey ?? null,
        input.repetition ?? null,
        JSON.stringify(input.testbedVersion),
        new Date().toISOString()
      );
    return this.getOrThrow(input.id);
  }

  get(id: string): ExperimentRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM experiments WHERE id = ?`).get(id) as unknown as ExperimentRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  getOrThrow(id: string): ExperimentRecord {
    const record = this.get(id);
    if (!record) throw new Error(`Experiment not found: ${id}`);
    return record;
  }

  list(filter: { batchId?: string; scenarioId?: string; excludeBatches?: boolean; limit?: number } = {}): ExperimentRecord[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.batchId) {
      clauses.push("batch_id = ?");
      params.push(filter.batchId);
    }
    if (filter.scenarioId) {
      clauses.push("scenario_id = ?");
      params.push(filter.scenarioId);
    }
    if (filter.excludeBatches) clauses.push("batch_id IS NULL");
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    params.push(filter.limit ?? 500);
    const rows = this.db
      .prepare(`SELECT * FROM experiments${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params) as unknown as ExperimentRow[];
    return rows.map(rowToRecord);
  }

  update(id: string, changes: ExperimentUpdate): void {
    const entries = Object.entries(changes).filter(([, v]) => v !== undefined) as Array<[keyof ExperimentUpdate, never]>;
    if (entries.length === 0) return;
    const sets = entries.map(([key]) => `${UPDATE_COLUMNS[key].column} = ?`).join(", ");
    const values = entries.map(([key, value]) => UPDATE_COLUMNS[key].encode(value));
    this.db.prepare(`UPDATE experiments SET ${sets} WHERE id = ?`).run(...(values as (string | number | null)[]), id);
  }

  /** On server start: any run that never finished was cut off by a restart/crash. Returns the affected ids. */
  listUnfinishedIds(): string[] {
    const rows = this.db.prepare(`SELECT id FROM experiments WHERE finished_at IS NULL`).all() as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM experiments WHERE id = ?`).run(id);
  }
}
