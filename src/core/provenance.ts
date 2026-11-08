/**
 * Request-level provenance: which upstream requests produced a tool answer.
 *
 * Every tool call runs inside a trace (AsyncLocalStorage, so it follows every
 * await). The fetch layer records each upstream request it answers — from the
 * network, the cache or the last-known-good store — and respond() writes the
 * list into the envelope as `provenance.upstream`. Together with `source`
 * (who publishes the data, under which licence) this answers "where exactly
 * did this come from, and how old is it?" for every response.
 *
 * Privacy and safety:
 * - Credentials never appear: URL user-info is dropped and query parameters
 *   whose names look like secrets (key, token, secret, password, auth…) are
 *   replaced with "REDACTED". Header credentials are never recorded at all.
 * - POST bodies are not recorded (only method and URL).
 * - URLs are truncated and the list is capped, so a response stays small.
 * The trace lives only for the duration of one call and is never stored.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { CacheStatus } from "./types.js";

export interface UpstreamRecord {
  url: string;
  method?: string;
  cache_status: CacheStatus;
  retrieved_at: string;
}

interface Trace {
  upstream: UpstreamRecord[];
  seen: Set<string>;
}

const MAX_RECORDS = 12;
const MAX_URL_CHARS = 300;
const SECRET_PARAM = /(key|token|secret|passw|auth|signature|sig$|credential|session)/i;

const store = new AsyncLocalStorage<Trace>();

/** Run fn with a fresh provenance trace (one per tool call). */
export function withProvenance<T>(fn: () => Promise<T>): Promise<T> {
  return store.run({ upstream: [], seen: new Set() }, fn);
}

/** URL safe to show: no user-info, secret-looking query values redacted, bounded length. */
export function publicUrl(raw: string): string {
  let out: string;
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    for (const name of [...u.searchParams.keys()]) {
      if (SECRET_PARAM.test(name)) u.searchParams.set(name, "REDACTED");
    }
    out = u.toString();
  } catch {
    return "(unparseable URL)";
  }
  return out.length > MAX_URL_CHARS ? `${out.slice(0, MAX_URL_CHARS - 1)}…` : out;
}

/** Record one upstream request for the current call (no-op outside a trace). */
export function recordUpstream(rec: { url: string; method?: string; cacheStatus: CacheStatus; retrievedAt: string }): void {
  const t = store.getStore();
  if (!t) return;
  const url = publicUrl(rec.url);
  const method = rec.method && rec.method.toUpperCase() !== "GET" ? rec.method.toUpperCase() : undefined;
  const id = `${method ?? "GET"} ${url}`;
  if (t.seen.has(id) || t.upstream.length >= MAX_RECORDS) return;
  t.seen.add(id);
  t.upstream.push({ url, ...(method ? { method } : {}), cache_status: rec.cacheStatus, retrieved_at: rec.retrievedAt });
}

/** Upstream requests recorded so far in the current call. */
export function currentUpstream(): UpstreamRecord[] {
  return store.getStore()?.upstream.slice() ?? [];
}
