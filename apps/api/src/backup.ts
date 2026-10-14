import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import type { BackupStatus } from "@et/shared";
import { getMeta, setMeta, type DB } from "./db.js";

/*
 * Off-site copy of the SQLite file for hosts whose disk does not survive a restart (Render's free tier).
 * The file is gzipped and encrypted with AES-256-GCM before it leaves the server, and stored as one file in a
 * private GitHub repository; every backup is a commit, so the repository history doubles as point-in-time copies.
 * On start, when the local database file is missing, the latest copy is downloaded and decrypted first.
 *
 * Blob layout: MAGIC | generation (uint64 BE) | 12-byte nonce | ciphertext | 16-byte GCM tag.
 * MAGIC and the generation are the additional authenticated data, so the generation cannot be changed without the key.
 *
 * Every upload carries the next generation, and the database records the generation it was restored from or last
 * uploaded (meta "backup_generation", also stamped into the uploaded copy itself). Before writing over a remote copy
 * this instance has not written itself, it checks that the remote generation is the one this database came from;
 * if not, another instance (or a manual restore) wrote something newer, and uploads stop loudly instead of
 * overwriting it. The upload itself is a compare-and-swap on the file's sha, which closes the window in between.
 */

const MAGIC = Buffer.from("MONCSYBK2");
const HEADER_LENGTH = MAGIC.length + 8;
const META_GENERATION = "backup_generation";
const META_AT = "backup_at";

export interface BackupConfig {
  /** "owner/name" of a private repository */
  repo: string;
  token: string;
  /** path of the blob inside the repository */
  path: string;
  /** 32 bytes */
  key: Buffer;
  /** wait this long after the last write before uploading */
  debounceMs: number;
  /** start even though the backup file is gone or older than its history says (BACKUP_ALLOW_RESET=1) */
  allowReset?: boolean;
}

/** Every GitHub call gives up after this long, so a hanging connection cannot hold a backup or a start forever. */
const GITHUB_TIMEOUT_MS = 60_000;

export type { BackupStatus };

function readSecret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, "utf8").trim();
  return env[name]?.trim() || undefined;
}

/**
 * All of BACKUP_GITHUB_REPO, BACKUP_GITHUB_TOKEN and BACKUP_KEY, or none; a half-configured backup refuses to start.
 * REQUIRE_BACKUP=1 (set by render.yaml) turns "none" into a refusal too, for hosts whose disk is wiped on restart.
 */
export function loadBackupConfig(env: NodeJS.ProcessEnv = process.env): BackupConfig | null {
  const repo = env.BACKUP_GITHUB_REPO?.trim();
  const token = readSecret(env, "BACKUP_GITHUB_TOKEN");
  const keyText = readSecret(env, "BACKUP_KEY");
  const given = [repo, token, keyText].filter(Boolean).length;
  if (given === 0 && env.REQUIRE_BACKUP === "1") {
    throw new Error(
      "REQUIRE_BACKUP=1 but BACKUP_GITHUB_REPO, BACKUP_GITHUB_TOKEN and BACKUP_KEY are not set; " +
        "on a host without a persistent disk every restart would start from an empty database.",
    );
  }
  if (given === 0) return null;
  if (given < 3) {
    throw new Error("Backup needs all of BACKUP_GITHUB_REPO, BACKUP_GITHUB_TOKEN (or _FILE) and BACKUP_KEY (or _FILE); some are missing.");
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo!)) throw new Error(`BACKUP_GITHUB_REPO must look like "owner/name", got "${repo}"`);
  const key = Buffer.from(keyText!, "base64");
  if (key.length !== 32) {
    throw new Error("BACKUP_KEY must be 32 random bytes in base64 (generate one with: openssl rand -base64 32)");
  }
  const debounceMs = Number(env.BACKUP_DEBOUNCE_MS?.trim() || 10_000);
  if (!Number.isInteger(debounceMs) || debounceMs < 0) throw new Error(`Invalid BACKUP_DEBOUNCE_MS "${env.BACKUP_DEBOUNCE_MS}" (expected milliseconds)`);
  const allowReset = env.BACKUP_ALLOW_RESET?.trim();
  if (allowReset && allowReset !== "1") throw new Error(`Invalid BACKUP_ALLOW_RESET "${allowReset}" (expected 1, or leave it unset)`);
  return { repo: repo!, token: token!, key, path: env.BACKUP_GITHUB_PATH?.trim() || "moncsy.db.enc", debounceMs, allowReset: allowReset === "1" };
}

