import { z } from "zod";
import type { Category, ReceiptScanResult } from "@et/shared";
import type { AIProvider } from "../ai/index.js";
import { parseModelJson } from "../ai/json.js";

const num = z.number().finite();

const modelReceiptSchema = z.object({
  merchant: z.string().trim().min(1).nullable(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}/, "expected YYYY-MM-DD")
    .refine((s) => !Number.isNaN(Date.parse(s.slice(0, 10))), "not a real date")
    .transform((s) => s.slice(0, 10))
    .nullable(),
  total: num.nullable(),
  currency: z
    .string()
    .trim()
    .transform((s) => (/^ft\.?$/i.test(s) ? "HUF" : s.toUpperCase()))
    .pipe(z.string().regex(/^[A-Z]{3}$/, "expected ISO 4217 code"))
    .nullable(),
  items: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        quantity: num.default(1),
        unitPrice: num,
        total: num,
        product: z.string().trim().min(1).nullable().default(null).transform((s) => s?.toLocaleLowerCase("hu") ?? null),
        brand: z.string().trim().min(1).nullable().default(null),
        packSize: num.positive().nullable().default(null),
        packUnit: z.enum(["g", "kg", "ml", "l", "db"]).nullable().default(null),
      }),
    )
    .default([]),
  suggestedCategoryId: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  rawText: z.string().optional(),
});

export function receiptPrompt(categories: Category[]): string {
  const cats = categories.map((c) => `- ${c.id}: ${c.name}`).join("\n");
  return `You are reading a photo or PDF of a shopping receipt or invoice. Extract its data.

Hungarian receipts are common:
- "ÖSSZESEN", "FIZETENDŐ" or "VÉGÖSSZEG" marks the grand total; "Ft" or "HUF" means currency HUF.
- "ÁFA" lines are VAT breakdowns, not purchased items; do not list them as items and do not add them to the total.
- Numbers use a decimal comma and space or dot thousands separators ("1 234,50" = 1234.5).
- Dates are usually written "2026.10.14." or "2026.10.14 13:45"; output them as YYYY-MM-DD.
- Lines like "2 db x 389" mean quantity 2, unit price 389.
- Ignore payment/change lines ("KÉSZPÉNZ", "VISSZAJÁRÓ", "BANKKÁRTYA") when listing items.
- A discount line ("KEDVEZMÉNY", "AKCIÓ -120") belongs to the item above it: lower that item's total and unitPrice instead of listing it.

For every item also give, so the same product can be compared across stores:
- "product": the generic product in Hungarian, lower case, singular, without brand or size ("tej", "kenyér", "trappista sajt", "banán").
- "brand": the brand when the line or your knowledge of the store's own labels shows it ("Mizo", "Pilos", "Spar"), else null.
- "packSize" + "packUnit": the package size printed in the name ("1l" -> 1 + "l", "500g" -> 500 + "g", "6x1,5l" -> 9 + "l",
  "10 db" -> 10 + "db"). For goods sold by weight ("0,746 kg x 599 Ft/kg") use quantity = the weight, unitPrice = the price
  per kg, packSize 1, packUnit "kg". null when the size is not shown.

Choose suggestedCategoryId from exactly one of these category ids (or null if none fits):
${cats}

Return only this JSON object, with numbers as JSON numbers (no currency symbols, no thousands separators):
{
  "merchant": string | null,          // store or company name
  "date": "YYYY-MM-DD" | null,
  "total": number | null,             // grand total actually paid, positive
  "currency": "HUF" | "EUR" | ... | null,  // ISO 4217
  "items": [{ "name": string, "quantity": number, "unitPrice": number, "total": number,
               "product": string | null, "brand": string | null, "packSize": number | null, "packUnit": "g" | "kg" | "ml" | "l" | "db" | null }],
  "suggestedCategoryId": string | null,
  "confidence": number,               // 0..1, how sure you are about merchant/date/total
  "rawText": string                   // the receipt text as you read it
}
Use null for anything you cannot read; do not guess.`;
}

export async function scanReceipt(
  ai: AIProvider,
  categories: Category[],
  fileBase64: string,
  mime: string,
): Promise<ReceiptScanResult> {
  const raw = await ai.vision(fileBase64, mime, receiptPrompt(categories), { json: true, maxTokens: 4000, temperature: 0 });
  const r = parseModelJson(ai.name, raw, modelReceiptSchema);
  const known = new Set(categories.map((c) => c.id));
  const out: ReceiptScanResult = {
    merchant: r.merchant,
    date: r.date,
    total: r.total,
    currency: r.currency,
    items: r.items,
    // A category id the model invented is dropped (null = "no suggestion"), not mapped to a guess.
    suggestedCategoryId: r.suggestedCategoryId && known.has(r.suggestedCategoryId) ? r.suggestedCategoryId : null,
    confidence: r.confidence,
  };
  if (r.rawText !== undefined) out.rawText = r.rawText;
  return out;
}
