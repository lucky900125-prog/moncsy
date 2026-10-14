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

export type PackUnit = "g" | "kg" | "ml" | "l" | "db";

export interface ReceiptItem {
  /** the line as printed on the receipt */
  name: string;
  quantity: number;
  unitPrice: number;
  total: number;
  /** generic product type in Hungarian, lower case ("tej", "kenyér"); null when unknown */
  product?: string | null;
  brand?: string | null;
  /** package size with packUnit, e.g. 1 + "l"; for goods sold by weight 1 + "kg" (unitPrice is then per kg) */
  packSize?: number | null;
  packUnit?: PackUnit | null;
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
  /** "spending" (default): categories, merchants, months. "products": receipt line items and store prices. */
  scope?: "spending" | "products";
  /** scope "products" only: narrows the products sent to the AI. Matching ignores case and accents. */
  products?: ProductFilter;
}

export interface ProductFilter {
  /** part of the product name or of the receipt line, e.g. "tej" */
  q?: string;
  /** the brand, e.g. "Mizo" */
  brand?: string;
  /** only products bought at least once in this store, e.g. "Spar"; the other stores stay in for comparison */
  merchant?: string;
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

export type StatementFormat = "csv" | "xlsx" | "camt" | "ofx" | "mt940" | "pdf" | "revolut";

/** Columns a tabular statement can be mapped to; amount alone or debit + credit carry the money. */
export type StatementRole =
  | "date"
  | "valueDate"
  | "amount"
  | "debit"
  | "credit"
  | "direction"
  | "currency"
  | "counterparty"
  | "description"
  | "type"
  | "balance"
  | "reference";

export type StatementMapping = Partial<Record<StatementRole, string>>;

/** A transaction read from a bank statement, not yet saved. externalId makes re-imports idempotent. */
export interface StatementTx {
  externalId: string;
  date: string;
  amount: number;
  currency: string;
  merchant: string;
  note?: string;
  categoryId: string | null;
  source: "import" | "revolut";
}

export interface StatementPreview {
  format: StatementFormat;
  /** tabular formats only: the header row found in the file and how it was mapped */
  columns: string[];
  mapping: StatementMapping;
  currency: string | null;
  transactions: StatementTx[];
  /** rows that are not transactions (pending, internal exchange, opening balance) */
  ignored: number;
  errors: string[];
}

/** HTTP contract (prefix /api). When the server has API_TOKEN set, every route except /health
 *  needs "Authorization: Bearer <token>".
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
 *  POST   /statements/parse            multipart "file" (any bank's CSV/XLSX, CAMT.053 XML, OFX, MT940, PDF) and optional
 *                                      fields "mapping" (StatementMapping JSON), "currency" sent before the file -> StatementPreview
 *  POST   /statements/import           { transactions: StatementTx[] } -> { imported; skipped; errors: string[] }
 *  GET    /products?from&to            -> { products: ProductStat[]; stores: StoreRank[] } (from receipt line items;
 *                                      types in "@et/shared/products")
 *  POST   /import                      multipart "file" (.xlsx | .xml) -> { imported; skipped; errors: string[] }
 *  GET    /export?format=xlsx|xml&from&to -> file download
 */
