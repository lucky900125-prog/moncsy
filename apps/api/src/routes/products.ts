import type { FastifyInstance } from "fastify";
import { buildProductStats, rankStores } from "@et/shared/products";
import type { AppDeps } from "../app.js";
import { parseOrThrow, productQuerySchema } from "../schemas.js";

export async function productRoutes(app: FastifyInstance, { repo }: AppDeps): Promise<void> {
  // Products are derived from the line items saved on receipt transactions, so there is nothing to keep in sync.
  app.get("/products", async (req) => {
    const q = parseOrThrow(productQuerySchema, req.query, "query");
    const products = buildProductStats(await repo.listTransactions({ from: q.from, to: q.to }));
    return { products, stores: rankStores(products) };
  });
}
