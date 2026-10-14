import { zonedToUtc } from "../revolut/csv.js";

/** Lower case, no accents, single spaces: the form header names and keywords are compared in. */
export const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s\u00a0\u202f]+/g, " ")
    .trim();

export type DecimalSep = "," | ".";

/**
 * Which character a column uses as the decimal separator, judged from all its values at once:
 * "1.234" alone is ambiguous, but not next to "12,50" or "1,234.00".
 * Hungarian banks use a decimal comma, so with no evidence either way the comma wins.
 */
export function detectDecimal(values: unknown[]): DecimalSep {
  let comma = 0;
  let dot = 0;
  for (const v of values) {
    if (typeof v !== "string") continue;
    const s = v.replace(/[^\d.,]/g, "");
    const lc = s.lastIndexOf(",");
    const ld = s.lastIndexOf(".");
    if (lc >= 0 && ld >= 0) {
      if (lc > ld) comma++;
      else dot++;
    } else if (lc >= 0) {
      if (/,\d{1,2}$/.test(s) || (s.match(/,/g) ?? []).length === 1 && !/,\d{3}$/.test(s)) comma++;
      else if (/^\d{1,3}(,\d{3})+$/.test(s)) dot++;
    } else if (ld >= 0) {
      if (/\.\d{1,2}$/.test(s) || /\.\d{4,}$/.test(s)) dot++;
      else if (/^\d{1,3}(\.\d{3})+$/.test(s)) comma++;
    }
  }
  return dot > comma ? "." : ",";
}

/**
 * "1 234,56", "-1.234,56", "1,234.56", "1234,56-", "(12.50)", "-12 000 Ft", "HUF 5 000" -> number.
 * Returns null for an empty cell; throws for text that is not a number.
 */
export function parseAmount(v: unknown, decimal: DecimalSep): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  if (s === "") return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  // Only a currency next to the number is dropped; any other text makes it "not an amount".
  s = s
    .replace(/[\s\u00a0\u202f']/g, "")
    .replace(/^([A-Za-z]{3})(?=[-+−(\d.,])|(?<=[\d.,)-])([A-Za-z]{3})$/, (m) => (KNOWN_CURRENCIES.has(m.toUpperCase()) ? "" : m))
    .replace(/(?<=[\d.,)-])ft\.?$/i, "")
    .replace(/[€$£]/g, "");
  if (s.startsWith("+")) s = s.slice(1);
  if (s.startsWith("-") || s.startsWith("−")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.endsWith("-")) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (s === "") return null;
  const thousands = decimal === "," ? "." : ",";
  s = s.split(thousands).join("");
  if (decimal === ",") s = s.replace(",", ".");
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) throw new Error(`not an amount: "${String(v)}"`);
  const n = Number(s);
  return negative ? -n : n;
}

export type DateOrder = "ymd" | "dmy" | "mdy";

const DATE_RE = /^(\d{1,4})[.\-/ ](\d{1,2})[.\-/ ](\d{1,4})\.?(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/;

/** Year-first is unambiguous; for "01/02/2026" any part above 12 settles it, and day-first wins a tie (European banks). */
export function detectDateOrder(values: unknown[]): DateOrder {
  let dmy = 0;
  let mdy = 0;
  for (const v of values) {
    if (typeof v !== "string") continue;
    const m = v.trim().match(DATE_RE);
    if (!m) continue;
    if (m[1]!.length === 4) return "ymd";
    if (+m[1]! > 12) dmy++;
    if (+m[2]! > 12) mdy++;
  }
  return mdy > dmy ? "mdy" : "dmy";
}

/** Days since 1899-12-30, the Excel epoch, for cells that arrive as plain serial numbers. */
function fromExcelSerial(n: number): Date {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000));
}

/**
 * A statement date in the bank's local time (STATEMENT_TZ), returned as an ISO instant.
 * A date without a time becomes local noon, so it stays on the same calendar day in any nearby time zone.
 */
export function parseStatementDate(v: unknown, order: DateOrder, timeZone: string): string {
  let y: number, mo: number, d: number;
  let h = 12;
  let mi = 0;
  let s = 0;
  if (v instanceof Date || typeof v === "number") {
    // Excel keeps wall-clock time encoded as UTC.
    const dt = v instanceof Date ? v : fromExcelSerial(v);
    if (Number.isNaN(dt.getTime())) throw new Error(`invalid date "${String(v)}"`);
    [y, mo, d] = [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
    const hasTime = dt.getUTCHours() || dt.getUTCMinutes() || dt.getUTCSeconds();
    if (hasTime) [h, mi, s] = [dt.getUTCHours(), dt.getUTCMinutes(), dt.getUTCSeconds()];
  } else {
    const str = String(v ?? "").trim();
    const compact = str.match(/^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?/); // OFX / CAMT style 20261014[1200]
    const m = str.match(DATE_RE);
    if (m) {
      const [a, b, c] = [+m[1]!, +m[2]!, +m[3]!];
      if (m[1]!.length === 4) [y, mo, d] = [a, b, c];
      else if (order === "mdy") [y, mo, d] = [c, a, b];
      else [y, mo, d] = [c, b, a];
      if (y < 100) y += 2000;
      if (m[4] !== undefined) [h, mi, s] = [+m[4], +m[5]!, +(m[6] ?? 0)];
    } else if (compact) {
      [y, mo, d] = [+compact[1]!, +compact[2]!, +compact[3]!];
      if (compact[4] !== undefined) [h, mi, s] = [+compact[4], +compact[5]!, +(compact[6] ?? 0)];
    } else {
      throw new Error(`invalid date "${str}"`);
    }
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) throw new Error(`invalid date "${String(v)}"`);
  return zonedToUtc(y, mo, d, h, mi, s, timeZone).toISOString();
}

/** ISO 4217 code from a cell or a header like "Összeg (HUF)"; "Ft" means HUF. */
export function currencyFrom(text: string): string | null {
  const t = text.trim();
  if (/^ft\.?$|\bft\b|forint/i.test(t)) return "HUF";
  const m = t.toUpperCase().match(/\b([A-Z]{3})\b/);
  return m && KNOWN_CURRENCIES.has(m[1]!) ? m[1]! : null;
}

const KNOWN_CURRENCIES = new Set([
  "HUF", "EUR", "USD", "GBP", "CHF", "PLN", "CZK", "RON", "SEK", "NOK", "DKK", "JPY", "CAD", "AUD", "CNY", "HRK", "BGN", "RSD", "TRY", "UAH",
]);
