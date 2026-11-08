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
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  wgs84ToLv95,
  lv95ToWgs84,
  distanceKm,
  isLikelyLv95,
  inSwitzerland,
  byDistance,
} from "../dist/core/coords.js";
import { withParams } from "../dist/core/http.js";
import { respond } from "../dist/core/envelope.js";
import { hashKey, timingSafeEqualStr, KeyStore, TIER_LIMITS } from "../dist/core/keys.js";
import { resolveModules, PRESETS, ALL_MODULES, HOSTED_EXCLUDED } from "../dist/registry.js";
import { VERSION } from "../dist/server.js";
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

test("coords: byDistance sorts nearest-first and annotates distance_km", () => {
  const items = [
    { name: "Zürich", wgs84: { lat: 47.3769, lon: 8.5417 } },
    { name: "Bern", wgs84: { lat: 46.9481, lon: 7.4474 } },
    { name: "Nowhere", wgs84: undefined },
  ];
  const from = { lat: 46.9481, lon: 7.4474 }; // Bern
  const out = byDistance(items, from, (s) => s.wgs84);
  assert.equal(out[0].name, "Bern");
  assert.equal(out[0].distance_km, 0);
  assert.equal(out[1].name, "Zürich");
  assert.ok(out[1].distance_km > 90 && out[1].distance_km < 100);
  assert.equal(out[2].name, "Nowhere", "coordless item sorts last");
  assert.equal(out[2].distance_km, undefined);
});

test("coords: byDistance with no origin preserves order, distance undefined", () => {
  const items = [{ id: 1, wgs84: { lat: 47, lon: 8 } }, { id: 2, wgs84: undefined }];
  const out = byDistance(items, undefined, (s) => s.wgs84);
  assert.deepEqual(out.map((x) => x.id), [1, 2]);
  assert.ok(out.every((x) => x.distance_km === undefined));
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
  // The full publicID is kept so get_earthquake_details can resolve it on any
  // SeisComP instance; the short form is for display only.
  assert.equal(q.event_id, "smi:ch.ethz.sed/sc/Event/2026abcd");
  assert.equal(q.event_id_short, "2026abcd");
  assert.equal(q.time, "2026-07-01T12:00:00.0Z");
  assert.deepEqual(q.wgs84, { lat: 46.8, lon: 9.8 });
  assert.equal(q.depth_km, 5.2);
  assert.equal(q.magnitude, 2.4);
  assert.equal(q.magnitude_type, "MLh");
  assert.equal(q.location, "Chur GR");
  assert.equal("event_type" in q, false, "fabricated event_type must not be surfaced");
});

