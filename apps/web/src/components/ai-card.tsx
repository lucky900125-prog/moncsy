import { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import { toast } from "sonner";
import type { AIProviderInfo, AIProvidersResponse } from "@et/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useApp } from "@/store/app";
import { getAiChoice, saveAiChoice, type AiChoice } from "@/lib/ai-choice";

/**
 * Picks the AI service and model for the analysis and the receipt scan, from the ones the server has a key for.
 * Keys are set on the server only; a service without one is listed greyed out with the reason.
 */
export function AiCard() {
  const backend = useApp((s) => s.backend);
  const [info, setInfo] = useState<AIProvidersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<AiChoice | null>(getAiChoice);

  useEffect(() => {
    if (backend?.mode !== "api") return;
    backend.aiProviders().then(setInfo, (e) => setError((e as Error).message));
  }, [backend]);

  const offers = (p: AIProviderInfo, model: string) => p.models.includes(model) || (p.customModel && model.trim() !== "");
  const usable = (c: AiChoice | null) => !!c && !!info?.providers.some((p) => p.id === c.provider && p.configured && offers(p, c.model));
  // A saved pick the server can no longer serve (its key was removed, the model dropped) is dropped, so the calls go
  // with the server's default instead of failing; the card says which one it was.
  const [dropped, setDropped] = useState<AiChoice | null>(null);
  useEffect(() => {
    if (!info || !choice || usable(choice)) return;
    setDropped(choice);
    setChoice(null);
    try { saveAiChoice(null); } catch { /* blocked storage: nothing was kept to drop */ }
  }, [info, choice]);
  if (backend?.mode === "demo") return null; // the demo analysis runs in the browser, there is no AI to pick

  const current = info ? (usable(choice) ? choice! : info.default) : null;
  const provider = info?.providers.find((p) => p.id === current?.provider);
  const missing = info?.providers.filter((p) => !p.configured) ?? [];

  function pick(next: AiChoice | null) {
    try {
      saveAiChoice(next);
      setChoice(next);
      setDropped(null);
      const shown = next ?? info!.default;
      const label = info!.providers.find((p) => p.id === shown.provider)?.label ?? shown.provider;
      toast.success(next ? `AI: ${label} · ${shown.model}` : `AI: a szerver alapértéke (${label} · ${shown.model})`);
    } catch (e) {
      toast.error("Nem sikerült menteni", { description: `A böngésző tiltja a helyi tárolást: ${(e as Error).message}` });
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Bot className="size-4" /> AI</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">Ezzel készül az elemzés és a blokkbeolvasás. Csak a szerveren megadott kulcsú szolgáltatók választhatók.</p>
        {error && <p className="text-sm text-destructive">A szolgáltatók nem kérdezhetők le: {error}</p>}
        {!info && !error && <p className="text-sm text-muted-foreground">Betöltés…</p>}
        {info && current && (
          <>
            {dropped && (
              <p className="text-sm text-amber-700 dark:text-amber-300">
                A korábban választott {dropped.provider} · {dropped.model} már nem érhető el a szerveren, ezért visszaállt a szerver alapértékére.
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="ai-provider">Szolgáltató</Label>
                <Select
                  value={current.provider}
                  onValueChange={(id) => {
                    const p = info.providers.find((x) => x.id === id)!;
                    pick({ provider: p.id, model: p.defaultModel });
                  }}
                >
                  <SelectTrigger id="ai-provider"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {info.providers.map((p) => (
                      <SelectItem key={p.id} value={p.id} disabled={!p.configured} className="data-[disabled]:opacity-50">
                        {p.label}{p.configured ? "" : p.keyEnv ? " · nincs kulcs" : " · nem elérhető"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ai-model">Modell</Label>
                {provider?.customModel ? (
                  // Any model the server can run (Ollama): typed, with the listed ones offered.
                  <>
                    <Input
                      id="ai-model"
                      list="ai-models"
                      defaultValue={current.model}
                      key={current.provider}
                      onBlur={(e) => { const m = e.target.value.trim(); if (m && m !== current.model) pick({ provider: current.provider, model: m }); }}
                    />
                    <datalist id="ai-models">{provider.models.map((m) => <option key={m} value={m} />)}</datalist>
                  </>
                ) : (
                  <Select value={current.model} onValueChange={(model) => pick({ provider: current.provider, model })}>
                    <SelectTrigger id="ai-model"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {provider?.models.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </div>
            {missing.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Nem választható: {missing.map((p) => `${p.label} (${p.keyEnv ? `nincs ${p.keyEnv}` : "csak a szerver alapértékeként"})`).join(", ")}.
                A kulcsot a szerver .env fájljába kell írni, itt nem adható meg.
              </p>
            )}
            {choice && (
              <Button variant="ghost" size="sm" className="self-start text-muted-foreground" onClick={() => pick(null)}>
                Vissza a szerver alapértékére
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
