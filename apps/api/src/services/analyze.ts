import { z } from "zod";
import type { AnalyzeRequest, AnalyzeResponse, Category, ProductFilter, Transaction } from "@et/shared";
import { buildProductStats, rankStores, storeName, type ProductStat, type StoreRank } from "@et/shared/products";
import type { AIProvider } from "../ai/index.js";
import { parseModelJson } from "../ai/json.js";
import { round2 } from "../repository.js";
import { fold } from "../statements/values.js";

export interface Aggregate {
  from: string;
  to: string;
  currency: string;
  totals: { income: number; expense: number; net: number; count: number };
  byCategory: { categoryId: string | null; name: string; expense: number; share: number; count: number; budget: number | null }[];
  topMerchants: { merchant: string; expense: number; count: number }[];
  monthly: { month: string; income: number; expense: number }[];
  monthOverMonth: {
    previousMonth: string;
    currentMonth: string;
    expenseChangePct: number | null;
    categoryChanges: { name: string; previous: number; current: number; change: number }[];
  } | null;
  otherCurrencies: { currency: string; income: number; expense: number; count: number }[];
}

/** Builds the aggregate that is sent to the model. Raw transaction rows never leave the server. */
export function aggregate(
  txs: Transaction[],
  categories: Category[],
  from: string,
  to: string,
  defaultCurrency: string,
): Aggregate {
  const byCur = new Map<string, Transaction[]>();
  for (const t of txs) {
    const list = byCur.get(t.currency);
    if (list) list.push(t);
    else byCur.set(t.currency, [t]);
  }
  const currency =
    [...byCur.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0]?.[0] ?? defaultCurrency;
  const main = byCur.get(currency) ?? [];
  const catById = new Map(categories.map((c) => [c.id, c] as const));

  const income = main.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const expense = main.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0);

  const catAgg = new Map<string | null, { expense: number; count: number }>();
  const merchAgg = new Map<string, { merchant: string; expense: number; count: number }>();
  const monthAgg = new Map<string, { income: number; expense: number; cats: Map<string | null, number> }>();
  for (const t of main) {
    const month = t.date.slice(0, 7);
    const m = monthAgg.get(month) ?? { income: 0, expense: 0, cats: new Map() };
    if (t.amount > 0) m.income += t.amount;
    else {
      m.expense -= t.amount;
      m.cats.set(t.categoryId, (m.cats.get(t.categoryId) ?? 0) - t.amount);
      const c = catAgg.get(t.categoryId) ?? { expense: 0, count: 0 };
      c.expense -= t.amount;
      c.count++;
      catAgg.set(t.categoryId, c);
      const key = t.merchant.trim().toLocaleLowerCase("hu") || "(ismeretlen)";
      const mm = merchAgg.get(key) ?? { merchant: t.merchant.trim() || "(ismeretlen)", expense: 0, count: 0 };
      mm.expense -= t.amount;
      mm.count++;
      merchAgg.set(key, mm);
    }
    monthAgg.set(month, m);
  }
  const nameOf = (id: string | null) => (id ? (catById.get(id)?.name ?? id) : "Kategória nélkül");

  const monthly = [...monthAgg.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v]) => ({ month, income: round2(v.income), expense: round2(v.expense) }));

  let monthOverMonth: Aggregate["monthOverMonth"] = null;
  if (monthly.length >= 2) {
    const prev = monthly[monthly.length - 2]!;
    const cur = monthly[monthly.length - 1]!;
    const pc = monthAgg.get(prev.month)!.cats;
    const cc = monthAgg.get(cur.month)!.cats;
    const ids = new Set([...pc.keys(), ...cc.keys()]);
    monthOverMonth = {
      previousMonth: prev.month,
      currentMonth: cur.month,
      expenseChangePct: prev.expense > 0 ? round2(((cur.expense - prev.expense) / prev.expense) * 100) : null,
      categoryChanges: [...ids]
        .map((id) => {
          const p = pc.get(id) ?? 0;
          const c = cc.get(id) ?? 0;
          return { name: nameOf(id), previous: round2(p), current: round2(c), change: round2(c - p) };
        })
        .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
        .slice(0, 6),
    };
  }

  return {
    from,
    to,
    currency,
    totals: { income: round2(income), expense: round2(expense), net: round2(income - expense), count: main.length },
    byCategory: [...catAgg.entries()]
      .map(([id, v]) => ({
        categoryId: id,
        name: nameOf(id),
        expense: round2(v.expense),
        share: expense > 0 ? round2(v.expense / expense) : 0,
        count: v.count,
        budget: id ? (catById.get(id)?.budget ?? null) : null,
      }))
      .sort((a, b) => b.expense - a.expense),
    topMerchants: [...merchAgg.values()]
      .map((m) => ({ ...m, expense: round2(m.expense) }))
      .sort((a, b) => b.expense - a.expense)
      .slice(0, 8),
    monthly,
    monthOverMonth,
    otherCurrencies: [...byCur.entries()]
      .filter(([c]) => c !== currency)
      .map(([c, list]) => ({
        currency: c,
        income: round2(list.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0)),
        expense: round2(list.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0)),
        count: list.length,
      })),
  };
}

