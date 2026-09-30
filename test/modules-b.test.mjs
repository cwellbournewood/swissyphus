/**
 * Offline value tests for the data-correctness fixes in the "B" module group
 * (law, voting, alerts, avalanche, snow, trails, earthquakes, airquality, fx,
 * holidays, waste, news, lindas, postcode, buildings, coords).
 *
 * Run against the compiled output:  npm run build && node --test test/modules-b.test.mjs
 *
 * Fixtures under test/fixtures/ are SYNTHETIC: they are modelled on the
 * documented upstream shapes, not captured responses. Replace them with
 * captured responses once the live canary has recorded real payloads.
 * Handler-level tests stub globalThis.fetch — no network is used.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { swissDate, swissYear, swissMonth, addDays, isValidIsoDate } from "../dist/modules/_time.js";
import { resolveCanton, regionTerms, matchesRegion } from "../dist/modules/_cantons.js";
import { pairError } from "../dist/modules/_args.js";
import {
  selectActs,
  rankSearchResults,
  buildSearchSparql,
  endedFilter,
  sanitizeLiteral,
} from "../dist/modules/law.js";
import { cantonalMajority } from "../dist/modules/voting.js";
import { parseAlerts, filterAlertsByRegion, alertsModule } from "../dist/modules/alerts.js";
import {
  summarizeFeature,
  countRegions,
  featureContains,
  dangerLevel,
} from "../dist/modules/avalanche.js";
import { latestPerStation } from "../dist/modules/snow.js";
import { parseFdsnText, fdsnTime, sedQuery, SED_BASES } from "../dist/modules/earthquakes.js";
import { LRV_LIMITS } from "../dist/modules/airquality.js";
import { validValues, monthRangeError, fxModule } from "../dist/modules/fx.js";
import { holidaysForScope, cantonParam, holidaysModule } from "../dist/modules/holidays.js";
import { parseRss, decodeEntities, rssText, newsModule } from "../dist/modules/news.js";
import { guardSparql, maskSparql, MAX_LIMIT, DEFAULT_LIMIT, MAX_QUERY_LENGTH } from "../dist/modules/lindas.js";
import { splitZipLabel } from "../dist/modules/postcode.js";
import { parseBuildingXml } from "../dist/modules/buildings.js";
import { interpretLv, checkWgs84 } from "../dist/modules/coordsModule.js";
import { trailsModule } from "../dist/modules/trails.js";

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name) => readFileSync(resolve(fixtures, name), "utf8");
const json = (name) => JSON.parse(fixture(name));

// ── fetch stub for handler-level tests ───────────────────────────────────────
const realFetch = globalThis.fetch;
const routes = new Map(); // url prefix → { status, body }
globalThis.fetch = async (url) => {
  const u = String(url);
  for (const [prefix, r] of routes) {
    if (u.startsWith(prefix)) return new Response(r.body, { status: r.status ?? 200 });
  }
  throw new Error(`unexpected network access in offline test: ${u}`);
};
after(() => {
  globalThis.fetch = realFetch;
});
const handler = (mod, name) => mod.tools.find((t) => t.name === name).handler;
const body = (res) => JSON.parse(res.content[0].text);

// ── Swiss-local time ────────────────────────────────────────────────────────
test("time: 23:30 UTC is already the next day in Switzerland (CEST and CET)", () => {
  assert.equal(swissDate(new Date("2026-06-30T23:30:00Z")), "2026-07-01"); // CEST, 01:30 local
  assert.equal(swissDate(new Date("2026-12-31T23:30:00Z")), "2027-01-01"); // CET, 00:30 local
  assert.equal(swissYear(new Date("2026-12-31T23:30:00Z")), 2027);
  assert.equal(swissDate(new Date("2026-01-15T22:30:00Z")), "2026-01-15"); // 23:30 local
  assert.equal(swissMonth(-1, new Date("2026-03-31T23:30:00Z")), "2026-03"); // local April 1 → prev = March
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
  assert.equal(isValidIsoDate("2026-02-30"), false);
  assert.equal(isValidIsoDate("2024-02-29"), true);
});

// ── cantons ─────────────────────────────────────────────────────────────────
test("cantons: names in DE/FR/IT/EN resolve, diacritics optional", () => {
  assert.equal(resolveCanton("Genève"), "GE");
  assert.equal(resolveCanton("geneva"), "GE");
  assert.equal(resolveCanton("Genf"), "GE");
  assert.equal(resolveCanton("graubunden"), "GR");
  assert.equal(resolveCanton("CH-zh"), "ZH");
  assert.equal(resolveCanton("Atlantis"), undefined);
  assert.equal(matchesRegion(["Security test"], regionTerms("Uri")), false, "word-start match, not substring");
});

// ── law ─────────────────────────────────────────────────────────────────────
test("law: get_law_by_sr never merges acts; the in-force act is primary", () => {
  const bindings = json("law-sr-235.1.json").results.bindings;
  const { primary, others } = selectActs(bindings, "2026-09-26");
  assert.equal(primary.consoUri, "https://fedlex.data.admin.ch/eli/cc/2022/491");
  assert.equal(primary.in_force, true);
  assert.equal(primary.no_longer_in_force_from, undefined);
  assert.equal(primary.titles.de.abbreviation, "Datenschutzgesetz, DSG");
  assert.equal(others.length, 1);
  assert.equal(others[0].consoUri, "https://fedlex.data.admin.ch/eli/cc/1993/1945_1945_1945");
  assert.equal(others[0].in_force, false);
  assert.equal(others[0].no_longer_in_force_from, "2023-09-01");
  // Binding order must not matter (the old code let the last row win).
  const reversed = selectActs([...bindings].reverse(), "2026-09-26");
  assert.equal(reversed.primary.consoUri, primary.consoUri);
});

test("law: before the successor's entry into force, the old act is primary", () => {
  const bindings = json("law-sr-235.1.json").results.bindings;
  const { primary } = selectActs(bindings, "2023-08-31");
  assert.equal(primary.consoUri, "https://fedlex.data.admin.ch/eli/cc/1993/1945_1945_1945");
  assert.equal(primary.in_force, true);
});

test("law: search ranks exact abbreviation matches first and has a type-safe date filter", () => {
  const bindings = [
    { sr: { value: "172.010" }, titleStr: { value: "Regierungs- und Verwaltungsorganisationsverordnung" }, abbrStr: { value: "RVOV" } },
    { sr: { value: "220" }, titleStr: { value: "Bundesgesetz betreffend die Ergänzung des Schweizerischen Zivilgesetzbuches (Fünfter Teil: Obligationenrecht)" }, abbrStr: { value: "OR" } },
    { sr: { value: "641.20" }, titleStr: { value: "Mehrwertsteuerverordnung" }, abbrStr: { value: "MWSTV" } },
  ];
  const ranked = rankSearchResults(bindings, "or");
  assert.equal(ranked[0].sr_number, "220");
  assert.equal(ranked[0].rank, 0);

  const sparql = buildSearchSparql({ term: "or", langUri: "http://x/DEU", inForceOnly: true, limit: 5, today: "2026-09-26" });
  assert.ok(!/NOW\(\)/.test(sparql), "no xsd:date vs xsd:dateTime comparison");
  assert.match(sparql, /SUBSTR\(STR\(\?end\), 1, 10\) <= "2026-09-26"/);
  assert.match(sparql, /ORDER BY \?rank/);
  assert.equal(endedFilter("?x", "2026-01-01"), 'FILTER(SUBSTR(STR(?x), 1, 10) <= "2026-01-01")');
  assert.throws(() => endedFilter("?x", 'x") }'));
  assert.equal(sanitizeLiteral('"")}'), "", "empty after sanitize → handler rejects it");
});

// ── voting ──────────────────────────────────────────────────────────────────
test("voting: cantonal majority counts half-cantons as ½", () => {
  const [tie, halvesDecide, noHalves] = json("voting-vote-day.json").schweiz.vorlagen.map((v) => cantonalMajority(v.staende));
  assert.equal(tie.yes_cantons, 11.5);
  assert.equal(tie.no_cantons, 11.5);
  assert.equal(tie.majority_of_cantons, false, "a 11.5 : 11.5 tie is not a majority");
  assert.equal(halvesDecide.yes_cantons, 12.5);
  assert.equal(halvesDecide.no_cantons, 10.5);
  assert.equal(halvesDecide.majority_of_cantons, true);
  assert.equal(noHalves.half_cantons_reported, false);
  assert.equal(noHalves.yes_cantons, 13);
  assert.equal(noHalves.majority_of_cantons, true, "12+ whole cantons is decisive even without halves");
  assert.equal(cantonalMajority({ jaStaendeGanz: 10, neinStaendeGanz: 10 }).majority_of_cantons, undefined);
  assert.equal(cantonalMajority(undefined), undefined);
});

// ── alerts ──────────────────────────────────────────────────────────────────
test("alerts: unrecognised shapes are NOT 'no alerts'", () => {
  assert.equal(parseAlerts({}), undefined);
  assert.equal(parseAlerts({ alerts: "x" }), undefined);
  assert.equal(parseAlerts(null), undefined);
  assert.equal(parseAlerts([]), undefined);
  assert.deepEqual(parseAlerts({ alerts: [] }), []);
});

test("alerts: region filter is diacritic-insensitive and multilingual", () => {
  const alerts = parseAlerts(json("alerts-actual.json"));
  assert.equal(alerts.length, 3);
  for (const q of ["Geneva", "Genf", "geneve", "GE", "Genève"]) {
    assert.deepEqual(filterAlertsByRegion(alerts, q).map((a) => a.id), ["a-1"], q);
  }
  assert.deepEqual(filterAlertsByRegion(alerts, "Grisons").map((a) => a.id), ["a-2"]);
  assert.deepEqual(filterAlertsByRegion(alerts, "graubunden").map((a) => a.id), ["a-2"]);
  assert.deepEqual(filterAlertsByRegion(alerts, "Zurich").map((a) => a.id), ["a-3"]);
  assert.deepEqual(filterAlertsByRegion(alerts, "Uri"), []);
});

test("alerts handler: changed format → error, never an all-clear", async () => {
  routes.set("https://www.alert.swiss/", { body: JSON.stringify({ items: [] }) });
  const res = await handler(alertsModule, "get_emergency_alerts")({ include_tests: false, limit: 20 });
  assert.equal(res.isError, true);
  assert.match(body(res).error, /could NOT be determined/);
  routes.delete("https://www.alert.swiss/");
});

// ── avalanche ───────────────────────────────────────────────────────────────
test("avalanche: CAAML per-bulletin features map words to 1–5 and count regions", () => {
  const { features } = json("avalanche-caaml.json");
  const b = summarizeFeature(features[0]);
  assert.equal(b.bulletin_id, "b-east");
  assert.equal(b.regions.length, 3);
  assert.equal(b.regions[2].name, "Prättigau");
  assert.equal(b.danger_rating, 3, "max of moderate(2) and considerable(3)");
  assert.equal(b.danger_rating_word, "considerable");
  assert.equal(b.danger_breakdown.length, 2);
  assert.equal(b.danger_breakdown[0].elevation, "below 2200 m");
  assert.equal(b.danger_breakdown[1].elevation, "above 2200 m");
  const legacy = summarizeFeature(features[1]);
  assert.equal(legacy.danger_rating, 1);
  assert.deepEqual(legacy.regions, [{ id: "CH-1111", name: "Jura" }]);
  assert.equal(countRegions([b, legacy]), 4, "regions, not bulletins");
  assert.equal(dangerLevel("very_high"), 5);
  assert.equal(dangerLevel("no_rating"), null);
  assert.equal(dangerLevel({ mainValue: "high" }), 4);
});

test("avalanche: point-in-polygon honours holes", () => {
  const { features } = json("avalanche-caaml.json");
  assert.equal(featureContains(features[0], 46.2, 9.2), true);
  assert.equal(featureContains(features[0], 46.5, 9.5), false, "inside the hole");
  assert.equal(featureContains(features[1], 47.0, 6.5), true, "MultiPolygon");
  assert.equal(featureContains(features[1], 47.0, 8.5), false);
});

// ── snow ────────────────────────────────────────────────────────────────────
test("snow: only the latest measurement per station is kept", () => {
  const rows = latestPerStation([
    { station_code: "DAV2", measure_date: "2026-01-10T10:00:00Z", HS: 100 },
    { station_code: "DAV2", measure_date: "2026-01-10T10:30:00Z", HS: 102 },
    { station_code: "SLF2", measure_date: "2026-01-10T10:30:00Z", HS: 50 },
    { measure_date: "2026-01-10T10:30:00Z", HS: 999 },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.station_code === "DAV2").HS, 102);
  assert.match(pairError(46.8, undefined, "near_lat", "near_lon"), /both near_lat and near_lon/);
  assert.equal(pairError(undefined, undefined, "a", "b"), undefined);
});

// ── trails ──────────────────────────────────────────────────────────────────
test("trails: no nationwide claim", () => {
  assert.ok(!/nationwide or/i.test(trailsModule.description));
  const t = trailsModule.tools.find((x) => x.name === "get_trail_closures");
  assert.match(t.description, /no nationwide listing/i);
});

// ── earthquakes ─────────────────────────────────────────────────────────────
test("earthquakes: 13-column rows have no event_type; 14-column rows do", () => {
  const r13 = "smi:ch.ethz.sed/sc25a/Event/2026aaaa|2026-07-01T12:00:00Z|46.8|9.8|5.2|SED|SED|SED|1|MLh|2.4|SED|Chur GR";
  const r14 = `${r13.replace("2026aaaa", "2026bbbb")}|earthquake`;
  const [a, b] = parseFdsnText(`${r13}\n${r14}`);
  assert.equal("event_type" in a, false);
  assert.equal(b.event_type, "earthquake");
  assert.equal(a.event_id, "smi:ch.ethz.sed/sc25a/Event/2026aaaa", "full publicID kept");
  // A header without EventType is authoritative: no event_type even for extra columns.
  const hdr = "#EventID|Time|Latitude|Longitude|Depth/km|Author|Catalog|Contributor|ContributorID|MagType|Magnitude|MagAuthor|EventLocationName";
  assert.equal("event_type" in parseFdsnText(`${hdr}\n${r13}`)[0], false);
  assert.equal(fdsnTime("2026-01-31", true), "2026-01-31T23:59:59");
  assert.equal(fdsnTime("2026-01-01", false), "2026-01-01T00:00:00");
});

// ── air quality ─────────────────────────────────────────────────────────────
test("airquality: PM10 daily limit allows 3 exceedances per year (LRV Annex 7)", () => {
  const pm10 = LRV_LIMITS.find((l) => l.pollutant === "PM10");
  assert.match(pm10.limit, /at most 3 times per year/);
  assert.ok(!/1 exceedance/.test(pm10.limit));
});

// ── fx ──────────────────────────────────────────────────────────────────────
test("fx: null values are dropped; month ranges are validated and bounded", () => {
  const vals = validValues({
    values: [
      { date: "2026-01", value: 0.93 },
      { date: "2026-02", value: null },
      { date: "2026-03" },
    ],
  });
  assert.deepEqual(vals, [{ date: "2026-01", value: 0.93 }]);
  assert.equal(monthRangeError("2026-01", "2026-06"), undefined);
  assert.match(monthRangeError("2026-06", "2026-01"), /after/);
  assert.match(monthRangeError("2026-13", "2026-12"), /not a valid/);
  assert.match(monthRangeError("1990-01", "2026-01"), /maximum/);
});

test("fx: health-probe dates are computed at probe time, not import time", () => {
  const probe = fxModule.healthProbes[0];
  assert.ok(Object.getOwnPropertyDescriptor(probe, "url").get, "url is a getter");
  assert.match(probe.url, new RegExp(`toDate=${swissMonth()}`));
});

// ── holidays ────────────────────────────────────────────────────────────────
test("holidays: nationwide check counts only nationwide === true", () => {
  const data = json("holidays-2026-01-02.json");
  assert.equal(holidaysForScope(data, undefined).length, 0, "Berchtoldstag is not nationwide");
  assert.equal(holidaysForScope(data, "ZH").length, 1);
  assert.equal(holidaysForScope([{ nationwide: true }, { nationwide: undefined }], undefined).length, 1);
  assert.deepEqual(cantonParam("Genève"), { code: "GE", subdivision: "CH-GE" });
  assert.match(cantonParam("XX").error, /Unknown canton/);
});

test("holidays handler: nationwide is_holiday false for a cantonal-only day; unknown canton is a tool error", async () => {
  routes.set("https://openholidaysapi.org/PublicHolidays", { body: fixture("holidays-2026-01-02.json") });
  const res = await handler(holidaysModule, "is_holiday_today")({ date: "2026-01-02" });
  const env = body(res);
  assert.equal(env.data.is_holiday, false);
  assert.equal(env.data.cantonal_holidays_elsewhere.length, 1);
  const bad = await handler(holidaysModule, "get_public_holidays")({ canton: "XX" });
  assert.equal(bad.isError, true);
  assert.match(body(bad).error, /Unknown canton 'XX'/);
  routes.delete("https://openholidaysapi.org/PublicHolidays");
});

test("holidays: licence text states ODbL share-alike", () => {
  assert.match(holidaysModule.sources[0].licence, /share-alike/i);
});

// ── news ────────────────────────────────────────────────────────────────────
test("news: titles/links/dates only, no summaries; entities decoded once after tag stripping", () => {
  const items = parseRss(fixture("news-rss.xml"));
  assert.equal(items.length, 2);
  for (const i of items) assert.deepEqual(Object.keys(i).sort(), ["link", "published", "title"]);
  assert.ok(!JSON.stringify(items).includes("teaser"), "no description text leaks");
  assert.equal(items[0].title, "Bundesrat & Parlament: Einigung");
  assert.equal(items[1].title, "Zürich: “Test” &lt;tag&gt; <i>literal</i>");
  assert.equal(decodeEntities("&amp;amp;"), "&amp;", "no double decode");
  assert.equal(decodeEntities("&#39;&#x41;&unknown;"), "'A&unknown;");
  assert.equal(rssText("<![CDATA[<p>a &amp; b</p>]]>"), "a & b");
});

test("news handler: response carries no summary field", async () => {
  routes.set("https://www.srf.ch/", { body: fixture("news-rss.xml") });
  const res = await handler(newsModule, "get_swiss_news")({ limit: 10 });
  const env = body(res);
  assert.equal(env.data.headlines.length, 2);
  assert.ok(env.data.headlines.every((h) => !("summary" in h)));
  routes.delete("https://www.srf.ch/");
});

// ── lindas ──────────────────────────────────────────────────────────────────
test("lindas: a subquery LIMIT does not satisfy the outer LIMIT guard", () => {
  const q = "SELECT * WHERE { { SELECT ?s WHERE { ?s ?p ?o } LIMIT 5 } }";
  const g = guardSparql(q);
  assert.equal(g.ok, true);
  assert.equal(g.limit, DEFAULT_LIMIT);
  assert.match(g.query, new RegExp(`\\}\\s*LIMIT ${DEFAULT_LIMIT}$`));
  assert.ok(g.query.includes("LIMIT 5 }"), "inner LIMIT untouched");
});

test("lindas: top-level LIMIT is clamped; LIMIT is placed before trailing VALUES", () => {
  const big = guardSparql("SELECT ?s WHERE { ?s ?p ?o } LIMIT 5000");
  assert.equal(big.ok, true);
  assert.equal(big.limit, MAX_LIMIT);
  assert.match(big.query, new RegExp(`LIMIT ${MAX_LIMIT}$`));
  const small = guardSparql("SELECT ?s WHERE { ?s ?p ?o } LIMIT 7");
  assert.equal(small.limit, 7);
  const values = guardSparql("SELECT ?s WHERE { ?s ?p ?o } VALUES ?s { <http://example.org/a> }");
  assert.equal(values.ok, true);
  assert.ok(values.query.indexOf(`LIMIT ${DEFAULT_LIMIT}`) < values.query.indexOf("VALUES"));
  const lit = guardSparql('SELECT ?s WHERE { ?s ?p "LIMIT 3" }');
  assert.equal(lit.limit, DEFAULT_LIMIT, "LIMIT inside a string literal does not count");
});

test("lindas: SERVICE federation and update operations are blocked", () => {
  const svc = guardSparql("SELECT * WHERE { SERVICE <https://evil.example/sparql> { ?s ?p ?o } }");
  assert.equal(svc.ok, false);
  assert.match(svc.error, /SERVICE/);
  assert.equal(guardSparql("select * where { service <http://x> { ?s ?p ?o } }").ok, false);
  assert.equal(guardSparql("INSERT DATA { <http://a> <http://b> <http://c> }").ok, false);
  assert.equal(guardSparql("DELETE WHERE { ?s ?p ?o }").ok, false);
  assert.equal(guardSparql("SELECT * WHERE { ?s ?p ?o } ; DROP ALL").ok, false);
  assert.equal(guardSparql("ASK { ?s ?p ?o }").ok, false, "only SELECT");
  assert.equal(guardSparql("x".repeat(MAX_QUERY_LENGTH + 1)).ok, false);
});

test("lindas: literals, IRIs, variables, prefixed names and comments don't trip the read-only check", () => {
  const q = `PREFIX ex: <http://example.org/with/add#>
# this comment mentions SERVICE and DELETE
SELECT ?with ?add WHERE {
  ?with ex:add ?add .
  FILTER(CONTAINS(?add, "add with delete; insert"))
  FILTER(?with != 'drop')
}`;
  const g = guardSparql(q);
  assert.equal(g.ok, true, g.error);
  assert.equal(maskSparql('"ab"').length, 4);
});

// ── postcode ────────────────────────────────────────────────────────────────
test("postcode: locality labels with a dash separator are split", () => {
  assert.deepEqual(splitZipLabel("8001 - Zürich"), { postal_code: "8001", locality: "Zürich" });
  assert.deepEqual(splitZipLabel("<b>8001</b> Zürich"), { postal_code: "8001", locality: "Zürich" });
  assert.deepEqual(splitZipLabel("1000 – Lausanne 25"), { postal_code: "1000", locality: "Lausanne 25" });
  assert.equal(splitZipLabel("Zürich").postal_code, null);
});

// ── buildings ───────────────────────────────────────────────────────────────
test("buildings: all entrances are returned; unknown EGID is not-found", () => {
  const xml = fixture("buildings-multi-entrance.xml");
  const b = parseBuildingXml(xml, "123456");
  assert.equal(b.status, "existing");
  assert.equal(b.construction_year, "1912");
  assert.equal(b.entrance_count, 2);
  assert.deepEqual(b.entrances.map((e) => `${e.street} ${e.house_number}`), ["Bahnhofstrasse 1", "Rennweg 2"]);
  assert.equal(b.coordinates_lv95.easting, "2683000.5", "building-level coords, not the entrance's");
  assert.equal(b.dwelling_count, 2);
  assert.equal(parseBuildingXml("<maddResponse><buildingList/></maddResponse>", "999999999"), undefined);
  assert.equal(parseBuildingXml(xml, "654321"), undefined, "EGID mismatch");
  assert.equal(parseBuildingXml("", "1"), undefined);
});

// ── coords ──────────────────────────────────────────────────────────────────
test("coords: LV95/LV03 detection, swapped axes and out-of-range input", () => {
  assert.deepEqual(interpretLv(2600000, 1200000), { ok: true, system: "LV95", e95: 2600000, n95: 1200000 });
  assert.deepEqual(interpretLv(600000, 200000), { ok: true, system: "LV03", e95: 2600000, n95: 1200000 });
  const swapped = interpretLv(1200000, 2600000);
  assert.equal(swapped.ok, false);
  assert.match(swapped.error, /swapped/);
  assert.match(interpretLv(200000, 600000).error, /swapped/);
  assert.match(interpretLv(8.5, 47.3).error, /WGS84/);
  assert.match(interpretLv(3500000, 1200000).error, /outside Switzerland/);
  assert.deepEqual(checkWgs84(47.3, 8.5), { ok: true });
  assert.match(checkWgs84(8.5, 47.3).error, /swapped/);
  assert.match(checkWgs84(48.85, 2.35).error, /outside/);
  assert.match(checkWgs84(1200000, 2600000).error, /projected/);
});

test("earthquakes: SED queries fail over to the next host when one is unreachable, and stick to it", async () => {
  const realFetch = globalThis.fetch;
  const hosts = SED_BASES.map((b) => new URL(b).hostname);
  const calls = [];
  globalThis.fetch = async (url) => {
    const host = new URL(String(url)).hostname;
    calls.push(host);
    if (host === hosts[0]) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    return new Response("#EventID|Time\n", { status: 200, headers: { "content-type": "text/plain" } });
  };
  try {
    const r = await sedQuery({ format: "text", limit: 1, _t: "failover-a" }, 1000);
    assert.match(r.data, /EventID/);
    assert.ok(calls.includes(hosts[0]) && calls.at(-1) === hosts[1]);
    calls.length = 0;
    await sedQuery({ format: "text", limit: 1, _t: "failover-b" }, 1000);
    assert.deepEqual(calls, [hosts[1]], "the working host is tried first next time");
  } finally {
    globalThis.fetch = realFetch;
  }
});

