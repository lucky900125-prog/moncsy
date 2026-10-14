import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_CATEGORIES } from "@et/shared";

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
  /** the failure after which SQLite ended the open transaction by itself */
  private aborted: Error | null = null;

  constructor(private readonly db: DatabaseSync) {}

  /** Runs f once no transaction is open. The last check and f run in the same turn, so no transaction can begin in between. */
  private async whenIdle<T>(f: () => T): Promise<T> {
    while (this.active) await this.active.catch(() => undefined);
    return f();
  }

  /** Inside tx(): after disk full, an I/O error or out of memory SQLite ends the transaction itself, and a later statement must not autocommit. */
  private inTx<T>(f: (db: DatabaseSync) => T): T {
    if (!this.db.isTransaction) {
      throw new Error(`the transaction was rolled back by SQLite after an earlier error: ${this.aborted?.message ?? "unknown"}`, { cause: this.aborted ?? undefined });
    }
    try {
      return f(this.db);
    } catch (e) {
      if (!this.db.isTransaction) this.aborted ??= e as Error;
      throw e;
    }
  }

  private bound(): DB {
    const self = this;
    const direct: DB = {
      all: async <T>(sql: string, args: SqlArgs = []) => self.inTx((d) => d.prepare(sql).all(...args) as T[]),
      get: async <T>(sql: string, args: SqlArgs = []) => self.inTx((d) => d.prepare(sql).get(...args) as T | undefined),
      run: async (sql: string, args: SqlArgs = []) => self.inTx((d) => ({ changes: Number(d.prepare(sql).run(...args).changes) })),
      exec: async (sql: string) => self.inTx((d) => void d.exec(sql)),
      tx: (fn) => fn(direct),
      close: () => self.close(),
    };
    return direct;
  }

  all<T>(sql: string, args: SqlArgs = []): Promise<T[]> {
    return this.whenIdle(() => this.db.prepare(sql).all(...args) as T[]);
  }

  get<T>(sql: string, args: SqlArgs = []): Promise<T | undefined> {
    return this.whenIdle(() => this.db.prepare(sql).get(...args) as T | undefined);
  }

  run(sql: string, args: SqlArgs = []): Promise<{ changes: number }> {
    return this.whenIdle(() => ({ changes: Number(this.db.prepare(sql).run(...args).changes) }));
  }

  exec(sql: string): Promise<void> {
    return this.whenIdle(() => void this.db.exec(sql));
  }

  tx<T>(fn: (db: DB) => Promise<T>): Promise<T> {
    const run = async () => {
      this.db.exec("BEGIN IMMEDIATE");
      this.aborted = null;
      try {
        const out = await fn(this.bound());
        this.inTx((d) => d.exec("COMMIT"));
        return out;
      } catch (e) {
        // If SQLite has already rolled back, ROLLBACK would throw and hide e.
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
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

/** Idempotent: inserts any default category that is missing; rows the user has edited are left alone. */
async function seedCategories(db: DB): Promise<void> {
  await db.tx(async (t) => {
    for (const [i, c] of DEFAULT_CATEGORIES.entries()) {
      await t.run(
        "INSERT OR IGNORE INTO categories (id, name, icon, color, is_custom, parent_id, budget, sort) VALUES (?, ?, ?, ?, 0, NULL, NULL, ?)",
        [c.id, c.name, c.icon, c.color, i],
      );
    }
  });
}

export async function getMeta(db: DB, key: string): Promise<string | null> {
  const row = await db.get<{ value: string | null }>("SELECT value FROM meta WHERE key = ?", [key]);
  return row?.value ?? null;
}

export async function setMeta(db: DB, key: string, value: string): Promise<void> {
  await db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
}
