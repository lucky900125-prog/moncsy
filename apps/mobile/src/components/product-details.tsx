import { useMemo, useState } from "react";
import { LayoutAnimation, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { format, startOfMonth, subMonths } from "date-fns";
import { hu } from "date-fns/locale";
import { ChevronDown, Search } from "lucide-react-native";
import type { AnalyzeResponse, ProductFilter } from "@et/shared";
import { buildProductStats, rankStores, type ProductStat, type StorePrice } from "@et/shared/products";
import { Button, Card, ErrorCard, Label, useTheme } from "@/components/ui";
import { api } from "@/lib/api";
import { useData } from "@/lib/data";
import { money } from "@/lib/format";

type Range = "this" | "quarter" | "all";
const RANGES: { value: Range; label: string }[] = [
  { value: "this", label: "Ez a hónap" },
  { value: "quarter", label: "3 hónap" },
  { value: "all", label: "Összes" },
];

const unitLabel = (p: ProductStat) => (p.baseUnit ? `/${p.baseUnit}` : "/db");
const priceOf = (p: ProductStat, s: StorePrice) => (p.baseUnit ? (s.avgBasePrice ?? s.avgUnitPrice) : s.avgUnitPrice);
/** Stores sharing the lowest price; cheapest is null when there are two or more of them. */
const tiedAtBest = (p: ProductStat) => p.stores.filter((s) => priceOf(p, s) === priceOf(p, p.stores[0]!)).map((s) => s.store);
const productLabel = (p: ProductStat) => `${p.brand ? `${p.brand} ` : ""}${p.product}${p.pack ? ` (${p.pack})` : ""}`;
const shortDate = (iso: string) => format(new Date(iso), "MMM d.", { locale: hu });
const rangeStart = (r: Range) => (r === "all" ? null : r === "this" ? startOfMonth(new Date()) : startOfMonth(subMonths(new Date(), 2)));

// Same calm motion as the web: an eased height change instead of a jump.
const glide = () => LayoutAnimation.configureNext(LayoutAnimation.create(260, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity));

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      className={`rounded-full border px-3 py-1.5 ${active ? "border-transparent bg-fg dark:bg-fg-dark" : "border-line bg-card dark:border-line-dark dark:bg-card-dark"}`}
    >
      <Text className={`text-xs ${active ? "text-bg dark:text-bg-dark" : "text-muted-fg dark:text-muted-fg-dark"}`}>{label}</Text>
    </Pressable>
  );
}

