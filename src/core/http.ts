/**
 * Outbound HTTP layer.
 *
 * - SSRF protection: only allowlisted Swiss source hosts may be contacted.
 *   Redirects are followed manually (max 5) and every hop is re-checked against
 *   the allowlist; HTTPS→HTTP downgrades are refused.
 * - Response bodies are streamed with a byte cap (default 25 MB).
 * - In-memory LRU cache bounded by bytes and entries, with stale-while-revalidate
 *   and stale-if-error (serve an old body when the source is down).
 * - Single-flight: concurrent requests for the same cache key share one fetch.
 * - Per-host circuit breaker and concurrency cap, so a dead or slow source fails
 *   fast instead of tying up every request for 2× its timeout.
 * - Timeouts and network failures always surface as `SourceError`.
 * - Per-call time budgets (AsyncLocalStorage): every fetch gets
 *   min(its own timeout, time left in the tool call); retries only when affordable.
 * - Catalogue-derived URLs on arbitrary public hosts go through
 *   fetchPublicResource(), which pins the validated address at connect time.
 * - Every result carries cache_status + retrieved_at for the envelope.
 *
 * Tunables (environment):
 *   SWISSYPHUS_MAX_UPSTREAM_BYTES   max response body per upstream request (default 25 MiB)
 *   SWISSYPHUS_CACHE_MAX_BYTES      total cache budget in bytes (default 128 MiB;
 *                                   SWISSYPHUS_CACHE_MB is accepted as an alias in MiB)
 *   SWISSYPHUS_CACHE_MAX_ENTRIES    max cached entries (default 5000)
 *   SWISSYPHUS_UPSTREAM_CONCURRENCY max in-flight requests per upstream host (default 8)
 *   SWISSYPHUS_LKG_DIR / _MAX_BYTES on-disk last-known-good store (see core/lkg.ts)
 */

import { createRequire } from "node:module";
import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { AsyncLocalStorage } from "node:async_hooks";
import type { CacheStatus, FetchResult, SourceManifest } from "./types.js";
import { configureLkg, lkgGet, lkgPut, LKG_MAX_ENTRY_BYTES } from "./lkg.js";
import { recordUpstream } from "./provenance.js";

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
  /** How long an open circuit fails fast before a half-open probe (first trip). */
  breakerCooldownMs: number;
  /**
   * Upper bound for the cooldown. Each consecutive trip without a recovery doubles
   * the cooldown (30 s → 60 s → 2 min … ), and a source's own Retry-After can
   * lengthen it, but never beyond this.
   */
  breakerMaxCooldownMs: number;
  /** Delay before the single retry (unless Retry-After says otherwise). */
  retryDelayMs: number;
  /** Longest Retry-After we are willing to wait for; longer → no retry. */
  maxRetryAfterMs: number;
}

function defaultConfig(): HttpConfig {
  return {
    maxUpstreamBytes: envInt("SWISSYPHUS_MAX_UPSTREAM_BYTES", 25 * 1024 * 1024),
    cacheMaxBytes: envInt(
      "SWISSYPHUS_CACHE_MAX_BYTES",
      envInt("SWISSYPHUS_CACHE_MB", 128) * 1024 * 1024,
    ),
    cacheMaxEntries: envInt("SWISSYPHUS_CACHE_MAX_ENTRIES", 5_000),
    perHostConcurrency: envInt("SWISSYPHUS_UPSTREAM_CONCURRENCY", 8),
    breakerThreshold: 5,
    breakerCooldownMs: 30_000,
    breakerMaxCooldownMs: 10 * 60_000,
    retryDelayMs: 600,
    maxRetryAfterMs: 2_000,
  };
}

let cfg: HttpConfig = defaultConfig();

/** Serve stale (while revalidating in the background) up to this many TTLs old. */
const STALE_FACTOR = 6;
/**
 * Default max-stale: when the source fails, an old body may still be served up
 * to this many TTLs old. Sources override it with SourceManifest.maxStaleSeconds.
 */
const STALE_IF_ERROR_FACTOR = 24;

configureLkg(process.env["SWISSYPHUS_LKG_DIR"] || undefined, envInt("SWISSYPHUS_LKG_MAX_BYTES", 64 * 1024 * 1024));

