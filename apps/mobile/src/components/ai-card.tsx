import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import type { AIProviderInfo, AIProvidersResponse } from "@et/shared";
import { Button, Card, Label, useTheme } from "@/components/ui";
import { api, getAiChoice, setAiChoice, type AiChoice } from "@/lib/api";

/**
 * Picks the AI service and model for the analysis and the receipt scan, from the ones the server has a key for.
 * Keys are set on the server only; a service without one is listed greyed out with the reason. `reload` changes when
 * the connection is saved again, so the list is asked for anew.
 */
export function AiCard({ reload }: { reload: number }) {
  const t = useTheme();
  const [info, setInfo] = useState<AIProvidersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<AiChoice | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setInfo(null);
    setError(null);
    getAiChoice().then(setChoice);
    api.aiProviders().then(setInfo, (e) => setError((e as Error).message));
  }, [reload]);

  const offers = (p: AIProviderInfo, model: string) => p.models.includes(model) || (p.customModel && model.trim() !== "");
  const usable = (c: AiChoice | null) => !!c && !!info?.providers.some((p) => p.id === c.provider && p.configured && offers(p, c.model));
  // A saved pick the server can no longer serve (its key was removed, the model dropped) is dropped, so the calls go
  // with the server's default instead of failing; the card says which one it was.
  const [dropped, setDropped] = useState<AiChoice | null>(null);
  useEffect(() => {
    if (!info || !choice || usable(choice)) return;
    setDropped(choice);
    setChoice(null);
    try { void setAiChoice(null); } catch { /* blocked storage: nothing was kept to drop */ }
  }, [info, choice]);
  const current = info ? (usable(choice) ? choice! : info.default) : null;
  const provider = info?.providers.find((p) => p.id === current?.provider);

  async function pick(next: AiChoice | null) {
    try {
      await setAiChoice(next);
      setChoice(next);
      setDropped(null);
      setSaveError(null);
    } catch (e) {
      setSaveError(`Nem sikerült menteni: ${(e as Error).message}`);
    }
  }

  const chip = (active: boolean, disabled = false) =>
    `rounded-lg border px-3 py-2 ${active ? "border-fg bg-card dark:border-fg-dark dark:bg-card-dark" : "border-line dark:border-line-dark"} ${disabled ? "opacity-40" : ""}`;

  return (
    <Card className="gap-3">
      <Label>AI</Label>
      <Text className="text-sm text-muted-fg dark:text-muted-fg-dark">
        Ezzel készül az elemzés és a blokkbeolvasás. Csak a szerveren megadott kulcsú szolgáltatók választhatók.
      </Text>
      {error ? <Text className="text-sm text-danger dark:text-danger-dark">A szolgáltatók nem kérdezhetők le: {error}</Text> : null}
      {!info && !error ? <Text className="text-sm text-muted-fg dark:text-muted-fg-dark">Betöltés…</Text> : null}
      {info && current ? (
        <>
          {dropped ? (
            <Text className="text-sm text-amber-600 dark:text-amber-300">
              A korábban választott {dropped.provider} · {dropped.model} már nem érhető el a szerveren, ezért visszaállt a szerver alapértékére.
            </Text>
          ) : null}
          <Text className="text-xs font-medium text-muted-fg dark:text-muted-fg-dark">Szolgáltató</Text>
          <View className="gap-2">
            {info.providers.map((p) => (
              <Pressable
                key={p.id}
                disabled={!p.configured}
                onPress={() => pick({ provider: p.id, model: p.defaultModel })}
                className={chip(p.id === current.provider, !p.configured)}
              >
                <Text className="text-sm text-fg dark:text-fg-dark">{p.label}</Text>
                {!p.configured ? (
                  <Text className="text-xs text-muted-fg dark:text-muted-fg-dark">
                    {p.keyEnv ? `Nincs kulcs: a szerver .env fájljába kell a ${p.keyEnv}` : "Csak a szerver alapértékeként érhető el"}
                  </Text>
                ) : null}
              </Pressable>
            ))}
          </View>
          <Text className="text-xs font-medium text-muted-fg dark:text-muted-fg-dark">Modell</Text>
          {provider?.customModel ? (
            <TextInput
              key={current.provider}
              defaultValue={current.model}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={provider.defaultModel}
              placeholderTextColor={t.muted}
              onEndEditing={(e) => { const m = e.nativeEvent.text.trim(); if (m && m !== current.model) void pick({ provider: current.provider, model: m }); }}
              className="h-11 rounded-xl border border-line bg-bg px-3 text-fg dark:border-line-dark dark:bg-bg-dark dark:text-fg-dark"
            />
          ) : (
            <View className="flex-row flex-wrap gap-2">
              {provider?.models.map((m) => (
                <Pressable key={m} onPress={() => pick({ provider: current.provider, model: m })} className={chip(m === current.model)}>
                  <Text className="text-sm text-fg dark:text-fg-dark">{m}</Text>
                </Pressable>
              ))}
            </View>
          )}
          {saveError ? <Text className="text-sm text-danger dark:text-danger-dark">{saveError}</Text> : null}
          {choice ? <Button title="Vissza a szerver alapértékére" variant="outline" onPress={() => pick(null)} /> : null}
        </>
      ) : null}
    </Card>
  );
}
