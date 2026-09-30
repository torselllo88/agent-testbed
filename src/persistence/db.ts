import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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
  // Which process owns a live row (see processOwnerId); recovery only touches rows whose owner is gone.
  db.exec(`CREATE TABLE IF NOT EXISTS process_leases (owner_id TEXT PRIMARY KEY, pid INTEGER, heartbeat_at TEXT NOT NULL)`);
  ensureColumn(db, "process_leases", "host", "host TEXT");
  ensureColumn(db, "experiments", "owner_id", "owner_id TEXT");
  ensureColumn(db, "batches", "owner_id", "owner_id TEXT");
  db.exec(INTERACTION_SQL);
  ensureColumn(db, "debrief_sessions", "owner_id", "owner_id TEXT");
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
 * Process leases: which process owns a live run, batch or debrief session.
 * Each process that writes such rows gets a random owner id (pid numbers are
 * reused, aggressively so on Windows) and refreshes a heartbeat. Recovery only
 * touches rows whose owner is gone — so a server started next to a running CLI
 * batch on the same database leaves it alone.
 *
 * Invariant: recovery prefers leaving a dead owner's rows open a little longer
 * over interrupting an owner that may still be alive (which would also collide
 * with its next trace write). An owner is gone when
 *  - it ran on this host and its pid no longer exists (a crash or restart is
 *    recovered at once), or
 *  - its heartbeat has been seen standing still for a whole lease, measured on
 *    THIS process's monotonic clock — a wall-clock jump or a machine waking from
 *    sleep cannot make a live owner look dead (see forgetLeaseObservations).
 */
const HEARTBEAT_MS = 15_000;
export const LEASE_TTL_MS = 60_000;
const HOST = os.hostname();
const ownerIds = new WeakMap<Db, string>();
/** Per owner: the heartbeat last seen, and since when (monotonic ms) it has not moved. */
const observations = new WeakMap<Db, Map<string, { heartbeatAt: string; since: number }>>();
const leaseClocks = new WeakMap<Db, () => number>();

/** This process's owner id for rows it creates in this database (starts its heartbeat on first use). */
export function processOwnerId(db: Db): string {
  let id = ownerIds.get(db);
  if (id) return id;
  const ownerId = `proc_${randomUUID()}`;
  ownerIds.set(db, ownerId);
  const beat = () => {
    try {
      db.prepare(
        `INSERT INTO process_leases (owner_id, pid, host, heartbeat_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(owner_id) DO UPDATE SET heartbeat_at = excluded.heartbeat_at`
      ).run(ownerId, process.pid, HOST, new Date().toISOString());
    } catch {
      // database closed or busy — the next beat retries; a lease tolerates three missed beats
    }
  };
  beat();
  setInterval(beat, HEARTBEAT_MS).unref();
  return ownerId;
}

/** Whether a process with this pid exists. EPERM means it does (someone else's); only ESRCH means gone. */
function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Whether ANOTHER process that may still be alive owns a row. null / unknown
 * owners count as gone. This process's own rows are handled by the caller's
 * in-memory maps (live ones are skipped there), so here they count as gone.
 */
export function ownerAlive(db: Db, ownerId: string | null): boolean {
  if (!ownerId || ownerId === ownerIds.get(db)) return false;
  const row = db.prepare(`SELECT pid, host, heartbeat_at FROM process_leases WHERE owner_id = ?`).get(ownerId) as
    | { pid: number | null; host: string | null; heartbeat_at: string }
    | undefined;
  if (!row) return false;
  if (row.host === HOST && row.pid !== null && !pidExists(row.pid)) return false;
  const now = (leaseClocks.get(db) ?? performance.now)();
  let seen = observations.get(db);
  if (!seen) observations.set(db, (seen = new Map()));
  const last = seen.get(ownerId);
  if (!last || last.heartbeatAt !== row.heartbeat_at) {
    seen.set(ownerId, { heartbeatAt: row.heartbeat_at, since: now });
    return true;
  }
  return now - last.since < LEASE_TTL_MS;
}

/**
 * After this process itself was suspended (its timers ran late), what it saw
 * before says nothing about the others: start observing their heartbeats
 * afresh, so they get a whole lease to beat again.
 */
export function forgetLeaseObservations(db: Db): void {
  observations.delete(db);
}

/** Test-only: the monotonic clock ownerAlive measures a standing heartbeat with. */
export function setLeaseClockForTests(db: Db, clock: () => number): void {
  leaseClocks.set(db, clock);
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
