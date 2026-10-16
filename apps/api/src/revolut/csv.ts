import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import type { RevolutStatus } from "@et/shared";
import { getMeta, setMeta } from "../db.js";
import { badRequest } from "../errors.js";
import { decodeText, detectDelimiter } from "../io/text.js";
import { fromExcelSerial, isCalendarDate, zonedToUtc } from "../statements/dates.js";
import { assertStatementRows, assertTextStatementSize } from "../statements/limits.js";
import { detectDecimal, fold, parseAmount, parseStatementDate, type DecimalSep } from "../statements/values.js";
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

/**
 * The header words of each export language a source shows: English (the app's own export), Hungarian (an export the
 * owner sent, 2026-10-16) and Czech (https://git.vitexsoftware.com/MultiFlexi/AbraFlexi-Revolut, README, "Czech
 * Format"). Neither translation translates "State". Compared folded (no case, no accents). Any other language is read
 * by the column order instead (revolutLayout).
 */
const HEADER_ALIASES: Record<keyof StatementRow, string[]> = {
  type: ["type", "típus", "typ"],
  product: ["product", "termék", "produkt"],
  startedDate: ["started date", "started_date", "kezdés dátuma", "datum zahájení"],
  completedDate: ["completed date", "completed_date", "teljesítés dátuma", "datum dokončení"],
  description: ["description", "leírás", "popis"],
  amount: ["amount", "összeg", "částka"],
  fee: ["fee", "díj", "poplatek"],
  currency: ["currency", "pénznem", "měna"],
  state: ["state"],
  balance: ["balance", "egyenleg", "zůstatek"],
};

/** Revolut's column order, the same whatever the language of the header. */
const COLUMN_ORDER: (keyof StatementRow)[] = ["type", "product", "startedDate", "completedDate", "description", "amount", "fee", "currency", "state", "balance"];
const REQUIRED = ["startedDate", "description", "amount", "currency"] as const;

/** "Completed" in the languages a source shows (English, Czech). */
const COMPLETED_STATES = new Set(["completed", "dokonceno"]);
/** Revolut's English states for a transaction that is not final. */
const OPEN_STATES = new Set(["pending", "reverted", "declined", "failed"]);
/** Revolut's English types for the translated ones a source shows (Czech), so categories and the exchange rule apply. */
const TYPE_ALIASES = new Map([
  ["dobijeni", "TOPUP"],
  ["platba kartou", "CARD_PAYMENT"],
  ["poplatek", "FEE"],
  ["prevod", "TRANSFER"],
  ["vraceni penez na kartu", "CARD_REFUND"],
]);

type Layout = Partial<Record<keyof StatementRow, number>>;

function byHeaderWords(names: string[]): Layout {
  const layout: Layout = {};
  for (const field of COLUMN_ORDER) {
    const i = names.findIndex((n) => HEADER_ALIASES[field].some((a) => fold(a) === n));
    if (i >= 0) layout[field] = i;
  }
  return layout;
}

/** A first row that has a date third, an amount sixth and a currency code eighth, as Revolut writes them. */
function fitsColumnOrder(row: unknown[] | undefined): boolean {
  if (!row) return false;
  try {
    revolutDate(row[2], "UTC");
    return parseAmount(row[5], detectDecimal([row[5]])) !== null && /^[A-Za-z]{3}$/.test(String(row[7] ?? "").trim());
  } catch {
    return false;
  }
}

/**
 * Which column (by index) holds which field: by the header words of a language above, or else, for a header of ten
 * columns in any other language, by Revolut's column order when the first row fits it. Null when the file is not a
 * Revolut statement.
 */
export function revolutLayout(header: unknown[], first?: unknown[]): Layout | null {
  const names = header.map((c) => fold(String(c ?? "").replace(/^\uFEFF/, "")));
  while (names.length && !names[names.length - 1]) names.pop();
  const layout = byHeaderWords(names);
  if (REQUIRED.every((f) => layout[f] !== undefined)) return layout;
  if (names.length === COLUMN_ORDER.length && names.every(Boolean) && fitsColumnOrder(first)) {
    return Object.fromEntries(COLUMN_ORDER.map((f, i) => [f, i]));
  }
  return null;
}

/**
 * Revolut writes local wall-clock time without an offset ("2026-10-01 08:15:42").
 * It is interpreted in `timeZone` (STATEMENT_TZ from the config) and stored as UTC.
 * Excel Date cells carry the same wall-clock time encoded as UTC, so they are re-interpreted too.
 * A statement opened in a Hungarian Excel and saved again as CSV has "2026. 10. 01. 8:15" instead.
 */
export function revolutDate(v: unknown, timeZone: string): string {
  // A General-formatted cell holds the Excel serial number; 2958465 is 9999-12-31.
  if (typeof v === "number" && v > 0 && v < 2958466) return revolutDate(fromExcelSerial(v), timeZone);
  if (v instanceof Date) {
    return zonedToUtc(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate(), v.getUTCHours(), v.getUTCMinutes(), v.getUTCSeconds(), timeZone).toISOString();
  }
  const s = String(v ?? "").trim();
  // A statement saved again from a spreadsheet in most European languages writes the day first: "01.10.2026 08:15".
  if (/^\d{1,2}[./-] ?\d{1,2}[./-] ?\d{4}/.test(s)) return parseStatementDate(s, "dmy", timeZone);
  const m = s.match(/^(\d{4})(?:-|\. ?)(\d{1,2})(?:-|\. ?)(\d{1,2})\.?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const [, y, mo, d, h = "0", mi = "0", sec = "0"] = m;
    if (!isCalendarDate(+y!, +mo!, +d!, +h, +mi, +sec)) throw new Error(`invalid date "${s}"`);
    return zonedToUtc(+y!, +mo!, +d!, +h, +mi, +sec, timeZone).toISOString();
  }
  const t = Date.parse(s);
  // Date.parse reads a bare number such as "46309" as that year.
  if (Number.isNaN(t) || /^\d+$/.test(s)) throw new Error(`invalid date "${s}"`);
  return new Date(t).toISOString();
}

