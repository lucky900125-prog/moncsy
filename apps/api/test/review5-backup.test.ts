import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { MockProvider } from "../src/ai/index.js";
import { BackupScheduler, type BackupConfig, type GithubStore } from "../src/backup.js";
import { loadConfig } from "../src/config.js";
import { getMeta, openDb } from "../src/db.js";
import { HttpError } from "../src/errors.js";
import { fakeGithub } from "./fake-github.js";
import { multipart } from "./helpers.js";

const cfg: BackupConfig = { repo: "me/moncsy-data", token: "gh-token", path: "moncsy.db.enc", key: randomBytes(32), debounceMs: 60_000 };

afterEach(() => vi.unstubAllGlobals());

describe("backup mark across an upload (review round 5)", () => {
  it("keeps the mark for a write let in while an upload runs and made after it finished (K1)", async () => {
    const db = await openDb(":memory:");
    let land: () => void = () => {};
    const upload = vi.fn(() => new Promise<void>((resolve) => (land = resolve)));
    const store = { knowsRemote: true, upload } as unknown as GithubStore;
    const scheduler = new BackupScheduler(db, cfg, { info() {}, error() {} }, store);
    await scheduler.init();
    await scheduler.beginWrite();
    await db.run("INSERT INTO categories (id, name, icon, color) VALUES ('a', 'A', 'x', '#123456')");
    scheduler.endWrite();

    const uploading = scheduler.flush();
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await scheduler.beginWrite(); // a request let in during the upload, whose body is still arriving
    land();
    await uploading;
    await db.run("INSERT INTO categories (id, name, icon, color) VALUES ('b', 'B', 'x', '#123456')");
    expect(await getMeta(db, "backup_dirty")).toBe("1");
    scheduler.endWrite();
    // The next upload covers the second write, with no request open, so it clears the mark.
    upload.mockImplementation(async () => {});
    await scheduler.close();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(await getMeta(db, "backup_dirty")).toBe("0");
    db.close();
  });

  it("does not mark the database for requests that only read, such as an analysis (A1)", async () => {
    vi.stubGlobal("fetch", fakeGithub().fetchImpl);
    const app = await buildApp({ ai: new MockProvider(), backup: cfg, config: { ...loadConfig({ AI_PROVIDER: "mock" }), dbPath: ":memory:" } });
    await app.inject({ method: "POST", url: "/api/ai/analyze", payload: { from: "2026-10-01", to: "2026-10-31", scope: "spending" } });
    await app.inject({ method: "POST", url: "/api/statements/parse", ...multipart("k.csv", "text/csv", "Dátum;Összeg;Partner\n2026.10.01;-100;Spar\n") });
    expect(await getMeta(app.deps.db, "backup_dirty")).toBeNull();
    await app.inject({ method: "POST", url: "/api/categories", payload: { name: "Új", icon: "x", color: "#123456" } });
    expect(await getMeta(app.deps.db, "backup_dirty")).toBe("1");
    await app.close();
  });
});

describe("server error log (A5)", () => {
  it("logs an expected 5xx as a warning without a stack, and an unexpected one as an error with it", async () => {
    const stream = new PassThrough();
    const lines: Record<string, unknown>[] = [];
    stream.on("data", (b: Buffer) => b.toString().split("\n").filter(Boolean).forEach((l) => lines.push(JSON.parse(l))));
    const app = await buildApp({ ai: new MockProvider(), logger: { stream }, config: { ...loadConfig({ AI_PROVIDER: "mock" }), dbPath: ":memory:" } });
    app.get("/api/test-expected", async () => {
      throw new HttpError(502, "AI provider \"x\" returned HTTP 500", undefined, { cause: new Error("x answered: overloaded") });
    });
    app.get("/api/test-unexpected", async () => {
      throw new Error("boom");
    });
    await app.inject("/api/test-expected");
    await app.inject("/api/test-unexpected");
    await app.close();
    const expected = lines.find((l) => String(l.msg).includes("returned HTTP 500"))!;
    expect(expected).toMatchObject({ level: 40, status: 502 });
    expect(String(expected.msg)).toMatch(/x answered: overloaded/);
    expect(JSON.stringify(expected)).not.toMatch(/\bat .*\.ts:\d+/);
    expect(lines.find((l) => (l.err as { message?: string } | undefined)?.message === "boom")).toMatchObject({ level: 50 });
  });
});
