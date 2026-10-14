import { parse } from "csv-parse/sync";
import { z } from "zod";
import type { StatementFormat, StatementMapping, StatementPreview, StatementTx } from "@et/shared";
import type { AIProvider } from "../ai/index.js";
import { HttpError, badRequest } from "../errors.js";
import { cellValue, loadWorkbook } from "../io/xlsx.js";
import type { Repository } from "../repository.js";
import { parseStatementCsv, parseStatementXlsx, toTransactions } from "../revolut/csv.js";
import { isoDate } from "../schemas.js";
import { parseCamt, parseMt940, parseOfx } from "./formats.js";
import { parsePdfStatement } from "./pdf.js";
import { parseTabular, type Cell } from "./tabular.js";
import { fold } from "./values.js";

export interface ParseOptions {
  mapping?: StatementMapping;
  currency?: string;
  defaultCurrency: string;
  timeZone: string;
}

/** UTF-8 when the bytes are valid UTF-8, otherwise Windows-1250, the code page of older Hungarian bank exports. */
export function decodeText(data: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data).replace(/^\uFEFF/, "");
  } catch {
    return new TextDecoder("windows-1250").decode(data);
  }
}

/** The separator that splits the first lines into the same, largest number of fields. */
export function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 30);
  let best = ",";
  let bestScore = -1;
  for (const d of [";", ",", "\t", "|"]) {
    const counts = lines.map((l) => {
      let n = 0;
      let quoted = false;
      for (const ch of l) {
        if (ch === '"') quoted = !quoted;
        else if (ch === d && !quoted) n++;
      }
      return n;
    });
    // The most common count among lines that have any separator, times how many lines share it.
    const freq = new Map<number, number>();
    for (const c of counts) if (c > 0) freq.set(c, (freq.get(c) ?? 0) + 1);
    const [count, lines_] = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0] ?? [0, 0];
    const score = count * lines_;
    if (score > bestScore) [best, bestScore] = [d, score];
  }
  return best;
}

const isRevolutHeader = (cells: unknown[]) => {
  const h = new Set(cells.map((c) => fold(String(c ?? ""))));
  return h.has("started date") && h.has("state") && h.has("product");
};

function fromRevolut(rows: Awaited<ReturnType<typeof parseStatementXlsx>>): Omit<StatementPreview, "format" | "columns" | "mapping"> {
  const { txs, ignored } = toTransactions(rows.rows);
  return {
    currency: null,
    transactions: txs.map(
      (t): StatementTx => ({
        externalId: t.externalId,
        date: t.date,
        amount: t.amount,
        currency: t.currency,
        merchant: t.merchant,
        ...(t.note ? { note: t.note } : {}),
        categoryId: t.categoryId,
        source: "revolut",
      }),
    ),
    ignored,
    errors: rows.errors,
  };
}

/** Far more than any bank statement has; a cell far out would otherwise make the arrays below that long. */
const MAX_XLSX_ROWS = 100_000;
const MAX_XLSX_COLUMNS = 200;

async function xlsxRows(data: Buffer): Promise<Cell[][]> {
  const wb = await loadWorkbook(data, "Not a readable XLSX file");
  // The statement is the sheet with the most filled rows; banks sometimes add a cover sheet.
  const ws = [...wb.worksheets].sort((a, b) => b.actualRowCount - a.actualRowCount)[0];
  if (!ws) throw badRequest("The XLSX file has no worksheets");
  const rows: Cell[][] = [];
  // Only cells with a value: with includeEmpty, a formatted cell at the sheet's far corner makes millions of empty ones.
  ws.eachRow((row, n) => {
    if (n > MAX_XLSX_ROWS) throw badRequest(`The sheet has a value in row ${n}; statements of more than ${MAX_XLSX_ROWS} rows are not read`);
    const cells: Cell[] = [];
    row.eachCell((cell, c) => {
      if (c > MAX_XLSX_COLUMNS) throw badRequest(`The sheet has a value in column ${c}; more than ${MAX_XLSX_COLUMNS} columns are not read`);
      const v = cell.value;
      cells[c - 1] = v instanceof Date || typeof v === "number" ? v : (String(cellValue(v)) as Cell);
    });
    rows[n - 1] = Array.from(cells, (c) => c ?? null);
  });
  return Array.from(rows, (r) => r ?? []);
}

