/**
 * Offline tests for the modules added to reach and exceed mcp-swiss parity
 * (dams, traffic, sbb, meteoogd, realestate, openparl, geo/building extras,
 * postcode directory, waste calendar, voting details, companies by locality)
 * and for discovery mode. No network: pure functions plus stubbed fetch.
 *
 * Run: npm run build && node --test test/modules-c.test.mjs
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";

import { ALL_MODULES, PRESETS } from "../dist/registry.js";
import { discoveryTools, queryWords, discoveryEnabled } from "../dist/discovery.js";
import { mapDam, matchDams } from "../dist/modules/dams.js";
import { mapStation } from "../dist/modules/traffic.js";
import { odsString, punctualityFromGroups, delayMinutes, mapPlatform, groupFrequencies, mapDisruption } from "../dist/modules/sbb.js";
import { ogdTime, filesFor, selectColumns, toRows, pollenSpecies, pollenRows } from "../dist/modules/meteoogd.js";
import { fromPeriod, mapSeries } from "../dist/modules/realestate.js";
import { tr, excerpt, stripTags, mapAffair } from "../dist/modules/openparl.js";
import { parsePlaceLabel } from "../dist/modules/geoextra.js";
import { groupPostcodes } from "../dist/modules/postcode.js";
import { wasteCalendar } from "../dist/modules/waste.js";
import { snowDepthChange } from "../dist/modules/snow.js";
import { matchesAll } from "../dist/modules/news.js";
import { pickCommunity } from "../dist/modules/companies.js";
import { parseDsv, parseDsvObjects } from "../dist/modules/_csv.js";
import { readZip } from "../dist/modules/_zip.js";
import { inBbox, CANTON_BBOX_LV95, mapLimit } from "../dist/modules/_geoadmin.js";
import { decodeBody } from "../dist/core/http.js";

const body = (res) => JSON.parse(res.content[0].text);
const allTools = ALL_MODULES.flatMap((m) => m.tools);
const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

// ── registry ────────────────────────────────────────────────────────────────
test("registry: tool names are unique and every preset names real modules", () => {
  const names = allTools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "duplicate tool name");
  const ids = new Set(ALL_MODULES.map((m) => m.id));
  for (const [preset, mods] of Object.entries(PRESETS)) for (const id of mods) assert.ok(ids.has(id), `${preset} → ${id}`);
});

test("registry: covers every mcp-swiss capability by tool name or equivalent", () => {
  const have = new Set(allTools.map((t) => t.name));
  for (const n of [
    "get_station_passengers", "get_station_punctuality", "get_station_accessibility", "search_dams", "get_dams_by_canton",
    "get_dam_details", "get_traffic_count", "get_traffic_by_canton", "get_traffic_nearby", "get_property_price_index",
    "get_rent_index", "search_real_estate_data", "list_ogd_stations", "get_ogd_recent", "get_ogd_history",
    "search_parliament_speeches", "get_politician_interests", "search_cantonal_affairs", "get_parliamentary_documents",
    "get_committee_meetings", "search_buildings", "buildings_near", "search_map_layers", "find_map_features", "search_places",
    "get_pollen_daily", "list_pollen_stations", "list_postcodes_in_canton", "search_companies_by_locality", "search_swiss_news",
    "get_waste_calendar", "search_votes", "get_vote_details", "list_avalanche_regions", "get_snow_measurements",
    "list_dataset_resources",
  ]) assert.ok(have.has(n), `missing ${n}`);
});

// ── discovery mode ──────────────────────────────────────────────────────────
test("discovery: three meta-tools; env switch", () => {
  const tools = discoveryTools(ALL_MODULES);
  assert.deepEqual(tools.map((t) => t.name), ["swissyphus_search_tools", "swissyphus_call_tool", "swissyphus_list_modules"]);
  const prev = process.env.SWISSYPHUS_MODE;
  process.env.SWISSYPHUS_MODE = "discovery";
  assert.equal(discoveryEnabled(), true);
  assert.equal(discoveryEnabled(false), false, "explicit flag wins");
  process.env.SWISSYPHUS_MODE = prev ?? "";
});

test("discovery: stopwords dropped, synonyms added, word-start matching", async () => {
  assert.deepEqual(queryWords("is the law in force").map((w) => w[0]), ["law", "force"]);
  assert.ok(queryWords("electricity price")[1].includes("tariff"));
  const [search] = discoveryTools(ALL_MODULES);
  const top = async (q) => body(await search.handler({ query: q, limit: 1 })).data.tools[0].name;
  assert.equal(await top("train departures"), "get_departures");
  assert.equal(await top("is the law in force"), "get_law_by_sr");
  assert.equal(await top("electricity price"), "get_electricity_tariff");
  assert.equal(await top("train punctuality"), "get_station_punctuality");
});

test("discovery: search returns JSON input schemas; module filter validated", async () => {
  const [search] = discoveryTools(ALL_MODULES);
  const d = body(await search.handler({ module: "dams", limit: 10 })).data;
  assert.equal(d.match_count, 3);
  assert.equal(d.tools[0].input_schema.type, "object");
  const bad = await search.handler({ module: "nope", limit: 3 });
  assert.equal(bad.isError, true);
});

test("discovery: call_tool validates arguments before running the tool", async () => {
  const [, call] = discoveryTools(ALL_MODULES);
  const unknown = await call.handler({ name: "get_nothing", arguments: {} });
  assert.equal(body(unknown).kind, "invalid_input");
  const invalid = await call.handler({ name: "get_traffic_nearby", arguments: { lat: 99, lon: 8 } });
  assert.equal(invalid.isError, true);
  assert.match(body(invalid).error, /lat/);
});

test("discovery: call_tool runs the real handler with schema defaults applied", async () => {
  let seen;
  globalThis.fetch = async (url) => {
    seen = String(url);
    return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const [, call] = discoveryTools(ALL_MODULES);
  const res = await call.handler({ name: "get_traffic_by_canton", arguments: { canton: "Uri" } });
  globalThis.fetch = realFetch;
  assert.match(seen, /searchText=UR/);
  assert.equal(body(res).data.canton, "UR");
});

// ── dams / traffic / geo.admin helpers ──────────────────────────────────────
test("dams: LV95 → WGS84 and name ranking (exact before prefix before contains)", () => {
  const d = mapDam({ featureId: 1, attributes: { damname: "Grande Dixence", damheight: 285, impoundmentvolume: "385.000" }, geometry: { x: 2595800, y: 1102900 } });
  assert.equal(d.reservoir_volume_mio_m3, 385);
  assert.ok(d.lat > 46 && d.lat < 46.2 && d.lon > 7.3 && d.lon < 7.5);
  const dams = [{ name: "Dixence Nord" }, { name: "Grande Dixence", height_m: 285 }, { name: "Dixence", height_m: 10 }];
  assert.deepEqual(matchDams(dams, "dixence").map((x) => x.name), ["Dixence", "Dixence Nord", "Grande Dixence"]);
});

test("traffic: stations without counts are flagged, coordinates from locationlv95", () => {
  const s = mapStation({ featureId: 5, attributes: { mlocname: "X", canton: "UR", locationlv95: "2690000,1170000", dtv: null } });
  assert.equal(s.has_counts, false);
  assert.equal(s.counts, undefined);
  assert.ok(s.lat > 46.5 && s.lat < 47);
});

test("geo.admin: canton bounding boxes and concurrency helper", async () => {
  assert.equal(Object.keys(CANTON_BBOX_LV95).length, 26);
  assert.equal(inBbox(2600000, 1200000, CANTON_BBOX_LV95.BE), true);
  assert.equal(inBbox(2600000, 1200000, CANTON_BBOX_LV95.GR), false);
  let active = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (x) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return x * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12]);
  assert.ok(peak <= 2);
});

test("geo: gazetteer label parsing", () => {
  assert.deepEqual(parsePlaceLabel("<i>Alpin peak</i> <b>Eiger</b> (BE) - Grindelwald"), { name: "Eiger", kind: "Alpin peak", canton: "BE", municipality: "Grindelwald" });
});

// ── SBB ─────────────────────────────────────────────────────────────────────
test("sbb: ODSQL string literal escaping", () => {
  assert.equal(odsString('Zürich "HB"'), '"Zürich \\"HB\\""');
  assert.equal(odsString("a\\b"), '"a\\\\b"');
});

test("sbb: punctuality uses SBB's <3 min definition, cancellations separate", () => {
  const p = punctualityFromGroups([
    { ankunftsverspatung: "false", faellt_aus_tf: false, n: 90 },
    { ankunftsverspatung: "true", faellt_aus_tf: false, n: 10 },
    { ankunftsverspatung: "false", faellt_aus_tf: true, n: 5 },
  ]);
  assert.equal(p.punctuality_pct, 90);
  assert.equal(p.cancelled_stops, 5);
  assert.equal(p.scheduled_stops, 105);
});

test("sbb: delay is actual minus scheduled (positive = late)", () => {
  assert.equal(delayMinutes("2026-11-06T09:20:00", "2026-11-06T10:36:46"), 76.8);
  assert.equal(delayMinutes("2026-11-06T09:20:00", undefined), undefined);
});

test("sbb: platforms, passenger years and disruptions map cleanly", () => {
  assert.equal(mapPlatform({ p_nr: "2/3", perrontyp: "Mittelperron", z_schienenfrei: "ja" }).step_free_access, true);
  assert.equal(mapPlatform({ z_schienenfrei: "nein" }).step_free_access, false);
  const g = groupFrequencies([
    { bahnhof_gare_stazione: "Bern", jahr_annee_anno: "2023", dtv_tjm_tgm: 1 },
    { bahnhof_gare_stazione: "Bern", jahr_annee_anno: "2025", dtv_tjm_tgm: 3 },
  ]);
  assert.deepEqual(g[0].years.map((y) => y.year), [2025, 2023]);
  assert.equal(mapDisruption({ description: "a\n  b" }).description, "a b");
});

// ── MeteoSwiss OGD ──────────────────────────────────────────────────────────
test("meteoogd: timestamps, file selection and default parameters", () => {
  assert.equal(ogdTime("07.11.2026 00:10"), "2026-11-07T00:10Z");
  assert.deepEqual(filesFor("daily", "2025-12-30", "2026-01-02", 2026), ["d_historical", "d_recent"]);
  assert.deepEqual(filesFor("hourly", "2018-05-01", "2021-01-01", 2026), ["h_historical_2010-2019", "h_historical_2020-2029"]);
  assert.deepEqual(filesFor("yearly", "1864-01-01", "2000-01-01", 2026), ["y"]);
  const header = ["station_abbr", "reference_timestamp", "tre200s0", "xchills0", "rre150z0"];
  assert.deepEqual(selectColumns(header, undefined), ["tre200s0", "rre150z0"]);
  assert.deepEqual(selectColumns(header, ["all"]), ["tre200s0", "xchills0", "rre150z0"]);
  assert.deepEqual(toRows([{ reference_timestamp: "01.01.2026 00:00", tre200s0: "-1.5", rre150z0: "" }], ["tre200s0", "rre150z0"]), [
    { time: "2026-01-01T00:00Z", tre200s0: -1.5, rre150z0: null },
  ]);
});

test("meteoogd: pollen species columns renamed", () => {
  assert.equal(pollenSpecies("kabetud1"), "birch");
  assert.equal(pollenSpecies("khpoacd1"), "grasses");
  assert.equal(pollenSpecies("tre200s0"), undefined);
  const rows = pollenRows([{ reference_timestamp: "10.04.2026 00:00", kabetud0: "600", kabetud1: "666" }], "d1");
  assert.deepEqual(rows, [{ time: "2026-04-10T00:00Z", birch: 666 }]);
});

// ── real estate ─────────────────────────────────────────────────────────────
test("realestate: period parsing and year-on-year change", () => {
  assert.equal(fromPeriod("2020", "quarterly"), "2020-Q1");
  assert.equal(fromPeriod("2020-q3", "quarterly"), "2020-Q3");
  assert.equal(fromPeriod("2020-Q3", "annual"), "2020");
  const s = mapSeries({
    metadata: { frequency: "P3M", unit: "Q1 2000 = 100" },
    values: [100, 101, 102, 103, 110].map((value, i) => ({ date: `2025-Q${i + 1}`, value })),
  });
  assert.equal(s.change_yoy_pct, 10);
});

// ── OpenParlData ────────────────────────────────────────────────────────────
test("openparl: language fallback, excerpts and affair mapping", () => {
  assert.equal(tr({ de: "Motion", fr: "Motion F" }), "Motion");
  assert.equal(tr({ en: "E", de: "D" }), "E");
  assert.equal(stripTags("<p>Ein <b>Satz</b></p>"), "Ein Satz");
  const ex = excerpt("x".repeat(400) + " Klimaschutz " + "y".repeat(400), "klimaschutz", 100);
  assert.ok(ex.startsWith("…") && ex.includes("Klimaschutz"));
  assert.equal(mapAffair({ id: 1, title: { de: "T" }, begin_date: "2026-04-27T00:00:00" }).submitted, "2026-04-27");
});

// ── postcode / waste / snow / news / companies ──────────────────────────────
test("postcode: one entry per PLZ+locality listing every municipality", () => {
  const g = groupPostcodes([
    { postal_code: "6300", locality: "Zug", municipality: "Zug", language: "de", lat: 1, lon: 1 },
    { postal_code: "6300", locality: "Zug", municipality: "Baar", language: "de", lat: 1, lon: 1 },
  ]);
  assert.deepEqual(g, [{ postal_code: "6300", locality: "Zug", municipalities: ["Zug", "Baar"], language: "de", lat: 1, lon: 1 }]);
});

test("waste: calendar grouped by day with per-type next date and count", () => {
  const c = wasteCalendar([
    { date: "2026-11-10", waste_type: "waste" },
    { date: "2026-11-09", waste_type: "organic" },
    { date: "2026-11-10", waste_type: "paper" },
    { date: "2026-11-17", waste_type: "waste" },
  ]);
  assert.deepEqual(c.calendar.map((d) => d.date), ["2026-11-09", "2026-11-10", "2026-11-17"]);
  assert.deepEqual(c.summary.waste, { next: "2026-11-10", count: 2 });
});

test("snow: 24 h depth change ignores missing values", () => {
  assert.equal(snowDepthChange([{ measure_date: "b", HS: 6.15 }, { measure_date: "a", HS: 2.25 }, { measure_date: "c", HS: null }]), 3.9);
});

test("news: every keyword must be in the headline, accents ignored", () => {
  assert.equal(matchesAll("Zürich: SNB senkt den Zins", "zurich zins"), true);
  assert.equal(matchesAll("Zürich: SNB senkt den Zins", "zurich bern"), false);
});

test("companies: municipality resolution, ambiguity and replaced communities", () => {
  const list = [
    { id: 1, name: "Buchs (AG)", canton: "AG", bfsId: 4007 },
    { id: 2, name: "Buchs (SG)", canton: "SG", bfsId: 3271 },
    { id: 3, name: "Zug", canton: "ZG", bfsId: 1711 },
    { id: 4, name: "Zug", canton: "ZG", bfsId: 9999, replacedById: 3 },
  ];
  assert.equal(pickCommunity(list, "Buchs").length, 2);
  assert.equal(pickCommunity(list, "Buchs", "SG")[0].id, 2);
  assert.deepEqual(pickCommunity(list, "zug").map((c) => c.id), [3]);
  assert.equal(pickCommunity(list, "1711")[0].name, "Zug");
});

// ── CSV / ZIP / decoding ────────────────────────────────────────────────────
test("csv: quoted delimiters, escaped quotes, CRLF and BOM", () => {
  assert.deepEqual(parseDsv('a;"b;c";"say ""hi"""\r\n1;2;3'), [["a", "b;c", 'say "hi"'], ["1", "2", "3"]]);
  assert.deepEqual(parseDsvObjects("﻿x;y\n1;"), [{ x: "1", y: "" }]);
});

/** Build a one-entry deflate ZIP in memory. */
function makeZip(name, content) {
  const data = Buffer.from(content, "utf8");
  const comp = deflateRawSync(data);
  const nameBuf = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = local.length + nameBuf.length + comp.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameBuf, comp, central, nameBuf, eocd]);
}

test("zip: reads a deflated entry; rejects non-ZIP input", () => {
  const entries = readZip(makeZip("dir/a.csv", "PLZ4;Ort\n8001;Zürich\n"));
  assert.equal(entries[0].name, "dir/a.csv");
  assert.equal(entries[0].data().toString("utf8"), "PLZ4;Ort\n8001;Zürich\n");
  assert.throws(() => readZip(Buffer.from("not a zip at all, definitely not")), /Not a ZIP/);
});

test("http: UTF-8 kept as-is, Latin-1 bodies decoded via Windows-1252", () => {
  assert.equal(decodeBody(Buffer.from("Oberägeri", "utf8")), "Oberägeri");
  assert.equal(decodeBody(Buffer.from([0x4f, 0x62, 0x65, 0x72, 0xe4, 0x67, 0x65, 0x72, 0x69])), "Oberägeri");
});
