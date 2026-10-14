import { useDeferredValue, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MonthSwitcher } from "@/components/month-switcher";
import { TransactionRow } from "@/components/transaction-row";
import { useApp, useCategoryMap } from "@/store/app";
import { useUi } from "@/store/ui";
import { dayLabel, money } from "@/lib/format";
import { inMonth, totals } from "@/lib/stats";
import { cn } from "@/lib/utils";

export function TransactionsPage() {
  const [month, setMonth] = useState(() => new Date());
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<string | null>(null);
  const q = useDeferredValue(query.trim().toLowerCase());
  const { transactions, categories } = useApp();
  const cats = useCategoryMap();
  const openTx = useUi((s) => s.openTx);

  const filtered = useMemo(
    () =>
      inMonth(transactions, month).filter(
        (t) =>
          (!cat || t.categoryId === cat) &&
          (!q || t.merchant.toLowerCase().includes(q) || (t.note ?? "").toLowerCase().includes(q)),
      ),
    [transactions, month, cat, q],
  );

  const groups = useMemo(() => {
    const m = new Map<string, typeof filtered>();
    for (const t of filtered) {
      const k = t.date.slice(0, 10);
      m.set(k, [...(m.get(k) ?? []), t]);
    }
    return [...m.entries()];
  }, [filtered]);

  const sum = totals(filtered);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Tételek</h1>
          <p className="text-sm text-muted-foreground">
            {filtered.length} tétel · <span className="tabular-nums">{money(-sum.expense)}</span>
            {sum.income > 0 && <> · <span className="tabular-nums text-positive">{money(sum.income, "HUF", { sign: true })}</span></>}
          </p>
        </div>
        <MonthSwitcher value={month} onChange={setMonth} />
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Keresés kereskedőre vagy megjegyzésre" className="pl-9" />
      </div>

      <div className="scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0">
        {[{ id: null as string | null, name: "Mind", color: undefined as string | undefined }, ...categories].map((c) => (
          <button
            key={c.id ?? "all"}
            onClick={() => setCat(c.id)}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors duration-200",
              cat === c.id ? "border-transparent bg-foreground text-background" : "bg-card text-muted-foreground hover:text-foreground",
            )}
          >
            {c.color && <span className="size-1.5 rounded-full" style={{ background: c.color }} />}
            {c.name}
          </button>
        ))}
      </div>

      {groups.length === 0 ? (
        <Card className="py-14 text-center text-sm text-muted-foreground">Nincs a szűrésnek megfelelő tétel.</Card>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map(([day, items]) => {
            const dayExp = items.reduce((s, t) => s + (t.amount < 0 ? -t.amount : 0), 0);
            return (
              <section key={day}>
                <div className="flex items-baseline justify-between px-2 pb-1">
                  <h2 className="text-xs font-medium text-muted-foreground">{dayLabel(items[0].date)}</h2>
                  {dayExp > 0 && <span className="text-xs tabular-nums text-muted-foreground">{money(-dayExp)}</span>}
                </div>
                <Card className="p-1.5">
                  {items.map((t) => (
                    <TransactionRow key={t.id} tx={t} category={t.categoryId ? cats.get(t.categoryId) : undefined} onClick={() => openTx(t)} />
                  ))}
                </Card>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