function header(generation: number): Buffer {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error(`Invalid backup generation ${generation}`);
  const h = Buffer.alloc(HEADER_LENGTH);
  MAGIC.copy(h);
  h.writeBigUInt64BE(BigInt(generation), MAGIC.length);
  return h;
}

export function encryptBlob(plain: Buffer, key: Buffer, generation: number): Buffer {
  const head = header(generation);
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(head);
  const body = Buffer.concat([c.update(gzipSync(plain)), c.final()]);
  return Buffer.concat([head, nonce, body, c.getAuthTag()]);
}

export function decryptBlob(blob: Buffer, key: Buffer): { data: Buffer; generation: number } {
  if (blob.length < HEADER_LENGTH + 28 || !blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not a moncsy backup blob");
  const head = blob.subarray(0, HEADER_LENGTH);
  const generation = Number(head.readBigUInt64BE(MAGIC.length));
  const nonce = blob.subarray(HEADER_LENGTH, HEADER_LENGTH + 12);
  const tag = blob.subarray(blob.length - 16);
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAAD(head);
  d.setAuthTag(tag);
  try {
    return { data: gunzipSync(Buffer.concat([d.update(blob.subarray(HEADER_LENGTH + 12, blob.length - 16)), d.final()])), generation };
  } catch {
    throw new Error("backup could not be decrypted: wrong BACKUP_KEY or a damaged file");
  }
}

/** The remote file changed since this instance last read or wrote it (GitHub 409, or 422 for a missing sha). */
export class RemoteChangedError extends Error {}

/** A GitHub answer that is not a success. `lasting` when no retry can fix it: a token that expired, was revoked or lost access. */
export class GithubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly lasting: boolean,
  ) {
    super(message);
  }
}

/** 403 is also GitHub's rate limit (docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), which passes by itself. */
function githubError(res: Response, body: string, message: string): GithubError {
  const limited = res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after") || /rate limit/i.test(body);
  return new GithubError(message, res.status, res.status === 401 || res.status === 404 || (res.status === 403 && !limited));
}

/** The GitHub contents API, used for exactly one file. */
export class GithubStore {
  /** sha of the remote file as this instance last read or wrote it; null = no file */
  private sha: string | null = null;
  private known = false;

