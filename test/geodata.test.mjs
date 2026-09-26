/**
 * Offline tests for the geodata module (geo.admin.ch layers + STAC).
 * All HTTP is stubbed via globalThis.fetch with recorded-style fixtures.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  geodataModule,
  identifyWindow,
  bboxWindow,
  buildIdentifyUrl,
  swissPointProblem,
  parseLayerIds,
  parseLayerSearch,
  compactAttributes,
  geometryAnchor,
  groupByLayer,
  filterCollections,
  compactItem,
  tabularFormat,
  isStacHostUrl,
  nextLink,
  fitToBudget,
  resetStacVersion,
  currentStacBase,
  REPORT_LAYERS,
} from "../dist/modules/geodata.js";
import { getSearchers } from "../dist/core/discovery.js";
import { wgs84ToLv95 } from "../dist/core/coords.js";

const tools = Object.fromEntries(geodataModule.tools.map((t) => [t.name, t]));
const body = (res) => JSON.parse(res.content[0].text);

/** Route stubbed fetches by predicate; records every requested URL. */
async function withFetch(routes, fn) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url ?? String(input);
    calls.push(url);
    for (const [match, respond] of routes) {
      if (match(url)) {
        const r = typeof respond === "function" ? respond(url) : respond;
        if (r instanceof Response) return r;
        if (typeof r === "number") return new Response("error", { status: r });
        return new Response(typeof r === "string" ? r : JSON.stringify(r), { status: 200 });
      }
    }
    return new Response("not stubbed", { status: 404 });
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = orig;
  }
}

const has = (...parts) => (u) => parts.every((p) => u.includes(p));
const param = (u, k) => new URL(u).searchParams.get(k);

// ── Pure helpers ────────────────────────────────────────────────────────

test("identifyWindow: tolerance × pixel size equals the requested radius", () => {
  for (const r of [1, 10, 25, 99, 100, 300, 1000, 2000, 0.5]) {
    const w = identifyWindow(2600000, 1200000, r);
    assert.ok(Number.isInteger(w.tolerance) && w.tolerance >= 1 && w.tolerance <= 100, `tol ${w.tolerance}`);
    assert.ok(Math.abs(w.tolerance * w.pixelSizeM - r) < 0.02, `r=${r}: ${w.tolerance}×${w.pixelSizeM}`);
    const [minE, minN, maxE, maxN] = w.mapExtent.split(",").map(Number);
    const [wPx, hPx] = w.imageDisplay.split(",").map(Number);
    assert.ok(Math.abs((maxE - minE) / wPx - w.pixelSizeM) < 0.01, "extent/imageDisplay implies pixel size");
    assert.ok(Math.abs((maxN - minN) / hPx - w.pixelSizeM) < 0.01);
    assert.ok(maxE - 2600000 >= r - 0.01, "extent contains the search circle");
  }
  const zero = identifyWindow(2600000, 1200000, 0);
  assert.equal(zero.tolerance, 0);
  assert.equal(zero.pixelSizeM, 1);
  assert.equal(zero.mapExtent, "2599900,1199900,2600100,1200100");
  assert.equal(zero.imageDisplay, "200,200,96");
});

test("bboxWindow: LV95 envelope with ~≤1000 px and ≥1 m/px", () => {
  const w = bboxWindow([7.43, 46.94, 7.46, 46.96]);
  const [minE, minN, maxE, maxN] = w.geometry.split(",").map(Number);
  assert.ok(minE > 2598000 && maxE < 2602000 && minN > 1198000 && maxN < 1202000, w.geometry);
  assert.ok(w.widthM > 2000 && w.widthM < 2500, String(w.widthM));
  const [px] = w.imageDisplay.split(",").map(Number);
  assert.ok(px <= 1000 && px >= 1);
});

