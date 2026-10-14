import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Download, Upload, RefreshCw, Landmark, FileUp, Server, RotateCcw, Eye, EyeOff, KeyRound, ChevronRight, CloudCheck, CloudOff, CloudAlert, CloudUpload } from "lucide-react";
import { toast } from "sonner";
import type { BackupStatus, RevolutStatus } from "@et/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Segmented } from "@/components/ui/segmented";
import { useApp } from "@/store/app";
import { getTheme, setTheme, type Theme } from "@/lib/theme";
import { resetDemo } from "@/lib/demo";
import { getApiToken, getApiUrlSetting, saveConnection, type ImportResult } from "@/lib/backend";
import { backupHealth } from "@/lib/backup";
import { shortDate } from "@/lib/format";
import { format, formatDistanceToNow } from "date-fns";
import { hu } from "date-fns/locale";
import { cn } from "@/lib/utils";

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
  const [apiUrl, setApiUrl] = useState(getApiUrlSetting);
  const [token, setToken] = useState(getApiToken);
  const [showToken, setShowToken] = useState(false);
  const [revolut, setRevolut] = useState<RevolutStatus | null>(null);
  const [backup, setBackup] = useState<BackupStatus | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [revolutError, setRevolutError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const statementRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    backend?.backupStatus().then(setBackup, (e) => setBackupError((e as Error).message));
  }, [backend]);

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
      a.download = `moncsy-export-${new Date().toISOString().slice(0, 10)}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke later: Firefox and Safari read the blob URL after click() returns.
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
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

      {(backup || backupError) && <BackupCard status={backup} error={backupError} />}

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
          <Link
            to="/beallitasok/kivonat"
            className="flex items-center gap-3 rounded-lg border bg-card p-3 transition-colors duration-200 hover:bg-muted/60"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground"><FileUp className="size-4" /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Bankkivonat importálása</span>
              <span className="block text-xs text-muted-foreground">Bármelyik bank: CSV, Excel, CAMT XML, OFX, MT940, PDF. Oszlopok és előnézet mentés előtt.</span>
            </span>
            <ChevronRight className="size-4 text-muted-foreground" />
          </Link>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => exportAs("xlsx")} disabled={!!busy}><Download /> Export XLSX</Button>
            <Button variant="outline" onClick={() => exportAs("xml")} disabled={!!busy}><Download /> Export XML</Button>
            <Button variant="outline" onClick={() => importRef.current?.click()} disabled={!!busy}><Upload /> Import moncsy exportból</Button>
          </div>
          <p className="text-xs text-muted-foreground">A moncsy saját XLSX/XML exportját tölti vissza. A már meglévő tételeket kihagyja, a hibás sorokat külön jelzi.</p>
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
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              try {
                saveConnection(apiUrl, token);
                location.reload();
              } catch (err) {
                toast.error("Nem sikerült menteni", { description: `A böngésző tiltja a helyi tárolást: ${(err as Error).message}` });
              }
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="api">API cím (üresen: ugyanaz a domain)</Label>
              <Input id="api" value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="https://moncsy.example.com" inputMode="url" autoComplete="url" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="token" className="flex items-center gap-1.5"><KeyRound className="size-3.5" /> API token</Label>
              <div className="relative">
                <Input
                  id="token"
                  type={showToken ? "text" : "password"}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="A szerveren beállított token"
                  autoComplete="off"
                  spellCheck={false}
                  className="pr-10 font-mono"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground"
                  onClick={() => setShowToken((v) => !v)}
                  aria-label={showToken ? "Token elrejtése" : "Token megjelenítése"}
                >
                  {showToken ? <EyeOff /> : <Eye />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">Minden kéréshez csatolva megy (Authorization: Bearer). Csak ebben a böngészőben tárolódik.</p>
              {SHARED_ORIGIN && (
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  A {location.host} címet a fiók összes GitHub Pages oldala megosztja, ezek is olvashatják a tokent. Olyan tokent adj meg, amit le tudsz cserélni. Saját domainnel ez a kockázat megszűnik.
                </p>
              )}
            </div>
            <Button type="submit" variant="secondary" className="self-start">Mentés és újratöltés</Button>
          </form>
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

// Browser storage is per origin, and every Pages site of a GitHub account is served from <account>.github.io.
const SHARED_ORIGIN = location.hostname.endsWith(".github.io");

const backupTone = {
  ok: { icon: CloudCheck, cls: "text-positive" },
  pending: { icon: CloudUpload, cls: "text-muted-foreground" },
  warn: { icon: CloudAlert, cls: "text-amber-600 dark:text-amber-300" },
  error: { icon: CloudAlert, cls: "text-destructive" },
  off: { icon: CloudOff, cls: "text-muted-foreground" },
} as const;

/** Off-site backup state; only shown when the API reports it (never in demo mode). */
function BackupCard({ status, error }: { status: BackupStatus | null; error: string | null }) {
  const h = status ? backupHealth(status) : { tone: "error" as const, title: "A mentés állapota nem kérdezhető le", detail: error ?? undefined };
  const t = backupTone[h.tone];
  const last = status?.enabled ? status.lastBackupAt : null;
  return (
    <Card className="animate-fade-in">
      <CardHeader><CardTitle>Mentés</CardTitle></CardHeader>
      <CardContent className="flex items-start gap-3">
        <t.icon className={cn("mt-0.5 size-5 shrink-0", t.cls)} />
        <div className="min-w-0 text-sm">
          <p className={cn("font-medium", (h.tone === "warn" || h.tone === "error") && t.cls)}>{h.title}</p>
          {last && (
            <p className="text-muted-foreground">
              Utolsó sikeres mentés: {formatDistanceToNow(new Date(last), { locale: hu, addSuffix: true })}
              <span className="text-xs"> ({format(new Date(last), "yyyy. MM. dd. HH:mm")})</span>
            </p>
          )}
          {h.detail && <p className="mt-1 break-words text-muted-foreground">{h.detail}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
