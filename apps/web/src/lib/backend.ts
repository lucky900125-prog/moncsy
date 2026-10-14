import type {
  AnalyzeRequest, AnalyzeResponse, BackupStatus, Category, ReceiptScanResult, RevolutStatus, StatementMapping, StatementPreview, StatementTx,
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
  /** null in demo mode: the data stays in this browser, there is no server backup to report */
  backupStatus(): Promise<BackupStatus | null>;
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
  backupStatus: () => call("/backup/status"),
  exportFile: async (format, range) => {
    const res = await fetch(getApiBase() + `/export${qs({ format, ...range })}`, withAuth());
    if (!res.ok) throw await errorFrom(res);
    return res.blob();
  },
};

export type Detection = { backend: Backend; error?: string };

const WAKE_TIMEOUT_MS = 90_000;

/**
 * Picks the backend. Without a saved API address it probes the same origin briefly and falls back to the local demo.
 * With a saved address it never falls back: a sleeping free-tier server takes about a minute to start, so it waits
 * (calling onSlow after 1.5 s so the UI can say the server is waking) and reports an error if the API stays unreachable.
 */
export async function detectBackend(onSlow?: () => void): Promise<Detection> {
  const configured = getApiUrlSetting().trim() !== "";
  const ctrl = new AbortController();
  const abort = setTimeout(() => ctrl.abort(), configured ? WAKE_TIMEOUT_MS : 1500);
  const slow = configured && onSlow ? setTimeout(onSlow, 1500) : undefined;
  try {
    const res = await fetch(getApiBase() + "/health", withAuth({ signal: ctrl.signal }));
    // moncsy keeps /health public, so this is for a proxy or another server at that address that asks for auth.
    if (res.status === 401) return { backend: apiBackend, error: (await errorFrom(res)).message };
    if (res.ok && (res.headers.get("content-type") ?? "").includes("json")) {
      // /health is public; it only lists "ai" when the request carried the right token.
      const body = (await res.json()) as { auth?: "token" | "none"; ai?: unknown };
      if (body.auth === "token" && !body.ai) {
        return { backend: apiBackend, error: getApiToken() ? "Az API elutasította a tokent. Ellenőrizd a Beállítások / Kapcsolat alatt." : "Az API tokent kér. Add meg a Beállítások / Kapcsolat alatt." };
      }
      return { backend: apiBackend };
    }
    if (configured) return { backend: apiBackend, error: `Az API (${getApiBase()}) nem a várt választ adta: ${res.status} ${res.statusText}` };
  } catch (e) {
    if (configured) {
      const why = (e as Error).name === "AbortError" ? `${WAKE_TIMEOUT_MS / 1000} másodperc alatt sem válaszolt` : (e as Error).message;
      return { backend: apiBackend, error: `Az API (${getApiBase()}) nem érhető el: ${why}` };
    }
    /* no address saved and nothing on this origin: demo mode, shown in the UI as "Demó mód" */
  } finally {
    clearTimeout(abort);
    clearTimeout(slow);
  }
  return { backend: demoBackend };
}
