/**
 * Offline tests for the outbound fetch + cache layer (src/core/http.ts) and the
 * response envelope (src/core/envelope.ts). No network: globalThis.fetch is
 * stubbed to simulate upstreams on allowlisted hostnames.
 *
 *   npm run build && node --test test/core-http.test.mjs
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  fetchCached,
  fetchJson,
  SourceError,
  getCircuitStates,
  getCacheStats,
  USER_AGENT,
  PACKAGE_VERSION,
  __resetForTests,
} from "../dist/core/http.js";
import { respond, toolError, errorToResult } from "../dist/core/envelope.js";

const HOST = "api3.geo.admin.ch";
const BASE = `https://${HOST}`;
const realFetch = globalThis.fetch;

/** Install a fetch stub; returns the list of recorded calls. */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  return calls;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function abortable(init) {
  return new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
  });
}

const source = {
  id: "t",
  name: "Test source",
  operator: "Op",
  url: "https://example.ch",
  licence: "OGD",
  attribution: "© Op",
  updateFrequency: "hourly",
  cacheTtlSeconds: 60,
};

beforeEach(() => {
  __resetForTests({ retryDelayMs: 1, breakerCooldownMs: 60 });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// --- identity --------------------------------------------------------------

test("http: User-Agent carries the package.json version and repo URL; caller UA wins", async () => {
  assert.match(PACKAGE_VERSION, /^\d+\.\d+\.\d+/);
  assert.notEqual(PACKAGE_VERSION, "0.0.0");
  assert.equal(USER_AGENT, `swissyphus/${PACKAGE_VERSION} (MCP server; +https://github.com/cwellbournewood/swissyphus)`);
  const calls = stubFetch(() => new Response("ok"));
  await fetchCached(`${BASE}/ua1`);
  assert.equal(new Headers(calls[0].init.headers).get("user-agent"), USER_AGENT);
  await fetchCached(`${BASE}/ua2`, { init: { headers: { "User-Agent": "custom" } } });
  assert.equal(new Headers(calls[1].init.headers).get("user-agent"), "custom");
});

// --- S6: redirects -------------------------------------------------------------

test("redirect: to a non-allowlisted host is refused and not followed", async () => {
  const calls = stubFetch(() => new Response(null, { status: 302, headers: { Location: "https://evil.example.com/steal" } }));
  await assert.rejects(fetchCached(`${BASE}/r1`), (err) => {
    assert.ok(err instanceof SourceError);
    assert.equal(err.reason, "refused");
    assert.match(err.message, /allowlist/);
    return true;
  });
  assert.equal(calls.length, 1, "must not contact the redirect target");
  assert.equal(calls[0].init.redirect, "manual");
});

test("redirect: relative and cross-host allowlisted redirects are followed", async () => {
  const calls = stubFetch((url) => {
    if (url === `${BASE}/old`) return new Response(null, { status: 301, headers: { Location: "/new?x=1" } });
    if (url === `${BASE}/new?x=1`) return new Response(null, { status: 307, headers: { Location: "https://data.geo.admin.ch/final" } });
    if (url === "https://data.geo.admin.ch/final") return new Response("final-body");
    return new Response("unexpected", { status: 500 });
  });
  const r = await fetchCached(`${BASE}/old`);
  assert.equal(r.data, "final-body");
  assert.deepEqual(
    calls.map((c) => c.url),
    [`${BASE}/old`, `${BASE}/new?x=1`, "https://data.geo.admin.ch/final"],
  );
});

test("redirect: 303 after POST switches to GET without body", async () => {
  const calls = stubFetch((url) =>
    url.endsWith("/post")
      ? new Response(null, { status: 303, headers: { Location: "/result" } })
      : new Response("done"),
  );
  await fetchCached(`${BASE}/post`, { init: { method: "POST", body: "q=1", headers: { "Content-Type": "text/plain" } } });
  assert.equal(calls[1].init.method, "GET");
  assert.equal(calls[1].init.body, undefined);
  assert.equal(new Headers(calls[1].init.headers).get("content-type"), null);
});

test("redirect: HTTPS → HTTP downgrade is refused", async () => {
  const calls = stubFetch(() => new Response(null, { status: 302, headers: { Location: `http://${HOST}/plain` } }));
  await assert.rejects(fetchCached(`${BASE}/dg`), (err) => err instanceof SourceError && /HTTPS to HTTP/.test(err.message));
  assert.equal(calls.length, 1);
});

test("redirect: more than 5 hops is an error", async () => {
  const calls = stubFetch((url, _init, n) => new Response(null, { status: 302, headers: { Location: `/hop${n}` } }));
  await assert.rejects(fetchCached(`${BASE}/loop`), (err) => err instanceof SourceError && /redirected more than 5/.test(err.message));
  assert.equal(calls.length, 6);
});

// --- byte cap ---------------------------------------------------------------------

test("byte cap: a streamed body over maxBytes is aborted with SourceError", async () => {
  let pulled = 0;
  stubFetch(
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            pulled++;
            controller.enqueue(new Uint8Array(1024));
            if (pulled > 1000) controller.close();
          },
        }),
      ),
  );
  await assert.rejects(fetchCached(`${BASE}/big`, { maxBytes: 4096 }), (err) => {
    assert.ok(err instanceof SourceError);
    assert.equal(err.reason, "too_large");
    return true;
  });
  assert.ok(pulled < 20, `stopped reading early (pulled ${pulled} chunks)`);
});

