import { useEffect, useRef, useState } from "react";
import { Download, Upload, RefreshCw, Landmark, FileUp, Server, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import type { RevolutStatus } from "@et/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Segmented } from "@/components/ui/segmented";
import { useApp } from "@/store/app";
import { getTheme, setTheme, type Theme } from "@/lib/theme";
import { resetDemo } from "@/lib/demo";
import type { ImportResult } from "@/lib/backend";
import { shortDate } from "@/lib/format";

function reportImport(r: ImportResult) {
  toast.success(`${r.imported} tétel importálva`, {
    description: [r.skipped ? `${r.skipped} duplikátum kihagyva` : null, r.errors?.length ? `${r.errors.length} hibás sor` : null]
      .filter(Boolean)
      .join(" · ") || undefined,
  });
}

export function SettingsPage() {
  const { backend, refresh } = useApp();
  const [theme, setThemeState] = useState<Theme>(getTheme);
  const [apiUrl, setApiUrl] = useState(() => {
    try { return localStorage.getItem("kassza-api") ?? ""; } catch { return ""; }
  });
  const [revolut, setRevolut] = useState<RevolutStatus | null>(null);
  const [revolutError, setRevolutError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const statementRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    backend?.revolutStatus().then(setRevolut, (e) => setRevolutError((e as Error).message));
  }, [backend]);

  async function task(name: string, fn: () => Promise<void>) {
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      toast.error("Nem sikerült", { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const exportAs = (format: "xlsx" | "xml") =>
    task(`export-${format}`, async () => {
      const blob = await backend!.exportFile(format);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `kassza-export-${new Date().toISOString().slice(0, 10)}.${format}`;
      a.click();
      URL.revokeObjectURL(a.href);
    });

  const importFile = (file?: File) =>
    file && task("import", async () => { reportImport(await backend!.importFile(file)); await refresh(); });

  const importStatement = (file?: File) =>
    file && task("statement", async () => { reportImport(await backend!.revolutImportStatement(file)); await refresh(); });

  const sync = () => task("sync", async () => { reportImport(await backend!.revolutSync()); await refresh(); setRevolut(await backend!.revolutStatus()); });

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Beállítások</h1>
        <p className="text-sm text-muted-foreground">Megjelenés, bankkapcsolat, import és export.</p>
      </div>

      <Card>
        <CardHeader><CardTitle>Megjelenés</CardTitle></CardHeader>
        <CardContent>
          <Segmented
            value={theme}
            onChange={(t) => { setThemeState(t); setTheme(t); }}
            className="max-w-xs"
            options={[
              { value: "light", label: "Világos" },
              { value: "dark", label: "Sötét" },
              { value: "system", label: "Rendszer" },
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2"><Landmark className="size-4" /> Revolut</CardTitle>
          {revolut && <Badge className={revolut.connected ? "bg-accent text-accent-foreground" : ""}>{revolut.connected ? `Kapcsolódva · ${revolut.mode}` : "Nincs kapcsolat"}</Badge>}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {revolutError && <p className="text-sm text-destructive">Állapot nem lekérdezhető: {revolutError}</p>}
          {revolut?.accounts.map((a) => (
            <div key={a.id} className="flex justify-between text-sm">
              <span>{a.name}</span>
              <span className="tabular-nums text-muted-foreground">{a.balance.toLocaleString("hu-HU")} {a.currency}</span>
            </div>
          ))}
          <p className="text-sm text-muted-foreground">
            Személyes Revolut fiókhoz nincs magánszemélynek nyitott API. Két út van: a Revolut appból exportált kivonat (CSV/XLSX) importálása, vagy Business fióknál API token a szerveren (<code className="text-xs">REVOLUT_BUSINESS_TOKEN</code>).
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => statementRef.current?.click()} disabled={!!busy}>
              <FileUp /> Kivonat importálása
            </Button>
            <Button variant="outline" onClick={sync} disabled={!!busy || !revolut?.connected}>
              <RefreshCw className={busy === "sync" ? "animate-spin" : ""} /> Szinkronizálás
            </Button>
          </div>
          {revolut?.lastSyncAt && <p className="text-xs text-muted-foreground">Utolsó szinkron: {shortDate(revolut.lastSyncAt)}</p>}
          <input ref={statementRef} type="file" accept=".csv,.xlsx" className="hidden" onChange={(e) => { importStatement(e.target.files?.[0]); e.target.value = ""; }} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Import és export</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => exportAs("xlsx")} disabled={!!busy}><Download /> Export XLSX</Button>
            <Button variant="outline" onClick={() => exportAs("xml")} disabled={!!busy}><Download /> Export XML</Button>
            <Button variant="outline" onClick={() => importRef.current?.click()} disabled={!!busy}><Upload /> Import (XLSX / XML)</Button>
          </div>
          <p className="text-xs text-muted-foreground">Az import a már meglévő tételeket kihagyja, a hibás sorokat külön jelzi.</p>
          <input ref={importRef} type="file" accept=".xlsx,.xml" className="hidden" onChange={(e) => { importFile(e.target.files?.[0]); e.target.value = ""; }} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2"><Server className="size-4" /> Kapcsolat</CardTitle>
          <Badge className={backend?.mode === "api" ? "bg-accent text-accent-foreground" : "bg-amber-500/10 text-amber-700 dark:text-amber-300"}>
            {backend?.mode === "api" ? "API csatlakoztatva" : "Demó mód"}
          </Badge>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {backend?.mode === "demo" && (
            <p className="text-sm text-muted-foreground">Az API nem válaszolt, ezért a böngészőben tárolt demó adatokkal fut. Az import, export és a Revolut az API-t igényli.</p>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="api">API cím (üresen: ugyanaz a domain)</Label>
            <div className="flex gap-2">
              <Input id="api" value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="https://kassza.example.com" />
              <Button
                variant="secondary"
                onClick={() => {
                  try { localStorage.setItem("kassza-api", apiUrl.trim()); } catch { /* blocked storage */ }
                  location.reload();
                }}
              >
                Mentés
              </Button>
            </div>
          </div>
          {backend?.mode === "demo" && (
            <Button variant="ghost" size="sm" className="self-start text-muted-foreground" onClick={() => { resetDemo(); refresh(); toast("Demó adatok visszaállítva"); }}>
              <RotateCcw /> Demó adatok visszaállítása
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
