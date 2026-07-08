/**
 * Outbound HTTP layer.
 *
 * - SSRF protection: only allowlisted Swiss source hosts may be contacted (RFP §9).
 * - In-memory TTL cache with stale-while-revalidate (RFP §6.2).
 * - Timeouts and a single retry with backoff.
 * - Every result carries cache_status + retrieved_at for the envelope.
 */

import type { CacheStatus, FetchResult } from "./types.js";

const USER_AGENT = "swissyphus/0.1.0 (MCP server; https://github.com/swissyphus)";

/** Hosts Swissyphus is allowed to contact. Anything else is refused. */
const ALLOWED_HOSTS = new Set<string>([
  "www.zefix.admin.ch",
  "amtsblattportal.ch",
  "www.amtsblattportal.ch",
  "transport.opendata.ch",
  "app-prod-ws.meteoswiss-app.ch",
  "data.geo.admin.ch",
  "api3.geo.admin.ch",
  "www.hydrodaten.admin.ch",
  "api.existenz.ch",
  "aws.slf.ch",
  "measurement-api.slf.ch",
  "arclink.ethz.ch",
  "data.snb.ch",
  "openholidaysapi.org",
  "fedlex.data.admin.ch",
  "ckan.opendata.swiss",
  "opendata.swiss",
  "ws.parlament.ch",
  "www.alert.swiss",
  "ogd-static.voteinfo-app.ch",
  "madd.bfs.admin.ch",
  "www.srf.ch",
  "lindas.admin.ch",
  "www.pxweb.bfs.admin.ch",
  "openerz.metaodi.ch",
]);

interface CacheEntry {
  body: string;
  storedAt: number;
  ttlMs: number;
}

const cache = new Map<string, CacheEntry>();
const inflightRevalidations = new Set<string>();

/** How many multiples of the TTL a stale entry may still be served while revalidating. */
const STALE_FACTOR = 6;

/**
 * Hard cap on cached entries. A long-running HTTP server hits many distinct
 * URLs (every PLZ, station query, geocode); without a bound the cache grows
 * forever. The Map preserves insertion order, so evicting the first key drops
 * the oldest entry (approximate LRU — good enough for a fetch cache).
 */
const MAX_CACHE_ENTRIES = 5_000;

function cacheSet(key: string, entry: CacheEntry): void {
  cache.set(key, entry);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export class SourceError extends Error {
  constructor(
    message: string,
    public readonly sourceHost: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

function assertAllowed(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new SourceError(`Refusing non-HTTP(S) URL: ${url}`, parsed.hostname);
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new SourceError(
      `Host '${parsed.hostname}' is not in the Swissyphus source allowlist (SSRF protection).`,
      parsed.hostname,
    );
  }
  return parsed;
}

async function rawFetch(url: string, init: RequestInit, timeoutMs: number): Promise<string> {
  const parsed = assertAllowed(url);
  const attempt = async (): Promise<string> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...init,
        headers: { "User-Agent": USER_AGENT, ...(init.headers ?? {}) },
        signal: controller.signal,
        redirect: "follow",
      });
      if (!res.ok) {
        throw new SourceError(
          `Source '${parsed.hostname}' responded with HTTP ${res.status}.`,
          parsed.hostname,
          res.status,
        );
      }
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    return await attempt();
  } catch (err) {
    // One retry on transient failures (network error, 5xx, timeout).
    const status = err instanceof SourceError ? err.status : undefined;
    const retryable = status === undefined || status >= 500 || status === 429;
    if (!retryable) throw err;
    await new Promise((r) => setTimeout(r, 600));
    return attempt();
  }
}

interface FetchOptions {
  ttlMs?: number;
  timeoutMs?: number;
  init?: RequestInit;
}

/**
 * Fetch a URL with caching. Cache key includes method + body so POST search
 * queries are cached independently.
 */
export async function fetchCached(url: string, opts: FetchOptions = {}): Promise<FetchResult<string>> {
  const { ttlMs = 5 * 60_000, timeoutMs = 15_000, init = {} } = opts;
  const key = `${init.method ?? "GET"} ${url} ${typeof init.body === "string" ? init.body : ""}`;
  const now = Date.now();
  const entry = cache.get(key);

  if (entry) {
    const age = now - entry.storedAt;
    if (age < entry.ttlMs) {
      return { data: entry.body, cacheStatus: "hit", retrievedAt: new Date(entry.storedAt).toISOString() };
    }
    if (age < entry.ttlMs * STALE_FACTOR) {
      // Serve stale, revalidate in the background.
      if (!inflightRevalidations.has(key)) {
        inflightRevalidations.add(key);
        void rawFetch(url, init, timeoutMs)
          .then((body) => cacheSet(key, { body, storedAt: Date.now(), ttlMs: entry.ttlMs }))
          .catch(() => undefined)
          .finally(() => inflightRevalidations.delete(key));
      }
      return { data: entry.body, cacheStatus: "stale", retrievedAt: new Date(entry.storedAt).toISOString() };
    }
    // Past the stale window: drop the dead entry before refetching so it can't
    // linger in the map if this key is never requested again.
    cache.delete(key);
  }

  const body = await rawFetch(url, init, timeoutMs);
  cacheSet(key, { body, storedAt: Date.now(), ttlMs });
  return { data: body, cacheStatus: "miss", retrievedAt: new Date().toISOString() };
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<FetchResult<T>> {
  const headers = { Accept: "application/json", ...(opts.init?.headers ?? {}) };
  const result = await fetchCached(url, { ...opts, init: { ...opts.init, headers } });
  let data: T;
  try {
    data = JSON.parse(result.data) as T;
  } catch {
    const host = new URL(url).hostname;
    throw new SourceError(`Source '${host}' returned a non-JSON response (possibly down or changed format).`, host);
  }
  return { data, cacheStatus: result.cacheStatus, retrievedAt: result.retrievedAt };
}

export async function fetchTextCached(url: string, opts: FetchOptions = {}): Promise<FetchResult<string>> {
  return fetchCached(url, opts);
}

/** Build a URL with query params, skipping undefined values. */
export function withParams(base: string, params: Record<string, string | number | boolean | undefined>): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

export type CacheStatusOf = CacheStatus;
