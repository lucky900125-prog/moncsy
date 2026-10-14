import type { FastifyInstance } from "fastify";
import { readUpload, type AppDeps } from "../app.js";
import { HttpError, badRequest } from "../errors.js";
import { stripJpegMetadata } from "../io/jpeg.js";
import { toIso, rangeEnd } from "../repository.js";
import { analyzeRequestSchema, parseOrThrow } from "../schemas.js";
import { aggregate, analyze, productAggregate } from "../services/analyze.js";
import { scanReceipt } from "../services/receipt.js";

const ACCEPTED = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"]);
const BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
};

/** Trusts magic bytes over the client's content type; falls back to the file extension. */
export function sniffMime(data: Buffer, declared: string, filename: string): string {
  if (data.subarray(0, 4).toString("latin1") === "%PDF") return "application/pdf";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  const brand = data.subarray(4, 12).toString("latin1");
  if (/^ftyp(heic|heix|hevc|mif1|msf1|heif)/.test(brand)) return "image/heic";
  if (ACCEPTED.has(declared)) return declared;
  return BY_EXT[filename.split(".").pop()?.toLowerCase() ?? ""] ?? declared;
}

export async function aiRoutes(app: FastifyInstance, { repo, ai, config }: AppDeps): Promise<void> {
  app.post("/receipts/scan", async (req) => {
    const file = await readUpload(req);
    const mime = sniffMime(file.data, file.mimetype, file.filename);
    if (!ACCEPTED.has(mime)) {
      throw new HttpError(415, `Unsupported file type ${mime}; send JPEG, PNG, WebP, HEIC or PDF`);
    }
    // A photo's EXIF can hold where it was taken; the clients re-encode without it, and this holds for any other sender.
    let image = file.data;
    if (mime === "image/jpeg") {
      try {
        image = stripJpegMetadata(file.data);
      } catch (e) {
        throw badRequest(`The image is not a readable JPEG: ${(e as Error).message}`);
      }
    }
    return scanReceipt(ai, await repo.listCategories(), image.toString("base64"), mime);
  });

  app.post("/ai/analyze", async (req) => {
    const body = parseOrThrow(analyzeRequestSchema, req.body, "analyze request");
    const txs = await repo.listTransactions({ from: body.from, to: body.to });
    if (body.scope === "products") {
      const agg = productAggregate(txs, toIso(body.from), rangeEnd(body.to), body.products);
      if (agg.products.length === 0) {
        throw new HttpError(
          422,
          agg.filter
            ? "No receipt line items in this period match the product filter."
            : "No receipt line items in this period yet; scan receipts to compare product prices.",
        );
      }
      return analyze(ai, body, agg);
    }
    const agg = aggregate(txs, await repo.listCategories(), toIso(body.from), rangeEnd(body.to), config.defaultCurrency);
    return analyze(ai, body, agg);
  });
}
