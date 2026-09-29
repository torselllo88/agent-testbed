import { randomUUID } from "node:crypto";
import { configHash, parseExperimentConfig, taskDefinitionHash, type ExperimentConfig } from "../experiment/config.js";
import type { Db } from "./db.js";

export interface ScenarioRecord {
  id: string;
  name: string;
  /** Increments on every saved change — a run records the version it was started from. */
  version: number;
  config: ExperimentConfig;
  configHash: string;
  taskDefinitionHash: string;
  /** Set for a managed built-in scenario (synced from code, read-only). */
  builtin: { id: string; version: number } | null;
  createdAt: string;
  updatedAt: string;
}

interface ScenarioRow {
  id: string;
  name: string;
  version: number;
  config_json: string;
  config_hash: string;
  builtin_id: string | null;
  builtin_version: number | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: ScenarioRow): ScenarioRecord {
  // Parse on read so records saved by older versions get today's defaults
  // filled in; a record that no longer validates is still listed as stored
  // (it will be reported when someone tries to save or run it).
  const raw = JSON.parse(row.config_json) as ExperimentConfig;
  let config: ExperimentConfig;
  try {
    config = parseExperimentConfig(raw);
  } catch {
    config = raw;
  }
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    config,
    configHash: row.config_hash,
    taskDefinitionHash: safeTaskHash(config),
    builtin: row.builtin_id ? { id: row.builtin_id, version: row.builtin_version ?? 0 } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeTaskHash(config: ExperimentConfig): string {
  try {
    return taskDefinitionHash(config);
  } catch {
    return "";
  }
}

/** Editing or deleting a managed built-in scenario — duplicate it instead. */
export class ReadOnlyScenarioError extends Error {
  constructor(name: string) {
    super(`"${name}" is a built-in scenario and cannot be changed — duplicate it to make an editable copy`);
    this.name = "ReadOnlyScenarioError";
  }
}

export interface BuiltinDefinition {
  id: string;
  version: number;
  config: () => ExperimentConfig;
}

/**
 * The scenario library: user scenarios (editable) and managed built-ins
 * (read-only rows kept in sync with the definitions in code). Configs are
 * validated and stored fully resolved, so what is saved is exactly what will
 * run — interactively and in batches alike.
 */
export class ScenarioRepository {
  constructor(private readonly db: Db) {}

  create(rawConfig: unknown): ScenarioRecord {
    return this.insert(parseExperimentConfig(rawConfig), null);
  }

  private insert(config: ExperimentConfig, builtin: { id: string; version: number } | null): ScenarioRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO scenarios (id, name, version, config_json, config_hash, builtin_id, builtin_version, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, config.name, JSON.stringify(config), configHash(config), builtin?.id ?? null, builtin?.version ?? null, now, now);
    return this.getOrThrow(id);
  }

  update(id: string, rawConfig: unknown): ScenarioRecord {
    const current = this.getOrThrow(id);
    if (current.builtin) throw new ReadOnlyScenarioError(current.name);
    return this.write(current, parseExperimentConfig(rawConfig));
  }

  private write(current: ScenarioRecord, config: ExperimentConfig, builtinVersion?: number): ScenarioRecord {
    const hash = configHash(config);
    if (hash === current.configHash && builtinVersion === undefined) return current; // no-op save keeps the version
    this.db
      .prepare(
        `UPDATE scenarios SET name = ?, version = version + 1, config_json = ?, config_hash = ?,
           builtin_version = COALESCE(?, builtin_version), updated_at = ? WHERE id = ?`
      )
      .run(config.name, JSON.stringify(config), hash, builtinVersion ?? null, new Date().toISOString(), current.id);
    return this.getOrThrow(current.id);
  }

  /**
   * Makes the library match the built-in definitions in code: missing
   * built-ins are added, and a built-in whose code version is newer than its
   * row is updated in place (its scenario version increments, so past runs
   * keep pointing at the version they used). User scenarios are never touched.
   */
  syncBuiltins(builtins: BuiltinDefinition[]): { added: string[]; updated: string[] } {
    const added: string[] = [];
    const updated: string[] = [];
    for (const builtin of builtins) {
      const row = this.db.prepare(`SELECT * FROM scenarios WHERE builtin_id = ?`).get(builtin.id) as unknown as ScenarioRow | undefined;
      if (!row) {
        this.insert(parseExperimentConfig(builtin.config()), { id: builtin.id, version: builtin.version });
        added.push(builtin.id);
      } else if ((row.builtin_version ?? 0) < builtin.version) {
        this.write(rowToRecord(row), parseExperimentConfig(builtin.config()), builtin.version);
        updated.push(builtin.id);
      }
    }
    return { added, updated };
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

  getBuiltin(builtinId: string): ScenarioRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM scenarios WHERE builtin_id = ?`).get(builtinId) as unknown as ScenarioRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /** Built-ins first (in definition order), then user scenarios, most recently updated first. */
  list(): ScenarioRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM scenarios
         ORDER BY (builtin_id IS NULL), CASE WHEN builtin_id IS NOT NULL THEN rowid END, updated_at DESC`
      )
      .all() as unknown as ScenarioRow[];
    return rows.map(rowToRecord);
  }

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM scenarios`).get() as { n: number }).n;
  }

  delete(id: string): void {
    const current = this.getOrThrow(id);
    if (current.builtin) throw new ReadOnlyScenarioError(current.name);
    this.db.prepare(`DELETE FROM scenarios WHERE id = ?`).run(id);
  }
}