test("buildIdentifyUrl: point request uses LV95, all:<ids>, tolerance/extent consistent", () => {
  const u = buildIdentifyUrl({ layers: ["ch.bag.radonkarte", "ch.are.bauzonen"], lang: "de", point: { lat: 46.948, lon: 7.4474, radiusM: 50 } });
  assert.equal(param(u, "layers"), "all:ch.bag.radonkarte,ch.are.bauzonen");
  assert.equal(param(u, "sr"), "2056");
  assert.equal(param(u, "geometryType"), "esriGeometryPoint");
  assert.equal(param(u, "tolerance"), "50");
  assert.equal(param(u, "returnGeometry"), "false");
  assert.equal(param(u, "lang"), "de");
  const [e, n] = param(u, "geometry").split(",").map(Number);
  const ref = wgs84ToLv95(46.948, 7.4474);
  assert.equal(e, ref.easting);
  assert.equal(n, ref.northing);
  const b = buildIdentifyUrl({ layers: ["x.y.z"], lang: "en", bbox: [7.43, 46.94, 7.46, 46.96], returnGeometry: true });
  assert.equal(param(b, "geometryType"), "esriGeometryEnvelope");
  assert.equal(param(b, "tolerance"), "0");
  assert.equal(param(b, "geometryFormat"), "geojson");
});

test("swissPointProblem: ok inside CH; detects swapped, LV95 and foreign points", () => {
  assert.equal(swissPointProblem(46.948, 7.4474), undefined);
  assert.match(swissPointProblem(7.4474, 46.948).message, /swapped/);
  assert.match(swissPointProblem(2600000, 1200000).message, /LV95/);
  assert.match(swissPointProblem(48.85, 2.35).message, /outside Switzerland/);
});

test("parseLayerIds: splits, strips 'all:', de-duplicates and flags invalid ids", () => {
  const r = parseLayerIds("all:ch.bag.radonkarte, ch.are.bauzonen;ch.bag.radonkarte  bad id!, x");
  assert.deepEqual(r.valid, ["ch.bag.radonkarte", "ch.are.bauzonen", "bad"]);
  assert.deepEqual(r.invalid, ["id!", "x"]);
});

test("parseLayerSearch: extracts layer ids and strips HTML labels", () => {
  const fixture = {
    results: [
      { id: 101, weight: 120, attrs: { label: "<b>Strassenlärm</b> Tag", layer: "ch.bafu.laerm-strassenlaerm_tag", lang: "de", staging: "prod", detail: "strassenlaerm tag" } },
      { id: 102, weight: 90, attrs: { label: "Strassenlärm Nacht", layer: "ch.bafu.laerm-strassenlaerm_nacht" } },
      { id: 103, attrs: { label: "no layer here" } },
      { id: 104, attrs: { label: "dup", layer: "ch.bafu.laerm-strassenlaerm_tag" } },
    ],
  };
  const out = parseLayerSearch(fixture);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { layer_id: "ch.bafu.laerm-strassenlaerm_tag", title: "Strassenlärm Tag", detail: "strassenlaerm tag" });
});

test("compactAttributes / geometryAnchor / groupByLayer", () => {
  const a = compactAttributes({ a: 1, b: null, c: "", d: "x".repeat(400), e: { nested: true } }, 40, 300);
  assert.deepEqual(Object.keys(a), ["a", "d", "e"]);
  assert.equal(a.d.length, 301);
  assert.equal(compactAttributes({ a: 1, b: 2, c: 3 }, 2)._truncated_fields, true);

  const pt = geometryAnchor({ type: "Point", coordinates: [2600000, 1200000] });
  assert.ok(Math.abs(pt.lat - 46.951) < 0.001 && Math.abs(pt.lon - 7.4386) < 0.001);
  assert.equal(geometryAnchor({ x: 2600000, y: 1200000 }).type, "Point");
  assert.equal(geometryAnchor({ rings: [[[2600000, 1200000], [2600010, 1200000]]] }).type, "Polygon");
  assert.equal(geometryAnchor(null), undefined);

  const g = groupByLayer(
    [
      { layerBodId: "l.a.one", layerName: "One", featureId: 1, attributes: { v: 1 } },
      { layerBodId: "l.a.one", featureId: 2, attributes: { v: 2 } },
      { layerBodId: "l.a.one", featureId: 3, attributes: { v: 3 } },
    ],
    ["l.a.one", "l.a.two"],
    2,
  );
  assert.equal(g[0].count, 3);
  assert.equal(g[0].truncated, true);
  assert.equal(g[0].features.length, 2);
  assert.deepEqual(g[1], { layer_id: "l.a.two", layer_name: undefined, count: 0, features: [] });
});

