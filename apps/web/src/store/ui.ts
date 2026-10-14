import { create } from "zustand";
import type { Transaction } from "@et/shared";

type Draft = Partial<Omit<Transaction, "id">> & { id?: string };

interface UiState {
  txSheet: { open: boolean; draft: Draft | null };
  openTx(draft?: Draft): void;
  closeTx(): void;
}

export const useUi = create<UiState>((set) => ({
  txSheet: { open: false, draft: null },
  openTx: (draft) => set({ txSheet: { open: true, draft: draft ?? null } }),
  closeTx: () => set((s) => ({ txSheet: { ...s.txSheet, open: false } })),
}));
