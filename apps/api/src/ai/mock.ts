import type { AIProvider, ChatMessage, CompleteOptions } from "./types.js";

/**
 * Deterministic offline provider. Used by default when no API key is configured, and in tests.
 * - vision(): always returns the same plausible Hungarian supermarket receipt.
 * - complete(): if the prompt carries an <aggregate>…</aggregate> JSON block (see ai/prompts.ts),
 *   derives a few insights from it; otherwise returns a fixed JSON object.
 */
export class MockProvider implements AIProvider {
  readonly name = "mock";
  readonly model = "mock-1";

  async complete(messages: ChatMessage[], _opts?: CompleteOptions): Promise<string> {
    const text = messages.map((m) => m.content).join("\n");
    const m = text.match(/<aggregate>([\s\S]*?)<\/aggregate>/);
    if (!m) return JSON.stringify({ summary: "Mock válasz.", insights: [] });
    return JSON.stringify(mockAnalysis(JSON.parse(m[1]!) as MockAggregate));
  }

  async vision(_b64: string, _mime: string, _prompt: string): Promise<string> {
    return JSON.stringify({
      merchant: "SPAR Magyarország Kft.",
      date: "2026-10-12",
      total: 4785,
      currency: "HUF",
      items: [
        { name: "Tej 2,8% 1l", quantity: 2, unitPrice: 389, total: 778 },
        { name: "Kenyér fehér 500g", quantity: 1, unitPrice: 549, total: 549 },
        { name: "Trappista sajt 250g", quantity: 1, unitPrice: 1299, total: 1299 },
        { name: "Alma Jonagold", quantity: 1.5, unitPrice: 599, total: 899 },
        { name: "Ásványvíz 1,5l", quantity: 6, unitPrice: 210, total: 1260 },
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
