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
- Skip opening and closing balances, subtotals, interest summaries and fee tables that repeat lines already listed.
- amount is negative for money leaving the account and positive for money arriving.
- counterparty is the other party (shop, payee, payer) when it is shown; description is the rest of the line or the remittance text.

Return only this JSON object:
{
  "currency": "HUF" | "EUR" | ... | null,      // the account currency, ISO 4217
  "transactions": [{ "date": "YYYY-MM-DD", "amount": number, "currency": string | null, "counterparty": string | null, "description": string | null }]
}
Use null for anything you cannot read; do not guess and do not invent rows.`;

const schema = z.object({
  currency: z.string().regex(/^[A-Za-z]{3}$/).nullable(),
  transactions: z.array(
    z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
      amount: z.number().finite(),
      currency: z.string().regex(/^[A-Za-z]{3}$/).nullable().optional(),
      counterparty: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
    }),
  ),
});

/** PDF statements have no machine-readable table, so the configured AI provider reads them. */
export async function parsePdfStatement(ai: AIProvider, pdf: Buffer, defaultCurrency: string, timeZone: string): Promise<FormatResult> {
  const raw = await ai.vision(pdf.toString("base64"), "application/pdf", PROMPT, { json: true, maxTokens: 16000, temperature: 0 });
  const r = parseModelJson(ai.name, raw, schema);
  const seen = new Map<string, number>();
  const res: FormatResult = { currency: r.currency?.toUpperCase() ?? null, transactions: [], ignored: 0, errors: [] };
  r.transactions.forEach((t, i) => {
    if (t.amount === 0) {
      res.ignored++;
      return;
    }
    try {
      const currency = (t.currency ?? r.currency ?? defaultCurrency).toUpperCase();
      const counterparty = t.counterparty?.trim() ?? "";
      const description = t.description?.trim() ?? "";
      const date = parseStatementDate(t.date.slice(0, 10), "ymd", timeZone);
      const tx: StatementTx = {
        externalId: rowExternalId([date, t.amount.toFixed(2), currency, counterparty, description], seen),
        date,
        amount: Math.round(t.amount * 100) / 100,
        currency,
        merchant: (counterparty || description || "Ismeretlen").slice(0, 200),
        categoryId: categorize(`${counterparty} ${description}`, t.amount),
        source: "import",
      };
      if (counterparty && description) tx.note = description.slice(0, 2000);
      res.transactions.push(tx);
    } catch (e) {
      res.errors.push(`Transaction ${i + 1}: ${(e as Error).message}`);
    }
  });
  return res;
}