test("STAC helpers: filterCollections ranking, compactItem, nextLink, tabularFormat, host checks", () => {
  const cols = [
    { id: "ch.swisstopo.swissalti3d", title: "swissALTI3D", description: "Höhenmodell" },
    { id: "ch.meteoschweiz.ogd-smn", title: "SwissMetNet automatic stations", description: "10-minute data", providers: [{ name: "MeteoSchweiz" }] },
    { id: "ch.meteoschweiz.ogd-nime", title: "Manual precipitation", description: "Niederschlag" },
  ];
  assert.deepEqual(filterCollections(cols, "meteoschweiz").map((c) => c.id), ["ch.meteoschweiz.ogd-smn", "ch.meteoschweiz.ogd-nime"], "provider match ranks higher");
  assert.deepEqual(filterCollections(cols, "meteoschweiz swissmetnet").map((c) => c.id), ["ch.meteoschweiz.ogd-smn"]);
  assert.deepEqual(filterCollections(cols, "hohenmodell").map((c) => c.id), ["ch.swisstopo.swissalti3d"], "diacritic-insensitive");
  assert.equal(filterCollections(cols, "").length, 3);

  const item = compactItem(
    {
      id: "ber",
      geometry: { type: "Point", coordinates: [7.4642, 46.9907] },
      properties: { datetime: null, title: "Bern / Zollikofen" },
      assets: {
        "ogd-smn_ber_d_recent.csv": { href: "https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/ber/ogd-smn_ber_d_recent.csv", type: "text/csv", "file:size": 12345 },
        "ogd-smn_ber_h_now.csv": { href: "https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/ber/ogd-smn_ber_h_now.csv", type: "text/csv" },
      },
    },
    "_d_",
  );
  assert.equal(item.asset_count, 1);
  assert.equal(item.assets[0].size_bytes, 12345);
  assert.deepEqual(item.location, { lat: 46.9907, lon: 7.4642 });

  assert.equal(nextLink([{ rel: "self", href: "a" }, { rel: "next", href: "b" }]), "b");
  assert.equal(nextLink(undefined), undefined);
  assert.equal(tabularFormat("https://data.geo.admin.ch/x/y.csv"), "csv");
  assert.equal(tabularFormat("https://data.geo.admin.ch/x/y.geojson"), "json");
  assert.equal(tabularFormat("https://data.geo.admin.ch/x/y.tif", "image/tiff; application=geotiff"), undefined);
  assert.equal(isStacHostUrl("https://data.geo.admin.ch/api/stac/v0.9/collections?cursor=x", "/api/stac/"), true);
  assert.equal(isStacHostUrl("https://evil.example.com/api/stac/v0.9/collections", "/api/stac/"), false);
  assert.equal(isStacHostUrl("http://data.geo.admin.ch/x.csv"), false);
});

test("fitToBudget shrinks lists until the payload fits", () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ i, pad: "x".repeat(1000) }));
  const { data, dropped } = fitToBudget(items, (xs) => ({ xs }), 20_000);
  assert.ok(JSON.stringify(data).length <= 20_000);
  assert.ok(dropped > 0 && data.xs.length + dropped === 100);
});

