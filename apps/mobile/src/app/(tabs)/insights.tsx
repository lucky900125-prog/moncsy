import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { endOfMonth, startOfMonth, subMonths } from "date-fns";
import type { AnalyzeResponse } from "@et/shared";
import { Button, Card, ErrorCard, Label, Screen, useTheme } from "@/components/ui";
import { ProductDetails } from "@/components/product-details";
import { api } from "@/lib/api";

type Range = "this" | "last" | "quarter";
const RANGES: { value: Range; label: string }[] = [
  { value: "this", label: "Ez a hónap" },
  { value: "last", label: "Előző" },
  { value: "quarter", label: "3 hónap" },
];

// Whole calendar months, like the dashboard: a transaction later today (or dated later this month) is in "this month".
function range(r: Range) {
  const now = new Date();
  if (r === "this") return { from: startOfMonth(now), to: endOfMonth(now) };
  if (r === "last") { const p = subMonths(now, 1); return { from: startOfMonth(p), to: endOfMonth(p) }; }
  return { from: startOfMonth(subMonths(now, 2)), to: endOfMonth(now) };
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
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AnalyzeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const { from, to } = range(r);
      setRes(await api.analyze({ from: from.toISOString(), to: to.toISOString(), question: q.trim() || undefined }));
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
      <TextInput
        value={q}
        onChangeText={setQ}
        multiline
        placeholder="Kérdezz valamit a költéseidről (opcionális)"
        placeholderTextColor={t.muted}
        className="min-h-20 rounded-xl border border-line bg-card px-3 py-2 text-fg dark:border-line-dark dark:bg-card-dark dark:text-fg-dark"
      />
      <Button title="Elemzés indítása" onPress={run} loading={busy} />
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
      </>}
    </Screen>
  );
}
