/**
 * API key store with tiered quotas and usage metering.
 *
 * Onboarding phase: metering is ON, billing is OFF. Free keys are
 * self-service; pro/enterprise are granted via admin endpoints. Keys and
 * monthly usage persist to a JSON file (single-instance friendly; move to
 * Redis/Postgres when a second instance is needed).
 *
 * Keys are stored as SHA-256 hashes, never in plaintext — the raw key is
 * returned to the caller once, at creation time, and is not recoverable
 * afterwards (nFADP Art. 8 / VDSG security-of-processing baseline).
 */

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

  constructor(dataDir?: string) {
    const dir = dataDir ?? process.env["SWISSYPHUS_DATA_DIR"] ?? join(process.cwd(), "data");
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "keys.json");
    const retentionDays = Number(process.env["SWISSYPHUS_REVOKED_RETENTION_DAYS"] ?? DEFAULT_REVOKED_RETENTION_DAYS);
    this.revokedRetentionMs = (Number.isFinite(retentionDays) ? retentionDays : DEFAULT_REVOKED_RETENTION_DAYS) * 86_400_000;
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, "utf-8")) as StoreFile;
        for (const k of parsed.keys ?? []) this.keys.set(k.hash, k);
      } catch {
        console.error(`[keys] could not parse ${this.file}; starting with an empty key store`);
      }
    }
    // Flush metered usage periodically without keeping the process alive.
    const flushTimer = setInterval(() => this.flushUsage(), 30_000);
    flushTimer.unref();
    // Permanently purge revoked keys past the retention window (data-minimization / erasure).
    const purgeTimer = setInterval(() => this.purgeExpiredRevocations(), 6 * 3600_000);
    purgeTimer.unref();
    this.purgeExpiredRevocations();
    process.once("SIGTERM", () => this.flushUsage());
    process.once("SIGINT", () => this.flushUsage());
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify({ keys: [...this.keys.values()] }, null, 2));
    this.usageDirty = false;
  }

  flushUsage(): void {
    if (this.usageDirty) this.persist();
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

  /** Returns the raw key once — it is never stored or retrievable again. */
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
    this.persist();
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

  /** Count one request against the key's monthly quota. Returns quota state. */
  meter(record: ApiKeyRecord): { withinQuota: boolean; used: number; quota: number } {
    const m = monthKey();
    record.usage[m] = (record.usage[m] ?? 0) + 1;
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