/** "Részletek": receipt line items as products, where each was cheapest, and AI questions about them. */
export function ProductDetails() {
  const t = useTheme();
  const { transactions } = useData();
  const [r, setR] = useState<Range>("all");
  const [q, setQ] = useState("");
  const [brand, setBrand] = useState<string | null>(null);
  const [store, setStore] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AnalyzeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stats = useMemo(() => {
    const from = rangeStart(r);
    return buildProductStats(from ? transactions.filter((x) => new Date(x.date) >= from) : transactions);
  }, [transactions, r]);
  const brands = useMemo(() => [...new Set(stats.map((p) => p.brand).filter((b): b is string => !!b))].sort((a, b) => a.localeCompare(b, "hu")), [stats]);
  const stores = useMemo(() => [...new Set(stats.flatMap((p) => p.stores.map((s) => s.store)))].sort((a, b) => a.localeCompare(b, "hu")), [stats]);

  const needle = q.trim().toLocaleLowerCase("hu");
  // The ranking follows brand and search, not the store filter: it answers "where is this selection cheapest".
  const selection = useMemo(
    () =>
      stats.filter(
        (p) =>
          (!brand || p.brand === brand) &&
          (!needle || `${p.product} ${p.brand ?? ""} ${p.history.map((h) => h.name).join(" ")}`.toLocaleLowerCase("hu").includes(needle)),
      ),
    [stats, brand, needle],
  );
  const shown = useMemo(() => (store ? selection.filter((p) => p.stores.some((s) => s.store === store)) : selection), [selection, store]);
  const ranking = useMemo(() => rankStores(selection), [selection]);

  // The AI gets the products the user is looking at: the current filters, or one product when asked from its row.
  const currentFilter = (): ProductFilter | undefined => {
    const f: ProductFilter = { q: q.trim() || undefined, brand: brand ?? undefined, merchant: store ?? undefined };
    return f.q || f.brand || f.merchant ? f : undefined;
  };

  async function ask(text: string, products: ProductFilter | undefined = currentFilter()) {
    const from = rangeStart(r);
    const oldest = transactions.length ? transactions[transactions.length - 1]!.date : new Date().toISOString();
    setQuestion(text);
    setBusy(true);
    setError(null);
    try {
      setRes(await api.analyze({ from: (from ?? new Date(oldest)).toISOString(), to: new Date().toISOString(), scope: "products", products, question: text.trim() || undefined }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const presets = [
    brand ? `Hol érdemes ${brand} termékeket venni?` : "Hol érdemes megvenni, amit rendszeresen veszek?",
    "Melyik terméknél számít a legtöbbet, hol vásárolok?",
  ];

  if (stats.length === 0 && r === "all") {
    return (
      <Card className="items-center gap-2 py-8">
        <Text className="font-medium text-fg dark:text-fg-dark">Még nincs beolvasott blokktétel</Text>
        <Text className="text-center text-sm text-muted-fg dark:text-muted-fg-dark">
          Amikor egy blokkot beolvasol és elmentesz, a tételei (kenyér, tej…) termékként ide kerülnek.
        </Text>
      </Card>
    );
  }

  return (
    <>
      <View className="flex-row rounded-xl bg-muted p-1 dark:bg-muted-dark">
        {RANGES.map((o) => (
          <Pressable key={o.value} onPress={() => setR(o.value)} className={`h-9 flex-1 items-center justify-center rounded-lg ${r === o.value ? "bg-card dark:bg-card-dark" : ""}`}>
            <Text className={`text-xs font-medium ${r === o.value ? "text-fg dark:text-fg-dark" : "text-muted-fg dark:text-muted-fg-dark"}`}>{o.label}</Text>
          </Pressable>
        ))}
      </View>

      <View className="h-11 flex-row items-center gap-2 rounded-xl border border-line bg-card px-3 dark:border-line-dark dark:bg-card-dark">
        <Search size={16} color={t.muted} />
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Termék vagy márka keresése"
          placeholderTextColor={t.muted}
          autoCorrect={false}
          className="flex-1 text-fg dark:text-fg-dark"
        />
      </View>

      {brands.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2">
          <Chip label="Minden márka" active={!brand} onPress={() => setBrand(null)} />
          {brands.map((b) => <Chip key={b} label={b} active={brand === b} onPress={() => setBrand(brand === b ? null : b)} />)}
        </ScrollView>
      )}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2">
        <Chip label="Minden bolt" active={!store} onPress={() => setStore(null)} />
        {stores.map((s) => <Chip key={s} label={s} active={store === s} onPress={() => setStore(store === s ? null : s)} />)}
      </ScrollView>

      <Card className="gap-2">
        <Label>{brand ? `Hol a legolcsóbb a ${brand}?` : "Hol volt a legolcsóbb?"}</Label>
        {ranking.length === 0 ? (
          <Text className="text-sm text-muted-fg dark:text-muted-fg-dark">Még nincs olyan termék, amit több boltban is megvettél.</Text>
        ) : (
          ranking.map((s) => (
            <View key={s.store} className="gap-1">
              <View className="flex-row justify-between">
                <Text className="text-sm text-fg dark:text-fg-dark">{s.store}</Text>
                <Text className="text-sm text-muted-fg dark:text-muted-fg-dark">{s.cheapestFor} / {s.compared} legolcsóbb</Text>
              </View>
              <View className="h-1 overflow-hidden rounded-full bg-muted dark:bg-muted-dark">
                <View className="h-full rounded-full bg-primary dark:bg-primary-dark" style={{ width: `${(s.cheapestFor / (s.compared || 1)) * 100}%`, opacity: 0.7 }} />
              </View>
            </View>
          ))
        )}
      </Card>

      <Text className="px-1 text-xs text-muted-fg dark:text-muted-fg-dark">{shown.length} termék</Text>
      {shown.length === 0 ? (
        <Card><Text className="text-sm text-muted-fg dark:text-muted-fg-dark">Nincs a szűrésnek megfelelő termék.</Text></Card>
      ) : (
        shown.map((p) => (
          <ProductRow
            key={p.key}
            p={p}
            open={open === p.key}
            onToggle={() => { glide(); setOpen(open === p.key ? null : p.key); }}
            onAsk={() => ask(`Hol érdemes venni: ${productLabel(p)}?`, { q: p.product, brand: p.brand ?? undefined })}
            busy={busy}
          />
        ))
      )}

      <Card className="gap-3">
        <Label>Kérdezd az AI-t a termékeidről</Label>
        <TextInput
          value={question}
          onChangeText={setQuestion}
          multiline
          placeholder="Pl. hol érdemes Mizo tejet venni?"
          placeholderTextColor={t.muted}
          className="min-h-16 rounded-xl border border-line bg-bg px-3 py-2 text-fg dark:border-line-dark dark:bg-bg-dark dark:text-fg-dark"
        />
        <View className="flex-row flex-wrap gap-2">
          {presets.map((p) => <Chip key={p} label={p} active={false} onPress={() => ask(p)} />)}
        </View>
        <Button title="Kérdezés" onPress={() => ask(question)} loading={busy} />
      </Card>

      {error ? <ErrorCard message={error} /> : null}
      {res ? (
        <>
          <Card className="gap-2">
            <View className="flex-row justify-between"><Label>Összefoglaló</Label><Label>{res.provider} · {res.model}</Label></View>
            <Text className="text-sm leading-5 text-fg dark:text-fg-dark">{res.summary}</Text>
          </Card>
          {res.insights.map((i, n) => (
            <Card key={n} className="gap-1">
              <Text className={`font-medium ${i.severity === "warning" ? "text-amber-600 dark:text-amber-300" : i.severity === "positive" ? "text-positive dark:text-positive-dark" : "text-fg dark:text-fg-dark"}`}>{i.title}</Text>
              <Text className="text-sm text-muted-fg dark:text-muted-fg-dark">{i.detail}</Text>
            </Card>
          ))}
        </>
      ) : null}
    </>
  );
}

function ProductRow({ p, open, onToggle, onAsk, busy }: { p: ProductStat; open: boolean; onToggle: () => void; onAsk: () => void; busy: boolean }) {
  const t = useTheme();
  const cheapest = p.stores[0]!;
  return (
    // Not <Card>: its p-4 would double the row's own padding (NativeWind does not let a later p-0 win).
    <View className="overflow-hidden rounded-2xl border border-line bg-card dark:border-line-dark dark:bg-card-dark">
      <Pressable onPress={onToggle} className="flex-row items-center gap-3 px-4 py-3 active:opacity-80">
        <View className="flex-1 gap-0.5">
          <View className="flex-row flex-wrap items-center gap-1.5">
            <Text className="font-medium text-fg dark:text-fg-dark">{p.product}</Text>
            {p.brand ? (
              <View className="rounded-full bg-muted px-2 py-0.5 dark:bg-muted-dark">
                <Text className="text-[11px] text-muted-fg dark:text-muted-fg-dark">{p.brand}</Text>
              </View>
            ) : null}
            {p.pack ? <Text className="text-xs text-muted-fg dark:text-muted-fg-dark">{p.pack}</Text> : null}
          </View>
          <Text className="text-xs text-muted-fg dark:text-muted-fg-dark">
            {p.purchases} vásárlás ·{" "}
            {p.stores.length === 1
              ? `csak itt: ${cheapest.store}`
              : `${p.cheapest ? `legolcsóbb: ${p.cheapest}` : `legolcsóbb egyforma áron: ${tiedAtBest(p).join(", ")}`}, ${money(priceOf(p, cheapest), p.currency)}${unitLabel(p)}`}
          </Text>
        </View>
        <Text className="text-sm text-fg dark:text-fg-dark">{money(p.spent, p.currency)}</Text>
        <View style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }}>
          <ChevronDown size={16} color={t.muted} />
        </View>
      </Pressable>
      {open ? (
        <View className="gap-1 border-t border-line px-4 pb-3 pt-2 dark:border-line-dark">
          {p.stores.map((s) => (
            <View key={s.store} className="flex-row justify-between">
              <Text className={`text-sm ${p.cheapest === s.store ? "text-positive dark:text-positive-dark" : "text-fg dark:text-fg-dark"}`}>{s.store}</Text>
              <Text className={`text-sm ${p.cheapest === s.store ? "text-positive dark:text-positive-dark" : "text-fg dark:text-fg-dark"}`}>
                {money(priceOf(p, s), p.currency)}{unitLabel(p)} · {s.purchases}×
              </Text>
            </View>
          ))}
          {p.history.slice(0, 4).map((h, i) => (
            <Text key={i} numberOfLines={1} className="text-xs text-muted-fg dark:text-muted-fg-dark">
              {shortDate(h.date)} · {h.store} · {h.name} · {money(h.unitPrice, h.currency)}
            </Text>
          ))}
          <Pressable onPress={onAsk} disabled={busy} className="mt-1 self-start py-1 active:opacity-70">
            <Text className="text-xs font-medium text-primary dark:text-primary-dark">Kérdezd az AI-t erről a termékről</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
