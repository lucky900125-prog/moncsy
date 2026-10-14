import { z } from "zod";
import { HttpError } from "./errors.js";

/** Accepts any string Date can parse; normalized to full ISO 8601 (UTC) by the repository. */
export const isoDate = z
  .string()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: "Invalid date (expected ISO 8601)" });

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, "Expected hex color like #7c9a7e");
const currency = z
  .string()
  .regex(/^[A-Za-z]{3}$/, "Expected ISO 4217 currency code")
  .transform((s) => s.toUpperCase());

export const receiptItemSchema = z.object({
  name: z.string(),
  quantity: z.number().finite(),
  unitPrice: z.number().finite(),
  total: z.number().finite(),
});

export const categoryCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  icon: z.string().trim().min(1).max(64),
  color: hexColor,
  parentId: z.string().min(1).nullable().optional(),
  budget: z.number().finite().nonnegative().nullable().optional(),
});
export const categoryPatchSchema = categoryCreateSchema.partial();

export const transactionSourceSchema = z.enum(["manual", "receipt", "revolut", "import"]);

export const transactionCreateSchema = z.object({
  amount: z.number().finite(),
  currency,
  date: isoDate,
  merchant: z.string().trim().max(200),
  note: z.string().max(2000).optional(),
  categoryId: z.string().min(1).nullable().default(null),
  source: transactionSourceSchema.default("manual"),
  items: z.array(receiptItemSchema).optional(),
  externalId: z.string().min(1).nullable().optional(),
});
export const transactionPatchSchema = z
  .object({
    amount: z.number().finite(),
    currency,
    date: isoDate,
    merchant: z.string().trim().max(200),
    note: z.string().max(2000).nullable(),
    categoryId: z.string().min(1).nullable(),
    source: transactionSourceSchema,
    items: z.array(receiptItemSchema).nullable(),
    externalId: z.string().min(1).nullable(),
  })
  .partial();

export const transactionQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  categoryId: z.string().min(1).optional(),
  q: z.string().optional(),
});

export const summaryQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  currency: currency.optional(),
});

export const analyzeRequestSchema = z.object({
  from: isoDate,
  to: isoDate,
  question: z.string().max(2000).optional(),
});

export const exportQuerySchema = z.object({
  format: z.enum(["xlsx", "xml"]).default("xlsx"),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export type TransactionCreate = z.infer<typeof transactionCreateSchema>;
export type TransactionPatch = z.infer<typeof transactionPatchSchema>;
export type CategoryCreate = z.infer<typeof categoryCreateSchema>;
export type CategoryPatch = z.infer<typeof categoryPatchSchema>;

export function parseOrThrow<T extends z.ZodType>(schema: T, data: unknown, what = "request"): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new HttpError(400, `Invalid ${what}: ${issues.join("; ")}`, issues);
  }
  return r.data;
}
