import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { env } from "../config/env.js";
import { INIT_SQL } from "./migrations/001_init.js";

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
}

export function openDb(dataDir: string = env.dataDir): Db {
  const dbDir = path.join(dataDir, "db");
  fs.mkdirSync(dbDir, { recursive: true });
  const db = new DatabaseSync(path.join(dbDir, "testbed.sqlite3"));
  db.exec("PRAGMA journal_mode = WAL;");
  // Every trace event is its own write. With the default FULL, each one
  // fsyncs (~2 ms on a typical disk) — the dominant cost of a stub run. In
  // WAL mode NORMAL stays safe across process crashes and restarts; only an
  // OS crash / power loss can drop the most recent commits.
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  // Default busy_timeout is 0ms — a second writer (e.g. a CLI batch run
  // while the server holds this file open) would otherwise get an immediate
  // SQLITE_BUSY instead of waiting for the first writer's transaction.
  db.exec("PRAGMA busy_timeout = 5000;");
  applyMigrations(db);
  return db;
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