test("REPORT_LAYERS: ~20 unique, well-formed ids", () => {
  const ids = REPORT_LAYERS.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.length >= 15 && ids.length <= 22);
  for (const id of ids) assert.match(id, /^ch\./);
});

// ── Handler paths with recorded-style fixtures ──────────────────────────

test("search_map_layers: SearchServer type=layers → layer ids with map links", async () => {
  await withFetch(
    [[has("/SearchServer", "type=layers"), { results: [{ id: 1, attrs: { label: "<b>Radon</b>karte", layer: "ch.bag.radonkarte" } }] }]],
    async (calls) => {
      const res = await tools.search_map_layers.handler({ query: "radon-t1", lang: "de", limit: 5 });
      const b = body(res);
      assert.equal(res.isError, undefined);
      assert.equal(b.data.layers[0].layer_id, "ch.bag.radonkarte");
      assert.equal(b.data.layers[0].title, "Radonkarte");
      assert.match(b.data.layers[0].map_url, /layers=ch.bag.radonkarte/);
      assert.equal(param(calls[0], "lang"), "de");
      assert.equal(b.source.name, "geo.admin.ch federal geodata layers (api3 REST: SearchServer / MapServer)");
    },
  );
});

test("query_layer_at_point: combined identify, grouped per layer", async () => {
  const fixture = {
    results: [
      { layerBodId: "ch.bafu.laerm-strassenlaerm_tag", layerName: "Strassenlärm Tag", featureId: 77, id: 77, attributes: { lr_db: 55.3, label: "55-60 dB" } },
      { layerBodId: "ch.bag.radonkarte", layerName: "Radonkarte", featureId: "12", attributes: { radon_prob: "10-20%" } },
    ],
  };
  await withFetch([[has("/MapServer/identify"), fixture]], async (calls) => {
    const res = await tools.query_layer_at_point.handler({
      layers: "ch.bafu.laerm-strassenlaerm_tag,ch.bag.radonkarte,ch.are.bauzonen",
      lat: 46.9481,
      lon: 7.4474,
      radius_m: 20,
      return_geometry: false,
      per_layer_limit: 5,
      lang: "en",
    });
    const b = body(res);
    assert.equal(calls.length, 1);
    assert.equal(param(calls[0], "tolerance"), "20");
    assert.equal(b.data.total_features, 2);
    const byId = Object.fromEntries(b.data.layers.map((l) => [l.layer_id, l]));
    assert.equal(byId["ch.bafu.laerm-strassenlaerm_tag"].status, "match");
    assert.equal(byId["ch.bafu.laerm-strassenlaerm_tag"].features[0].attributes.lr_db, 55.3);
    assert.equal(byId["ch.are.bauzonen"].status, "no_match");
    assert.equal(b.data.query.radius_m, 20);
  });
});

test("query_layer_at_point: a bad layer (HTTP 400) is isolated via per-layer retry", async () => {
  await withFetch(
    [
      [(u) => u.includes("/identify") && param(u, "layers").includes(","), 400],
      [(u) => u.includes("/identify") && param(u, "layers") === "all:ch.nope.missing", 400],
      [(u) => u.includes("/identify") && param(u, "layers") === "all:ch.bag.radonkarte", { results: [{ layerBodId: "ch.bag.radonkarte", featureId: 1, attributes: { x: 1 } }] }],
    ],
    async (calls) => {
      const res = await tools.query_layer_at_point.handler({
        layers: "ch.bag.radonkarte,ch.nope.missing",
        lat: 46.95,
        lon: 7.45,
        radius_m: 0,
        return_geometry: false,
        per_layer_limit: 5,
        lang: "en",
      });
      const b = body(res);
      assert.equal(res.isError, undefined);
      assert.equal(calls.length, 3);
      const byId = Object.fromEntries(b.data.layers.map((l) => [l.layer_id, l]));
      assert.equal(byId["ch.bag.radonkarte"].status, "match");
      assert.equal(byId["ch.nope.missing"].status, "error");
      assert.match(byId["ch.nope.missing"].error, /HTTP 400/);
    },
  );
});

