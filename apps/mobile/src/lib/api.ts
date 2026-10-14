import AsyncStorage from "@react-native-async-storage/async-storage";
import type { AnalyzeRequest, AnalyzeResponse, Category, ReceiptScanResult, Transaction } from "@et/shared";

const KEY = "moncsy-api";
// On a phone "localhost" is the phone itself, so the API address must be set (or baked in via EXPO_PUBLIC_API_URL).
const DEFAULT_BASE = process.env.EXPO_PUBLIC_API_URL ?? "";

let base: string | null = null;

export async function getApiUrl() {
  if (base === null) base = (await AsyncStorage.getItem(KEY)) ?? DEFAULT_BASE;
  return base ?? "";
}

export async function setApiUrl(url: string) {
  base = url.trim().replace(/\/$/, "");
  await AsyncStorage.setItem(KEY, base);
}

export class ApiError extends Error {}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const root = await getApiUrl();
  if (!root) throw new ApiError("Nincs beállítva az API címe. Add meg a Beállításokban.");
  let res: Response;
  try {
    res = await fetch(`${root}/api${path}`, init);
  } catch (e) {
    throw new ApiError(`Az API nem érhető el (${root}): ${(e as Error).message}`);
  }
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const body = await res.json();
      msg = body.error ?? body.message ?? msg;
    } catch { /* body was not JSON; keep the status code */ }
    throw new ApiError(msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  health: () => call<{ status: string; ai: { provider: string; model: string } }>("/health"),
  categories: () => call<Category[]>("/categories"),
  transactions: () => call<Transaction[]>("/transactions"),
  createTransaction: (t: Omit<Transaction, "id">) => call<Transaction>("/transactions", json("POST", t)),
  updateTransaction: (id: string, t: Partial<Transaction>) => call<Transaction>(`/transactions/${id}`, json("PATCH", t)),
  deleteTransaction: (id: string) => call<void>(`/transactions/${id}`, { method: "DELETE" }),
  analyze: (req: AnalyzeRequest) => call<AnalyzeResponse>("/ai/analyze", json("POST", req)),
  scanReceipt: (uri: string, mime: string, name: string) => {
    const fd = new FormData();
    // React Native's FormData takes a { uri, type, name } file descriptor.
    fd.append("file", { uri, type: mime, name } as unknown as Blob);
    return call<ReceiptScanResult>("/receipts/scan", { method: "POST", body: fd });
  },
};
