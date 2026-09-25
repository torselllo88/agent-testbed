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

function applyMigrations(db: Db): void {
  db.exec(INIT_SQL);
}

export function openDb(dataDir: string = env.dataDir): Db {
  const dbDir = path.join(dataDir, "db");
  fs.mkdirSync(dbDir, { recursive: true });
  const db = new DatabaseSync(path.join(dbDir, "testbed.sqlite3"));
  db.exec("PRAGMA journal_mode = WAL;");
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
