import type {
  AnalyzeRequest, AnalyzeResponse, Category, ReceiptScanResult, RevolutStatus, Transaction,
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
  exportFile(format: "xlsx" | "xml", range?: { from?: string; to?: string }): Promise<Blob>;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function getApiBase() {
  try {
    return (localStorage.getItem("moncsy-api") || "").replace(/\/$/, "") + "/api";
  } catch {
    return "/api";
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(getApiBase() + path, init);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      msg = body.message || body.error || msg;
    } catch { /* body was not JSON; keep status text */ }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const upload = (file: File): RequestInit => {
  const fd = new FormData();
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
  exportFile: async (format, range) => {
    const res = await fetch(getApiBase() + `/export${qs({ format, ...range })}`);
    if (!res.ok) throw new ApiError(res.status, `Export sikertelen: ${res.status} ${res.statusText}`);
    return res.blob();
  },
};

/** Uses the real API when /api/health answers, otherwise the local demo backend. */
export async function detectBackend(): Promise<Backend> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(getApiBase() + "/health", { signal: ctrl.signal });
    clearTimeout(t);
    if (res.ok && (res.headers.get("content-type") ?? "").includes("json")) return apiBackend;
  } catch { /* unreachable: fall through to demo, surfaced in the UI as "Demó mód" */ }
  return demoBackend;
}
