import { describe, expect, it } from "vitest";
import { createInMemoryDb, withTransaction } from "../../src/persistence/db.js";

describe("db", () => {
  it("creates the testbed schema", () => {
    const db = createInMemoryDb();
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{ name: string }>)
      .map((r) => r.name)
      .filter((name) => !name.startsWith("sqlite_"));
    expect(tables).toEqual(["batches", "debrief_sessions", "events", "experiments", "interaction_events", "scenarios"]);
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
});
