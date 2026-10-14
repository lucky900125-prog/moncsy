import { createHash } from "node:crypto";
import type { StatementMapping, StatementRole, StatementTx } from "@et/shared";
import { badRequest } from "../errors.js";
import { categorize } from "../revolut/categorize.js";
import { currencyFrom, detectDateOrder, detectDecimal, fold, parseAmount, parseStatementDate } from "./values.js";

export type Cell = string | number | Date | null;

/**
 * Header names seen in Hungarian, English and German bank exports, compared after fold().
 * Exact matches win over "contains" matches, and earlier roles claim a column first.
 */
const ALIASES: Record<StatementRole, string[]> = {
  date: [
    "konyvelesi datum", "konyveles datuma", "konyveles napja", "tranzakcio datuma", "tranzakcio napja", "terhelesi datum",
    "datum", "booking date", "transaction date", "completed date", "started date", "posting date", "date", "buchungstag",
    "buchungsdatum", "datum/zeit", "kelt",
  ],
  valueDate: ["erteknap", "ertek nap", "value date", "valuta", "wertstellung"],
  debit: ["terheles", "terhelesek", "kiadas", "kifizetes", "debit", "paid out", "money out", "withdrawal", "soll", "tartozik"],
  credit: ["jovairas", "jovairasok", "bevetel", "befizetes", "credit", "paid in", "money in", "deposit", "haben", "kovetel"],
  amount: [
    "osszeg", "tranzakcio osszege", "terhelt osszeg", "konyvelt osszeg", "amount", "transaction amount", "betrag", "umsatz",
  ],
  direction: ["irany", "jelleg", "terheles/jovairas", "t/j", "debit/credit", "dr/cr", "cd", "soll/haben", "s/h"],
  currency: ["deviza", "devizanem", "penznem", "currency", "ccy", "wahrung", "waehrung"],
  counterparty: [
    "partner neve", "partner", "ellenoldali nev", "ellenoldali szamlatulajdonos", "kedvezmenyezett neve", "kedvezmenyezett",
    "megbizo neve", "megbizo", "kereskedo", "elfogado", "payee", "counterparty", "beneficiary", "merchant", "name",
    "empfanger", "auftraggeber", "beguenstigter/zahlungspflichtiger",
  ],
  description: [
    "kozlemeny", "megjegyzes", "leiras", "tranzakcio leirasa", "reszletek", "description", "details", "narrative", "memo",
    "reference", "remittance information", "verwendungszweck", "buchungstext", "text",
  ],
  type: ["tranzakcio tipusa", "tipus", "muvelet", "type", "transaction type", "umsatzart"],
  balance: ["egyenleg", "konyvelt egyenleg", "balance", "saldo", "kontostand"],
  reference: ["tranzakcio azonosito", "azonosito", "bizonylatszam", "transaction id", "reference number", "id", "referenz"],
};

const ROLE_ORDER: StatementRole[] = [
  "valueDate", "date", "debit", "credit", "amount", "direction", "currency", "counterparty", "description", "type", "balance", "reference",
];

/** Maps header cells to roles. Explicit (user-chosen) entries are kept as given. */
export function detectMapping(header: string[], explicit: StatementMapping = {}): StatementMapping {
  const mapping: StatementMapping = {};
  const taken = new Set<string>();
  for (const [role, col] of Object.entries(explicit) as [StatementRole, string][]) {
    if (col && header.includes(col)) {
      mapping[role] = col;
      taken.add(col);
    }
  }
  const folded = header.map((h) => [h, fold(h).replace(/\(.*?\)/g, "").trim()] as const);
  for (const pass of ["exact", "contains"] as const) {
    for (const role of ROLE_ORDER) {
      if (mapping[role] || role in explicit) continue;
      for (const alias of ALIASES[role]) {
        const hit = folded.find(
          ([orig, f]) => !taken.has(orig) && f !== "" && (pass === "exact" ? f === alias : alias.length > 3 && f.includes(alias)),
        );
        if (hit) {
          mapping[role] = hit[0];
          taken.add(hit[0]);
          break;
        }
      }
    }
  }
  return mapping;
}

const usable = (m: StatementMapping) => Boolean((m.date || m.valueDate) && (m.amount || m.debit || m.credit));

/**
 * Banks put account details above the table, so the header is the first of the top rows that maps to a
 * date and an amount. Returns its index, or -1.
 */
export function findHeaderRow(rows: Cell[][]): number {
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const cells = rows[i]!.map((c) => (c == null ? "" : String(c).trim()));
    if (cells.filter(Boolean).length < 2) continue;
    if (usable(detectMapping(cells))) return i;
  }
  return -1;
}

const DEBIT_WORDS = /^(t|d|db|dr|dbit|debit|terheles|kiadas|kimeno|soll|s|-)$/;
const CREDIT_WORDS = /^(j|c|cr|crdt|credit|jovairas|bevetel|bejovo|haben|h|\+)$/;

export interface TabularOptions {
  mapping?: StatementMapping;
  /** used when neither a column nor the header names one */
  currency?: string;
  defaultCurrency: string;
  timeZone: string;
}

export interface TabularResult {
  columns: string[];
  mapping: StatementMapping;
  currency: string | null;
  transactions: StatementTx[];
  ignored: number;
  errors: string[];
}

/** externalId = hash of the row's identifying fields; an occurrence suffix separates identical rows in one file. */
export function rowExternalId(parts: (string | number)[], seen: Map<string, number>): string {
  const h = createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
  const n = seen.get(h) ?? 0;
  seen.set(h, n + 1);
  return n === 0 ? `stmt:${h}` : `stmt:${h}:${n}`;
}

