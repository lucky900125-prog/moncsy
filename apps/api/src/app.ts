import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { createAIProvider, type AIProvider } from "./ai/index.js";
import { DailyLimitedProvider } from "./ai/quota.js";
import { BackupScheduler, type BackupConfig } from "./backup.js";
import { loadConfig, type AppConfig } from "./config.js";
import { openDb, type DB } from "./db.js";
import { HttpError } from "./errors.js";
import { Repository } from "./repository.js";
import { createRevolutProvider, type RevolutProvider } from "./revolut/index.js";
import { aiRoutes } from "./routes/ai.js";
import { coreRoutes } from "./routes/core.js";
import { ioRoutes } from "./routes/io.js";
import { productRoutes } from "./routes/products.js";
import { revolutRoutes } from "./routes/revolut.js";
import { statementRoutes } from "./routes/statements.js";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export interface AppDeps {
  config: AppConfig;
  db: DB;
  repo: Repository;
  ai: AIProvider;
  revolut: RevolutProvider;
  /** null when no off-site backup is configured */
  backup: BackupScheduler | null;
}

export interface BuildOptions {
  config?: Partial<AppConfig>;
  db?: DB;
  ai?: AIProvider;
  revolut?: RevolutProvider;
  backup?: BackupConfig | null;
  logger?: boolean;
}

/** After this many wrong tokens from one address in AUTH_WINDOW_MS, that address gets 429 until the window ends. */
const AUTH_MAX_FAILURES = 20;
const AUTH_WINDOW_MS = 10 * 60 * 1000;

