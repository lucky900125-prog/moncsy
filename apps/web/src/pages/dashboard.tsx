import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getDate, isSameMonth } from "date-fns";
import { ArrowDownRight, ArrowUpRight, ChevronRight, ScanLine, Sparkles } from "lucide-react";
import { Area, AreaChart, Cell, Line, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { MonthSwitcher } from "@/components/month-switcher";
import { TransactionRow } from "@/components/transaction-row";
import { CategoryBadgeIcon } from "@/components/category-dot";
import { useApp, useCategoryMap } from "@/store/app";
import { useUi } from "@/store/ui";
import { money } from "@/lib/format";
import { BASE_CURRENCY, byCategory, cumulative, inMonth, pctChange, splitByCurrency, totals } from "@/lib/stats";
import { prevMonth } from "@/lib/period";
import { cn } from "@/lib/utils";

function Stat({ label, value, delta, invert, tone, className, size = "md" }: { label: string; value: number; delta: number | null; invert?: boolean; tone?: "positive"; className?: string; size?: "md" | "lg" }) {
  const flat = delta !== null && Math.abs(delta) < 1;
  const good = delta === null ? null : invert ? delta < 0 : delta > 0;
  return (
    <Card className={className}>
      <CardHeader className="p-4 pb-1 sm:p-5 sm:pb-1">
        <CardTitle>{label}</CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0 sm:p-5 sm:pt-0">
        <div className={cn("font-semibold tracking-tight tabular-nums sm:text-2xl", size === "lg" ? "text-3xl" : "text-lg", tone === "positive" && "text-positive")}>{money(value)}</div>
        {delta !== null && (
          <div className={cn("mt-1 inline-flex items-center gap-0.5 text-xs", flat ? "text-muted-foreground" : good ? "text-positive" : "text-destructive")}>
            {flat ? null : delta >= 0 ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}
            {flat ? "Ugyanannyi" : `${Math.abs(delta).toFixed(0)}%`}<span className="hidden sm:inline">&nbsp;az előző hónap azonos időszakához</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function DashboardPage() {
  const [month, setMonth] = useState(() => new Date());
  const { transactions, status, error } = useApp();
  const cats = useCategoryMap();
  const openTx = useUi((s) => s.openTx);

  const data = useMemo(() => {
    // Only the base currency is summed; foreign-currency rows are counted and flagged instead of mixed in.
    const { base: cur, other: foreign } = splitByCurrency(inMonth(transactions, month));
    const prev = splitByCurrency(inMonth(transactions, prevMonth(month))).base;
    const isCurrent = isSameMonth(month, new Date());
    const t = totals(cur);
    // For the running month compare against the same days of the previous month, not its full total.
    const today = getDate(new Date());
    const p = totals(isCurrent ? prev.filter((x) => getDate(new Date(x.date)) <= today) : prev);
    const curCum = cumulative(cur, month, isCurrent);
    const prevCum = cumulative(prev, prevMonth(month), false);
    const series = curCum.map((v, i) => ({ day: i + 1, current: v, previous: prevCum[i] ?? prevCum[prevCum.length - 1] }));
    return { cur, foreign, t, p, series, cats: byCategory(cur, cats) };
  }, [transactions, month, cats]);

  if (status === "error") {
    return (
      <Card className="flex flex-col items-start gap-3 p-6 text-sm">
        <p className="text-destructive">Nem sikerült betölteni az adatokat: {error}</p>
        <Button asChild variant="outline" size="sm"><Link to="/beallitasok">Kapcsolat beállítása</Link></Button>
      </Card>
    );
  }
  if (status === "loading") {
    return <div className="grid gap-4 sm:grid-cols-3">{[0, 1, 2].map((i) => <div key={i} className="h-28 animate-pulse rounded-xl bg-muted" />)}</div>;
  }

  const budgets = [...cats.values()].filter((c) => c.budget);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Áttekintés</h1>
          <p className="text-sm text-muted-foreground">Hová ment a pénz ebben a hónapban.</p>
        </div>
        <MonthSwitcher value={month} onChange={setMonth} />
      </div>

      {data.foreign.length > 0 && (
        <p className="-mt-2 text-xs text-muted-foreground">
          {data.foreign.length} tétel más pénznemben ({[...new Set(data.foreign.map((t) => t.currency))].join(", ")}) van ebben a hónapban, ezek nincsenek benne a {BASE_CURRENCY} összesítésekben.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Kiadás" value={data.t.expense} delta={pctChange(data.t.expense, data.p.expense)} invert size="lg" className="col-span-2 sm:col-span-1" />
        <Stat label="Bevétel" value={data.t.income} delta={pctChange(data.t.income, data.p.income)} tone="positive" />
        <Stat label="Egyenleg" value={data.t.balance} delta={null} tone={data.t.balance >= 0 ? "positive" : undefined} />
      </div>

      <div className="grid gap-3 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Halmozott költés</CardTitle>
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5"><span className="h-0.5 w-3 rounded bg-primary" />Ez a hónap</span>
              <span className="flex items-center gap-1.5"><span className="h-0.5 w-3 rounded border-t border-dashed border-muted-foreground" />Előző</span>
            </div>
          </CardHeader>
          <CardContent className="h-56 px-2">
            <ResponsiveContainer>
              <AreaChart data={data.series} margin={{ left: 8, right: 8, top: 8 }}>
                <defs>
                  <linearGradient id="fillCur" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.22} />
                    <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="day" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} interval={6} />
                <YAxis hide />
                <Tooltip
                  cursor={{ stroke: "var(--border)" }}
                  contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 10, fontSize: 12 }}
                  formatter={(v: unknown, n: unknown) => [money(Number(v)), n === "current" ? "Ez a hónap" : "Előző hónap"]}
                  labelFormatter={(d) => `${d}. nap`}
                />
                <Line type="monotone" dataKey="previous" stroke="var(--muted-foreground)" strokeOpacity={0.5} strokeDasharray="4 4" dot={false} strokeWidth={1.5} animationDuration={900} />
                <Area type="monotone" dataKey="current" stroke="var(--primary)" strokeWidth={2} fill="url(#fillCur)" connectNulls={false} animationDuration={900} />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Kategóriák szerint</CardTitle>
          </CardHeader>
          <CardContent>
            {data.cats.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">Ebben a hónapban még nincs kiadás.</p>
            ) : (
              <div className="flex items-center gap-4">
                <div className="relative size-32 shrink-0">
                  <ResponsiveContainer>
                    <PieChart>
                      <Pie data={data.cats} dataKey="value" innerRadius={42} outerRadius={62} paddingAngle={2} stroke="none" animationDuration={900}>
                        {data.cats.map((c) => <Cell key={c.id ?? "none"} fill={c.category?.color ?? "#94a3a8"} />)}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-[10px] text-muted-foreground">Összesen</span>
                    <span className="text-xs font-semibold tabular-nums">{money(data.t.expense, "HUF", { compact: true })}</span>
                  </div>
                </div>
                <ul className="flex min-w-0 flex-1 flex-col gap-1.5">
                  {data.cats.slice(0, 5).map((c) => (
                    <li key={c.id ?? "none"} className="flex items-center gap-2 text-xs">
                      <span className="size-2 shrink-0 rounded-full" style={{ background: c.category?.color ?? "#94a3a8" }} />
                      <span className="flex-1 truncate">{c.category?.name ?? "Nincs kategória"}</span>
                      <span className="tabular-nums text-muted-foreground">{Math.round((c.value / (data.t.expense || 1)) * 100)}%</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Legutóbbi tételek</CardTitle>
            <Button asChild variant="ghost" size="sm" className="-mr-2 text-muted-foreground">
              <Link to="/tetelek">Mind <ChevronRight /></Link>
            </Button>
          </CardHeader>
          <CardContent className="px-3">
            {inMonth(transactions, month).slice(0, 6).map((t) => (
              <TransactionRow key={t.id} tx={t} category={t.categoryId ? cats.get(t.categoryId) : undefined} onClick={() => openTx(t)} />
            ))}
            {data.cur.length + data.foreign.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">Nincs tétel ebben a hónapban.</p>}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-3 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Keretek</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {budgets.length === 0 && <p className="text-sm text-muted-foreground">Állíts be havi keretet egy kategóriánál.</p>}
              {budgets.map((c) => {
                const spent = data.cats.find((x) => x.id === c.id)?.value ?? 0;
                const pct = (spent / (c.budget || 1)) * 100;
                return (
                  <div key={c.id} className="flex items-center gap-3">
                    <CategoryBadgeIcon category={c} size="sm" />
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <div className="flex justify-between text-xs">
                        <span className="truncate font-medium">{c.name}</span>
                        <span className={cn("tabular-nums text-muted-foreground", pct > 100 && "text-destructive")}>
                          {money(spent, "HUF", { compact: true })} / {money(c.budget!, "HUF", { compact: true })}
                        </span>
                      </div>
                      <Progress value={pct} color={pct > 100 ? "var(--destructive)" : c.color} />
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <div className="grid grid-cols-2 gap-3">
            <Link to="/blokk" className="group rounded-xl border bg-card p-4 transition-colors duration-200 hover:bg-muted/60">
              <ScanLine className="size-5 text-primary" />
              <div className="mt-3 text-sm font-medium">Blokk beolvasása</div>
              <div className="text-xs text-muted-foreground">Fotózd le, a többit intézi.</div>
            </Link>
            <Link to="/elemzes" className="group rounded-xl border bg-card p-4 transition-colors duration-200 hover:bg-muted/60">
              <Sparkles className="size-5 text-primary" />
              <div className="mt-3 text-sm font-medium">AI elemzés</div>
              <div className="text-xs text-muted-foreground">Mire figyelj ebben a hónapban.</div>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
