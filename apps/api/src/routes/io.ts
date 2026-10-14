import type { FastifyInstance } from "fastify";
import { readUpload, type AppDeps } from "../app.js";
import { HttpError } from "../errors.js";
import { applyImport } from "../io/common.js";
import { exportXlsx, parseXlsx } from "../io/xlsx.js";
import { exportXml, parseXml } from "../io/xml.js";
import { exportQuerySchema, parseOrThrow } from "../schemas.js";

export async function ioRoutes(app: FastifyInstance, { repo }: AppDeps): Promise<void> {
  app.post("/import", async (req) => {
    const file = await readUpload(req);
    const head = file.data.subarray(0, 64).toString("utf8").replace(/^\uFEFF/, "").trimStart();
    const isZip = file.data.subarray(0, 2).toString("latin1") === "PK";
    let payload;
    if (/\.xlsx$/i.test(file.filename) || isZip) payload = await parseXlsx(file.data);
    else if (/\.xml$/i.test(file.filename) || head.startsWith("<")) payload = parseXml(file.data.toString("utf8"));
    else throw new HttpError(415, "Unsupported import file; send .xlsx or .xml");
    return applyImport(repo, payload);
  });

  app.get("/export", async (req, reply) => {
    const q = parseOrThrow(exportQuerySchema, req.query, "query");
    const payload = {
      categories: repo.listCategories(),
      transactions: repo.listTransactions({ from: q.from, to: q.to }).reverse(),
    };
    const stamp = new Date().toISOString().slice(0, 10);
    if (q.format === "xml") {
      reply
        .header("content-type", "application/xml; charset=utf-8")
        .header("content-disposition", `attachment; filename="expenses-${stamp}.xml"`);
      return exportXml(payload);
    }
    reply
      .header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("content-disposition", `attachment; filename="expenses-${stamp}.xlsx"`);
    return exportXlsx(payload);
  });
}
