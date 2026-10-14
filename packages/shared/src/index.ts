// Shared contract between apps/web, apps/mobile and apps/api.
// Amounts are decimal numbers in the transaction's currency; negative = expense, positive = income.

export type TransactionSource = "manual" | "receipt" | "revolut" | "import";

export interface Category {
  id: string;
  name: string;
  /** lucide icon name, e.g. "shopping-cart" */
  icon: string;
  /** hex color, e.g. "#7c9a7e" */
  color: string;
  isCustom: boolean;
  parentId?: string | null;
  /** optional monthly budget in the default currency */
  budget?: number | null;
}

export interface ReceiptItem {
  name: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface Transaction {
  id: string;
  amount: number;
  currency: string;
  /** ISO 8601 date-time */
  date: string;
  merchant: string;
  /** null clears the note on PATCH */
  note?: string | null;
  categoryId: string | null;
  source: TransactionSource;
  items?: ReceiptItem[];
  externalId?: string | null;
}

export interface ReceiptScanResult {
  merchant: string | null;
  date: string | null;
  total: number | null;
  currency: string | null;
  items: ReceiptItem[];
  suggestedCategoryId: string | null;
  /** 0..1 */
  confidence: number;
  rawText?: string;
}

export interface CategorySummary {
  categoryId: string | null;
  total: number;
  count: number;
}

export interface Summary {
  from: string;
  to: string;
  currency: string;
  income: number;
  expense: number;
  byCategory: CategorySummary[];
}

export interface AnalyzeRequest {
  from: string;
  to: string;
  question?: string;
}

export interface Insight {
  title: string;
  detail: string;
  severity: "info" | "positive" | "warning";
}

export interface AnalyzeResponse {
  provider: string;
  model: string;
  summary: string;
  insights: Insight[];
}

export interface RevolutStatus {
  connected: boolean;
  mode: "business-api" | "open-banking" | "csv" | null;
  lastSyncAt: string | null;
  accounts: { id: string; name: string; currency: string; balance: number }[];
}

/** HTTP contract (prefix /api):
 *  GET    /health
 *  GET    /categories                  -> Category[]
 *  POST   /categories                  body Omit<Category,"id"|"isCustom"> -> Category (isCustom=true)
 *  PATCH  /categories/:id              -> Category
 *  DELETE /categories/:id              -> 204 (only custom; transactions fall back to null)
 *  GET    /transactions?from&to&categoryId&q -> Transaction[]
 *  POST   /transactions                -> Transaction
 *  PATCH  /transactions/:id            -> Transaction
 *  DELETE /transactions/:id            -> 204
 *  GET    /summary?from&to             -> Summary
 *  POST   /receipts/scan               multipart "file" (image/jpeg|png|webp|heic, pdf) -> ReceiptScanResult
 *  GET    /revolut/status              -> RevolutStatus
 *  POST   /revolut/sync                -> { imported: number; skipped: number }
 *  POST   /revolut/import-statement    multipart "file" (Revolut CSV/XLSX statement) -> { imported; skipped }
 *  POST   /ai/analyze                  AnalyzeRequest -> AnalyzeResponse
 *  POST   /import                      multipart "file" (.xlsx | .xml) -> { imported; skipped; errors: string[] }
 *  GET    /export?format=xlsx|xml&from&to -> file download
 */
