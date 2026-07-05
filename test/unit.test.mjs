/**
 * Offline unit tests for Swissyphus pure logic — no network required.
 * Run against the compiled output:  npm test  (which builds first)
 *   node --test test/unit.test.mjs
 *
 * These cover the deterministic core (coordinate maths, the fetch cache's
 * helpers, key store, response envelope, module resolution) and the two
 * parsers/sanitizers that recently carried bugs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  wgs84ToLv95,
  lv95ToWgs84,
  distanceKm,
  isLikelyLv95,
  inSwitzerland,
} from "../dist/core/coords.js";
import { withParams } from "../dist/core/http.js";
import { respond } from "../dist/core/envelope.js";
import { hashKey, timingSafeEqualStr, KeyStore, TIER_LIMITS } from "../dist/core/keys.js";
import { resolveModules, PRESETS, ALL_MODULES } from "../dist/registry.js";
import { parseFdsnText } from "../dist/modules/earthquakes.js";
import { sanitizeLiteral } from "../dist/modules/law.js";

test("coords: WGS84 → LV95 matches the swisstopo reference origin (~1 m)", () => {
  // 46.951083°N, 7.438639°E is the LV95 fundamental point ≈ 2600000 / 1200000.
  const { easting, northing } = wgs84ToLv95(46.951083, 7.438639);
  assert.ok(Math.abs(easting - 2600000) < 1, `easting ${easting}`);
  assert.ok(Math.abs(northing - 1200000) < 1, `northing ${northing}`);
});

test("coords: LV95 ↔ WGS84 round-trips within a metre", () => {
  const start = { lat: 47.3769, lon: 8.5417 };
  const lv95 = wgs84ToLv95(start.lat, start.lon);
  const back = lv95ToWgs84(lv95.easting, lv95.northing);
  assert.ok(Math.abs(back.lat - start.lat) < 0.0001, `lat ${back.lat}`);
  assert.ok(Math.abs(back.lon - start.lon) < 0.0001, `lon ${back.lon}`);
});

test("coords: distanceKm Bern→Zürich ≈ 95 km", () => {
  const d = distanceKm(46.9481, 7.4474, 47.3769, 8.5417);
  assert.ok(d > 90 && d < 100, `got ${d}`);
});

test("coords: distanceKm identical points is zero", () => {
  assert.equal(distanceKm(47, 8, 47, 8), 0);
});

test("coords: isLikelyLv95 / inSwitzerland classifiers", () => {
  assert.equal(isLikelyLv95(2600000, 1200000), true);
  assert.equal(isLikelyLv95(8.5, 47.3), false);
  assert.equal(inSwitzerland(46.95, 7.44), true);
  assert.equal(inSwitzerland(48.85, 2.35), false); // Paris
});

test("http: withParams skips undefined and stringifies the rest", () => {
  const url = withParams("https://data.geo.admin.ch/x", { a: 1, b: undefined, c: "z", d: true });
  const u = new URL(url);
  assert.equal(u.searchParams.get("a"), "1");
  assert.equal(u.searchParams.get("c"), "z");
  assert.equal(u.searchParams.get("d"), "true");
  assert.equal(u.searchParams.has("b"), false);
});

test("envelope: respond carries data + attribution + freshness", () => {
  const res = respond(
    { hello: "world" },
    {
      source: {
        name: "Src",
        operator: "Op",
        url: "https://example.ch",
        licence: "OGD",
        attribution: "© Op",
      },
      cacheStatus: "miss",
      retrievedAt: "2026-01-01T00:00:00Z",
    },
  );
  const body = JSON.parse(res.content[0].text);
  assert.deepEqual(body.data, { hello: "world" });
  assert.equal(body.source.attribution, "© Op");
  assert.equal(body.cache_status, "miss");
  assert.equal(body.language, "en");
});

test("envelope: oversized payload degrades to VALID JSON (not a sliced fragment)", () => {
  const huge = Array.from({ length: 20000 }, (_, i) => ({ i, s: "x".repeat(20) }));
  const res = respond(huge, {
    source: { name: "S", operator: "O", url: "https://x.ch", licence: "L", attribution: "A" },
    cacheStatus: "miss",
    retrievedAt: "2026-01-01T00:00:00Z",
  });
  const text = res.content[0].text;
  assert.ok(text.length <= 51000, `still ${text.length}`);
  // The whole point of the fix: it must parse.
  const body = JSON.parse(text);
  assert.match(body.data.error, /exceeded the 50 KB cap/);
  assert.equal(body.source.attribution, "A");
});

test("keys: hashKey is deterministic 64-hex and hides the raw key", () => {
  const h = hashKey("sy_live_abc");
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, hashKey("sy_live_abc"));
  assert.notEqual(h, hashKey("sy_live_abd"));
});

test("keys: timingSafeEqualStr matches only equal strings", () => {
  assert.equal(timingSafeEqualStr("token", "token"), true);
  assert.equal(timingSafeEqualStr("token", "Token"), false);
  assert.equal(timingSafeEqualStr("token", "tokenlonger"), false);
});

test("keys: KeyStore create → get → revoke lifecycle + monthly metering", () => {
  const dir = mkdtempSync(join(tmpdir(), "sy-keys-"));
  const store = new KeyStore(dir);
  const { record, rawKey } = store.create("User@Example.com", "free");
  assert.match(rawKey, /^sy_live_[0-9a-f]{48}$/);
  assert.equal(record.email, "user@example.com"); // normalised

  assert.ok(store.get(rawKey), "active key resolves");
  assert.equal(store.findByEmail("user@example.com").length, 1);

  const q1 = store.meter(record);
  assert.equal(q1.used, 1);
  assert.equal(q1.quota, TIER_LIMITS.free.perMonth);
  assert.equal(q1.withinQuota, true);

  assert.equal(store.revoke(rawKey), true);
  assert.equal(store.get(rawKey), undefined, "revoked key no longer resolves");

  assert.equal(store.erase(rawKey), true);
  assert.equal(store.list().length, 0);
});

test("registry: presets resolve, always include meta, and reject unknowns", () => {
  const outdoor = resolveModules({ preset: "outdoor" }).map((m) => m.id);
  assert.ok(outdoor.includes("avalanche"));
  assert.ok(outdoor.includes("meta"), "meta auto-included when filtering");

  const picked = resolveModules({ modules: ["transport", "weather"] }).map((m) => m.id);
  assert.deepEqual(new Set(picked), new Set(["transport", "weather", "meta"]));

  assert.equal(resolveModules({}).length, ALL_MODULES.length, "no filter → all");
  assert.throws(() => resolveModules({ preset: "does-not-exist" }), /Unknown preset/);
  assert.throws(() => resolveModules({ modules: ["nope"] }), /Unknown module/);
  assert.ok(Object.keys(PRESETS).includes("full"));
});

test("earthquakes: parseFdsnText reads the 13 columns and omits event_type", () => {
  const sample =
    "smi:ch.ethz.sed/sc/Event/2026abcd|2026-07-01T12:00:00.0Z|46.8|9.8|5.2|SED|SED|SED|1|MLh|2.4|SED|Chur GR";
  const [q] = parseFdsnText(sample);
  assert.equal(q.event_id, "2026abcd");
  assert.equal(q.time, "2026-07-01T12:00:00.0Z");
  assert.deepEqual(q.wgs84, { lat: 46.8, lon: 9.8 });
  assert.equal(q.depth_km, 5.2);
  assert.equal(q.magnitude, 2.4);
  assert.equal(q.magnitude_type, "MLh");
  assert.equal(q.location, "Chur GR");
  assert.equal("event_type" in q, false, "fabricated event_type must not be surfaced");
});

test("earthquakes: parseFdsnText skips comments and short rows", () => {
  const text = "#EventID|Time|...\nsmi:x|t|46|9|1|A|C|C|1|ML|1.0|A"; // only 12 cols
  assert.equal(parseFdsnText(text).length, 0);
});

test("law: sanitizeLiteral neutralises SPARQL literal breakout and newlines", () => {
  assert.equal(sanitizeLiteral('data") } DROP ALL #'), "data DROP ALL");
  assert.equal(sanitizeLiteral("line1\nline2\tx"), "line1 line2 x");
  assert.equal(sanitizeLiteral("Datenschutz"), "Datenschutz");
  assert.ok(!sanitizeLiteral('a"b\\c').includes('"'));
  assert.ok(!sanitizeLiteral('a"b\\c').includes("\\"));
});
