/**
 * Outbound HTTP layer.
 *
 * - SSRF protection: only allowlisted Swiss source hosts may be contacted (RFP §9).
 *   Redirects are followed manually (max 5) and every hop is re-checked against
 *   the allowlist; HTTPS→HTTP downgrades are refused.
 * - Response bodies are streamed with a byte cap (default 25 MB).
 * - In-memory LRU cache bounded by bytes and entries, with stale-while-revalidate
 *   (RFP §6.2) and stale-if-error (serve an old body when the source is down).
 * - Single-flight: concurrent requests for the same cache key share one fetch.
 * - Per-host circuit breaker and concurrency cap, so a dead or slow source fails
 *   fast instead of tying up every request for 2× its timeout.
 * - Timeouts and network failures always surface as `SourceError`.
 * - Every result carries cache_status + retrieved_at for the envelope.
 *
 * Tunables (environment):
 *   SWISSYPHUS_MAX_UPSTREAM_BYTES   max response body per upstream request (default 25 MiB)
 *   SWISSYPHUS_CACHE_MAX_BYTES      total cache budget in bytes (default 64 MiB)
 *   SWISSYPHUS_CACHE_MAX_ENTRIES    max cached entries (default 5000)
 *   SWISSYPHUS_UPSTREAM_CONCURRENCY max in-flight requests per upstream host (default 8)
 */

import { createRequire } from "node:module";
import type { CacheStatus, FetchResult } from "./types.js";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

function readPackageVersion(): string {
  try {
    // dist/core/http.js → ../../package.json is the package root, both in the
    // repo checkout and in the published npm package / Docker image / .mcpb.
    const pkg = createRequire(import.meta.url)("../../package.json") as { name?: unknown; version?: unknown };
    if (pkg && pkg.name === "swissyphus" && typeof pkg.version === "string") return pkg.version;
  } catch {
    /* fall through */
  }
  return "0.0.0";
}

/** Version of the running Swissyphus package, read from package.json. */
export const PACKAGE_VERSION = readPackageVersion();

/** User-Agent sent to every upstream source. */
export const USER_AGENT = `swissyphus/${PACKAGE_VERSION} (MCP server; +https://github.com/cwellbournewood/swissyphus)`;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

interface HttpConfig {
  /** Max bytes read from one upstream response. */
  maxUpstreamBytes: number;
  /** Total cache budget in bytes (body + parsed-object estimate). */
  cacheMaxBytes: number;
  /** Hard cap on number of cache entries. */
  cacheMaxEntries: number;
  /** Max concurrent requests per upstream host; the rest queue. */
  perHostConcurrency: number;
  /** Consecutive failures that open a host's circuit. */
  breakerThreshold: number;
  /** How long an open circuit fails fast before a half-open probe. */
  breakerCooldownMs: number;
  /** Delay before the single retry (unless Retry-After says otherwise). */
  retryDelayMs: number;
  /** Longest Retry-After we are willing to wait for; longer → no retry. */
  maxRetryAfterMs: number;
}

function defaultConfig(): HttpConfig {
  return {
    maxUpstreamBytes: envInt("SWISSYPHUS_MAX_UPSTREAM_BYTES", 25 * 1024 * 1024),
    cacheMaxBytes: envInt("SWISSYPHUS_CACHE_MAX_BYTES", 64 * 1024 * 1024),
    cacheMaxEntries: envInt("SWISSYPHUS_CACHE_MAX_ENTRIES", 5_000),
    perHostConcurrency: envInt("SWISSYPHUS_UPSTREAM_CONCURRENCY", 8),
    breakerThreshold: 5,
    breakerCooldownMs: 30_000,
    retryDelayMs: 600,
    maxRetryAfterMs: 2_000,
  };
}

let cfg: HttpConfig = defaultConfig();

/** Serve stale (while revalidating in the background) up to this many TTLs old. */
const STALE_FACTOR = 6;
/** When the source fails, an old body may still be served up to this many TTLs old. */
const STALE_IF_ERROR_FACTOR = 24;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// ---------------------------------------------------------------------------
// Allowlist + errors
// ---------------------------------------------------------------------------

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
  "eida.ethz.ch",
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
  "data.sbb.ch",
]);

