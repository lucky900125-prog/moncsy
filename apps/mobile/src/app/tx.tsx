import { useMemo, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { format } from "date-fns";
import { X } from "lucide-react-native";
import type { Transaction } from "@et/shared";
import { Button, CategoryBadge, Label, useTheme } from "@/components/ui";
import { useData } from "@/lib/data";
import { money } from "@/lib/format";

type Draft = Partial<Omit<Transaction, "id">>;

export default function TxEditor() {
  const t = useTheme();
  const { id, draft: draftParam } = useLocalSearchParams<{ id?: string; draft?: string }>();
  const { transactions, categories, save, remove } = useData();
  const existing = id ? transactions.find((x) => x.id === id) : undefined;
  const draft: Draft = useMemo(() => existing ?? (draftParam ? (JSON.parse(draftParam) as Draft) : {}), [existing, draftParam]);

  const [kind, setKind] = useState<"expense" | "income">((draft.amount ?? 0) > 0 ? "income" : "expense");
  const [amount, setAmount] = useState(draft.amount ? String(Math.abs(draft.amount)) : "");
  const [merchant, setMerchant] = useState(draft.merchant ?? "");
  const [categoryId, setCategoryId] = useState<string | null>(draft.categoryId ?? null);
  const [date, setDate] = useState(format(draft.date ? new Date(draft.date) : new Date(), "yyyy-MM-dd HH:mm"));
  const [note, setNote] = useState(draft.note ?? "");
  const [busy, setBusy] = useState(false);

  const parsed = Number(amount.replace(/\s/g, "").replace(",", "."));
  const when = new Date(date.replace(" ", "T"));
  const dateValid = !Number.isNaN(when.getTime());
  const valid = Number.isFinite(parsed) && parsed > 0 && dateValid;
  const currency = draft.currency ?? "HUF";
  const cats = categories.filter((c) => (kind === "income" ? c.id === "income" || c.isCustom : c.id !== "income"));

  async function submit() {
    setBusy(true);
    try {
      await save(
        {
          amount: kind === "expense" ? -parsed : parsed,
          currency,
          merchant: merchant.trim(),
          categoryId,
          date: when.toISOString(),
          note: note.trim() || null,
          source: draft.source ?? "manual",
          items: draft.items,
        },
        existing?.id,
      );
      router.back();
    } catch (e) {
      Alert.alert("Mentés sikertelen", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function confirmDelete() {
    if (!existing) return;
    Alert.alert("Törlöd a tételt?", existing.merchant, [
      { text: "Mégse", style: "cancel" },
      {
        text: "Törlés",
        style: "destructive",
        onPress: async () => {
          try {
            await remove(existing.id);
            router.back();
          } catch (e) {
            Alert.alert("Törlés sikertelen", (e as Error).message);
          }
        },
      },
    ]);
  }

  const input = "h-11 rounded-xl border border-line bg-card px-3 text-fg dark:border-line-dark dark:bg-card-dark dark:text-fg-dark";

  return (
    <SafeAreaView className="flex-1 bg-bg dark:bg-bg-dark">
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} className="flex-1">
        <View className="flex-row items-center justify-between px-4 py-2">
          <Text className="text-lg font-semibold text-fg dark:text-fg-dark">{existing ? "Tétel szerkesztése" : "Új tétel"}</Text>
          <Pressable onPress={() => router.back()} className="p-2" accessibilityLabel="Bezárás"><X size={20} color={t.muted} /></Pressable>
        </View>
        <ScrollView contentContainerClassName="gap-5 px-4 pb-10" keyboardShouldPersistTaps="handled">
          <View className="flex-row rounded-xl bg-muted p-1 dark:bg-muted-dark">
            {(["expense", "income"] as const).map((k) => (
              <Pressable key={k} onPress={() => setKind(k)} className={`h-9 flex-1 items-center justify-center rounded-lg ${kind === k ? "bg-card dark:bg-card-dark" : ""}`}>
                <Text className={`text-sm font-medium ${kind === k ? "text-fg dark:text-fg-dark" : "text-muted-fg dark:text-muted-fg-dark"}`}>{k === "expense" ? "Kiadás" : "Bevétel"}</Text>
              </Pressable>
            ))}
          </View>
          <View className="flex-row items-baseline justify-center gap-2">
            <TextInput
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              placeholder="0"
              placeholderTextColor={t.muted}
              autoFocus={!existing && !draftParam}
              className={`min-w-24 text-center text-4xl font-semibold ${kind === "income" ? "text-positive dark:text-positive-dark" : "text-fg dark:text-fg-dark"}`}
            />
            <Text className="text-lg text-muted-fg dark:text-muted-fg-dark">{currency}</Text>
          </View>
          <View className="gap-1.5">
            <Label>Hol / mire</Label>
            <TextInput value={merchant} onChangeText={setMerchant} placeholder="pl. Lidl" placeholderTextColor={t.muted} className={input} />
          </View>
          <View className="gap-2">
            <Label>Kategória</Label>
            <View className="flex-row flex-wrap">
              {cats.map((c) => (
                <Pressable
                  key={c.id}
                  onPress={() => setCategoryId(c.id === categoryId ? null : c.id)}
                  className={`w-1/4 items-center gap-1 rounded-xl p-2 ${c.id === categoryId ? "bg-accent dark:bg-accent-dark" : ""}`}
                >
                  <CategoryBadge category={c} size={30} />
                  <Text numberOfLines={1} className="text-[11px] text-fg dark:text-fg-dark">{c.name}</Text>
                </Pressable>
              ))}
            </View>
          </View>
          <View className="gap-1.5">
            <Label>Időpont (ÉÉÉÉ-HH-NN óó:pp)</Label>
            <TextInput value={date} onChangeText={setDate} className={input} />
            {!dateValid ? <Text className="text-xs text-danger dark:text-danger-dark">Adj meg egy érvényes időpontot.</Text> : null}
          </View>
          {draft.items?.length ? (
            <View className="gap-1.5">
              <Label>Tételek a blokkról</Label>
              {draft.items.map((it, i) => (
                <View key={i} className="flex-row justify-between">
                  <Text numberOfLines={1} className="flex-1 text-sm text-fg dark:text-fg-dark">{it.quantity > 1 ? `${it.quantity}× ` : ""}{it.name}</Text>
                  <Text className="text-sm text-muted-fg dark:text-muted-fg-dark">{money(it.total, currency)}</Text>
                </View>
              ))}
            </View>
          ) : null}
          <View className="gap-1.5">
            <Label>Megjegyzés</Label>
            <TextInput value={note} onChangeText={setNote} placeholder="Opcionális" placeholderTextColor={t.muted} multiline className={`${input} h-20 py-2`} />
          </View>
          <View className="flex-row gap-2">
            {existing ? <Button title="Törlés" variant="outline" onPress={confirmDelete} /> : null}
            <Button title={existing ? "Mentés" : "Rögzítés"} onPress={submit} loading={busy} disabled={!valid} className="flex-1" />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