test("query_layer_at_point: validation errors are actionable", async () => {
  const swapped = await tools.query_layer_at_point.handler({ layers: "ch.bag.radonkarte", lat: 7.44, lon: 46.95, radius_m: 0, per_layer_limit: 5, lang: "en" });
  assert.equal(swapped.isError, true);
  assert.match(body(swapped).suggestions[0], /lat=46.95/);
  const none = await tools.query_layer_at_point.handler({ layers: "ch.bag.radonkarte", radius_m: 0, per_layer_limit: 5, lang: "en" });
  assert.equal(none.isError, true);
  const huge = await tools.query_layer_at_point.handler({ layers: "ch.bag.radonkarte", bbox: [7.0, 46.5, 7.5, 47.0], per_layer_limit: 5, lang: "en" });
  assert.match(body(huge).error, /maximum is 5000 m/);
});

test("get_location_report: geocodes, runs layers in parallel, tolerates per-layer failures", async () => {
  const gwr = "ch.bfs.gebaeude_wohnungs_register";
  await withFetch(
    [
      [has("/SearchServer", "type=locations"), { results: [{ attrs: { label: "<b>Bundesplatz 3</b> 3011 Bern", lat: 46.9466, lon: 7.4441, y: 2600417, x: 1199561 } }] }],
      [(u) => u.includes("/identify") && param(u, "layers") === "all:ch.swisstopo.swissboundaries3d-gemeinde-flaeche.fill", { results: [{ layerBodId: "ch.swisstopo.swissboundaries3d-gemeinde-flaeche.fill", featureId: 351, attributes: { gemname: "Bern", kanton: "BE", gemnummer: 351 } }] }],
      [(u) => u.includes("/identify") && param(u, "layers") === `all:${gwr}`, (u) => {
        assert.equal(param(u, "tolerance"), "25");
        return { results: [{ layerBodId: gwr, featureId: "1017979_0", attributes: { egid: 1017979, strname_deinr: "Bundesplatz 3", gbauj: 1902 } }] };
      }],
      [(u) => u.includes("/identify") && param(u, "layers") === "all:ch.bag.radonkarte", 500],
      [has("/identify"), { results: [] }],
    ],
    async () => {
      const res = await tools.get_location_report.handler({ address: "Bundesplatz 3 Bern", lang: "de" });
      const b = body(res);
      assert.equal(res.isError, undefined);
      assert.equal(b.data.location.municipality, "Bern");
      assert.equal(b.data.location.canton, "BE");
      assert.equal(b.data.location.matched, "Bundesplatz 3 3011 Bern");
      assert.equal(b.data.summary.layers_queried, REPORT_LAYERS.length);
      assert.equal(b.data.summary.match, 2);
      assert.equal(b.data.summary.error, 1);
      const radon = b.data.layers.find((l) => l.layer_id === "ch.bag.radonkarte");
      assert.equal(radon.status, "error");
      const building = b.data.layers.find((l) => l.layer_id === gwr);
      assert.equal(building.features[0].attributes.egid, 1017979);
      assert.match(b.notes, /Best-effort/);
    },
  );
});

test("get_location_report: topics filter + extra layers; outside-CH is rejected", async () => {
  await withFetch([[has("/identify"), { results: [] }]], async (calls) => {
    const res = await tools.get_location_report.handler({ lat: 47.3769, lon: 8.5417, topics: ["noise"], extra_layers: "ch.bafu.bundesinventare-amphibien", lang: "en" });
    const b = body(res);
    assert.equal(b.data.summary.layers_queried, 5);
    assert.equal(calls.length, 5);
    assert.ok(b.data.layers.some((l) => l.layer_id === "ch.bafu.bundesinventare-amphibien"));
  });
  const out = await tools.get_location_report.handler({ lat: 48.85, lon: 2.35, lang: "en" });
  assert.equal(out.isError, true);
});