/**
 * Cache options for a source: its TTL and (if declared) its max-stale window.
 * Use as `fetchJson(url, { ...sourceCache(source), timeoutMs })`.
 */
export function sourceCache(source: Pick<SourceManifest, "cacheTtlSeconds" | "maxStaleSeconds">): {
  ttlMs: number;
  maxStaleMs?: number;
} {
  return {
    ttlMs: source.cacheTtlSeconds * 1000,
    ...(source.maxStaleSeconds !== undefined ? { maxStaleMs: source.maxStaleSeconds * 1000 } : {}),
  };
}

/** How long an entry may be served at all (stale-if-error limit). Never below the TTL. */
function maxStaleOf(e: { ttlMs: number; maxStaleMs?: number }): number {
  return Math.max(e.ttlMs, e.maxStaleMs ?? e.ttlMs * STALE_IF_ERROR_FACTOR);
}

/** How long an entry is served stale-while-revalidating (no error needed). */
function swrWindowOf(e: { ttlMs: number; maxStaleMs?: number }): number {
  return Math.min(e.ttlMs * STALE_FACTOR, maxStaleOf(e));
}
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
 * editing this file.
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

// ---------------------------------------------------------------------------
// Time budgets
// ---------------------------------------------------------------------------
//
// An agent waiting on a tool is a person waiting on an answer. Every tool
// call runs inside a time budget (AsyncLocalStorage, so it flows through
// every await): each upstream fetch gets min(its own timeout, time left),
// retries only happen when there is time for them, and once the budget is
// spent further fetches fail fast instead of stacking 30–45 s timeouts.

interface Budget {
  deadline: number;
  retries: boolean;
}
const budgetStore = new AsyncLocalStorage<Budget>();

export function withTimeBudget<T>(
  ms: number,
  fn: () => Promise<T>,
  opts: { retries?: boolean; detached?: boolean } = {},
): Promise<T> {
  const parent = opts.detached ? undefined : budgetStore.getStore();
  const deadline = Math.min(Date.now() + ms, parent?.deadline ?? Infinity);
  const retries = (opts.retries ?? true) && (parent?.retries ?? true);
  return budgetStore.run({ deadline, retries }, fn);
}

/** Milliseconds left in the current budget (Infinity outside any budget). */
export function remainingBudgetMs(): number {
  const b = budgetStore.getStore();
  return b ? b.deadline - Date.now() : Infinity;
}

/** Run fn outside any budget (background revalidation / cache warming). */
export function outsideBudget<T>(fn: () => T): T {
  return budgetStore.exit(fn);
}

/** True when the current budget (if any) can afford a retry. */
function budgetAllowsRetry(): boolean {
  const b = budgetStore.getStore();
  return !b || (b.retries && remainingBudgetMs() > 3_000);
}

const DEBUG = process.env["SWISSYPHUS_DEBUG"] === "1";

/** Debug trace to stderr (stdout is the MCP channel). Enabled by SWISSYPHUS_DEBUG=1. */
export function debugLog(msg: string): void {
  if (DEBUG) process.stderr.write(`[swissyphus ${new Date().toISOString().slice(11, 23)}] ${msg}\n`);
}

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
 * - budget: the tool call's time budget was used up before the request started
 */
export type SourceErrorReason =
  | "timeout"
  | "unreachable"
  | "http"
  | "refused"
  | "redirect"
  | "too_large"
  | "circuit_open"
  | "invalid_response"
  | "budget";

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

/** Upstream body exceeded the configured size ceiling. Not retried. */
export class TooLargeError extends SourceError {
  constructor(
    sourceHost: string,
    public readonly bytes: number,
    public readonly maxBytes: number,
  ) {
    super(
      `Resource on '${sourceHost}' is too large (${Math.round(bytes / 1024)} KB > ${Math.round(maxBytes / 1024)} KB limit); response refused (size cap).`,
      sourceHost,
      undefined,
      "too_large",
    );
    this.name = "TooLargeError";
  }
}

/** Effective timeout for one attempt: min(timeout, budget left); throws when spent. */
function budgetedTimeout(timeoutMs: number, host: string): number {
  const left = remainingBudgetMs();
  if (left < 250) {
    throw new SourceError(`Stopped before querying '${host}': this call's time budget is used up.`, host, undefined, "budget");
  }
  return Math.min(timeoutMs, left);
}