  constructor(
    private readonly cfg: Pick<BackupConfig, "repo" | "token" | "path">,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * True after a download or a successful upload: the remote file is then the one this instance saw last.
   * Any failed upload makes it false, since the write may or may not have landed.
   */
  get knowsRemote(): boolean {
    return this.known;
  }

  private repoUrl() {
    return `https://api.github.com/repos/${this.cfg.repo}`;
  }

  private url() {
    return `${this.repoUrl()}/contents/${this.cfg.path.split("/").map(encodeURIComponent).join("/")}`;
  }

  private call(url: string, init: RequestInit): Promise<Response> {
    return this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) });
  }

  private headers(accept: string) {
    return {
      authorization: `Bearer ${this.cfg.token}`,
      accept,
      "x-github-api-version": "2022-11-28",
      "user-agent": "moncsy-backup",
    };
  }

  /** null when the file does not exist yet; throws for every other failure, so a fresh start never hides a lost copy. */
  async download(): Promise<Buffer | null> {
    // Files over 1 MB get metadata only through the "object" (or "raw") media type (docs.github.com/en/rest/repos/contents).
    const meta = await this.call(this.url(), { headers: this.headers("application/vnd.github.object+json") });
    if (meta.status === 404) {
      // GitHub also answers 404 for a private repository the token cannot see; only a readable repository makes it "no file yet".
      const repo = await this.call(this.repoUrl(), { headers: this.headers("application/vnd.github+json") });
      if (!repo.ok) {
        const body = await repo.text();
        throw githubError(repo, body, `GitHub ${repo.status}: repository ${this.cfg.repo} not found, or BACKUP_GITHUB_TOKEN cannot read it`);
      }
      this.sha = null;
      this.known = true;
      return null;
    }
    if (!meta.ok) {
      const body = await meta.text();
      throw githubError(meta, body, `GitHub ${meta.status} reading ${this.cfg.repo}/${this.cfg.path}: ${body.slice(0, 200)}`);
    }
    const sha = ((await meta.json()) as { sha: string }).sha;
    const raw = await this.call(this.url(), { headers: this.headers("application/vnd.github.raw+json") });
    if (!raw.ok) throw githubError(raw, await raw.text(), `GitHub ${raw.status} downloading ${this.cfg.repo}/${this.cfg.path}`);
    const blob = Buffer.from(await raw.arrayBuffer());
    this.sha = sha;
    this.known = true;
    return blob;
  }

  /**
   * How many commits touched the file, and the highest generation their messages name. Every upload is a commit
   * "backup <generation> <time>", so a file that is gone or older than this was deleted or rolled back.
   */
  async history(): Promise<{ commits: number; maxGeneration: number | null }> {
    const res = await this.call(`${this.repoUrl()}/commits?path=${encodeURIComponent(this.cfg.path)}&per_page=100`, {
      headers: this.headers("application/vnd.github+json"),
    });
    // A repository without any commit, the state a new backup repository starts in, answers 409.
    if (res.status === 409) return { commits: 0, maxGeneration: null };
    if (!res.ok) throw githubError(res, await res.text(), `GitHub ${res.status} reading the history of ${this.cfg.repo}/${this.cfg.path}`);
    const list = (await res.json()) as { commit: { message: string } }[];
    const generations = list.map((c) => /^backup (\d+) /.exec(c.commit.message)?.[1]).filter((g) => g !== undefined).map(Number);
    return { commits: list.length, maxGeneration: generations.length ? Math.max(...generations) : null };
  }

  /** Writes over exactly the version last downloaded or uploaded; anything newer makes it throw RemoteChangedError. */
  async upload(blob: Buffer, message: string): Promise<void> {
    if (!this.known) throw new Error("upload() before download(): the remote version is not known");
    // Until GitHub confirms, the write may or may not have landed (a lost response is the hard case).
    this.known = false;
    const res = await this.call(this.url(), {
      method: "PUT",
      headers: { ...this.headers("application/vnd.github+json"), "content-type": "application/json" },
      body: JSON.stringify({ message, content: blob.toString("base64"), ...(this.sha ? { sha: this.sha } : {}) }),
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 200);
      if (res.status === 409 || res.status === 422) {
        throw new RemoteChangedError(`GitHub ${res.status} writing ${this.cfg.repo}/${this.cfg.path}; the file changed since it was read: ${text}`);
      }
      throw githubError(res, text, `GitHub ${res.status} writing ${this.cfg.repo}/${this.cfg.path}: ${text}`);
    }
    this.sha = ((await res.json()) as { content: { sha: string } }).content.sha;
    this.known = true;
  }
}

/**
 * SQLite's own consistency check of a database file, opened read-only. null when it is sound, otherwise what is wrong.
 * A file that is not a database, or is cut short, makes SQLite throw instead of answering; that is what is wrong then.
 */
export function checkDatabaseFile(path: string): string | null {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const rows = db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
    if (rows.length === 0) return "integrity_check returned nothing";
    const problems = rows.map((r) => r.integrity_check).filter((m) => m !== "ok");
    if (problems.length === 0) return null;
    const more = problems.length > 5 ? `; and ${problems.length - 5} more` : "";
    return `integrity_check: ${problems.slice(0, 5).join("; ")}${more}`;
  } catch (e) {
    return (e as Error).message;
  } finally {
    db?.close();
  }
}

