import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { startOfMonth, subMonths } from "date-fns";
import { ChevronDown, ScanLine, Search, Sparkles, Store, X } from "lucide-react";
import type { ProductFilter } from "@et/shared";
import { buildProductStats, rankStores, type ProductStat, type StorePrice } from "@et/shared/products";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AnalysisResult, useAnalysis } from "@/components/analysis-result";
import { useApp } from "@/store/app";
import { money, shortDate } from "@/lib/format";
import { cn } from "@/lib/utils";

type DetailRange = "this" | "quarter" | "all";

const ALL_BRANDS = "__all";

// Without a package size the price is per receipt unit. A fractional quantity means goods sold by weight or volume,
// and the line does not say whether that is kg or l, so no unit is shown rather than a wrong "/db".
const unitLabel = (p: ProductStat) => (p.baseUnit ? `/${p.baseUnit}` : p.history.every((h) => Number.isInteger(h.quantity)) ? "/db" : "");
const priceOf = (p: ProductStat, s: StorePrice) => (p.baseUnit ? (s.avgBasePrice ?? s.avgUnitPrice) : s.avgUnitPrice);
/** Stores sharing the lowest price; cheapest is null when there are two or more of them. */
const tiedAtBest = (p: ProductStat) => p.stores.filter((s) => priceOf(p, s) === priceOf(p, p.stores[0]!)).map((s) => s.store);
const productLabel = (p: ProductStat) => `${p.brand ? `${p.brand} ` : ""}${p.product}${p.pack ? ` (${p.pack})` : ""}`;

function rangeStart(r: DetailRange) {
  if (r === "all") return null;
  return r === "this" ? startOfMonth(new Date()) : startOfMonth(subMonths(new Date(), 2));
}

