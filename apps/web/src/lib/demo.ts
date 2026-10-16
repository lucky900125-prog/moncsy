import { DEFAULT_CATEGORIES, type AnalyzeResponse, type Category, type DefaultCategoryId, type PackUnit, type ProductFilter, type ReceiptItem, type Transaction } from "@et/shared";
import { buildProductStats, rankStores } from "@et/shared/products";
import type { Backend, TxQuery } from "./backend";
import { demoParseStatement } from "./demo-statement";
import { uid } from "./utils";

/** Local, offline backend used when the API is not reachable. Data lives in localStorage. */

// v2: grocery receipts carry line items for the Részletek tab; older demo data is replaced once.
const KEY = "moncsy-demo-v2";

/** Demo budgets on top of the shared defaults, so the dashboard's "Keretek" card has something to show. */
const DEMO_BUDGETS: Partial<Record<DefaultCategoryId, number>> = {
  groceries: 120000,
  restaurant: 40000,
  transport: 25000,
  utilities: 35000,
  entertainment: 20000,
  subscriptions: 12000,
};

const DEMO_CATEGORIES: Category[] = DEFAULT_CATEGORIES.map((c) => ({ ...c, isCustom: false, budget: DEMO_BUDGETS[c.id] ?? null }));

type Db = { categories: Category[]; transactions: Transaction[] };

// [product, brand, packSize, packUnit, price, sold by weight]
const CATALOG: [string, string | null, number, PackUnit, number, boolean][] = [
  ["tej", "Mizo", 1, "l", 429, false],
  ["kenyér", null, 500, "g", 549, false],
  ["trappista sajt", "Tolle", 500, "g", 2199, false],
  ["banán", null, 1, "kg", 599, true],
  ["tojás", null, 10, "db", 899, false],
  ["ásványvíz", "Szentkirályi", 1.5, "l", 219, false],
  ["kávé", "Tchibo", 250, "g", 2490, false],
  ["csirkemell", null, 1, "kg", 2690, true],
  ["vaj", "Président", 200, "g", 949, false],
  ["túró rudi", "Pöttyös", 1, "db", 189, false],
];
// Lidl and Aldi are cheaper on most lines, Spar dearer; each product still varies a little per store.
const STORE_LEVEL: Record<string, number> = { Lidl: 0.94, Aldi: 0.95, Penny: 0.97, Tesco: 1, Spar: 1.06 };

function receiptItems(store: string, r: () => number): ReceiptItem[] {
  const n = 3 + Math.floor(r() * 4);
  const picked = [...CATALOG].sort(() => r() - 0.5).slice(0, n);
  return picked.map(([product, brand, packSize, packUnit, price, byWeight]) => {
    const wobble = 1 + ((product.length * 7 + store.length * 13) % 9 - 4) / 100;
    const unitPrice = Math.round((price * (STORE_LEVEL[store] ?? 1) * wobble) / 10) * 10 - 1;
    const quantity = byWeight ? Math.round((0.6 + r()) * 1000) / 1000 : product === "ásványvíz" ? 6 : 1 + Math.floor(r() * 2);
    const size = packUnit === "db" && packSize > 1 ? `${packSize} db` : `${packSize}${packUnit}`;
    return {
      name: `${brand ? `${brand} ` : ""}${product}${byWeight ? "" : ` ${size}`}`,
      quantity,
      unitPrice,
      total: Math.round(unitPrice * quantity),
      product,
      brand,
      packSize,
      packUnit,
    };
  });
}

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