/**
 * Downloads and decrypts the latest copy when the local file is missing.
 * Returns what happened, for the start-up log.
 */
export async function restoreIfMissing(dbPath: string, cfg: BackupConfig, store = new GithubStore(cfg)): Promise<string> {
  if (dbPath === ":memory:") throw new Error("Backup cannot be used with DB_PATH=:memory:");
  if (existsSync(dbPath)) return `local database ${dbPath} exists; not restoring`;
  const blob = await store.download();
  const history = await store.history();
  const reset = "or set BACKUP_ALLOW_RESET=1 for one start to accept it, and remove it again afterwards.";
  if (!blob) {
    if (history.commits === 0) return `no backup at ${cfg.repo}/${cfg.path} yet; starting with an empty database`;
    const last = history.maxGeneration === null ? "" : `, up to backup generation ${history.maxGeneration}`;
    if (!cfg.allowReset) {
      throw new Error(
        `${cfg.repo}/${cfg.path} is gone, but its history has ${history.commits} commit(s)${last}. Not starting with an empty database: ` +
          `restore the file from the repository history, ${reset}`,
      );
    }
    return `${cfg.repo}/${cfg.path} is gone (history has ${history.commits} commit(s)${last}); BACKUP_ALLOW_RESET=1, starting with an empty database`;
  }
  const { data, generation } = decryptBlob(blob, cfg.key);
  if (history.maxGeneration !== null && history.maxGeneration > generation && !cfg.allowReset) {
    throw new Error(
      `${cfg.repo}/${cfg.path} holds generation ${generation}, but generation ${history.maxGeneration} was written later: the copy was ` +
        `rolled back. Not starting from it: restore generation ${history.maxGeneration} from the repository history, ${reset}`,
    );
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  // Journal files left by an earlier database at this path would be replayed over the restored copy.
  for (const suffix of ["-wal", "-shm", "-journal"]) rmSync(dbPath + suffix, { force: true });
  // Written next to it, synced and renamed, so an interrupted restore never leaves a half file that looks like a database.
  const partial = `${dbPath}.restoring`;
  try {
    const fd = openSync(partial, "w");
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Decrypting proves the bytes are the ones uploaded, not that they were a sound database when they were.
    const damage = checkDatabaseFile(partial);
    if (damage) {
      throw new Error(
        `${cfg.repo}/${cfg.path} generation ${generation} decrypted, but it is not a sound database (${damage}). Not starting from it: ` +
          "restore an earlier generation from the repository history.",
      );
    }
    renameSync(partial, dbPath);
  } catch (e) {
    rmSync(partial, { force: true });
    throw e;
  }
  return `restored ${dbPath} from ${cfg.repo}/${cfg.path}, generation ${generation} (${blob.length} bytes)`;
}

/**
 * Checks the copy the next start would restore, the way that start would, and changes nothing: no upload, no file
 * at DB_PATH, no generation. A restore tried with the live settings would instead write a database that its own
 * scheduler could upload, with a new generation, over the copy the running server keeps. Problems are lines that
 * start with "PROBLEM:"; a failure to read GitHub at all throws, because then nothing was checked.
 */
export async function verifyBackup(cfg: BackupConfig, store = new GithubStore(cfg)): Promise<{ ok: boolean; lines: string[] }> {
  const where = `${cfg.repo}/${cfg.path}`;
  const lines: string[] = [];
  let problems = 0;
  const problem = (text: string) => {
    problems++;
    lines.push(`PROBLEM: ${text}`);
  };
  const done = (generation?: number) => {
    lines.push(
      problems === 0 && generation !== undefined
        ? `OK: the next start would restore generation ${generation} from this copy.`
        : `NOT OK: ${problems} problem(s) above.`,
    );
    return { ok: problems === 0 && generation !== undefined, lines };
  };

  const blob = await store.download();
  const history = await store.history();
  const last = history.maxGeneration === null ? "" : `, up to generation ${history.maxGeneration}`;
  if (!blob) {
    if (history.commits === 0) problem(`there is no backup at ${where} yet`);
    else problem(`${where} is gone, but its history has ${history.commits} commit(s)${last}; the next start refuses to start empty`);
    return done();
  }
  let plain: { data: Buffer; generation: number };
  try {
    plain = decryptBlob(blob, cfg.key);
  } catch (e) {
    problem(`${where} (${blob.length} bytes): ${(e as Error).message}`);
    return done();
  }
  const { data, generation } = plain;
  lines.push(`copy: ${where}, generation ${generation}, ${blob.length} bytes`);
  lines.push(`history: ${history.commits} commit(s), highest generation ${history.maxGeneration ?? "none named"}`);
  lines.push("decrypt: ok");
  if (history.maxGeneration !== null && history.maxGeneration > generation) {
    problem(
      `the file holds generation ${generation}, but generation ${history.maxGeneration} was written later: the copy was rolled back, ` +
        "and the next start refuses it",
    );
  }

  const dir = mkdtempSync(join(tmpdir(), "moncsy-verify-"));
  try {
    const file = join(dir, "copy.db");
    writeFileSync(file, data);
    const damage = checkDatabaseFile(file);
    if (damage) {
      problem(damage.startsWith("integrity_check:") ? damage : `not a sound database: ${damage}`);
      return done();
    }
    lines.push("integrity_check: ok");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(
        (t) => t.name,
      );
      const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM "${t.replaceAll('"', '""')}"`).get() as { n: number }).n;
      lines.push(`rows: ${tables.map((t) => `${t} ${count(t)}`).join(", ") || "no tables"}`);
      // The restored database continues from the generation it records; without it, or with another one, its first upload stops.
      const meta = tables.includes("meta")
        ? new Map((db.prepare("SELECT key, value FROM meta WHERE key IN (?, ?)").all(META_GENERATION, META_AT) as { key: string; value: string }[]).map((r) => [r.key, r.value]))
        : new Map<string, string>();
      const recorded = meta.get(META_GENERATION);
      if (recorded === undefined) {
        problem("the copy does not record which generation it is (meta backup_generation), so the server restored from it would stop its backups");
      } else {
        lines.push(`made: ${meta.get(META_AT) ?? "unknown"}, recorded generation ${recorded}`);
        if (Number(recorded) !== generation) {
          problem(`the copy records generation ${recorded}, but the file says ${generation}, so the server restored from it would stop its backups`);
        }
      }
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return done(generation);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long a change may wait for a failing upload before writes are refused until one succeeds. */
const UNSAVED_LIMIT_MS = 5 * 60_000;

/** Uploads a consistent snapshot a few seconds after the database last changed, one upload at a time. */
export class BackupScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private savedChanges: number | null = null;
  /** when the oldest change not yet uploaded was announced; caps how long new writes can postpone the upload */
  private pendingSince: number | null = null;
  /** an upload whose outcome is unknown (the request failed); if it landed, it is this instance's own copy */
  private unconfirmed: { generation: number; at: string; blob: Buffer; changes: number } | null = null;
  /** the highest generation in the file's history; new generations go above it, also after an accepted reset */
  private historyMax = 0;
  private closed = false;
  private status: BackupStatus = { enabled: true, lastBackupAt: null, generation: null, lastError: null, pending: false, stopped: false };

  constructor(
    private readonly db: DB,
    private readonly cfg: BackupConfig,
    private readonly log: { info(msg: string): void; error(msg: string): void },
    private readonly store = new GithubStore(cfg),
  ) {}

  /** Reads which copy this database came from; call once before serving requests. */
  async init(): Promise<void> {
    const generation = await getMeta(this.db, META_GENERATION);
    this.status.generation = generation === null ? null : Number(generation);
    this.status.lastBackupAt = await getMeta(this.db, META_AT);
    // What is on disk now is either the restored copy or not worth a commit on its own (migrations, seeding).
    this.savedChanges = await this.totalChanges();
  }

  getStatus(): BackupStatus {
    return { ...this.status };
  }

  /**
   * Why a write has to be refused now, or null. A write would exist only on this disk, which a host without a persistent
   * disk wipes on restart: once uploads stopped that is true of every write, and while they fail, of the writes made after
   * a change has waited UNSAVED_LIMIT_MS, until an upload succeeds. Refusing keeps the loss to what the client still has.
   */
  refusal(): string | null {
    if (this.status.stopped) return `Changes are not saved: the backup has stopped (${this.status.lastError}). Reading and GET /api/export still work.`;
    if (this.status.lastError !== null && this.pendingSince !== null && Date.now() - this.pendingSince > UNSAVED_LIMIT_MS) {
      return (
        `Changes are not saved: the backup has failed for more than ${UNSAVED_LIMIT_MS / 60_000} minutes (${this.status.lastError}). ` +
        "Reading and GET /api/export still work, and writing works again after the next successful backup."
      );
    }
    return null;
  }

  private async totalChanges(db: DB = this.db): Promise<number> {
    return (await db.get<{ n: number }>("SELECT total_changes() AS n"))!.n;
  }

  private maxWaitMs(): number {
    return Math.max(60_000, 6 * this.cfg.debounceMs);
  }

  /** Called after an authorized request that may have written; uploads only when the change counter moved. */
  touch(): void {
    if (this.closed) return;
    const now = Date.now();
    this.pendingSince ??= now;
    this.status.pending = true;
    // Writes keep postponing the upload, but not past maxWaitMs from the first one.
    const wait = Math.max(0, Math.min(this.cfg.debounceMs, this.pendingSince + this.maxWaitMs() - now));
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), wait);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    while (this.running) await this.running;
    this.running = this.backup().finally(() => (this.running = null));
    await this.running;
  }

  /** Last upload before shutdown, retried a few times since nothing runs after it; then no timer fires again. */
  async close(): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await this.flush();
      if (!this.status.pending || this.status.stopped) break;
      if (attempt < 3) await sleep(1000 * attempt);
    }
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.status.pending) {
      this.log.error(
        `final backup did not complete; changes made after ${this.status.lastBackupAt ?? "the start"} exist only on this disk: ${this.status.lastError}`,
      );
    }
  }

  private stop(reason: string): void {
    this.status.stopped = true;
    this.status.lastError = reason;
    this.log.error(`backup stopped: ${reason}`);
  }

  /** Records an upload GitHub accepted, in the database and in the status. */
  private async recordUploaded(generation: number, at: string): Promise<number> {
    // Measured inside one transaction, so a write that lands meanwhile is not mistaken for these two.
    const delta = await this.db.tx(async (t) => {
      const before = await this.totalChanges(t);
      await setMeta(t, META_GENERATION, String(generation));
      await setMeta(t, META_AT, at);
      return (await this.totalChanges(t)) - before;
    });
    this.unconfirmed = null;
    this.status = { ...this.status, generation, lastBackupAt: at, lastError: null };
    return delta;
  }

  /** Before writing over a remote copy this instance has not seen, make sure it is the one this database came from. */
  private async remoteIsOurs(): Promise<boolean> {
    const blob = await this.store.download();
    this.historyMax = (await this.store.history()).maxGeneration ?? 0;
    if (!blob) return true;
    if (this.unconfirmed && blob.equals(this.unconfirmed.blob)) {
      // The upload whose response was lost did land: it is ours, so continue from it.
      const { generation, at, changes } = this.unconfirmed;
      this.savedChanges = changes + (await this.recordUploaded(generation, at));
      this.log.info(`backup ${generation} had reached ${this.cfg.repo}/${this.cfg.path} although its request failed`);
      return true;
    }
    this.unconfirmed = null;
    let remote: number;
    try {
      remote = decryptBlob(blob, this.cfg.key).generation;
    } catch (e) {
      this.stop(
        `${this.cfg.repo}/${this.cfg.path} cannot be read with this BACKUP_KEY (${(e as Error).message}). ` +
          "Not overwriting it: check BACKUP_KEY, or remove the remote file if it is really not needed.",
      );
      return false;
    }
    const base = this.status.generation;
    if (base === null) {
      this.stop(
        `${this.cfg.repo}/${this.cfg.path} already holds a backup (generation ${remote}), but this database was not restored from it. ` +
          "Not overwriting it. Delete the local database file and restart to restore it, or remove the remote file to start over.",
      );
      return false;
    }
    if (remote > base) {
      this.stop(
        `${this.cfg.repo}/${this.cfg.path} holds generation ${remote}, but this database came from generation ${base}: ` +
          "another instance wrote a newer copy. Not overwriting it. " +
          `The changes made on this instance since ${this.status.lastBackupAt ?? "the start"} are not in that copy: ` +
          "save them with GET /api/export before restarting, then restart the service to load it.",
      );
      return false;
    }
    if (remote < base) {
      // A restart would not help here: the newer data exists only on this disk.
      this.stop(
        `${this.cfg.repo}/${this.cfg.path} holds generation ${remote}, older than generation ${base} this database came from: ` +
          "the copy was rolled back. Not overwriting it. The newer data is only on this server's disk, so do not restart yet: " +
          "export it first (GET /api/export), or restore the newer generation from the repository history.",
      );
      return false;
    }
    return true;
  }

  private async backup(): Promise<void> {
    if (this.status.stopped || this.closed) return;
    if (this.savedChanges !== null && (await this.totalChanges()) === this.savedChanges) {
      this.status.pending = false;
      this.pendingSince = null;
      return;
    }
    this.status.pending = true;
    const tmp = join(tmpdir(), `moncsy-snapshot-${process.pid}-${Date.now()}.db`);
    try {
      if (!this.store.knowsRemote && !(await this.remoteIsOurs())) return;
      // Read again right before the snapshot: adopting an upload that did land may have covered everything.
      const changes = await this.totalChanges();
      if (changes === this.savedChanges) {
        this.status.pending = false;
        this.pendingSince = null;
        return;
      }
      const generation = Math.max(this.status.generation ?? 0, this.historyMax) + 1;
      const at = new Date().toISOString();
      // VACUUM INTO writes a consistent copy without blocking readers for long.
      await this.db.run("VACUUM INTO ?", [tmp]);
      // The copy records its own generation, so a database restored from it knows which copy it came from.
      const snapshot = new DatabaseSync(tmp);
      try {
        const put = snapshot.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
        put.run(META_GENERATION, String(generation));
        put.run(META_AT, at);
      } finally {
        snapshot.close();
      }
      const blob = encryptBlob(readFileSync(tmp), this.cfg.key, generation);
      this.unconfirmed = { generation, at, blob, changes };
      await this.store.upload(blob, `backup ${generation} ${at}`);
      // `changes` was read before the snapshot: a write made during the upload keeps the counter ahead of this,
      // so it is uploaded next time instead of being taken as saved.
      this.savedChanges = changes + (await this.recordUploaded(generation, at));
      if ((await this.totalChanges()) === this.savedChanges) {
        this.status.pending = false;
        this.pendingSince = null;
      }
      this.log.info(`backup ${generation} uploaded to ${this.cfg.repo}/${this.cfg.path} (${blob.length} bytes)`);
    } catch (e) {
      if (e instanceof GithubError && e.lasting) {
        this.stop(
          `${e.message}. Retrying cannot fix this: the token expired, was revoked or lost access to ${this.cfg.repo}. ` +
            `Before restarting, save the changes made since ${this.status.lastBackupAt ?? "the start"} with GET /api/export, ` +
            "then set a working BACKUP_GITHUB_TOKEN and restart.",
        );
        return;
      }
      this.status.lastError = (e as Error).message;
      this.log.error(`backup failed, will retry: ${(e as Error).message}`);
      // Retry later even if nothing else is written. A failed upload leaves the remote unknown, so the retry reads it
      // first: it adopts an upload that did land, and stops if another instance wrote the copy.
      if (!this.closed) this.timer = setTimeout(() => void this.flush(), Math.max(60_000, this.cfg.debounceMs));
    } finally {
      rmSync(tmp, { force: true });
    }
  }
}
