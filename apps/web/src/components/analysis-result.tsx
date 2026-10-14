import { useState } from "react";
import { TrendingUp, Info, AlertTriangle, CheckCircle2 } from "lucide-react";
import type { AnalyzeRequest, AnalyzeResponse } from "@et/shared";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useApp } from "@/store/app";
import { cn } from "@/lib/utils";

const severityStyle = {
  info: { icon: Info, cls: "text-muted-foreground" },
  positive: { icon: CheckCircle2, cls: "text-positive" },
  warning: { icon: AlertTriangle, cls: "text-amber-600 dark:text-amber-300" },
} as const;

export function useAnalysis() {
  const backend = useApp((s) => s.backend);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AnalyzeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run(req: AnalyzeRequest) {
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

export function AnalysisResult({ busy, res, error }: { busy: boolean; res: AnalyzeResponse | null; error: string | null }) {
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

