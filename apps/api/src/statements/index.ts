import { parse } from "csv-parse/sync";
import { z } from "zod";
import type { StatementFormat, StatementMapping, StatementPreview, StatementTx } from "@et/shared";
import type { AIProvider } from "../ai/index.js";
import { HttpError, badRequest } from "../errors.js";
import { decodeText, detectDelimiter, utf16Encoding } from "../io/text.js";
import { busiestSheet, cellValue, readWorkbook, type SheetCell } from "../io/xlsx.js";
import type { Repository } from "../repository.js";
import { parseStatementCsv, parseStatementSheet, revolutLayout, toTransactions } from "../revolut/csv.js";
import { isoDate } from "../schemas.js";
import { parseCamt, parseMt940, parseOfx } from "./formats.js";
import { parsePdfStatement } from "./pdf.js";
import { MAX_STATEMENT_ROWS, assertStatementRows, assertTextStatementSize } from "./limits.js";
import { parseTabular, type Cell } from "./tabular.js";

export interface ParseOptions {
  mapping?: StatementMapping;
  currency?: string;
  defaultCurrency: string;
  timeZone: string;
}

export { decodeText, detectDelimiter };

/** A Revolut statement in any language: its header words or its column order, with a product and a state column. */
const isRevolut = (rows: unknown[][]) => {
  const layout = revolutLayout(rows[0] ?? [], rows[1]);
  return layout !== null && layout.product !== undefined && layout.state !== undefined;
};

function fromRevolut(rows: ReturnType<typeof parseStatementCsv>): Omit<StatementPreview, "format" | "columns" | "mapping"> {
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

/** Dates and numbers stay as they are (a formula's result included); everything else is text. */
const tabularCell = (c: SheetCell): Cell => (c instanceof Date || typeof c === "number" || c === null ? c : String(cellValue(c)));

export function sniffStatement(data: Buffer, filename: string): StatementFormat | "xls" | "text" {
  const head = data.subarray(0, 8);
  if (head.subarray(0, 4).toString("latin1") === "%PDF") return "pdf";
  if (head.subarray(0, 2).toString("latin1") === "PK") return "xlsx";
  if (head.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return "xls";
  // Old Excel saved as HTML or SpreadsheetML is also named .xls; tab-separated text with that name is read as text.
  // UTF-16 text is full of zero bytes, so for it only the decoded start counts.
  if (/\.xls$/i.test(filename)) {
    const utf16 = utf16Encoding(data) !== null;
    const start = utf16 ? decodeText(data.subarray(0, 512)) : data.subarray(0, 256).toString("latin1");
    if ((!utf16 && data.includes(0)) || /^(\uFEFF|\xEF\xBB\xBF)?\s*</.test(start)) return "xls";
  }
  return "text";
}

/** Reads any supported statement into transactions without saving anything. */
export async function parseStatementFile(
  file: { filename: string; data: Buffer },
  opts: ParseOptions,
  ai: AIProvider,
): Promise<StatementPreview> {
  const preview = await readStatement(file, opts, ai);
  // What the import would refuse anyway (statementImportSchema) is not offered in a preview either.
  assertStatementRows(preview.transactions.length + preview.ignored + preview.errors.length);
  return preview;
}

async function readStatement(
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
    // The statement is the sheet with the most filled rows; banks sometimes add a cover sheet.
    const sheet = busiestSheet(await readWorkbook(file.data, "Not a readable XLSX file"));
    if (!sheet) throw badRequest("The XLSX file has no worksheets");
    if (isRevolut(sheet.rows.slice(0, 2).map((r) => r.map((c, i) => (c instanceof Date || i > 0 ? c : cellValue(c)))))) return { format: "revolut", ...empty, ...fromRevolut(parseStatementSheet(sheet.rows, opts.timeZone)) };
    return { format: "xlsx", ...parseTabular(sheet.rows.map((r) => r.map(tabularCell)), opts) };
  }

  assertTextStatementSize(file.data);
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
  if (isRevolut(rows)) return { format: "revolut", ...empty, ...fromRevolut(parseStatementCsv(text, opts.timeZone, delimiter)) };
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

export const statementImportSchema = z.object({ transactions: z.array(z.unknown()).max(MAX_STATEMENT_ROWS) });

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
