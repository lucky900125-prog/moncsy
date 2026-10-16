import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { endOfDay, endOfMonth, format, isValid, parse, startOfDay, startOfMonth, subMonths } from "date-fns";
import { Sparkles } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { AnalysisResult, useAnalysis } from "@/components/analysis-result";
import { DetailsTab } from "./product-details";

type Range = "this" | "last" | "quarter" | "custom";

// Whole calendar months, like the dashboard: a transaction later today (or dated later this month) is in "this month".
function range(r: Exclude<Range, "custom">) {
  const now = new Date();
  if (r === "this") return { from: startOfMonth(now), to: endOfMonth(now) };
  if (r === "last") { const p = subMonths(now, 1); return { from: startOfMonth(p), to: endOfMonth(p) }; }
  return { from: startOfMonth(subMonths(now, 2)), to: endOfMonth(now) };
}

const day = (s: string) => parse(s, "yyyy-MM-dd", new Date());

/** The user's own period, whole days from the first to the last; an error message when it cannot be used. */
function customRange(from: string, to: string) {
  const f = day(from), t = day(to);
  if (!isValid(f) || !isValid(t)) return { error: "Add meg mindkét dátumot." };
  if (f > t) return { error: "A kezdő dátum nem lehet a záró után." };
  return { from: startOfDay(f), to: endOfDay(t) };
}

const PRESETS = [
  "Hol tudnék a legkönnyebben spórolni?",
  "Mely előfizetéseim drágultak vagy feleslegesek?",
  "Hogyan alakult az élelmiszer-költésem?",
];

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

function AiTab() {
  const [r, setR] = useState<Range>("this");
  // The custom period starts as the last twelve months, the stretch the presets do not reach.
  const [customFrom, setCustomFrom] = useState(() => format(startOfMonth(subMonths(new Date(), 11)), "yyyy-MM-dd"));
  const [customTo, setCustomTo] = useState(() => format(new Date(), "yyyy-MM-dd"));
  const [question, setQuestion] = useState("");
  const a = useAnalysis();
  const period = r === "custom" ? customRange(customFrom, customTo) : range(r);

  function run(q = question) {
    if ("error" in period) return;
    void a.run({ from: period.from.toISOString(), to: period.to.toISOString(), question: q.trim() || undefined });
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
              { value: "custom", label: "Egyéni" },
            ]}
          />
          {r === "custom" && (
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-2 text-sm sm:max-w-sm">
                <label className="flex flex-col gap-1 text-muted-foreground">
                  Mettől
                  <Input id="period-from" type="date" value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)} />
                </label>
                <label className="flex flex-col gap-1 text-muted-foreground">
                  Meddig
                  <Input id="period-to" type="date" value={customTo} min={customFrom} onChange={(e) => setCustomTo(e.target.value)} />
                </label>
              </div>
              {"error" in period && <p className="text-sm text-destructive">{period.error}</p>}
            </div>
          )}
          <Textarea value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Kérdezz valamit a költéseidről (opcionális)" rows={2} />
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => { setQuestion(p); run(p); }}
                disabled={"error" in period}
                className="rounded-full border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors duration-200 hover:text-foreground disabled:opacity-50"
              >
                {p}
              </button>
            ))}
          </div>
          <Button onClick={() => run()} disabled={a.busy || "error" in period} className="self-start">
            <Sparkles /> {a.busy ? "Elemzés…" : "Elemzés indítása"}
          </Button>
        </CardContent>
      </Card>
      <AnalysisResult busy={a.busy} res={a.res} error={a.error} />
    </>
  );
}
