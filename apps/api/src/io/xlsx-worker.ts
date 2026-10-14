// Reads an uploaded workbook in a worker thread that has its own memory limit (io/xlsx.ts#readWorkbook).
// ExcelJS builds the whole workbook in memory, and a few bytes of XML (a merge, a column range, a validation or a
// defined name over the whole sheet) make it build millions of objects. Out of memory, only this thread dies.
// Node runs this file as it is: from dist/ as JavaScript, in development and tests by stripping the types, so it
// imports nothing from the rest of the API.
import { getHeapStatistics } from "node:v8";
import { parentPort, workerData } from "node:worker_threads";
import ExcelJS from "exceljs";

export type SheetCell = string | number | boolean | Date | null;

export interface SheetRows {
  name: string;
  /** rows[r][c] is the cell in row r + 1, column c + 1; a row or cell without a value is empty */
  rows: SheetCell[][];
}

export interface WorkerInput {
  data: Uint8Array;
  maxRows: number;
  maxColumns: number;
  /** the heap this thread was started with, in MB */
  heapMb: number;
}

export type WorkerOutput = { ok: true; sheets: SheetRows[] } | { ok: false; status: 400 | 503; message: string };

/** The value a cell shows: a formula's result, rich text's text, a hyperlink's text; an error is empty. */
function plain(v: ExcelJS.CellValue): SheetCell {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if ("result" in v) return plain(v.result as ExcelJS.CellValue);
  if ("richText" in v) return v.richText.map((r) => r.text).join("");
  if ("text" in v) return String(v.text);
  return null;
}

async function read({ data, maxRows, maxColumns, heapMb }: WorkerInput): Promise<WorkerOutput> {
  // --max-old-space-size (for example in NODE_OPTIONS) is process-wide and overrides a worker's own limit,
  // which would leave the server as exposed as reading the workbook on the main thread.
  const limitMb = getHeapStatistics().heap_size_limit / 1024 / 1024;
  if (limitMb > heapMb * 2) {
    return {
      ok: false,
      status: 503,
      message: `XLSX files are not read: the reader's memory limit of ${heapMb} MB is overridden (${Math.round(limitMb)} MB), usually by --max-old-space-size in NODE_OPTIONS`,
    };
  }
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(data as unknown as ArrayBuffer);
  } catch (e) {
    return { ok: false, status: 400, message: (e as Error).message };
  }
  const sheets: SheetRows[] = [];
  for (const ws of wb.worksheets) {
    const rows: SheetCell[][] = [];
    let tooFar: string | null = null;
    // Only cells with a value: with includeEmpty, a formatted cell at the sheet's far corner makes millions of empty ones.
    ws.eachRow((row, n) => {
      if (tooFar) return;
      if (n > maxRows) {
        tooFar = `The sheet "${ws.name}" has a value in row ${n}; sheets of more than ${maxRows} rows are not read`;
        return;
      }
      const cells: SheetCell[] = [];
      row.eachCell((cell, c) => {
        if (c > maxColumns) tooFar ??= `The sheet "${ws.name}" has a value in column ${c}; more than ${maxColumns} columns are not read`;
        else cells[c - 1] = plain(cell.value);
      });
      rows[n - 1] = Array.from(cells, (c) => c ?? null);
    });
    if (tooFar) return { ok: false, status: 400, message: tooFar };
    sheets.push({ name: ws.name, rows: Array.from(rows, (r) => r ?? []) });
  }
  return { ok: true, sheets };
}

// Anything thrown past read() is a defect here, not a bad file: it reaches the caller as a failed worker.
if (parentPort) {
  const port = parentPort;
  void read(workerData as WorkerInput).then((out) => port.postMessage(out));
}
