import { useState } from "react";
import { endOfMonth, startOfMonth, subMonths } from "date-fns";
import { Sparkles, TrendingUp, Info, AlertTriangle, CheckCircle2 } from "lucide-react";
import type { AnalyzeResponse } from "@et/shared";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Segmented } from "@/components/ui/segmented";
import { useApp } from "@/store/app";
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

export function InsightsPage() {
  const backend = useApp((s) => s.backend);
  const [r, setR] = useState<Range>("this");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AnalyzeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(q = question) {
    if (!backend) return;
    setBusy(true);
    setError(null);
    try {
      const { from, to } = range(r);
      setRes(await backend.analyze({ from: from.toISOString(), to: to.toISOString(), question: q.trim() || undefined }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">AI elemzés</h1>
        <p className="text-sm text-muted-foreground">Összesített adatokból dolgozik, nem a nyers tételeidből. Bármelyik AI szolgáltatóval működik.</p>
      </div>

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
          <Button onClick={() => run()} disabled={busy} className="self-start">
            <Sparkles /> {busy ? "Elemzés…" : "Elemzés indítása"}
          </Button>
        </CardContent>
      </Card>

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
    </div>
  );
}
