import type { RevolutStatus } from "@et/shared";

export interface RevolutProvider {
  readonly mode: NonNullable<RevolutStatus["mode"]>;
  status(): Promise<RevolutStatus>;
  /** Pull new transactions from the remote source into the local DB. */
  sync(): Promise<{ imported: number; skipped: number }>;
}

export const META_LAST_SYNC = "revolut.lastSyncAt";
export const META_CSV_ACCOUNTS = "revolut.csvAccounts";