/**
 * Why a SourceError happened (machine-readable):
 * - timeout: the request (or waiting for a connection slot) exceeded its timeout
 * - unreachable: DNS / TCP / TLS / connection-reset failure
 * - http: the source answered with a non-2xx status (see `status`)
 * - refused: Swissyphus refused the URL (allowlist, protocol, HTTPS downgrade)
 * - redirect: malformed redirect or too many redirects
 * - too_large: the response exceeded the byte cap
 * - circuit_open: the host's circuit breaker is open (failing fast)
 * - invalid_response: body could not be parsed (e.g. non-JSON)
 */
export type SourceErrorReason =
  | "timeout"
  | "unreachable"
  | "http"
  | "refused"
  | "redirect"
  | "too_large"
  | "circuit_open"
  | "invalid_response";

export class SourceError extends Error {
  /** Server-requested retry delay (from Retry-After), when present. */
  retryAfterMs?: number;

  constructor(
    message: string,
    public readonly sourceHost: string,
    public readonly status?: number,
    public readonly reason?: SourceErrorReason,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

function assertAllowed(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SourceError(`Refusing malformed URL: ${url}`, "", undefined, "refused");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new SourceError(`Refusing non-HTTP(S) URL: ${url}`, parsed.hostname, undefined, "refused");
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new SourceError(
      `Host '${parsed.hostname}' is not in the Swissyphus source allowlist (SSRF protection).`,
      parsed.hostname,
      undefined,
      "refused",
    );
  }
  return parsed;
}

function toSourceError(err: unknown, host: string, timedOut: boolean, timeoutMs: number): SourceError {
  if (err instanceof SourceError) return err;
  const name = err instanceof Error ? err.name : "";
  if (timedOut || name === "AbortError" || name === "TimeoutError") {
    return new SourceError(
      `Source '${host}' timed out after ${Math.round(timeoutMs / 100) / 10}s.`,
      host,
      undefined,
      "timeout",
    );
  }
  const cause = (err as { cause?: { code?: unknown; message?: unknown } } | undefined)?.cause;
  const detail =
    (typeof cause?.code === "string" && cause.code) ||
    (typeof cause?.message === "string" && cause.message) ||
    (err instanceof Error ? err.message : String(err));
  return new SourceError(`Source '${host}' is unreachable (${detail}).`, host, undefined, "unreachable");
}

/** Failures that say "the source is down/overloaded" (retry, breaker, stale-if-error). */
function isTransient(err: unknown): boolean {
  if (!(err instanceof SourceError)) return false;
  switch (err.reason) {
    case "timeout":
    case "unreachable":
    case "circuit_open":
    case "invalid_response":
    case "too_large":
      return true;
    case "http":
      return err.status !== undefined && (err.status >= 500 || err.status === 429);
    default:
      return false;
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

// ---------------------------------------------------------------------------
// Circuit breaker (per host)
// ---------------------------------------------------------------------------

type CircuitState = "closed" | "open" | "half_open";

interface Circuit {
  state: CircuitState;
  failures: number;
  openUntil: number;
  probing: boolean;
  lastError?: string;
}

const circuits = new Map<string, Circuit>();

export interface CircuitStatus {
  state: CircuitState;
  consecutiveFailures: number;
  /** ISO timestamp until which the circuit fails fast (only while open). */
  openUntil?: string;
  lastError?: string;
}

/** Snapshot of every upstream host's circuit breaker, for health reporting. */
export function getCircuitStates(): Record<string, CircuitStatus> {
  const now = Date.now();
  const out: Record<string, CircuitStatus> = {};
  for (const [host, c] of circuits) {
    const state: CircuitState = c.state === "open" && now >= c.openUntil ? "half_open" : c.state;
    out[host] = {
      state,
      consecutiveFailures: c.failures,
      ...(state === "open" ? { openUntil: new Date(c.openUntil).toISOString() } : {}),
      ...(c.lastError ? { lastError: c.lastError } : {}),
    };
  }
  return out;
}

/** Returns true when this request is the half-open probe. Throws when the circuit is open. */
function circuitAdmit(host: string): boolean {
  const c = circuits.get(host);
  if (!c || c.state === "closed") return false;
  const now = Date.now();
  if (c.state === "open") {
    if (now < c.openUntil) {
      throw new SourceError(
        `Source '${host}' is temporarily unavailable after repeated failures (circuit open; retrying in ${Math.ceil(
          (c.openUntil - now) / 1000,
        )}s).`,
        host,
        undefined,
        "circuit_open",
      );
    }
    c.state = "half_open";
    c.probing = false;
  }
  if (c.probing) {
    throw new SourceError(
      `Source '${host}' is temporarily unavailable (circuit half-open; a recovery probe is in flight).`,
      host,
      undefined,
      "circuit_open",
    );
  }
  c.probing = true;
  return true;
}

function circuitSuccess(host: string): void {
  const c = circuits.get(host);
  if (!c) return;
  // Healthy hosts don't need an entry; keeps getCircuitStates() small.
  circuits.delete(host);
}

function circuitFailure(host: string, err: unknown, isProbe: boolean): void {
  if (!(err instanceof SourceError)) return;
  const counts =
    err.reason === "timeout" ||
    err.reason === "unreachable" ||
    err.reason === "invalid_response" ||
    (err.reason === "http" && err.status !== undefined && (err.status >= 500 || err.status === 429));
  if (!counts) {
    // The host was reached and answered (e.g. 404, too large) → it is alive.
    if (err.reason === "http" || err.reason === "too_large" || err.reason === "redirect") {
      circuitSuccess(host);
    } else if (isProbe) {
      const c = circuits.get(host);
      if (c) c.probing = false; // no verdict; let the next request probe
    }
    return;
  }
  let c = circuits.get(host);
  if (!c) {
    c = { state: "closed", failures: 0, openUntil: 0, probing: false };
    circuits.set(host, c);
  }
  c.failures++;
  c.lastError = err.message;
  c.probing = false;
  if (isProbe || c.failures >= cfg.breakerThreshold) {
    c.state = "open";
    c.openUntil = Date.now() + cfg.breakerCooldownMs;
  }
}

// ---------------------------------------------------------------------------
// Per-host concurrency cap
// ---------------------------------------------------------------------------

interface HostSlots {
  active: number;
  queue: Array<() => void>;
}

const hostSlots = new Map<string, HostSlots>();

function acquireSlot(host: string, timeoutMs: number): Promise<() => void> {
  let slots = hostSlots.get(host);
  if (!slots) {
    slots = { active: 0, queue: [] };
    hostSlots.set(host, slots);
  }
  const s = slots;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    s.active--;
    const next = s.queue.shift();
    if (next) next();
    else if (s.active === 0 && hostSlots.get(host) === s) hostSlots.delete(host);
  };
  if (s.active < cfg.perHostConcurrency) {
    s.active++;
    return Promise.resolve(release);
  }
  return new Promise((resolve, reject) => {
    const grant = () => {
      clearTimeout(timer);
      s.active++;
      resolve(release);
    };
    const timer = setTimeout(() => {
      const i = s.queue.indexOf(grant);
      if (i >= 0) s.queue.splice(i, 1);
      reject(
        new SourceError(
          `Source '${host}' timed out: too many concurrent requests queued (waited ${Math.round(timeoutMs / 1000)}s).`,
          host,
          undefined,
          "timeout",
        ),
      );
    }, timeoutMs);
    s.queue.push(grant);
  });
}

// ---------------------------------------------------------------------------
// One HTTP attempt: manual redirects + streaming byte cap
// ---------------------------------------------------------------------------

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* ignore */
  }
}

