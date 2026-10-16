# @et/api

The expense tracker's backend: Fastify on Node 24 (the repository's `.node-version`; `engines` asks for 24 or later), SQLite storage with an optional encrypted off-site backup, a pluggable AI provider for receipt scanning and spending and product analysis, bank statement import for any bank, and Revolut import. It implements the HTTP contract in `packages/shared/src/index.ts`. All routes are under `/api`, and with `API_TOKEN` set every route except `/health` needs `Authorization: Bearer <API_TOKEN>`.

```bash
pnpm install                 # from the repo root
pnpm --filter @et/api dev    # tsx watch, http://localhost:8787/api/health
pnpm --filter @et/api build && pnpm --filter @et/api start
pnpm --filter @et/api test   # vitest; uses the offline mock provider, no network
```

Copy `.env.example` to `.env`, here or in the repository root (the root `.env.example` lists the few settings a local run needs). At startup the server loads `./.env` from its working directory and then the repository root's `.env`, each when present (`src/env-files.ts`); a key in both takes the first file's value, real environment variables take precedence over both, and the log names the files it read.

## Storage

The API uses SQLite through **`node:sqlite`**, which is built into Node, rather than `better-sqlite3`. pnpm 10 blocks dependency build scripts unless they are allow-listed in the workspace root config, so `better-sqlite3`'s native binary never gets built. `node:sqlite` needs no native build. Node 24.21 (the version this repository pins) prints no `ExperimentalWarning` for it, so nothing suppresses one.

Everything above the database talks to the small async `DB` interface in `db.ts` (`all`, `get`, `run`, `exec`, `tx`, `close`), so another engine can be dropped in without touching the repository. `tx()` runs one transaction at a time; queries outside it wait for it to finish.

The database is created at `DB_PATH` on first run. Its schema changes are the ordered list `MIGRATIONS` in `src/db.ts`. The database records how many it has had (meta `schema_version`), and on start each missing one runs once, in its own transaction. A database made before versioning counts as version 1 and is taken over unchanged. A database with a higher version than the server knows was written by a newer release, so the server refuses to start rather than run older code on it. A schema change is a new entry at the end of the list; an entry that databases already have is never edited. The default categories come from `packages/shared` (`DEFAULT_CATEGORIES`) and are seeded on every start with `INSERT OR IGNORE`: a category added to the list later appears in existing databases on the next start, while rows the user has edited are left alone. Their ids are stable English slugs and their names are Hungarian:

| id | name | icon (lucide) | color |
|---|---|---|---|
| groceries | Élelmiszer | shopping-cart | #7c9a7e |
| restaurant | Étterem | utensils-crossed | #c4956c |
| transport | Közlekedés | bus | #8aa6b8 |
| housing | Lakhatás | home | #9d8fb5 |
| utilities | Rezsi | zap | #c9a66b |
| entertainment | Szórakozás | film | #b5899f |
| health | Egészség | heart-pulse | #b88a8a |
| clothing | Ruházat | shirt | #7fa8a3 |
| travel | Utazás | plane | #8f9bb3 |
| subscriptions | Előfizetések | repeat | #a3a86b |
| other | Egyéb | package | #94a3a8 |
| income | Bevétel | wallet | #6f8f73 |

### Off-site backup (`src/backup.ts`)

