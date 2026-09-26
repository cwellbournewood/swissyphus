/**
 * Outbound HTTP layer.
 *
 * - SSRF protection: only allowlisted Swiss source hosts may be contacted (RFP §9).
 * - In-memory TTL cache with stale-while-revalidate (RFP §6.2).
 * - Timeouts and a single retry with backoff.
 * - Every result carries cache_status + retrieved_at for the envelope.
 */

import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
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

/**
 * Byte budget for the whole cache (UTF-16 string length × 2 ≈ heap bytes).
 * Catalogue adapters cache multi-MB open-data files, so an entry-count cap
 * alone could pin gigabytes. Override with SWISSYPHUS_CACHE_MB.
 */
const MAX_CACHE_BYTES = (Number(process.env.SWISSYPHUS_CACHE_MB) || 256) * 1024 * 1024;
let cacheBytes = 0;

const entryBytes = (key: string, e: CacheEntry) => (key.length + e.body.length) * 2;

function cacheDelete(key: string): void {
  const e = cache.get(key);
  if (e) {
    cacheBytes -= entryBytes(key, e);
    cache.delete(key);
  }
}

function cacheSet(key: string, entry: CacheEntry): void {
  const size = entryBytes(key, entry);
  // Never let one giant body evict the whole cache.
  if (size > MAX_CACHE_BYTES / 4) return;
  cacheDelete(key);
  cache.set(key, entry);
  cacheBytes += size;
  while (cache.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cacheDelete(oldest);
  }
}

/** Current cache footprint (for health/metrics and tests). */
export function cacheStats(): { entries: number; bytes: number; maxBytes: number } {
  return { entries: cache.size, bytes: cacheBytes, maxBytes: MAX_CACHE_BYTES };
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

const MAX_REDIRECTS = 5;

/** Read at most `max` bytes of a body (for error excerpts), then stop. */
async function readExcerpt(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    /* partial excerpt is fine */
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const buf = new Uint8Array(Math.min(total, max));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, buf.byteLength - off);
    if (take <= 0) break;
    buf.set(c.subarray(0, take), off);
    off += take;
  }
  return new TextDecoder("utf-8").decode(buf);
}

/** Linear-time tag strip + whitespace collapse, capped at 400 chars. */
export function errorExcerpt(text: string): string {
  // `[^<>]*` (not `[^>]+`) keeps this linear on inputs like "<<<<<<…".
  return text.replace(/<[^<>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
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

async function rawFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  maxBytes = DEFAULT_MAX_BYTES,
  retries = 1,
): Promise<string> {
  const parsed = assertAllowed(url);
  const attempt = async (): Promise<string> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Follow redirects manually so every hop is re-checked against the
      // allowlist: an open redirect on an allowlisted host must not bounce
      // us to an arbitrary (possibly internal) URL.
      let current = url;
      let reqInit: RequestInit = init;
      let res: Response | undefined;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const hopUrl = hop === 0 ? parsed : assertAllowed(current);
        res = await fetch(current, {
          ...reqInit,
          headers: { "User-Agent": USER_AGENT, ...(reqInit.headers ?? {}) },
          signal: controller.signal,
          redirect: "manual",
        });
        if (res.status < 300 || res.status >= 400 || res.status === 304) break;
        const loc = res.headers.get("location");
        if (!loc) break;
        await res.body?.cancel().catch(() => undefined);
        current = new URL(loc, hopUrl).toString();
        // 301/302/303 → GET without body (per fetch spec); 307/308 keep method + body.
        if (res.status !== 307 && res.status !== 308) reqInit = { ...reqInit, method: "GET", body: undefined };
        if (hop === MAX_REDIRECTS) {
          throw new SourceError(`Too many redirects from '${parsed.hostname}'.`, parsed.hostname, res.status);
        }
      }
      res = res as Response;
      if (!res.ok) {
        // Surface a short excerpt of error bodies: query-language APIs (ODSQL,
        // SPARQL, OData) explain *why* a query was rejected there, and SOAP
        // services report faults (incl. rate limits) as HTTP 500 bodies.
        let detail = "";
        if (res.status >= 400) {
          const excerpt = errorExcerpt(await readExcerpt(res, 16 * 1024));
          if (excerpt) detail = ` Upstream said: ${excerpt}`;
        }
        throw new SourceError(
          `Source '${parsed.hostname}' responded with HTTP ${res.status}.${detail}`,
          parsed.hostname,
          res.status,
        );
      }
      return await readCapped(res, parsed.hostname, maxBytes, controller);
    } finally {
      clearTimeout(timer);
    }
  };

  // Network errors / aborts surface from fetch as TypeError/AbortError; wrap
  // them so callers report "source unavailable" rather than "format changed".
  const guarded = async (): Promise<string> => {
    try {
      return await attempt();
    } catch (err) {
      if (err instanceof SourceError || err instanceof TooLargeError) throw err;
      const aborted = err instanceof Error && err.name === "AbortError";
      throw new SourceError(
        aborted
          ? `Source '${parsed.hostname}' did not answer within ${Math.round(timeoutMs / 1000)} s.`
          : `Could not reach '${parsed.hostname}' (${err instanceof Error ? err.message : String(err)}).`,
        parsed.hostname,
      );
    }
  };

  try {
    return await guarded();
  } catch (err) {
    if (err instanceof TooLargeError) throw err;
    // One retry on transient failures (network error, 5xx, timeout).
    const status = err instanceof SourceError ? err.status : undefined;
    const retryable = status === undefined || status >= 500 || status === 429;
    if (!retryable || retries < 1) throw err;
    await new Promise((r) => setTimeout(r, 600));
    return guarded();
  }
}