function tooLarge(host: string, maxBytes: number): SourceError {
  return new SourceError(
    `Source '${host}' returned more than ${Math.round(maxBytes / 1024 / 1024)} MB; response refused (size cap).`,
    host,
    undefined,
    "too_large",
  );
}

interface RawBody {
  body: string;
  bytes: number;
}

async function attemptOnce(url: string, init: RequestInit, timeoutMs: number, maxBytes: number): Promise<RawBody> {
  let current = assertAllowed(url);
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  const headers = new Headers(init.headers ?? {});
  if (!headers.has("User-Agent")) headers.set("User-Agent", USER_AGENT);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    for (let hop = 0; ; hop++) {
      const host = current.hostname;
      let res: Response;
      try {
        res = await fetch(current.toString(), {
          ...init,
          method,
          body,
          headers,
          signal: controller.signal,
          redirect: "manual",
        });
      } catch (err) {
        throw toSourceError(err, host, timedOut, timeoutMs);
      }

      if (REDIRECT_STATUSES.has(res.status)) {
        await discard(res);
        const location = res.headers.get("location");
        if (!location) {
          throw new SourceError(
            `Source '${host}' sent an HTTP ${res.status} redirect without a Location header.`,
            host,
            res.status,
            "redirect",
          );
        }
        if (hop >= MAX_REDIRECTS) {
          throw new SourceError(`Source '${host}' redirected more than ${MAX_REDIRECTS} times.`, host, res.status, "redirect");
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new SourceError(`Source '${host}' sent a malformed redirect Location.`, host, res.status, "redirect");
        }
        if (current.protocol === "https:" && next.protocol !== "https:") {
          throw new SourceError(
            `Refusing redirect from HTTPS to ${next.protocol.replace(":", "").toUpperCase()} (${next.hostname}).`,
            host,
            res.status,
            "refused",
          );
        }
        assertAllowed(next.toString()); // SSRF check on every hop
        // Fetch-spec method rewriting.
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
          if (method !== "HEAD") method = "GET";
          body = undefined;
          headers.delete("content-type");
          headers.delete("content-length");
        }
        if (next.host !== current.host) {
          headers.delete("authorization");
          headers.delete("cookie");
        }
        current = next;
        continue;
      }

      if (!res.ok) {
        await discard(res);
        const err = new SourceError(`Source '${host}' responded with HTTP ${res.status}.`, host, res.status, "http");
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        if (retryAfter !== undefined) err.retryAfterMs = retryAfter;
        throw err;
      }

      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await discard(res);
        throw tooLarge(host, maxBytes);
      }
      if (!res.body) return { body: "", bytes: 0 };

      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            void reader.cancel().catch(() => undefined);
            throw tooLarge(host, maxBytes);
          }
          chunks.push(value);
        }
      } catch (err) {
        throw toSourceError(err, host, timedOut, timeoutMs);
      }
      return { body: decodeBody(Buffer.concat(chunks, total)), bytes: total };
    }
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Logical request: breaker + concurrency cap + one retry
// ---------------------------------------------------------------------------

