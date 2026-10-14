import type { FastifyInstance } from "fastify";
import { readUpload, type AppDeps } from "../app.js";
import { importStatement } from "../revolut/index.js";

export async function revolutRoutes(app: FastifyInstance, { repo, revolut }: AppDeps): Promise<void> {
  app.get("/revolut/status", async () => revolut.status());

  app.post("/revolut/sync", async () => revolut.sync());

  // Statement import works in every mode (it is the only option for personal accounts without an aggregator).
  // Returns { imported, skipped } plus errors[] for rows that could not be parsed.
  app.post("/revolut/import-statement", async (req) => importStatement(repo, await readUpload(req)));
}
