import { randomUUID } from "node:crypto";
import { configHash, parseExperimentConfig, type ExperimentConfig } from "../experiment/config.js";
import type { Db } from "./db.js";

export interface ScenarioRecord {
  id: string;
  name: string;
  /** Increments on every save — a run records the version it was started from. */
  version: number;
  config: ExperimentConfig;
  configHash: string;
  createdAt: string;
  updatedAt: string;
}

interface ScenarioRow {
  id: string;
  name: string;
  version: number;
  config_json: string;
  config_hash: string;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: ScenarioRow): ScenarioRecord {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    config: JSON.parse(row.config_json) as ExperimentConfig,
    configHash: row.config_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Saved, reusable experiment configurations. Configs are validated and
 * stored fully resolved (defaults filled), so what is saved is exactly what
 * will run — for interactive runs and batch runs alike.
 */
export class ScenarioRepository {
  constructor(private readonly db: Db) {}

  create(rawConfig: unknown): ScenarioRecord {
    const config = parseExperimentConfig(rawConfig);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO scenarios (id, name, version, config_json, config_hash, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?)`
      )
      .run(id, config.name, JSON.stringify(config), configHash(config), now, now);
    return this.getOrThrow(id);
  }

  update(id: string, rawConfig: unknown): ScenarioRecord {
    const current = this.getOrThrow(id);
    const config = parseExperimentConfig(rawConfig);
    const hash = configHash(config);
    if (hash === current.configHash) return current; // no-op save keeps the version
    this.db
      .prepare(`UPDATE scenarios SET name = ?, version = version + 1, config_json = ?, config_hash = ?, updated_at = ? WHERE id = ?`)
      .run(config.name, JSON.stringify(config), hash, new Date().toISOString(), id);
    return this.getOrThrow(id);
  }

  duplicate(id: string): ScenarioRecord {
    const source = this.getOrThrow(id);
    return this.create({ ...source.config, name: `${source.config.name} (copy)` });
  }

  get(id: string): ScenarioRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM scenarios WHERE id = ?`).get(id) as unknown as ScenarioRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  getOrThrow(id: string): ScenarioRecord {
    const record = this.get(id);
    if (!record) throw new Error(`Scenario not found: ${id}`);
    return record;
  }

  list(): ScenarioRecord[] {
    const rows = this.db.prepare(`SELECT * FROM scenarios ORDER BY updated_at DESC`).all() as unknown as ScenarioRow[];
    return rows.map(rowToRecord);
  }

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM scenarios`).get() as { n: number }).n;
  }

  delete(id: string): void {
    this.getOrThrow(id);
    this.db.prepare(`DELETE FROM scenarios WHERE id = ?`).run(id);
  }
}
