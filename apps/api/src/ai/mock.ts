import { STATEMENT_PROMPT_MARKER } from "../statements/pdf.js";
import type { AIProvider, ChatMessage, CompleteOptions } from "./types.js";

/**
 * Deterministic offline provider. Used by default when no API key is configured, and in tests.
 * - vision(): the same plausible Hungarian supermarket receipt, or for the statement prompt three statement lines.
 * - complete(): if the prompt carries an <aggregate>…</aggregate> JSON block (see ai/prompts.ts),
 *   derives a few insights from it; otherwise returns a fixed JSON object.
 */
export class MockProvider implements AIProvider {
  readonly name = "mock";
  readonly model = "mock-1";

  async complete(messages: ChatMessage[], _opts?: CompleteOptions): Promise<string> {
    const text = messages.map((m) => m.content).join("\n");
    const p = text.match(/<products>([\s\S]*?)<\/products>/);
    if (p) return JSON.stringify(mockProducts(JSON.parse(p[1]!) as MockProducts));
    const m = text.match(/<aggregate>([\s\S]*?)<\/aggregate>/);
    if (!m) return JSON.stringify({ summary: "Mock válasz.", insights: [] });
    return JSON.stringify(mockAnalysis(JSON.parse(m[1]!) as MockAggregate));
  }

  async vision(_b64: string, _mime: string, prompt: string): Promise<string> {
    if (prompt.startsWith(STATEMENT_PROMPT_MARKER)) {
      return JSON.stringify({
        currency: "HUF",
        transactions: [
          { date: "2026-10-01", amount: -4785, currency: null, counterparty: "SPAR 1234 Budapest", description: "Kártyás vásárlás" },
          { date: "2026-10-03", amount: 685000, currency: null, counterparty: "Példa Kft.", description: "Munkabér október" },
          { date: "2026-10-05", amount: -12990, currency: null, counterparty: "MVM Next", description: "Áramdíj" },
        ],
      });
    }
    return JSON.stringify({
      merchant: "SPAR Magyarország Kft.",
      date: "2026-10-12",
      total: 4785,
      currency: "HUF",
      items: [
        { name: "Mizo Tej 2,8% 1l", quantity: 2, unitPrice: 389, total: 778, product: "tej", brand: "Mizo", packSize: 1, packUnit: "l" },
        { name: "Kenyér fehér 500g", quantity: 1, unitPrice: 549, total: 549, product: "kenyér", brand: null, packSize: 500, packUnit: "g" },
        { name: "Trappista sajt 250g", quantity: 1, unitPrice: 1299, total: 1299, product: "trappista sajt", brand: null, packSize: 250, packUnit: "g" },
        { name: "Alma Jonagold", quantity: 1.5, unitPrice: 599, total: 899, product: "alma", brand: null, packSize: 1, packUnit: "kg" },
        { name: "Szentkirályi ásványvíz 1,5l", quantity: 6, unitPrice: 210, total: 1260, product: "ásványvíz", brand: "Szentkirályi", packSize: 1.5, packUnit: "l" },
      ],
      suggestedCategoryId: "groceries",
      confidence: 0.92,
      rawText: "SPAR MAGYARORSZÁG KFT.\n...\nÖSSZESEN: 4 785 Ft\nÁFA 27%: 1 017 Ft",
    });
  }
}

interface MockAggregate {
  currency: string;
  totals: { income: number; expense: number; net: number; count: number };
  byCategory: { name: string; expense: number; share: number }[];
  topMerchants: { merchant: string; expense: number; count: number }[];
  monthOverMonth: { previousMonth: string; currentMonth: string; expenseChangePct: number | null } | null;
}

function fmt(n: number, cur: string): string {
  return `${Math.round(n).toLocaleString("hu-HU")} ${cur}`;
}

function mockAnalysis(a: MockAggregate) {
  const insights: { title: string; detail: string; severity: "info" | "positive" | "warning" }[] = [];
  const top = a.byCategory[0];
  if (top) {
    insights.push({
      title: `Legnagyobb kiadás: ${top.name}`,
      detail: `${fmt(top.expense, a.currency)}, a kiadások ${Math.round(top.share * 100)}%-a.`,
      severity: top.share > 0.4 ? "warning" : "info",
    });
  }
  const merchant = a.topMerchants[0];
  if (merchant) {
    insights.push({
      title: `Leggyakoribb hely: ${merchant.merchant}`,
      detail: `${merchant.count} tranzakció, összesen ${fmt(merchant.expense, a.currency)}.`,
      severity: "info",
    });
  }
  const mom = a.monthOverMonth;
  if (mom && mom.expenseChangePct !== null) {
    const up = mom.expenseChangePct > 0;
    insights.push({
      title: up ? "Nőttek a kiadások" : "Csökkentek a kiadások",
      detail: `${mom.currentMonth}: ${Math.abs(mom.expenseChangePct).toFixed(1)}%-kal ${up ? "több" : "kevesebb"}, mint ${mom.previousMonth}.`,
      severity: up ? "warning" : "positive",
    });
  }
  insights.push({
    title: a.totals.net >= 0 ? "Pozitív egyenleg" : "Negatív egyenleg",
    detail: `Bevétel ${fmt(a.totals.income, a.currency)}, kiadás ${fmt(a.totals.expense, a.currency)}.`,
    severity: a.totals.net >= 0 ? "positive" : "warning",
  });
  return {
    summary: `Az időszakban ${a.totals.count} tranzakció történt, ${fmt(a.totals.expense, a.currency)} kiadással és ${fmt(a.totals.income, a.currency)} bevétellel.`,
    insights,
  };
}

interface MockProducts {
  products: { product: string; brand: string | null; priceUnit: string; currency: string; stores: { store: string; avgPrice: number }[] }[];
  storeRanking: { store: string; cheapestFor: number; compared: number }[];
}

function mockProducts(a: MockProducts) {
  const compared = a.products.filter((p) => p.stores.length >= 2);
  const insights = compared.slice(0, 5).map((p) => {
    const lo = p.stores[0]!;
    const hi = p.stores[p.stores.length - 1]!;
    const unit = p.priceUnit === "package" ? "db" : p.priceUnit;
    return {
      title: `${p.brand ? `${p.brand} ` : ""}${p.product}: ${lo.store}`,
      detail: `${fmt(lo.avgPrice, p.currency)}/${unit} a ${lo.store}-nál, ${fmt(hi.avgPrice, p.currency)}/${unit} a ${hi.store}-nál.`,
      severity: "positive" as const,
    };
  });
  const best = a.storeRanking[0];
  return {
    summary: best
      ? `${compared.length} terméket vettél több boltban; ezek közül ${best.cheapestFor} esetben a ${best.store} volt a legolcsóbb.`
      : "Még nincs olyan termék, amit több boltban is megvettél, így nincs mit összehasonlítani.",
    insights,
  };
}