export function parseTabular(rows: Cell[][], opts: TabularOptions): TabularResult {
  const chosen = Object.values(opts.mapping ?? {}).filter((c): c is string => Boolean(c));
  const label = (c: Cell, i: number) => (c == null || String(c).trim() === "" ? `Oszlop ${i + 1}` : String(c).trim());
  // With columns chosen by hand, the header is the first row that has all of them.
  let headerIdx = chosen.length ? rows.findIndex((r) => chosen.every((c) => r.map(label).includes(c))) : findHeaderRow(rows);
  if (chosen.length && headerIdx < 0) throw badRequest(`No row has all the chosen columns (${chosen.join(", ")})`);
  const detected = headerIdx >= 0;
  // Nothing recognisable: offer the first row with content as the header, so the columns can be chosen by hand.
  if (!detected) headerIdx = rows.findIndex((r) => r.filter((c) => c != null && String(c).trim() !== "").length >= 2);
  if (headerIdx < 0) throw badRequest("The file has no rows with at least two columns");
  const columns = rows[headerIdx]!.map(label);
  const mapping = detectMapping(columns, opts.mapping);
  if (!usable(mapping)) {
    return {
      columns,
      mapping,
      currency: opts.currency?.toUpperCase() || null,
      transactions: [],
      ignored: 0,
      errors: ["No date and amount (or debit and credit) column was recognised; choose them by hand."],
    };
  }
  const idx = Object.fromEntries(Object.entries(mapping).map(([r, c]) => [r, columns.indexOf(c!)])) as Partial<Record<StatementRole, number>>;
  // line = 1-based row in the file, for error messages
  const body = rows
    .map((r, i) => ({ r, line: i + 1 }))
    .slice(headerIdx + 1)
    .filter(({ r }) => r.some((c) => c != null && String(c).trim() !== ""));
  const col = (role: StatementRole) => (idx[role] === undefined ? [] : body.map(({ r }) => r[idx[role]!]));

  const decimal = detectDecimal([...col("amount"), ...col("debit"), ...col("credit")]);
  const order = detectDateOrder([...col("date"), ...col("valueDate")]);
  const headerCurrency = [mapping.amount, mapping.debit, mapping.credit].map((h) => (h ? currencyFrom(h.match(/\((.*?)\)/)?.[1] ?? "") : null)).find(Boolean);
  const fileCurrency = opts.currency?.toUpperCase() || headerCurrency || null;

  const transactions: StatementTx[] = [];
  const errors: string[] = [];
  const seen = new Map<string, number>();
  let ignored = 0;
  body.forEach(({ r, line }) => {
    const get = (role: StatementRole): Cell => (idx[role] === undefined ? null : (r[idx[role]!] ?? null));
    const text = (role: StatementRole) => {
      const v = get(role);
      return v == null ? "" : v instanceof Date ? v.toISOString() : String(v).trim();
    };
    try {
      const dateCell = get("date") ?? get("valueDate");
      if (dateCell == null || String(dateCell).trim() === "") {
        // Totals and closing-balance lines under the table carry no date.
        ignored++;
        return;
      }
      let amount: number | null;
      if (idx.amount !== undefined) {
        amount = parseAmount(get("amount"), decimal);
        const dir = fold(text("direction"));
        if (amount !== null && dir) {
          if (DEBIT_WORDS.test(dir)) amount = -Math.abs(amount);
          else if (CREDIT_WORDS.test(dir)) amount = Math.abs(amount);
        }
      } else {
        const out = parseAmount(get("debit"), decimal);
        const inc = parseAmount(get("credit"), decimal);
        amount = out === null && inc === null ? null : Math.abs(inc ?? 0) - Math.abs(out ?? 0);
      }
      if (amount === null) throw new Error("no amount");
      if (amount === 0) {
        ignored++;
        return;
      }
      const date = parseStatementDate(dateCell, order, opts.timeZone);
      const cellCurrency = text("currency") ? currencyFrom(text("currency")) ?? text("currency").toUpperCase() : null;
      const amountText = typeof get("amount") === "string" ? currencyFrom(String(get("amount")).replace(/[\d\s.,+\-−()]/g, " ")) : null;
      const currency = cellCurrency || amountText || fileCurrency || opts.defaultCurrency;
      if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`unknown currency "${currency}"`);
      const counterparty = text("counterparty");
      const description = text("description");
      const type = text("type");
      const merchant = (counterparty || description || type || "Ismeretlen").slice(0, 200);
      const note = [counterparty && description && description !== counterparty ? description : "", type && type !== merchant ? type : ""]
        .filter(Boolean)
        .join(" · ")
        .slice(0, 2000);
      const ref = text("reference");
      const tx: StatementTx = {
        // A reference column can repeat across files (a customer or creditor id, a per-file row number), so it never stands alone.
        externalId: ref
          ? rowExternalId(["ref", ref, date.slice(0, 10), amount.toFixed(2)], seen)
          : rowExternalId([date, amount.toFixed(2), currency, counterparty, description], seen),
        date,
        amount: Math.round(amount * 100) / 100,
        currency,
        merchant,
        categoryId: categorize(`${counterparty} ${description}`, amount, type),
        source: "import",
      };
      if (note) tx.note = note;
      transactions.push(tx);
    } catch (e) {
      errors.push(`Row ${line}: ${(e as Error).message}`);
    }
  });
  return { columns, mapping, currency: fileCurrency, transactions, ignored, errors };
}
