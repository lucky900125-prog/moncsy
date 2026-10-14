import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { createAIProvider, type AIProvider } from "./ai/index.js";
import { loadConfig, type AppConfig } from "./config.js";
import { openDb, type DB } from "./db.js";
import { HttpError } from "./errors.js";
import { Repository } from "./repository.js";
import { createRevolutProvider, type RevolutProvider } from "./revolut/index.js";
import { aiRoutes } from "./routes/ai.js";
import { coreRoutes } from "./routes/core.js";
import { ioRoutes } from "./routes/io.js";
import { revolutRoutes } from "./routes/revolut.js";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export interface AppDeps {
  config: AppConfig;
  db: DB;
  repo: Repository;
  ai: AIProvider;
  revolut: RevolutProvider;
}

export interface BuildOptions {
  config?: Partial<AppConfig>;
  db?: DB;
  ai?: AIProvider;
  revolut?: RevolutProvider;
  logger?: boolean;
}

export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance & { deps: AppDeps }> {
  const base = loadConfig();
  const config: AppConfig = { ...base, ...opts.config };
  const db = opts.db ?? openDb(config.dbPath);
  const repo = new Repository(db);
  const deps: AppDeps = {
    config,
    db,
    repo,
    ai: opts.ai ?? createAIProvider(config.ai),
    revolut: opts.revolut ?? createRevolutProvider(config.revolut, repo),
  };

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 2 * 1024 * 1024 });
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
      await coreRoutes(api, deps);
      await aiRoutes(api, deps);
      await revolutRoutes(api, deps);
      await ioRoutes(api, deps);
    },
    { prefix: "/api" },
  );

  app.addHook("onClose", async () => {
    if (!opts.db) db.close();
  });

  app.decorate("deps", deps);
  return app as unknown as FastifyInstance & { deps: AppDeps };
}

/** Reads the single multipart "file" field into memory (size-limited by the multipart plugin). */
export async function readUpload(req: FastifyRequest): Promise<{ filename: string; mimetype: string; data: Buffer }> {
  if (!req.isMultipart()) throw new HttpError(415, 'Expected multipart/form-data with a "file" field');
  const file = await req.file();
  if (!file) throw new HttpError(400, 'Missing "file" field');
  if (file.fieldname !== "file") throw new HttpError(400, `Unexpected field "${file.fieldname}"; send the upload as "file"`);
  const data = await file.toBuffer();
  if (data.length === 0) throw new HttpError(400, "Uploaded file is empty");
  return { filename: file.filename, mimetype: file.mimetype, data };
}
