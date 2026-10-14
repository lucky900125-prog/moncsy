import { Worker } from "node:worker_threads";
import ExcelJS from "exceljs";
import { HttpError, badRequest } from "../errors.js";
import type { ExportPayload, ImportPayload, RawRecord } from "./common.js";
import type { SheetCell, SheetRows, WorkerInput, WorkerOutput } from "./xlsx-worker.js";

export type { SheetCell, SheetRows };

/** What an uploaded workbook may unpack to. A bank statement of several thousand rows is about 2 MB. */
export const MAX_XLSX_UNPACKED_BYTES = 20 * 1024 * 1024;
/** Far more than any bank statement or export has; a cell far out would otherwise make the arrays that long. */
export const MAX_XLSX_ROWS = 100_000;
export const MAX_XLSX_COLUMNS = 200;
/**
 * The reading thread's heap, and how long it may take. Render's free plan kills the service at 512 MB, and the main
 * thread alone stays at 250-330 MB after reading a large statement, so the reader gets 96 MB: enough for 30 000 rows
 * of a five-column statement or 20 000 rows of an export.
 */
export const XLSX_WORKER_HEAP_MB = 96;
export const XLSX_WORKER_TIMEOUT_MS = 30_000;

// Built JavaScript runs the built worker; in development and tests the module is TypeScript, and so is the worker.
const WORKER_URL = new URL(import.meta.url.endsWith(".ts") ? "./xlsx-worker.ts" : "./xlsx-worker.js", import.meta.url);

/** One workbook is read at a time, so two uploads cannot take twice the memory. */
let queue: Promise<unknown> = Promise.resolve();

function inWorker(data: Buffer, failure: string, timeoutMs: number): Promise<WorkerOutput> {
  return new Promise((resolve, reject) => {
    const input: WorkerInput = {
      data: new Uint8Array(data),
      maxUnpackedBytes: MAX_XLSX_UNPACKED_BYTES,
      maxRows: MAX_XLSX_ROWS,
      maxColumns: MAX_XLSX_COLUMNS,
      heapMb: XLSX_WORKER_HEAP_MB,
      failure,
    };
    const worker = new Worker(WORKER_URL, {
      workerData: input,
      resourceLimits: { maxOldGenerationSizeMb: XLSX_WORKER_HEAP_MB, maxYoungGenerationSizeMb: 16 },
    });
    let settled = false;
    const settle = (f: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      f();
      void worker.terminate();
    };
    const timer = setTimeout(
      () => settle(() => reject(new HttpError(413, `The XLSX file takes more than ${timeoutMs / 1000} s to read; split it into smaller files`))),
      timeoutMs,
    );
    worker.once("message", (out: WorkerOutput) => settle(() => resolve(out)));
    worker.once("error", (e: Error & { code?: string }) =>
      settle(() =>
        reject(
          e.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? new HttpError(413, `The XLSX file needs more than ${XLSX_WORKER_HEAP_MB} MB to read; split it into smaller files or save it as CSV`)
            : e,
        ),
      ),
    );
    worker.once("exit", (code) => settle(() => reject(new Error(`The XLSX reader stopped with exit code ${code} before answering`))));
  });
}

/**
 * Reads every sheet of an uploaded workbook into plain rows, in a worker thread with its own heap and time limit
 * (io/xlsx-worker.ts). The ZIP is checked there first, before ExcelJS loads it: what it unpacks to, and the ranges
 * ExcelJS would expand (io/xlsx-ranges.ts). So this thread never unpacks or scans an upload, and checking a large one
 * runs out of the reader's time, not the server's. `failure` starts the 400 message for a file that is not a workbook.
 */
export async function readWorkbook(buf: Buffer, failure: string, timeoutMs = XLSX_WORKER_TIMEOUT_MS): Promise<SheetRows[]> {
  const run = queue.then(() => inWorker(buf, failure, timeoutMs));
  queue = run.catch(() => undefined);
  const out = await run;
  if (out.ok) return out.sheets;
  throw new HttpError(out.status, out.message);
}