interface FetchOptions {
  ttlMs?: number;
  timeoutMs?: number;
  init?: RequestInit;
  /** Abort and throw TooLargeError past this many bytes (default 8 MB). */
  maxBytes?: number;
  /** Retries on network error / 5xx / 429 (default 1; use 0 for fan-out searches with their own deadline). */
  retries?: number;
}

/**
 * Fetch a URL with caching. Cache key includes method + body so POST search
 * queries are cached independently.
 */
export async function fetchCached(url: string, opts: FetchOptions = {}): Promise<FetchResult<string>> {
  const { ttlMs = 5 * 60_000, timeoutMs = 15_000, init = {}, maxBytes, retries } = opts;
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
        void rawFetch(url, init, timeoutMs, maxBytes, retries)
          .then((body) => cacheSet(key, { body, storedAt: Date.now(), ttlMs: entry.ttlMs }))
          .catch(() => undefined)
          .finally(() => inflightRevalidations.delete(key));
      }
      return { data: entry.body, cacheStatus: "stale", retrievedAt: new Date(entry.storedAt).toISOString() };
    }
    // Past the stale window: drop the dead entry before refetching so it can't
    // linger in the map if this key is never requested again.
    cacheDelete(key);
  }

  const body = await rawFetch(url, init, timeoutMs, maxBytes, retries);
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
// of opening the allowlist, such fetches go through fetchPublicResource():
//  (1) only http(s) URLs on standard ports, no credentials, no internal names;
//  (2) the address check runs INSIDE the socket's DNS lookup, so the address
//      that was validated is the address that is connected to — no
//      check-then-resolve-again gap for DNS rebinding;
//  (3) only globally routable addresses pass (IPv4 private/reserved ranges
//      rejected; IPv6 must be global unicast 2000::/3 minus 6to4, Teredo and
//      documentation space — which also rejects every IPv4-mapped/-compatible
//      and NAT64 form such as ::ffff:7f00:1);
//  (4) redirects are followed manually, every hop re-checked.

/** Expand an IPv6 literal into eight 16-bit groups, or undefined if malformed. */
function ipv6Groups(ip: string): number[] | undefined {
  let x = ip.toLowerCase().split("%")[0];
  // Embedded dotted IPv4 tail (::ffff:1.2.3.4) → two hex groups.
  const dotted = x.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const o = dotted[2].split(".").map(Number);
    if (o.some((n) => n > 255)) return undefined;
    x = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = x.split("::");
  if (halves.length > 2) return undefined;
  const parse = (h: string) => (h ? h.split(":").map((g) => parseInt(g, 16)) : []);
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return undefined;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill(0), ...tail];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : undefined;
}

/** True if an IPv4/IPv6 literal is NOT a globally routable public address. */
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
    const g = ipv6Groups(ip);
    if (!g) return true;
    if ((g[0] & 0xe000) !== 0x2000) return true; // not global unicast 2000::/3
    if (g[0] === 0x2002) return true; // 6to4 (embeds arbitrary IPv4)
    if (g[0] === 0x2001 && g[1] === 0x0000) return true; // Teredo
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
    return false;
  }
  return true; // not an IP at all → treat as unsafe
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A dns.lookup replacement for http(s).request that refuses non-public
 * addresses at connect time (defeats DNS rebinding).
 */
