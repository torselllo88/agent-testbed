import { withTransaction, type Db } from "./db.js";

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

export interface ExposureSampleRecord {
  id: string;
  batchId: string | null;
  name: string;
  seed: number;
  createdAt: string;
  items: Array<{ experimentId: string; messageId: string }>;
}

export interface ExposureAnnotation {
  annotator: string;
  experimentId: string;
  messageId: string;
  factId: string;
  label: string;
  updatedAt: string;
}

interface SampleRow {
  id: string;
  batch_id: string | null;
  name: string;
  seed: number;
  created_at: string;
  items_json: string;
}

const sampleFromRow = (r: SampleRow): ExposureSampleRecord => ({
  id: r.id,
  batchId: r.batch_id,
  name: r.name,
  seed: Number(r.seed),
  createdAt: r.created_at,
  items: JSON.parse(r.items_json) as ExposureSampleRecord["items"],
});

/** Manual labeling: samples of messages and the labels people gave them. */
export class AnnotationRepository {
  constructor(private readonly db: Db) {}

  createSample(sample: ExposureSampleRecord): void {
    this.db
      .prepare(`INSERT INTO exposure_samples (id, batch_id, name, seed, created_at, items_json) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(sample.id, sample.batchId, sample.name, sample.seed, sample.createdAt, JSON.stringify(sample.items));
  }

  sample(id: string): ExposureSampleRecord | null {
    const row = this.db.prepare(`SELECT * FROM exposure_samples WHERE id = ?`).get(id) as SampleRow | undefined;
    return row ? sampleFromRow(row) : null;
  }

  samples(batchId: string): ExposureSampleRecord[] {
    return (this.db.prepare(`SELECT * FROM exposure_samples WHERE batch_id = ? ORDER BY created_at`).all(batchId) as unknown as SampleRow[]).map(sampleFromRow);
  }

  /** Replaces one annotator's labels for one message (every proposition given). */
  saveLabels(sampleId: string, annotator: string, experimentId: string, messageId: string, labels: Record<string, string>): void {
    const now = new Date().toISOString();
    const upsert = this.db.prepare(
      `INSERT INTO exposure_annotations (sample_id, annotator, experiment_id, message_id, fact_id, label, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (sample_id, annotator, experiment_id, message_id, fact_id) DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at`
    );
    withTransaction(this.db, () => {
      for (const [factId, label] of Object.entries(labels)) upsert.run(sampleId, annotator, experimentId, messageId, factId, label, now);
    });
  }

  annotations(sampleId: string, annotator?: string): ExposureAnnotation[] {
    const rows = (
      annotator === undefined
        ? this.db.prepare(`SELECT * FROM exposure_annotations WHERE sample_id = ? ORDER BY annotator, experiment_id, message_id, fact_id`).all(sampleId)
        : this.db.prepare(`SELECT * FROM exposure_annotations WHERE sample_id = ? AND annotator = ? ORDER BY experiment_id, message_id, fact_id`).all(sampleId, annotator)
    ) as Array<{ annotator: string; experiment_id: string; message_id: string; fact_id: string; label: string; updated_at: string }>;
    return rows.map((r) => ({ annotator: r.annotator, experimentId: r.experiment_id, messageId: r.message_id, factId: r.fact_id, label: r.label, updatedAt: r.updated_at }));
  }
}