test("byte cap: declared Content-Length over the cap is refused before reading", async () => {
  stubFetch(() => new Response("x".repeat(100), { headers: { "Content-Length": "999999999" } }));
  await assert.rejects(fetchCached(`${BASE}/declared`, { maxBytes: 1000 }), (err) => err.reason === "too_large");
});

test("byte cap: bodies under the cap are returned intact (UTF-8)", async () => {
  stubFetch(() => new Response("Zürich – Genève"));
  const r = await fetchCached(`${BASE}/small`, { maxBytes: 1000 });
  assert.equal(r.data, "Zürich – Genève");
});

// --- timeouts / network errors ----------------------------------------------------

test("timeout: surfaces as SourceError 'timed out'; GET is retried once", async () => {
  const calls = stubFetch((_url, init) => abortable(init));
  await assert.rejects(fetchCached(`${BASE}/slow`, { timeoutMs: 20 }), (err) => {
    assert.ok(err instanceof SourceError);
    assert.equal(err.reason, "timeout");
    assert.match(err.message, /timed out/);
    return true;
  });
  assert.equal(calls.length, 2);
});

test("timeout: POST with a body is NOT retried (no expensive query twice)", async () => {
  const calls = stubFetch((_url, init) => abortable(init));
  await assert.rejects(
    fetchCached(`https://lindas.admin.ch/query`, { timeoutMs: 20, init: { method: "POST", body: "query=SELECT" } }),
    (err) => err instanceof SourceError && err.reason === "timeout",
  );
  assert.equal(calls.length, 1);
});

test("network failure: SourceError 'unreachable', retried once, maps to kind 'unavailable'", async () => {
  const calls = stubFetch(() => {
    throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
  });
  let caught;
  await assert.rejects(fetchCached(`${BASE}/down`), (err) => {
    caught = err;
    return err instanceof SourceError && err.reason === "unreachable" && /unreachable \(ECONNREFUSED\)/.test(err.message);
  });
  assert.equal(calls.length, 2);
  const body = JSON.parse(errorToResult(caught, "Test").content[0].text);
  assert.equal(body.kind, "unavailable");
  assert.match(body.error, /currently unavailable/);
});

