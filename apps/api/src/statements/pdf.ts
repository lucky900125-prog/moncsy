import { z } from "zod";
import type { StatementTx } from "@et/shared";
import type { AIProvider } from "../ai/index.js";
import { parseModelJson } from "../ai/json.js";
import { categorize } from "../revolut/categorize.js";
import type { FormatResult } from "./formats.js";
import { rowExternalId } from "./tabular.js";
import { parseStatementDate } from "./values.js";

export const STATEMENT_PROMPT_MARKER = "You are reading a bank account statement";

const PROMPT = `${STATEMENT_PROMPT_MARKER} (PDF). List every booked transaction in it.

- Hungarian statements are common: "Terhelés" means money out, "Jóváírás" money in; "Könyvelés dátuma" is the booking date,
  "Értéknap" the value date. Numbers use a decimal comma and space or dot thousands separators ("1 234,50" = 1234.5).
- Do not list opening and closing balances, subtotals, interest summaries or fee tables that repeat lines already listed.
- openingBalance and closingBalance are the account balance at the start and at the end of the statement period as printed
  ("Nyitó egyenleg", "Záró egyenleg"); null when the statement does not show them.
- amount is negative for money leaving the account and positive for money arriving.
- counterparty is the other party (shop, payee, payer) when it is shown; description is the rest of the line or the remittance text.

Return only this JSON object:
{
  "currency": "HUF" | "EUR" | ... | null,      // the account currency, ISO 4217
  "openingBalance": number | null,
  "closingBalance": number | null,
  "transactions": [{ "date": "YYYY-MM-DD", "amount": number, "currency": string | null, "counterparty": string | null, "description": string | null }]
}
Use null for anything you cannot read; do not guess and do not invent rows.`;

// The limits are far beyond a real statement line and only refuse a runaway answer; the row count is the import's (index.ts).
const schema = z.object({
  currency: z.string().regex(/^[A-Za-z]{3}$/).nullable(),
  // Optional, so an answer without them is read as before, only without the check.
  openingBalance: z.number().finite().nullable().optional(),
  closingBalance: z.number().finite().nullable().optional(),
  transactions: z
    .array(
      z.object({
        // null is what the prompt asks for when a value cannot be read; that row is reported, the rest still import.
        date: z.string().max(40).nullable(),
        amount: z.number().finite().nullable(),
        currency: z.string().max(10).nullable().optional(),
        counterparty: z.string().max(1000).nullable().optional(),
        description: z.string().max(4000).nullable().optional(),
      }),
    )
    .max(20_000),
});

/** PDF statements have no machine-readable table, so the configured AI provider reads them. */
export async function parsePdfStatement(ai: AIProvider, pdf: Buffer, defaultCurrency: string, timeZone: string): Promise<FormatResult> {
  const raw = await ai.vision(pdf.toString("base64"), "application/pdf", PROMPT, { json: true, maxTokens: 16000, temperature: 0 });
  const r = parseModelJson(ai.name, raw, schema);
  const seen = new Map<string, number>();
  const res: FormatResult = { currency: r.currency?.toUpperCase() ?? null, transactions: [], ignored: 0, errors: [] };
  const account = (r.currency ?? defaultCurrency).toUpperCase();
  let sumCents = 0;
  let otherCurrency = false;
  r.transactions.forEach((t, i) => {
    if (t.date == null || t.amount == null) {
      res.errors.push(`Transaction ${i + 1}: unreadable ${t.date == null ? "date" : "amount"}`);
      return;
    }
    if (t.amount === 0) {
      res.ignored++;
      return;
    }
    try {
      const currency = (t.currency ?? r.currency ?? defaultCurrency).toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`invalid currency "${currency}"`);
      const counterparty = t.counterparty?.trim() ?? "";
      const description = t.description?.trim() ?? "";
      if (!/^\d{4}-\d{2}-\d{2}/.test(t.date)) throw new Error(`invalid date "${t.date}"`);
      const date = parseStatementDate(t.date.slice(0, 10), "ymd", timeZone);
      const tx: StatementTx = {
        // Only what the model reads unambiguously: its wording of the counterparty and the text varies between runs,
        // and a re-import must find the same ids. The occurrence suffix separates same-day, same-amount rows.
        externalId: rowExternalId(["pdf", date, t.amount.toFixed(2), currency], seen),
        date,
        amount: Math.round(t.amount * 100) / 100,
        currency,
        merchant: (counterparty || description || "Ismeretlen").slice(0, 200),
        categoryId: categorize(`${counterparty} ${description}`, t.amount),
        source: "import",
      };
      if (counterparty && description) tx.note = description.slice(0, 2000);
      res.transactions.push(tx);
      sumCents += Math.round(t.amount * 100);
      if (currency !== account) otherCurrency = true;
    } catch (e) {
      res.errors.push(`Transaction ${i + 1}: ${(e as Error).message}`);
    }
  });
  // Only a complete list in the account's own currency has to add up to the change in balance.
  const warning = res.errors.length === 0 && !otherCurrency ? balanceWarning(r.openingBalance, r.closingBalance, sumCents, account) : null;
  if (warning) res.errors.push(warning);
  return res;
}

/**
 * The statement's own balances are the one independent check of what the model read: the rows must account for the change
 * between them. A mismatch is a warning, not a refusal, because the rows may still be right and the user decides.
 */
function balanceWarning(opening: number | null | undefined, closing: number | null | undefined, sumCents: number, currency: string): string | null {
  if (opening == null || closing == null) return null;
  const from = Math.round(opening * 100);
  const to = Math.round(closing * 100);
  if (to - from === sumCents) return null;
  const f = (cents: number) => (cents / 100).toFixed(2);
  return (
    `The listed transactions add up to ${f(sumCents)} ${currency}, but the balance moved by ${f(to - from)} ${currency} ` +
    `(from ${f(from)} to ${f(to)}): a row is missing, doubled or misread. Compare the list with the PDF before importing.`
  );
}
