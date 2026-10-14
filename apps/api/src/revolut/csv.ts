import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import type { RevolutStatus } from "@et/shared";
import { getMeta, setMeta } from "../db.js";
import { badRequest } from "../errors.js";
import { decodeText, detectDelimiter } from "../io/text.js";
import type { Repository } from "../repository.js";
import { categorize } from "./categorize.js";
import { busiestSheet, cellValue, readWorkbook, type SheetCell } from "../io/xlsx.js";
import { META_CSV_ACCOUNTS, META_LAST_SYNC, type RevolutProvider } from "./types.js";

/** One row of the Revolut app's "Account statement" export (Excel or CSV). */
export interface StatementRow {
  type: string;
  product: string;
  startedDate: string;
  completedDate: string | null;
  description: string;
  amount: number;
  fee: number;
  currency: string;
  state: string;
  balance: number | null;
}

export interface ParsedStatementTx {
  externalId: string;
  date: string;
  amount: number;
  currency: string;
  merchant: string;
  note?: string;
  categoryId: string | null;
  row: StatementRow;
}

const HEADER_ALIASES: Record<keyof StatementRow, string[]> = {
  type: ["type"],
  product: ["product"],
  startedDate: ["started date", "started_date"],
  completedDate: ["completed date", "completed_date"],
  description: ["description"],
  amount: ["amount"],
  fee: ["fee"],
  currency: ["currency"],
  state: ["state"],
  balance: ["balance"],
};

/** One formatter per time zone: building one costs far more than using it, and a statement converts every row. */
const tzFormats = new Map<string, Intl.DateTimeFormat>();

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function tzOffset(utcMs: number, timeZone: string): number {
  let format = tzFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    tzFormats.set(timeZone, format);
  }
  const parts = format.formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - utcMs;
}

/** Converts a wall-clock time in `timeZone` to a UTC instant (DST-aware). */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, timeZone: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = guess - tzOffset(guess, timeZone);
  t = guess - tzOffset(t, timeZone);
  return new Date(t);
}

/**
 * Revolut writes local wall-clock time without an offset ("2026-10-01 08:15:42").
 * It is interpreted in STATEMENT_TZ (default Europe/Budapest) and stored as UTC.
 * Excel Date cells carry the same wall-clock time encoded as UTC, so they are re-interpreted too.
 * A statement opened in a Hungarian Excel and saved again as CSV has "2026. 10. 01. 8:15" instead.
 */
export function revolutDate(v: unknown, timeZone = process.env.STATEMENT_TZ || "Europe/Budapest"): string {
  if (v instanceof Date) {
    return zonedToUtc(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate(), v.getUTCHours(), v.getUTCMinutes(), v.getUTCSeconds(), timeZone).toISOString();
  }
  const s = String(v ?? "").trim();
  const m = s.match(/^(\d{4})(?:-|\. ?)(\d{1,2})(?:-|\. ?)(\d{1,2})\.?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const [, y, mo, d, h = "0", mi = "0", sec = "0"] = m;
    return zonedToUtc(+y!, +mo!, +d!, +h, +mi, +sec, timeZone).toISOString();
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`invalid date "${s}"`);
  return new Date(t).toISOString();
}

function toNum(v: unknown, field: string, required: boolean): number | null {
  if (v === null || v === undefined || String(v).trim() === "") {
    if (required) throw new Error(`missing ${field}`);
    return null;
  }
  if (typeof v === "number") return v;
  const n = Number(String(v).replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(n)) throw new Error(`invalid ${field} "${String(v)}"`);
  return n;
}

