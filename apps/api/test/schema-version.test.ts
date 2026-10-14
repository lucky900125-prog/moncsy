import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, getMeta, migrate, openDb, type DB } from "../src/db.js";

let dirs: string[] = [];
const tempDb = () => {
  const d = mkdtempSync(join(tmpdir(), "moncsy-schema-"));
  dirs.push(d);
  return join(d, "expense.db");
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const tables = async (db: DB) => (await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).map((t) => t.name);

describe("schema version", () => {
  it("records the version of a new database", async () => {
    const db = await openDb(":memory:");
    expect(await getMeta(db, "schema_version")).toBe(String(MIGRATIONS.length));
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it("takes over a database made before versioning, with its data", async () => {
    const path = tempDb();
    // The schema every database had before versioning, with one row in it.
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL, color TEXT NOT NULL,
        is_custom INTEGER NOT NULL DEFAULT 0, parent_id TEXT REFERENCES categories(id) ON DELETE SET NULL, budget REAL, sort INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE transactions (id TEXT PRIMARY KEY, amount REAL NOT NULL, currency TEXT NOT NULL, date TEXT NOT NULL, merchant TEXT NOT NULL,
        note TEXT, category_id TEXT REFERENCES categories(id) ON DELETE SET NULL, source TEXT NOT NULL, items TEXT, external_id TEXT UNIQUE);
      CREATE INDEX idx_tx_date ON transactions(date);
      CREATE INDEX idx_tx_category ON transactions(category_id);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('backup_generation', '7');
      INSERT INTO transactions VALUES ('t1', -4785, 'HUF', '2026-10-12T10:00:00.000Z', 'Spar', NULL, NULL, 'manual', NULL, NULL);
    `);
    old.close();

    const db = await openDb(path);
    expect(await getMeta(db, "schema_version")).toBe(String(MIGRATIONS.length));
    expect(await getMeta(db, "backup_generation")).toBe("7");
    expect(await db.all("SELECT id, merchant FROM transactions")).toEqual([{ id: "t1", merchant: "Spar" }]);
    db.close();
  });

  it("refuses a database written by a newer version, and leaves it as it is", async () => {
    const path = tempDb();
    const db = await openDb(path);
    await db.run("UPDATE meta SET value = ? WHERE key = 'schema_version'", [String(MIGRATIONS.length + 5)]);
    db.close();
    await expect(openDb(path)).rejects.toThrow(
      new RegExp(`^Could not open the database at .*: it has schema version ${MIGRATIONS.length + 5}, but this server knows only up to ${MIGRATIONS.length}`),
    );
    const raw = new DatabaseSync(path, { readOnly: true });
    expect(raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: String(MIGRATIONS.length + 5) });
    raw.close();
  });

  it("refuses a schema version that is not a whole number", async () => {
    const path = tempDb();
    const db = await openDb(path);
    await db.run("UPDATE meta SET value = 'abc' WHERE key = 'schema_version'");
    db.close();
    await expect(openDb(path)).rejects.toThrow(/schema_version "abc"/);
  });

  it("applies each migration once, in order, and keeps a failed one from counting or leaving anything", async () => {
    const db = await openDb(":memory:");
    const base = MIGRATIONS.length;
    const ran: string[] = [];
    const next = async (t: DB) => {
      ran.push("next");
      await t.exec("CREATE TABLE extra (x)");
    };
    const failing = async (t: DB) => {
      ran.push("failing");
      await t.exec("CREATE TABLE half (x)");
      throw new Error("migration failed");
    };

    await expect(migrate(db, [...MIGRATIONS, next, failing])).rejects.toThrow(/migration failed/);
    expect(ran).toEqual(["next", "failing"]);
    expect(await getMeta(db, "schema_version")).toBe(String(base + 1));
    expect(await tables(db)).toContain("extra");
    expect(await tables(db)).not.toContain("half");

    ran.length = 0;
    await migrate(db, [...MIGRATIONS, next, async () => void ran.push("fixed")]);
    expect(ran).toEqual(["fixed"]);
    expect(await getMeta(db, "schema_version")).toBe(String(base + 2));

    ran.length = 0;
    await migrate(db, [...MIGRATIONS, next, async () => void ran.push("again")]);
    expect(ran).toEqual([]);
    db.close();
  });
});
