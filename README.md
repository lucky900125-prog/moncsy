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

## Élő demó

A `main` minden pusha után a GitHub Actions kiteszi a webappot GitHub Pages-re: https://lucky900125-prog.github.io/moncsy/ .
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
   - Három értéket kér:
     - `BACKUP_GITHUB_REPO`, például `lucky900125-prog/moncsy-data`;
     - `BACKUP_GITHUB_TOKEN`, a 2. lépés tokenje;
     - `BACKUP_KEY`, a 3. lépés kulcsa.
5. **Ellenőrzés.** A `https://<szolgáltatás neve>.onrender.com/api/health` címnek `{"status":"ok",…,"auth":"token"}` választ kell adnia. A mentés állapotát (utolsó mentés ideje, hiba, leállt-e) a `GET /api/backup/status` adja, ezt az app is megmutatja.
6. **Az app összekötése.**
   - Az `API_TOKEN` értékét a Render generálja: Render → moncsy-api → Environment.
   - Ezt és az API címét a webapp és a mobilapp beállításaiban kell megadni.
7. **AI- és Revolut-kulcsok, később.**
   - Helyük: Render → moncsy-api → Environment → Add Environment Variable.
   - AI: `ANTHROPIC_API_KEY`, vagy `AI_PROVIDER` + `AI_API_KEY` (a többi szolgáltató az `apps/api/README.md`-ben).
   - Revolut Business: `REVOLUT_BUSINESS_TOKEN`.
   - Kulcs nélkül az AI mintaválaszt ad, a Revolut pedig kivonatfájlból importál.

A kulcsok és tokenek csak a Render környezeti változóiban legyenek, soha ne a repóban vagy a webapp buildjében (`VITE_*`). Az ingyenes csomagon a tétlenség utáni első kérés kb. egy percig tart, mert a szerver ilyenkor indul el, és tölti vissza a mentést.