export function DetailsTab() {
  const transactions = useApp((s) => s.transactions);
  const [r, setR] = useState<DetailRange>("all");
  const [q, setQ] = useState("");
  const [brand, setBrand] = useState<string>(ALL_BRANDS);
  const [store, setStore] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const aiRef = useRef<HTMLDivElement>(null);
  const a = useAnalysis();

  const stats = useMemo(() => {
    const from = rangeStart(r);
    return buildProductStats(from ? transactions.filter((t) => new Date(t.date) >= from) : transactions);
  }, [transactions, r]);

  const brands = useMemo(() => [...new Set(stats.map((p) => p.brand).filter((b): b is string => !!b))].sort((x, y) => x.localeCompare(y, "hu")), [stats]);
  const stores = useMemo(() => [...new Set(stats.flatMap((p) => p.stores.map((s) => s.store)))].sort((x, y) => x.localeCompare(y, "hu")), [stats]);

  const needle = q.trim().toLocaleLowerCase("hu");
  // The ranking answers "where is this selection cheapest", so it follows brand and search but not the store chip.
  const selection = useMemo(
    () =>
      stats.filter(
        (p) =>
          (brand === ALL_BRANDS || p.brand === brand) &&
          (!needle || `${p.product} ${p.brand ?? ""} ${p.history.map((h) => h.name).join(" ")}`.toLocaleLowerCase("hu").includes(needle)),
      ),
    [stats, brand, needle],
  );
  const filtered = useMemo(() => (store ? selection.filter((p) => p.stores.some((s) => s.store === store)) : selection), [selection, store]);
  const ranking = useMemo(() => rankStores(selection), [selection]);
  // One sum per currency, HUF first: adding EUR to HUF would be wrong, and leaving it out would hide it.
  const totals = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of filtered) m.set(p.currency, (m.get(p.currency) ?? 0) + p.spent);
    return [...m].sort(([a], [b]) => (a === "HUF" ? -1 : b === "HUF" ? 1 : a.localeCompare(b)));
  }, [filtered]);
  const compared = ranking.length ? Math.max(...ranking.map((s) => s.compared)) : 0;
  const brandName = brand === ALL_BRANDS ? null : brand;

  const presets = [
    brandName ? `Hol érdemes ${brandName} termékeket venni?` : "Hol érdemes megvenni, amit rendszeresen veszek?",
    "Melyik terméknél számít a legtöbbet, hol vásárolok?",
    store ? `Mit éri meg inkább máshol venni, mint a ${store} boltban?` : "Mely termékek drágultak az utóbbi időben?",
  ];

  // The AI gets the products the user is looking at: the current filters, or one product when asked from its row.
  const currentFilter = (): ProductFilter | undefined => {
    const f: ProductFilter = { q: q.trim() || undefined, brand: brandName ?? undefined, merchant: store ?? undefined };
    return f.q || f.brand || f.merchant ? f : undefined;
  };

  function ask(text: string, products: ProductFilter | undefined = currentFilter()) {
    const from = rangeStart(r);
    const oldest = transactions.length ? transactions[transactions.length - 1]!.date : new Date().toISOString();
    setQuestion(text);
    void a.run({
      from: (from ?? new Date(oldest)).toISOString(),
      to: new Date().toISOString(),
      scope: "products",
      products,
      question: text.trim() || undefined,
    });
    aiRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const clearFilters = () => { setQ(""); setBrand(ALL_BRANDS); setStore(null); };
  const filtering = !!needle || brand !== ALL_BRANDS || !!store;

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
      <div className="flex flex-col gap-3">
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
          <Select value={brand} onValueChange={setBrand}>
            <SelectTrigger className="sm:w-44" aria-label="Márka"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_BRANDS}>Minden márka</SelectItem>
              {brands.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0">
          {[null, ...stores].map((s) => (
            <button
              key={s ?? "all"}
              onClick={() => setStore(s)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors duration-200",
                store === s ? "border-transparent bg-foreground text-background" : "bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              {s ? <Store className="size-3" /> : null}
              {s ?? "Minden bolt"}
            </button>
          ))}
          {filtering && (
            <button onClick={clearFilters} className="flex shrink-0 items-center gap-1 px-2 py-1.5 text-xs text-muted-foreground transition-colors duration-200 hover:text-foreground">
              <X className="size-3" /> Szűrők törlése
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="flex flex-col gap-2">
          <p className="px-1 text-xs text-muted-foreground">
            {filtered.length} termék{totals.map(([c, v]) => ` · ${money(v, c)}`).join("")}
          </p>
          {filtered.length === 0 && (
            <Card className="p-5 text-sm text-muted-foreground">
              {stats.length === 0 ? "Ebben az időszakban nincs blokktétel." : "Nincs a szűrésnek megfelelő termék."}
            </Card>
          )}
          {filtered.map((p, i) => (
            <ProductRow
              key={p.key}
              p={p}
              open={open === p.key}
              onToggle={() => setOpen(open === p.key ? null : p.key)}
              onAsk={() => ask(`Hol érdemes venni: ${productLabel(p)}?`, { q: p.product, brand: p.brand ?? undefined })}
              busy={a.busy}
              delay={Math.min(i, 8) * 30}
            />
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Store className="size-4" /> {brandName ? `Hol a legolcsóbb a ${brandName}?` : "Hol volt a legolcsóbb?"}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              {ranking.length === 0 ? (
                <p className="text-muted-foreground">Még nincs olyan termék, amit több boltban is megvettél, így nincs mit összehasonlítani.</p>
              ) : (
                <>
                  <p className="text-muted-foreground">Több boltban is megvett termékek alapján ({compared} db):</p>
                  {ranking.map((s) => (
                    <div key={s.store} className="flex flex-col gap-1">
                      <div className="flex items-center justify-between gap-3">
                        <span>{s.store}</span>
                        <span className="tabular-nums text-muted-foreground">{s.cheapestFor} / {s.compared} legolcsóbb</span>
                      </div>
                      <div className="h-1 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-primary/70 transition-[width] duration-500 ease-[var(--ease-calm)]" style={{ width: `${(s.cheapestFor / (s.compared || 1)) * 100}%` }} />
                      </div>
                    </div>
                  ))}
                </>
              )}
            </CardContent>
          </Card>
          <p className="px-1 text-xs text-muted-foreground">
            Az árak termékenként, azonos márkán belül hasonlíthatók. Ha a kiszerelés ismert, literre, kilóra vagy darabra vetítve.
          </p>
        </div>
      </div>

      <div ref={aiRef} className="scroll-mt-20">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Sparkles className="size-4" /> Kérdezd az AI-t a termékeidről</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Textarea value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Pl. hol érdemes Mizo tejet venni?" rows={2} />
            <div className="flex flex-wrap gap-2">
              {presets.map((p) => (
                <button
                  key={p}
                  onClick={() => ask(p)}
                  disabled={a.busy}
                  className="rounded-full border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors duration-200 hover:text-foreground disabled:opacity-50"
                >
                  {p}
                </button>
              ))}
            </div>
            <Button onClick={() => ask(question)} disabled={a.busy} className="self-start">
              <Sparkles /> {a.busy ? "Elemzés…" : "Kérdezés"}
            </Button>
          </CardContent>
        </Card>
      </div>

      <AnalysisResult busy={a.busy} res={a.res} error={a.error} />
    </>
  );
}

function ProductRow({ p, open, onToggle, onAsk, busy, delay }: { p: ProductStat; open: boolean; onToggle: () => void; onAsk: () => void; busy: boolean; delay: number }) {
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
            {p.stores.length === 1 ? (
              <>csak itt: {cheapest.store}</>
            ) : (
              <>
                {p.cheapest ? <>legolcsóbb: <span className="text-positive">{p.cheapest}</span></> : <>legolcsóbb egyforma áron: {tiedAtBest(p).join(", ")}</>}
                , {money(priceOf(p, cheapest), p.currency)}{unitLabel(p)}
                {p.saving ? <> (−{money(p.saving, p.currency)}{unitLabel(p)})</> : null}
              </>
            )}
          </div>
        </div>
        <span className="text-sm tabular-nums">{money(p.spent, p.currency)}</span>
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-300 ease-[var(--ease-calm)]", open && "rotate-180")} />
      </button>
      {/* Height animates through grid rows, so opening and closing both glide instead of snapping. */}
      <div className={cn("grid transition-[grid-template-rows,opacity] duration-300 ease-[var(--ease-calm)]", open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")} inert={!open}>
        <div className="min-h-0 overflow-hidden">
          <div className="border-t px-4 py-3 text-sm">
            <table className="w-full">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="pb-1 text-left font-normal">Bolt</th>
                  <th className="pb-1 text-right font-normal">Átlagár{unitLabel(p)}</th>
                  <th className="pb-1 text-right font-normal">{p.baseUnit && p.pack !== `1 ${p.baseUnit}` ? "Utolsó/csomag" : "Utolsó"}</th>
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
                  <span className="shrink-0 tabular-nums">{h.quantity !== 1 ? `${h.quantity.toLocaleString("hu-HU", { maximumFractionDigits: 2 })} × ` : ""}{money(h.unitPrice, h.currency)}</span>
                </li>
              ))}
            </ul>
            <Button variant="ghost" size="sm" className="-ml-2 mt-2 text-muted-foreground" onClick={onAsk} disabled={busy}>
              <Sparkles /> Kérdezd az AI-t erről a termékről
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