export interface ProductAggregate {
  from: string;
  to: string;
  products: {
    product: string;
    brand: string | null;
    pack: string | null;
    /** what a price below is for: per kg, per l, per db, or per package/piece when the size is unknown */
    priceUnit: "kg" | "l" | "db" | "package";
    currency: string;
    purchases: number;
    spent: number;
    stores: { store: string; avgPrice: number; purchases: number; lastDate: string }[];
  }[];
  storeRanking: StoreRank[];
  /** products left out to keep the request small */
  omitted: number;
  /** what the user narrowed the products to, so the model answers about that and not the whole basket */
  filter?: ProductFilter;
}

const MAX_PRODUCTS = 40;

/** True when the product matches every part of the filter that is set. */
export function matchesProductFilter(p: ProductStat, f: ProductFilter): boolean {
  const has = (text: string | null | undefined, needle: string) => fold(text ?? "").includes(fold(needle));
  if (f.q && !has(p.product, f.q) && !p.history.some((h) => has(h.name, f.q!))) return false;
  if (f.brand && fold(p.brand ?? "") !== fold(f.brand)) return false;
  if (f.merchant && !p.stores.some((s) => has(s.store, storeName(f.merchant!)))) return false;
  return true;
}

/** Receipt line items grouped into products with their average price per store. Line-level history stays on the server. */
export function productAggregate(txs: Transaction[], from: string, to: string, filter?: ProductFilter): ProductAggregate {
  const active = filter && (filter.q || filter.brand || filter.merchant) ? filter : undefined;
  const stats = buildProductStats(txs).filter((p) => !active || matchesProductFilter(p, active));
  // Products bought in several stores are the comparable ones, so they go first; then the biggest spend.
  const picked = [...stats.filter((p) => p.cheapest), ...stats.filter((p) => !p.cheapest)].slice(0, MAX_PRODUCTS);
  return {
    from,
    to,
    products: picked.map((p) => ({
      product: p.product,
      brand: p.brand,
      pack: p.pack,
      priceUnit: p.baseUnit ?? "package",
      currency: p.currency,
      purchases: p.purchases,
      spent: p.spent,
      stores: p.stores.map((s) => ({
        store: s.store,
        avgPrice: p.baseUnit ? (s.avgBasePrice ?? s.avgUnitPrice) : s.avgUnitPrice,
        purchases: s.purchases,
        lastDate: s.lastDate.slice(0, 10),
      })),
    })),
    storeRanking: rankStores(stats),
    omitted: Math.max(0, stats.length - picked.length),
    ...(active ? { filter: active } : {}),
  };
}

const analysisSchema = z.object({
  summary: z.string().min(1),
  insights: z
    .array(
      z.object({
        title: z.string().min(1),
        detail: z.string().min(1),
        severity: z.enum(["info", "positive", "warning"]),
      }),
    )
    .max(10),
});

const SYSTEM = `You are a careful personal-finance analyst for a household expense tracker.
You receive an aggregate of the user's transactions (not raw rows). Amounts are in the given currency;
"expense" values are positive magnitudes of spending. Monthly budgets, when present, are per category.
Write in Hungarian unless the user's question is clearly in another language.
Use only numbers that appear in or follow directly from the data; do not invent transactions.
Return only this JSON object:
{"summary": string (2-4 sentences), "insights": [{"title": string, "detail": string, "severity": "info" | "positive" | "warning"}]}
Give 3 to 6 insights: notable categories, month-over-month changes, budget overruns, recurring merchants, and concrete savings ideas.`;

const PRODUCTS_SYSTEM = `You are a careful shopping analyst for a household expense tracker.
You receive the user's receipt line items grouped into products (generic product, brand, package size) with the average
price paid in each store. avgPrice is per kg, per l or per db when priceUnit says so, otherwise per package or piece.
storeRanking counts, over the products bought in more than one store, how often each store was the cheapest.
When a "filter" is present, the user narrowed the products to it: answer about those products only.
Write in Hungarian unless the user's question is clearly in another language.
Compare prices only within one product entry (same product, same brand when a brand is given). A product bought in a single
store has no comparison: say so instead of calling that store cheap. Use only numbers that appear in or follow from the data.
Return only this JSON object:
{"summary": string (2-4 sentences), "insights": [{"title": string, "detail": string, "severity": "info" | "positive" | "warning"}]}
Give 3 to 8 insights: for which products and brands the store matters most and by how much, which store is cheapest overall
for the basket the user actually buys, and where the data is too thin to tell.`;

export async function analyze(ai: AIProvider, req: AnalyzeRequest, agg: Aggregate | ProductAggregate): Promise<AnalyzeResponse> {
  const products = req.scope === "products";
  const user = [
    req.question ? `Question: ${req.question}` : products ? "Where is it worth buying the products I buy?" : "Give a general analysis of this period.",
    products ? `<products>${JSON.stringify(agg)}</products>` : `<aggregate>${JSON.stringify(agg)}</aggregate>`,
  ].join("\n\n");
  const raw = await ai.complete(
    [
      { role: "system", content: products ? PRODUCTS_SYSTEM : SYSTEM },
      { role: "user", content: user },
    ],
    { json: true, maxTokens: 4000, temperature: 0.2 },
  );
  const r = parseModelJson(ai.name, raw, analysisSchema);
  return { provider: ai.name, model: ai.model, summary: r.summary, insights: r.insights };
}