test("earthquakes: parseFdsnText exposes event_type only from a real 14th EventType column", () => {
  const header =
    "#EventID|Time|Latitude|Longitude|Depth/km|Author|Catalog|Contributor|ContributorID|MagType|Magnitude|MagAuthor|EventLocationName|EventType";
  const row =
    "smi:ch.ethz.sed/sc25a/Event/2026efgh|2026-07-02T08:00:00.0Z|47.1|7.9|0.0|SED|SED|SED|2|MLh|1.1|SED|Quarry X|quarry blast";
  const [q] = parseFdsnText(`${header}\n${row}`);
  assert.equal(q.event_type, "quarry blast", "the upstream value is passed through, never defaulted");
  // An empty magnitude is null, not M0.0.
  const [q2] = parseFdsnText("smi:x/Event/1|2026-07-03T00:00:00Z|46|8|3|A|C|C|1|||A|Somewhere");
  assert.equal(q2.magnitude, null);
  assert.equal("event_type" in q2, false);
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

// ── MCP Bundle manifest (manifest.json) ───────────────────────────────────
// The committed manifest.json is generated from the module registry
// (src/scripts/manifest.ts). These tests keep it honest: if a tool is added,
// renamed or removed and the manifest isn't regenerated (`npm run manifest`),
// the bijection assertion below fails.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(repoRoot, "manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));

test("manifest: has the MCPB-required shape (spec manifest_version 0.3)", () => {
  assert.equal(manifest.manifest_version, "0.3");
  assert.equal(manifest.name, "swissyphus");
  assert.ok(manifest.description, "description is required");
  assert.equal(typeof manifest.author?.name, "string");
  assert.equal(manifest.server?.type, "node");
  assert.equal(manifest.server?.entry_point, "dist/index.js");
  assert.equal(manifest.server?.mcp_config?.command, "node");
  assert.ok(
    manifest.server.mcp_config.args.includes("${__dirname}/dist/index.js"),
    "entry point must be launched via the ${__dirname} bundle variable",
  );
});

test("manifest: version tracks package.json and the server VERSION", () => {
  assert.equal(manifest.version, VERSION);
  assert.equal(manifest.version, pkg.version);
});

test("manifest: tool list is a bijection with the registry (must be regenerated on tool changes)", () => {
  const registryTools = ALL_MODULES.flatMap((m) => m.tools.map((t) => t.name)).sort();
  const manifestTools = manifest.tools.map((t) => t.name).sort();
  assert.deepEqual(
    manifestTools,
    registryTools,
    "manifest.json is stale — run `npm run manifest`",
  );
  // Every manifest tool must carry a description (host UI shows it).
  for (const t of manifest.tools) assert.ok(t.description, `tool ${t.name} missing description`);
});

test("manifest: preset user_config default is a real preset", () => {
  const def = manifest.user_config?.preset?.default;
  assert.ok(def, "preset user_config must declare a default");
  assert.ok(def in PRESETS, `default preset '${def}' is not a known preset`);
});

test("registry: hosted preset is full minus modules with unresolved redistribution terms", () => {
  const hosted = new Set(PRESETS["hosted"]);
  for (const id of Object.keys(HOSTED_EXCLUDED)) {
    assert.ok(ALL_MODULES.some((m) => m.id === id), `excluded module '${id}' exists`);
    assert.ok(!hosted.has(id), `'${id}' is not hosted`);
  }
  assert.equal(hosted.size, ALL_MODULES.length - Object.keys(HOSTED_EXCLUDED).length);
  assert.ok(hosted.has("meta") && hosted.has("sanctions") && hosted.has("transport"));
});

test("server.json (MCP Registry) matches package.json and the preset list", async () => {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const server = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
  assert.equal(server.name, pkg.mcpName, "server.json name = package.json mcpName");
  assert.equal(server.version, pkg.version);
  const npm = server.packages.find((p) => p.registryType === "npm");
  assert.equal(npm.identifier, pkg.name);
  assert.equal(npm.version, pkg.version);
  const oci = server.packages.find((p) => p.registryType === "oci");
  assert.ok(oci.identifier.endsWith(`:v${pkg.version}`), oci.identifier);
  assert.ok(server.description.length <= 100);
  const choices = npm.packageArguments.find((a) => a.name === "--preset").choices;
  assert.deepEqual([...choices].sort(), Object.keys(PRESETS).filter((p) => p !== "hosted").sort());
});

test("compactToolList keeps $schema where draft-07 and 2020-12 differ, and non-default execution", async () => {
  const { compactToolList } = await import("../dist/server.js");
  const out = compactToolList({
    tools: [
      { name: "a", inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { x: { type: "string" } } }, execution: { taskSupport: "forbidden" } },
      { name: "b", inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { t: { type: "array", items: [{ type: "string" }] } } }, execution: { taskSupport: "optional" } },
      { name: "c", inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", definitions: { d: { type: "string" } } } },
    ],
  });
  assert.equal(out.tools[0].inputSchema.$schema, undefined);
  assert.equal(out.tools[0].execution, undefined);
  assert.ok(out.tools[1].inputSchema.$schema, "tuple items keep the dialect");
  assert.deepEqual(out.tools[1].execution, { taskSupport: "optional" });
  assert.ok(out.tools[2].inputSchema.$schema, "definitions keep the dialect");
});

test("every source declares operator, URL, licence and attribution (the provenance contract)", () => {
  const seen = new Map();
  for (const m of ALL_MODULES) {
    for (const s of m.sources) {
      for (const f of ["id", "name", "operator", "url", "licence", "attribution"]) {
        assert.ok(typeof s[f] === "string" && s[f].trim().length > 1, `${m.id}/${s.id}: missing ${f}`);
      }
      assert.match(s.url, /^https?:\/\//, `${m.id}/${s.id}: url`);
      assert.ok(Number.isFinite(s.cacheTtlSeconds), `${m.id}/${s.id}: cacheTtlSeconds`);
      const prev = seen.get(s.id);
      if (prev) assert.deepEqual(prev, s, `source id ${s.id} declared twice with different metadata`);
      seen.set(s.id, s);
    }
  }
  assert.ok(seen.size >= 60);
});