export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance & { deps: AppDeps }> {
  const base = loadConfig();
  const config: AppConfig = { ...base, ...opts.config };
  const db = opts.db ?? (await openDb(config.dbPath));
  const repo = new Repository(db);
  const deps: AppDeps = {
    config,
    db,
    repo,
    ai: new DailyLimitedProvider(opts.ai ?? createAIProvider(config.ai), config.ai.dailyLimit),
    revolut: opts.revolut ?? createRevolutProvider(config.revolut, repo),
    backup: null,
  };

  // Behind a reverse proxy (Render) the client address is in X-Forwarded-For; TRUST_PROXY_HOPS says how many proxies to trust.
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 2 * 1024 * 1024, trustProxy: (_addr: string, hop: number) => hop < config.trustProxyHops });
  if (opts.backup) {
    deps.backup = new BackupScheduler(db, opts.backup, { info: (m) => app.log.info(m), error: (m) => app.log.error(m) });
    await deps.backup.init();
  }
  await app.register(cors, {
    origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(",").map((s) => s.trim()),
    // @fastify/cors allows only GET, HEAD and POST by default; a cross-origin web client also edits and deletes.
    methods: ["GET", "HEAD", "POST", "PATCH", "DELETE"],
  });
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10 } });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    const status = err instanceof HttpError ? err.statusCode : (err.statusCode ?? 500);
    if (status >= 500) req.log.error(err);
    const body: Record<string, unknown> = {
      error: status >= 500 && !(err instanceof HttpError) ? "Internal server error" : err.message,
    };
    if (err instanceof HttpError && err.details !== undefined) body.details = err.details;
    if (err.code === "FST_REQ_FILE_TOO_LARGE") body.error = `File too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`;
    reply.status(status).send(body);
  });
  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: `Route ${req.method} ${req.url} not found` }));

  await app.register(
    async (api) => {
      if (config.apiToken) {
        const failures = new Map<string, { count: number; resetAt: number }>();
        const unauthorized = { error: "Missing or wrong API token (Authorization: Bearer <API_TOKEN>)" };
        api.addHook("onRequest", async (req, reply) => {
          if (req.method === "OPTIONS") return;
          // The right token always gets through, so nobody can lock the owner out by sending wrong ones from the same
          // address (behind Render's proxy every client can share one). The limit only answers repeated wrong guesses.
          if (isAuthorized(config, req)) return;
          const health = req.routeOptions.url === "/api/health";
          // Only a sent token is a guess; counting bare requests would only add noise.
          if (!req.headers.authorization) return health ? undefined : reply.status(401).send(unauthorized);
          const now = Date.now();
          let f = failures.get(req.ip);
          if (!f || f.resetAt <= now) {
            f = { count: 0, resetAt: now + AUTH_WINDOW_MS };
            failures.set(req.ip, f);
          }
          f.count++;
          if (failures.size > 1000) for (const [ip, v] of failures) if (v.resetAt <= now) failures.delete(ip);
          if (f.count > AUTH_MAX_FAILURES) {
            return reply.status(429).send({ error: "Too many wrong API tokens from this address; try again later" });
          }
          // /health stays public, but it tells a right token from a wrong one, so a wrong guess there counts too.
          return health ? undefined : reply.status(401).send(unauthorized);
        });
      }
      if (deps.backup) {
        const backup = deps.backup;
        const refused = new WeakSet<FastifyRequest>();
        // While uploads are stopped or failing too long, writes are refused (BackupScheduler.refusal). Reads and the export
        // keep working, so the data can be saved by hand. Registered after the token check, so only the owner learns of it.
        api.addHook("onRequest", async (req, reply) => {
          if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
          const error = backup.refusal();
          if (error === null) return;
          refused.add(req);
          return reply.status(503).send({ error });
        });
        // Anything but a read may have written; the scheduler uploads only if the database actually changed.
        // A request refused for the token or the backup wrote nothing: letting it touch would let anyone keep postponing
        // the backup, and a refused write would set off an upload attempt each time.
        // onSend, not onResponse: onResponse never runs when the client went away before the response, though the write stands.
        api.addHook("onSend", async (req, _reply, payload) => {
          if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS" && isAuthorized(config, req) && !refused.has(req)) backup.touch();
          return payload;
        });
      }
      await coreRoutes(api, deps);
      await aiRoutes(api, deps);
      await revolutRoutes(api, deps);
      await ioRoutes(api, deps);
      await statementRoutes(api, deps);
      await productRoutes(api, deps);
    },
    { prefix: "/api" },
  );

  app.addHook("onClose", async () => {
    await deps.backup?.close();
    if (!opts.db) db.close();
  });

  app.decorate("deps", deps);
  return app as unknown as FastifyInstance & { deps: AppDeps };
}

/** True when no API_TOKEN is configured, or the request carries it as a Bearer token. */
export function isAuthorized(config: AppConfig, req: FastifyRequest): boolean {
  if (!config.apiToken) return true;
  const given = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim() ?? "";
  // Compare digests so the check takes the same time whatever the token's length or content.
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return given !== "" && timingSafeEqual(digest(given), digest(config.apiToken));
}

/**
 * Reads the single multipart "file" field into memory (size-limited by the multipart plugin).
 * Text fields are returned too, but only those sent before the file.
 */
export async function readUpload(
  req: FastifyRequest,
): Promise<{ filename: string; mimetype: string; data: Buffer; fields: Record<string, string> }> {
  if (!req.isMultipart()) throw new HttpError(415, 'Expected multipart/form-data with a "file" field');
  const file = await req.file();
  if (!file) throw new HttpError(400, 'Missing "file" field');
  if (file.fieldname !== "file") throw new HttpError(400, `Unexpected field "${file.fieldname}"; send the upload as "file"`);
  const data = await file.toBuffer();
  if (data.length === 0) throw new HttpError(400, "Uploaded file is empty");
  const fields: Record<string, string> = {};
  for (const [name, f] of Object.entries(file.fields)) {
    const one = Array.isArray(f) ? f[0] : f;
    if (one && one.type === "field" && name !== "file") fields[name] = String(one.value);
  }
  return { filename: file.filename, mimetype: file.mimetype, data, fields };
}