test("get_layer_info: merges attributes, metadata and layersConfig; unknown layer → helpful error", async () => {
  await withFetch(
    [
      [has("/MapServer/layersConfig"), { "ch.bag.radonkarte": { label: "Radon map", queryable: true, timeEnabled: false, type: "wmts", attribution: "BAG" } }],
      [has("/MapServer/ch.bag.radonkarte?"), { layerId: "ch.bag.radonkarte", name: "Radonkarte", fields: [{ name: "radon_prob", alias: "Probability", type: "VARCHAR", values: ["<10%", "10-20%"] }] }],
      [(u) => u.includes("/MapServer?") && param(u, "searchText") === "ch.bag.radonkarte", { layers: [{ layerBodId: "ch.bag.radonkarte", fullName: "Radonkarte", attributes: { abstract: "<p>Probability of exceeding 300 Bq/m3</p>", dataOwner: "FOPH" } }] }],
    ],
    async () => {
      const res = await tools.get_layer_info.handler({ layer_id: "ch.bag.radonkarte", lang: "en" });
      const b = body(res);
      assert.equal(b.data.title, "Radon map");
      assert.equal(b.data.queryable, true);
      assert.equal(b.data.data_owner, "FOPH");
      assert.equal(b.data.abstract, "Probability of exceeding 300 Bq/m3");
      assert.deepEqual(b.data.fields[0], { name: "radon_prob", alias: "Probability", type: "VARCHAR", sample_values: ["<10%", "10-20%"] });
      assert.match(b.data.legend_url, /\/MapServer\/ch\.bag\.radonkarte\/legend\?lang=en/);
    },
  );
  await withFetch(
    [
      [has("/MapServer/layersConfig"), {}],
      [has("/MapServer/ch.nope.layer?"), 400],
      [has("/MapServer?"), { layers: [] }],
    ],
    async () => {
      const res = await tools.get_layer_info.handler({ layer_id: "ch.nope.layer", lang: "fr" });
      assert.equal(res.isError, true);
      assert.match(body(res).error, /not found/);
    },
  );
});

test("find_layer_features and get_layer_feature: request shape + parsing", async () => {
  await withFetch(
    [
      [has("/MapServer/find"), { results: [{ layerBodId: "ch.bfs.gebaeude_wohnungs_register", featureId: "1231641_0", attributes: { egid: 1231641, strname_deinr: "Musterweg 1" } }] }],
      [has("/MapServer/ch.bfs.gebaeude_wohnungs_register/1231641_0"), { feature: { layerBodId: "ch.bfs.gebaeude_wohnungs_register", featureId: "1231641_0", attributes: { egid: 1231641 }, geometry: { type: "Point", coordinates: [2600000, 1200000] } } }],
    ],
    async (calls) => {
      const f = body(await tools.find_layer_features.handler({ layer_id: "ch.bfs.gebaeude_wohnungs_register", search_field: "egid", search_text: "1231641", contains: false, limit: 10, lang: "de" }));
      assert.equal(f.data.features[0].feature_id, "1231641_0");
      assert.equal(param(calls[0], "contains"), "false");
      assert.equal(param(calls[0], "searchField"), "egid");
      const g = body(await tools.get_layer_feature.handler({ layer_id: "ch.bfs.gebaeude_wohnungs_register", feature_id: "1231641_0", return_geometry: true, lang: "de" }));
      assert.equal(g.data.features[0].attributes.egid, 1231641);
      assert.ok(g.data.features[0].location.lat > 46.9);
    },
  );
  const bad = await tools.get_layer_feature.handler({ layer_id: "ch.a.b", feature_id: "../etc", return_geometry: false, lang: "en" });
  assert.equal(bad.isError, true);
});

