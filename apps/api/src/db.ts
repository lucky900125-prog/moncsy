import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type SqlArgs = SQLInputValue[];

/**
 * The storage the repository talks to. It is asynchronous so that a hosted engine can be plugged in
 * later without touching the callers; the only implementation today is a local SQLite file.
 */
export interface DB {
  all<T>(sql: string, args?: SqlArgs): Promise<T[]>;
  get<T>(sql: string, args?: SqlArgs): Promise<T | undefined>;
  run(sql: string, args?: SqlArgs): Promise<{ changes: number }>;
  exec(sql: string): Promise<void>;
  /** Runs fn inside one write transaction; nested calls join the outer one. */
  tx<T>(fn: (db: DB) => Promise<T>): Promise<T>;
  close(): void;
}

/**
 * node:sqlite (built into Node 22) rather than better-sqlite3: pnpm 10 blocks dependency build scripts
 * unless they are allow-listed in the workspace root config, so better-sqlite3's native binary is never built.
 *
 * One connection serves every request. While a transaction is open, queries from other requests wait
 * for it to finish instead of running inside it.
 */
class SqliteDb implements DB {
  private queue: Promise<unknown> = Promise.resolve();
  private active: Promise<unknown> | null = null;

  constructor(private readonly db: DatabaseSync) {}

  private async idle(): Promise<void> {
    while (this.active) await this.active.catch(() => undefined);
  }

  private bound(): DB {
    const self = this;
    const direct: DB = {
      all: async <T>(sql: string, args: SqlArgs = []) => self.db.prepare(sql).all(...args) as T[],
      get: async <T>(sql: string, args: SqlArgs = []) => self.db.prepare(sql).get(...args) as T | undefined,
      run: async (sql: string, args: SqlArgs = []) => ({ changes: Number(self.db.prepare(sql).run(...args).changes) }),
      exec: async (sql: string) => void self.db.exec(sql),
      tx: (fn) => fn(direct),
      close: () => self.close(),
    };
    return direct;
  }

  async all<T>(sql: string, args: SqlArgs = []): Promise<T[]> {
    await this.idle();
    return this.db.prepare(sql).all(...args) as T[];
  }

  async get<T>(sql: string, args: SqlArgs = []): Promise<T | undefined> {
    await this.idle();
    return this.db.prepare(sql).get(...args) as T | undefined;
  }

  async run(sql: string, args: SqlArgs = []): Promise<{ changes: number }> {
    await this.idle();
    return { changes: Number(this.db.prepare(sql).run(...args).changes) };
  }

  async exec(sql: string): Promise<void> {
    await this.idle();
    this.db.exec(sql);
  }

  tx<T>(fn: (db: DB) => Promise<T>): Promise<T> {
    const run = async () => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const out = await fn(this.bound());
        this.db.exec("COMMIT");
        return out;
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    };
    // Transactions run one at a time, in arrival order.
    const p = this.queue.then(() => {
      const t = run();
      this.active = t;
      return t.finally(() => {
        if (this.active === t) this.active = null;
      });
    });
    this.queue = p.catch(() => undefined);
    return p;
  }

  close(): void {
    this.db.close();
  }
}

export async function openDb(path: string): Promise<DB> {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const db = new SqliteDb(raw);
  await migrate(db);
  await seedCategories(db);
  return db;
}

async function migrate(db: DB): Promise<void> {
  await db.exec(`
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

async function seedCategories(db: DB): Promise<void> {
  if (await db.get("SELECT value FROM meta WHERE key = 'seeded'")) return;
  await db.tx(async (t) => {
    for (const [i, c] of DEFAULT_CATEGORIES.entries()) {
      await t.run(
        "INSERT OR IGNORE INTO categories (id, name, icon, color, is_custom, parent_id, budget, sort) VALUES (?, ?, ?, ?, 0, NULL, NULL, ?)",
        [c.id, c.name, c.icon, c.color, i],
      );
    }
    await t.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('seeded', ?)", [new Date().toISOString()]);
  });
}

export async function getMeta(db: DB, key: string): Promise<string | null> {
  const row = await db.get<{ value: string | null }>("SELECT value FROM meta WHERE key = ?", [key]);
  return row?.value ?? null;
}

export async function setMeta(db: DB, key: string, value: string): Promise<void> {
  await db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
}
