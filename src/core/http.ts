/**
 * Outbound HTTP layer.
 *
 * - SSRF protection: only allowlisted Swiss source hosts may be contacted (RFP §9).
 * - In-memory TTL cache with stale-while-revalidate (RFP §6.2).
 * - Timeouts and a single retry with backoff.
 * - Every result carries cache_status + retrieved_at for the envelope.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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

/**
 * Host suffixes that are allowlisted wholesale. Only multi-tenant SaaS domains
 * that exclusively host public open-data portals belong here (e.g. every
 * `*.opendatasoft.com` tenant is an Opendatasoft open-data portal).
 */
const ALLOWED_SUFFIXES = new Set<string>([".opendatasoft.com"]);

/**
 * Register additional allowlisted hosts. Each connector module calls this at
 * load time for the hosts it talks to, so adding a source never requires
 * editing this file (and parallel connector work never conflicts here).
 */
export function allowHosts(...hosts: string[]): void {
  for (const h of hosts) ALLOWED_HOSTS.add(h.toLowerCase());
}

/** True if a hostname is on the static/registered allowlist. */
export function isAllowedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (ALLOWED_HOSTS.has(h)) return true;
  for (const suf of ALLOWED_SUFFIXES) if (h.endsWith(suf)) return true;
  return false;
}

/** Default ceiling on a single upstream response body (bytes). */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

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
  if (!isAllowedHost(parsed.hostname)) {
    throw new SourceError(
      `Host '${parsed.hostname}' is not in the Swissyphus source allowlist (SSRF protection).`,
      parsed.hostname,
    );
  }
  return parsed;
}

/** Read a response body as text, aborting once it exceeds `maxBytes`. */
async function readCapped(res: Response, host: string, maxBytes: number, controller: AbortController): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    controller.abort();
    throw new TooLargeError(host, declared, maxBytes);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      controller.abort();
      throw new TooLargeError(host, total, maxBytes);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  // Swiss CSV exports are still sometimes Latin-1/Windows-1252: fall back
  // when the bytes are not valid UTF-8.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("windows-1252").decode(buf);
  }
}

/** Upstream body exceeded the configured size ceiling. Not retryable. */
export class TooLargeError extends Error {
  constructor(
    public readonly sourceHost: string,
    public readonly bytes: number,
    public readonly maxBytes: number,
  ) {
    super(
      `Resource on '${sourceHost}' is too large (${Math.round(bytes / 1024)} KB > ${Math.round(maxBytes / 1024)} KB limit).`,
    );
    this.name = "TooLargeError";
  }
}

async function rawFetch(url: string, init: RequestInit, timeoutMs: number, maxBytes = DEFAULT_MAX_BYTES): Promise<string> {
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
      return await readCapped(res, parsed.hostname, maxBytes, controller);
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    return await attempt();
  } catch (err) {
    if (err instanceof TooLargeError) throw err;
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
  /** Abort and throw TooLargeError past this many bytes (default 8 MB). */
  maxBytes?: number;
}

/**
 * Fetch a URL with caching. Cache key includes method + body so POST search
 * queries are cached independently.
 */
export async function fetchCached(url: string, opts: FetchOptions = {}): Promise<FetchResult<string>> {
  const { ttlMs = 5 * 60_000, timeoutMs = 15_000, init = {}, maxBytes } = opts;
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
        void rawFetch(url, init, timeoutMs, maxBytes)
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

  const body = await rawFetch(url, init, timeoutMs, maxBytes);
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

// ── Dynamic (catalogue-derived) hosts ────────────────────────────────────
//
// Catalogue adapters (opendata.swiss resources, …) must fetch files from
// thousands of publisher hosts that cannot be enumerated in advance. Instead
// of opening the allowlist, such fetches go through fetchPublicResource(),
// which (1) only accepts https URLs on standard ports, (2) resolves the host
// and refuses any private, loopback, link-local, CGNAT or otherwise
// non-public address, and (3) follows redirects manually, re-checking every
// hop, so a public URL cannot bounce the server into an internal network.

/** True if an IPv4/IPv6 literal is in a non-public range. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1") return true;
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x);
  }
  return true; // not an IP at all → treat as unsafe
}

async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SourceError(`Invalid resource URL: ${raw}`, "invalid");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new SourceError(`Refusing non-HTTP(S) resource URL: ${raw}`, u.hostname);
  }
  if (u.port && u.port !== "443" && u.port !== "80") {
    throw new SourceError(`Refusing non-standard port ${u.port} on ${u.hostname}.`, u.hostname);
  }
  if (u.username || u.password) {
    throw new SourceError("Refusing resource URL with embedded credentials.", u.hostname);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/(^|\.)(localhost|local|internal|intranet|lan)$/i.test(host)) {
    throw new SourceError(`Refusing internal hostname '${host}'.`, host);
  }
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new SourceError(`Could not resolve '${host}'.`, host);
  if (addrs.some((a) => isPrivateAddress(a.address))) {
    throw new SourceError(`Refusing '${host}': resolves to a non-public address (SSRF protection).`, host);
  }
  return u;
}

/**
 * Fetch a public open-data resource from a host that is not on the static
 * allowlist (catalogue-derived URL). Cached like fetchCached. Size-capped.
 */
export async function fetchPublicResource(
  url: string,
  opts: { ttlMs?: number; timeoutMs?: number; maxBytes?: number } = {},
): Promise<FetchResult<string> & { finalUrl: string; contentType?: string }> {
  const { ttlMs = 3600_000, timeoutMs = 30_000, maxBytes = DEFAULT_MAX_BYTES } = opts;
  const key = `PUBLIC ${url}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.storedAt < hit.ttlMs) {
    const meta = JSON.parse(hit.body) as { body: string; finalUrl: string; contentType?: string };
    return { data: meta.body, finalUrl: meta.finalUrl, contentType: meta.contentType, cacheStatus: "hit", retrievedAt: new Date(hit.storedAt).toISOString() };
  }
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const u = await assertPublicUrl(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(u, {
        headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
        signal: controller.signal,
        redirect: "manual",
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw new SourceError(`Redirect without Location from ${u.hostname}.`, u.hostname, res.status);
        current = new URL(loc, u).toString();
        continue;
      }
      if (!res.ok) {
        throw new SourceError(`Resource host '${u.hostname}' responded with HTTP ${res.status}.`, u.hostname, res.status);
      }
      const body = await readCapped(res, u.hostname, maxBytes, controller);
      const contentType = res.headers.get("content-type") ?? undefined;
      cacheSet(key, { body: JSON.stringify({ body, finalUrl: current, contentType }), storedAt: Date.now(), ttlMs });
      return { data: body, finalUrl: current, contentType, cacheStatus: "miss", retrievedAt: new Date().toISOString() };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new SourceError(`Too many redirects fetching ${url}.`, new URL(url).hostname);
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
