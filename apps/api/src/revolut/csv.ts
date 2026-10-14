import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import ExcelJS from "exceljs";
import type { RevolutStatus } from "@et/shared";
import { getMeta, setMeta, transaction as dbTransaction } from "../db.js";
import { badRequest } from "../errors.js";
import type { Repository } from "../repository.js";
import { categorize } from "./categorize.js";
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

/** Revolut writes local wall-clock time without an offset ("2026-10-01 08:15:42"); it is stored as UTC. */
function revolutDate(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  const s = String(v ?? "").trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  const iso = m ? `${m[1]}T${(m[2] ?? "0").padStart(2, "0")}:${m[3] ?? "00"}:${m[4] ?? "00"}Z` : s;
  const t = Date.parse(iso);
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

function normalizeRecords(records: Record<string, unknown>[]): { rows: StatementRow[]; errors: string[] } {
  if (records.length === 0) return { rows: [], errors: [] };
  const keys = Object.keys(records[0]!);
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

export function parseStatementCsv(text: string): { rows: StatementRow[]; errors: string[] } {
  const records = parse(text, { columns: true, bom: true, skip_empty_lines: true, trim: true, relax_column_count: true }) as Record<
    string,
    unknown
  >[];
  return normalizeRecords(records);
}

export async function parseStatementXlsx(buf: Buffer): Promise<{ rows: StatementRow[]; errors: string[] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) throw badRequest("The XLSX file has no worksheets");
  const header: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, c) => (header[c] = String(cell.text ?? "").trim()));
  const records: Record<string, unknown>[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const rec: Record<string, unknown> = {};
    header.forEach((h, c) => {
      if (!h) return;
      const v = row.getCell(c).value;
      rec[h] = v && typeof v === "object" && !(v instanceof Date) && "result" in v ? (v as { result: unknown }).result : v;
    });
    if (Object.values(rec).some((v) => v !== null && v !== undefined && v !== "")) records.push(rec);
  });
  if (records.length === 0 && header.length) records.push(Object.fromEntries(header.filter(Boolean).map((h) => [h, ""])));
  const out = normalizeRecords(records);
  return { rows: out.rows.filter((r) => r.description || r.amount), errors: out.errors };
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
  const { rows, errors } = isXlsx ? await parseStatementXlsx(file.data) : parseStatementCsv(file.data.toString("utf8"));
  const { txs, ignored } = toTransactions(rows);
  let imported = 0;
  let skipped = ignored;
  const known = new Set(repo.listCategories().map((c) => c.id));
  dbTransaction(repo.db, () => {
    for (const t of txs) {
      if (repo.hasExternalId(t.externalId)) {
        skipped++;
        continue;
      }
      repo.createTransaction({
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
      (JSON.parse(getMeta(repo.db, META_CSV_ACCOUNTS) ?? "[]") as (RevolutStatus["accounts"][number] & { at: string })[]).map((a) => [
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
    setMeta(repo.db, META_CSV_ACCOUNTS, JSON.stringify([...accounts.values()]));
    setMeta(repo.db, META_LAST_SYNC, new Date().toISOString());
  });
  return { imported, skipped, errors };
}

export class CsvRevolutProvider implements RevolutProvider {
  readonly mode = "csv" as const;
  constructor(private readonly repo: Repository) {}

  async status(): Promise<RevolutStatus> {
    const lastSyncAt = getMeta(this.repo.db, META_LAST_SYNC);
    const accounts = (JSON.parse(getMeta(this.repo.db, META_CSV_ACCOUNTS) ?? "[]") as RevolutStatus["accounts"]).map(
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
