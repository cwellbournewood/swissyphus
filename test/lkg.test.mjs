/**
 * Offline tests for per-source max-stale windows (core/http.ts) and the on-disk
 * last-known-good store (core/lkg.ts). No network: globalThis.fetch is stubbed.
 *
 *   npm run build && node --test test/lkg.test.mjs
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fetchCached, fetchJson, sourceCache, SourceError, __resetForTests } from "../dist/core/http.js";
import { configureLkg, getLkgStats, lkgFlush } from "../dist/core/lkg.js";

const HOST = "api3.geo.admin.ch";
const BASE = `https://${HOST}`;
const realFetch = globalThis.fetch;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  return calls;
}

let dir;

beforeEach(() => {
  __resetForTests({ retryDelayMs: 1, breakerCooldownMs: 60 });
  dir = mkdtempSync(join(tmpdir(), "swissyphus-lkg-"));
  configureLkg(undefined);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  configureLkg(undefined);
  rmSync(dir, { recursive: true, force: true });
});

/** Simulate a process restart: memory cache gone, disk store re-indexed from the directory. */
function restart() {
  __resetForTests({ retryDelayMs: 1, breakerCooldownMs: 60 });
  configureLkg(dir);
}

// --- per-source max-stale -------------------------------------------------------

test("sourceCache: maps cacheTtlSeconds/maxStaleSeconds to ms options", () => {
  assert.deepEqual(sourceCache({ cacheTtlSeconds: 30 }), { ttlMs: 30_000 });
  assert.deepEqual(sourceCache({ cacheTtlSeconds: 30, maxStaleSeconds: 600 }), { ttlMs: 30_000, maxStaleMs: 600_000 });
});

test("max-stale: a short window stops stale-if-error earlier than the 24×TTL default", async () => {
  let up = true;
  stubFetch(() => (up ? new Response("live") : new Response("down", { status: 503 })));
  await fetchCached(`${BASE}/ms-short`, { ttlMs: 10, maxStaleMs: 20 });
  up = false;
  await sleep(40); // > maxStale (20), < 24×TTL (240)
  await assert.rejects(fetchCached(`${BASE}/ms-short`, { ttlMs: 10, maxStaleMs: 20 }), (err) => err.status === 503);
});

test("max-stale: a long window keeps serving stale data well past 24×TTL", async () => {
  let up = true;
  stubFetch(() => (up ? new Response("annual") : new Response("down", { status: 503 })));
  await fetchCached(`${BASE}/ms-long`, { ttlMs: 2, maxStaleMs: 10_000 });
  up = false;
  await sleep(80); // > 24×TTL (48)
  const r = await fetchCached(`${BASE}/ms-long`, { ttlMs: 2, maxStaleMs: 10_000 });
  assert.equal(r.cacheStatus, "stale");
  assert.equal(r.data, "annual");
});

test("max-stale: also caps the stale-while-revalidate window (no silently old data)", async () => {
  let v = 1;
  stubFetch(() => new Response(`v${v}`));
  await fetchCached(`${BASE}/ms-swr`, { ttlMs: 10, maxStaleMs: 15 });
  v = 2;
  await sleep(25); // past maxStale but inside 6×TTL (60)
  const r = await fetchCached(`${BASE}/ms-swr`, { ttlMs: 10, maxStaleMs: 15 });
  assert.equal(r.cacheStatus, "miss", "refetched synchronously instead of serving stale");
  assert.equal(r.data, "v2");
});

test("max-stale: never shorter than the TTL itself", async () => {
  stubFetch(() => new Response("x"));
  await fetchCached(`${BASE}/ms-floor`, { ttlMs: 10_000, maxStaleMs: 1 });
  await sleep(5);
  assert.equal((await fetchCached(`${BASE}/ms-floor`, { ttlMs: 10_000, maxStaleMs: 1 })).cacheStatus, "hit");
});

// --- last-known-good store ----------------------------------------------------------

test("lkg: disabled by default: nothing written, nothing restored", async () => {
  assert.equal(getLkgStats().enabled, false);
  stubFetch(() => new Response("x"));
  await fetchCached(`${BASE}/off`);
  await lkgFlush();
  assert.deepEqual(readdirSync(dir), []);
});

test("lkg: survives a restart: a failing source serves the on-disk copy as stale", async () => {
  configureLkg(dir);
  let up = true;
  const calls = stubFetch(() => (up ? new Response(JSON.stringify({ pop: 9_000_000 })) : new Response("down", { status: 503 })));
  const first = await fetchJson(`${BASE}/pop?year=2025`, { ttlMs: 50, maxStaleMs: 60_000 });
  await lkgFlush();
  assert.equal(getLkgStats().entries, 1);

  restart();
  up = false;
  const r = await fetchJson(`${BASE}/pop?year=2025`, { ttlMs: 50, maxStaleMs: 60_000 });
  assert.equal(r.cacheStatus, "stale");
  assert.deepEqual(r.data, first.data);
  assert.equal(r.retrievedAt, first.retrievedAt, "keeps the original retrieval time");
  assert.equal(typeof r.staleAgeSeconds, "number");

  // Restored into memory: the next call is served from memory, still marked stale.
  await sleep(60); // past the 50 ms TTL
  const n = calls.length;
  const again = await fetchJson(`${BASE}/pop?year=2025`, { ttlMs: 50, maxStaleMs: 60_000 });
  assert.equal(again.cacheStatus, "stale");
  assert.ok(calls.length <= n + 2, "at most one fresh attempt (+retry)");
});