test("retry: 429 with a long Retry-After is not retried; 5xx is retried once", async () => {
  let calls = stubFetch(() => new Response("slow down", { status: 429, headers: { "Retry-After": "10" } }));
  await assert.rejects(fetchCached(`${BASE}/rl`), (err) => err.status === 429);
  assert.equal(calls.length, 1);

  calls = stubFetch((_u, _i, n) => (n === 1 ? new Response("oops", { status: 502 }) : new Response("recovered")));
  const r = await fetchCached(`${BASE}/flaky`);
  assert.equal(r.data, "recovered");
  assert.equal(calls.length, 2);

  calls = stubFetch(() => new Response("nope", { status: 404 }));
  await assert.rejects(fetchCached(`${BASE}/missing`), (err) => err.status === 404);
  assert.equal(calls.length, 1, "4xx is not retried");
});

// --- single-flight ------------------------------------------------------------------

test("single-flight: 100 concurrent misses for one key → 1 upstream fetch", async () => {
  const calls = stubFetch(async () => {
    await sleep(20);
    return new Response(JSON.stringify({ n: 1 }));
  });
  const results = await Promise.all(Array.from({ length: 100 }, () => fetchJson(`${BASE}/sf`)));
  assert.equal(calls.length, 1);
  assert.ok(results.every((r) => r.data === results[0].data), "all callers share the same parsed object");
  assert.ok(results.every((r) => r.cacheStatus === "miss"));
});

test("single-flight: failures are shared too, and the next call refetches", async () => {
  const calls = stubFetch(async () => {
    await sleep(10);
    return new Response("nope", { status: 404 });
  });
  const settled = await Promise.allSettled(Array.from({ length: 10 }, () => fetchCached(`${BASE}/sf404`)));
  assert.ok(settled.every((s) => s.status === "rejected"));
  assert.equal(calls.length, 1);
  await assert.rejects(fetchCached(`${BASE}/sf404`));
  assert.equal(calls.length, 2);
});

// --- SWR + stale-if-error --------------------------------------------------------------

test("stale-while-revalidate: stale body served, one background refresh", async () => {
  let version = 1;
  const calls = stubFetch(async () => {
    await sleep(5);
    return new Response(`v${version}`);
  });
  await fetchCached(`${BASE}/swr`, { ttlMs: 30 });
  version = 2;
  await sleep(40); // past TTL, inside 6×TTL
  const [a, b] = await Promise.all([fetchCached(`${BASE}/swr`, { ttlMs: 30 }), fetchCached(`${BASE}/swr`, { ttlMs: 30 })]);
  assert.equal(a.cacheStatus, "stale");
  assert.equal(a.data, "v1");
  assert.equal(b.data, "v1");
  assert.ok(typeof a.staleAgeSeconds === "number");
  await sleep(20);
  assert.equal(calls.length, 2, "revalidation deduped");
  const c = await fetchCached(`${BASE}/swr`, { ttlMs: 30 });
  assert.equal(c.cacheStatus, "hit");
  assert.equal(c.data, "v2");
});

test("stale-if-error: past the SWR window, a failing source serves the old body as stale", async () => {
  let up = true;
  stubFetch(() => (up ? new Response(JSON.stringify({ ok: 1 })) : new Response("down", { status: 503 })));
  const first = await fetchJson(`${BASE}/sie`, { ttlMs: 10 });
  up = false;
  await sleep(80); // > 6×TTL, < 24×TTL
  const r = await fetchJson(`${BASE}/sie`, { ttlMs: 10 });
  assert.equal(r.cacheStatus, "stale");
  assert.equal(r.data, first.data);
  assert.equal(r.retrievedAt, first.retrievedAt);
  assert.equal(typeof r.staleAgeSeconds, "number");
});

