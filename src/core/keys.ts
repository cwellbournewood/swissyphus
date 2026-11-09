/**
 * API key store with tiered quotas and usage metering.
 *
 * Metering is ON, billing is OFF. Free keys are
 * self-service; pro/enterprise are granted via admin endpoints. Keys and
 * monthly usage persist to a JSON file (single-instance friendly; move to
 * Redis/Postgres when a second instance is needed).
 *
 * Keys are stored as SHA-256 hashes, never in plaintext; the raw key is
 * returned to the caller once, at creation time, and is not recoverable
 * afterwards (nFADP Art. 8 / VDSG security-of-processing baseline).
 *
 * Durability: every write goes to `keys.json.tmp`, is fsync'd, then atomically
 * renamed over `keys.json`, so a crash or full disk mid-write can never leave
 * a truncated store behind. If `keys.json` cannot be parsed at startup the
 * store refuses to start: the bad file is moved aside to
 * `keys.json.corrupt-<timestamp>` and the constructor throws; it never
 * silently continues with an empty store that the next write would persist
 * over the operator's keys.
 *
 * The store installs no signal handlers; the HTTP server owns process
 * shutdown and calls `close()` (which flushes usage) while draining.
 */

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type Tier = "free" | "pro" | "enterprise";

export interface TierLimits {
  perMinute: number;
  /** 0 = unlimited */
  perMonth: number;
}

export const TIER_LIMITS: Record<Tier, TierLimits> = {
  free: { perMinute: 240, perMonth: 50_000 },
  pro: { perMinute: 1000, perMonth: 1_000_000 },
  enterprise: { perMinute: 0, perMonth: 0 },
};

export const ANONYMOUS_PER_MINUTE = 60;

/** Days a revoked/erased-pending key record is kept before permanent purge. */
export const DEFAULT_REVOKED_RETENTION_DAYS = 30;

export interface ApiKeyRecord {
  /** SHA-256 hex digest of the raw key. The raw key itself is never stored. */
  hash: string;
  /** Last 4 chars of the raw key, for display only (e.g. admin listings). */
  last4: string;
  email: string;
  tier: Tier;
  created: string;
  /** ISO timestamp of revocation; undefined = active. */
  revokedAt?: string;
  /** month (YYYY-MM) → request count */
  usage: Record<string, number>;
}

interface StoreFile {
  keys: ApiKeyRecord[];
}

function monthKey(): string {
  return new Date().toISOString().slice(0, 7);
}

export function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

