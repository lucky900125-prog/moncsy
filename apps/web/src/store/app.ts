import { useMemo } from "react";
import { create } from "zustand";
import type { Category, Transaction } from "@et/shared";
import { detectBackend, type Backend } from "@/lib/backend";

type Status = "loading" | "ready" | "error";

interface AppState {
  status: Status;
  error: string | null;
  backend: Backend | null;
  categories: Category[];
  transactions: Transaction[];
  init(): Promise<void>;
  refresh(): Promise<void>;
  addTransaction(t: Omit<Transaction, "id">): Promise<Transaction>;
  updateTransaction(id: string, patch: Partial<Transaction>): Promise<void>;
  removeTransaction(id: string): Promise<void>;
  addCategory(c: Omit<Category, "id" | "isCustom">): Promise<Category>;
  updateCategory(id: string, patch: Partial<Category>): Promise<void>;
  removeCategory(id: string): Promise<void>;
}

const sortTx = (a: Transaction[]) => [...a].sort((x, y) => y.date.localeCompare(x.date));

export const useApp = create<AppState>((set, get) => {
  const be = () => {
    const b = get().backend;
    if (!b) throw new Error("A háttérszolgáltatás még nem állt fel");
    return b;
  };
  return {
    status: "loading",
    error: null,
    backend: null,
    categories: [],
    transactions: [],
    async init() {
      const backend = await detectBackend();
      set({ backend });
      await get().refresh();
    },
    async refresh() {
      try {
        const [categories, transactions] = await Promise.all([be().listCategories(), be().listTransactions()]);
        set({ categories, transactions: sortTx(transactions), status: "ready", error: null });
      } catch (e) {
        set({ status: "error", error: (e as Error).message });
      }
    },
    async addTransaction(t) {
      const tx = await be().createTransaction(t);
      set({ transactions: sortTx([tx, ...get().transactions]) });
      return tx;
    },
    async updateTransaction(id, patch) {
      const tx = await be().updateTransaction(id, patch);
      set({ transactions: sortTx(get().transactions.map((t) => (t.id === id ? tx : t))) });
    },
    async removeTransaction(id) {
      await be().deleteTransaction(id);
      set({ transactions: get().transactions.filter((t) => t.id !== id) });
    },
    async addCategory(c) {
      const cat = await be().createCategory(c);
      set({ categories: [...get().categories, cat] });
      return cat;
    },
    async updateCategory(id, patch) {
      const cat = await be().updateCategory(id, patch);
      set({ categories: get().categories.map((c) => (c.id === id ? cat : c)) });
    },
    async removeCategory(id) {
      await be().deleteCategory(id);
      set({
        categories: get().categories.filter((c) => c.id !== id),
        transactions: get().transactions.map((t) => (t.categoryId === id ? { ...t, categoryId: null } : t)),
      });
    },
  };
});

/** Memoized per categories array, so it is a stable useMemo/useEffect dependency in pages. */
export function useCategoryMap() {
  const categories = useApp((s) => s.categories);
  return useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
}
