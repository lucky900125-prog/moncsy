import ExcelJS from "exceljs";
import { badRequest } from "../errors.js";
import type { ExportPayload, ImportPayload, RawRecord } from "./common.js";

/*
 * Workbook layout (first row = header, column order irrelevant on import):
 *   Transactions: id | date (ISO 8601 text) | amount | currency | merchant | categoryId | category (name, informational)
 *                 | note | source | externalId | items (JSON array of {name,quantity,unitPrice,total})
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

function cellValue(v: ExcelJS.CellValue): unknown {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    if ("result" in v) return cellValue((v as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
    if ("richText" in v) return (v as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join("");
    if ("text" in v) return String((v as ExcelJS.CellHyperlinkValue).text);
    if ("error" in v) return "";
  }
  return v;
}

function sheetRecords(ws: ExcelJS.Worksheet | undefined, sheet: string): RawRecord[] {
  if (!ws) return [];
  const header: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => (header[i] = String(cellValue(c.value)).trim()));
  const out: RawRecord[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const data: Record<string, unknown> = {};
    header.forEach((h, i) => {
      if (h) data[h] = cellValue(row.getCell(i).value);
    });
    if (Object.values(data).every((v) => v === "")) return;
    out.push({ where: `${sheet} row ${n}`, data });
  });
  return out;
}

export async function parseXlsx(buf: Buffer): Promise<ImportPayload> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch (e) {
    throw badRequest(`Could not read XLSX file: ${(e as Error).message}`);
  }
  const find = (name: string) => wb.worksheets.find((w) => w.name.trim().toLowerCase() === name.toLowerCase());
  const txSheet = find("Transactions") ?? (find("Categories") ? undefined : wb.worksheets[0]);
  if (!txSheet && !find("Categories")) throw badRequest('XLSX must contain a "Transactions" and/or "Categories" sheet');
  return { categories: sheetRecords(find("Categories"), "Categories"), transactions: sheetRecords(txSheet, txSheet?.name ?? "Transactions") };
}
