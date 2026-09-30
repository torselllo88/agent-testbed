import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { env } from "../config/env.js";
import { INIT_SQL } from "./migrations/001_init.js";
import { INTERACTION_SQL } from "./migrations/002_interaction.js";
import { ROOMS_SQL } from "./migrations/003_rooms.js";

// node:sqlite is a prefix-only builtin (isBuiltin("sqlite") is false, only
// isBuiltin("node:sqlite") is true). Vite/vite-node's ESM externalization
// strips the "node:" prefix before resolving, which breaks a static
// `import ... from "node:sqlite"` under vitest. Going through Node's own
// CommonJS require() sidesteps Vite's module pipeline entirely.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};

export type Db = DatabaseSyncType;

/**
 * CREATE TABLE IF NOT EXISTS is a no-op against an existing table, so a
 * column added after a database was created needs this PRAGMA-guarded ALTER
 * (SQLite has no ADD COLUMN IF NOT EXISTS). No-op for a fresh database.
 */
function ensureColumn(db: Db, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

function applyMigrations(db: Db): void {
  db.exec(INIT_SQL);
  ensureColumn(db, "experiments", "repetition", "repetition INTEGER");
  ensureColumn(db, "experiments", "task_definition_hash", "task_definition_hash TEXT");
  // At most one row per builtin_id — enforced by ScenarioRepository.syncBuiltins (the only writer).
  ensureColumn(db, "scenarios", "builtin_id", "builtin_id TEXT");
  ensureColumn(db, "scenarios", "builtin_version", "builtin_version INTEGER");
  // The process that runs a live experiment / batch: startup recovery only touches rows whose owner is gone,
  // so a server started next to a running CLI batch on the same database leaves the CLI's runs alone.
  ensureColumn(db, "experiments", "owner_pid", "owner_pid INTEGER");
  ensureColumn(db, "batches", "owner_pid", "owner_pid INTEGER");
  db.exec(INTERACTION_SQL);
  db.exec(ROOMS_SQL);
}

const SYNCHRONOUS_NAMES = ["OFF", "NORMAL", "FULL", "EXTRA"] as const;

/** The durability mode actually in effect on this connection (read back from SQLite, not from config). */
export function sqliteSynchronousMode(db: Db): string {
  const row = db.prepare("PRAGMA synchronous").get() as { synchronous: number } | undefined;
  return row ? (SYNCHRONOUS_NAMES[row.synchronous] ?? String(row.synchronous)) : "unknown";
}

export function openDb(dataDir: string = env.dataDir, synchronous: string = env.sqliteSynchronous): Db {
  const dbDir = path.join(dataDir, "db");
  fs.mkdirSync(dbDir, { recursive: true });
  const db = new DatabaseSync(path.join(dbDir, "testbed.sqlite3"));
  db.exec("PRAGMA journal_mode = WAL;");
  // Every trace event is its own write. With SQLite's own default FULL, each
  // one fsyncs (~2 ms on a typical disk) — the dominant cost of a stub run.
  // Our default NORMAL (WAL mode) stays safe across process crashes and
  // restarts; only an OS crash / power loss can drop the most recent commits.
  // Configurable via SQLITE_SYNCHRONOUS; the effective value is recorded on
  // every run (see sqliteSynchronousMode()).
  db.exec(`PRAGMA synchronous = ${synchronous};`);
  db.exec("PRAGMA foreign_keys = ON;");
  // Default busy_timeout is 0ms — a second writer (e.g. a CLI batch run
  // while the server holds this file open) would otherwise get an immediate
  // SQLITE_BUSY instead of waiting for the first writer's transaction.
  db.exec("PRAGMA busy_timeout = 5000;");
  applyMigrations(db);
  return db;
}

/**
 * Whether ANOTHER live process on this machine owns a row (null = unknown owner, treated as gone).
 * This process's own live runs are excluded by the caller's in-memory maps; a row it owns but no
 * longer runs is dead.
 */
export function processAlive(pid: number | null): boolean {
  if (pid === null || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // exists, but not ours to signal
  }
}

/** Test-only: a fresh in-memory DB with migrations applied. */
export function createInMemoryDb(): Db {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  applyMigrations(db);
  return db;
}

/**
 * node:sqlite's DatabaseSync has no built-in `.transaction()` helper (unlike
 * better-sqlite3) — this wraps the same BEGIN/COMMIT/ROLLBACK pattern by hand.
 */
export function withTransaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
