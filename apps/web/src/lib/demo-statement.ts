import type { StatementMapping, StatementPreview, StatementRole, StatementTx } from "@et/shared";

/**
 * Demo stand-in for POST /statements/parse: whatever file is chosen, it "reads" this fixed sample statement,
 * so the column mapping and preview can be tried without the API. The real parser lives on the server.
 */

const COLUMNS = ["Könyvelés dátuma", "Értéknap", "Összeg", "Pénznem", "Partner neve", "Közlemény", "Egyenleg"];

const DETECTED: StatementMapping = {
  date: "Könyvelés dátuma",
  valueDate: "Értéknap",
  amount: "Összeg",
  currency: "Pénznem",
  counterparty: "Partner neve",
  description: "Közlemény",
  balance: "Egyenleg",
};

// [days ago, amount, partner, note, category the server would guess]
const ROWS: [number, number, string, string, string | null][] = [
  [1, -4785, "SPAR 123", "Kártyás vásárlás", "groceries"],
  [2, -12990, "MOL Töltőállomás", "Kártyás vásárlás", "transport"],
  [3, -3450, "Wolt", "Online kártyás vásárlás", "restaurant"],
  [5, 685000, "Munkáltató Kft", "Munkabér", "income"],
  [6, -210000, "Kovács Anna", "Albérlet", "housing"],
  [8, -15800, "MVM Next", "Csoportos beszedés", "utilities"],
  [9, -2990, "Spotify", "Előfizetés", "subscriptions"],
  [11, -8740, "Lidl", "Kártyás vásárlás", "groceries"],
];

function cellRows() {
  let balance = 412_350;
  const now = new Date();
  return ROWS.map(([ago, amount, partner, note, cat]) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ago, 12);
    const day = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
    balance -= amount;
    const cells: Record<string, string> = {
      "Könyvelés dátuma": day,
      "Értéknap": day,
      "Összeg": amount.toLocaleString("hu-HU"),
      "Pénznem": "HUF",
      "Partner neve": partner,
      "Közlemény": note,
      "Egyenleg": balance.toLocaleString("hu-HU"),
    };
    return { cells, iso: d.toISOString(), amount, cat };
  });
}

const ROLE_LABEL: Partial<Record<StatementRole, string>> = { date: "dátum", amount: "összeg" };

export function demoParseStatement(opts: { mapping?: StatementMapping; currency?: string } = {}): StatementPreview {
  // Same currency rules as the server (routes/statements.ts, statements/tabular.ts): the field has to be a 3-letter
  // code, and a row whose currency is not one is an error for that row.
  if (opts.currency && !/^[A-Za-z]{3}$/.test(opts.currency)) throw new Error('"currency" must be an ISO 4217 code');
  // Same rule as the server: an explicit entry wins, "" means "no column", anything else is auto-detected.
  const mapping: StatementMapping = { ...DETECTED };
  for (const [role, col] of Object.entries(opts.mapping ?? {}) as [StatementRole, string][]) {
    if (col) mapping[role] = col;
    else delete mapping[role];
  }
  const dateCol = mapping.date || mapping.valueDate;
  const missing = (["date", "amount"] as const).filter((r) => (r === "date" ? !dateCol : !(mapping.amount || mapping.debit || mapping.credit)));
  if (missing.length) {
    return {
      format: "csv", columns: COLUMNS, mapping, currency: null, transactions: [], ignored: 0,
      errors: [`Hiányzik a(z) ${missing.map((r) => ROLE_LABEL[r]).join(" és a(z) ")} oszlop hozzárendelése`],
    };
  }
  const errors: string[] = [];
  const transactions: StatementTx[] = [];
  cellRows().forEach(({ cells, iso, amount, cat }, i) => {
    const raw = cells[mapping.amount ?? ""];
    const parsed = raw === undefined ? NaN : Number(raw.replace(/\s/g, "").replace(/ /g, "").replace("−", "-").replace(",", "."));
    if (!Number.isFinite(parsed) || !/\d{4}\.\d{2}\.\d{2}/.test(cells[dateCol!] ?? "")) {
      errors.push(`${i + 2}. sor: nem olvasható dátum vagy összeg`);
      return;
    }
    const rawCurrency = (mapping.currency ? cells[mapping.currency] : opts.currency) || "HUF";
    const currency = /^ft\.?$|forint/i.test(rawCurrency.trim()) ? "HUF" : rawCurrency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      errors.push(`${i + 2}. sor: ismeretlen pénznem: ${rawCurrency}`);
      return;
    }
    const merchant = cells[mapping.counterparty ?? ""] ?? cells[mapping.description ?? ""] ?? "";
    const note = mapping.description && mapping.description !== mapping.counterparty ? cells[mapping.description] : undefined;
    transactions.push({
      externalId: `demo-stmt:${iso.slice(0, 10)}:${amount}:${merchant}`,
      date: iso,
      amount: parsed,
      currency,
      merchant,
      ...(note ? { note } : {}),
      categoryId: cat,
      source: "import",
    });
  });
  return { format: "csv", columns: COLUMNS, mapping, currency: null, transactions, ignored: 0, errors };
}
