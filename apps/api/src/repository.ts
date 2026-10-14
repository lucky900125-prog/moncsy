import { randomUUID } from "node:crypto";
import type { Category, ReceiptItem, Summary, Transaction, TransactionSource } from "@et/shared";
import type { DB } from "./db.js";
import { HttpError, badRequest, notFound } from "./errors.js";
import type { CategoryCreate, CategoryPatch, TransactionCreate, TransactionPatch } from "./schemas.js";

interface CategoryRow {
  id: string;
  name: string;
  icon: string;
  color: string;
  is_custom: number;
  parent_id: string | null;
  budget: number | null;
}

interface TransactionRow {
  id: string;
  amount: number;
  currency: string;
  date: string;
  merchant: string;
  note: string | null;
  category_id: string | null;
  source: string;
  items: string | null;
  external_id: string | null;
}

export function toIso(date: string): string {
  const t = Date.parse(date);
  if (Number.isNaN(t)) throw badRequest(`Invalid date "${date}"`);
  return new Date(t).toISOString();
}

/** Date-only upper bounds ("2026-10-31") are inclusive of the whole day. */
export function rangeEnd(to: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) return toIso(`${to}T23:59:59.999Z`);
  return toIso(to);
}

const rowToCategory = (r: CategoryRow): Category => ({
  id: r.id,
  name: r.name,
  icon: r.icon,
  color: r.color,
  isCustom: r.is_custom === 1,
  parentId: r.parent_id,
  budget: r.budget,
});

const rowToTransaction = (r: TransactionRow): Transaction => {
  const tx: Transaction = {
    id: r.id,
    amount: r.amount,
    currency: r.currency,
    date: r.date,
    merchant: r.merchant,
    categoryId: r.category_id,
    source: r.source as TransactionSource,
    externalId: r.external_id,
  };
  if (r.note !== null) tx.note = r.note;
  if (r.items !== null) tx.items = JSON.parse(r.items) as ReceiptItem[];
  return tx;
};

export interface TransactionFilter {
  from?: string;
  to?: string;
  categoryId?: string;
  q?: string;
}

export class Repository {
  constructor(readonly db: DB) {}

  /** Runs fn with a repository bound to one write transaction. */
  withTx<T>(fn: (repo: Repository) => Promise<T>): Promise<T> {
    return this.db.tx((db) => fn(new Repository(db)));
  }

  // ---------- categories ----------

  async listCategories(): Promise<Category[]> {
    const rows = await this.db.all<CategoryRow>("SELECT * FROM categories ORDER BY sort, name");
    return rows.map(rowToCategory);
  }

  async getCategory(id: string): Promise<Category | null> {
    const row = await this.db.get<CategoryRow>("SELECT * FROM categories WHERE id = ?", [id]);
    return row ? rowToCategory(row) : null;
  }

  private async assertCategory(id: string | null | undefined, field = "categoryId"): Promise<void> {
    if (id != null && !(await this.getCategory(id))) throw badRequest(`${field}: unknown category "${id}"`);
  }

  async createCategory(input: CategoryCreate, opts: { id?: string; isCustom?: boolean } = {}): Promise<Category> {
    await this.assertCategory(input.parentId, "parentId");
    const id = opts.id ?? randomUUID();
    const sort = (await this.db.get<{ s: number }>("SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM categories"))!.s;
    await this.db.run(
      "INSERT INTO categories (id, name, icon, color, is_custom, parent_id, budget, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [id, input.name, input.icon, input.color, opts.isCustom === false ? 0 : 1, input.parentId ?? null, input.budget ?? null, sort],
    );
    return (await this.getCategory(id))!;
  }

  async updateCategory(id: string, patch: CategoryPatch): Promise<Category> {
    const cur = await this.getCategory(id);
    if (!cur) throw notFound(`Category "${id}" not found`);
    if (patch.parentId !== undefined) {
      if (patch.parentId === id) throw badRequest("parentId: a category cannot be its own parent");
      await this.assertCategory(patch.parentId, "parentId");
    }
    const next = { ...cur, ...stripUndefined(patch) };
    await this.db.run("UPDATE categories SET name = ?, icon = ?, color = ?, parent_id = ?, budget = ? WHERE id = ?", [
      next.name,
      next.icon,
      next.color,
      next.parentId ?? null,
      next.budget ?? null,
      id,
    ]);
    return (await this.getCategory(id))!;
  }

  async deleteCategory(id: string): Promise<void> {
    const cur = await this.getCategory(id);
    if (!cur) throw notFound(`Category "${id}" not found`);
    if (!cur.isCustom) throw new HttpError(409, `Category "${cur.name}" is built in and cannot be deleted`);
    await this.db.tx(async (db) => {
      await db.run("UPDATE transactions SET category_id = NULL WHERE category_id = ?", [id]);
      await db.run("UPDATE categories SET parent_id = NULL WHERE parent_id = ?", [id]);
      await db.run("DELETE FROM categories WHERE id = ?", [id]);
    });
  }

  // ---------- transactions ----------

