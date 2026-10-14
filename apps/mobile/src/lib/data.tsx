import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Category, Transaction } from "@et/shared";
import { api } from "./api";

type State = {
  loading: boolean;
  error: string | null;
  categories: Category[];
  categoryMap: Map<string, Category>;
  transactions: Transaction[];
  refresh(): Promise<void>;
  save(t: Omit<Transaction, "id">, id?: string): Promise<void>;
  remove(id: string): Promise<void>;
};

const Ctx = createContext<State | null>(null);
const sortTx = (a: Transaction[]) => [...a].sort((x, y) => y.date.localeCompare(x.date));

export function DataProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);

  const latest = useRef(0);

  // The newest refresh owns the state: a slower earlier one (the first load still running when pull-to-refresh or a
  // new API address in Settings starts another) must not overwrite its answer or end its loading state.
  const refresh = useCallback(async () => {
    const id = ++latest.current;
    setLoading(true);
    try {
      const [c, t] = await Promise.all([api.categories(), api.transactions()]);
      if (id !== latest.current) return;
      setCategories(c);
      setTransactions(sortTx(t));
      setError(null);
    } catch (e) {
      if (id !== latest.current) return;
      setError((e as Error).message);
    } finally {
      if (id === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = useCallback(async (t: Omit<Transaction, "id">, id?: string) => {
    const saved = id ? await api.updateTransaction(id, t) : await api.createTransaction(t);
    setTransactions((prev) => sortTx(id ? prev.map((x) => (x.id === id ? saved : x)) : [saved, ...prev]));
  }, []);

  const remove = useCallback(async (id: string) => {
    await api.deleteTransaction(id);
    setTransactions((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const value = useMemo(
    () => ({
      loading, error, categories, transactions, refresh, save, remove,
      categoryMap: new Map(categories.map((c) => [c.id, c])),
    }),
    [loading, error, categories, transactions, refresh, save, remove],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useData() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useData outside DataProvider");
  return v;
}
