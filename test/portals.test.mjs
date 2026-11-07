/**
 * Offline tests for the Opendatasoft portals module (src/modules/portals.ts).
 * globalThis.fetch is stubbed with recorded-style Explore API v2.1 fixtures.
 *   npm run build && node --test test/portals.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PORTALS,
  resolvePortal,
  stripHtml,
  sanitizeOdsText,
  isSafeFieldName,
  isSafeDatasetId,
  validateOdsql,
  buildNearClause,
  buildDistanceOrder,
  summarizeDataset,
  describeDataset,
  extractOdsRecords,
  trimRecord,
  readGeoPoint,
  portalsModule,
} from "../dist/modules/portals.js";
import { isAllowedHost } from "../dist/core/http.js";
import { getSearchers } from "../dist/core/discovery.js";

// ── Fixtures (Explore API v2.1 shapes) ────────────────────────────────────

const parkingDataset = {
  dataset_id: "100088",
  dataset_uid: "da_abc123",
  has_records: true,
  features: ["analyze", "geo", "timeserie"],
  metas: {
    default: {
      title: "Parkhäuser Basel-Stadt: Belegung",
      description: "<p>Aktuelle Belegung der <b>Parkhäuser</b> in Basel.</p><p>Aktualisierung alle 5&nbsp;Minuten.</p>",
      theme: ["Mobilität und Verkehr"],
      keyword: ["Parkhaus", "Parking", "Echtzeit"],
      license: "CC BY 4.0",
      license_url: "https://creativecommons.org/licenses/by/4.0/",
      publisher: "Immobilien Basel-Stadt",
      attributions: ["Parkleitsystem Basel"],
      modified: "2026-09-26T08:15:00+00:00",
      data_processed: "2026-09-26T08:15:00+00:00",
      records_count: 16,
      language: "de",
    },
  },
  fields: [
    { name: "title", label: "Parkhaus", type: "text", description: null, annotations: { facet: true } },
    { name: "free", label: "Freie Plätze", type: "int", description: "Anzahl freier Plätze", annotations: {} },
    { name: "total", label: "Total Plätze", type: "int", description: null, annotations: {} },
    { name: "published", label: "Zeitstempel", type: "datetime", description: null, annotations: { timeserie_precision: "minute" } },
    { name: "geo_point_2d", label: "Geo Point", type: "geo_point_2d", description: null, annotations: {} },
    { name: "geo_shape", label: "Geo Shape", type: "geo_shape", description: null, annotations: {} },
  ],
};

const bigShape = {
  type: "Feature",
  geometry: {
    type: "Polygon",
    coordinates: [Array.from({ length: 60 }, (_, i) => [7.58 + i / 1000, 47.55 + i / 1000])],
  },
  properties: {},
};

const parkingRecords = {
  total_count: 2,
  results: [
    { title: "Parkhaus Steinen", free: 120, total: 526, published: "2026-09-26T08:10:00+00:00", geo_point_2d: { lon: 7.5859, lat: 47.5536 }, geo_shape: bigShape },
    { title: "Parkhaus Bahnhof Süd", free: 40, total: 250, published: "2026-09-26T08:10:00+00:00", geo_point_2d: { lon: 7.5898, lat: 47.5467 }, geo_shape: bigShape },
  ],
};

function catalog(portalTitle, datasets) {
  return { total_count: datasets.length, results: datasets.map((d, i) => ({ ...parkingDataset, dataset_id: `${portalTitle}-${i}`, metas: { default: { ...parkingDataset.metas.default, title: d } } })) };
}

// ── fetch stub ────────────────────────────────────────────────────────────

function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    const out = handler(new URL(url));
    if (typeof out === "number") return new Response("error", { status: out });
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

const toolByName = (n) => portalsModule.tools.find((t) => t.name === n);
const parse = (res) => JSON.parse(res.content[0].text);

// ── Pure helpers ──────────────────────────────────────────────────────────

test("portals: registry ids unique, domains allowlisted", () => {
  const ids = PORTALS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const p of PORTALS) assert.ok(isAllowedHost(p.domain), p.domain);
  assert.ok(PORTALS.find((p) => p.domain === "data.sbb.ch"));
  assert.ok(PORTALS.find((p) => p.domain === "swisspost.opendatasoft.com"));
});

test("portals: resolvePortal by id, alias, domain, URL and *.opendatasoft.com", () => {
  assert.equal(resolvePortal("sbb")?.domain, "data.sbb.ch");
  assert.equal(resolvePortal("BS")?.id, "basel-stadt");
  assert.equal(resolvePortal("https://data.bl.ch/explore/")?.id, "basel-landschaft");
  assert.equal(resolvePortal("post")?.id, "swisspost");
  assert.equal(resolvePortal("foo.opendatasoft.com")?.domain, "foo.opendatasoft.com");
  assert.equal(resolvePortal("evil.example.com"), undefined);
  assert.equal(resolvePortal("x.opendatasoft.com.evil.net"), undefined);
});

test("portals: stripHtml and sanitizeOdsText", () => {
  assert.equal(stripHtml("<p>A&nbsp;<b>b</b></p><p>c &amp; d</p>"), "A b c & d");
  assert.equal(stripHtml(null), "");
  assert.equal(sanitizeOdsText('Park"haus\\ OR 1=1 `x`'), "Park haus OR 1=1 x");
  assert.equal(sanitizeOdsText("Luftqualität\n"), "Luftqualität");
});

test("portals: identifier and ODSQL validation", () => {
  assert.ok(isSafeFieldName("geo_point_2d"));
  assert.ok(!isSafeFieldName("geo) OR (1"));
  assert.ok(isSafeDatasetId("100088"));
  assert.ok(isSafeDatasetId("plz_verzeichnis_v2"));
  assert.ok(!isSafeDatasetId("../secret"));
  assert.equal(validateOdsql("where", "jahr = 2023", 100), undefined);
  assert.match(validateOdsql("where", "x".repeat(101), 100), /too long/);
  assert.match(validateOdsql("where", "a\u0000b", 100), /control/);
});

test("portals: buildNearClause / buildDistanceOrder use lon-lat WKT order", () => {
  assert.equal(
    buildNearClause("geo_point_2d", 47.5476, 7.5896, 800),
    "within_distance(geo_point_2d, geom'POINT(7.589600 47.547600)', 800m)",
  );
  assert.equal(buildDistanceOrder("geo", 47, 8), "distance(geo, geom'POINT(8.000000 47.000000)')");
  assert.throws(() => buildNearClause("bad field", 47, 8, 1));
});

test("portals: summarizeDataset / describeDataset normalise v2.1 and v2.0 shapes", () => {
  const p = resolvePortal("basel-stadt");
  const s = summarizeDataset(parkingDataset, p);
  assert.equal(s.dataset_id, "100088");
  assert.equal(s.records, 16);
  assert.equal(s.modified, "2026-09-26");
  assert.deepEqual(s.themes, ["Mobilität und Verkehr"]);
  assert.ok(!s.description.includes("<"));
  assert.equal(s.url, "https://data.bs.ch/explore/dataset/100088/");

  const v20 = summarizeDataset({ dataset: parkingDataset }, p);
  assert.equal(v20.dataset_id, "100088");

  const d = describeDataset(parkingDataset, p);
  assert.equal(d.licence, "CC BY 4.0");
  assert.equal(d.geo_point_field, "geo_point_2d");
  assert.deepEqual(d.attributions, ["Parkleitsystem Basel"]);
  assert.equal(d.fields.length, 6);
  assert.deepEqual(d.fields[0], { name: "title", label: "Parkhaus", type: "text", description: undefined, facet: true });
  assert.equal(d.fields[1].description, "Anzahl freier Plätze");
  // legacy array annotations
  const legacy = describeDataset({ ...parkingDataset, fields: [{ name: "a", type: "text", annotations: [{ name: "facet" }] }] }, p);
  assert.equal(legacy.fields[0].facet, true);
});

test("portals: extractOdsRecords, trimRecord, readGeoPoint", () => {
  assert.equal(extractOdsRecords(parkingRecords).length, 2);
  assert.deepEqual(extractOdsRecords({ records: [{ record: { fields: { a: 1 } } }] }), [{ a: 1 }]);
  assert.deepEqual(extractOdsRecords({}), []);

  const t = trimRecord({ ...parkingRecords.results[0], note: "x".repeat(900) });
  assert.equal(t.geo_shape.geometry_summary.type, "Polygon");
  assert.deepEqual(t.geo_point_2d, { lon: 7.5859, lat: 47.5536 });
  assert.equal(t.note.length, 500);

  assert.deepEqual(readGeoPoint({ lon: 7.5, lat: 47.5 }), { lat: 47.5, lon: 7.5 });
  assert.deepEqual(readGeoPoint("47.5, 7.5"), { lat: 47.5, lon: 7.5 });
  assert.equal(readGeoPoint({ foo: 1 }), undefined);
});

test("portals: module wiring (tools, probes, searcher)", () => {
  assert.equal(portalsModule.id, "portals");
  assert.deepEqual(
    portalsModule.tools.map((t) => t.name).sort(),
    ["get_portal_dataset", "list_data_portals", "query_portal_records", "search_portal_datasets"],
  );
  assert.equal(portalsModule.healthProbes.length, PORTALS.length);
  assert.ok(getSearchers().some((s) => s.catalogue === "Opendatasoft portals" && s.module === "portals"));
});

// ── Handler paths ─────────────────────────────────────────────────────────

test("portals: list_data_portals returns the registry", async () => {
  const body = parse(await toolByName("list_data_portals").handler({}));
  assert.equal(body.data.portals.length, PORTALS.length);
  assert.ok(body.data.portals.every((p) => p.domain && p.platform_confidence));
});

test("portals: search_portal_datasets on one portal uses ODSQL full-text where", async () => {
  const stub = stubFetch((u) => {
    assert.equal(u.hostname, "data.bs.ch");
    assert.equal(u.pathname, "/api/explore/v2.1/catalog/datasets");
    return catalog("bs", ["Parkhäuser Basel-Stadt: Belegung"]);
  });
  try {
    const res = await toolByName("search_portal_datasets").handler({ query: 'Parkhaus"', portal: "bs", limit: 5 });
    assert.ok(!res.isError, res.content[0].text);
    const body = parse(res);
    assert.equal(body.data.portal, "basel-stadt");
    assert.equal(body.data.results[0].title, "Parkhäuser Basel-Stadt: Belegung");
    const u = new URL(stub.calls[0]);
    assert.equal(u.searchParams.get("where"), '"Parkhaus"');
    assert.equal(u.searchParams.get("limit"), "5");
    assert.match(body.source.attribution, /Basel-Stadt/);
  } finally {
    stub.restore();
  }
});

test("portals: search falls back to q= when the portal rejects the where literal", async () => {
  const stub = stubFetch((u) => (u.searchParams.has("where") ? 400 : catalog("tg", ["Wahlen Thurgau"])));
  try {
    const body = parse(await toolByName("search_portal_datasets").handler({ query: "Wahlen fallback", portal: "tg", limit: 3 }));
    assert.equal(body.data.results[0].title, "Wahlen Thurgau");
    assert.equal(new URL(stub.calls[1]).searchParams.get("q"), "Wahlen fallback");
  } finally {
    stub.restore();
  }
});

test("portals: search across all portals tolerates per-portal failures", async () => {
  const stub = stubFetch((u) => (u.hostname === "data.sbb.ch" ? 404 : catalog(u.hostname, [`Luft ${u.hostname}`])));
  try {
    const res = await toolByName("search_portal_datasets").handler({ query: "Luftqualität allportals", limit: 2 });
    assert.ok(!res.isError, res.content[0].text);
    const body = parse(res);
    const sbb = body.data.per_portal.find((x) => x.portal === "sbb");
    assert.match(sbb.error, /404/);
    assert.equal(body.data.results.length, PORTALS.length - 1);
    assert.ok(body.data.per_portal.filter((x) => !x.error).every((x) => x.returned === 1));
  } finally {
    stub.restore();
  }
});

test("portals: get_portal_dataset returns schema, licence and 404 handling", async () => {
  const stub = stubFetch((u) => (u.pathname.endsWith("/datasets/100088") ? parkingDataset : 404));
  try {
    const body = parse(await toolByName("get_portal_dataset").handler({ portal: "basel-stadt", dataset_id: "100088" }));
    assert.equal(body.data.licence, "CC BY 4.0");
    assert.equal(body.data.records, 16);
    assert.equal(body.data.fields[1].name, "free");
    assert.equal(body.data_as_of, "2026-09-26T08:15:00+00:00");

    const miss = await toolByName("get_portal_dataset").handler({ portal: "basel-stadt", dataset_id: "nope" });
    assert.equal(miss.isError, true);
    assert.match(miss.content[0].text, /not found/);

    const bad = await toolByName("get_portal_dataset").handler({ portal: "example.com", dataset_id: "x" });
    assert.equal(bad.isError, true);
  } finally {
    stub.restore();
  }
});

test("portals: query_portal_records with near builds within_distance and sorts by distance", async () => {
  const stub = stubFetch((u) => {
    if (u.pathname.endsWith("/datasets/100088")) return parkingDataset;
    if (u.pathname.endsWith("/datasets/100088/records")) {
      // Simulate a portal that rejects order_by distance() → client-side sort.
      if ((u.searchParams.get("order_by") ?? "").startsWith("distance(")) return 400;
      return parkingRecords;
    }
    return 404;
  });
  try {
    const res = await toolByName("query_portal_records").handler({
      portal: "basel-stadt",
      dataset_id: "100088",
      where: "free > 0",
      limit: 20,
      offset: 0,
      near: { lat: 47.5476, lon: 7.5896, radius_m: 800 },
    });
    assert.ok(!res.isError, res.content[0].text);
    const body = parse(res);
    const recUrls = stub.calls.filter((c) => c.includes("/records"));
    assert.equal(recUrls.length, 2);
    const where = new URL(recUrls[1]).searchParams.get("where");
    assert.equal(where, "(free > 0) AND within_distance(geo_point_2d, geom'POINT(7.589600 47.547600)', 800m)");
    assert.equal(body.data.records[0].title, "Parkhaus Bahnhof Süd");
    assert.ok(body.data.records[0].distance_m < body.data.records[1].distance_m);
    assert.equal(body.data.records[0].geo_shape.geometry_summary.type, "Polygon");
    assert.equal(body.data.near.geo_field, "geo_point_2d");
    assert.equal(body.data.total_count, 2);
  } finally {
    stub.restore();
  }
});

test("portals: query_portal_records passes group_by/select through and maps HTTP 400", async () => {
  const stub = stubFetch((u) => {
    if (u.searchParams.get("select") === "broken(") return 400;
    return { total_count: 2, results: [{ kanton: "BS", n: 10 }, { kanton: "BL", n: 7 }] };
  });
  try {
    const body = parse(
      await toolByName("query_portal_records").handler({
        portal: "sbb",
        dataset_id: "passagierfrequenz",
        select: "kanton, count(*) as n",
        group_by: "kanton",
        order_by: "n desc",
        limit: 10,
        offset: 0,
      }),
    );
    const u = new URL(stub.calls[0]);
    assert.equal(u.hostname, "data.sbb.ch");
    assert.equal(u.searchParams.get("group_by"), "kanton");
    assert.equal(u.searchParams.get("order_by"), "n desc");
    assert.equal(u.searchParams.has("offset"), false);
    assert.deepEqual(body.data.records[0], { kanton: "BS", n: 10 });

    const err = await toolByName("query_portal_records").handler({
      portal: "sbb",
      dataset_id: "passagierfrequenz",
      select: "broken(",
      limit: 10,
      offset: 0,
    });
    assert.equal(err.isError, true);
    assert.match(err.content[0].text, /ODSQL/);

    const tooDeep = await toolByName("query_portal_records").handler({ portal: "sbb", dataset_id: "x", limit: 100, offset: 9950 });
    assert.equal(tooDeep.isError, true);
  } finally {
    stub.restore();
  }
});

test("portals: searcher throws when every portal fails, returns [] when some merely have no hits", async () => {
  const s = getSearchers().find((x) => x.catalogue === "Opendatasoft portals");
  const down = stubFetch(() => 404);
  try {
    await assert.rejects(s.search("allportalsdown unique query", 5, "de"), (err) => {
      assert.match(err.message, new RegExp(`All ${PORTALS.length} Opendatasoft portals failed`));
      assert.match(err.message, /data\.sbb\.ch|HTTP 404/);
      return true;
    });
  } finally {
    down.restore();
  }
  const partly = stubFetch((u) => (u.hostname === "data.sbb.ch" ? { total_count: 0, results: [] } : 404));
  try {
    assert.deepEqual(await s.search("someportalsdown unique query", 5, "de"), []);
  } finally {
    partly.restore();
  }
});

test("portals: registered searcher returns DataHits pointing at get_portal_dataset", async () => {
  const stub = stubFetch((u) => (u.hostname === "data.sbb.ch" ? catalog("sbb", ["Passagierfrequenz"]) : { total_count: 0, results: [] }));
  try {
    const s = getSearchers().find((x) => x.catalogue === "Opendatasoft portals");
    const hits = await s.search("Passagierfrequenz searcher", 5, "de");
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0].next, { tool: "get_portal_dataset", args: { portal: "sbb", dataset_id: "sbb-0" } });
    assert.equal(hits[0].id, "sbb/sbb-0");
  } finally {
    stub.restore();
  }
});
