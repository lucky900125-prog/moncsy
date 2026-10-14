import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, ArrowLeft, Check, ChevronDown, FileUp, RotateCcw, Upload } from "lucide-react";
import { toast } from "sonner";
import type { StatementMapping, StatementPreview, StatementRole } from "@et/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CategoryBadgeIcon } from "@/components/category-dot";
import { useApp, useCategoryMap } from "@/store/app";
import type { ImportResult } from "@/lib/backend";
import { money, shortDate } from "@/lib/format";
import { cn } from "@/lib/utils";

const FORMAT_LABEL: Record<StatementPreview["format"], string> = {
  csv: "CSV", xlsx: "Excel", camt: "ISO 20022 XML (CAMT)", ofx: "OFX", mt940: "MT940", pdf: "PDF (AI-val olvasva)", revolut: "Revolut kivonat",
};

const MAIN_ROLES: { role: StatementRole; label: string; hint?: string }[] = [
  { role: "date", label: "Dátum" },
  { role: "amount", label: "Összeg", hint: "előjeles; ha nincs, terhelés + jóváírás" },
  { role: "debit", label: "Terhelés" },
  { role: "credit", label: "Jóváírás" },
  { role: "counterparty", label: "Partner / kereskedő" },
  { role: "description", label: "Közlemény" },
  { role: "currency", label: "Pénznem" },
  { role: "direction", label: "Irány (T/J)" },
];
const MORE_ROLES: { role: StatementRole; label: string }[] = [
  { role: "valueDate", label: "Értéknap" },
  { role: "type", label: "Típus" },
  { role: "reference", label: "Azonosító" },
  { role: "balance", label: "Egyenleg" },
];

const NONE = "__none";
const PREVIEW_ROWS = 60;

/*
 * The user's own mapping for a bank's column layout, so the next statement from the same bank maps itself.
 * For a file without a header row the "columns" are its first transaction (date, amount, partner, IBAN), so nothing
 * readable is stored: the key is a SHA-256 of the columns and the value holds column positions, not names.
 * crypto.subtle needs https or localhost; elsewhere the mapping is not remembered.
 */
const MAPPING_PREFIX = "moncsy-stmt-mapping:";
/** role -> column position; -1 means the role has no column */
type StoredMapping = Partial<Record<StatementRole, number>>;

async function mappingKey(columns: string[]) {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(columns)));
  return MAPPING_PREFIX + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function loadMapping(columns: string[]): Promise<StatementMapping | null> {
  try {
    const key = await mappingKey(columns);
    const raw = key && localStorage.getItem(key);
    if (!raw) return null;
    const m: StatementMapping = {};
    for (const [role, i] of Object.entries(JSON.parse(raw) as StoredMapping) as [StatementRole, number][]) {
      if (i === -1) m[role] = "";
      else if (Number.isInteger(i) && columns[i] !== undefined) m[role] = columns[i];
    }
    return m;
  } catch {
    return null; // blocked storage or a corrupted entry: fall back to the server's detection
  }
}

async function storeMapping(columns: string[], m: StatementMapping) {
  const stored: StoredMapping = {};
  for (const [role, col] of Object.entries(m) as [StatementRole, string | undefined][]) {
    if (col === "") stored[role] = -1;
    else if (col !== undefined && columns.includes(col)) stored[role] = columns.indexOf(col);
  }
  try {
    const key = await mappingKey(columns);
    if (key) localStorage.setItem(key, JSON.stringify(stored));
  } catch { /* blocked storage: the mapping just is not remembered */ }
}

/** Entries saved before the key was hashed name the columns, which for a file without a header are statement data. */
function dropReadableMappings() {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(MAPPING_PREFIX) && !/^[0-9a-f]{64}$/.test(k.slice(MAPPING_PREFIX.length))) localStorage.removeItem(k);
    }
  } catch { /* blocked storage: nothing was stored either */ }
}

