/**
 * Offline tests for dams (SFOE), traffic counts (FEDRO), SBB station data and
 * the FSO property price index. geo.admin fixtures are trimmed live responses;
 * SBB and BFS fixtures follow their documented response shapes.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { __resetForTests } from "../dist/core/http.js";
import { invokeTool } from "../dist/core/invoke.js";
import { damsModule, searchDams, mapDam } from "../dist/modules/dams.js";
import { trafficModule, filterStations } from "../dist/modules/traffic.js";
import { sbbModule, summariseRidership, onTimePct, isTrackFree, odsString } from "../dist/modules/sbb.js";
import { realestateModule, quarterOf, parseImpi, withChanges } from "../dist/modules/realestate.js";
import { toPoints, fold } from "../dist/modules/layerIndex.js";

const fx = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const DAMS = fx("dams-identify.json");
const TRAFFIC = fx("traffic-identify.json");
const realFetch = globalThis.fetch;
const body = (r) => JSON.parse(r.content[0].text);
const tool = (m, n) => m.tools.find((t) => t.name === n);
const json = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });

let urls;
function route(handler) {
  urls = [];
  globalThis.fetch = async (u) => {
    urls.push(String(u));
    return handler(new URL(String(u)));
  };
}

beforeEach(() => __resetForTests({ retryDelayMs: 1, breakerCooldownMs: 60 }));
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── layer index ─────────────────────────────────────────────────────────

test("layerIndex: reads geojson properties and converts LV95 to WGS84", () => {
  const pts = toPoints(DAMS);
  const dix = pts.find((p) => p.attributes.damname === "Grande Dixence");
  assert.ok(dix);
  assert.ok(Math.abs(dix.lat - 46.0806) < 0.01 && Math.abs(dix.lon - 7.403) < 0.01, `${dix.lat},${dix.lon}`);
  assert.equal(fold("Émosson-Barrage"), "emosson barrage");
});

// ── dams ────────────────────────────────────────────────────────────────

test("dams: mapping, ranking by height and volume, name and purpose search", () => {
  const dams = toPoints(DAMS).map(mapDam);
  const dix = dams.find((d) => d.name === "Grande Dixence");
  assert.equal(dix.height_m, 285);
  assert.equal(dix.volume_million_m3, 385);
  assert.equal(dix.type, "gravity dam");
  assert.match(dix.map_url, /stauanlagen/);
  assert.equal(searchDams(dams, { sort_by: "height", order: "desc" })[0].name, "Grande Dixence");
  assert.equal(searchDams(dams, { sort_by: "volume", order: "desc" })[1].name, "Emosson");
  assert.deepEqual(searchDams(dams, { query: "dixence", sort_by: "height", order: "desc" }).map((d) => d.name), ["Grande Dixence"]);
  assert.ok(searchDams(dams, { purpose: "flood", sort_by: "height", order: "desc" }).every((d) => /flood/.test(d.purpose)));
});

test("dams: tools load the whole register once (paged) and answer with provenance", async () => {
  route(() => json(DAMS));
  const top = body(await invokeTool(tool(damsModule, "search_dams"), { sort_by: "height", order: "desc", limit: 2 }));
  assert.deepEqual(top.data.dams.map((d) => d.name), ["Grande Dixence", "Mauvoisin"]);
  assert.equal(top.source.operator, "Swiss Federal Office of Energy (SFOE)");
  assert.match(top.provenance.upstream[0].url, /stauanlagen-bundesaufsicht/);
  const near = body(await invokeTool(tool(damsModule, "get_dams_nearby"), { lat: 46.08, lon: 7.4, radius_km: 5, limit: 5 }));
  assert.equal(near.data.dams[0].name, "Grande Dixence");
  assert.ok(near.data.dams[0].distance_km < 1);
  assert.equal(urls.length, 1, "second call served from cache");
  const none = await invokeTool(tool(damsModule, "search_dams"), { query: "nonexistent dam xyz", sort_by: "height", order: "desc", limit: 5 });
  assert.equal(none.isError, true);
});

// ── traffic ─────────────────────────────────────────────────────────────

test("traffic: busiest station, road and canton filters, heavy-goods ranking, data_as_of = count year", async () => {
  route(() => json(TRAFFIC));
  const busiest = body(await invokeTool(tool(trafficModule, "get_traffic_counts"), { sort_by: "daily", limit: 1 }));
  assert.equal(busiest.data.stations[0].station, "WALLISELLEN (AB)");
  assert.equal(busiest.data.stations[0].road, "A 1");
  assert.ok(busiest.data.stations[0].daily_avg > 100_000);
  assert.match(busiest.data_as_of, /^\d{4}$/);
  const gott = body(await invokeTool(tool(trafficModule, "get_traffic_counts"), { station: "gotthard", sort_by: "daily", limit: 5 }));
  assert.deepEqual(gott.data.stations.map((s) => s.station), ["GOTTHARDTUNNEL", "HOSPENTAL S, ST. GOTTHARD"]);
  const a1 = body(await invokeTool(tool(trafficModule, "get_traffic_counts"), { road: "a1", canton: "zh", sort_by: "daily", limit: 10 }));
  assert.ok(a1.data.stations.every((s) => s.road === "A 1" && s.canton === "ZH"));
  const near = body(await invokeTool(tool(trafficModule, "get_traffic_counts_nearby"), { lat: 47.05, lon: 8.31, radius_km: 10, limit: 3 }));
  assert.ok(near.data.stations.length >= 1 && near.data.stations[0].distance_km <= 10);
});

test("traffic: filterStations sorts missing figures last", () => {
  const all = [
    { station: "A", daily_avg: null, heavy_traffic_pct: null },
    { station: "B", daily_avg: 5, heavy_traffic_pct: 2 },
  ];
  assert.deepEqual(filterStations(all, { sort_by: "daily" }).map((s) => s.station), ["B", "A"]);
});

// ── SBB ─────────────────────────────────────────────────────────────────

test("sbb: ridership summary with year-on-year change", () => {
  const s = summariseRidership([
    { bahnhof_gare_stazione: "Bern", code_codice: "BN", uic: 8507000, kt_ct_cantone: "BE", jahr_annee_anno: "2024", dtv_tjm_tgm: 220000, dwv_tmjo_tfm: 250000, dnwv_tmjno_tmgnl: 160000 },
    { bahnhof_gare_stazione: "Bern", jahr_annee_anno: "2023", dtv_tjm_tgm: 200000 },
  ]);
  assert.equal(s.station, "Bern");
  assert.equal(s.latest.year, 2024);
  assert.equal(s.latest.change_vs_previous_year_pct, 10);
  assert.equal(s.by_year[1].change_vs_previous_year_pct, null);
});

test("sbb: helpers (ODSQL quoting, on-time share, track-free flag)", () => {
  assert.equal(odsString('Zürich "HB"\\'), '"Zürich HB"');
  assert.equal(onTimePct(5, 100), 95);
  assert.equal(onTimePct(0, 0), null);
  assert.equal(isTrackFree("ja"), true);
  assert.equal(isTrackFree("Nein"), false);
  assert.equal(isTrackFree(""), null);
});

test("sbb: punctuality combines counts and the most-delayed lines; unknown names get suggestions", async () => {
  route((u) => {
    const where = u.searchParams.get("where") ?? "";
    if (u.pathname.includes("ist-daten-sbb")) {
      if (where.includes(" like ")) return json({ total_count: 1, results: [{ haltestellen_name: "Olten" }] });
      if (where.includes('"Oltn"')) return json({ total_count: 0, results: [] });
      if (u.searchParams.get("group_by")) return json({ total_count: 2, results: [{ linien_text: "IC1", n: 7 }, { linien_text: "S23", n: 3 }] });
      if (where.includes("ankunftsverspatung")) return json({ total_count: 12, results: [] });
      if (where.includes("abfahrtsverspatung")) return json({ total_count: 8, results: [] });
      if (where.includes("faellt_aus_tf")) return json({ total_count: 1, results: [] });
      return json({ total_count: 400, results: [{ betriebstag: "2026-11-07" }] });
    }
    return json({ total_count: 0, results: [] });
  });
  const ok = body(await invokeTool(tool(sbbModule, "get_station_punctuality"), { station: "Olten" }));
  assert.equal(ok.data.stops, 400);
  assert.equal(ok.data.on_time_arrivals_pct, 97);
  assert.equal(ok.data.on_time_departures_pct, 98);
  assert.equal(ok.data.cancellations, 1);
  assert.deepEqual(ok.data.most_delayed_lines[0], { line: "IC1", delayed_arrivals: 7 });
  assert.equal(ok.data_as_of, "2026-11-07");
  const miss = await invokeTool(tool(sbbModule, "get_station_punctuality"), { station: "Oltn" });
  assert.equal(miss.isError, true);
  assert.match(miss.content[0].text, /Did you mean: Olten/);
});

test("sbb: platforms summary", async () => {
  route(() =>
    json({
      total_count: 3,
      results: [
        { bps: "BN", bps_name: "Bern", p_nr: "1", p_lange: 420, z_schienenfrei: "ja", perrontyp: "Mittelperron" },
        { bps: "BN", bps_name: "Bern", p_nr: "2", p_lange: 380, z_schienenfrei: "ja", perrontyp: "Mittelperron" },
        { bps: "BN", bps_name: "Bern", p_nr: "13", p_lange: 150, z_schienenfrei: "nein", perrontyp: "Seitenperron" },
      ],
    }),
  );
  const r = body(await invokeTool(tool(sbbModule, "get_station_platforms"), { station: "Bern" }));
  assert.equal(r.data.platform_count, 3);
  assert.equal(r.data.track_free_platforms, 2);
  assert.equal(r.data.platforms_requiring_track_crossing, 1);
  assert.equal(r.data.longest_platform_m, 420);
});

// ── property price index ────────────────────────────────────────────────

const IMPI_FILE = {
  dataStatus: "final",
  data: {
    total: { geoscope1: [{ year: "11.2023", value: 110 }, { year: "2.2024", value: 111 }, { year: "11.2024", value: 115.5 }] },
    efh: { geoscope1: [{ year: "11.2023", value: 112 }, { year: "2.2024", value: 113 }, { year: "11.2024", value: 118 }] },
    egw: { geoscope1: [{ year: "11.2023", value: 108 }, { year: "2.2024", value: 109 }, { year: "11.2024", value: 113.4 }] },
  },
};

test("realestate: quarter labels, parsing and year-on-year change", () => {
  assert.equal(quarterOf("2.2024"), "2024-Q1");
  assert.equal(quarterOf("11.2024"), "2024-Q4");
  assert.equal(quarterOf("x"), undefined);
  const rows = withChanges(parseImpi(IMPI_FILE));
  assert.deepEqual(rows.map((r) => r.period), ["2023-Q4", "2024-Q1", "2024-Q4"]);
  assert.equal(rows[2].yoy_change_pct.all, 5);
  assert.equal(rows[2].yoy_change_pct.apartments, 5);
  assert.equal(rows[1].yoy_change_pct.all, null);
});

test("realestate: tool finds the current asset, then the file; period filters", async () => {
  route((u) => {
    if (u.pathname.endsWith("/assets")) {
      assert.equal(u.searchParams.get("orderNr"), "ds-x-05.06.03.01.02");
      return json({ data: [{ bfs: { lifecycle: { code: "CURRENT" } }, links: [{ rel: "master", href: "https://dam-api.bfs.admin.ch/hub/api/dam/assets/123/master" }] }] });
    }
    return json(IMPI_FILE);
  });
  const r = body(await invokeTool(tool(realestateModule, "get_property_price_index"), { last: 8 }));
  assert.equal(r.data.latest.period, "2024-Q4");
  assert.equal(r.data_as_of, "2024-Q4");
  assert.equal(r.data.change_over_period_pct.all, 5);
  assert.equal(r.provenance.upstream.length, 2);
  const one = body(await invokeTool(tool(realestateModule, "get_property_price_index"), { from: "2024", to: "2024", last: 8 }));
  assert.deepEqual(one.data.quarters.map((q) => q.period), ["2024-Q1", "2024-Q4"]);
});