export function publicOnlyLookup(hostname: string, options: LookupAllOptions | number | undefined, cb: LookupCb): void {
  const opts: { family?: number; all?: boolean } =
    typeof options === "object" && options ? (options as { family?: number; all?: boolean }) : {};
  dnsLookup(hostname, { all: true, family: (opts.family ?? 0) as 0 | 4 | 6 }, (err, addrs) => {
    if (err) return cb(err, "");
    const list = (addrs as LookupAddress[]) ?? [];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (!list.length || bad) {
      const e: NodeJS.ErrnoException = new Error(
        `Refusing '${hostname}': resolves to a non-public address (SSRF protection).`,
      );
      e.code = "ESWISSYPHUS_PRIVATE";
      return cb(e, "");
    }
    if (opts.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

function checkPublicUrlShape(raw: string): URL {
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
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/i.test(host) || !host.includes(".") && !isIP(host)) {
    throw new SourceError(`Refusing internal hostname '${host}'.`, host);
  }
  // IP literals never hit the lookup hook, so check them here.
  if (isIP(host) && isPrivateAddress(host)) {
    throw new SourceError(`Refusing '${host}': non-public address (SSRF protection).`, host);
  }
  return u;
}

export interface PublicResponse {
  status: number;
  location?: string;
  contentType?: string;
  body: string;
}

/** One HTTP exchange with connect-time address validation (no redirects). */
export type PublicTransport = (u: URL, timeoutMs: number, maxBytes: number) => Promise<PublicResponse>;

const nodeTransport: PublicTransport = (u, timeoutMs, maxBytes) =>
  new Promise((resolve, reject) => {
    const mod = u.protocol === "https:" ? httpsRequest : httpRequest;
    const req = mod(
      u,
      {
        method: "GET",
        headers: { "User-Agent": USER_AGENT, Accept: "*/*", "Accept-Encoding": "identity" },
        lookup: publicOnlyLookup as never,
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === "string" ? res.headers.location : undefined;
        const contentType = res.headers["content-type"];
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, location, contentType, body: "" });
        }
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > maxBytes) {
          req.destroy();
          return reject(new TooLargeError(u.hostname, declared, maxBytes));
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total > maxBytes) {
            req.destroy();
            reject(new TooLargeError(u.hostname, total, maxBytes));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          let body: string;
          try {
            body = new TextDecoder("utf-8", { fatal: true }).decode(buf);
          } catch {
            body = new TextDecoder("windows-1252").decode(buf);
          }
          resolve({ status, location, contentType, body });
        });
        res.on("error", reject);
      },
    );
    const timer = setTimeout(() => req.destroy(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    req.on("timeout", () => req.destroy(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`)));
    req.on("close", () => clearTimeout(timer));
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ESWISSYPHUS_PRIVATE") reject(new SourceError(err.message, u.hostname));
      else reject(new SourceError(`Could not fetch resource from '${u.hostname}' (${err.message}).`, u.hostname));
    });
    req.end();
  });

/**
 * Transport over globalThis.fetch (no connect-time address pinning). Only for
 * offline tests that stub fetch; production always uses nodeTransport.
 */
export const fetchBackedTransport: PublicTransport = async (u, timeoutMs, maxBytes) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(u.toString(), {
      headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
      signal: controller.signal,
      redirect: "manual",
    });
    const location = res.headers.get("location") ?? undefined;
    const contentType = res.headers.get("content-type") ?? undefined;
    if (res.status >= 300 && res.status < 400) return { status: res.status, location, contentType, body: "" };
    const body = await readCapped(res, u.hostname, maxBytes, controller);
    return { status: res.status, location, contentType, body };
  } finally {
    clearTimeout(timer);
  }
};

let publicTransport: PublicTransport = nodeTransport;

/** Test hook: replace the network transport (address/redirect policy still applies). */
export function setPublicTransportForTests(t: PublicTransport | undefined): void {
  publicTransport = t ?? nodeTransport;
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
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = checkPublicUrlShape(current);
    const res = await publicTransport(u, timeoutMs, maxBytes);
    if (res.status >= 300 && res.status < 400) {
      if (!res.location) throw new SourceError(`Redirect without Location from ${u.hostname}.`, u.hostname, res.status);
      current = new URL(res.location, u).toString();
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new SourceError(`Resource host '${u.hostname}' responded with HTTP ${res.status}.`, u.hostname, res.status);
    }
    cacheSet(key, { body: JSON.stringify({ body: res.body, finalUrl: current, contentType: res.contentType }), storedAt: Date.now(), ttlMs });
    return { data: res.body, finalUrl: current, contentType: res.contentType, cacheStatus: "miss", retrievedAt: new Date().toISOString() };
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
