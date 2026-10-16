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

/**
 * Built-in categories. The API seeds them (idempotently, so a new entry here reaches existing
 * databases on the next start) and the web demo mode starts from them. Ids are stable English
 * slugs; name, icon and color are defaults the user may edit.
 */
export const DEFAULT_CATEGORIES = [
  { id: "groceries", name: "Élelmiszer", icon: "shopping-cart", color: "#7c9a7e" },
  { id: "restaurant", name: "Étterem", icon: "utensils-crossed", color: "#c4956c" },
  { id: "transport", name: "Közlekedés", icon: "bus", color: "#8aa6b8" },
  { id: "housing", name: "Lakhatás", icon: "home", color: "#9d8fb5" },
  { id: "utilities", name: "Rezsi", icon: "zap", color: "#c9a66b" },
  { id: "entertainment", name: "Szórakozás", icon: "film", color: "#b5899f" },
  { id: "health", name: "Egészség", icon: "heart-pulse", color: "#b88a8a" },
  { id: "clothing", name: "Ruházat", icon: "shirt", color: "#7fa8a3" },
  { id: "travel", name: "Utazás", icon: "plane", color: "#8f9bb3" },
  { id: "subscriptions", name: "Előfizetések", icon: "repeat", color: "#a3a86b" },
  { id: "other", name: "Egyéb", icon: "package", color: "#94a3a8" },
  { id: "income", name: "Bevétel", icon: "wallet", color: "#6f8f73" },
] as const satisfies readonly Pick<Category, "id" | "name" | "icon" | "color">[];

export type DefaultCategoryId = (typeof DEFAULT_CATEGORIES)[number]["id"];

/** Icons a category may use (lucide kebab-case names, stored in Category.icon). Web and mobile each map these to their lucide package. */
export const CATEGORY_ICON_NAMES = [
  "shopping-cart", "shopping-bag", "utensils-crossed", "coffee", "bus", "train", "car", "fuel", "home", "zap", "wifi", "film",
  "gamepad-2", "music", "heart-pulse", "pill", "shirt", "plane", "repeat", "package", "wallet", "gift", "graduation-cap",
  "paw-print", "baby", "dumbbell", "smartphone", "wrench", "briefcase", "landmark", "sparkles", "book-open", "beer", "circle-ellipsis",
] as const;

export type CategoryIconName = (typeof CATEGORY_ICON_NAMES)[number];

/** Icon names older databases may still hold, mapped onto the current set. */
export const CATEGORY_ICON_ALIASES: Readonly<Record<string, CategoryIconName>> = { utensils: "utensils-crossed", house: "home" };

/** Resolves a stored icon name to one of CATEGORY_ICON_NAMES, or null when it is unknown. */
export function resolveCategoryIcon(name: string | null | undefined): CategoryIconName | null {
  if (!name) return null;
  const n = CATEGORY_ICON_ALIASES[name] ?? name;
  return (CATEGORY_ICON_NAMES as readonly string[]).includes(n) ? (n as CategoryIconName) : null;
}

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
  /** one of GET /ai/providers' configured ids; left out = the server's default */
  provider?: AIProviderId;
  /** one of that provider's models (or any name when customModel); left out = its defaultModel */
  model?: string;
}

export type AIProviderId = "anthropic" | "openai" | "gemini" | "ollama" | "mock";

/** GET /ai/providers. Keys stay on the server; keyEnv is only the name of the variable that holds one. */
export interface AIProvidersResponse {
  default: { provider: string; model: string };
  providers: AIProviderInfo[];
}

export interface AIProviderInfo {
  id: AIProviderId;
  label: string;
  /** false: the server has no key for it, so it cannot be chosen */
  configured: boolean;
  /** the models it may be asked for, defaultModel first */
  models: string[];
  defaultModel: string;
  /** true: a model name that is not on the list may be sent too */
  customModel: boolean;
  /** the server variable that holds its key, e.g. "GEMINI_API_KEY"; null when it needs none */
  keyEnv: string | null;
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

/** GET /backup/status. The copy of the database in a private GitHub repository, for hosts whose disk is wiped on restart. */
export interface BackupStatus {
  enabled: boolean;
  /** when the newest copy was made; survives restarts, since it is restored with the database */
  lastBackupAt: string | null;
  /** generation of the newest copy this database knows of; counts up by one per upload */
  generation: number | null;
  /** the last upload failed with this; uploads are retried */
  lastError: string | null;
  /** changes are waiting to be uploaded */
  pending: boolean;
  /** uploads stopped because the remote copy is not the one this database came from; lastError says why. Needs a restart. */
  stopped: boolean;
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
 *  GET    /backup/status               -> BackupStatus
 *  GET    /categories                  -> Category[]
 *  POST   /categories                  body Omit<Category,"id"|"isCustom"> -> Category (isCustom=true)
 *  PATCH  /categories/:id              -> Category
 *  DELETE /categories/:id              -> 204 (only custom; transactions fall back to null)
 *  GET    /transactions?from&to&categoryId&q -> Transaction[]
 *  POST   /transactions                -> Transaction
 *  PATCH  /transactions/:id            -> Transaction
 *  DELETE /transactions/:id            -> 204
 *  GET    /summary?from&to             -> Summary
 *  POST   /receipts/scan               multipart "file" (image/jpeg|png|webp|heic, pdf) and optional fields "provider",
 *                                      "model" sent before the file -> ReceiptScanResult
 *  GET    /ai/providers                -> AIProvidersResponse
 *  GET    /revolut/status              -> RevolutStatus
 *  POST   /revolut/sync                -> { imported: number; skipped: number }
 *  POST   /revolut/import-statement    multipart "file" (Revolut CSV/XLSX statement) -> { imported; skipped }
 *  POST   /ai/analyze                  AnalyzeRequest -> AnalyzeResponse
 *  POST   /statements/parse            multipart "file" (any bank's CSV/XLSX, CAMT.053 XML, OFX, MT940, PDF) and optional
 *                                      fields "mapping" (StatementMapping JSON), "currency", "provider", "model" (for a PDF) sent
 *                                      before the file -> StatementPreview
 *  POST   /statements/import           { transactions: StatementTx[] } -> { imported; skipped; errors: string[] }
 *  GET    /products?from&to            -> { products: ProductStat[]; stores: StoreRank[] } (from receipt line items;
 *                                      types in "@et/shared/products")
 *  POST   /import                      multipart "file" (.xlsx | .xml) -> { imported; skipped; errors: string[] }
 *  GET    /export?format=xlsx|xml&from&to -> file download
 */