test("fetchJson validate: an implausible body is never cached, and the last good body is served stale", async () => {
  let body = JSON.stringify({ payload: { a: 1 } });
  const calls = stubFetch(() => new Response(body));
  const valid = (d) => Object.keys(d?.payload ?? {}).length > 0;
  const first = await fetchJson(`${BASE}/val`, { ttlMs: 10, validate: valid });
  assert.deepEqual(first.data, { payload: { a: 1 } });
  body = JSON.stringify({ payload: {} });
  await sleep(80); // past the SWR window → a real refetch
  const r = await fetchJson(`${BASE}/val`, { ttlMs: 10, validate: valid });
  assert.equal(r.cacheStatus, "stale", "empty upstream answer falls back to the good copy");
  assert.deepEqual(r.data, { payload: { a: 1 } });

  // Cold cache: the implausible body is a transient unavailable error and is not stored.
  await assert.rejects(fetchJson(`${BASE}/val-cold`, { ttlMs: 10_000, validate: valid }), (err) => {
    assert.ok(err instanceof SourceError);
    assert.equal(err.reason, "invalid_response");
    assert.match(err.message, /empty or unrecognised/);
    return true;
  });
  body = JSON.stringify({ payload: { b: 2 } });
  const n = calls.length;
  const ok = await fetchJson(`${BASE}/val-cold`, { ttlMs: 10_000, validate: valid });
  assert.equal(calls.length, n + 1, "the empty answer was not cached");
  assert.equal(ok.cacheStatus, "miss");
});

test("stale-if-error: 4xx is not masked by stale data; too old entries are dropped", async () => {
  let mode = "ok";
  stubFetch(() =>
    mode === "ok" ? new Response("body") : mode === "404" ? new Response("gone", { status: 404 }) : new Response("x", { status: 503 }),
  );
  await fetchCached(`${BASE}/sie2`, { ttlMs: 5 });
  mode = "404";
  await sleep(40);
  await assert.rejects(fetchCached(`${BASE}/sie2`, { ttlMs: 5 }), (err) => err.status === 404);

  await fetchCached(`${BASE}/sie3`, { ttlMs: 2 }).catch(() => undefined);
  mode = "ok";
  await fetchCached(`${BASE}/sie4`, { ttlMs: 2 });
  mode = "503";
  await sleep(60); // > 24×TTL
  await assert.rejects(fetchCached(`${BASE}/sie4`, { ttlMs: 2 }), (err) => err.status === 503);
});

// --- cache hygiene ---------------------------------------------------------------------

test("cache: true LRU bounded by bytes (a hit refreshes recency)", async () => {
  __resetForTests({ retryDelayMs: 1, cacheMaxBytes: 1000 });
  const calls = stubFetch(() => new Response("x".repeat(400)));
  await fetchCached(`${BASE}/A`);
  await fetchCached(`${BASE}/B`);
  assert.equal((await fetchCached(`${BASE}/A`)).cacheStatus, "hit"); // A is now most recent
  await fetchCached(`${BASE}/C`); // evicts B (least recently used), not A
  assert.equal(calls.length, 3);
  assert.ok(getCacheStats().bytes <= 1000);
  assert.equal((await fetchCached(`${BASE}/A`)).cacheStatus, "hit");
  assert.equal((await fetchCached(`${BASE}/B`)).cacheStatus, "miss");
  assert.equal(calls.length, 4);
});

test("cache: entry-count bound still applies", async () => {
  __resetForTests({ retryDelayMs: 1, cacheMaxEntries: 3 });
  stubFetch(() => new Response("y"));
  for (let i = 0; i < 10; i++) await fetchCached(`${BASE}/e${i}`);
  assert.equal(getCacheStats().entries, 3);
});

// --- parsed-object cache -----------------------------------------------------------------

test("fetchJson: cache hits return the memoized parsed object (no re-parse)", async () => {
  const calls = stubFetch(() => new Response(JSON.stringify({ items: [1, 2, 3] })));
  const a = await fetchJson(`${BASE}/json`);
  const origParse = JSON.parse;
  let parses = 0;
  JSON.parse = (...args) => {
    parses++;
    return origParse(...args);
  };
  try {
    const b = await fetchJson(`${BASE}/json`);
    assert.equal(b.cacheStatus, "hit");
    assert.equal(b.data, a.data, "same object identity");
    assert.equal(parses, 0);
  } finally {
    JSON.parse = origParse;
  }
  assert.equal(calls.length, 1);
  assert.equal(new Headers(calls[0].init.headers).get("accept"), "application/json");
});