type Phase = "idle" | "reading" | "preview" | "importing" | "done";

export function StatementImportPage() {
  const { backend, refresh } = useApp();
  const cats = useCategoryMap();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [currency, setCurrency] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [preview, setPreview] = useState<StatementPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [moreRoles, setMoreRoles] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const reqId = useRef(0);
  const ccy = currency.trim().toUpperCase();
  // The server only takes a 3-letter code here; anything else is refused before the file is sent.
  const ccyInvalid = ccy !== "" && !/^[A-Z]{3}$/.test(ccy);

  async function read(f: File, mapping?: StatementMapping, opts: { remembered?: boolean } = {}) {
    if (!backend) return;
    const id = ++reqId.current;
    setError(null);
    setPhase("reading");
    try {
      const p = await backend.parseStatement(f, { mapping, currency: ccy || undefined });
      if (id !== reqId.current) return; // a newer read (e.g. another mapping change) superseded this one
      // First read of a known layout: apply the mapping the user chose last time for it.
      if (!mapping && !opts.remembered && p.columns.length) {
        const saved = await loadMapping(p.columns);
        if (id !== reqId.current) return;
        if (saved && JSON.stringify(saved) !== JSON.stringify(p.mapping)) return read(f, saved, { remembered: true });
      }
      setPreview(p);
      setExcluded(new Set());
      setPhase("preview");
    } catch (e) {
      if (id !== reqId.current) return;
      setError((e as Error).message);
      setPhase(preview ? "preview" : "idle");
    }
  }

  function choose(f: File | undefined) {
    if (!f || ccyInvalid) return;
    setFile(f);
    setPreview(null);
    setResult(null);
    setShowAll(false);
    void read(f);
  }

  function remap(role: StatementRole, col: string) {
    if (!preview || !file) return;
    // "" tells the server this role has no column, so auto-detection does not fill it back in.
    const next: StatementMapping = { ...preview.mapping, [role]: col === NONE ? "" : col };
    void read(file, next, { remembered: true });
  }

  function reset() {
    reqId.current++;
    setFile(null);
    setPreview(null);
    setResult(null);
    setError(null);
    setPhase("idle");
  }

  const rows = preview?.transactions ?? [];
  const selected = useMemo(() => rows.filter((t) => !excluded.has(t.externalId)), [rows, excluded]);
  const sums = useMemo(() => {
    const m = new Map<string, { out: number; in: number }>();
    for (const t of selected) {
      const v = m.get(t.currency) ?? { out: 0, in: 0 };
      if (t.amount < 0) v.out -= t.amount;
      else v.in += t.amount;
      m.set(t.currency, v);
    }
    return [...m.entries()];
  }, [selected]);

  async function doImport() {
    if (!backend || !preview || selected.length === 0) return;
    setPhase("importing");
    try {
      const r = await backend.importStatement(selected);
      // Remembered only once a statement was imported with it, so a wrong try is not applied to the next file.
      if (preview.columns.length) void storeMapping(preview.columns, preview.mapping);
      setResult(r);
      setPhase("done");
      const description = r.skipped ? `${r.skipped} már megvolt, kihagyva` : undefined;
      if (r.imported > 0) toast.success(`${r.imported} tétel importálva`, { description });
      else if (r.errors?.length) toast.warning("Egy tétel sem került be", { description });
      else toast("Nem volt új tétel", { description });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      setPhase("preview");
    }
  }

  // Leaving with a parsed but unimported statement is fine; nothing was saved. Cancel late responses though.
  useEffect(() => () => { reqId.current++; }, []);
  useEffect(dropReadableMappings, []);

  const toggle = (id: string) =>
    setExcluded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allOn = excluded.size === 0;
  const tabular = preview && preview.columns.length > 0;
  const busy = phase === "reading" || phase === "importing";
  const mappingShown = mapOpen || rows.length === 0;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-1 text-muted-foreground">
          <Link to="/beallitasok"><ArrowLeft /> Beállítások</Link>
        </Button>
        <h1 className="text-xl font-semibold tracking-tight">Bankkivonat importálása</h1>
        <p className="text-sm text-muted-foreground">
          Bármelyik bank kivonata: CSV, Excel (XLSX), ISO 20022 XML (CAMT), OFX, MT940 vagy PDF. Mentés előtt mindent megnézhetsz.
        </p>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".csv,.txt,.xlsx,.xml,.ofx,.qfx,.sta,.mt940,.940,.pdf"
        className="hidden"
        onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ""; }}
      />

      {phase === "done" && result ? (
        <Card className="flex animate-rise-in flex-col items-start gap-3 p-6">
          {result.imported > 0 ? (
            <div className="flex size-11 items-center justify-center rounded-2xl bg-accent text-accent-foreground"><Check className="size-5" /></div>
          ) : (
            <div className="flex size-11 items-center justify-center rounded-2xl bg-muted text-muted-foreground"><AlertCircle className="size-5" /></div>
          )}
          <div>
            <p className="font-medium">{result.imported > 0 ? `${result.imported} tétel importálva` : result.errors?.length ? "Egy tétel sem került be" : "Nem volt új tétel"}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {result.skipped ? `${result.skipped} már szerepelt korábbról, ezeket kihagytam. ` : ""}
              {result.errors?.length ? `${result.errors.length} sort a szerver elutasított.` : ""}
            </p>
          </div>
          {result.errors?.length ? <ErrorList errors={result.errors} /> : null}
          <div className="flex flex-wrap gap-2">
            <Button asChild><Link to="/tetelek">Tételek megnyitása</Link></Button>
            <Button variant="outline" onClick={reset}><FileUp /> Másik kivonat</Button>
          </div>
        </Card>
      ) : !file ? (
        <Card
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); choose(e.dataTransfer.files?.[0]); }}
          className={cn("flex min-h-56 flex-col items-center justify-center gap-4 border-dashed p-8 text-center transition-[background-color,border-color] duration-300", dragging && "border-ring bg-accent/50")}
        >
          <div className="flex size-14 items-center justify-center rounded-2xl bg-accent text-accent-foreground"><FileUp className="size-6" /></div>
          <div>
            <p className="text-sm font-medium">Húzd ide a kivonatot, vagy válaszd ki</p>
            <p className="text-xs text-muted-foreground">Max. 10 MB. A régi .xls fájlt előbb mentsd el .xlsx vagy .csv formában.</p>
          </div>
          <Button onClick={() => fileRef.current?.click()} disabled={!backend || ccyInvalid}><Upload /> Fájl kiválasztása</Button>
          <div className="grid w-full max-w-56 gap-1.5 text-left">
            <Label htmlFor="ccy" className="text-xs text-muted-foreground">Pénznem, ha a fájlban nincs (opcionális)</Label>
            <Input id="ccy" value={currency} onChange={(e) => setCurrency(e.target.value)} placeholder="HUF" maxLength={3} aria-invalid={ccyInvalid} aria-describedby={ccyInvalid ? "ccy-error" : undefined} className="h-9 uppercase" />
            {ccyInvalid && <p id="ccy-error" className="text-xs text-destructive">3 betűs pénznemkód kell, például HUF vagy EUR.</p>}
          </div>
        </Card>
      ) : (
        <>
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-5">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{file.name}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  {preview ? (
                    <>
                      <Badge>{FORMAT_LABEL[preview.format]}</Badge>
                      <span>{rows.length} tranzakció</span>
                      {preview.ignored > 0 && <span>· {preview.ignored} nem tranzakció sor kihagyva</span>}
                    </>
                  ) : (
                    <span>Beolvasás…</span>
                  )}
                </div>
                {preview && backend?.mode === "demo" && (
                  <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Demó mód: ez egy beépített minta kivonat, nem a feltöltött fájl tartalma.</p>
                )}
              </div>
              <Button variant="outline" size="sm" onClick={reset} disabled={phase === "importing"}><RotateCcw /> Másik fájl</Button>
            </CardContent>
          </Card>

          {error && (
            <Card className="flex animate-rise-in items-start gap-3 border-destructive/30 p-5 text-sm">
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div>
                <p className="font-medium">Nem sikerült</p>
                <p className="mt-1 text-muted-foreground">{error}</p>
              </div>
            </Card>
          )}

          {!preview && phase === "reading" && (
            <Card className="flex flex-col gap-3 p-5">
              {[70, 90, 60, 80].map((w, i) => <div key={i} className="h-3 animate-pulse rounded bg-muted" style={{ width: `${w}%`, animationDelay: `${i * 120}ms` }} />)}
            </Card>
          )}

          {preview && (
            <div className={cn("grid gap-4 transition-opacity duration-300 lg:grid-cols-[18rem_1fr]", phase === "reading" && "opacity-60")}>
              {tabular ? (
                <Card className="self-start">
                  <CardHeader>
                    {/* On phones the mapping folds away once it works, so the preview is not pushed below the fold. */}
                    <button onClick={() => setMapOpen((v) => !v)} className="flex items-center justify-between text-left lg:pointer-events-none" aria-expanded={mappingShown}>
                      <CardTitle>Oszlopok</CardTitle>
                      <ChevronDown className={cn("size-4 text-muted-foreground transition-transform duration-300 lg:hidden", mappingShown && "rotate-180")} />
                    </button>
                    <p className="text-xs text-muted-foreground">Felismertem, de átállíthatod. A választást erre a bankformátumra megjegyzem.</p>
                  </CardHeader>
                  <div className={cn("grid transition-[grid-template-rows,opacity] duration-300 ease-[var(--ease-calm)] lg:grid-rows-[1fr] lg:opacity-100", mappingShown ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
                  <div className="min-h-0 overflow-hidden">
                  <CardContent className="flex flex-col gap-3">
                    {MAIN_ROLES.map((r) => (
                      <RolePicker key={r.role} label={r.label} hint={r.hint} value={preview.mapping[r.role]} columns={preview.columns} onChange={(c) => remap(r.role, c)} disabled={busy} />
                    ))}
                    <button
                      onClick={() => setMoreRoles((v) => !v)}
                      className="flex items-center gap-1 self-start text-xs text-muted-foreground transition-colors duration-200 hover:text-foreground"
                      aria-expanded={moreRoles}
                    >
                      <ChevronDown className={cn("size-3.5 transition-transform duration-300", moreRoles && "rotate-180")} /> További oszlopok
                    </button>
                    <div className={cn("grid transition-[grid-template-rows,opacity] duration-300 ease-[var(--ease-calm)]", moreRoles ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")} inert={!moreRoles}>
                      <div className="flex min-h-0 flex-col gap-3 overflow-hidden">
                        {MORE_ROLES.map((r) => (
                          <RolePicker key={r.role} label={r.label} value={preview.mapping[r.role]} columns={preview.columns} onChange={(c) => remap(r.role, c)} disabled={busy} />
                        ))}
                      </div>
                    </div>
                  </CardContent>
                  </div>
                  </div>
                </Card>
              ) : (
                <Card className="self-start p-5 text-sm text-muted-foreground">
                  A {FORMAT_LABEL[preview.format]} formátumnak kötött szerkezete van, nincs mit hozzárendelni.
                </Card>
              )}

              <div className="flex min-w-0 flex-col gap-3">
                {preview.errors.length > 0 && <ErrorList errors={preview.errors} />}

                {rows.length === 0 ? (
                  <Card className="p-6 text-center text-sm text-muted-foreground">
                    {tabular ? "Nincs beolvasható tranzakció. Állítsd be a dátum és az összeg oszlopát." : "Nincs beolvasható tranzakció a fájlban."}
                  </Card>
                ) : (
                  <Card className="overflow-hidden">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
                      <label className="flex cursor-pointer items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={allOn}
                          ref={(el) => { if (el) el.indeterminate = !allOn && selected.length > 0; }}
                          onChange={() => setExcluded(allOn ? new Set(rows.map((t) => t.externalId)) : new Set())}
                          className="size-4 accent-[var(--primary)]"
                        />
                        {selected.length} / {rows.length} kijelölve
                      </label>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {sums.map(([c, v]) => [v.out ? money(-v.out, c) : null, v.in ? money(v.in, c, { sign: true }) : null].filter(Boolean).join(" · ")).join(" · ")}
                      </span>
                    </div>
                    <ul className="divide-y">
                      {(showAll ? rows : rows.slice(0, PREVIEW_ROWS)).map((t) => {
                        const on = !excluded.has(t.externalId);
                        const cat = t.categoryId ? cats.get(t.categoryId) : undefined;
                        return (
                          <li key={t.externalId}>
                            <label className={cn("flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-opacity duration-200", !on && "opacity-45")}>
                              <input type="checkbox" checked={on} onChange={() => toggle(t.externalId)} className="size-4 shrink-0 accent-[var(--primary)]" />
                              <CategoryBadgeIcon category={cat} size="sm" />
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm">{t.merchant || "Névtelen"}</div>
                                <div className="truncate text-xs text-muted-foreground">
                                  {shortDate(t.date)} · {cat?.name ?? "Kategória nélkül"}{t.note ? ` · ${t.note}` : ""}
                                </div>
                              </div>
                              <span className={cn("shrink-0 text-sm font-medium tabular-nums", t.amount > 0 && "text-positive")}>
                                {money(t.amount, t.currency, { sign: t.amount > 0 })}
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                    {rows.length > PREVIEW_ROWS && !showAll && (
                      <button onClick={() => setShowAll(true)} className="w-full border-t px-4 py-2.5 text-xs text-muted-foreground transition-colors duration-200 hover:bg-muted/50 hover:text-foreground">
                        További {rows.length - PREVIEW_ROWS} sor mutatása
                      </button>
                    )}
                  </Card>
                )}

                <div className="flex flex-wrap items-center gap-3">
                  <Button onClick={doImport} disabled={busy || selected.length === 0}>
                    <Check /> {phase === "importing" ? "Importálás…" : `${selected.length} tétel importálása`}
                  </Button>
                  <p className="text-xs text-muted-foreground">A korábban már importált sorokat a szerver kihagyja, így duplán nem kerülnek be.</p>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function RolePicker({ label, hint, value, columns, onChange, disabled }: { label: string; hint?: string; value?: string; columns: string[]; onChange: (col: string) => void; disabled?: boolean }) {
  return (
    <div className="grid gap-1">
      <span className="text-xs text-muted-foreground">{label}{hint ? <span className="opacity-70"> · {hint}</span> : null}</span>
      <Select value={value || NONE} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger aria-label={label} className={cn("h-9", !value && "text-muted-foreground")}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>Nincs ilyen oszlop</SelectItem>
          {[...new Set(columns.filter(Boolean))].map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

function ErrorList({ errors }: { errors: string[] }) {
  const [open, setOpen] = useState(false);
  const shown = open ? errors : errors.slice(0, 3);
  return (
    <div className="w-full rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
      <p className="font-medium">{errors.length} figyelmeztetés</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        {shown.map((e, i) => <li key={i}>{e}</li>)}
      </ul>
      {errors.length > 3 && (
        <button onClick={() => setOpen((v) => !v)} className="mt-1 underline-offset-2 hover:underline">
          {open ? "Kevesebb" : `Mind a ${errors.length} mutatása`}
        </button>
      )}
    </div>
  );
}
