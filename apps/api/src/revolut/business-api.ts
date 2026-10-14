import type { RevolutStatus } from "@et/shared";
import { getMeta, setMeta } from "../db.js";
import { HttpError } from "../errors.js";
import type { Repository } from "../repository.js";
import { categorize } from "./categorize.js";
import { META_LAST_SYNC, type RevolutProvider } from "./types.js";

const META_PENDING_SINCE = "revolut.business.pendingSince";

/*
 * Revolut Business API, verified against developer.revolut.com (2026-10):
 *  - Base URL production https://b2b.revolut.com/api/1.0, sandbox https://sandbox-b2b.revolut.com/api/1.0
 *  - Auth: "Authorization: Bearer <access_token>"
 *  - GET /accounts -> [{ id, name, balance, currency, state, public, created_at, updated_at, account_type }]
 *  - GET /transactions?from&to&count(<=1000, default 100)&account&type ; paginate by passing the
 *    created_at of the last item as `to`.
 *  - Transaction: { id, type, state, created_at, updated_at, completed_at, reference,
 *    merchant?: { name, city, category_code, country }, legs: [{ leg_id, account_id, amount, fee,
 *    currency, bill_amount, bill_currency, description, balance, counterparty }] }
 *  - Access tokens expire after 40 minutes; refreshing needs a refresh token + client-assertion JWT
 *    signed with your private key.
 */
const BASES = {
  production: "https://b2b.revolut.com/api/1.0",
  sandbox: "https://sandbox-b2b.revolut.com/api/1.0",
} as const;

interface BizAccount {
  id: string;
  name?: string;
  balance: number;
  currency: string;
  state: string;
}

interface BizLeg {
  leg_id: string;
  account_id: string;
  amount: number;
  fee?: number;
  currency: string;
  description?: string;
}

interface BizTransaction {
  id: string;
  type: string;
  state: string;
  created_at: string;
  completed_at?: string;
  reference?: string;
  merchant?: { name?: string; city?: string };
  legs: BizLeg[];
}

const PAGE = 1000;

export class BusinessApiRevolutProvider implements RevolutProvider {
  readonly mode = "business-api" as const;
  private readonly base: string;

  constructor(
    private readonly repo: Repository,
    private readonly token: string | undefined,
    env: "production" | "sandbox",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = BASES[env];
  }

  private async get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    if (!this.token) {
      throw new HttpError(503, "REVOLUT_BUSINESS_TOKEN is not set; generate an access token in Revolut Business > APIs.");
    }
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      throw new HttpError(502, `Revolut Business API request failed: ${(e as Error).message}`);
    }
    if (res.status === 401) {
      // TODO: implement the refresh flow (POST /auth/token, grant_type=refresh_token + client_assertion JWT).
      // Until then the 40-minute access token in REVOLUT_BUSINESS_TOKEN has to be replaced manually.
      throw new HttpError(502, "Revolut Business API rejected the token (401). Access tokens expire after 40 minutes; refresh it.");
    }
    if (!res.ok) throw new HttpError(502, `Revolut Business API ${path} returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  async status(): Promise<RevolutStatus> {
    const lastSyncAt = await getMeta(this.repo.db, META_LAST_SYNC);
    if (!this.token) return { connected: false, mode: this.mode, lastSyncAt, accounts: [] };
    const accounts = await this.get<BizAccount[]>("/accounts");
    return {
      connected: true,
      mode: this.mode,
      lastSyncAt,
      accounts: accounts
        .filter((a) => a.state === "active")
        .map((a) => ({ id: a.id, name: a.name ?? a.currency, currency: a.currency, balance: a.balance })),
    };
  }

  async sync(): Promise<{ imported: number; skipped: number }> {
    const last = await getMeta(this.repo.db, META_LAST_SYNC);
    // The window starts at the earliest still-pending transaction from earlier syncs (so it is fetched again once
    // it completes) or a day before the last sync; dedupe on externalId handles the overlap.
    const pendingSince = await getMeta(this.repo.db, META_PENDING_SINCE);
    const candidates = [
      last ? Date.parse(last) - 86_400_000 : Date.now() - 90 * 86_400_000,
      pendingSince ? Date.parse(pendingSince) : Infinity,
    ];
    const from = new Date(Math.min(...candidates)).toISOString();
    const all: BizTransaction[] = [];
    const seenIds = new Set<string>();
    let to: string | undefined;
    for (let page = 0; page < 100; page++) {
      const q: Record<string, string> = { from, count: String(PAGE) };
      if (to) q.to = to;
      const batch = await this.get<BizTransaction[]>("/transactions", q);
      // Paging by `to = last created_at` can hand back the boundary item again; keep each transaction once.
      for (const tx of batch) {
        if (seenIds.has(tx.id)) continue;
        seenIds.add(tx.id);
        all.push(tx);
      }
      if (batch.length < PAGE) break;
      const nextTo = batch[batch.length - 1]!.created_at;
      if (nextTo === to) break;
      to = nextTo;
    }
    const known = new Set((await this.repo.listCategories()).map((c) => c.id));
    let imported = 0;
    let skipped = 0;
    let earliestPending: string | null = null;
    await this.repo.withTx(async (repo) => {
      for (const tx of all) {
        if (tx.state === "pending" && tx.type !== "exchange" && (!earliestPending || tx.created_at < earliestPending)) {
          earliestPending = tx.created_at;
        }
        if (tx.state !== "completed" || tx.type === "exchange") {
          skipped++;
          continue;
        }
        for (const leg of tx.legs ?? []) {
          const externalId = `revolut-biz:${tx.id}:${leg.leg_id}`;
          if (await repo.hasExternalId(externalId)) {
            skipped++;
            continue;
          }
          // TODO(unverified): docs do not state the sign convention of legs[].amount / fee explicitly;
          // this assumes amount is negative for outgoing money and fee is a positive charge.
          const amount = Math.round((leg.amount - (leg.fee ?? 0)) * 100) / 100;
          const merchant = tx.merchant?.name ?? leg.description ?? tx.reference ?? tx.type;
          const cat = categorize(`${merchant} ${leg.description ?? ""}`, amount, tx.type);
          await repo.createTransaction({
            amount,
            currency: leg.currency,
            date: tx.completed_at ?? tx.created_at,
            merchant,
            note: tx.reference && tx.reference !== merchant ? tx.reference : undefined,
            categoryId: cat && known.has(cat) ? cat : null,
            source: "revolut",
            externalId,
          });
          imported++;
        }
      }
      await setMeta(repo.db, META_LAST_SYNC, new Date().toISOString());
      await setMeta(repo.db, META_PENDING_SINCE, earliestPending ?? "");
    });
    return { imported, skipped };
  }
}