test("fetchJson: non-JSON body is a SourceError and is not cached", async () => {
  const calls = stubFetch(() => new Response("<html>maintenance</html>"));
  await assert.rejects(fetchJson(`${BASE}/html`), (err) => err instanceof SourceError && /non-JSON/.test(err.message));
  await assert.rejects(fetchJson(`${BASE}/html`));
  assert.equal(calls.length, 2);
});

test("fetchJson after fetchCached on the same key parses lazily once", async () => {
  const calls = stubFetch(() => new Response('{"a":1}'));
  await fetchCached(`${BASE}/mixed`);
  const x = await fetchJson(`${BASE}/mixed`);
  const y = await fetchJson(`${BASE}/mixed`);
  assert.deepEqual(x.data, { a: 1 });
  assert.equal(x.data, y.data);
  assert.equal(calls.length, 1);
});

// --- circuit breaker ----------------------------------------------------------------------

test("circuit breaker: opens after 5 failures, fails fast, half-open probe closes it", async () => {
  let healthy = false;
  const calls = stubFetch(() => (healthy ? new Response("ok") : new Response("err", { status: 500 })));
  for (let i = 0; i < 5; i++) {
    await assert.rejects(fetchCached(`${BASE}/cb${i}`), (err) => err.status === 500);
  }
  assert.equal(getCircuitStates()[HOST].state, "open");
  const before = calls.length;
  await assert.rejects(fetchCached(`${BASE}/cb-fast`), (err) => err instanceof SourceError && err.reason === "circuit_open");
  assert.equal(calls.length, before, "open circuit makes no upstream call");

  // Other hosts are unaffected.
  healthy = true;
  assert.equal((await fetchCached("https://data.geo.admin.ch/other")).data, "ok");

  // Cooldown → half-open: a failing probe re-opens immediately.
  healthy = false;
  await sleep(70);
  assert.equal(getCircuitStates()[HOST].state, "half_open");
  await assert.rejects(fetchCached(`${BASE}/probe1`), (err) => err.status === 500);
  assert.equal(getCircuitStates()[HOST].state, "open");

  // Next cooldown → a successful probe closes the circuit; concurrent requests fail fast meanwhile.
  healthy = true;
  await sleep(70);
  const probe = fetchCached(`${BASE}/probe2`);
  await assert.rejects(fetchCached(`${BASE}/during-probe`), (err) => err.reason === "circuit_open");
  assert.equal((await probe).data, "ok");
  assert.equal(getCircuitStates()[HOST], undefined, "healthy host drops out of the snapshot");
  assert.equal((await fetchCached(`${BASE}/after`)).data, "ok");
});

test("circuit breaker: open circuit serves stale data when available", async () => {
  let healthy = true;
  stubFetch(() => (healthy ? new Response("cached") : new Response("err", { status: 503 })));
  await fetchCached(`${BASE}/cbstale`, { ttlMs: 5 });
  healthy = false;
  for (let i = 0; i < 5; i++) await fetchCached(`${BASE}/cbx${i}`).catch(() => undefined);
  assert.equal(getCircuitStates()[HOST].state, "open");
  await sleep(40); // past SWR window for the 5 ms entry
  const r = await fetchCached(`${BASE}/cbstale`, { ttlMs: 5 });
  assert.equal(r.cacheStatus, "stale");
  assert.equal(r.data, "cached");
});

test("circuit breaker: 4xx answers do not count as host failures", async () => {
  stubFetch(() => new Response("nope", { status: 404 }));
  for (let i = 0; i < 8; i++) await fetchCached(`${BASE}/nf${i}`).catch(() => undefined);
  assert.equal(getCircuitStates()[HOST], undefined);
});

// --- concurrency cap --------------------------------------------------------------------

