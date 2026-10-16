import { randomBytes } from "node:crypto";
import { buildApp, type BuildOptions } from "../src/app.js";
import { MockProvider } from "../src/ai/index.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";

export async function testApp(opts: BuildOptions = {}) {
  const base = loadConfig({ AI_PROVIDER: "mock" });
  return buildApp({
    db: opts.db ?? await openDb(":memory:"),
    ai: opts.ai ?? new MockProvider(),
    revolut: opts.revolut,
    config: { ...base, dbPath: ":memory:", ...opts.config },
  });
}

/** fields go before the file, as the routes read only those (app.ts readUpload). */
export function multipart(filename: string, contentType: string, data: Buffer | string, field = "file", fields: Record<string, string> = {}) {
  const boundary = `----et${randomBytes(8).toString("hex")}`;
  const before = Object.entries(fields)
    .map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
    .join("");
  const head = Buffer.from(
    `${before}--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, typeof data === "string" ? Buffer.from(data) : data, tail]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

/**
 * A real 8x8 JPEG without metadata (Pillow 12.3, quality 50), small enough to inline: the scan route follows its
 * markers to strip metadata (io/jpeg.ts). The mock provider never decodes it.
 */
export const FAKE_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCDT9C6fJRRRXPVxNTm3LwGLq+xWp//2Q==",
  "base64",
);
