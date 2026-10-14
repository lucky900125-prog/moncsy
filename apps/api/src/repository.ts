import { randomUUID } from "node:crypto";
import type { Category, ReceiptItem, Summary, Transaction, TransactionSource } from "@et/shared";
import { transaction, type DB } from "./db.js";
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

  // ---------- categories ----------

  listCategories(): Category[] {
    const rows = this.db.prepare("SELECT * FROM categories ORDER BY sort, name").all() as unknown as CategoryRow[];
    return rows.map(rowToCategory);
  }

  getCategory(id: string): Category | null {
    const row = this.db.prepare("SELECT * FROM categories WHERE id = ?").get(id) as CategoryRow | undefined;
    return row ? rowToCategory(row) : null;
  }

  private assertCategory(id: string | null | undefined, field = "categoryId"): void {
    if (id != null && !this.getCategory(id)) throw badRequest(`${field}: unknown category "${id}"`);
  }

  createCategory(input: CategoryCreate, opts: { id?: string; isCustom?: boolean } = {}): Category {
    this.assertCategory(input.parentId, "parentId");
    const id = opts.id ?? randomUUID();
    const sort = (this.db.prepare("SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM categories").get() as { s: number }).s;
    this.db
      .prepare(
        "INSERT INTO categories (id, name, icon, color, is_custom, parent_id, budget, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.name, input.icon, input.color, opts.isCustom === false ? 0 : 1, input.parentId ?? null, input.budget ?? null, sort);
    return this.getCategory(id)!;
  }

  updateCategory(id: string, patch: CategoryPatch): Category {
    const cur = this.getCategory(id);
    if (!cur) throw notFound(`Category "${id}" not found`);
    if (patch.parentId !== undefined) {
      if (patch.parentId === id) throw badRequest("parentId: a category cannot be its own parent");
      this.assertCategory(patch.parentId, "parentId");
    }
    const next = { ...cur, ...stripUndefined(patch) };
    this.db
      .prepare("UPDATE categories SET name = ?, icon = ?, color = ?, parent_id = ?, budget = ? WHERE id = ?")
      .run(next.name, next.icon, next.color, next.parentId ?? null, next.budget ?? null, id);
    return this.getCategory(id)!;
  }

  deleteCategory(id: string): void {
    const cur = this.getCategory(id);
    if (!cur) throw notFound(`Category "${id}" not found`);
    if (!cur.isCustom) throw new HttpError(409, `Category "${cur.name}" is built in and cannot be deleted`);
    transaction(this.db, () => {
      this.db.prepare("UPDATE transactions SET category_id = NULL WHERE category_id = ?").run(id);
      this.db.prepare("UPDATE categories SET parent_id = NULL WHERE parent_id = ?").run(id);
      this.db.prepare("DELETE FROM categories WHERE id = ?").run(id);
    });
  }

  // ---------- transactions ----------

  listTransactions(f: TransactionFilter = {}): Transaction[] {
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
    let rows = this.db.prepare(sql).all(...params) as unknown as TransactionRow[];
    if (f.q && f.q.trim()) {
      // SQLite's LOWER() is ASCII-only, so match case-insensitively in JS for Hungarian accents.
      const needle = f.q.trim().toLocaleLowerCase("hu");
      rows = rows.filter((r) => `${r.merchant}\n${r.note ?? ""}`.toLocaleLowerCase("hu").includes(needle));
    }
    return rows.map(rowToTransaction);
  }

  getTransaction(id: string): Transaction | null {
    const row = this.db.prepare("SELECT * FROM transactions WHERE id = ?").get(id) as TransactionRow | undefined;
    return row ? rowToTransaction(row) : null;
  }

  hasExternalId(externalId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM transactions WHERE external_id = ?").get(externalId);
  }

  createTransaction(input: TransactionCreate, opts: { id?: string } = {}): Transaction {
    this.assertCategory(input.categoryId);
    if (input.externalId && this.hasExternalId(input.externalId)) {
      throw new HttpError(409, `A transaction with externalId "${input.externalId}" already exists`);
    }
    const id = opts.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO transactions (id, amount, currency, date, merchant, note, category_id, source, items, external_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
      );
    return this.getTransaction(id)!;
  }

  updateTransaction(id: string, patch: TransactionPatch): Transaction {
    const cur = this.getTransaction(id);
    if (!cur) throw notFound(`Transaction "${id}" not found`);
    if (patch.categoryId !== undefined) this.assertCategory(patch.categoryId);
    if (patch.externalId && patch.externalId !== cur.externalId && this.hasExternalId(patch.externalId)) {
      throw new HttpError(409, `A transaction with externalId "${patch.externalId}" already exists`);
    }
    const p = stripUndefined(patch);
    const note = "note" in p ? p.note : cur.note ?? null;
    const items = "items" in p ? p.items : cur.items ?? null;
    this.db
      .prepare(
        `UPDATE transactions SET amount = ?, currency = ?, date = ?, merchant = ?, note = ?, category_id = ?, source = ?, items = ?, external_id = ?
         WHERE id = ?`,
      )
      .run(
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
      );
    return this.getTransaction(id)!;
  }

  deleteTransaction(id: string): void {
    const r = this.db.prepare("DELETE FROM transactions WHERE id = ?").run(id);
    if (Number(r.changes) === 0) throw notFound(`Transaction "${id}" not found`);
  }

  // ---------- summary ----------

  /**
   * Totals for one currency (amounts in different currencies are never added together).
   * Currency: explicit param, else the most frequent currency in the range, else the default.
   * income / expense are non-negative magnitudes; byCategory[].total is the signed sum
   * (negative for spending), sorted by largest spend first.
   */
  summary(from: string, to: string, currency: string | undefined, defaultCurrency: string): Summary {
    const lo = toIso(from);
    const hi = rangeEnd(to);
    let cur = currency?.toUpperCase();
    if (!cur) {
      const top = this.db
        .prepare(
          "SELECT currency, COUNT(*) AS n FROM transactions WHERE date >= ? AND date <= ? GROUP BY currency ORDER BY n DESC, currency LIMIT 1",
        )
        .get(lo, hi) as { currency: string } | undefined;
      cur = top?.currency ?? defaultCurrency;
    }
    const totals = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount END), 0) AS income,
                COALESCE(SUM(CASE WHEN amount < 0 THEN -amount END), 0) AS expense
         FROM transactions WHERE date >= ? AND date <= ? AND currency = ?`,
      )
      .get(lo, hi, cur) as { income: number; expense: number };
    const byCategory = this.db
      .prepare(
        `SELECT category_id AS categoryId, SUM(amount) AS total, COUNT(*) AS count
         FROM transactions WHERE date >= ? AND date <= ? AND currency = ?
         GROUP BY category_id ORDER BY total ASC`,
      )
      .all(lo, hi, cur) as unknown as { categoryId: string | null; total: number; count: number }[];
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
