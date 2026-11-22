import { describe, expect, it } from "vitest";
import { ownerAlive, createInMemoryDb, withTransaction } from "../../src/persistence/db.js";

describe("db", () => {
  it("creates the testbed schema", () => {
    const db = createInMemoryDb();
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{ name: string }>)
      .map((r) => r.name)
      .filter((name) => !name.startsWith("sqlite_"));
    expect(tables).toEqual(["batches", "debrief_sessions", "events", "experiments", "exposure_annotations", "exposure_detections", "exposure_samples", "interaction_events", "pilot_live_sessions", "process_leases", "room_bindings", "room_inbound", "room_outbox", "scenarios"]);
  });

  it("rolls back a failed transaction", () => {
    const db = createInMemoryDb();
    const now = new Date().toISOString();
    expect(() =>
      withTransaction(db, () => {
        db.prepare(
          `INSERT INTO scenarios (id, name, version, config_json, config_hash, created_at, updated_at) VALUES (?, ?, 1, '{}', 'h', ?, ?)`
        ).run("s1", "demo", now, now);
        throw new Error("abort");
      })
    ).toThrow("abort");
    expect(db.prepare(`SELECT COUNT(*) AS n FROM scenarios`).get()).toEqual({ n: 0 });
  });
  it("sees another live process's lease with the default clock (a second process on the same database, e.g. the GUI next to the pair runner)", () => {
    const db = createInMemoryDb();
    // Another host, current heartbeat: liveness is judged by the heartbeat standing still for the lease TTL, measured with the process clock.
    db.prepare("INSERT INTO process_leases (owner_id, pid, host, heartbeat_at) VALUES (?, ?, ?, ?)").run("proc_other", null, "other-host", new Date().toISOString());
    expect(ownerAlive(db, "proc_other")).toBe(true);
    expect(ownerAlive(db, "proc_other")).toBe(true);
    expect(ownerAlive(db, null)).toBe(false);
    expect(ownerAlive(db, "proc_unknown")).toBe(false);
  });
});