function seed(): Db {
  const r = rng(42);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const tx: Transaction[] = [];
  const now = new Date();
  const merchants: Record<string, [string[], number, number, number]> = {
    // category: [merchants, min, max, per-month count]
    groceries: [["Lidl", "Spar", "Aldi", "Tesco", "Penny"], 2500, 24000, 11],
    restaurant: [["Bors GasztroBár", "Wolt", "Pizza Me", "Costes Downtown", "Kifli Bistro"], 2800, 16000, 6],
    transport: [["BKK", "MOL", "Bolt", "MÁV"], 450, 18000, 6],
    utilities: [["MVM", "Főgáz", "Vodafone", "Díjbeszedő"], 6000, 19000, 3],
    entertainment: [["Cinema City", "Steam", "Akvárium Klub", "Libri"], 2500, 12000, 3],
    subscriptions: [["Spotify", "Netflix", "iCloud", "YouTube Premium"], 999, 4990, 3],
    health: [["BENU Gyógyszertár", "Dr. Rose"], 1800, 22000, 1],
    clothing: [["Zara", "Decathlon", "H&M"], 6000, 32000, 1],
  };
  for (let m = 0; m < 4; m++) {
    const base = new Date(now.getFullYear(), now.getMonth() - m, 1);
    const daysInMonth = m === 0 ? now.getDate() : new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
    const scale = m === 0 ? daysInMonth / 30 : 1;
    tx.push({
      id: uid(), amount: 685000, currency: "HUF", merchant: "Munkabér", categoryId: "income", source: "revolut",
      date: new Date(base.getFullYear(), base.getMonth(), Math.min(5, daysInMonth), 9).toISOString(),
    });
    tx.push({
      id: uid(), amount: -210000, currency: "HUF", merchant: "Albérlet", categoryId: "housing", source: "manual",
      date: new Date(base.getFullYear(), base.getMonth(), Math.min(3, daysInMonth), 10).toISOString(),
    });
    for (const [cat, [names, min, max, count]] of Object.entries(merchants)) {
      const n = Math.max(0, Math.round(count * scale));
      for (let i = 0; i < n; i++) {
        const day = 1 + Math.floor(r() * daysInMonth);
        const merchant = pick(names);
        const source = r() > 0.6 ? "receipt" : "revolut";
        const items = cat === "groceries" && source === "receipt" ? receiptItems(merchant, r) : undefined;
        const amt = items ? items.reduce((s, i) => s + i.total, 0) : Math.round((min + r() * (max - min)) / 10) * 10;
        tx.push({
          id: uid(), amount: -amt, currency: "HUF", merchant, categoryId: cat, source, ...(items ? { items } : {}),
          date: new Date(base.getFullYear(), base.getMonth(), day, 8 + Math.floor(r() * 12), Math.floor(r() * 60)).toISOString(),
        });
      }
    }
  }
  tx.sort((a, b) => b.date.localeCompare(a.date));
  return { categories: DEMO_CATEGORIES, transactions: tx };
}

function load(): Db {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Db;
  } catch { /* corrupted or blocked storage: reseed below */ }
  const db = seed();
  save(db);
  return db;
}

function save(db: Db) {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch { /* storage blocked: demo stays in-memory for this session */ }
}

let db: Db | null = null;
const getDb = () => (db ??= load());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const notInDemo = (what: string) =>
  Promise.reject(new Error(`${what} a backendet igényli. Indítsd el az API-t (pnpm dev:api), majd töltsd újra az oldalt.`));

export function resetDemo() {
  db = seed();
  save(db);
}