test("STAC: v0.9 404 falls back to v1; collections are paginated and filtered", async () => {
  resetStacVersion();
  await withFetch(
    [
      [has("/api/stac/v0.9/"), 404],
      [(u) => u.includes("/api/stac/v1/collections") && !u.includes("cursor"), {
        collections: [{ id: "ch.swisstopo.swissalti3d", title: "swissALTI3D", description: "Digital elevation model" }],
        links: [{ rel: "next", href: "https://data.geo.admin.ch/api/stac/v1/collections?cursor=p2&limit=100" }],
      }],
      [has("/api/stac/v1/collections", "cursor=p2"), {
        collections: [{ id: "ch.meteoschweiz.ogd-smn", title: "SwissMetNet", description: "Automatic weather stations", license: "CC-BY-4.0", providers: [{ name: "MeteoSwiss" }], extent: { temporal: { interval: [["1864-01-01T00:00:00Z", null]] } } }],
        links: [{ rel: "self", href: "x" }],
      }],
    ],
    async () => {
      const res = await tools.search_geodata_collections.handler({ query: "weather stations", limit: 20, offset: 0 });
      const b = body(res);
      assert.equal(res.isError, undefined);
      assert.equal(b.data.total_collections, 2);
      assert.equal(b.data.collections[0].id, "ch.meteoschweiz.ogd-smn");
      assert.deepEqual(b.data.collections[0].temporal_extent, { start: "1864-01-01T00:00:00Z", end: null });
      assert.equal(currentStacBase(), "https://data.geo.admin.ch/api/stac/v1");
    },
  );
  resetStacVersion();
});

test("get_geodata_collection_items: collection assets + items with filtered assets and next page", async () => {
  resetStacVersion();
  await withFetch(
    [
      [has("/api/stac/v0.9/collections/ch.meteoschweiz.ogd-smn/items"), (u) => {
        assert.equal(param(u, "bbox"), "7.4,46.9,7.5,47");
        return {
          type: "FeatureCollection",
          features: [
            {
              id: "ber",
              geometry: { type: "Point", coordinates: [7.4642, 46.9907] },
              properties: { datetime: "2025-01-01T00:00:00Z", title: "Bern / Zollikofen" },
              assets: {
                "ogd-smn_ber_d_recent.csv": { href: "https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/ber/ogd-smn_ber_d_recent.csv", type: "text/csv" },
                "ogd-smn_ber_t_now.csv": { href: "https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/ber/ogd-smn_ber_t_now.csv", type: "text/csv" },
              },
            },
          ],
          links: [{ rel: "next", href: "https://data.geo.admin.ch/api/stac/v0.9/collections/ch.meteoschweiz.ogd-smn/items?cursor=abc" }],
        };
      }],
      [has("/api/stac/v0.9/collections/ch.meteoschweiz.ogd-smn"), {
        id: "ch.meteoschweiz.ogd-smn",
        title: "SwissMetNet",
        license: "CC-BY-4.0",
        assets: { "ogd-smn_meta_stations.csv": { href: "https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/ogd-smn_meta_stations.csv", type: "text/csv" } },
      }],
    ],
    async () => {
      const res = await tools.get_geodata_collection_items.handler({
        collection: "ch.meteoschweiz.ogd-smn",
        bbox: [7.4, 46.9, 7.5, 47.0],
        asset_filter: "",
        include_collection_assets: true,
        limit: 10,
      });
      const b = body(res);
      assert.equal(res.isError, undefined);
      assert.equal(b.data.collection_assets.assets[0].key, "ogd-smn_meta_stations.csv");
      assert.equal(b.data.items[0].id, "ber");
      assert.equal(b.data.items[0].asset_count, 2);
      assert.match(b.data.next_page_url, /cursor=abc/);
      assert.equal(b.source.name, "MeteoSwiss Open Government Data (via data.geo.admin.ch STAC)");
      assert.match(b.notes, /granularity/);
    },
  );
  const bad = await tools.get_geodata_collection_items.handler({ collection: "ch.x.y", page_url: "https://evil.example.com/api/stac/x", include_collection_assets: true, limit: 10 });
  assert.equal(bad.isError, true);
});

