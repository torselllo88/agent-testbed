import type { Db } from "./db.js";

export interface ExposureDetectionRecord {
  id: string;
  experimentId: string;
  createdAt: string;
  detectorVersion: string;
  model: Record<string, unknown>;
  factsHash: string;
  result: unknown;
}

interface Row {
  id: string;
  experiment_id: string;
  created_at: string;
  detector_version: string;
  model_json: string;
  facts_hash: string;
  result_json: string;
}

const fromRow = (row: Row): ExposureDetectionRecord => ({
  id: row.id,
  experimentId: row.experiment_id,
  createdAt: row.created_at,
  detectorVersion: row.detector_version,
  model: JSON.parse(row.model_json) as Record<string, unknown>,
  factsHash: row.facts_hash,
  result: JSON.parse(row.result_json) as unknown,
});

export class ExposureRepository {
  constructor(private readonly db: Db) {}

  save(record: ExposureDetectionRecord): void {
    this.db
      .prepare(
        `INSERT INTO exposure_detections (id, experiment_id, created_at, detector_version, model_json, facts_hash, result_json) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(record.id, record.experimentId, record.createdAt, record.detectorVersion, JSON.stringify(record.model), record.factsHash, JSON.stringify(record.result));
  }

  /** The most recent pass over a run (null: never labeled). */
  latest(experimentId: string): ExposureDetectionRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM exposure_detections WHERE experiment_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(experimentId) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  list(experimentId: string): ExposureDetectionRecord[] {
    return (this.db.prepare(`SELECT * FROM exposure_detections WHERE experiment_id = ? ORDER BY created_at, rowid`).all(experimentId) as unknown as Row[]).map(fromRow);
  }
}
