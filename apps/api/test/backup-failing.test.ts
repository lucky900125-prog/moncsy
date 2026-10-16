import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { MockProvider } from "../src/ai/index.js";
import type { BackupConfig } from "../src/backup.js";
import { loadConfig } from "../src/config.js";
import { fakeGithub } from "./fake-github.js";

const cfg: BackupConfig = { repo: "me/moncsy-data", token: "gh-token", path: "moncsy.db.enc", key: randomBytes(32), debounceMs: 5 };
let dirs: string[] = [];
const tempDb = () => {
  const d = mkdtempSync(join(tmpdir(), "moncsy-bkf-"));
  dirs.push(d);
  return join(d, "expense.db");
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** The fake GitHub, with every upload answered by `uploads.answer` while it is set; `uploads.attempts` counts the uploads tried. */
function github() {
  const gh = fakeGithub();
  const uploads = { attempts: 0, answer: null as (() => Response) | null };
  vi.stubGlobal("fetch", ((url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      uploads.attempts++;
      if (uploads.answer) return Promise.resolve(uploads.answer());
    }
    return gh.fetchImpl(url, init);
  }) as typeof fetch);
  return { gh, uploads };
}

const headers = { authorization: "Bearer right" };
const tx = { date: "2026-10-14", amount: -100, currency: "HUF", merchant: "Spar", categoryId: null, source: "manual" };
const start = () => buildApp({ ai: new MockProvider(), backup: cfg, config: { ...loadConfig({ AI_PROVIDER: "mock" }), dbPath: tempDb(), apiToken: "right" } });
const tick = () => new Promise((r) => setTimeout(r, 50));

describe("a backup that keeps failing", () => {
  it.each([
    [401, "Bad credentials"],
    [403, "Resource not accessible by personal access token"],
    [404, "Not Found"],
  ])("stops at GitHub %i, which no retry fixes, and refuses writes from then on", async (status, body) => {
    const { gh, uploads } = github();
    const app = await start();
    expect((await app.inject({ method: "POST", url: "/api/transactions", headers, payload: tx })).statusCode).toBe(201);
    await app.deps.backup!.flush();
    expect(gh.state.puts).toBe(1);

    uploads.answer = () => new Response(body, { status });
    expect((await app.inject({ method: "POST", url: "/api/transactions", headers, payload: tx })).statusCode).toBe(201);
    await app.deps.backup!.flush();
    const s = app.deps.backup!.getStatus();
    expect(s).toMatchObject({ stopped: true, pending: true });
    expect(s.lastError).toMatch(new RegExp(`^GitHub ${status} writing me/moncsy-data/moncsy\\.db\\.enc: ${body}\\. Retrying cannot fix this`));
    expect(s.lastError).toMatch(/save the changes made since .* with GET \/api\/export, then set a working BACKUP_GITHUB_TOKEN and restart/);

    const refused = await app.inject({ method: "POST", url: "/api/transactions", headers, payload: tx });
    expect(refused.statusCode).toBe(503);
    expect(refused.json().error).toMatch(new RegExp(`^Changes are not saved: the backup has stopped \\(GitHub ${status} `));
    const tried = uploads.attempts;
    await app.deps.backup!.flush();
    await tick();
    expect(uploads.attempts).toBe(tried);
    expect((await app.inject({ url: "/api/export", headers })).statusCode).toBe(200);
    uploads.answer = null;
    await app.close();
    expect(gh.state.puts).toBe(1);
  });

  it("keeps retrying a rate limit, which passes by itself", async () => {
    const { gh, uploads } = github();
    const app = await start();
    for (const limited of [
      () => new Response("API rate limit exceeded", { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
      () => new Response("You have exceeded a secondary rate limit", { status: 403 }),
      () => new Response("slow down", { status: 403, headers: { "retry-after": "60" } }),
      () => new Response("Too Many Requests", { status: 429 }),
    ]) {
      uploads.answer = limited;
      expect((await app.inject({ method: "POST", url: "/api/transactions", headers, payload: tx })).statusCode).toBe(201);
      await app.deps.backup!.flush();
      expect(app.deps.backup!.getStatus()).toMatchObject({ stopped: false, pending: true, lastError: expect.stringMatching(/^GitHub 4(03|29) /) });
    }
    uploads.answer = null;
    await app.deps.backup!.flush();
    expect(app.deps.backup!.getStatus()).toMatchObject({ stopped: false, pending: false, lastError: null });
    expect(gh.state.puts).toBe(1);
    await app.close();
  });

  it("refuses writes once a change has waited 5 minutes for a failing upload, and takes them again after the next upload", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-10-14T12:00:00Z").getTime();
    vi.setSystemTime(t0);
    const { gh, uploads } = github();
    const app = await start();
    uploads.answer = () => new Response("Service Unavailable", { status: 503 });

    expect((await app.inject({ method: "POST", url: "/api/transactions", headers, payload: tx })).statusCode).toBe(201);
    await app.deps.backup!.flush();
    expect(app.deps.backup!.getStatus()).toMatchObject({ stopped: false, pending: true, lastError: expect.stringMatching(/^GitHub 503 /) });

    // Within the 5 minutes the server keeps taking writes while it retries.
    vi.setSystemTime(t0 + 5 * 60_000);
    expect((await app.inject({ method: "POST", url: "/api/transactions", headers, payload: tx })).statusCode).toBe(201);
    await app.deps.backup!.flush();

    vi.setSystemTime(t0 + 5 * 60_000 + 1000);
    const refused = await app.inject({ method: "POST", url: "/api/transactions", headers, payload: tx });
    expect(refused.statusCode).toBe(503);
    expect(refused.json().error).toBe(
      "Changes are not saved: the backup has failed for more than 5 minutes (GitHub 503 writing me/moncsy-data/moncsy.db.enc: Service Unavailable). " +
        "Reading and GET /api/export still work, and writing works again after the next successful backup.",
    );
    expect((await app.inject({ url: "/api/transactions", headers })).json()).toHaveLength(2);
    expect((await app.inject({ url: "/api/export", headers })).statusCode).toBe(200);
    expect(app.deps.backup!.getStatus()).toMatchObject({ stopped: false });

    // A refused write wrote nothing, so it does not set off an upload either.
    await app.deps.backup!.flush();
    const tried = uploads.attempts;
    for (let i = 0; i < 3; i++) expect((await app.inject({ method: "DELETE", url: "/api/transactions/x", headers })).statusCode).toBe(503);
    await tick();
    expect(uploads.attempts).toBe(tried);

    uploads.answer = null;
    await app.deps.backup!.flush();
    expect(app.deps.backup!.getStatus()).toMatchObject({ stopped: false, pending: false, lastError: null });
    expect(gh.state.puts).toBe(1);
    expect((await app.inject({ method: "POST", url: "/api/transactions", headers, payload: tx })).statusCode).toBe(201);
    await app.close();
    expect(gh.state.puts).toBe(2);
  });
});