function toNum(v: unknown, field: string, required: boolean, decimal: DecimalSep): number | null {
  let n: number | null;
  try {
    n = parseAmount(v, decimal);
  } catch {
    throw new Error(`invalid ${field} "${String(v)}"`);
  }
  if (n === null && required) throw new Error(`missing ${field}`);
  return n;
}

/** A state "completed" in a known language, or a state word not known here on a row that has a completion date. */
function isCompleted(state: string, completed: unknown): boolean {
  const s = fold(state);
  if (COMPLETED_STATES.has(s)) return true;
  if (OPEN_STATES.has(s)) return false;
  return completed !== undefined && completed !== null && String(completed).trim() !== "";
}

/** Validates the header first, so an empty statement is told apart from a file that is not a statement at all. */
function normalizeRecords(records: Record<string, unknown>[], keys: string[], timeZone: string): { rows: StatementRow[]; errors: string[] } {
  const layout = revolutLayout(keys, records[0] && keys.map((k) => records[0]![k]));
  if (!layout) {
    const found = byHeaderWords(keys.map((k) => fold(k)));
    const missing = REQUIRED.filter((f) => found[f] === undefined);
    throw badRequest(
      `Not a Revolut statement: missing column(s) ${missing.map((m) => HEADER_ALIASES[m][0]).join(", ")}. Found: ${keys.join(", ")}`,
    );
  }
  const col = Object.fromEntries(COLUMN_ORDER.map((f) => [f, layout[f] === undefined ? undefined : keys[layout[f]!]])) as Record<
    keyof StatementRow,
    string | undefined
  >;
  // Each record becomes a row or an error, and each row a transaction or an ignored one: refused by the count before any is read.
  assertStatementRows(records.length);
  const rows: StatementRow[] = [];
  const errors: string[] = [];
  const get = (r: Record<string, unknown>, f: keyof StatementRow) => (col[f] ? r[col[f]!] : undefined);
  // One decimal separator for the whole file, judged from every number in it ("-1.234,50" and "0,50" agree).
  const decimal = detectDecimal(records.flatMap((r) => [get(r, "amount"), get(r, "fee"), get(r, "balance")]));
  records.forEach((r, i) => {
    try {
      const completed = get(r, "completedDate");
      const type = String(get(r, "type") ?? "").trim();
      const state = String(get(r, "state") ?? "COMPLETED").trim().toUpperCase();
      rows.push({
        type: TYPE_ALIASES.get(fold(type)) ?? type,
        product: String(get(r, "product") ?? "").trim(),
        startedDate: revolutDate(get(r, "startedDate"), timeZone),
        completedDate: completed === undefined || completed === null || String(completed).trim() === "" ? null : revolutDate(completed, timeZone),
        description: String(get(r, "description") ?? "").trim(),
        amount: toNum(get(r, "amount"), "Amount", true, decimal)!,
        fee: toNum(get(r, "fee"), "Fee", false, decimal) ?? 0,
        currency: String(get(r, "currency") ?? "").trim().toUpperCase(),
        state: isCompleted(state, completed) ? "COMPLETED" : state,
        balance: toNum(get(r, "balance"), "Balance", false, decimal),
      });
    } catch (e) {
      errors.push(`Row ${i + 2}: ${(e as Error).message}`);
    }
  });
  return { rows, errors };
}

/** The app writes commas; a statement saved again from a Hungarian Excel has semicolons. */
export function parseStatementCsv(text: string, timeZone: string, delimiter = detectDelimiter(text)): { rows: StatementRow[]; errors: string[] } {
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
  return normalizeRecords(records, header, timeZone);
}

/** The rows of the statement's sheet, first row the header. */
export function parseStatementSheet(rows: SheetCell[][], timeZone: string): { rows: StatementRow[]; errors: string[] } {
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
  return normalizeRecords(records, header.filter(Boolean), timeZone);
}

export async function parseStatementXlsx(buf: Buffer, timeZone: string): Promise<{ rows: StatementRow[]; errors: string[] }> {
  const sheet = busiestSheet(await readWorkbook(buf, "Not a readable XLSX file"));
  if (!sheet) throw badRequest("The XLSX file has no worksheets");
  return parseStatementSheet(sheet.rows, timeZone);
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
  timeZone: string,
): Promise<{ imported: number; skipped: number; errors: string[] }> {
  const isXlsx =
    /\.xlsx$/i.test(file.filename) ||
    file.mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    file.data.subarray(0, 2).toString("latin1") === "PK";
  if (!isXlsx) assertTextStatementSize(file.data);
  const { rows, errors } = isXlsx ? await parseStatementXlsx(file.data, timeZone) : parseStatementCsv(decodeText(file.data), timeZone);
  assertStatementRows(rows.length + errors.length);
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
