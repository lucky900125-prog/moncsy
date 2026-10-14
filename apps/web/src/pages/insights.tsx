import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { endOfMonth, startOfMonth, subMonths } from "date-fns";
import { Sparkles, TrendingUp, Info, AlertTriangle, CheckCircle2, ChevronDown, Search, ScanLine, Store } from "lucide-react";
import type { AnalyzeResponse } from "@et/shared";
import { buildProductStats, rankStores, type ProductStat } from "@et/shared/products";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Segmented } from "@/components/ui/segmented";
import { useApp } from "@/store/app";
import { money, shortDate } from "@/lib/format";
import { cn } from "@/lib/utils";

type Range = "this" | "last" | "quarter";

function range(r: Range) {
  const now = new Date();
  if (r === "this") return { from: startOfMonth(now), to: now };
  if (r === "last") { const p = subMonths(now, 1); return { from: startOfMonth(p), to: endOfMonth(p) }; }
  return { from: startOfMonth(subMonths(now, 2)), to: now };
}

const PRESETS = [
  "Hol tudnék a legkönnyebben spórolni?",
  "Mely előfizetéseim drágultak vagy feleslegesek?",
  "Hogyan alakult az élelmiszer-költésem?",
];

const severityStyle = {
  info: { icon: Info, cls: "text-muted-foreground" },
  positive: { icon: CheckCircle2, cls: "text-positive" },
  warning: { icon: AlertTriangle, cls: "text-amber-600 dark:text-amber-300" },
} as const;

export function InsightsPage({ tab = "ai" }: { tab?: "ai" | "details" }) {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Elemzés</h1>
          <p className="text-sm text-muted-foreground">
            {tab === "ai"
              ? "Összesített adatokból dolgozik, nem a nyers tételeidből. Bármelyik AI szolgáltatóval működik."
              : "A blokkokról beolvasott termékek, és hogy melyik boltban voltak a legolcsóbbak."}
          </p>
        </div>
        <Segmented
          value={tab}
          onChange={(t) => navigate(t === "ai" ? "/elemzes" : "/elemzes/reszletek")}
          className="w-full sm:w-64"
          options={[
            { value: "ai", label: "AI elemzés" },
            { value: "details", label: "Részletek" },
          ]}
        />
      </div>
      {tab === "ai" ? <AiTab /> : <DetailsTab />}
    </div>
  );
}

