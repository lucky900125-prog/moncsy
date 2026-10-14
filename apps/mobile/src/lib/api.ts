import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import type { AnalyzeRequest, AnalyzeResponse, BackupStatus, Category, ReceiptScanResult, Transaction } from "@et/shared";

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

// The token is a credential: on iOS/Android it goes to the Keychain/Keystore. SecureStore has no web implementation,
// so the Expo web build keeps it in AsyncStorage (browser localStorage), like the web PWA does.
const TOKEN_KEY = "moncsy-token";
const tokenStore = Platform.OS === "web"
  ? { get: () => AsyncStorage.getItem(TOKEN_KEY), set: (v: string) => AsyncStorage.setItem(TOKEN_KEY, v), clear: () => AsyncStorage.removeItem(TOKEN_KEY) }
  : { get: () => SecureStore.getItemAsync(TOKEN_KEY), set: (v: string) => SecureStore.setItemAsync(TOKEN_KEY, v), clear: () => SecureStore.deleteItemAsync(TOKEN_KEY) };

let token: string | null = null;

export async function getApiToken() {
  if (token === null) token = (await tokenStore.get()) ?? "";
  return token;
}

export async function setApiToken(value: string) {
  const v = value.trim();
  if (v) await tokenStore.set(v);
  else await tokenStore.clear();
  token = v;
}

export class ApiError extends Error {}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const root = await getApiUrl();
  if (!root) throw new ApiError("Nincs beállítva az API címe. Add meg a Beállításokban.");
  const auth = await getApiToken();
  const headers = new Headers(init?.headers);
  if (auth) headers.set("Authorization", `Bearer ${auth}`);
  let res: Response;
  try {
    res = await fetch(`${root}/api${path}`, { ...init, headers });
  } catch (e) {
    throw new ApiError(`Az API nem érhető el (${root}): ${(e as Error).message}`);
  }
  if (res.status === 401) {
    throw new ApiError(auth ? "Az API elutasította a tokent. Ellenőrizd a Beállításokban." : "Az API tokent kér. Add meg a Beállításokban.");
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
  // /health is public; "ai" is only in the answer when the request carried the right token.
  health: () => call<{ status: string; auth?: "token" | "none"; ai?: { provider: string; model: string }; backup?: BackupStatus }>("/health"),
  backupStatus: () => call<BackupStatus>("/backup/status"),
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
