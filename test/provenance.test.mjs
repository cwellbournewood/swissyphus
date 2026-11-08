/**
 * Offline tests for request-level provenance (core/provenance.ts): every tool
 * answer lists the upstream requests behind it, credentials never leak, and
 * data_as_of is the publisher's timestamp or null — never the fetch time.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { fetchJson, __resetForTests } from "../dist/core/http.js";
import { respond } from "../dist/core/envelope.js";
import { invokeTool } from "../dist/core/invoke.js";
import { publicUrl, recordUpstream, currentUpstream, withProvenance } from "../dist/core/provenance.js";
import { coordsModule } from "../dist/modules/coordsModule.js";

const realFetch = globalThis.fetch;
const SOURCE = {
  id: "t", name: "Test source", operator: "Test office", url: "https://api3.geo.admin.ch",
  licence: "OGD", attribution: "© Test", updateFrequency: "daily", cacheTtlSeconds: 60,
};
const body = (r) => JSON.parse(r.content[0].text);

beforeEach(() => {
  __resetForTests({ retryDelayMs: 1, breakerCooldownMs: 60 });
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: 1 }), { headers: { "content-type": "application/json" } });
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function toolFetching(urls) {
  return {
    name: "t_fetch",
    handler: async () => {
      let r;
      for (const u of urls) r = await fetchJson(u, { ttlMs: 60_000 });
      return respond({ n: urls.length }, { source: SOURCE, cacheStatus: r.cacheStatus, retrievedAt: r.retrievedAt });
    },
  };
}

test("provenance: each upstream request of a call is listed with its cache status and fetch time", async () => {
  const a = "https://api3.geo.admin.ch/rest/services/a?q=Bern";
  const b = "https://api3.geo.admin.ch/rest/services/b?q=Lugano";
  const first = body(await invokeTool(toolFetching([a, b]), {}));
  assert.deepEqual(first.provenance.upstream.map((u) => [u.url, u.cache_status]), [[a, "miss"], [b, "miss"]]);
  assert.ok(first.provenance.upstream.every((u) => !Number.isNaN(Date.parse(u.retrieved_at))));

  // Second call: answered from cache, and says so per request.
  const second = body(await invokeTool(toolFetching([a, a]), {}));
  assert.deepEqual(second.provenance.upstream.map((u) => [u.url, u.cache_status]), [[a, "hit"]], "deduplicated");
  assert.equal(second.provenance.upstream[0].retrieved_at, first.provenance.upstream[0].retrieved_at, "fetch time of the cached body");
});

test("provenance: traces are per call (concurrent calls do not mix)", async () => {
  const [x, y] = await Promise.all([
    invokeTool(toolFetching(["https://api3.geo.admin.ch/x"]), {}),
    invokeTool(toolFetching(["https://api3.geo.admin.ch/y"]), {}),
  ]);
  assert.deepEqual(body(x).provenance.upstream.map((u) => u.url), ["https://api3.geo.admin.ch/x"]);
  assert.deepEqual(body(y).provenance.upstream.map((u) => u.url), ["https://api3.geo.admin.ch/y"]);
});

test("provenance: credentials never appear (user-info and secret-looking query values redacted)", () => {
  const u = publicUrl("https://user:pw@example.ch/api?api_key=S3CRET&token=T0K&query=Bern&Signature=abc");
  assert.ok(!/S3CRET|T0K|pw@|user@|abc/.test(u), u);
  assert.match(u, /query=Bern/);
  assert.match(u, /api_key=REDACTED/);
  assert.ok(publicUrl(`https://example.ch/?q=${"x".repeat(1000)}`).length <= 300);
});

test("provenance: no trace outside a tool call, and the list is capped", async () => {
  recordUpstream({ url: "https://example.ch/a", cacheStatus: "miss", retrievedAt: new Date().toISOString() });
  assert.deepEqual(currentUpstream(), []);
  await withProvenance(async () => {
    for (let i = 0; i < 30; i++) recordUpstream({ url: `https://example.ch/${i}`, cacheStatus: "miss", retrievedAt: "2026-01-01T00:00:00Z" });
    assert.equal(currentUpstream().length, 12);
  });
});

test("envelope: data_as_of is the publisher's timestamp, or null when unknown (never the fetch time)", async () => {
  const computed = body(await invokeTool(coordsModule.tools.find((t) => t.name === "convert_wgs84_to_lv95"), { lat: 46.95, lon: 7.44 }));
  assert.equal(computed.data_as_of, null);
  assert.equal(computed.provenance, undefined, "offline computation: no upstream request");
  assert.ok(computed.retrieved_at);

  const known = body(respond({}, { source: SOURCE, cacheStatus: "hit", retrievedAt: "2026-11-08T10:00:00Z", dataAsOf: "2026-11-08T09:50:00Z" }));
  assert.equal(known.data_as_of, "2026-11-08T09:50:00Z");
});
