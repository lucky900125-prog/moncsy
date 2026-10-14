import type {
  AnalyzeRequest, AnalyzeResponse, Category, ReceiptScanResult, RevolutStatus, StatementMapping, StatementPreview, StatementTx,
  Transaction,
} from "@et/shared";
import { demoBackend } from "./demo";

export type ImportResult = { imported: number; skipped: number; errors?: string[] };
export type TxQuery = { from?: string; to?: string; categoryId?: string; q?: string };

export interface Backend {
  mode: "api" | "demo";
  listCategories(): Promise<Category[]>;
  createCategory(c: Omit<Category, "id" | "isCustom">): Promise<Category>;
  updateCategory(id: string, patch: Partial<Category>): Promise<Category>;
  deleteCategory(id: string): Promise<void>;
  listTransactions(q?: TxQuery): Promise<Transaction[]>;
  createTransaction(t: Omit<Transaction, "id">): Promise<Transaction>;
  updateTransaction(id: string, patch: Partial<Transaction>): Promise<Transaction>;
  deleteTransaction(id: string): Promise<void>;
  scanReceipt(file: File): Promise<ReceiptScanResult>;
  analyze(req: AnalyzeRequest): Promise<AnalyzeResponse>;
  revolutStatus(): Promise<RevolutStatus>;
  revolutSync(): Promise<ImportResult>;
  revolutImportStatement(file: File): Promise<ImportResult>;
  importFile(file: File): Promise<ImportResult>;
  /** Reads any bank statement; nothing is saved until importStatement. */
  parseStatement(file: File, opts?: { mapping?: StatementMapping; currency?: string }): Promise<StatementPreview>;
  importStatement(transactions: StatementTx[]): Promise<ImportResult>;
  exportFile(format: "xlsx" | "xml", range?: { from?: string; to?: string }): Promise<Blob>;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const API_KEY = "moncsy-api";
const TOKEN_KEY = "moncsy-api-token";

function readSetting(key: string) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return ""; // blocked storage behaves as "not set"
  }
}

export const getApiBase = () => readSetting(API_KEY).replace(/\/$/, "") + "/api";
export const getApiUrlSetting = () => readSetting(API_KEY);
export const getApiToken = () => readSetting(TOKEN_KEY);

/** Saves the connection; the caller reloads the page so the backend is detected again. */
export function saveConnection(url: string, token: string) {
  localStorage.setItem(API_KEY, url.trim());
  if (token.trim()) localStorage.setItem(TOKEN_KEY, token.trim());
  else localStorage.removeItem(TOKEN_KEY);
}

function withAuth(init: RequestInit = {}): RequestInit {
  const token = getApiToken();
  if (!token) return init;
  return { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` } };
}

async function errorFrom(res: Response): Promise<ApiError> {
  if (res.status === 401) {
    return new ApiError(401, getApiToken()
      ? "Az API elutasította a tokent. Ellenőrizd a Beállítások / Kapcsolat alatt."
      : "Az API tokent kér. Add meg a Beállítások / Kapcsolat alatt.");
  }
  let msg = `${res.status} ${res.statusText}`;
  try {
    const body = await res.json();
    msg = body.message || body.error || msg;
  } catch { /* body was not JSON; keep status text */ }
  return new ApiError(res.status, msg);
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(getApiBase() + path, withAuth(init));
  if (!res.ok) throw await errorFrom(res);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const upload = (file: File, fields: Record<string, string | undefined> = {}): RequestInit => {
  const fd = new FormData();
  // The server reads text fields only when they come before the file.
  for (const [k, v] of Object.entries(fields)) if (v) fd.append(k, v);
  fd.append("file", file);
  return { method: "POST", body: fd };
};

const qs = (q: Record<string, string | undefined> = {}) => {
  const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]);
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const apiBackend: Backend = {
  mode: "api",
  listCategories: () => call("/categories"),
  createCategory: (c) => call("/categories", json("POST", c)),
  updateCategory: (id, patch) => call(`/categories/${id}`, json("PATCH", patch)),
  deleteCategory: (id) => call(`/categories/${id}`, { method: "DELETE" }),
  listTransactions: (q) => call(`/transactions${qs(q)}`),
  createTransaction: (t) => call("/transactions", json("POST", t)),
  updateTransaction: (id, patch) => call(`/transactions/${id}`, json("PATCH", patch)),
  deleteTransaction: (id) => call(`/transactions/${id}`, { method: "DELETE" }),
  scanReceipt: (file) => call("/receipts/scan", upload(file)),
  analyze: (req) => call("/ai/analyze", json("POST", req)),
  revolutStatus: () => call("/revolut/status"),
  revolutSync: () => call("/revolut/sync", { method: "POST" }),
  revolutImportStatement: (file) => call("/revolut/import-statement", upload(file)),
  importFile: (file) => call("/import", upload(file)),
  parseStatement: (file, opts = {}) =>
    call("/statements/parse", upload(file, { mapping: opts.mapping ? JSON.stringify(opts.mapping) : undefined, currency: opts.currency })),
  importStatement: (transactions) => call("/statements/import", json("POST", { transactions })),
  exportFile: async (format, range) => {
    const res = await fetch(getApiBase() + `/export${qs({ format, ...range })}`, withAuth());
    if (!res.ok) throw await errorFrom(res);
    return res.blob();
  },
};

/** Uses the real API when /api/health answers, otherwise the local demo backend. */
export async function detectBackend(): Promise<Backend> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(getApiBase() + "/health", withAuth({ signal: ctrl.signal }));
    clearTimeout(t);
    // 401 still means the API is there: stay on it so a missing or wrong token shows up as an error, not as demo data.
    if (res.status === 401 || (res.ok && (res.headers.get("content-type") ?? "").includes("json"))) return apiBackend;
  } catch { /* unreachable: fall through to demo, surfaced in the UI as "Demó mód" */ }
  return demoBackend;
}