type Parser = (body: string) => unknown;

interface Fetched extends RawBody {
  parsed?: unknown;
  hasParsed: boolean;
}

function nonJson(host: string): SourceError {
  return new SourceError(
    `Source '${host}' returned a non-JSON response (possibly down or changed format).`,
    host,
    undefined,
    "invalid_response",
  );
}

function retryDelayFor(err: unknown, hasBody: boolean): number | undefined {
  if (!(err instanceof SourceError)) return undefined;
  let retryable = false;
  if (err.reason === "unreachable") retryable = true;
  else if (err.reason === "timeout") retryable = !hasBody; // don't run expensive POST queries twice
  else if (err.reason === "http") retryable = err.status !== undefined && (err.status >= 500 || err.status === 429);
  if (!retryable) return undefined;
  if (err.retryAfterMs !== undefined) {
    return err.retryAfterMs <= cfg.maxRetryAfterMs ? err.retryAfterMs : undefined;
  }
  return cfg.retryDelayMs;
}

/**
 * Decode a response body. Most sources send UTF-8; a few Swiss federal CSVs
 * (MeteoSwiss OGD metadata, some BFS files) are Windows-1252/Latin-1. Strict
 * UTF-8 first, so valid UTF-8 is never altered; only invalid UTF-8 falls back.
 */
export function decodeBody(buf: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("windows-1252").decode(buf);
  }
}