/** Validates the header first, so an empty statement is told apart from a file that is not a statement at all. */
function normalizeRecords(records: Record<string, unknown>[], keys: string[]): { rows: StatementRow[]; errors: string[] } {
  const find = (field: keyof StatementRow) => keys.find((k) => HEADER_ALIASES[field].includes(k.trim().toLowerCase()));
  const col = Object.fromEntries((Object.keys(HEADER_ALIASES) as (keyof StatementRow)[]).map((f) => [f, find(f)])) as Record<
    keyof StatementRow,
    string | undefined
  >;
  const missing = (["startedDate", "description", "amount", "currency"] as const).filter((f) => !col[f]);
  if (missing.length) {
    throw badRequest(
      `Not a Revolut statement: missing column(s) ${missing.map((m) => HEADER_ALIASES[m][0]).join(", ")}. Found: ${keys.join(", ")}`,
    );
  }
  const rows: StatementRow[] = [];
  const errors: string[] = [];
  records.forEach((r, i) => {
    const get = (f: keyof StatementRow) => (col[f] ? r[col[f]!] : undefined);
    try {
      const completed = get("completedDate");
      rows.push({
        type: String(get("type") ?? "").trim(),
        product: String(get("product") ?? "").trim(),
        startedDate: revolutDate(get("startedDate")),
        completedDate: completed === undefined || completed === null || String(completed).trim() === "" ? null : revolutDate(completed),
        description: String(get("description") ?? "").trim(),
        amount: toNum(get("amount"), "Amount", true)!,
        fee: toNum(get("fee"), "Fee", false) ?? 0,
        currency: String(get("currency") ?? "").trim().toUpperCase(),
        state: String(get("state") ?? "COMPLETED").trim().toUpperCase(),
        balance: toNum(get("balance"), "Balance", false),
      });
    } catch (e) {
      errors.push(`Row ${i + 2}: ${(e as Error).message}`);
    }
  });
  return { rows, errors };
}

/** The app writes commas; a statement saved again from a Hungarian Excel has semicolons. */
export function parseStatementCsv(text: string, delimiter = detectDelimiter(text)): { rows: StatementRow[]; errors: string[] } {
  // relax_quotes: a stray quote inside a description (`Spar 5" cable`) is part of the text, not a broken file.
  const common = { bom: true, delimiter, skip_empty_lines: true, trim: true, relax_quotes: true } as const;
  let header: string[];
  let records: Record<string, unknown>[];
  try {
    header = (parse(text, { ...common, to_line: 1 }) as string[][])[0] ?? [];
    records = parse(text, { ...common, columns: true, relax_column_count: true }) as Record<string, unknown>[];
  } catch (e) {
    throw badRequest(`Not a readable CSV file: ${(e as Error).message}`);
  }
  return normalizeRecords(records, header);
}

/** The rows of the statement's sheet, first row the header. */
export function parseStatementSheet(rows: SheetCell[][]): { rows: StatementRow[]; errors: string[] } {
  const header = (rows[0] ?? []).map((c) => String(cellValue(c)).trim());
  const records: Record<string, unknown>[] = [];
  for (const row of rows.slice(1)) {
    const rec: Record<string, unknown> = {};
    header.forEach((h, c) => {
      if (!h) return;
      const v = row[c] ?? null;
      // Keep real Date objects (revolutDate handles them).
      rec[h] = v instanceof Date ? v : cellValue(v);
    });
    if (Object.values(rec).some((v) => v !== null && v !== undefined && v !== "")) records.push(rec);
  }
  return normalizeRecords(records, header.filter(Boolean));
}

export async function parseStatementXlsx(buf: Buffer): Promise<{ rows: StatementRow[]; errors: string[] }> {
  const sheet = busiestSheet(await readWorkbook(buf, "Not a readable XLSX file"));
  if (!sheet) throw badRequest("The XLSX file has no worksheets");
  return parseStatementSheet(sheet.rows);
}

/** externalId = hash of date + amount + description (an occurrence suffix separates identical rows in one file). */
export function statementExternalId(date: string, amount: number, description: string, occurrence = 0): string {
  const h = createHash("sha256").update(`${date}|${amount.toFixed(2)}|${description}`).digest("hex").slice(0, 32);
  return occurrence > 0 ? `revolut:${h}:${occurrence}` : `revolut:${h}`;
}

