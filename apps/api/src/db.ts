import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = DatabaseSync;

/**
 * Persistence uses node:sqlite (built into Node 22) rather than better-sqlite3:
 * pnpm 10 blocks dependency build scripts unless they are allow-listed in the
 * workspace root config, so better-sqlite3's native binary is never built.
 */
export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(db);
  seedCategories(db);
  return db;
}

function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      icon       TEXT NOT NULL,
      color      TEXT NOT NULL,
      is_custom  INTEGER NOT NULL DEFAULT 0,
      parent_id  TEXT REFERENCES categories(id) ON DELETE SET NULL,
      budget     REAL,
      sort       INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id          TEXT PRIMARY KEY,
      amount      REAL NOT NULL,
      currency    TEXT NOT NULL,
      date        TEXT NOT NULL,
      merchant    TEXT NOT NULL,
      note        TEXT,
      category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
      source      TEXT NOT NULL,
      items       TEXT,
      external_id TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
    CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(category_id);
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

export const DEFAULT_CATEGORIES = [
  { id: "groceries", name: "Élelmiszer", icon: "shopping-cart", color: "#7c9a7e" },
  { id: "restaurant", name: "Étterem", icon: "utensils", color: "#c08b6a" },
  { id: "transport", name: "Közlekedés", icon: "bus", color: "#6f8fa8" },
  { id: "housing", name: "Lakhatás", icon: "home", color: "#9a8577" },
  { id: "utilities", name: "Rezsi", icon: "zap", color: "#c2a65f" },
  { id: "entertainment", name: "Szórakozás", icon: "film", color: "#a07fa3" },
  { id: "health", name: "Egészség", icon: "heart-pulse", color: "#c47f86" },
  { id: "clothing", name: "Ruházat", icon: "shirt", color: "#8c8fb3" },
  { id: "travel", name: "Utazás", icon: "plane", color: "#5f9c9a" },
  { id: "subscriptions", name: "Előfizetések", icon: "repeat", color: "#8a9bb0" },
  { id: "other", name: "Egyéb", icon: "circle-ellipsis", color: "#9e9e94" },
  { id: "income", name: "Bevétel", icon: "wallet", color: "#6e9f72" },
] as const;

export type DefaultCategoryId = (typeof DEFAULT_CATEGORIES)[number]["id"];

function seedCategories(db: DB): void {
  const done = db.prepare("SELECT value FROM meta WHERE key = 'seeded'").get();
  if (done) return;
  const insert = db.prepare(
    "INSERT OR IGNORE INTO categories (id, name, icon, color, is_custom, parent_id, budget, sort) VALUES (?, ?, ?, ?, 0, NULL, NULL, ?)",
  );
  db.exec("BEGIN");
  try {
    DEFAULT_CATEGORIES.forEach((c, i) => insert.run(c.id, c.name, c.icon, c.color, i));
    db.prepare("INSERT INTO meta (key, value) VALUES ('seeded', ?)").run(new Date().toISOString());
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function getMeta(db: DB, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string | null } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function transaction<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
