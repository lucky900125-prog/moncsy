import type { PackUnit, ReceiptItem, Transaction, TransactionSource } from "@et/shared";

export type Draft = Partial<Omit<Transaction, "id">>;

// The tx screen also opens from a moncsy://tx?draft=… link, so the draft is untrusted input: only known fields with the
// right types are kept, and anything malformed is refused instead of half-filling the form. The limits follow what the
// API accepts when the transaction is saved (apps/api/src/schemas.ts), so a real scan result always passes.
const SOURCES: TransactionSource[] = ["manual", "receipt", "revolut", "import"];
const UNITS: PackUnit[] = ["g", "kg", "ml", "l", "db"];
const MAX_ITEMS = 1000;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length <= max;
const optional = <T,>(v: unknown, ok: (x: unknown) => x is T): v is T | null | undefined => v == null || ok(v);

function parseItem(v: unknown): ReceiptItem | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!isText(o.name, 1000) || !isNum(o.quantity) || !isNum(o.unitPrice) || !isNum(o.total)) return null;
  const short = (x: unknown): x is string => isText(x, 120);
  if (!optional(o.product, short) || !optional(o.brand, short) || !optional(o.packSize, isNum)) return null;
  if (!optional(o.packUnit, (x): x is PackUnit => UNITS.includes(x as PackUnit))) return null;
  return {
    name: o.name, quantity: o.quantity, unitPrice: o.unitPrice, total: o.total,
    product: o.product ?? null, brand: o.brand ?? null, packSize: o.packSize ?? null, packUnit: o.packUnit ?? null,
  };
}

/** The draft from the link, {} when there is none, or null when it is not a valid draft. */
export function parseDraft(raw: string | undefined): Draft | null {
  if (!raw) return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const d: Draft = {};
  if (o.amount !== undefined) { if (!isNum(o.amount)) return null; d.amount = o.amount; }
  if (o.currency !== undefined) { if (typeof o.currency !== "string" || !/^[A-Za-z]{3}$/.test(o.currency)) return null; d.currency = o.currency.toUpperCase(); }
  if (o.merchant !== undefined) { if (!isText(o.merchant, 200)) return null; d.merchant = o.merchant; }
  if (o.categoryId !== undefined) { if (!optional(o.categoryId, (x): x is string => isText(x, 100))) return null; d.categoryId = o.categoryId ?? null; }
  if (o.date !== undefined) { if (typeof o.date !== "string" || Number.isNaN(Date.parse(o.date))) return null; d.date = o.date; }
  if (o.note !== undefined) { if (!optional(o.note, (x): x is string => isText(x, 2000))) return null; d.note = o.note ?? null; }
  if (o.source !== undefined) { if (!SOURCES.includes(o.source as TransactionSource)) return null; d.source = o.source as TransactionSource; }
  if (o.items !== undefined) {
    if (!Array.isArray(o.items) || o.items.length > MAX_ITEMS) return null;
    const items = o.items.map(parseItem);
    if (items.some((x) => x === null)) return null;
    d.items = items as ReceiptItem[];
  }
  return d;
}
