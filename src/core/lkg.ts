/**
 * Last-known-good (LKG) store: a small on-disk copy of recent successful
 * upstream responses, so stale-if-error still works after a restart or deploy.
 *
 * The in-memory cache (core/http.ts) is lost whenever the process restarts.
 * Without this store, a source that is down at that moment produces errors
 * until it recovers, even though a perfectly usable answer was fetched
 * minutes earlier. The LKG store is read ONLY when a fetch fails transiently
 * and memory has nothing usable; fresh data always wins.
 *
 * Enabled only when SWISSYPHUS_LKG_DIR is set (the Docker image sets it to
 * /app/data/lkg). Local npx/stdio use writes nothing to disk by default.
 *
 * - One file per cache key, named sha256(key). The key itself (which contains
 *   the upstream URL and therefore the query text) is not written; reads
 *   verify a hash of it instead.
 * - Requests carrying credentials (Authorization/Cookie headers) are never
 *   persisted: the caller enforces that.
 * - Bounded: total bytes (SWISSYPHUS_LKG_MAX_BYTES, default 64 MiB), per-entry
 *   size (2 MiB), and age (each entry's own max-stale window; expired files
 *   are deleted on read and on the periodic sweep).
 * - Writes are atomic (tmp + rename) and fire-and-forget; any disk error just
 *   disables the store for that write. The store is an optimisation, never a
 *   dependency.
 *
 * Tunables (environment):
 *   SWISSYPHUS_LKG_DIR        directory for the store (unset = disabled)
 *   SWISSYPHUS_LKG_MAX_BYTES  total byte budget (default 64 MiB)
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface LkgRecord {
  body: string;
  storedAt: number;
  ttlMs: number;
  /** Absolute serving limit: the record is useless after storedAt + maxStaleMs. */
  maxStaleMs: number;
}

interface StoredFile extends LkgRecord {
  v: 1;
  /** sha256 of the cache key, as a collision/tamper check. */
  k: string;
}

interface IndexEntry {
  size: number;
  expiresAt: number;
}

export const LKG_MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const SWEEP_INTERVAL_MS = 10 * 60_000;

let dir: string | undefined;
let maxBytes = 64 * 1024 * 1024;
/** file name → size/expiry; Map order approximates write order (oldest first). */
const index = new Map<string, IndexEntry>();
let totalBytes = 0;
let sweepTimer: NodeJS.Timeout | undefined;
let warned = false;
const pending = new Set<Promise<void>>();

function warnOnce(what: string, err: unknown): void {
  if (warned) return;
  warned = true;
  console.error(`[lkg] ${what}: ${err instanceof Error ? err.message : String(err)} (further LKG errors are silent)`);
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function fileFor(name: string): string {
  return join(dir as string, `${name}.json`);
}

function forget(name: string): void {
  const e = index.get(name);
  if (!e) return;
  index.delete(name);
  totalBytes -= e.size;
}

function remove(name: string): void {
  forget(name);
  void unlink(fileFor(name)).catch(() => undefined);
}

function enforceBudget(): void {
  while (totalBytes > maxBytes && index.size > 0) {
    const oldest = index.keys().next().value;
    if (oldest === undefined) break;
    remove(oldest);
  }
}

function sweep(): void {
  const now = Date.now();
  for (const [name, e] of index) if (e.expiresAt <= now) remove(name);
}

/**
 * Enable (or disable, with `undefined`) the store. Scans the directory once to
 * rebuild the size index; expiry of pre-existing files is learned on first read
 * or approximated from mtime + 30 days for the budget sweep.
 */
export function configureLkg(directory: string | undefined, budgetBytes?: number): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = undefined;
  index.clear();
  totalBytes = 0;
  warned = false;
  dir = undefined;
  if (budgetBytes !== undefined && budgetBytes > 0) maxBytes = budgetBytes;
  if (!directory) return;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const files = readdirSync(directory)
      .filter((f) => /^[0-9a-f]{64}\.json$/.test(f))
      .map((f) => {
        const st = statSync(join(directory, f));
        return { name: f.slice(0, -5), size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime);
    for (const f of files) {
      index.set(f.name, { size: f.size, expiresAt: f.mtime + 30 * 86_400_000 });
      totalBytes += f.size;
    }
    dir = directory;
    enforceBudget();
    sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
    sweepTimer.unref();
  } catch (err) {
    warnOnce(`disabled, cannot use ${directory}`, err);
    dir = undefined;
  }
}

export function lkgEnabled(): boolean {
  return dir !== undefined;
}

/**
 * Persist a successful response (fire-and-forget). `maxEntryBytes` raises the
 * per-entry cap for a deliberate, single large snapshot (e.g. a parsed index);
 * the total budget still applies.
 */
export function lkgPut(key: string, record: LkgRecord, opts: { maxEntryBytes?: number } = {}): void {
  if (!dir) return;
  if (Buffer.byteLength(record.body) > (opts.maxEntryBytes ?? LKG_MAX_ENTRY_BYTES)) return;
  const k = hashKey(key);
  const name = hashKey(`file:${key}`);
  const payload = JSON.stringify({ v: 1, k, ...record } satisfies StoredFile);
  const size = Buffer.byteLength(payload);
  const target = fileFor(name);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  forget(name);
  index.set(name, { size, expiresAt: record.storedAt + record.maxStaleMs });
  totalBytes += size;
  enforceBudget();
  const p: Promise<void> = writeFile(tmp, payload, { mode: 0o600 })
    .then(() => rename(tmp, target))
    .catch((err) => {
      forget(name);
      void unlink(tmp).catch(() => undefined);
      warnOnce("write failed", err);
    })
    .finally(() => pending.delete(p));
  pending.add(p);
}

/** Read a record for `key`, or undefined if absent, expired or unreadable. */
export async function lkgGet(key: string, now = Date.now()): Promise<LkgRecord | undefined> {
  if (!dir) return undefined;
  const name = hashKey(`file:${key}`);
  if (!index.has(name)) return undefined;
  try {
    const parsed = JSON.parse(await readFile(fileFor(name), "utf8")) as Partial<StoredFile>;
    if (
      parsed.v !== 1 ||
      parsed.k !== hashKey(key) ||
      typeof parsed.body !== "string" ||
      typeof parsed.storedAt !== "number" ||
      typeof parsed.ttlMs !== "number" ||
      typeof parsed.maxStaleMs !== "number"
    ) {
      remove(name);
      return undefined;
    }
    if (now - parsed.storedAt >= parsed.maxStaleMs) {
      remove(name);
      return undefined;
    }
    return { body: parsed.body, storedAt: parsed.storedAt, ttlMs: parsed.ttlMs, maxStaleMs: parsed.maxStaleMs };
  } catch {
    remove(name);
    return undefined;
  }
}

/** Statistics for health/metrics. */
export function getLkgStats(): { enabled: boolean; entries: number; bytes: number; maxBytes: number } {
  return { enabled: dir !== undefined, entries: index.size, bytes: totalBytes, maxBytes };
}

/** Wait for pending fire-and-forget writes to settle (shutdown, tests). */
export async function lkgFlush(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}