For hosts whose disk is wiped on restart (Render's free plan), set `BACKUP_GITHUB_REPO`, `BACKUP_GITHUB_TOKEN` and `BACKUP_KEY`:

- **What is uploaded.** A `VACUUM INTO` snapshot, gzipped and encrypted with AES-256-GCM (`MONCSYBK2 | generation | nonce | ciphertext | tag`; the magic and the generation are authenticated), written as one file through the GitHub contents API. Every upload is a commit, so the repository history keeps older copies.
- **When.** `BACKUP_DEBOUNCE_MS` (10 s) after the last request with the right token that was not a read, only if SQLite's change counter moved, and never later than a minute after the first such request. Once more when the server shuts down, retried up to three times. A failed upload is retried after a minute. Every GitHub call gives up after 60 s.
- **Restore.** On start, when the file at `DB_PATH` does not exist, the latest copy is downloaded and decrypted before the database is opened. If the copy exists but cannot be read or decrypted, or the token cannot see the repository, the server does not start, so an empty database never overwrites a good backup. It also refuses when the file is gone but its history has commits (deleted), or when the history names a higher generation than the file holds (rolled back). `BACKUP_ALLOW_RESET=1` accepts either for one start; remove it afterwards. A copy that decrypts but fails SQLite's `PRAGMA integrity_check` (or is not a database at all) is refused too, before it is put in place; restore an earlier generation from the repository history then.
- **Never over a newer copy.** Each upload has the next generation, and the database records the generation it came from (meta `backup_generation`, stamped into the uploaded copy too). Before writing over a remote copy it has not written itself, an instance checks that the remote generation is its own; the upload is a compare-and-swap on the file's sha. If another instance wrote a newer remote copy, uploads stop and `stopped: true` with the reason shows in `GET /backup/status`; a restart loads that copy. The changes made on this instance since its last backup are not in it, the write that revealed the conflict included, which already got its 2xx (an accepted limit), so the reason says to save them with `GET /export` before restarting. If the remote copy was rolled back to an older generation, uploads stop too, and the reason says not to restart before exporting the data, because the newer data is only on this disk. A remote copy that this `BACKUP_KEY` cannot decrypt stops uploads as well. So does a GitHub 401, 404, or 403 that is not a rate limit, while uploading or reading the remote copy: an expired or revoked token, or lost access to the repository, is not fixed by retrying. The reason then says to save the changes since the last backup with `GET /export` before setting a working token and restarting. Every other failure (5xx, timeout, rate limit) is retried.
- **Writes stop with it.** Once uploads have stopped, every `/api` request that is not a `GET`, `HEAD` or `OPTIONS` gets 503 with the reason, because what it wrote would exist only on a disk the host wipes on restart. The same happens while uploads keep failing, once a change has waited more than 5 minutes for one, and lasts until the next upload succeeds. A refused request sets off no upload attempt of its own. Reads, `GET /backup/status` and `GET /export` keep working, so the data on the disk can still be saved by hand. A request without the right token still gets 401 first.
- **Checking a copy without restoring it.** `pnpm --filter @et/api build`, then in `apps/api` with the same backup settings as the server (`BACKUP_GITHUB_REPO`, `BACKUP_GITHUB_TOKEN_FILE`, `BACKUP_KEY_FILE`, from the environment or `./.env`): `pnpm verify-backup`. It downloads the copy the next start would restore, decrypts it into a temporary file, runs `PRAGMA integrity_check`, and prints its generation, when it was made and the row count of every table, plus a `PROBLEM:` line for anything the next start would refuse or that would stop the restored server's backups. It uploads nothing, writes nothing at `DB_PATH` and deletes the temporary file, so it can run beside the live server. Exit code 0 means the copy is sound, 1 that a problem was found, and 2 that the check could not run (settings, network, GitHub). Trying a restore with the live settings instead would make a database whose first write uploads a new generation over the server's copy and stops the server's own backups.
- **Status.** `GET /backup/status` (and the token-protected part of `GET /health`) returns `BackupStatus`: `lastBackupAt` and `generation` survive restarts because they travel with the database; `lastError` shows an expired token or any other failed upload.
- **Limits.** Writes made in the last few seconds before the host kills the process without a shutdown signal are lost. When two instances run at once (during a deploy), the second writer stops instead of overwriting, so its writes after the first one's upload are not backed up.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address. Any other address needs `API_TOKEN` or `ALLOW_NO_AUTH=1` |
| `DB_PATH` | `./data/expense.db` | SQLite file (`:memory:` for an ephemeral DB) |
| `CORS_ORIGIN` | `http://localhost:5173,http://localhost:4173` | Allowed origins, comma-separated. Without `API_TOKEN`, `*` lets any website you visit read and change your data |
| `API_TOKEN` / `API_TOKEN_FILE` | – | Bearer token for every route except `/health`. The right token is always accepted. After 20 wrong tokens from one address in 10 minutes, further wrong tokens from it get 429 until the window ends, also on `/health`; requests without a token are not counted |
| `ALLOW_NO_AUTH` | – | `1` = start on a non-localhost `HOST` without a token (logged as a warning) |
| `TRUST_PROXY_HOPS` | `0` | Reverse proxies whose `X-Forwarded-For` is trusted for the client address (used by the wrong-token limit) |
| `BACKUP_GITHUB_REPO` | – | `owner/name` of a private repository for the encrypted backup |
| `BACKUP_GITHUB_TOKEN` / `_FILE` | – | Fine-grained token with Contents read and write on that repository only |
| `BACKUP_KEY` / `_FILE` | – | 32 random bytes, base64 (`openssl rand -base64 32`). Without it the backup cannot be decrypted |
| `BACKUP_GITHUB_PATH` | `moncsy.db.enc` | File path inside the backup repository |
| `BACKUP_DEBOUNCE_MS` | `10000` | Delay after the last write before uploading |
| `REQUIRE_BACKUP` | – | `1` = refuse to start without the three `BACKUP_` values |
| `BACKUP_ALLOW_RESET` | – | `1` = start even though the backup file was deleted or rolled back; for one start only |
| `STATEMENT_TZ` | `Europe/Budapest` | Time zone of the wall-clock times in bank and Revolut statements |
| `DEFAULT_CURRENCY` | `HUF` | Summary/analysis currency when a range has no transactions, and statement currency when the file has none |
| `AI_PROVIDER` | auto | `anthropic` \| `openai` \| `ollama` \| `mock`. If unset: `anthropic` when `ANTHROPIC_API_KEY` is set, else `openai` when `OPENAI_API_KEY` is set, else `mock` |
| `AI_MODEL` | per provider | `claude-sonnet-5-5` / `gpt-4.1-mini` / `llama3.2-vision` |
| `AI_API_KEY` | – | Key for the selected provider (overrides the two below) |
| `ANTHROPIC_API_KEY` | – | Anthropic key |
| `OPENAI_API_KEY` | – | OpenAI key |
| `AI_BASE_URL` | per provider | Endpoint override (OpenRouter, Groq, LM Studio, remote Ollama, proxies) |
| `AI_TIMEOUT_MS` | `90000` (ollama `180000`) | Per-request timeout |
| `AI_JSON_MODE` | `on` | openai provider: send `response_format: json_object`. Set `off` for servers that reject it |
| `ANTHROPIC_FALLBACKS` | `on` | anthropic provider: server-side refusal fallback (see below) |
| `AI_DAILY_LIMIT` | `100` | AI calls allowed per UTC day, over receipt scans, analyses and PDF statements together; the next one gets 429 until 00:00 UTC. `0` turns the AI off. Counted in memory, so a restart starts the day again: set a spending cap at the provider too |
| `REVOLUT_MODE` | auto | `business-api` \| `open-banking` \| `csv`. If unset: `business-api` when `REVOLUT_BUSINESS_TOKEN` is set, else `csv` |
| `REVOLUT_BUSINESS_TOKEN` | – | Revolut Business API access token |
| `REVOLUT_ENV` | `production` | `production` or `sandbox` |

## Endpoints

| Method & path | Body / query | Response |
|---|---|---|
| `GET /health` | | `{ status, time, auth: "token" \| "none" }`; with a valid token also `ai: { provider, model }, revolut: { mode }, backup` |
| `GET /backup/status` | | `BackupStatus`: `{ enabled, lastBackupAt, generation, lastError, pending, stopped }` |
| `GET /categories` | | `Category[]` |
| `POST /categories` | `{ name, icon, color, parentId?, budget? }` | `201 Category` (`isCustom: true`) |
| `PATCH /categories/:id` | any subset of the create fields | `Category` |
| `DELETE /categories/:id` | | `204`. Only custom categories (built-in → `409`). Their transactions and subcategories fall back to `null` |
| `GET /transactions` | `from`, `to`, `categoryId` (`none` = uncategorized), `q` (merchant/note search) | `Transaction[]`, newest first |
| `POST /transactions` | `Omit<Transaction,"id">`. `source` defaults to `manual`, `categoryId` to `null` | `201 Transaction` |
| `PATCH /transactions/:id` | partial; `note`/`items`/`categoryId`/`externalId` accept `null` to clear | `Transaction` |
| `DELETE /transactions/:id` | | `204` |
| `GET /summary` | `from`, `to` (required), `currency` (optional) | `Summary` |
| `POST /receipts/scan` | multipart `file`: JPEG/PNG/WebP/HEIC/PDF, max 10 MB; whether HEIC and PDF can be read depends on the AI provider (see below). An image reaches the AI without its metadata: a JPEG without EXIF apart from the orientation, XMP, IPTC, comments and anything after the image (`io/jpeg.ts`); a PNG without eXIf apart from the orientation, text and time chunks and every other chunk a decoder does not use (`io/png.ts`); a WebP without EXIF apart from the orientation, XMP and unknown chunks (`io/webp.ts`); a HEIC/HEIF with its Exif and XMP items overwritten with zeros (`io/heif.ts`). An image whose structure cannot be followed gets 400 (`The image is not a readable <format>: …`) | `ReceiptScanResult` |
| `POST /ai/analyze` | `AnalyzeRequest`; `scope: "products"` asks where each product was cheapest, optionally narrowed by `products: { q?, brand?, merchant? }` | `AnalyzeResponse`; 422 when the range has no (matching) receipt line items |
| `GET /products` | `from`, `to` (optional) | `{ products: ProductStat[], stores: StoreRank[] }` from receipt line items (`@et/shared/products`) |
| `POST /statements/parse` | multipart `file`: any bank's CSV/XLSX, CAMT.052/053/054, OFX, MT940, PDF (AI); optional fields `mapping` (JSON) and `currency`, sent before the file | `StatementPreview`; nothing is saved |
| `POST /statements/import` | `{ transactions: StatementTx[] }` (max 20 000) | `{ imported, skipped, errors }`; rows whose `externalId` exists are skipped |
| `GET /revolut/status` | | `RevolutStatus` |
| `POST /revolut/sync` | | `{ imported, skipped }` |
| `POST /revolut/import-statement` | multipart `file`: Revolut CSV or XLSX statement | `{ imported, skipped, errors }` |
| `POST /import` | multipart `file`: `.xlsx` or `.xml` | `{ imported, skipped, errors }` |
| `GET /export` | `format=xlsx\|xml` (default xlsx), `from`, `to` | file download |

Conventions:

- **Errors.** Every error returns `{ error: string, details?: unknown }`. The status codes are 400 (validation), 401 (missing or wrong token), 404, 409 (conflict, built-in category), 413 (upload > 10 MB, or an XLSX file too large to read, see below), 415 (wrong file type), 422 (product analysis without receipt lines, or an AI answer cut off at its token limit), 429 (too many wrong tokens, or the day's AI calls under `AI_DAILY_LIMIT` used up), 500 (server error), 501 (open-banking sync), 502 (AI provider or Revolut upstream failure, or invalid AI JSON; the provider's own text goes to the server log, not into the answer) and 503 (writes while the backup has stopped or has failed for more than 5 minutes, Revolut business-api without a token, or XLSX reading switched off by `NODE_OPTIONS`, see below). Every answer carries `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
- **Dates.** Dates are stored as full ISO 8601 UTC strings. Any parseable date is accepted on input, and `2026-10-12` becomes `2026-10-12T00:00:00.000Z`. A date-only `to` covers the whole day.
- **`GET /summary`.** Amounts in different currencies are never added together. The summary covers `currency`, or else the most common currency in the range, or else `DEFAULT_CURRENCY`. `income` and `expense` are non-negative magnitudes. `byCategory[].total` is the signed sum (negative = spending), largest spend first. An income category has a positive total.
- **Notes.** An empty `note` is stored as no note.
- **Duplicate `externalId`.** Creating a transaction with an existing `externalId` returns 409.
- **Uploaded XLSX** (`/statements/parse`, `/revolut/import-statement`, `/import`). A few kilobytes of workbook XML can describe the whole sheet (a merge, a data validation, a defined name or a column range up to cell XFD1048576), and ExcelJS builds an object for every cell it covers, so such a file runs any server out of memory. Everything about an uploaded workbook happens in a worker thread (`io/xlsx-worker.ts`) with a 96 MB heap and a 30 s limit, one file at a time, so the server's own thread never unpacks or scans one. Before ExcelJS loads anything, the archive is unpacked and counted there, every part of it read the way ExcelJS reads it (`io/xlsx-ranges.ts`: whatever its name, in either quote, with character references or comments inside a range): more than 20 MB unpacked, more than 100 000 merged cells, data validation or defined names over more than 200 000 cells (a whole column is 1 048 576) each get 413, and a column past XFD gets 400. The workbook is then read in the same thread, which holds about 30 000 rows of a five-column statement or 20 000 rows of an export; Render's free plan restarts the service at 512 MB, and the main thread alone can take 250-330 MB: a file that needs more gets 413, one that takes more than 30 s gets 413 too, and the server keeps running. A sheet with a value beyond row 100 000 or column 200 gets 400. A process-wide `--max-old-space-size` (for example in `NODE_OPTIONS`) overrides the worker's limit, so while one larger than twice that limit is set, every XLSX upload gets 503 and says why.

## AI providers (`src/ai/`)

```ts
interface AIProvider {
  name: string; model: string;
  complete(messages: ChatMessage[], opts?: { json?, maxTokens?, temperature? }): Promise<string>;
  vision(imageBase64: string, mime: string, prompt: string, opts?): Promise<string>;
}
```

All adapters use plain `fetch`, with no vendor SDKs. The callers in `src/services/` ask for strict JSON and validate the reply with zod in `ai/json.ts`. A surrounding Markdown code fence is tolerated. If the reply does not parse, or parses but has the wrong shape, the endpoint returns **502** with the reason and the first 1000 characters of the raw answer in `details`. Defaults are few and named here. A `suggestedCategoryId` that is not an existing category id becomes `null`. On a receipt, a line without a quantity counts as 1 and a reply without lines has none; a line's product details (`product`, `brand`, `packSize`, `packUnit`) that do not fit their type become `null` instead of failing the scan, because they only enrich the line. Every text and list in a reply has an upper limit far beyond a real answer (a receipt's merchant 200 characters and at most 500 lines, an analysis summary 4000 characters, a PDF statement at most 20 000 rows), so a runaway or planted answer is a 502 rather than a huge response; a receipt line's `product` or `brand` longer than the 120 characters a saved line takes becomes `null`.

| Provider | Setup | Notes |
|---|---|---|
| **mock** (default without keys) | nothing | Deterministic and offline. `vision` returns a fixed SPAR receipt (4 785 HUF, 5 items, `groceries`). `complete` derives Hungarian insights from the aggregate it is sent |
| **anthropic** | `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY=…`, optional `AI_MODEL` (default `claude-sonnet-5-5`) | `POST https://api.anthropic.com/v1/messages`, `anthropic-version: 2023-06-01`. Images are sent as `image` blocks (JPEG/PNG/GIF/WebP) and PDFs as `document` blocks. HEIC returns 415, so convert it to JPEG first. Every request states `thinking: {type: "adaptive"}` and `output_config: {effort: "medium"}` and sends no `temperature`, which Sonnet 5.5 refuses; a model that takes neither field fails with the API's 400 in a 502. A `refusal` stop returns 502. A `max_tokens` or `model_context_window_exceeded` stop returns 422 saying the answer was cut off (thinking counts toward `max_tokens`; receipts and analyses get 16000, PDF statements 16000), as does a `length` finish from the openai and ollama adapters. Against the official endpoint the adapter also sends the server-side refusal fallback (`anthropic-beta: server-side-fallback-2026-07-01`, `fallbacks: "default"`). Set `ANTHROPIC_FALLBACKS=off` to disable it; it is skipped automatically when `AI_BASE_URL` points elsewhere |
| **openai** | `AI_PROVIDER=openai`, `OPENAI_API_KEY=…`, optional `AI_MODEL` (default `gpt-4.1-mini`) | `POST {base}/chat/completions` with `response_format: json_object`. Images are sent as `image_url` data URLs and PDFs as `file` parts (OpenAI supports these; many compatible servers do not). HEIC is passed on as it is; a server that cannot read it answers with an error, which comes back as 502, not 415 |
| ↳ OpenRouter | `AI_PROVIDER=openai`, `AI_BASE_URL=https://openrouter.ai/api/v1`, `AI_API_KEY=sk-or-…`, `AI_MODEL=anthropic/claude-sonnet-5-5` (any vision model) | |
| ↳ Groq | `AI_PROVIDER=openai`, `AI_BASE_URL=https://api.groq.com/openai/v1`, `AI_API_KEY=gsk_…`, `AI_MODEL=<a Groq vision model>` | |
| ↳ LM Studio / vLLM | `AI_PROVIDER=openai`, `AI_BASE_URL=http://localhost:1234/v1`, `AI_MODEL=<loaded model>` | No key is needed for a non-OpenAI base URL. Set `AI_JSON_MODE=off` if the server rejects `json_object` |
| **ollama** | `AI_PROVIDER=ollama`, `AI_MODEL=llama3.2-vision` (or `qwen2.5vl`, …), optional `AI_BASE_URL` (default `http://localhost:11434`) | `POST /api/chat` with `format: "json"` and `images: [base64]`. Images only: PDF and HEIC return 415 |

**Receipt scanning.** The prompt (`services/receipt.ts`) gives the model the existing category ids and covers Hungarian receipt conventions: `ÖSSZESEN`/`FIZETENDŐ` as the total, `ÁFA` lines that are not items, `Ft` = HUF, decimal commas, and `2026.10.14.` dates. The file type is detected from magic bytes, then from the declared type and the file extension.

**Analysis.** `/ai/analyze` sends the model an **aggregate**, never raw rows (`services/analyze.ts`). The aggregate holds:

- totals in the main currency
- spending by category, with share and budget
- the top 8 merchants
- monthly income and expense
- month-over-month change, including the biggest category movers
- totals for other currencies

The model answers in Hungarian unless the question is in another language.

## Bank statements (`src/statements/`)

`POST /statements/parse` reads a statement from any bank and returns a preview; `POST /statements/import` saves the rows the user confirmed. The format is detected from the content, not the file name:

- **CSV / XLSX.** The header row is searched for in the first 40 rows, and columns are matched by Hungarian, English and German names (accents and case ignored) to roles such as `date`, `amount` or `debit` + `credit`, `currency`, `counterparty`, `description`. The decimal separator and the day/month order are detected per column. CSV may be UTF-8, UTF-16 with a byte order mark (Excel's "Unicode text") or Windows-1250, with `;`, `,`, tab or `|` delimiters. When the date or the amount cannot be found, the preview lists the columns so the client can send a `mapping`. A Revolut export is routed to the Revolut parser. From an XLSX file the sheet with the most filled rows is read, and a formula cell counts as its result (a number stays a number, a date a date).
- **CAMT.052/053/054** (ISO 20022 XML), **OFX** and **MT940** are read by their structure.
- **PDF** goes to the AI provider's vision call, so it needs a real provider. The model also reads the opening and closing balance; when it finds both, every row is readable and in the account's currency, and the rows do not add up to the change between them to the cent, the preview carries a warning in `errors` and still lists the rows.
- **Old `.xls`** and XML that is not a bank statement are refused with 415 and a message saying what to do.
- **Header row.** A summary line above the table can name a date and an amount too, so the header is the last such row before the first transaction. With no header recognised, the columns offered for a `mapping` are those of the row above the first transaction.
- **Size.** Text statements (CSV, OFX, MT940, CAMT) are parsed on the main thread, so one larger than 4 MB gets 413 before it is read; 20 000 CSV rows are about 2 MB and take about 0.6 s. A statement of more than 20 000 rows (transactions, skipped and unreadable rows together) gets 413 too, in any format, because `POST /statements/import` takes at most 20 000 at once; the rows are counted once the file is split into them, before any is read, so a 4 MB file of 89 000 rows is refused in about 0.25 s rather than 2 s. Revolut statement import has the same two limits.
- **Deduplication.** `externalId` is the bank's reference when there is one, otherwise `stmt:` + a hash of date, amount, currency, counterparty and description, with a `:n` suffix for identical rows in one file.

## Revolut (`src/revolut/`)

Statement import (`POST /revolut/import-statement`) works in every mode. `REVOLUT_MODE` picks what `/revolut/status` and `/revolut/sync` do.

### `csv` (default): statement import

In the Revolut app, choose Account → Statement → Excel or CSV, then upload the file.

- **Columns.** The importer reads `Type, Product, Started Date, Completed Date, Description, Amount, Fee, Currency, State, Balance` by header name, case-insensitive. CSV (with or without BOM) and XLSX are both supported; from an XLSX file the sheet with the most filled rows is read. A CSV saved again from a Hungarian Excel, with `;` delimiters, decimal commas and `2026. 10. 01. 8:15` dates, is read too.
- **Which rows are imported.** Only `State = COMPLETED` rows are imported. `EXCHANGE` rows (internal currency conversions) are not imported. Both kinds count as `skipped`.
- **Amounts.** Amount = `Amount − Fee`. A non-zero fee is mentioned in the note.
- **Dates.** The date is `Completed Date`, or `Started Date` when there is none. Revolut writes local time without an offset; it is read in `STATEMENT_TZ` and stored as UTC.
- **Deduplication.** `externalId = "revolut:" + sha256(date | amount | description)`. Re-importing the same or an overlapping statement, in either format, skips rows that already exist. Identical rows within one file get an `:n` suffix.
- **Categories.** Simple keyword rules (`categorize.ts`) match accent- and case-insensitively: Spar/Tesco/Lidl → Élelmiszer, Wolt/foodora → Étterem, BKK/MOL/Bolt → Közlekedés, Netflix/Spotify → Előfizetések, and so on. Any other positive amount → Bevétel. Rows with no match get `null`.
- **Status.** `/revolut/status` reports the latest balance per product and currency seen in statements. `/revolut/sync` returns 400 in this mode.

### `business-api`: Revolut Business accounts only

Set `REVOLUT_BUSINESS_TOKEN` (Revolut Business → APIs) and optionally `REVOLUT_ENV=sandbox`.

- **Endpoints.** The base URLs are `https://b2b.revolut.com/api/1.0` and `https://sandbox-b2b.revolut.com/api/1.0`, with `Authorization: Bearer <token>`. The adapter calls `GET /accounts` for status and `GET /transactions?from&to&count=1000` for sync. It pages backwards by passing the last item's `created_at` as `to`. All of this was checked against developer.revolut.com.
- **What gets imported.** Sync fetches from the last sync minus one day, or the last 90 days on the first run. Each leg of a completed, non-exchange transaction becomes one transaction, with `externalId = revolut-biz:<id>:<leg_id>`.
- **Caveats:**
  - Access tokens expire after **40 minutes**. Refreshing a token needs a refresh token plus a client-assertion JWT signed with your private key. **That flow is not implemented** (TODO in `business-api.ts`): a 401 returns a 502 telling you to refresh the token.
  - **Unverified:** the docs list `legs[].amount` and `fee` but do not state the sign convention. The adapter assumes outgoing amounts are negative and the fee is a positive charge (TODO in code).

### `open-banking`: personal accounts (stub)

Personal Revolut accounts cannot be read with a personal token. Revolut's Open Banking (PSD2 AIS) API is only open to **licensed Account Information Service Providers**. In this mode `/revolut/sync` returns **501** with that explanation, and `/revolut/status` reports `connected: false`. To make it work, implement the TODO in `open-banking.ts` against an aggregator such as **GoCardless Bank Account Data** or **Enable Banking** (consent → requisition → accounts → transactions). Until then, use statement import.

## Import / export

`GET /export?format=xlsx|xml&from&to` returns all categories plus the transactions in the range, oldest first. `POST /import` accepts either format back. Import rules:

- **Existing rows are skipped.** A category id, transaction id or `externalId` that already exists is skipped and never overwritten. Re-importing an export imports nothing.
- **Bad rows don't stop the import.** Each invalid row adds a message with its sheet/row or element number to `errors[]`, and the remaining rows are still imported.
- **What the counts include.** `imported` and `skipped` count category and transaction rows together.
- **Round trips are lossless.** Every field of `Category` and `Transaction` survives export → import into an empty database (covered by tests). Built-in categories already exist in any database, so they are skipped rather than overwritten.

### XLSX

| Sheet | Columns (header row; order does not matter on import) |
|---|---|
| `Transactions` | `id`, `date` (ISO text), `amount`, `currency`, `merchant`, `categoryId`, `category` (name, informational), `note`, `source`, `externalId`, `items` (JSON array) |
| `Categories` | `id`, `name`, `icon`, `color`, `isCustom`, `parentId`, `budget` |

For hand-made sheets, only `date`, `amount`, `currency` and `merchant` are required:

- `id` is generated when missing.
- `source` defaults to `import`.
- A `category` name can stand in for `categoryId`.
- Real Excel date cells are accepted.

### XML

```xml
<?xml version="1.0" encoding="UTF-8"?>
<expenses version="1" exportedAt="2026-10-14T10:00:00.000Z">
  <categories>
    <category id="groceries" isCustom="false">
      <name>Élelmiszer</name><icon>shopping-cart</icon><color>#7c9a7e</color>
      <budget>80000</budget>                  <!-- optional -->
      <parentId>…</parentId>                  <!-- optional -->
    </category>
  </categories>
  <transactions>
    <transaction id="…" source="receipt">     <!-- id optional on import; source defaults to "import" -->
      <date>2026-10-12T10:30:00.000Z</date>
      <amount>-4785</amount>                  <!-- negative = expense -->
      <currency>HUF</currency>
      <merchant>SPAR</merchant>
      <categoryId>groceries</categoryId>      <!-- optional -->
      <note>…</note>                          <!-- optional -->
      <externalId>…</externalId>              <!-- optional -->
      <items>                                 <!-- optional -->
        <item><name>Tej</name><quantity>2</quantity><unitPrice>389</unitPrice><total>778</total></item>
      </items>
    </transaction>
  </transactions>
</expenses>
```

Elements with null or absent values are omitted. All values are read as strings and validated with zod, so a merchant called `123` stays a string.

## Layout

```
src/
  index.ts            entry (loads .env, listens)
  env-files.ts        which .env files are read, and in what order
  app.ts              buildApp(): plugins, error handler, routes; injectable db/ai/revolut for tests
  config.ts db.ts repository.ts schemas.ts errors.ts
  backup.ts           encrypted off-site backup to a private GitHub repository, restore on start
  verify-backup.ts    `pnpm verify-backup`: read-only check of the backup copy, separate from the server
  ai/                 provider interface + anthropic/openai/ollama/mock adapters, strict JSON parsing
  services/           receipt.ts (scan prompt + validation), analyze.ts (aggregate + prompt)
  revolut/            csv.ts, business-api.ts, open-banking.ts, categorize.ts
  io/                 xlsx.ts (+ xlsx-worker.ts, the reading thread, and the checks it runs first: zip.ts, xlsx-ranges.ts), xml.ts, text.ts, common.ts (shared import pipeline)
  statements/         any bank's statement: tabular.ts (CSV/XLSX), formats.ts (CAMT/OFX/MT940), pdf.ts, values.ts
  routes/             core.ts, ai.ts, revolut.ts, io.ts, statements.ts, products.ts
test/                 vitest suites (fastify.inject, in-memory SQLite, mock provider)
```
