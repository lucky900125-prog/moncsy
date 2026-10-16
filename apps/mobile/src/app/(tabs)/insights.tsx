import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { endOfDay, endOfMonth, format, isValid, parse, startOfDay, startOfMonth, subMonths } from "date-fns";
import type { AnalyzeResponse } from "@et/shared";
import { Button, Card, ErrorCard, Label, Screen, useTheme } from "@/components/ui";
import { ProductDetails } from "@/components/product-details";
import { api } from "@/lib/api";

type Range = "this" | "last" | "quarter" | "custom";
const RANGES: { value: Range; label: string }[] = [
  { value: "this", label: "Ez a hónap" },
  { value: "last", label: "Előző" },
  { value: "quarter", label: "3 hónap" },
  { value: "custom", label: "Egyéni" },
];

// Whole calendar months, like the dashboard: a transaction later today (or dated later this month) is in "this month".
function range(r: Exclude<Range, "custom">) {
  const now = new Date();
  if (r === "this") return { from: startOfMonth(now), to: endOfMonth(now) };
  if (r === "last") { const p = subMonths(now, 1); return { from: startOfMonth(p), to: endOfMonth(p) }; }
  return { from: startOfMonth(subMonths(now, 2)), to: endOfMonth(now) };
}

const day = (s: string) => parse(s.trim(), "yyyy-MM-dd", new Date());

/** The user's own period, whole days from the first to the last; an error message when it cannot be used. */
function customRange(from: string, to: string) {
  const f = day(from), t = day(to);
  if (!isValid(f) || !isValid(t)) return { error: "Mindkét dátum ÉÉÉÉ-HH-NN alakban kell, például 2026-01-31." };
  if (f > t) return { error: "A kezdő dátum nem lehet a záró után." };
  return { from: startOfDay(f), to: endOfDay(t) };
}

type Tab = "ai" | "details";
const TABS: { value: Tab; label: string }[] = [
  { value: "ai", label: "AI elemzés" },
  { value: "details", label: "Részletek" },
];

export default function Insights() {
  const t = useTheme();
  const [tab, setTab] = useState<Tab>("ai");
  const [r, setR] = useState<Range>("this");
  // The custom period starts as the last twelve months, the stretch the presets do not reach.
  const [customFrom, setCustomFrom] = useState(() => format(startOfMonth(subMonths(new Date(), 11)), "yyyy-MM-dd"));
  const [customTo, setCustomTo] = useState(() => format(new Date(), "yyyy-MM-dd"));
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AnalyzeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const period = r === "custom" ? customRange(customFrom, customTo) : range(r);

  async function run() {
    if ("error" in period) return;
    setBusy(true);
    setError(null);
    try {
      setRes(await api.analyze({ from: period.from.toISOString(), to: period.to.toISOString(), question: q.trim() || undefined }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      title="Elemzés"
      subtitle={tab === "ai" ? "Összesített adatokból, bármelyik AI szolgáltatóval." : "A blokkok termékei, és hol voltak a legolcsóbbak."}
    >
      <View className="flex-row rounded-xl bg-muted p-1 dark:bg-muted-dark">
        {TABS.map((o) => (
          <Pressable key={o.value} onPress={() => setTab(o.value)} className={`h-9 flex-1 items-center justify-center rounded-lg ${tab === o.value ? "bg-card dark:bg-card-dark" : ""}`}>
            <Text className={`text-sm font-medium ${tab === o.value ? "text-fg dark:text-fg-dark" : "text-muted-fg dark:text-muted-fg-dark"}`}>{o.label}</Text>
          </Pressable>
        ))}
      </View>
      {tab === "details" ? <ProductDetails /> : <>
      <View className="flex-row rounded-xl bg-muted p-1 dark:bg-muted-dark">
        {RANGES.map((o) => (
          <Pressable key={o.value} onPress={() => setR(o.value)} className={`h-9 flex-1 items-center justify-center rounded-lg ${r === o.value ? "bg-card dark:bg-card-dark" : ""}`}>
            <Text className={`text-xs font-medium ${r === o.value ? "text-fg dark:text-fg-dark" : "text-muted-fg dark:text-muted-fg-dark"}`}>{o.label}</Text>
          </Pressable>
        ))}
      </View>
      {r === "custom" ? (
        <View className="gap-2">
          <View className="flex-row gap-2">
            {[
              { label: "Mettől", value: customFrom, set: setCustomFrom },
              { label: "Meddig", value: customTo, set: setCustomTo },
            ].map((d) => (
              <View key={d.label} className="flex-1 gap-1">
                <Label>{d.label}</Label>
                <TextInput
                  value={d.value}
                  onChangeText={d.set}
                  placeholder="ÉÉÉÉ-HH-NN"
                  placeholderTextColor={t.muted}
                  keyboardType="numbers-and-punctuation"
                  maxLength={10}
                  className="h-11 rounded-xl border border-line bg-card px-3 text-fg dark:border-line-dark dark:bg-card-dark dark:text-fg-dark"
                />
              </View>
            ))}
          </View>
          {"error" in period ? <Text className="text-sm text-danger dark:text-danger-dark">{period.error}</Text> : null}
        </View>
      ) : null}
      <TextInput
        value={q}
        onChangeText={setQ}
        multiline
        placeholder="Kérdezz valamit a költéseidről (opcionális)"
        placeholderTextColor={t.muted}
        className="min-h-20 rounded-xl border border-line bg-card px-3 py-2 text-fg dark:border-line-dark dark:bg-card-dark dark:text-fg-dark"
      />
      <Button title="Elemzés indítása" onPress={run} loading={busy} disabled={"error" in period} />
      {error ? <ErrorCard message={error} /> : null}
      {res ? (
        <>
          <Card className="gap-2">
            <View className="flex-row justify-between"><Label>Összefoglaló</Label><Label>{res.provider} · {res.model}</Label></View>
            <Text className="text-sm leading-5 text-fg dark:text-fg-dark">{res.summary}</Text>
            {res.provider === "mock" ? (
              // The server answers with its offline mock when it has no AI key: totals only, the question is not read.
              <Text className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                Ez nem AI-elemzés: a szerveren nincs AI-kulcs beállítva, ezért csak az időszak összesítését látod, a kérdésedre
                nem válaszol. Az ANTHROPIC_API_KEY megadása után valódi elemzést kapsz.
              </Text>
            ) : null}
          </Card>
          {res.insights.map((i, n) => (
            <Card key={n} className="gap-1">
              <Text className={`font-medium ${i.severity === "warning" ? "text-amber-600 dark:text-amber-300" : i.severity === "positive" ? "text-positive dark:text-positive-dark" : "text-fg dark:text-fg-dark"}`}>{i.title}</Text>
              <Text className="text-sm text-muted-fg dark:text-muted-fg-dark">{i.detail}</Text>
            </Card>
          ))}
        </>
      ) : null}
      </>}
    </Screen>
  );
}
