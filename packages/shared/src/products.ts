// Receipt line items turned into products, and where each product was cheapest.
// Runs in the browser (web demo, mobile) and on the server (AI analysis), so it has no dependencies.

import type { PackUnit, ReceiptItem, Transaction } from "./index.ts";

export type BaseUnit = "kg" | "l" | "db";

export interface ProductPurchase {
  transactionId: string;
  date: string;
  store: string;
  /** the line as printed on the receipt */
  name: string;
  quantity: number;
  unitPrice: number;
  total: number;
  currency: string;
  /** unitPrice per kg / l / db when the package size is known */
  basePrice: number | null;
}

export interface StorePrice {
  store: string;
  purchases: number;
  avgUnitPrice: number;
  minUnitPrice: number;
  lastUnitPrice: number;
  lastDate: string;
  /** average price per kg / l / db; null when no purchase here had a package size */
  avgBasePrice: number | null;
}

export interface ProductStat {
  key: string;
  product: string;
  brand: string | null;
  /** "1 l", "500 g"; null when unknown or when sizes differ (then prices compare per baseUnit) */
  pack: string | null;
  baseUnit: BaseUnit | null;
  currency: string;
  purchases: number;
  quantity: number;
  spent: number;
  /** cheapest first; compared per baseUnit when known, else per unit */
  stores: StorePrice[];
  /** set only when the product was bought in at least two stores */
  cheapest: string | null;
  /** price difference between the dearest and the cheapest store, per baseUnit or per unit */
  saving: number | null;
  /** newest first */
  history: ProductPurchase[];
}

export interface StoreRank {
  store: string;
  /** products for which this store had the lowest price */
  cheapestFor: number;
  /** products bought here that were also bought somewhere else */
  compared: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const LEGAL_FORMS = new Set(["kft", "zrt", "nyrt", "bt", "kkt", "rt", "ltd", "gmbh", "co", "inc", "sa", "ag"]);
const STORE_NOISE = new Set([
  "magyarország", "magyarorszag", "hungary", "hungária", "global", "áruházak", "áruház", "aruhazak", "aruhaz",
  "kereskedelmi", "élelmiszer", "elelmiszer", "és", "es", "szolgáltató", "szolgaltato", "holding",
]);

/**
 * "SPAR Magyarország Kft." and "Spar" are the same store; legal forms and country words are dropped.
 * A registered company name is "<chain> <words about the company> <legal form>", so it ends at the first such word:
 * "Penny Market Kft." is "Penny Market", like the "Penny Market" a bank shows, and not "Penny".
 */
export function storeName(merchant: string): string {
  const words = merchant
    .replace(/\([^()]*\)/g, " ")
    .replace(/[-–,]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/\.+$/, ""))
    .filter(Boolean);
  const isLegal = (w: string) => LEGAL_FORMS.has(w.toLocaleLowerCase("hu"));
  const isNoise = (w: string) => STORE_NOISE.has(w.toLocaleLowerCase("hu"));
  const kept = words.filter((w) => !isLegal(w) && !isNoise(w));
  if (kept.length === 0) return merchant.trim() || "Ismeretlen bolt";
  const end = words.findIndex((w) => isLegal(w) || isNoise(w));
  const name = words.some(isLegal) && end > 0 ? words.slice(0, end) : kept;
  // A word in capitals that is longer than an acronym is a name: "PENNY MARKET" is "Penny Market", "OTP" stays.
  const shout = (w: string) => w.length > 3 && w === w.toLocaleUpperCase("hu") && w !== w.toLocaleLowerCase("hu");
  return name.map((w) => (shout(w) ? capitalize(w.toLocaleLowerCase("hu")) : w)).join(" ");
}

/** What two spellings of one store have in common: "Spar", "SPAR" and "spar", or "Müller" and "MULLER". */
const storeKey = (name: string) =>
  name
    .toLocaleLowerCase("hu")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const capitalize = (s: string) => s.charAt(0).toLocaleUpperCase("hu") + s.slice(1);
const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLocaleLowerCase("hu");

const BASE: Record<PackUnit, [BaseUnit, number]> = {
  g: ["kg", 1000],
  kg: ["kg", 1],
  ml: ["l", 1000],
  l: ["l", 1],
  db: ["db", 1],
};

function packOf(item: ReceiptItem): { base: BaseUnit; size: number; label: string } | null {
  if (!item.packUnit || !item.packSize || !(item.packSize > 0)) return null;
  const [base, div] = BASE[item.packUnit];
  return { base, size: item.packSize / div, label: `${item.packSize} ${item.packUnit}` };
}

