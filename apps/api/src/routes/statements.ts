import type { FastifyInstance } from "fastify";
import type { StatementMapping } from "@et/shared";
import { readUpload, type AppDeps } from "../app.js";
import { badRequest } from "../errors.js";
import { parseOrThrow } from "../schemas.js";
import { importStatementTxs, parseStatementFile, statementImportSchema } from "../statements/index.js";

const ROLES = new Set(["date", "valueDate", "amount", "debit", "credit", "direction", "currency", "counterparty", "description", "type", "balance", "reference"]);

function mappingField(raw: string | undefined): StatementMapping | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw badRequest('"mapping" must be a JSON object of role -> column name');
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw badRequest('"mapping" must be a JSON object');
  const out: StatementMapping = {};
  for (const [role, col] of Object.entries(parsed)) {
    if (!ROLES.has(role)) throw badRequest(`"mapping": unknown role "${role}"`);
    if (col !== null && col !== "" && typeof col !== "string") throw badRequest(`"mapping.${role}" must be a column name`);
    // An empty value means "this role has no column" and stops auto-detection from filling it.
    out[role as keyof StatementMapping] = (col as string | null) ?? "";
  }
  return out;
}

export async function statementRoutes(app: FastifyInstance, { repo, ai, config }: AppDeps): Promise<void> {
  app.post("/statements/parse", { config: { readOnly: true } }, async (req) => {
    const file = await readUpload(req);
    const currency = file.fields.currency?.trim();
    if (currency && !/^[A-Za-z]{3}$/.test(currency)) throw badRequest('"currency" must be an ISO 4217 code');
    return parseStatementFile(
      file,
      { mapping: mappingField(file.fields.mapping), currency: currency || undefined, defaultCurrency: config.defaultCurrency, timeZone: config.statementTz },
      ai.pick(file.fields.provider, file.fields.model),
    );
  });

  app.post("/statements/import", { bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    const body = parseOrThrow(statementImportSchema, req.body, "statement import");
    return importStatementTxs(repo, body.transactions);
  });
}