async function rawFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  maxBytes: number,
  parse?: Parser,
): Promise<Fetched> {
  const host = assertAllowed(url).hostname;
  const isProbe = circuitAdmit(host);
  const hasBody = init.body !== undefined && init.body !== null;

  const run = async (): Promise<Fetched> => {
    const release = await acquireSlot(host, timeoutMs);
    try {
      const raw = await attemptOnce(url, init, timeoutMs, maxBytes);
      if (!parse) return { ...raw, hasParsed: false };
      let parsed: unknown;
      try {
        parsed = parse(raw.body);
      } catch (err) {
        if (err instanceof SourceError) throw err;
        throw nonJson(host);
      }
      return { ...raw, parsed, hasParsed: true };
    } finally {
      release();
    }
  };

  try {
    let result: Fetched;
    try {
      result = await run();
    } catch (err) {
      const delay = retryDelayFor(err, hasBody);
      if (delay === undefined) throw err;
      await new Promise((r) => setTimeout(r, delay));
      result = await run();
    }
    circuitSuccess(host);
    return result;
  } catch (err) {
    circuitFailure(host, err, isProbe);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Cache: LRU bounded by bytes + entries, single-flight, SWR, stale-if-error
// ---------------------------------------------------------------------------

interface CacheEntry {
  body: string;
  bytes: number;
  /** Memoized JSON.parse(body). Shared by every caller — never mutate it. */
  parsed?: unknown;
  hasParsed: boolean;
  storedAt: number;
  ttlMs: number;
  /** Accounted size in bytes (body + parsed estimate + key). */
  size: number;
}

const cache = new Map<string, CacheEntry>();
let cacheBytes = 0;
const inflight = new Map<string, Promise<CacheEntry>>();

function entrySize(key: string, e: Pick<CacheEntry, "bytes" | "hasParsed">): number {
  // A parsed JSON object typically costs at least as much heap as its source text.
  return key.length + e.bytes * (e.hasParsed ? 2 : 1);
}

function cacheDelete(key: string): void {
  const e = cache.get(key);
  if (!e) return;
  cache.delete(key);
  cacheBytes -= e.size;
}

function evict(): void {
  while (cache.size > cfg.cacheMaxEntries || (cacheBytes > cfg.cacheMaxBytes && cache.size > 0)) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cacheDelete(oldest);
  }
}

function cacheSet(key: string, entry: CacheEntry): void {
  cacheDelete(key);
  if (entry.size > cfg.cacheMaxBytes) return; // larger than the whole budget: serve, don't keep
  cache.set(key, entry);
  cacheBytes += entry.size;
  evict();
}

/** Mark as most-recently used (Map order is the LRU order). */
function touch(key: string, entry: CacheEntry): void {
  if (cache.get(key) !== entry) return;
  cache.delete(key);
  cache.set(key, entry);
}

function attachParsed(key: string, entry: CacheEntry, parsed: unknown): void {
  entry.parsed = parsed;
  entry.hasParsed = true;
  const size = entrySize(key, entry);
  if (cache.get(key) === entry) {
    cacheBytes += size - entry.size;
    entry.size = size;
    evict();
  } else {
    entry.size = size;
  }
}

export interface FetchOptions {
  ttlMs?: number;
  timeoutMs?: number;
  init?: RequestInit;
  /** Max response bytes for this call (default SWISSYPHUS_MAX_UPSTREAM_BYTES / 25 MiB). */
  maxBytes?: number;
  /**
   * Don't keep the body in the shared response cache (single-flight still applies).
   * For very large payloads the caller indexes and memoises itself, so holding the
   * raw body too would only evict everyone else's entries.
   */
  noStore?: boolean;
}

function startFlight(key: string, url: string, opts: Required<FetchOptions>, parse?: Parser): Promise<CacheEntry> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = rawFetch(url, opts.init, opts.timeoutMs, opts.maxBytes, parse)
    .then((r) => {
      const entry: CacheEntry = {
        body: r.body,
        bytes: r.bytes,
        parsed: r.parsed,
        hasParsed: r.hasParsed,
        storedAt: Date.now(),
        ttlMs: opts.ttlMs,
        size: 0,
      };
      entry.size = entrySize(key, entry);
      if (!opts.noStore) cacheSet(key, entry);
      return entry;
    })
    .finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

interface Loaded {
  key: string;
  entry: CacheEntry;
  status: CacheStatus;
  staleAgeMs?: number;
}

async function load(url: string, opts: FetchOptions, parse?: Parser): Promise<Loaded> {
  const resolved: Required<FetchOptions> = {
    ttlMs: opts.ttlMs ?? 5 * 60_000,
    timeoutMs: opts.timeoutMs ?? 15_000,
    init: opts.init ?? {},
    maxBytes: opts.maxBytes ?? cfg.maxUpstreamBytes,
    noStore: opts.noStore ?? false,
  };
  const { init } = resolved;
  const key = `${init.method ?? "GET"} ${url} ${typeof init.body === "string" ? init.body : ""}`;
  const now = Date.now();
  const entry = cache.get(key);

  if (entry) {
    const age = now - entry.storedAt;
    if (age < entry.ttlMs) {
      touch(key, entry);
      return { key, entry, status: "hit" };
    }
    if (age < entry.ttlMs * STALE_FACTOR) {
      touch(key, entry);
      // Serve stale; revalidate in the background (deduped with any in-flight fetch).
      void startFlight(key, url, resolved, parse).catch(() => undefined);
      return { key, entry, status: "stale", staleAgeMs: age };
    }
    if (age >= entry.ttlMs * STALE_IF_ERROR_FACTOR) cacheDelete(key);
  }

  try {
    return { key, entry: await startFlight(key, url, resolved, parse), status: "miss" };
  } catch (err) {
    // Stale-if-error: an old body beats a hard failure when the source is down.
    const fallback = cache.get(key);
    if (fallback && isTransient(err) && Date.now() - fallback.storedAt < fallback.ttlMs * STALE_IF_ERROR_FACTOR) {
      touch(key, fallback);
      return { key, entry: fallback, status: "stale", staleAgeMs: Date.now() - fallback.storedAt };
    }
    throw err;
  }
}

function toResult<T>(data: T, loaded: Loaded): FetchResult<T> {
  return {
    data,
    cacheStatus: loaded.status,
    retrievedAt: new Date(loaded.entry.storedAt).toISOString(),
    ...(loaded.staleAgeMs !== undefined ? { staleAgeSeconds: Math.round(loaded.staleAgeMs / 1000) } : {}),
  };
}

/**
 * Fetch a URL with caching. Cache key includes method + body so POST search
 * queries are cached independently.
 */
export async function fetchCached(url: string, opts: FetchOptions = {}): Promise<FetchResult<string>> {
  const loaded = await load(url, opts);
  return toResult(loaded.entry.body, loaded);
}

/**
 * Fetch and parse JSON. The parsed object is memoized with the cache entry, so
 * cache hits return the SAME object without re-parsing (multi-MB payloads).
 * Callers must treat the returned data as read-only: never mutate it in place
 * (copy arrays before `.sort()`, build new objects instead of assigning fields).
 */
export interface FetchJsonOptions extends FetchOptions {
  /**
   * Plausibility check on the parsed body. When it returns false the response
   * is treated as a transient `invalid_response` failure: it is NOT cached, and
   * a previous good body is served stale instead when one exists. Use it for
   * reference lists that are never legitimately empty, so one empty/garbled
   * upstream answer cannot poison the cache for a whole TTL.
   */
  validate?: (parsed: unknown) => boolean;
}

function implausible(host: string): SourceError {
  return new SourceError(
    `Source '${host}' returned an empty or unrecognised response (possibly down or changed format).`,
    host,
    undefined,
    "invalid_response",
  );
}

export async function fetchJson<T>(url: string, opts: FetchJsonOptions = {}): Promise<FetchResult<T>> {
  const { validate, ...fetchOpts } = opts;
  const host = new URL(url).hostname;
  const headers = new Headers(fetchOpts.init?.headers ?? {});
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  const parse: Parser = validate
    ? (body) => {
        const v: unknown = JSON.parse(body);
        if (!validate(v)) throw implausible(host);
        return v;
      }
    : JSON.parse;
  const loaded = await load(url, { ...fetchOpts, init: { ...fetchOpts.init, headers } }, parse);
  const { entry } = loaded;
  if (!entry.hasParsed) {
    // Entry was stored by a raw fetchCached call for the same key.
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.body);
    } catch {
      throw nonJson(host);
    }
    if (validate && !validate(parsed)) throw implausible(host);
    attachParsed(loaded.key, entry, parsed);
  }
  return toResult(entry.parsed as T, loaded);
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

/** Cache statistics for health/metrics endpoints. */
export function getCacheStats(): { entries: number; bytes: number; maxBytes: number; maxEntries: number; inflight: number } {
  return {
    entries: cache.size,
    bytes: cacheBytes,
    maxBytes: cfg.cacheMaxBytes,
    maxEntries: cfg.cacheMaxEntries,
    inflight: inflight.size,
  };
}

/**
 * Test hook: clear all module state (cache, in-flight, circuits, host slots)
 * and reset configuration to defaults, optionally overriding some values.
 */
export function __resetForTests(overrides: Partial<HttpConfig> = {}): void {
  cache.clear();
  cacheBytes = 0;
  inflight.clear();
  circuits.clear();
  hostSlots.clear();
  cfg = { ...defaultConfig(), ...overrides };
}

export type CacheStatusOf = CacheStatus;