export function productKey(item: ReceiptItem, currency: string): string {
  const pack = packOf(item);
  return [currency, norm(item.product || item.name), norm(item.brand ?? ""), pack ? pack.base : "unit"].join("|");
}

/**
 * Groups every receipt line item of the given transactions into products and compares the stores they were bought in.
 * Lines with a non-positive price (discounts, deposits returned) are left out.
 */
export function buildProductStats(transactions: Transaction[]): ProductStat[] {
  const groups = new Map<string, { item: ReceiptItem; purchases: ProductPurchase[]; packs: Set<string>; base: BaseUnit | null }>();
  // A store spelled several ways is one store, shown the way it first appears.
  const storeNames = new Map<string, string>();
  for (const tx of transactions) {
    if (!tx.items?.length) continue;
    const name = storeName(tx.merchant);
    if (!storeNames.has(storeKey(name))) storeNames.set(storeKey(name), name);
    const store = storeNames.get(storeKey(name))!;
    for (const item of tx.items) {
      if (!(item.unitPrice > 0) || !(item.total > 0)) continue;
      const key = productKey(item, tx.currency);
      const pack = packOf(item);
      let g = groups.get(key);
      if (!g) {
        g = { item, purchases: [], packs: new Set(), base: pack?.base ?? null };
        groups.set(key, g);
      }
      if (pack) g.packs.add(pack.label);
      g.purchases.push({
        transactionId: tx.id,
        date: tx.date,
        store,
        name: item.name,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        total: item.total,
        currency: tx.currency,
        basePrice: pack ? round2(item.unitPrice / pack.size) : null,
      });
    }
  }

  const stats: ProductStat[] = [];
  for (const [key, g] of groups) {
    const history = [...g.purchases].sort((a, b) => b.date.localeCompare(a.date));
    const byStore = new Map<string, ProductPurchase[]>();
    for (const p of history) byStore.set(p.store, [...(byStore.get(p.store) ?? []), p]);
    const stores: StorePrice[] = [...byStore.entries()].map(([store, ps]) => {
      const based = ps.filter((p) => p.basePrice !== null);
      return {
        store,
        purchases: ps.length,
        avgUnitPrice: round2(ps.reduce((s, p) => s + p.unitPrice, 0) / ps.length),
        minUnitPrice: Math.min(...ps.map((p) => p.unitPrice)),
        lastUnitPrice: ps[0]!.unitPrice,
        lastDate: ps[0]!.date,
        avgBasePrice: based.length ? round2(based.reduce((s, p) => s + p.basePrice!, 0) / based.length) : null,
      };
    });
    const price = (s: StorePrice) => (g.base ? (s.avgBasePrice ?? s.avgUnitPrice) : s.avgUnitPrice);
    stores.sort((a, b) => price(a) - price(b) || a.store.localeCompare(b.store, "hu"));
    const compared = stores.length >= 2;
    stats.push({
      key,
      product: capitalize((g.item.product || g.item.name).trim()),
      brand: g.item.brand?.trim() || null,
      pack: g.packs.size === 1 ? [...g.packs][0]! : null,
      baseUnit: g.base,
      currency: history[0]!.currency,
      purchases: history.length,
      quantity: round2(history.reduce((s, p) => s + p.quantity, 0)),
      spent: round2(history.reduce((s, p) => s + p.total, 0)),
      stores,
      cheapest: compared ? stores[0]!.store : null,
      saving: compared ? round2(price(stores[stores.length - 1]!) - price(stores[0]!)) : null,
      history,
    });
  }
  return stats.sort((a, b) => b.spent - a.spent || a.product.localeCompare(b.product, "hu"));
}

/** Which store was cheapest most often, over the products bought in more than one store. */
export function rankStores(stats: ProductStat[]): StoreRank[] {
  const rank = new Map<string, StoreRank>();
  for (const p of stats) {
    if (!p.cheapest) continue;
    for (const s of p.stores) {
      const r = rank.get(s.store) ?? { store: s.store, cheapestFor: 0, compared: 0 };
      r.compared++;
      if (s.store === p.cheapest) r.cheapestFor++;
      rank.set(s.store, r);
    }
  }
  return [...rank.values()].sort((a, b) => b.cheapestFor - a.cheapestFor || b.compared - a.compared || a.store.localeCompare(b.store, "hu"));
}