  async listTransactions(f: TransactionFilter = {}): Promise<Transaction[]> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (f.from) {
      where.push("date >= ?");
      params.push(toIso(f.from));
    }
    if (f.to) {
      where.push("date <= ?");
      params.push(rangeEnd(f.to));
    }
    if (f.categoryId) {
      if (f.categoryId === "none" || f.categoryId === "null") where.push("category_id IS NULL");
      else {
        where.push("category_id = ?");
        params.push(f.categoryId);
      }
    }
    const sql = `SELECT * FROM transactions ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY date DESC, id`;
    let rows = await this.db.all<TransactionRow>(sql, params);
    if (f.q && f.q.trim()) {
      // SQLite's LOWER() is ASCII-only, so match case-insensitively in JS for Hungarian accents.
      const needle = f.q.trim().toLocaleLowerCase("hu");
      rows = rows.filter((r) => `${r.merchant}\n${r.note ?? ""}`.toLocaleLowerCase("hu").includes(needle));
    }
    return rows.map(rowToTransaction);
  }

  async getTransaction(id: string): Promise<Transaction | null> {
    const row = await this.db.get<TransactionRow>("SELECT * FROM transactions WHERE id = ?", [id]);
    return row ? rowToTransaction(row) : null;
  }

  async hasExternalId(externalId: string): Promise<boolean> {
    return !!(await this.db.get("SELECT 1 FROM transactions WHERE external_id = ?", [externalId]));
  }

  async createTransaction(input: TransactionCreate, opts: { id?: string } = {}): Promise<Transaction> {
    await this.assertCategory(input.categoryId);
    if (input.externalId && (await this.hasExternalId(input.externalId))) {
      throw new HttpError(409, `A transaction with externalId "${input.externalId}" already exists`);
    }
    const id = opts.id ?? randomUUID();
    await this.db.run(
      `INSERT INTO transactions (id, amount, currency, date, merchant, note, category_id, source, items, external_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.amount,
        input.currency.toUpperCase(),
        toIso(input.date),
        input.merchant,
        input.note || null, // empty note == no note
        input.categoryId ?? null,
        input.source ?? "manual",
        input.items ? JSON.stringify(input.items) : null,
        input.externalId ?? null,
      ],
    );
    return (await this.getTransaction(id))!;
  }

  async updateTransaction(id: string, patch: TransactionPatch): Promise<Transaction> {
    const cur = await this.getTransaction(id);
    if (!cur) throw notFound(`Transaction "${id}" not found`);
    if (patch.categoryId !== undefined) await this.assertCategory(patch.categoryId);
    if (patch.externalId && patch.externalId !== cur.externalId && (await this.hasExternalId(patch.externalId))) {
      throw new HttpError(409, `A transaction with externalId "${patch.externalId}" already exists`);
    }
    const p = stripUndefined(patch);
    const note = "note" in p ? p.note : cur.note ?? null;
    const items = "items" in p ? p.items : cur.items ?? null;
    await this.db.run(
      `UPDATE transactions SET amount = ?, currency = ?, date = ?, merchant = ?, note = ?, category_id = ?, source = ?, items = ?, external_id = ?
       WHERE id = ?`,
      [
        p.amount ?? cur.amount,
        (p.currency ?? cur.currency).toUpperCase(),
        p.date ? toIso(p.date) : cur.date,
        p.merchant ?? cur.merchant,
        note || null,
        "categoryId" in p ? (p.categoryId ?? null) : cur.categoryId,
        p.source ?? cur.source,
        items ? JSON.stringify(items) : null,
        "externalId" in p ? (p.externalId ?? null) : (cur.externalId ?? null),
        id,
      ],
    );
    return (await this.getTransaction(id))!;
  }

  async deleteTransaction(id: string): Promise<void> {
    const r = await this.db.run("DELETE FROM transactions WHERE id = ?", [id]);
    if (r.changes === 0) throw notFound(`Transaction "${id}" not found`);
  }

  // ---------- summary ----------

  /**
   * Totals for one currency (amounts in different currencies are never added together).
   * Currency: explicit param, else the most frequent currency in the range, else the default.
   * income / expense are non-negative magnitudes; byCategory[].total is the signed sum
   * (negative for spending), sorted by largest spend first.
   */
  async summary(from: string, to: string, currency: string | undefined, defaultCurrency: string): Promise<Summary> {
    const lo = toIso(from);
    const hi = rangeEnd(to);
    let cur = currency?.toUpperCase();
    if (!cur) {
      const top = await this.db.get<{ currency: string }>(
        "SELECT currency, COUNT(*) AS n FROM transactions WHERE date >= ? AND date <= ? GROUP BY currency ORDER BY n DESC, currency LIMIT 1",
        [lo, hi],
      );
      cur = top?.currency ?? defaultCurrency;
    }
    const totals = (await this.db.get<{ income: number; expense: number }>(
      `SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount END), 0) AS income,
              COALESCE(SUM(CASE WHEN amount < 0 THEN -amount END), 0) AS expense
       FROM transactions WHERE date >= ? AND date <= ? AND currency = ?`,
      [lo, hi, cur],
    ))!;
    const byCategory = await this.db.all<{ categoryId: string | null; total: number; count: number }>(
      `SELECT category_id AS categoryId, SUM(amount) AS total, COUNT(*) AS count
       FROM transactions WHERE date >= ? AND date <= ? AND currency = ?
       GROUP BY category_id ORDER BY total ASC`,
      [lo, hi, cur],
    );
    return {
      from: lo,
      to: hi,
      currency: cur,
      income: round2(totals.income),
      expense: round2(totals.expense),
      byCategory: byCategory.map((c) => ({ categoryId: c.categoryId, total: round2(c.total), count: Number(c.count) })),
    };
  }
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