/** Linear-time tag strip + whitespace collapse, capped at 400 chars. */
export function errorExcerpt(text: string): string {
  // `[^<>]*` (not `[^>]+`) keeps this linear on inputs like "<<<<<<…".
  return text.replace(/<[^<>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
}

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
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks, total).subarray(0, max));
}

/** Decode bytes as UTF-8; Swiss CSV exports are still sometimes Windows-1252. */
function decodeBody(buf: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("windows-1252").decode(buf);
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
  if (!isAllowedHost(parsed.hostname)) {
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
      `Source '${host}' did not answer in time (timed out after ${Math.round(timeoutMs / 100) / 10}s).`,
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
  return new SourceError(`Could not reach '${host}': source is unreachable (${detail}).`, host, undefined, "unreachable");
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
    case "budget":
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
  /** How many times the circuit opened since the host was last healthy (drives backoff). */
  trips: number;
  lastError?: string;
}

const circuits = new Map<string, Circuit>();

export interface CircuitStatus {
  state: CircuitState;
  consecutiveFailures: number;
  /** Times the circuit opened since the host was last healthy. */
  trips: number;
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
      trips: c.trips,
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
      const err = new SourceError(
        `Source '${host}' is temporarily unavailable after repeated failures (circuit open; retrying in ${Math.ceil(
          (c.openUntil - now) / 1000,
        )}s).`,
        host,
        undefined,
        "circuit_open",
      );
      err.retryAfterMs = c.openUntil - now;
      throw err;
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
    c = { state: "closed", failures: 0, openUntil: 0, probing: false, trips: 0 };
    circuits.set(host, c);
  }
  c.failures++;
  c.lastError = err.message;
  c.probing = false;
  // A 429 is the source telling us, explicitly, that we are over its limit: stop
  // at once rather than spending four more requests (from one shared egress IP)
  // to reach the generic threshold. Same for any failure that names a Retry-After.
  const toldToBackOff = err.status === 429 || err.retryAfterMs !== undefined;
  if (isProbe || toldToBackOff || c.failures >= cfg.breakerThreshold) {
    c.trips++;
    const backoff = cfg.breakerCooldownMs * 2 ** Math.min(c.trips - 1, 20);
    const cooldown = Math.min(cfg.breakerMaxCooldownMs, Math.max(backoff, err.retryAfterMs ?? 0));
    c.state = "open";
    c.openUntil = Date.now() + cooldown;
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

function tooLarge(host: string, bytes: number, maxBytes: number): TooLargeError {
  return new TooLargeError(host, bytes, maxBytes);
}

interface RawBody {
  body: string;
  bytes: number;
}

/**
 * Request headers as a plain object that keeps the caller's key casing
 * (lookups and deletes are case-insensitive).
 */
class HeaderBag {
  readonly h: Record<string, string> = {};
  constructor(init?: HeadersInit) {
    if (!init) return;
    const entries: Iterable<[string, string]> =
      init instanceof Headers ? init.entries() : Array.isArray(init) ? (init as [string, string][]) : Object.entries(init);
    for (const [k, v] of entries) this.set(k, v);
  }
  private find(name: string): string | undefined {
    const n = name.toLowerCase();
    return Object.keys(this.h).find((k) => k.toLowerCase() === n);
  }
  has(name: string): boolean {
    return this.find(name) !== undefined;
  }
  set(name: string, value: string): void {
    const k = this.find(name);
    if (k !== undefined) delete this.h[k];
    this.h[name] = value;
  }
  delete(name: string): void {
    const k = this.find(name);
    if (k !== undefined) delete this.h[k];
  }
}

async function attemptOnce(url: string, init: RequestInit, timeoutMs: number, maxBytes: number): Promise<RawBody> {
  let current = assertAllowed(url);
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  const headers = new HeaderBag(init.headers);
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
          headers: { ...headers.h },
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
        assertAllowed(next.toString()); // SSRF check on every hop
        if (current.protocol === "https:" && next.protocol !== "https:") {
          throw new SourceError(
            `Refusing redirect from HTTPS to ${next.protocol.replace(":", "").toUpperCase()} (${next.hostname}).`,
            host,
            res.status,
            "refused",
          );
        }
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
        // Surface a short excerpt of error bodies: query-language APIs (ODSQL,
        // SPARQL, OData) explain *why* a query was rejected there, and SOAP
        // services report faults (incl. rate limits) as HTTP 500 bodies.
        let detail = "";
        if (res.status >= 400) {
          const excerpt = errorExcerpt(await readExcerpt(res, 16 * 1024));
          if (excerpt) detail = ` Upstream said: ${excerpt}`;
        } else {
          await discard(res);
        }
        const err = new SourceError(`Source '${host}' responded with HTTP ${res.status}.${detail}`, host, res.status, "http");
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        if (retryAfter !== undefined) err.retryAfterMs = retryAfter;
        throw err;
      }

      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await discard(res);
        throw tooLarge(host, declared, maxBytes);
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
            throw tooLarge(host, total, maxBytes);
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

async function rawFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  maxBytes: number,
  parse?: Parser,
  retries = 1,
): Promise<Fetched> {
  const parsedUrl = assertAllowed(url);
  const host = parsedUrl.hostname;
  // Budget check before the breaker: an exhausted budget says nothing about the host.
  budgetedTimeout(timeoutMs, host);
  const isProbe = circuitAdmit(host);
  const hasBody = init.body !== undefined && init.body !== null;

  const run = async (): Promise<Fetched> => {
    const effTimeout = budgetedTimeout(timeoutMs, host);
    const release = await acquireSlot(host, effTimeout);
    const started = Date.now();
    try {
      const raw = await attemptOnce(url, init, effTimeout, maxBytes);
      debugLog(`${init.method ?? "GET"} ${host}${parsedUrl.pathname.slice(0, 60)} → ${raw.bytes} B in ${Date.now() - started} ms`);
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
      debugLog(`${init.method ?? "GET"} ${host}${parsedUrl.pathname.slice(0, 60)} → ${err instanceof Error ? err.message : String(err)}`);
      const delay = retries > 0 && budgetAllowsRetry() ? retryDelayFor(err, hasBody) : undefined;
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
  /** Memoized JSON.parse(body). Shared by every caller; never mutate it. */
  parsed?: unknown;
  hasParsed: boolean;
  storedAt: number;
  ttlMs: number;
  /** Source-specific max-stale window; default ttlMs × STALE_IF_ERROR_FACTOR. */
  maxStaleMs?: number;
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
  if (entry.size > cfg.cacheMaxBytes / 2) return; // one giant body must not flush the whole cache: serve, don't keep
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
  /**
   * Longest a cached body may be served when the source fails (stale-if-error),
   * and the cap on the stale-while-revalidate window. Default ttlMs × 24.
   * Usually set via sourceCache(manifest) from SourceManifest.maxStaleSeconds.
   */
  maxStaleMs?: number;
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
  /** Retries on network error / 5xx / 429 (default 1; use 0 for fan-out searches with their own deadline). */
  retries?: number;
}

type ResolvedOptions = Required<Omit<FetchOptions, "maxStaleMs">> & Pick<FetchOptions, "maxStaleMs">;

/** Whether a request may be written to the on-disk LKG store (never anything credentialed). */
function persistable(opts: ResolvedOptions): boolean {
  if (opts.noStore) return false;
  const h = new Headers(opts.init.headers ?? {});
  return !h.has("authorization") && !h.has("cookie");
}

function startFlight(key: string, url: string, opts: ResolvedOptions, parse?: Parser): Promise<CacheEntry> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = rawFetch(url, opts.init, opts.timeoutMs, opts.maxBytes, parse, opts.retries)
    .then((r) => {
      const entry: CacheEntry = {
        body: r.body,
        bytes: r.bytes,
        parsed: r.parsed,
        hasParsed: r.hasParsed,
        storedAt: Date.now(),
        ttlMs: opts.ttlMs,
        ...(opts.maxStaleMs !== undefined ? { maxStaleMs: opts.maxStaleMs } : {}),
        size: 0,
      };
      entry.size = entrySize(key, entry);
      if (!opts.noStore) cacheSet(key, entry);
      if (r.bytes <= LKG_MAX_ENTRY_BYTES && persistable(opts)) {
        lkgPut(key, { body: r.body, storedAt: entry.storedAt, ttlMs: entry.ttlMs, maxStaleMs: maxStaleOf(entry) });
      }
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

/** load() plus a provenance record for the current tool call (core/provenance.ts). */
async function load(url: string, opts: FetchOptions, parse?: Parser): Promise<Loaded> {
  const loaded = await loadEntry(url, opts, parse);
  recordUpstream({
    url,
    ...(opts.init?.method ? { method: opts.init.method } : {}),
    cacheStatus: loaded.status,
    retrievedAt: new Date(loaded.entry.storedAt).toISOString(),
  });
  return loaded;
}

async function loadEntry(url: string, opts: FetchOptions, parse?: Parser): Promise<Loaded> {
  const resolved: ResolvedOptions = {
    ttlMs: opts.ttlMs ?? 5 * 60_000,
    ...(opts.maxStaleMs !== undefined ? { maxStaleMs: opts.maxStaleMs } : {}),
    timeoutMs: opts.timeoutMs ?? 15_000,
    init: opts.init ?? {},
    maxBytes: opts.maxBytes ?? cfg.maxUpstreamBytes,
    noStore: opts.noStore ?? false,
    retries: opts.retries ?? 1,
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
    if (age < swrWindowOf(entry)) {
      touch(key, entry);
      // Serve stale; revalidate in the background (deduped with any in-flight fetch).
      void outsideBudget(() => startFlight(key, url, resolved, parse)).catch(() => undefined);
      return { key, entry, status: "stale", staleAgeMs: age };
    }
    if (age >= maxStaleOf(entry)) cacheDelete(key);
  }

  try {
    return { key, entry: await startFlight(key, url, resolved, parse), status: "miss" };
  } catch (err) {
    // Stale-if-error: an old body beats a hard failure when the source is down.
    if (!isTransient(err)) throw err;
    const fallback = cache.get(key);
    if (fallback && Date.now() - fallback.storedAt < maxStaleOf(fallback)) {
      touch(key, fallback);
      return { key, entry: fallback, status: "stale", staleAgeMs: Date.now() - fallback.storedAt };
    }
    // Nothing usable in memory (e.g. right after a restart): try the on-disk copy.
    const restored = await restoreFromLkg(key, parse);
    if (restored) return { key, entry: restored, status: "stale", staleAgeMs: Date.now() - restored.storedAt };
    throw err;
  }
}

async function restoreFromLkg(key: string, parse?: Parser): Promise<CacheEntry | undefined> {
  const rec = await lkgGet(key);
  if (!rec) return undefined;
  let parsed: unknown;
  let hasParsed = false;
  if (parse) {
    try {
      parsed = parse(rec.body);
      hasParsed = true;
    } catch {
      return undefined; // no longer parses / passes validation: don't serve it
    }
  }
  const entry: CacheEntry = {
    body: rec.body,
    bytes: Buffer.byteLength(rec.body),
    parsed,
    hasParsed,
    storedAt: rec.storedAt,
    ttlMs: rec.ttlMs,
    maxStaleMs: rec.maxStaleMs,
    size: 0,
  };
  entry.size = entrySize(key, entry);
  // Back in memory, so concurrent and following requests don't re-read the disk.
  if (!cache.has(key)) cacheSet(key, entry);
  return entry;
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
  const bag = new HeaderBag(fetchOpts.init?.headers);
  if (!bag.has("Accept")) bag.set("Accept", "application/json");
  const headers = bag.h;
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

// ── Dynamic (catalogue-derived) hosts ────────────────────────────────────
//
// Catalogue adapters (opendata.swiss resources, …) must fetch files from
// thousands of publisher hosts that cannot be enumerated in advance. Instead
// of opening the allowlist, such fetches go through fetchPublicResource():
//  (1) only http(s) URLs on standard ports, no credentials, no internal names;
//  (2) the address check runs INSIDE the socket's DNS lookup, so the address
//      that was validated is the address that is connected to, with no
//      check-then-resolve-again gap for DNS rebinding;
//  (3) only globally routable addresses pass (IPv4 private/reserved ranges
//      rejected; IPv6 must be global unicast 2000::/3 minus 6to4, Teredo and
//      documentation space, which also rejects every IPv4-mapped/-compatible
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
    throw new SourceError(`Invalid resource URL: ${raw}`, "invalid", undefined, "refused");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new SourceError(`Refusing non-HTTP(S) resource URL: ${raw}`, u.hostname, undefined, "refused");
  }
  if (u.port && u.port !== "443" && u.port !== "80") {
    throw new SourceError(`Refusing non-standard port ${u.port} on ${u.hostname}.`, u.hostname, undefined, "refused");
  }
  if (u.username || u.password) {
    throw new SourceError("Refusing resource URL with embedded credentials.", u.hostname, undefined, "refused");
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/i.test(host) || !host.includes(".") && !isIP(host)) {
    throw new SourceError(`Refusing internal hostname '${host}'.`, host, undefined, "refused");
  }
  // IP literals never hit the lookup hook, so check them here.
  if (isIP(host) && isPrivateAddress(host)) {
    throw new SourceError(`Refusing '${host}': non-public address (SSRF protection).`, host, undefined, "refused");
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
            body = decodeBody(buf);
          } catch {
            body = "";
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
      if (err.code === "ESWISSYPHUS_PRIVATE") reject(new SourceError(err.message, u.hostname, undefined, "refused"));
      else if (/timed out/.test(err.message)) reject(new SourceError(`Resource host '${u.hostname}' did not answer in time (${err.message}).`, u.hostname, undefined, "timeout"));
      else reject(new SourceError(`Could not fetch resource from '${u.hostname}' (${err.message}).`, u.hostname, undefined, "unreachable"));
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
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      controller.abort();
      throw new TooLargeError(u.hostname, declared, maxBytes);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new TooLargeError(u.hostname, buf.byteLength, maxBytes);
    return { status: res.status, location, contentType, body: decodeBody(buf) };
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
  const { ttlMs = 3600_000, timeoutMs = 30_000, maxBytes = Math.min(cfg.maxUpstreamBytes, 8 * 1024 * 1024) } = opts;
  const key = `PUBLIC ${url}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.storedAt < hit.ttlMs) {
    touch(key, hit);
    const meta = JSON.parse(hit.body) as { body: string; finalUrl: string; contentType?: string };
    recordUpstream({ url: meta.finalUrl, cacheStatus: "hit", retrievedAt: new Date(hit.storedAt).toISOString() });
    return { data: meta.body, finalUrl: meta.finalUrl, contentType: meta.contentType, cacheStatus: "hit", retrievedAt: new Date(hit.storedAt).toISOString() };
  }
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = checkPublicUrlShape(current);
    const started = Date.now();
    const res = await publicTransport(u, budgetedTimeout(timeoutMs, u.hostname), maxBytes);
    debugLog(`GET ${u.hostname}${u.pathname.slice(0, 60)} (resource) → ${res.status} in ${Date.now() - started} ms, ${res.body.length} chars`);
    if (res.status >= 300 && res.status < 400) {
      if (!res.location) throw new SourceError(`Redirect without Location from ${u.hostname}.`, u.hostname, res.status, "redirect");
      const next = new URL(res.location, u);
      checkPublicUrlShape(next.toString()); // SSRF check on every hop
      if (u.protocol === "https:" && next.protocol !== "https:") {
        throw new SourceError(`Refusing redirect from HTTPS to ${next.protocol.replace(":", "").toUpperCase()} (${next.hostname}).`, u.hostname, res.status, "refused");
      }
      current = new URL(res.location, u).toString();
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new SourceError(`Resource host '${u.hostname}' responded with HTTP ${res.status}.`, u.hostname, res.status, "http");
    }
    const stored = JSON.stringify({ body: res.body, finalUrl: current, contentType: res.contentType });
    const entry: CacheEntry = { body: stored, bytes: Buffer.byteLength(stored), hasParsed: false, storedAt: Date.now(), ttlMs, size: 0 };
    entry.size = entrySize(key, entry);
    cacheSet(key, entry);
    recordUpstream({ url: current, cacheStatus: "miss", retrievedAt: new Date(entry.storedAt).toISOString() });
    return { data: res.body, finalUrl: current, contentType: res.contentType, cacheStatus: "miss", retrievedAt: new Date(entry.storedAt).toISOString() };
  }
  throw new SourceError(`Too many redirects fetching ${url}.`, new URL(url).hostname, undefined, "redirect");
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

/** Current cache footprint (alias used by catalogue adapters and tests). */
export function cacheStats(): { entries: number; bytes: number; maxBytes: number } {
  return { entries: cache.size, bytes: cacheBytes, maxBytes: cfg.cacheMaxBytes };
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