/** Constant-time string comparison, immune to both content and length timing leaks. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = createHash("sha256").update(a).digest();
  const bufB = createHash("sha256").update(b).digest();
  return timingSafeEqual(bufA, bufB);
}

export class KeyStore {
  private keys = new Map<string, ApiKeyRecord>();
  private readonly file: string;
  private readonly revokedRetentionMs: number;
  private usageDirty = false;
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(dataDir?: string) {
    const dir = dataDir ?? process.env["SWISSYPHUS_DATA_DIR"] ?? join(process.cwd(), "data");
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "keys.json");
    const retentionDays = Number(process.env["SWISSYPHUS_REVOKED_RETENTION_DAYS"] ?? DEFAULT_REVOKED_RETENTION_DAYS);
    this.revokedRetentionMs = (Number.isFinite(retentionDays) ? retentionDays : DEFAULT_REVOKED_RETENTION_DAYS) * 86_400_000;
    if (existsSync(this.file)) this.load();
    else this.refuseIfUnresolvedCorruption(dir);
    // Flush metered usage periodically without keeping the process alive.
    // Background writes must never crash the process (e.g. ENOSPC/EACCES): log and
    // retry on the next tick; usage stays dirty in memory until a write succeeds.
    const safely = (what: string, fn: () => unknown) => () => {
      try {
        fn();
      } catch (err) {
        console.error(`[keys] ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    const flushTimer = setInterval(safely("usage flush", () => this.flushUsage()), 30_000);
    flushTimer.unref();
    // Permanently purge revoked keys past the retention window (data-minimization / erasure).
    const purgeTimer = setInterval(safely("revocation purge", () => this.purgeExpiredRevocations()), 6 * 3600_000);
    purgeTimer.unref();
    this.timers.push(flushTimer, purgeTimer);
    this.purgeExpiredRevocations();
  }

  /**
   * keys.json is absent but an earlier start moved a corrupt store aside: keep
   * refusing (e.g. across a Docker `restart: unless-stopped` loop) until the
   * operator restores keys.json or deletes the .corrupt file on purpose,
   * otherwise the restart would silently come up with an empty store.
   */
  private refuseIfUnresolvedCorruption(dir: string): void {
    const leftovers = readdirSync(dir).filter((f) => f.startsWith("keys.json.corrupt-"));
    if (!leftovers.length) return;
    throw new Error(
      `[keys] keys.json is missing but ${leftovers.join(", ")} exists in ${dir}. ` +
        "Refusing to start with an empty key store. Restore keys.json from a backup (or repair the " +
        ".corrupt file into keys.json) and restart; to deliberately start with no keys, delete the .corrupt file(s).",
    );
  }

  /** Load keys.json. On any parse/shape error: move it aside and refuse to start. */
  private load(): void {
    let parsed: StoreFile;
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf-8")) as StoreFile;
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.keys)) {
        throw new Error("missing 'keys' array");
      }
      for (const k of parsed.keys) {
        if (!k || typeof k.hash !== "string" || !/^[0-9a-f]{64}$/.test(k.hash)) {
          throw new Error("found a key record without a valid hash");
        }
      }
    } catch (err) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const aside = `${this.file}.corrupt-${stamp}`;
      let moved = false;
      try {
        renameSync(this.file, aside);
        moved = true;
      } catch {
        /* leave it in place; we refuse to start either way */
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[keys] ${this.file} is corrupt (${reason}). ` +
          (moved ? `It was moved to ${aside}. ` : "It could not be moved aside. ") +
          "Refusing to start with an empty key store, which would overwrite every issued key. " +
          "Restore keys.json from a backup (or repair the .corrupt file) and restart; " +
          "to deliberately start with no keys, leave keys.json absent.",
      );
    }
    for (const k of parsed.keys) {
      k.usage ??= {};
      this.keys.set(k.hash, k);
    }
  }

  /** Atomic persist: write keys.json.tmp, fsync, rename over keys.json. */
  private persist(): void {
    const tmp = `${this.file}.tmp`;
    const data = JSON.stringify({ keys: [...this.keys.values()] }, null, 2);
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.file);
    // Best effort: fsync the directory so the rename itself survives a power loss.
    try {
      const dirFd = openSync(dirname(this.file), "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      /* not supported on every platform/filesystem */
    }
    this.usageDirty = false;
  }

  flushUsage(): void {
    if (this.usageDirty) this.persist();
  }

  /** Stop background timers and flush pending usage (shutdown path; also used by tests). */
  close(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    this.flushUsage();
  }

  /** Permanently delete revoked records older than the retention window. */
  purgeExpiredRevocations(): number {
    const now = Date.now();
    let removed = 0;
    for (const [hash, record] of this.keys) {
      if (record.revokedAt && now - Date.parse(record.revokedAt) > this.revokedRetentionMs) {
        this.keys.delete(hash);
        removed++;
      }
    }
    if (removed > 0) this.persist();
    return removed;
  }

  /** Returns the raw key once; it is never stored or retrievable again. */
  create(email: string, tier: Tier = "free"): { record: ApiKeyRecord; rawKey: string } {
    const rawKey = `sy_live_${randomBytes(24).toString("hex")}`;
    const record: ApiKeyRecord = {
      hash: hashKey(rawKey),
      last4: rawKey.slice(-4),
      email: email.trim().toLowerCase(),
      tier,
      created: new Date().toISOString(),
      usage: {},
    };
    this.keys.set(record.hash, record);
    try {
      this.persist();
    } catch (err) {
      // Don't leave an orphan record (the caller never received the raw key) for the next flush to write.
      this.keys.delete(record.hash);
      throw err;
    }
    return { record, rawKey };
  }

  get(rawKey: string): ApiKeyRecord | undefined {
    const r = this.keys.get(hashKey(rawKey));
    return r && !r.revokedAt ? r : undefined;
  }

  findByEmail(email: string): ApiKeyRecord[] {
    const e = email.trim().toLowerCase();
    return [...this.keys.values()].filter((k) => k.email === e && !k.revokedAt);
  }

  setTier(rawKey: string, tier: Tier): ApiKeyRecord | undefined {
    const r = this.keys.get(hashKey(rawKey));
    if (!r) return undefined;
    r.tier = tier;
    this.persist();
    return r;
  }

  /** Soft-revoke: disables the key immediately; record is purged after the retention window. */
  revoke(rawKey: string): boolean {
    const r = this.keys.get(hashKey(rawKey));
    if (!r) return false;
    r.revokedAt = new Date().toISOString();
    this.persist();
    return true;
  }

  /** Hard delete: immediate, permanent erasure of the key record (data-subject erasure request). */
  erase(rawKey: string): boolean {
    const deleted = this.keys.delete(hashKey(rawKey));
    if (deleted) this.persist();
    return deleted;
  }

  /** Hard delete of every active/revoked key for an email address. Returns count removed. */
  eraseByEmail(email: string): number {
    const e = email.trim().toLowerCase();
    let removed = 0;
    for (const [hash, record] of this.keys) {
      if (record.email === e) {
        this.keys.delete(hash);
        removed++;
      }
    }
    if (removed > 0) this.persist();
    return removed;
  }

  /** Count `count` requests (default 1) against the key's monthly quota. Returns quota state. */
  meter(record: ApiKeyRecord, count = 1): { withinQuota: boolean; used: number; quota: number } {
    const m = monthKey();
    record.usage[m] = (record.usage[m] ?? 0) + count;
    this.usageDirty = true;
    const quota = TIER_LIMITS[record.tier].perMonth;
    const used = record.usage[m];
    return { withinQuota: quota === 0 || used <= quota, used, quota };
  }

  usageOf(record: ApiKeyRecord): { month: string; used: number; quota: number; per_minute_limit: number | "unlimited" } {
    const m = monthKey();
    const limits = TIER_LIMITS[record.tier];
    return {
      month: m,
      used: record.usage[m] ?? 0,
      quota: limits.perMonth,
      per_minute_limit: limits.perMinute === 0 ? "unlimited" : limits.perMinute,
    };
  }

  list(): Array<Omit<ApiKeyRecord, "hash"> & { key_preview: string }> {
    return [...this.keys.values()].map(({ hash: _hash, ...k }) => ({
      key_preview: `sy_live_…${k.last4}`,
      ...k,
    }));
  }
}
