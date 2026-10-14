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
