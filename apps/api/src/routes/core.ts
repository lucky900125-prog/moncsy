import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.js";
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

export async function coreRoutes(app: FastifyInstance, { repo, ai, config }: AppDeps): Promise<void> {
  app.get("/health", async () => ({
    status: "ok",
    time: new Date().toISOString(),
    ai: { provider: ai.name, model: ai.model },
    revolut: { mode: config.revolut.mode },
  }));

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
    repo.deleteCategory(req.params.id);
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
    repo.deleteTransaction(req.params.id);
    reply.status(204).send();
  });

  app.get("/summary", async (req) => {
    const q = parseOrThrow(summaryQuerySchema, req.query, "query");
    return repo.summary(q.from, q.to, q.currency, config.defaultCurrency);
  });
}
