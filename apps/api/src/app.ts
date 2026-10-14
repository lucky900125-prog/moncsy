import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { createAIProvider, type AIProvider } from "./ai/index.js";
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
    ai: opts.ai ?? createAIProvider(config.ai),
    revolut: opts.revolut ?? createRevolutProvider(config.revolut, repo),
    backup: null,
  };

  // Behind a reverse proxy (Render) the client address is in X-Forwarded-For; TRUST_PROXY_HOPS says how many proxies to trust.
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 2 * 1024 * 1024, trustProxy: (_addr: string, hop: number) => hop < config.trustProxyHops });
  if (opts.backup) {
    deps.backup = new BackupScheduler(db, opts.backup, { info: (m) => app.log.info(m), error: (m) => app.log.error(m) });
  }
  await app.register(cors, { origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(",").map((s) => s.trim()) });
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10 } });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    const status = err instanceof HttpError ? err.statusCode : (err.statusCode ?? 500);
    if (status >= 500 && !(err instanceof HttpError)) req.log.error(err);
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
        api.addHook("onRequest", async (req, reply) => {
          if (req.method === "OPTIONS" || req.routeOptions.url === "/api/health") return;
          const now = Date.now();
          let f = failures.get(req.ip);
          if (f && f.resetAt <= now) {
            failures.delete(req.ip);
            f = undefined;
          }
          if (f && f.count >= AUTH_MAX_FAILURES) {
            return reply.status(429).send({ error: "Too many wrong API tokens from this address; try again later" });
          }
          if (!isAuthorized(config, req)) {
            // Only a sent token is a guess; counting bare requests would let any crawler lock the owner out.
            if (req.headers.authorization) {
              failures.set(req.ip, { count: (f?.count ?? 0) + 1, resetAt: f?.resetAt ?? now + AUTH_WINDOW_MS });
            }
            return reply.status(401).send({ error: "Missing or wrong API token (Authorization: Bearer <API_TOKEN>)" });
          }
        });
      }
      if (deps.backup) {
        const backup = deps.backup;
        // Anything but a read may have written; the scheduler uploads only if the database actually changed.
        api.addHook("onResponse", async (req) => {
          if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") backup.touch();
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
    await deps.backup?.flush();
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
