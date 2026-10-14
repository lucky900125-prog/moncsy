import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { endOfMonth, startOfMonth, subMonths } from "date-fns";
import { Sparkles } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { AnalysisResult, useAnalysis } from "@/components/analysis-result";
import { DetailsTab } from "./product-details";

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
  const [question, setQuestion] = useState("");
  const a = useAnalysis();

  function run(q = question) {
    const { from, to } = range(r);
    void a.run({ from: from.toISOString(), to: to.toISOString(), question: q.trim() || undefined });
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
          <Button onClick={() => run()} disabled={a.busy} className="self-start">
            <Sparkles /> {a.busy ? "Elemzés…" : "Elemzés indítása"}
          </Button>
        </CardContent>
      </Card>
      <AnalysisResult busy={a.busy} res={a.res} error={a.error} />
    </>
  );
}