test("read_geodata_asset: Latin-1 ';' MeteoSwiss CSV → filtered rows; tail returns latest", async () => {
  const csv =
    "station_abbr;reference_timestamp;tre200d0;rre150d0\n" +
    "BER;01.06.2025 00:00;18.2;0.0\n" +
    "BER;02.06.2025 00:00;21.5;3.4\n" +
    "BER;03.06.2025 00:00;26.1;0.0\n" +
    "BER;04.06.2025 00:00;Zürich-ish;0.0\n";
  const latin1 = new Uint8Array([...csv].map((c) => c.charCodeAt(0)));
  const url = "https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/ber/ogd-smn_ber_d_recent.csv";
  await withFetch([[has("ogd-smn_ber_d_recent.csv"), () => new Response(latin1, { status: 200 })]], async () => {
    const hot = body(await tools.read_geodata_asset.handler({ url, where: { tre200d0: ">20" }, tail: false, offset: 0, limit: 50, max_mb: 8 }));
    assert.equal(hot.data.matched_rows, 2);
    assert.deepEqual(hot.data.columns, ["station_abbr", "reference_timestamp", "tre200d0", "rre150d0"]);
    const last = body(await tools.read_geodata_asset.handler({ url, columns: ["reference_timestamp", "tre200d0"], tail: true, offset: 0, limit: 2, max_mb: 8 }));
    assert.deepEqual(last.data.rows.map((r) => r.reference_timestamp), ["03.06.2025 00:00", "04.06.2025 00:00"]);
    assert.equal(last.data.rows[1].tre200d0, "Zürich-ish", "Latin-1 decoded");
    assert.equal(last.source.attribution, "Source: MeteoSwiss");
  });
  const foreign = await tools.read_geodata_asset.handler({ url: "https://example.com/x.csv", tail: false, offset: 0, limit: 5, max_mb: 8 });
  assert.equal(foreign.isError, true);
  const binary = await tools.read_geodata_asset.handler({ url: "https://data.geo.admin.ch/ch.swisstopo.swissalti3d/x/x.tif", tail: false, offset: 0, limit: 5, max_mb: 8 });
  assert.match(body(binary).error, /not a CSV/);
});

test("discovery: both catalogues registered and hits point at this module's tools", async () => {
  const s = getSearchers();
  const layers = s.find((x) => x.catalogue === "geo.admin.ch");
  const stac = s.find((x) => x.catalogue === "geo.admin.ch STAC");
  assert.ok(layers && stac);
  assert.equal(layers.module, "geodata");
  resetStacVersion();
  await withFetch(
    [
      [has("/SearchServer", "type=layers", "searchText=antenna-disc"), { results: [{ attrs: { label: "Mobile antennas", layer: "ch.bakom.standorte-mobilfunkanlagen" } }] }],
      [has("/api/stac/v0.9/collections"), { collections: [{ id: "ch.bakom.standorte-mobilfunkanlagen", title: "Antenna sites (antenna-disc)" }], links: [] }],
    ],
    async () => {
      const h1 = await layers.search("antenna-disc", 5, "xx");
      assert.deepEqual(h1[0].next, { tool: "get_layer_info", args: { layer_id: "ch.bakom.standorte-mobilfunkanlagen" } });
      const h2 = await stac.search("antenna-disc", 5, "en");
      assert.deepEqual(h2[0].next, { tool: "get_geodata_collection_items", args: { collection: "ch.bakom.standorte-mobilfunkanlagen" } });
      const toolNames = new Set(geodataModule.tools.map((t) => t.name));
      for (const h of [...h1, ...h2]) assert.ok(toolNames.has(h.next.tool));
    },
  );
});
