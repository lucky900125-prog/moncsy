import { z } from "zod";
import type { Category, Transaction } from "@et/shared";
import type { Repository } from "../repository.js";
import { categoryCreateSchema, transactionCreateSchema } from "../schemas.js";

/** A record pulled from an import file, with a human-readable location for error messages. */
export interface RawRecord {
  where: string;
  data: Record<string, unknown>;
}

export interface ImportPayload {
  categories: RawRecord[];
  transactions: RawRecord[];
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

export interface ExportPayload {
  categories: Category[];
  transactions: Transaction[];
}

const emptyToUndef = (v: unknown) => (v === "" || v === null ? undefined : v);
const emptyToNull = (v: unknown) => (v === "" || v === undefined ? null : v);
const numeric = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? Number(v.replace(",", ".")) : v);
const bool = (v: unknown) => (typeof v === "string" ? ["true", "1", "yes", "igen"].includes(v.trim().toLowerCase()) : v);

const importCategorySchema = categoryCreateSchema.extend({
  id: z.preprocess(emptyToUndef, z.string().min(1).optional()),
  isCustom: z.preprocess((v) => (v === "" || v == null ? true : bool(v)), z.boolean()),
  parentId: z.preprocess(emptyToNull, z.string().min(1).nullable()),
  budget: z.preprocess((v) => (v === "" || v == null ? null : numeric(v)), z.number().finite().nonnegative().nullable()),
});

const importTransactionSchema = transactionCreateSchema.extend({
  id: z.preprocess(emptyToUndef, z.string().min(1).optional()),
  amount: z.preprocess(numeric, z.number().finite()),
  merchant: z.preprocess((v) => (v == null ? "" : String(v)), z.string().trim().max(200)),
  note: z.preprocess((v) => (v == null || v === "" ? undefined : String(v)), z.string().max(2000).optional()),
  categoryId: z.preprocess(emptyToNull, z.string().min(1).nullable()),
  category: z.preprocess(emptyToUndef, z.string().optional()),
  source: z.preprocess((v) => emptyToUndef(v) ?? "import", transactionCreateSchema.shape.source),
  externalId: z.preprocess(emptyToNull, z.string().min(1).nullable()),
  items: z.preprocess(
    (v) => {
      if (v === "" || v == null) return undefined;
      if (typeof v === "string") {
        try {
          return JSON.parse(v);
        } catch {
          return v;
        }
      }
      return v;
    },
    z
      .array(
        z.object({
          name: z.preprocess((v) => (v == null ? "" : String(v)), z.string()),
          quantity: z.preprocess(numeric, z.number().finite()),
          unitPrice: z.preprocess(numeric, z.number().finite()),
          total: z.preprocess(numeric, z.number().finite()),
          product: z.preprocess(emptyToNull, z.string().nullable()).optional(),
          brand: z.preprocess(emptyToNull, z.string().nullable()).optional(),
          packSize: z.preprocess((v) => (v === "" || v == null ? null : numeric(v)), z.number().finite().positive().nullable()).optional(),
          packUnit: z.preprocess(emptyToNull, z.enum(["g", "kg", "ml", "l", "db"]).nullable()).optional(),
        }),
      )
      .optional(),
  ),
});

const fmtIssues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "(row)"}: ${i.message}`).join("; ");

/**
 * Applies an import. Rows are independent: a bad row lands in errors[] and the rest still import.
 * Existing ids / externalIds are skipped (never overwritten), so re-importing an export is a no-op.
 * imported / skipped count category and transaction rows together.
 */
export async function applyImport(repo: Repository, payload: ImportPayload): Promise<ImportResult> {
  const res: ImportResult = { imported: 0, skipped: 0, errors: [] };
  await repo.withTx(async (repo) => {
    const parents: [string, string, string][] = [];
    for (const rec of payload.categories) {
      const p = importCategorySchema.safeParse(rec.data);
      if (!p.success) {
        res.errors.push(`${rec.where}: ${fmtIssues(p.error)}`);
        continue;
      }
      const c = p.data;
      if (c.id && (await repo.getCategory(c.id))) {
        res.skipped++;
        continue;
      }
      const created = await repo.createCategory(
        { name: c.name, icon: c.icon, color: c.color, budget: c.budget, parentId: null },
        { id: c.id, isCustom: c.isCustom },
      );
      if (c.parentId) parents.push([created.id, c.parentId, rec.where]);
      res.imported++;
    }
    for (const [id, parentId, where] of parents) {
      if (!(await repo.getCategory(parentId))) res.errors.push(`${where}: parentId "${parentId}" not found; imported without parent`);
      else await repo.updateCategory(id, { parentId });
    }

    const byName = new Map((await repo.listCategories()).map((c) => [c.name.toLocaleLowerCase("hu"), c.id] as const));
    for (const rec of payload.transactions) {
      const p = importTransactionSchema.safeParse(rec.data);
      if (!p.success) {
        res.errors.push(`${rec.where}: ${fmtIssues(p.error)}`);
        continue;
      }
      const { id, category, ...t } = p.data;
      if ((id && (await repo.getTransaction(id))) || (t.externalId && (await repo.hasExternalId(t.externalId)))) {
        res.skipped++;
        continue;
      }
      if (t.categoryId && !(await repo.getCategory(t.categoryId))) {
        res.errors.push(`${rec.where}: unknown categoryId "${t.categoryId}"`);
        continue;
      }
      if (!t.categoryId && category) {
        const found = byName.get(category.toLocaleLowerCase("hu"));
        if (!found) {
          res.errors.push(`${rec.where}: unknown category "${category}"`);
          continue;
        }
        t.categoryId = found;
      }
      try {
        await repo.createTransaction(t, { id });
        res.imported++;
      } catch (e) {
        res.errors.push(`${rec.where}: ${(e as Error).message}`);
      }
    }
  });
  return res;
}
