import { useEffect, useRef, useState } from "react";
import { Camera, ImageUp, RotateCcw, Check, AlertCircle } from "lucide-react";
import type { ReceiptScanResult } from "@et/shared";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CategoryBadgeIcon } from "@/components/category-dot";
import { ReceiptItems } from "@/components/receipt-items";
import { useApp, useCategoryMap } from "@/store/app";
import { useUi } from "@/store/ui";
import { money, shortDate } from "@/lib/format";
import { shrinkImage } from "@/lib/image";
import { cn } from "@/lib/utils";

type Phase = "idle" | "scanning" | "done" | "error";

export function ScanPage() {
  const backend = useApp((s) => s.backend);
  const cats = useCategoryMap();
  const openTx = useUi((s) => s.openTx);
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [preview, setPreview] = useState<string | null>(null);
  const [result, setResult] = useState<ReceiptScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const reqId = useRef(0);

  // Release the preview blob URL whenever it is replaced, cleared, or the page unmounts.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  async function handle(file: File | undefined) {
    if (!file || !backend) return;
    // A newer file (or Újra) supersedes this scan, so its result never lands under another receipt's photo.
    const id = ++reqId.current;
    setError(null);
    setResult(null);
    setPreview(file.type.startsWith("image/") ? URL.createObjectURL(file) : null);
    setPhase("scanning");
    try {
      const small = await shrinkImage(file);
      const r = await backend.scanReceipt(small);
      if (id !== reqId.current) return;
      setResult(r);
      setPhase("done");
    } catch (e) {
      if (id !== reqId.current) return;
      setError((e as Error).message);
      setPhase("error");
    }
  }

  function reset() {
    reqId.current++;
    setPreview(null);
    setResult(null);
    setError(null);
    setPhase("idle");
  }

  function save() {
    if (!result) return;
    openTx({
      amount: result.total ? -Math.abs(result.total) : undefined,
      currency: result.currency ?? "HUF",
      merchant: result.merchant ?? "",
      date: result.date ?? new Date().toISOString(),
      categoryId: result.suggestedCategoryId,
      items: result.items,
      source: "receipt",
    });
  }

  const suggested = result?.suggestedCategoryId ? cats.get(result.suggestedCategoryId) : undefined;
  const itemsSum = result?.items.reduce((s, i) => s + i.total, 0) ?? 0;
  const mismatch = result?.total != null && result.items.length > 0 && Math.abs(itemsSum - result.total) > 1;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Blokk beolvasása</h1>
        <p className="text-sm text-muted-foreground">Fotózd le a blokkot vagy számlát, az AI kiolvassa a tételeket és az összeget.</p>
      </div>

      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => handle(e.target.files?.[0])} />
      <input ref={fileRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => handle(e.target.files?.[0])} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); handle(e.dataTransfer.files?.[0]); }}
          className={cn(
            "relative flex min-h-64 flex-col items-center justify-center overflow-hidden border-dashed transition-[background-color,border-color] duration-300",
            dragging && "border-ring bg-accent/50",
          )}
        >
          {preview ? (
            <>
              <img src={preview} alt="Blokk előnézet" className="max-h-72 w-full lg:max-h-[28rem] animate-fade-in object-contain p-3" />
              {phase === "scanning" && (
                <div className="absolute inset-0 animate-fade-in bg-background/40">
                  <div className="absolute inset-x-6 h-16 animate-[scan_2.4s_ease-in-out_infinite] rounded-full bg-gradient-to-b from-transparent via-primary/15 to-transparent" />
                </div>
              )}
            </>
          ) : phase === "scanning" ? (
            <p className="text-sm text-muted-foreground">Feldolgozás…</p>
          ) : (
            <div className="flex flex-col items-center gap-4 p-8 text-center">
              <div className="flex size-14 items-center justify-center rounded-2xl bg-accent text-accent-foreground">
                <Camera className="size-6" />
              </div>
              <div>
                <p className="text-sm font-medium">Húzd ide a képet, vagy válassz</p>
                <p className="text-xs text-muted-foreground">JPG, PNG, WEBP, HEIC vagy PDF, max. 10 MB</p>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={() => cameraRef.current?.click()}><Camera /> Fotó készítése</Button>
                <Button variant="outline" onClick={() => fileRef.current?.click()}><ImageUp /> Feltöltés</Button>
              </div>
            </div>
          )}
        </Card>

        <div className="flex flex-col gap-3">
          {phase === "idle" && (
            <Card className="p-5 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">Tippek a jó felismeréshez</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>Egyenletes fény, árnyék nélkül.</li>
                <li>A teljes blokk legyen a képen, az „ÖSSZESEN” sorral együtt.</li>
                <li>Hosszú blokknál elég, ha a tételek és a végösszeg olvasható.</li>
              </ul>
            </Card>
          )}

          {phase === "scanning" && (
            <Card className="flex flex-col gap-3 p-5">
              {[60, 85, 70, 40].map((w, i) => (
                <div key={i} className="h-3 animate-pulse rounded bg-muted" style={{ width: `${w}%`, animationDelay: `${i * 120}ms` }} />
              ))}
            </Card>
          )}

          {phase === "error" && (
            <Card className="flex animate-rise-in items-start gap-3 border-destructive/30 p-5">
              <AlertCircle className="mt-0.5 size-5 shrink-0 text-destructive" />
              <div className="flex-1">
                <p className="text-sm font-medium">Nem sikerült a felismerés</p>
                <p className="mt-1 text-sm text-muted-foreground">{error}</p>
                <Button variant="outline" size="sm" className="mt-3" onClick={reset}><RotateCcw /> Újra</Button>
              </div>
            </Card>
          )}

          {phase === "done" && result && (
            <Card className="animate-rise-in">
              <CardContent className="flex flex-col gap-4 pt-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <CategoryBadgeIcon category={suggested} size="lg" />
                    <div>
                      <div className="font-medium">{result.merchant ?? "Ismeretlen kereskedő"}</div>
                      <div className="text-xs text-muted-foreground">
                        {result.date ? shortDate(result.date) : "Dátum nem olvasható"} · {suggested?.name ?? "Kategória javaslat nélkül"}
                      </div>
                    </div>
                  </div>
                  <Badge className={cn(result.confidence < 0.7 && "bg-amber-500/10 text-amber-700 dark:text-amber-300")}>
                    {Math.round(result.confidence * 100)}% biztos
                  </Badge>
                </div>

                {result.items.length > 0 && (
                  <ReceiptItems items={result.items} currency={result.currency ?? "HUF"} />
                )}

                <div className="flex items-baseline justify-between">
                  <span className="text-sm text-muted-foreground">Összesen</span>
                  <span className="text-2xl font-semibold tabular-nums">
                    {result.total != null ? money(result.total, result.currency ?? "HUF") : "nem olvasható"}
                  </span>
                </div>
                {mismatch && (
                  <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                    A tételek összege ({money(itemsSum, result.currency ?? "HUF")}) eltér a végösszegtől. Mentés előtt ellenőrizd.
                  </p>
                )}

                <div className="flex gap-2">
                  <Button variant="outline" onClick={reset}><RotateCcw /> Másik</Button>
                  <Button className="flex-1" onClick={save}><Check /> Ellenőrzés és mentés</Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