test("lkg: fresh data always wins over the disk copy", async () => {
  configureLkg(dir);
  let v = "old";
  stubFetch(() => new Response(v));
  await fetchCached(`${BASE}/fresh`, { ttlMs: 50 });
  await lkgFlush();
  restart();
  v = "new";
  const r = await fetchCached(`${BASE}/fresh`, { ttlMs: 50 });
  assert.equal(r.cacheStatus, "miss");
  assert.equal(r.data, "new");
});

test("lkg: files don't contain the cache key (URL/query text) and are owner-only", async () => {
  configureLkg(dir);
  stubFetch(() => new Response("body"));
  await fetchCached(`${BASE}/search?q=Marktgasse%201%20Bern`);
  await lkgFlush();
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^[0-9a-f]{64}\.json$/);
  const text = readFileSync(join(dir, files[0]), "utf8");
  assert.doesNotMatch(text, /Marktgasse/);
  assert.doesNotMatch(text, /api3\.geo\.admin\.ch/);
});

test("lkg: expired entries (past max-stale) are not served and are deleted", async () => {
  configureLkg(dir);
  let up = true;
  stubFetch(() => (up ? new Response("short-lived") : new Response("down", { status: 503 })));
  await fetchCached(`${BASE}/exp`, { ttlMs: 5, maxStaleMs: 20 });
  await lkgFlush();
  await sleep(30);
  restart();
  up = false;
  await assert.rejects(fetchCached(`${BASE}/exp`, { ttlMs: 5, maxStaleMs: 20 }), (err) => err.status === 503);
  await sleep(10);
  assert.deepEqual(readdirSync(dir), []);
});

test("lkg: credentialed requests are never persisted", async () => {
  configureLkg(dir);
  stubFetch(() => new Response("secret-scoped"));
  await fetchCached(`${BASE}/auth`, { init: { headers: { Authorization: "Basic dTpw" } } });
  await fetchCached(`${BASE}/cookie`, { init: { headers: { Cookie: "a=b" } } });
  await lkgFlush();
  assert.deepEqual(readdirSync(dir), []);
});

test("lkg: noStore requests are never persisted", async () => {
  configureLkg(dir);
  stubFetch(() => new Response("huge"));
  await fetchCached(`${BASE}/nostore`, { noStore: true });
  await lkgFlush();
  assert.deepEqual(readdirSync(dir), []);
});

test("lkg: 4xx is not masked by the disk copy", async () => {
  configureLkg(dir);
  let mode = "ok";
  stubFetch(() => (mode === "ok" ? new Response("x") : new Response("gone", { status: 404 })));
  await fetchCached(`${BASE}/gone`, { ttlMs: 5 });
  await lkgFlush();
  restart();
  mode = "404";
  await assert.rejects(fetchCached(`${BASE}/gone`, { ttlMs: 5 }), (err) => err.status === 404);
});

test("lkg: a disk copy that fails validation is not served", async () => {
  configureLkg(dir);
  let up = true;
  stubFetch(() => (up ? new Response(JSON.stringify({ items: [1] })) : new Response("down", { status: 503 })));
  await fetchJson(`${BASE}/val`, { ttlMs: 5 });
  await lkgFlush();
  restart();
  up = false;
  await assert.rejects(
    fetchJson(`${BASE}/val`, { ttlMs: 5, validate: (d) => Array.isArray(d.items) && d.items.length > 1 }),
    (err) => err instanceof SourceError && err.status === 503,
  );
});

test("lkg: total size is bounded, oldest entries are evicted first", async () => {
  configureLkg(dir, 1_000);
  stubFetch((url) => new Response("x".repeat(300) + url));
  for (let i = 0; i < 10; i++) {
    await fetchCached(`${BASE}/b${i}`);
    await lkgFlush();
  }
  const stats = getLkgStats();
  assert.ok(stats.bytes <= 1_000, `bytes ${stats.bytes}`);
  assert.ok(stats.entries >= 1 && stats.entries < 10);
  await sleep(20);
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, stats.entries);
});

test("lkg: an unusable directory disables the store instead of failing", async () => {
  // A path *under a regular file* can never be created (ENOTDIR), on any OS.
  const file = join(dir, "not-a-dir");
  writeFileSync(file, "x");
  configureLkg(join(file, "lkg"));
  assert.equal(getLkgStats().enabled, false);
  stubFetch(() => new Response("ok"));
  assert.equal((await fetchCached(`${BASE}/nodisk`)).data, "ok");
});