/** The sheet with the most rows that have a value; banks sometimes add a cover sheet. */
export function busiestSheet(sheets: SheetRows[]): SheetRows | undefined {
  const filled = (s: SheetRows) => s.rows.filter((r) => r.some((c) => c !== null)).length;
  return [...sheets].sort((a, b) => filled(b) - filled(a))[0];
}

/*
 * Workbook layout (first row = header, column order irrelevant on import):
 *   Transactions: id | date (ISO 8601 text) | amount | currency | merchant | categoryId | category (name, informational)
 *                 | note | source | externalId | items (JSON array of {name,quantity,unitPrice,total} and optionally
 *                   product, brand, packSize, packUnit)
 *   Categories:   id | name | icon | color | isCustom | parentId | budget
 * On import a transaction may give a category name instead of a categoryId.
 */
const TX_COLS = ["id", "date", "amount", "currency", "merchant", "categoryId", "category", "note", "source", "externalId", "items"] as const;
const CAT_COLS = ["id", "name", "icon", "color", "isCustom", "parentId", "budget"] as const;

export async function exportXlsx(p: ExportPayload): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "expense-tracker";
  wb.created = new Date(0);
  const names = new Map(p.categories.map((c) => [c.id, c.name]));

  const tx = wb.addWorksheet("Transactions");
  tx.columns = TX_COLS.map((key) => ({ header: key, key, width: key === "merchant" || key === "note" ? 30 : key === "items" ? 50 : 16 }));
  for (const t of p.transactions) {
    tx.addRow({
      id: t.id,
      date: t.date,
      amount: t.amount,
      currency: t.currency,
      merchant: t.merchant,
      categoryId: t.categoryId ?? "",
      category: t.categoryId ? (names.get(t.categoryId) ?? "") : "",
      note: t.note ?? "",
      source: t.source,
      externalId: t.externalId ?? "",
      items: t.items ? JSON.stringify(t.items) : "",
    });
  }
  const cat = wb.addWorksheet("Categories");
  cat.columns = CAT_COLS.map((key) => ({ header: key, key, width: key === "name" ? 24 : 16 }));
  for (const c of p.categories) {
    cat.addRow({
      id: c.id,
      name: c.name,
      icon: c.icon,
      color: c.color,
      isCustom: c.isCustom,
      parentId: c.parentId ?? "",
      budget: c.budget ?? "",
    });
  }
  for (const ws of [tx, cat]) {
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: "frozen", ySplit: 1 }];
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** A cell as text-or-number: empty is "", a date is its ISO text. */
export function cellValue(v: SheetCell | undefined): string | number | boolean {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  return v;
}

function sheetRecords(ws: SheetRows | undefined, sheet: string): RawRecord[] {
  if (!ws) return [];
  const header = (ws.rows[0] ?? []).map((c) => String(cellValue(c)).trim());
  const out: RawRecord[] = [];
  ws.rows.forEach((row, i) => {
    if (i === 0) return;
    const data: Record<string, unknown> = {};
    header.forEach((h, c) => {
      if (h) data[h] = cellValue(row[c]);
    });
    if (Object.values(data).every((v) => v === "")) return;
    out.push({ where: `${sheet} row ${i + 1}`, data });
  });
  return out;
}

export async function parseXlsx(buf: Buffer): Promise<ImportPayload> {
  const sheets = await readWorkbook(buf, "Could not read XLSX file");
  const find = (name: string) => sheets.find((w) => w.name.trim().toLowerCase() === name.toLowerCase());
  const txSheet = find("Transactions") ?? (find("Categories") ? undefined : sheets[0]);
  if (!txSheet && !find("Categories")) throw badRequest('XLSX must contain a "Transactions" and/or "Categories" sheet');
  return { categories: sheetRecords(find("Categories"), "Categories"), transactions: sheetRecords(txSheet, txSheet?.name ?? "Transactions") };
}