test("per-host concurrency cap queues excess requests", async () => {
  __resetForTests({ retryDelayMs: 1, perHostConcurrency: 2 });
  let active = 0;
  let peak = 0;
  stubFetch(async () => {
    active++;
    peak = Math.max(peak, active);
    await sleep(10);
    active--;
    return new Response("ok");
  });
  const results = await Promise.all(Array.from({ length: 7 }, (_, i) => fetchCached(`${BASE}/cc${i}`)));
  assert.equal(results.length, 7);
  assert.equal(peak, 2);
});

// --- envelope -----------------------------------------------------------------------------

test("envelope: respond emits compact JSON", () => {
  const res = respond({ a: [1, 2], b: { c: "d" } }, { source, cacheStatus: "miss", retrievedAt: "2026-01-01T00:00:00Z" });
  const text = res.content[0].text;
  assert.ok(!text.includes("\n"));
  assert.equal(text, JSON.stringify(JSON.parse(text)));
  const body = JSON.parse(text);
  assert.equal(body.stale_age_seconds, undefined);
  assert.equal(body.notes, undefined);
});

test("envelope: stale data older than the TTL gets an age field and a note", () => {
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const body = JSON.parse(
    respond({}, { source, cacheStatus: "stale", retrievedAt: twoHoursAgo, notes: "Existing note." }).content[0].text,
  );
  assert.ok(Math.abs(body.stale_age_seconds - 7200) <= 2);
  assert.match(body.notes, /^Existing note\. Served from cache: this data was retrieved 2 h ago/);
  const explicit = JSON.parse(
    respond({}, { source, cacheStatus: "stale", retrievedAt: twoHoursAgo, staleAgeSeconds: 30 }).content[0].text,
  );
  assert.equal(explicit.stale_age_seconds, 30);
  assert.equal(explicit.notes, undefined, "within TTL: no note");
});

test("envelope: toolError is compact and carries an optional kind", () => {
  const plain = toolError("Nothing found", ["try X"]);
  assert.equal(plain.isError, true);
  assert.ok(!plain.content[0].text.includes("\n"));
  assert.deepEqual(JSON.parse(plain.content[0].text), { error: "Nothing found", suggestions: ["try X"] });

  for (const kind of ["invalid_input", "not_found", "unavailable"]) {
    const body = JSON.parse(toolError("e", [], { kind }).content[0].text);
    assert.equal(body.kind, kind);
    assert.equal(body.suggestions, undefined);
  }

  const src = JSON.parse(errorToResult(new SourceError("boom", HOST, 502, "http"), "Src").content[0].text);
  assert.equal(src.kind, "unavailable");
  const abort = JSON.parse(errorToResult(new DOMException("aborted", "AbortError"), "Src").content[0].text);
  assert.equal(abort.kind, "unavailable");
  const other = JSON.parse(errorToResult(new Error("bug"), "Src").content[0].text);
  assert.equal(other.kind, "unavailable", "shape drift is an upstream problem, not bad input");
  assert.match(other.error, /Unexpected error/);
});

// --- noStore (large payloads indexed by the caller) --------------------------

test("noStore: body is not kept in the shared cache, but concurrent callers still share one fetch", async () => {
  const calls = stubFetch(async () => {
    await sleep(5);
    return new Response("big");
  });
  const [a, b] = await Promise.all([
    fetchCached(`${BASE}/huge`, { noStore: true }),
    fetchCached(`${BASE}/huge`, { noStore: true }),
  ]);
  assert.equal(a.data, "big");
  assert.equal(b.data, "big");
  assert.equal(calls.length, 1, "single-flight still coalesces");
  await fetchCached(`${BASE}/huge`, { noStore: true });
  assert.equal(calls.length, 2, "nothing was cached, so the next call refetches");
});

test("errorToResult: unexpected errors are classified as unavailable", () => {
  const r = errorToResult(new TypeError("Cannot read properties of undefined"), "Test source");
  const body = JSON.parse(r.content[0].text);
  assert.equal(body.kind, "unavailable");
});
