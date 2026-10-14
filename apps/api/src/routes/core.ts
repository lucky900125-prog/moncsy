import type { FastifyInstance } from "fastify";
import { isAuthorized, type AppDeps } from "../app.js";
import {
  categoryCreateSchema,
  categoryPatchSchema,
  parseOrThrow,
  summaryQuerySchema,
  transactionCreateSchema,
  transactionPatchSchema,
  transactionQuerySchema,
} from "../schemas.js";

type IdParams = { Params: { id: string } };

export async function coreRoutes(app: FastifyInstance, { repo, ai, config, backup }: AppDeps): Promise<void> {
  // Open to everyone so clients can tell "server down" from "wrong token"; the setup details only with the token.
  app.get("/health", async (req) => {
    const base = { status: "ok", time: new Date().toISOString(), auth: config.apiToken ? "token" : "none" };
    if (!isAuthorized(config, req)) return base;
    return {
      ...base,
      ai: { provider: ai.name, model: ai.model },
      revolut: { mode: config.revolut.mode },
      backup: backup?.getStatus() ?? { enabled: false },
    };
  });

  app.get("/categories", async () => repo.listCategories());

  app.post("/categories", async (req, reply) => {
    const body = parseOrThrow(categoryCreateSchema, req.body, "category");
    reply.status(201);
    return repo.createCategory(body);
  });

  app.patch<IdParams>("/categories/:id", async (req) => {
    const body = parseOrThrow(categoryPatchSchema, req.body ?? {}, "category");
    return repo.updateCategory(req.params.id, body);
  });

  app.delete<IdParams>("/categories/:id", async (req, reply) => {
    await repo.deleteCategory(req.params.id);
    reply.status(204).send();
  });

  app.get("/transactions", async (req) => {
    const q = parseOrThrow(transactionQuerySchema, req.query, "query");
    return repo.listTransactions(q);
  });

  app.post("/transactions", async (req, reply) => {
    const body = parseOrThrow(transactionCreateSchema, req.body, "transaction");
    reply.status(201);
    return repo.createTransaction(body);
  });

  app.patch<IdParams>("/transactions/:id", async (req) => {
    const body = parseOrThrow(transactionPatchSchema, req.body ?? {}, "transaction");
    return repo.updateTransaction(req.params.id, body);
  });

  app.delete<IdParams>("/transactions/:id", async (req, reply) => {
    await repo.deleteTransaction(req.params.id);
    reply.status(204).send();
  });

  app.get("/summary", async (req) => {
    const q = parseOrThrow(summaryQuerySchema, req.query, "query");
    return repo.summary(q.from, q.to, q.currency, config.defaultCurrency);
  });
}