export const demoBackend: Backend = {
  mode: "demo",
  async listCategories() {
    return getDb().categories;
  },
  async createCategory(c) {
    const cat: Category = { ...c, id: uid(), isCustom: true };
    getDb().categories.push(cat);
    save(getDb());
    return cat;
  },
  async updateCategory(id, patch) {
    const d = getDb();
    const i = d.categories.findIndex((c) => c.id === id);
    if (i < 0) throw new Error("Nincs ilyen kategória");
    d.categories[i] = { ...d.categories[i], ...patch, id };
    save(d);
    return d.categories[i];
  },
  async deleteCategory(id) {
    const d = getDb();
    const c = d.categories.find((x) => x.id === id);
    if (!c?.isCustom) throw new Error("Csak egyedi kategória törölhető");
    d.categories = d.categories.filter((x) => x.id !== id);
    d.transactions = d.transactions.map((t) => (t.categoryId === id ? { ...t, categoryId: null } : t));
    save(d);
  },
  async listTransactions(q: TxQuery = {}) {
    return getDb().transactions.filter(
      (t) =>
        (!q.from || t.date >= q.from) &&
        (!q.to || t.date <= q.to) &&
        (!q.categoryId || t.categoryId === q.categoryId) &&
        (!q.q || t.merchant.toLowerCase().includes(q.q.toLowerCase())),
    );
  },
  async createTransaction(t) {
    const tx = { ...t, id: uid() };
    const d = getDb();
    d.transactions = [tx, ...d.transactions].sort((a, b) => b.date.localeCompare(a.date));
    save(d);
    return tx;
  },
  async updateTransaction(id, patch) {
    const d = getDb();
    const i = d.transactions.findIndex((t) => t.id === id);
    if (i < 0) throw new Error("Nincs ilyen tranzakció");
    d.transactions[i] = { ...d.transactions[i], ...patch, id };
    d.transactions.sort((a, b) => b.date.localeCompare(a.date));
    save(d);
    return d.transactions[i];
  },
  async deleteTransaction(id) {
    const d = getDb();
    d.transactions = d.transactions.filter((t) => t.id !== id);
    save(d);
  },
  async scanReceipt() {
    // Demo only: a fixed, clearly-labelled sample so the review flow can be tried without an AI key.
    await sleep(1400);
    return {
      merchant: "Lidl (demó)",
      date: new Date().toISOString(),
      total: 8740,
      currency: "HUF",
      confidence: 0.5,
      suggestedCategoryId: "groceries",
      items: [
        { name: "Félzsíros tej 1,5l", quantity: 2, unitPrice: 459, total: 918, product: "tej", brand: "Mizo", packSize: 1.5, packUnit: "l" },
        { name: "Teljes kiőrlésű kenyér", quantity: 1, unitPrice: 899, total: 899, product: "kenyér", brand: null, packSize: 500, packUnit: "g" },
        { name: "Trappista sajt 500g", quantity: 1, unitPrice: 2199, total: 2199, product: "trappista sajt", brand: "Tolle", packSize: 500, packUnit: "g" },
        { name: "Banán", quantity: 1, unitPrice: 749, total: 749, product: "banán", brand: null, packSize: 1, packUnit: "kg" },
        { name: "Csirkemell filé", quantity: 1, unitPrice: 3975, total: 3975, product: "csirkemell", brand: null, packSize: 1, packUnit: "kg" },
      ],
      rawText: "DEMÓ – nem valódi felismerés",
    };
  },
  async aiProviders() {
    // Settings shows no AI card in demo mode: the demo analysis runs in this browser.
    throw new Error("Demó módban nincs AI-szolgáltató; az API-hoz kapcsolódva választható.");
  },
  async analyze(req): Promise<AnalyzeResponse> {
    await sleep(900);
    const d = getDb();
    const tx = d.transactions.filter((t) => t.date >= req.from && t.date <= req.to);
    if (req.scope === "products") return demoProductAnalysis(tx, req.question, req.products);
    const exp = tx.filter((t) => t.amount < 0);
    const total = exp.reduce((s, t) => s - t.amount, 0);
    const byCat = new Map<string, number>();
    for (const t of exp) byCat.set(t.categoryId ?? "other", (byCat.get(t.categoryId ?? "other") ?? 0) - t.amount);
    const top = [...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const name = (id: string) => d.categories.find((c) => c.id === id)?.name ?? id;
    return {
      provider: "demo",
      model: "helyi szabályok",
      summary: `A kiválasztott időszakban ${exp.length} kiadás volt, összesen ${Math.round(total).toLocaleString("hu-HU")} Ft. Ez demó elemzés, valódi AI nélkül.`,
      insights: top.map(([id, v], i) => ({
        title: `${i + 1}. ${name(id)}`,
        detail: `${Math.round(v).toLocaleString("hu-HU")} Ft, a kiadások ${Math.round((v / (total || 1)) * 100)}%-a.`,
        severity: i === 0 ? "warning" : "info",
      })),
    };
  },
  async revolutStatus() {
    return { connected: false, mode: null, lastSyncAt: null, accounts: [] };
  },
  revolutSync: () => notInDemo("A Revolut szinkron"),
  revolutImportStatement: () => notInDemo("A Revolut kivonat importálása"),
  importFile: () => notInDemo("Az XLSX/XML import"),
  async parseStatement(_file, opts) {
    await sleep(700);
    return demoParseStatement(opts);
  },
  async importStatement(rows) {
    const d = getDb();
    const known = new Set(d.transactions.map((t) => t.externalId).filter(Boolean));
    const fresh = rows.filter((r) => !known.has(r.externalId));
    d.transactions = [...fresh.map((r) => ({ ...r, id: uid() })), ...d.transactions].sort((a, b) => b.date.localeCompare(a.date));
    save(d);
    return { imported: fresh.length, skipped: rows.length - fresh.length, errors: [] };
  },
  exportFile: () => notInDemo("Az XLSX/XML export"),
  // The demo keeps its data in this browser only; there is no server backup to report.
  backupStatus: async () => null,
};

function demoProductAnalysis(tx: Transaction[], question?: string, filter?: ProductFilter): AnalyzeResponse {
  const low = (s: string) => s.toLocaleLowerCase("hu");
  const all = buildProductStats(tx);
  // Same narrowing as the server's "products" filter (case-insensitive here; the server also ignores accents).
  const filtered = all.filter(
    (p) =>
      (!filter?.q || low(`${p.product} ${p.history.map((h) => h.name).join(" ")}`).includes(low(filter.q))) &&
      (!filter?.brand || low(p.brand ?? "") === low(filter.brand)) &&
      (!filter?.merchant || p.stores.some((s) => low(s.store) === low(filter.merchant!))),
  );
  if (filter && filtered.length === 0) throw new Error("A szűrésnek egyik termék sem felel meg.");
  // Stand-in for the model reading the question: narrow to the brands or products it names, if any.
  const q = low(question ?? "");
  const named = filtered.filter((p) => (p.brand && q.includes(low(p.brand))) || q.includes(low(p.product)));
  const stats = named.length ? named : filtered;
  if (stats.length === 0) throw new Error("Ebben az időszakban még nincs blokktétel. Olvass be blokkokat, hogy össze lehessen hasonlítani az árakat.");
  const compared = stats.filter((p) => p.stores.length >= 2);
  const best = rankStores(stats)[0];
  const fmt = (n: number) => `${Math.round(n).toLocaleString("hu-HU")} Ft`;
  const unit = (u: string | null) => (u ? `/${u}` : "/db");
  return {
    provider: "demo",
    model: "helyi szabályok",
    summary: best?.cheapestFor
      ? `${compared.length} terméket vettél több boltban; ${best.cheapestFor} esetben a ${best.store} volt a legolcsóbb. Ez demó elemzés, valódi AI nélkül.`
      : compared.length
        ? `${compared.length} terméket vettél több boltban, mindegyiket egyforma legjobb áron. Ez demó elemzés, valódi AI nélkül.`
        : "Még nincs olyan termék, amit több boltban is megvettél. Ez demó elemzés, valódi AI nélkül.",
    // Equal best prices name no store (cheapest is null then), like the server's offline analysis.
    insights: compared
      .filter((p) => p.cheapest)
      .sort((a, b) => (b.saving ?? 0) - (a.saving ?? 0))
      .slice(0, 6)
      .map((p) => {
        const lo = p.stores[0]!;
        const hi = p.stores[p.stores.length - 1]!;
        const price = (s: typeof lo) => (p.baseUnit ? (s.avgBasePrice ?? s.avgUnitPrice) : s.avgUnitPrice);
        return {
          title: `${p.brand ? `${p.brand} ` : ""}${p.product}: ${lo.store}`,
          detail: `${fmt(price(lo))}${unit(p.baseUnit)} a ${lo.store} boltban, ${fmt(price(hi))}${unit(p.baseUnit)} a ${hi.store} boltban.`,
          severity: "positive" as const,
        };
      }),
  };
}
