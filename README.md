# moncsy – kiadáskövető

Monorepo (pnpm workspace):

| Mappa | Mi |
|---|---|
| `apps/web` | React 19 + Vite + Tailwind v4 + shadcn-stílusú (Radix) komponensek, telepíthető PWA |
| `apps/api` | Node API: blokkfelismerés, AI-független elemzés, Revolut, XLSX/XML import-export |
| `packages/shared` | Közös típusok és a HTTP szerződés |
| `apps/mobile` | Expo / React Native kliens (Expo Router, NativeWind) ugyanarra az API-ra |

```bash
pnpm install
pnpm dev:api   # http://localhost:8787
pnpm dev:web   # http://localhost:5173 (a /api-t proxyzza)
pnpm --filter @et/mobile start
```

Ha az API nem érhető el, a web „Demó mód”-ban fut böngészőben tárolt mintaadatokkal.

### Helyi beállítások: `.env` a repó gyökerében

Az API a saját mappájának (`apps/api`) `.env`-jét, majd a repó gyökerében lévő `.env`-et olvassa, ha van. A gyökérbe tett `.env` tehát elég. Mintának a gyökér `.env.example` szolgál (az AI-kulcs és pár gyakori beállítás), a teljes lista az `apps/api/.env.example`. A `.env` sosem kerül a gitbe.

```powershell
Copy-Item .env.example .env   # a repó gyökerében
code .env                     # vagy bármelyik szerkesztő: ANTHROPIC_API_KEY=...
```

Ha egy beállítás mindkét fájlban szerepel, de más értékkel (az üres érték is más), az API nem indul el, és kiírja a beállítás nevét és a két fájlt; ilyenkor egy fájlban hagyd meg, a gyökér `.env` használatához töröld az `apps/api/.env`-et. A valódi környezeti változó mindkét fájlt felülírja. AI-szolgáltató nélkül sem indul: `AI_PROVIDER=anthropic` mellé `ANTHROPIC_API_KEY` kell, a mintaválaszokhoz kulcs nélkül `AI_PROVIDER=mock`. Az `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` és `GEMINI_API_KEY` közül amelyik be van írva, az a szolgáltató a modelljeivel választható az app beállításaiban; az `AI_PROVIDER` és az `AI_MODEL` csak az alapérték. Induláskor a napló kiírja, melyik fájlokat olvasta (`settings read from …`) és melyik AI-t használja (`AI provider: …`). A `DB_PATH` relatív útja az `apps/api` mappához képest értendő (alapból `apps/api/data/expense.db`). PowerShellben ne `echo … > .env`-vel hozd létre a fájlt, mert a Windows PowerShell 5.1 UTF-16-ban írja; ilyen fájllal az API nem indul el, és UTF-8 mentést kér.

A `pnpm-workspace.yaml` csak az ott felsorolt függőségek telepítő-szkriptjét engedi futni, és egy napnál frissebb csomagverziót nem old fel. Ha egy régebbi telepítés után a `pnpm install` `ERR_PNPM_IGNORED_BUILDS` hibával áll meg, töröld egyszer a `node_modules` mappákat (`rm -rf node_modules apps/*/node_modules packages/*/node_modules`), és telepíts újra.

A `pnpm audit --audit-level high` hetente és minden függőséget módosító PR-on lefut (`.github/workflows/audit.yml`); a két elfogadott, csak a mobil eszközláncot érintő találat a `pnpm-workspace.yaml` `auditConfig` részében van, indoklással. A Dependabot hetente nyit frissítési PR-t (`.github/dependabot.yml`). Minden GitHub Action egy commitra van rögzítve (a verzió megjegyzésben), mert egy tag később más kódra mutathat; a Dependabot a commitot és a megjegyzést együtt frissíti.

## Élő demó

A `main` minden pusha után a GitHub Actions kiteszi a webappot GitHub Pages-re, de csak ha a CI ellenőrzései (tesztek, buildek) átmentek (`.github/workflows/ci.yml`): https://lucky900125-prog.github.io/moncsy/ .
Ott nincs API, így demó módban fut (mintaadatok a böngészőben; a blokkfelismerés és az elemzés fix mintaeredményt ad).
Egyszeri beállítás a repóban: Settings → Pages → Source: „GitHub Actions”.

## Backend élesítése (Render, ingyenes)

A `render.yaml` egy Render Blueprint: az API-t az ingyenes csomagon futtatja, és az adatbázist titkosítva egy privát GitHub repóba menti. Az ingyenes Render lemeze minden leállításkor kiürül (15 perc tétlenség után is), ezért a szerver induláskor onnan tölti vissza. Mentés nélkül el sem indul (`REQUIRE_BACKUP=1`).

1. **Privát repó a mentésnek.** GitHubon hozz létre egy új, **Private** repót, például `moncsy-data`. Maradhat üres.
2. **Token, ami csak ehhez a repóhoz fér hozzá.**
   - Helye: GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.
   - Repository access: Only select repositories → `moncsy-data`.
   - Repository permissions → Contents: **Read and write**. Más jogosultság nem kell.
   - Amikor a token lejár, a mentés hibát jelez (a Render naplójában és a `/api/health` válaszában), ilyenkor újat kell beírni.
3. **Titkosító kulcs.** `openssl rand -base64 32` (vagy `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`). Tedd el a jelszókezelődbe is: kulcs nélkül a mentés nem fejthető vissza.
4. **Render Blueprint.**
   - Render → New → Blueprint → ez a repó. A Render a `main` ágon lévő `render.yaml`-t olvassa.
   - Öt értéket kér:
     - `AI_PROVIDER`: `anthropic`, vagy `mock` mintaválaszokhoz;
     - `ANTHROPIC_API_KEY`: az Anthropic-kulcs, `mock` esetén üresen hagyva;
     - `BACKUP_GITHUB_REPO`, például `lucky900125-prog/moncsy-data`;
     - `BACKUP_GITHUB_TOKEN`, a 2. lépés tokenje;
     - `BACKUP_KEY`, a 3. lépés kulcsa.
5. **Ellenőrzés.** A `https://<szolgáltatás neve>.onrender.com/api/health` címnek `{"status":"ok",…,"auth":"token"}` választ kell adnia. A mentés állapotát (utolsó mentés ideje, hiba, leállt-e) a `GET /api/backup/status` adja, ezt az app is megmutatja.
6. **Az app összekötése.**
   - Az `API_TOKEN` értékét a Render generálja: Render → moncsy-api → Environment.
   - Ezt és az API címét a webapp és a mobilapp beállításaiban kell megadni.
7. **AI-csere és Revolut-kulcs, később.**
   - Helyük: Render → moncsy-api → Environment.
   - AI: `mock` helyett `AI_PROVIDER=anthropic` és `ANTHROPIC_API_KEY`. Az `OPENAI_API_KEY` és a `GEMINI_API_KEY` mellé is felvehető: amelyiknek van kulcsa, az a beállításokban választható. `mock` mellett beállított kulccsal az API nem indul el.
   - Revolut Business: `REVOLUT_BUSINESS_TOKEN`. Nélküle a Revolut kivonatfájlból importál.

A kulcsok és tokenek csak a Render környezeti változóiban legyenek, soha ne a repóban vagy a webapp buildjében (`VITE_*`). Az ingyenes csomagon a tétlenség utáni első kérés kb. egy percig tart, mert a szerver ilyenkor indul el, és tölti vissza a mentést.