export function sniffStatement(data: Buffer, filename: string): StatementFormat | "xls" | "text" {
  const head = data.subarray(0, 8);
  if (head.subarray(0, 4).toString("latin1") === "%PDF") return "pdf";
  if (head.subarray(0, 2).toString("latin1") === "PK") return "xlsx";
  if (head.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return "xls";
  // Old Excel saved as HTML or SpreadsheetML is also named .xls; tab-separated text with that name is read as text.
  if (/\.xls$/i.test(filename) && (data.includes(0) || /^(\uFEFF|\xEF\xBB\xBF)?\s*</.test(data.subarray(0, 256).toString("latin1")))) return "xls";
  return "text";
}

/** Reads any supported statement into transactions without saving anything. */
export async function parseStatementFile(
  file: { filename: string; data: Buffer },
  opts: ParseOptions,
  ai: AIProvider,
): Promise<StatementPreview> {
  const kind = sniffStatement(file.data, file.filename);
  const empty = { columns: [] as string[], mapping: {} as StatementMapping };
  if (kind === "xls") {
    throw new HttpError(415, "Old Excel (.xls) files cannot be read. Open the file in Excel or LibreOffice and save it as .xlsx or .csv.");
  }
  if (kind === "pdf") {
    const r = await parsePdfStatement(ai, file.data, opts.currency ?? opts.defaultCurrency, opts.timeZone);
    return { format: "pdf", ...empty, ...r };
  }
  if (kind === "xlsx") {
    const rows = await xlsxRows(file.data);
    if (isRevolutHeader(rows[0] ?? [])) return { format: "revolut", ...empty, ...fromRevolut(await parseStatementXlsx(file.data)) };
    return { format: "xlsx", ...parseTabular(rows, opts) };
  }

  const text = decodeText(file.data);
  const start = text.trimStart().slice(0, 4000);
  if (/OFXHEADER|<OFX>/i.test(start)) return { format: "ofx", ...empty, ...parseOfx(text, opts.timeZone) };
  if (start.startsWith("<")) {
    if (/BkToCstmr/.test(text)) return { format: "camt", ...empty, ...parseCamt(text, opts.timeZone) };
    throw new HttpError(
      415,
      "This XML is not an ISO 20022 (camt.052/053/054) bank statement. A moncsy XML export goes to Import (XLSX / XML) instead.",
    );
  }
  if (/^:20:/m.test(start) && /^:61:/m.test(text)) return { format: "mt940", ...empty, ...parseMt940(text, opts.timeZone) };

  const delimiter = detectDelimiter(text);
  let rows: Cell[][];
  try {
    rows = parse(text, { delimiter, relax_column_count: true, relax_quotes: true, skip_empty_lines: false, trim: true }) as string[][];
  } catch (e) {
    throw badRequest(`Not a readable CSV file: ${(e as Error).message}`);
  }
  if (isRevolutHeader(rows[0] ?? [])) return { format: "revolut", ...empty, ...fromRevolut(parseStatementCsv(text)) };
  return { format: "csv", ...parseTabular(rows, opts) };
}

const statementTxSchema = z.object({
  externalId: z.string().min(1).max(200),
  date: isoDate,
  amount: z.number().finite(),
  currency: z.string().regex(/^[A-Za-z]{3}$/),
  merchant: z.string().trim().max(200),
  note: z.string().max(2000).optional(),
  categoryId: z.string().min(1).nullable(),
  source: z.enum(["import", "revolut"]),
});

export const statementImportSchema = z.object({ transactions: z.array(z.unknown()).max(20000) });

/**
 * Saves the transactions the client confirmed from a preview. Each row is validated on its own; a row
 * whose externalId is already stored is skipped, so importing the same statement twice changes nothing.
 * A category id that no longer exists is dropped rather than failing the row.
 */
export async function importStatementTxs(repo: Repository, rows: unknown[]): Promise<{ imported: number; skipped: number; errors: string[] }> {
  const res = { imported: 0, skipped: 0, errors: [] as string[] };
  const known = new Set((await repo.listCategories()).map((c) => c.id));
  await repo.withTx(async (repo) => {
    for (const [i, raw] of rows.entries()) {
      const p = statementTxSchema.safeParse(raw);
      if (!p.success) {
        res.errors.push(`Row ${i + 1}: ${p.error.issues.map((x) => `${x.path.join(".") || "(row)"}: ${x.message}`).join("; ")}`);
        continue;
      }
      const t = p.data;
      if (await repo.hasExternalId(t.externalId)) {
        res.skipped++;
        continue;
      }
      await repo.createTransaction({
        amount: t.amount,
        currency: t.currency.toUpperCase(),
        date: t.date,
        merchant: t.merchant,
        note: t.note,
        categoryId: t.categoryId && known.has(t.categoryId) ? t.categoryId : null,
        source: t.source,
        externalId: t.externalId,
      });
      res.imported++;
    }
  });
  return res;
}