/** Turns rows into transactions. Skips non-completed rows and internal currency exchanges. */
export function toTransactions(rows: StatementRow[]): { txs: ParsedStatementTx[]; ignored: number } {
  const seen = new Map<string, number>();
  const txs: ParsedStatementTx[] = [];
  let ignored = 0;
  for (const row of rows) {
    if (row.state !== "COMPLETED" || row.type.toUpperCase() === "EXCHANGE") {
      ignored++;
      continue;
    }
    const date = row.completedDate ?? row.startedDate;
    const base = statementExternalId(date, row.amount, row.description);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const amount = Math.round((row.amount - row.fee) * 100) / 100;
    const notes = [row.type && `Revolut ${row.type.toLowerCase().replace(/_/g, " ")}`, row.fee ? `díj: ${row.fee} ${row.currency}` : ""]
      .filter(Boolean)
      .join(", ");
    txs.push({
      externalId: n === 0 ? base : statementExternalId(date, row.amount, row.description, n),
      date,
      amount,
      currency: row.currency,
      merchant: row.description || row.type || "Revolut",
      note: notes || undefined,
      categoryId: categorize(row.description, amount, row.type),
      row,
    });
  }
  return { txs, ignored };
}

export async function importStatement(
  repo: Repository,
  file: { filename: string; mimetype: string; data: Buffer },
): Promise<{ imported: number; skipped: number; errors: string[] }> {
  const isXlsx =
    /\.xlsx$/i.test(file.filename) ||
    file.mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    file.data.subarray(0, 2).toString("latin1") === "PK";
  const { rows, errors } = isXlsx ? await parseStatementXlsx(file.data) : parseStatementCsv(decodeText(file.data));
  const { txs, ignored } = toTransactions(rows);
  let imported = 0;
  let skipped = ignored;
  const known = new Set((await repo.listCategories()).map((c) => c.id));
  await repo.withTx(async (repo) => {
    for (const t of txs) {
      if (await repo.hasExternalId(t.externalId)) {
        skipped++;
        continue;
      }
      await repo.createTransaction({
        amount: t.amount,
        currency: t.currency,
        date: t.date,
        merchant: t.merchant,
        note: t.note,
        categoryId: t.categoryId && known.has(t.categoryId) ? t.categoryId : null,
        source: "revolut",
        externalId: t.externalId,
      });
      imported++;
    }
    // Remember the latest balance per product/currency so /revolut/status can show "accounts".
    const accounts = new Map<string, RevolutStatus["accounts"][number] & { at: string }>(
      (JSON.parse((await getMeta(repo.db, META_CSV_ACCOUNTS)) ?? "[]") as (RevolutStatus["accounts"][number] & { at: string })[]).map((a) => [
        a.id,
        a,
      ]),
    );
    for (const r of rows) {
      if (r.balance === null || r.state !== "COMPLETED") continue;
      const id = `${r.product || "Current"}:${r.currency}`;
      const at = r.completedDate ?? r.startedDate;
      const prev = accounts.get(id);
      if (!prev || prev.at <= at) accounts.set(id, { id, name: `${r.product || "Current"} (${r.currency})`, currency: r.currency, balance: r.balance, at });
    }
    await setMeta(repo.db, META_CSV_ACCOUNTS, JSON.stringify([...accounts.values()]));
    await setMeta(repo.db, META_LAST_SYNC, new Date().toISOString());
  });
  return { imported, skipped, errors };
}

export class CsvRevolutProvider implements RevolutProvider {
  readonly mode = "csv" as const;
  constructor(private readonly repo: Repository) {}

  async status(): Promise<RevolutStatus> {
    const lastSyncAt = await getMeta(this.repo.db, META_LAST_SYNC);
    const accounts = (JSON.parse((await getMeta(this.repo.db, META_CSV_ACCOUNTS)) ?? "[]") as RevolutStatus["accounts"]).map(
      ({ id, name, currency, balance }) => ({ id, name, currency, balance }),
    );
    return { connected: lastSyncAt !== null, mode: "csv", lastSyncAt, accounts };
  }

  async sync(): Promise<{ imported: number; skipped: number }> {
    throw badRequest(
      "Revolut is in csv mode: there is nothing to sync. Upload an account statement (CSV or Excel) to POST /api/revolut/import-statement instead.",
    );
  }
}