function useAnalysis() {
  const backend = useApp((s) => s.backend);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AnalyzeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run(req: Parameters<NonNullable<typeof backend>["analyze"]>[0]) {
    if (!backend) return;
    setBusy(true);
    setError(null);
    try {
      setRes(await backend.analyze(req));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return { busy, res, error, run };
}

function AnalysisResult({ busy, res, error }: { busy: boolean; res: AnalyzeResponse | null; error: string | null }) {
  return (
    <>
      {error && <Card className="animate-rise-in border-destructive/30 p-5 text-sm text-destructive">Az elemzés nem sikerült: {error}</Card>}

      {busy && !res && (
        <Card className="flex flex-col gap-3 p-5">
          {[90, 75, 82].map((w, i) => <div key={i} className="h-3 animate-pulse rounded bg-muted" style={{ width: `${w}%` }} />)}
        </Card>
      )}

      {res && (
        <div key={res.summary} className={cn("flex animate-rise-in flex-col gap-3 transition-opacity duration-300", busy && "opacity-50")}>
          <Card>
            <CardContent className="flex flex-col gap-3 pt-5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-medium"><TrendingUp className="size-4 text-primary" /> Összefoglaló</div>
                <Badge>{res.provider} · {res.model}</Badge>
              </div>
              <p className="text-sm leading-relaxed">{res.summary}</p>
            </CardContent>
          </Card>
          <div className="grid gap-3 sm:grid-cols-2">
            {res.insights.map((ins, i) => {
              const s = severityStyle[ins.severity];
              return (
                <Card key={i} className="animate-rise-in p-4" style={{ animationDelay: `${i * 60}ms` }}>
                  <div className="flex items-start gap-3">
                    <s.icon className={cn("mt-0.5 size-4 shrink-0", s.cls)} />
                    <div>
                      <div className="text-sm font-medium">{ins.title}</div>
                      <div className="mt-1 text-sm text-muted-foreground">{ins.detail}</div>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

function AiTab() {
  const [r, setR] = useState<Range>("this");
  const [question, setQuestion] = useState("");
  const a = useAnalysis();

  function run(q = question) {
    const { from, to } = range(r);
    void a.run({ from: from.toISOString(), to: to.toISOString(), question: q.trim() || undefined });
  }

  return (
    <>
      <Card>
        <CardContent className="flex flex-col gap-4 pt-5">
          <Segmented
            value={r}
            onChange={setR}
            className="sm:max-w-sm"
            options={[
              { value: "this", label: "Ez a hónap" },
              { value: "last", label: "Előző hónap" },
              { value: "quarter", label: "3 hónap" },
            ]}
          />
          <Textarea value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Kérdezz valamit a költéseidről (opcionális)" rows={2} />
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => { setQuestion(p); run(p); }}
                className="rounded-full border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors duration-200 hover:text-foreground"
              >
                {p}
              </button>
            ))}
          </div>
          <Button onClick={() => run()} disabled={a.busy} className="self-start">
            <Sparkles /> {a.busy ? "Elemzés…" : "Elemzés indítása"}
          </Button>
        </CardContent>
      </Card>
      <AnalysisResult busy={a.busy} res={a.res} error={a.error} />
    </>
  );
}

type DetailRange = "quarter" | "this" | "all";

const unitLabel = (p: ProductStat) => (p.baseUnit ? `/${p.baseUnit}` : "/db");
const priceOf = (p: ProductStat, s: ProductStat["stores"][number]) => (p.baseUnit ? (s.avgBasePrice ?? s.avgUnitPrice) : s.avgUnitPrice);

function DetailsTab() {
  const transactions = useApp((s) => s.transactions);
  const [r, setR] = useState<DetailRange>("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const a = useAnalysis();

  const from = r === "all" ? null : r === "this" ? startOfMonth(new Date()) : startOfMonth(subMonths(new Date(), 2));
  const stats = useMemo(
    () => buildProductStats(from ? transactions.filter((t) => new Date(t.date) >= from) : transactions),
    // from is derived from r; recomputing it every render would defeat the memo
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transactions, r],
  );
  const ranking = useMemo(() => rankStores(stats), [stats]);
  const needle = q.trim().toLocaleLowerCase("hu");
  const shown = needle
    ? stats.filter((p) => `${p.product} ${p.brand ?? ""} ${p.history.map((h) => h.name).join(" ")}`.toLocaleLowerCase("hu").includes(needle))
    : stats;
  const compared = stats.filter((p) => p.cheapest).length;

  function askAi() {
    const oldest = transactions.length ? transactions[transactions.length - 1]!.date : new Date().toISOString();
    void a.run({
      from: (from ?? new Date(oldest)).toISOString(),
      to: new Date().toISOString(),
      scope: "products",
      question: "Hol érdemes megvenni azokat a termékeket és márkákat, amiket rendszeresen veszek?",
    });
  }

  if (stats.length === 0 && r === "all") {
    return (
      <Card className="flex flex-col items-center gap-3 p-8 text-center">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-accent text-accent-foreground"><ScanLine className="size-5" /></div>
        <div>
          <p className="text-sm font-medium">Még nincs beolvasott blokktétel</p>
          <p className="mt-1 text-sm text-muted-foreground">Amikor egy blokkot beolvasol és elmentesz, a tételei (kenyér, tej…) termékként ide kerülnek.</p>
        </div>
        <Button asChild><Link to="/blokk"><ScanLine /> Blokk beolvasása</Link></Button>
      </Card>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Segmented
          value={r}
          onChange={setR}
          className="sm:w-72"
          options={[
            { value: "this", label: "Ez a hónap" },
            { value: "quarter", label: "3 hónap" },
            { value: "all", label: "Összes" },
          ]}
        />
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Termék vagy márka keresése" className="pl-9" />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="flex flex-col gap-2">
          {shown.length === 0 && (
            <Card className="p-5 text-sm text-muted-foreground">
              {stats.length === 0 ? "Ebben az időszakban nincs blokktétel." : "Nincs a keresésnek megfelelő termék."}
            </Card>
          )}
          {shown.map((p, i) => (
            <ProductRow key={p.key} p={p} open={open === p.key} onToggle={() => setOpen(open === p.key ? null : p.key)} delay={Math.min(i, 8) * 30} />
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><Store className="size-4" /> Hol volt a legolcsóbb?</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              {ranking.length === 0 ? (
                <p className="text-muted-foreground">Még nincs olyan termék, amit több boltban is megvettél, így nincs mit összehasonlítani.</p>
              ) : (
                <>
                  <p className="text-muted-foreground">{compared} termék, amit több boltban is megvettél:</p>
                  {ranking.map((s) => (
                    <div key={s.store} className="flex items-center justify-between gap-3">
                      <span>{s.store}</span>
                      <span className="tabular-nums text-muted-foreground">{s.cheapestFor} / {s.compared} legolcsóbb</span>
                    </div>
                  ))}
                </>
              )}
              <Button variant="outline" className="mt-2" onClick={askAi} disabled={a.busy}>
                <Sparkles /> {a.busy ? "Elemzés…" : "AI: hol érdemes vásárolni?"}
              </Button>
            </CardContent>
          </Card>
          <p className="px-1 text-xs text-muted-foreground">
            Az árak termékenként, azonos márkán belül hasonlíthatók. Ha a kiszerelés ismert, literre, kilóra vagy darabra vetítve.
          </p>
        </div>
      </div>

      <AnalysisResult busy={a.busy} res={a.res} error={a.error} />
    </>
  );
}

function ProductRow({ p, open, onToggle, delay }: { p: ProductStat; open: boolean; onToggle: () => void; delay: number }) {
  const cheapest = p.stores[0]!;
  return (
    <Card className="animate-rise-in overflow-hidden" style={{ animationDelay: `${delay}ms` }}>
      <button onClick={onToggle} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-200 hover:bg-muted/50" aria-expanded={open}>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium">{p.product}</span>
            {p.brand && <Badge>{p.brand}</Badge>}
            {p.pack && <span className="text-xs text-muted-foreground">{p.pack}</span>}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {p.purchases} vásárlás ·{" "}
            {p.cheapest ? (
              <>
                legolcsóbb: <span className="text-positive">{p.cheapest}</span>, {money(priceOf(p, cheapest), p.currency)}{unitLabel(p)}
                {p.saving ? <> (−{money(p.saving, p.currency)}{unitLabel(p)})</> : null}
              </>
            ) : (
              <>csak itt: {cheapest.store}</>
            )}
          </div>
        </div>
        <span className="text-sm tabular-nums">{money(p.spent, p.currency)}</span>
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-300", open && "rotate-180")} />
      </button>
      {open && (
        <div className="animate-fade-in border-t px-4 py-3 text-sm">
          <table className="w-full">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="pb-1 text-left font-normal">Bolt</th>
                <th className="pb-1 text-right font-normal">Átlagár{unitLabel(p)}</th>
                <th className="pb-1 text-right font-normal">Utolsó</th>
                <th className="pb-1 text-right font-normal">Db</th>
              </tr>
            </thead>
            <tbody>
              {p.stores.map((s) => (
                <tr key={s.store} className={cn(p.cheapest === s.store && "text-positive")}>
                  <td className="py-0.5">{s.store}</td>
                  <td className="py-0.5 text-right tabular-nums">{money(priceOf(p, s), p.currency)}</td>
                  <td className="py-0.5 text-right tabular-nums">{money(s.lastUnitPrice, p.currency)}</td>
                  <td className="py-0.5 text-right tabular-nums">{s.purchases}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="mt-3 flex flex-col gap-1 text-xs text-muted-foreground">
            {p.history.slice(0, 5).map((h, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span className="truncate">{shortDate(h.date)} · {h.store} · {h.name}</span>
                <span className="shrink-0 tabular-nums">{h.quantity !== 1 ? `${h.quantity} × ` : ""}{money(h.unitPrice, h.currency)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
