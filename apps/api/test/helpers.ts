import { randomBytes } from "node:crypto";
import { buildApp, type BuildOptions } from "../src/app.js";
import { MockProvider } from "../src/ai/index.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";

export async function testApp(opts: BuildOptions = {}) {
  const base = loadConfig({});
  return buildApp({
    db: opts.db ?? openDb(":memory:"),
    ai: opts.ai ?? new MockProvider(),
    revolut: opts.revolut,
    config: { ...base, dbPath: ":memory:", ...opts.config },
  });
}

export function multipart(filename: string, contentType: string, data: Buffer | string, field = "file") {
  const boundary = `----et${randomBytes(8).toString("hex")}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, typeof data === "string" ? Buffer.from(data) : data, tail]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

/** Smallest valid-looking JPEG header; the mock provider never decodes it. */
export const FAKE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
