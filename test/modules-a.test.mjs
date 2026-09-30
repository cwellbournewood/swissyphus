/**
 * Offline unit tests for data-correctness fixes in the weather, geo,
 * companies, hydrology, energy, statistics, parliament and transport modules.
 *
 *   npm run build && node --test test/modules-a.test.mjs
 *
 * FIXTURES ARE SYNTHETIC: every file in test/fixtures/ used here is
 * hand-written from the documented upstream response shapes, NOT captured
 * from the live APIs (no network during development). Replace them with
 * captured live responses as soon as the live canary runs, and keep the
 * value assertions — they are the point of these tests.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { inSwitzerland, wgs84ToLv95 } from "../dist/core/coords.js";
import {
  pointToWgs84,
  mapMeasurementStations,
  downsampleSeries,
  buildHistory,
  parseSwissLocalTime,
  zurichIso,
  nearPoint,
  mapWarnings,
} from "../dist/modules/weather.js";
import {
  mapRoof,
  sortFeaturesByDistance,
  mapGwrBuilding,
  pickCurrentMunicipality,
  mapMunicipality,
  sonnendachCompass,
  identifyParams,
  distanceToGeometryM,
} from "../dist/modules/geo.js";
import {
  LEGAL_FORMS,
  parseLegalForms,
  normalizeFirm,
  compactFirm,
  classifyIdentifier,
  parseUid,
  uidChecksumValid,
  resolveByName,
  mapSogcPublications,
  statusLabel,
} from "../dist/modules/companies.js";
import { hydrologyModule } from "../dist/modules/hydrology.js";
import {
  indexEvData,
  nearbyEvStations,
  evseCoords,
  evseName,
  asArray,
  splitResolutions,
  MunicipalityNotFound,
} from "../dist/modules/energy.js";
import {
  pickLang,
  compactDataset,
  buildPopulationQuery,
  parsePopulationRows,
  PxShapeError,
} from "../dist/modules/statistics.js";
import { parseODataDate, clean, rowsOf, containsCI, equalsCI } from "../dist/modules/parliament.js";
import { mapStations } from "../dist/modules/transport.js";
import { SourceError } from "../dist/core/http.js";

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name) => JSON.parse(readFileSync(resolve(fixturesDir, name), "utf8"));

// ── weather ────────────────────────────────────────────────────────────────

test("weather: LV95 station coordinates are converted to WGS84 inside Switzerland", () => {
  const stations = mapMeasurementStations(fixture("weather-messwerte-lv95.json"), "°C");
  assert.equal(stations.length, 4);
  for (const s of stations) {
    assert.ok(s.wgs84, `${s.id} has coords`);
    assert.ok(inSwitzerland(s.wgs84.lat, s.wgs84.lon), `${s.id} → ${JSON.stringify(s.wgs84)}`);
  }
  const sma = stations.find((s) => s.id === "SMA");
  assert.ok(Math.abs(sma.wgs84.lat - 47.378) < 0.01 && Math.abs(sma.wgs84.lon - 8.566) < 0.01, JSON.stringify(sma.wgs84));
});

test("weather: pointToWgs84 accepts WGS84 [lon,lat], swapped [lat,lon], LV03 and LV95", () => {
  assert.deepEqual(pointToWgs84([8.5417, 47.3769]), { lat: 47.3769, lon: 8.5417 });
  assert.deepEqual(pointToWgs84([47.3769, 8.5417]), { lat: 47.3769, lon: 8.5417 });
  const lv95 = pointToWgs84([2600000, 1200000]);
  assert.ok(Math.abs(lv95.lat - 46.951) < 0.001 && Math.abs(lv95.lon - 7.4386) < 0.001);
  const lv03 = pointToWgs84([600000, 200000]);
  assert.ok(Math.abs(lv03.lat - 46.951) < 0.001 && Math.abs(lv03.lon - 7.4386) < 0.001);
  assert.equal(pointToWgs84(undefined), undefined);
  assert.equal(pointToWgs84(["x", 1]), undefined);
});

test("weather: near-point sorting puts Zürich-Fluntern first for a Zürich origin", async () => {
  const { byDistance } = await import("../dist/core/coords.js");
  const stations = mapMeasurementStations(fixture("weather-messwerte-lv95.json"));
  const sorted = byDistance(stations, { lat: 47.37, lon: 8.54 }, (s) => s.wgs84);
  assert.equal(sorted[0].id, "SMA");
  assert.ok(sorted[0].distance_km < 5, `distance ${sorted[0].distance_km}`);
  assert.equal(sorted[sorted.length - 1].id, "GVE");
});

test("weather: near_lat without near_lon is rejected", () => {
  assert.equal(nearPoint(47, undefined).ok, false);
  assert.equal(nearPoint(undefined, 8).ok, false);
  assert.deepEqual(nearPoint(undefined, undefined), { ok: true, point: undefined });
  assert.deepEqual(nearPoint(47, 8), { ok: true, point: { lat: 47, lon: 8 } });
});

test("weather: creation_time 'dd.mm.yyyy HH:MM' → ISO with Europe/Zurich offset", () => {
  assert.equal(parseSwissLocalTime("14.01.2025 10:20"), "2025-01-14T10:20:00+01:00");
  assert.equal(parseSwissLocalTime("14.07.2025 10:20"), "2025-07-14T10:20:00+02:00");
  assert.equal(new Date(parseSwissLocalTime("14.07.2025 10:20")).toISOString(), "2025-07-14T08:20:00.000Z");
  assert.equal(parseSwissLocalTime("2025-01-14T10:20:00Z"), "2025-01-14T10:20:00Z");
  assert.equal(parseSwissLocalTime("garbage"), undefined);
  assert.equal(parseSwissLocalTime(undefined), undefined);
  // Swiss local date just after midnight is not the UTC date.
  assert.equal(zurichIso(Date.parse("2025-07-13T22:30:00Z"), false), "2025-07-14");
});

function syntheticSmn(par, n, valueAt) {
  // SYNTHETIC api.existenz.ch smn payload: 10-minute steps.
  const t0 = Date.parse("2025-01-01T00:00:00Z") / 1000;
  return Array.from({ length: n }, (_, i) => ({ timestamp: t0 + i * 600, loc: "SMA", par, val: valueAt(i) }));
}

test("weather history: downsampling SUMS precipitation so the 30-day total is preserved", () => {
  const n = 30 * 144; // 30 days of 10-min values
  const payload = syntheticSmn("rr", n, (i) => (i % 7 === 0 ? 0.3 : i % 13 === 0 ? 1.1 : 0));
  const expected = payload.reduce((s, p) => s + p.val, 0);
  const h = buildHistory(payload, "precipitation", 200);
  assert.equal(h.downsampled, true);
  assert.ok(h.points <= 200, `points ${h.points}`);
  const summed = h.series.reduce((s, p) => s + (p.value ?? 0), 0);
  assert.ok(Math.abs(summed - expected) < 1e-6, `series sum ${summed} vs raw ${expected}`);
  assert.ok(Math.abs(h.total - expected) < 1e-6);
  assert.match(h.unit, /^mm per \d+ min$/);
});

test("weather history: temperature is averaged with min/max per bucket", () => {
  const payload = syntheticSmn("tt", 1000, (i) => (i % 2 ? 10 : 0));
  const h = buildHistory(payload, "temperature", 100);
  assert.equal(h.unit, "°C");
  for (const p of h.series) {
    assert.ok(p.value >= 0 && p.value <= 10);
    assert.equal(p.min, 0);
    assert.equal(p.max, 10);
  }
  assert.equal(h.total, undefined);
});

test("weather history: short series is returned raw and sorted", () => {
  const payload = syntheticSmn("tt", 5, (i) => i).reverse();
  const { series, downsampled } = downsampleSeries(payload, 200, "mean");
  assert.equal(downsampled, false);
  assert.deepEqual(series.map((p) => p.value), [0, 1, 2, 3, 4]);
});

test("weather warnings: textual type is preferred over the numeric code", () => {
  const [a, b] = mapWarnings([
    { warnType: 2, warnLevel: 3, typeText: "Gewitter" },
    { warnType: 2, warnLevel: 2 },
  ]);
  assert.equal(a.type, "Gewitter");
  assert.equal(b.type, "wind");
  assert.equal(b.type_code, 2);
});

// ── geo ────────────────────────────────────────────────────────────────────

test("geo solar: per-m² irradiation comes from mstrahlung (< 2000), total from gstrahlung", () => {
  const { results } = fixture("geo-sonnendach-identify.json");
  const roofs = sortFeaturesByDistance(results, 2600000, 1200000).map(mapRoof);
  for (const r of roofs) {
    assert.ok(r.irradiation_kwh_m2_year > 800 && r.irradiation_kwh_m2_year < 2000, `per-m² ${r.irradiation_kwh_m2_year}`);
    assert.ok(r.total_irradiation_kwh_year > r.irradiation_kwh_m2_year);
    // total ≈ per-m² × area for the synthetic data
    assert.ok(Math.abs(r.total_irradiation_kwh_year - r.irradiation_kwh_m2_year * r.roof_area_m2) < 1);
  }
  // The roof containing the query point sorts first, regardless of upstream order.
  assert.equal(roofs[0].distance_m, 0);
  assert.equal(roofs[0].suitability, "excellent");
  assert.equal(roofs[0].orientation, "south");
  assert.equal(roofs[1].orientation, "west");
});

test("geo solar: Sonnendach orientation convention (0 = south, -90 = east, +90 = west)", () => {
  assert.equal(sonnendachCompass(0), "south");
  assert.equal(sonnendachCompass(-90), "east");
  assert.equal(sonnendachCompass(90), "west");
  assert.equal(sonnendachCompass(180), "north");
  assert.equal(sonnendachCompass(-180), "north");
  assert.equal(sonnendachCompass(-45), "south-east");
  assert.equal(sonnendachCompass(undefined), undefined);
});

test("geo reverse geocode: GWR buildings sorted nearest-first (geometry or gkode/gkodn)", () => {
  const { results } = fixture("geo-gwr-identify.json");
  const rows = sortFeaturesByDistance(results, 2600000, 1200000).map(mapGwrBuilding);
  assert.deepEqual(rows.map((r) => r.egid), [2222, 3333, 1111]);
  assert.equal(rows[0].distance_m, 5);
  assert.equal(rows[1].street, "Mittelweg 5");
  assert.ok(rows.every((r) => r.distance_m <= 50));
});

test("geo identify: tolerance is in metres (1 px = 1 m)", () => {
  const p = identifyParams(2600000, 1200000, "x", 50, true);
  const [xmin, , xmax] = p.mapExtent.split(",").map(Number);
  const [px] = p.imageDisplay.split(",").map(Number);
  assert.equal((xmax - xmin) / px, 1);
  assert.equal(p.tolerance, 50);
  assert.equal(p.returnGeometry, true);
});

test("geo distanceToGeometryM handles GeoJSON polygons and points", () => {
  const poly = { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] };
  assert.equal(distanceToGeometryM(poly, 5, 5), 0);
  assert.equal(distanceToGeometryM(poly, 13, 5), 3);
  assert.equal(distanceToGeometryM({ type: "Point", coordinates: [3, 4] }, 0, 0), 5);
  assert.equal(distanceToGeometryM(undefined, 0, 0), undefined);
});

test("geo municipality: current boundary year preferred; gemflaeche/gem_flaeche both read", () => {
  const { results } = fixture("geo-gemeinde-identify.json");
  const m = mapMunicipality(pickCurrentMunicipality(results));
  assert.equal(m.municipality, "Zürich");
  assert.equal(m.area_ha, 8793);
  assert.equal(m.bfs_number, 261);
  // Without is_current_jahr, the latest jahr wins; gem_flaeche is read.
  const noFlag = results.map((r) => ({ ...r, attributes: { ...r.attributes, is_current_jahr: undefined } }));
  assert.equal(mapMunicipality(pickCurrentMunicipality(noFlag)).boundary_year, 2024);
  assert.equal(mapMunicipality(results[0]).area_ha, 8000);
});

// ── companies ──────────────────────────────────────────────────────────────

test("companies: fallback legal-form table follows ZEFIX ids (3 = AG, 4 = GmbH)", () => {
  assert.match(LEGAL_FORMS[3], /AG/);
  assert.match(LEGAL_FORMS[4], /GmbH/);
  assert.match(LEGAL_FORMS[1], /Sole proprietorship/);
  assert.match(LEGAL_FORMS[5], /Genossenschaft/);
  assert.match(LEGAL_FORMS[7], /Stiftung/);
  assert.match(LEGAL_FORMS[10], /Kommanditgesellschaft/);
  const [firm] = fixture("companies-zefix.json").zefixRestSearch.list;
  assert.match(compactFirm(normalizeFirm(firm)).legal_form, /AG/);
});

test("companies: live legalForm list parses and overrides the table", () => {
  const map = parseLegalForms(fixture("companies-zefix.json").legalForm);
  assert.equal(map.get(3), "Company limited by shares (AG)");
  assert.equal(map.get(4), "Limited liability company (GmbH)");
  assert.equal(map.get(5), "Cooperative (Genossenschaft)");
  assert.equal(parseLegalForms({ list: [{ id: 9, name: "Zweigniederlassung" }] }).get(9), "Zweigniederlassung");
  assert.equal(parseLegalForms("nonsense").size, 0);
});

test("companies: legal-form labels keep the register abbreviation, not the English short name", () => {
  // Shape of the live ZEFIX list (Sept 2026): en shortName is a translation ("LLC").
  const map = parseLegalForms([
    { id: 1, name: { de: "Einzelunternehmen", en: "Sole proprietorship" }, shortName: { de: "Einzelunternehmen", en: "Sole proprietorship" } },
    { id: 3, name: { de: "Aktiengesellschaft", en: "Company limited by shares" }, shortName: { de: "AG", fr: "SA", it: "SA", en: "Ltd" } },
    { id: 4, name: { de: "Gesellschaft mit beschränkter Haftung", en: "Limited liability company" }, shortName: { de: "GmbH", fr: "Sàrl", it: "Sagl", en: "LLC" } },
    { id: 5, name: { de: "Genossenschaft", en: "Cooperative" }, shortName: "Genossenschaft" },
    { id: 6, name: "Verein" },
  ]);
  assert.equal(map.get(1), "Sole proprietorship (Einzelunternehmen)");
  assert.equal(map.get(3), "Company limited by shares (AG/SA)");
  assert.equal(map.get(4), "Limited liability company (GmbH/Sàrl)");
  assert.equal(map.get(5), "Cooperative (Genossenschaft)");
  assert.equal(map.get(6), "Verein");
});

test("companies: ZefixREST and ZefixPublicREST records normalise to the same shape", () => {
  const fx = fixture("companies-zefix.json");
  const a = compactFirm(normalizeFirm(fx.zefixRestSearch.list[0]));
  const b = compactFirm(normalizeFirm(fx.publicRestCompany));
  for (const k of ["name", "uid", "ehraid", "status", "legal_form_id", "legal_form", "legal_seat", "last_sogc_date"]) {
    assert.deepEqual(a[k], b[k], `field ${k}`);
  }
  assert.equal(b.uid, "CHE-107.028.276");
  assert.equal(b.status, "active");
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
});

test("companies: UID parsing, checksum and identifier classification", () => {
  assert.equal(parseUid("CHE-107.028.276"), "CHE107028276");
  assert.equal(parseUid("che107028276 MWST"), "CHE107028276");
  assert.equal(parseUid("Migros"), undefined);
  assert.equal(uidChecksumValid("107028276"), true);
  assert.equal(uidChecksumValid("107028277"), false);
  assert.deepEqual(classifyIdentifier("CHE-107.028.276"), { kind: "uid", uid: "CHE107028276" });
  assert.deepEqual(classifyIdentifier("107028276"), { kind: "uid", uid: "CHE107028276" });
  assert.equal(classifyIdentifier("107028277").kind, "invalid");
  assert.equal(classifyIdentifier("CHE-107.028.277").kind, "invalid");
  assert.deepEqual(classifyIdentifier(" 123456 "), { kind: "ehraid", ehraid: 123456 });
  assert.deepEqual(classifyIdentifier("Beispiel Holding AG"), { kind: "name", name: "Beispiel Holding AG" });
});

test("companies: get_company by name requires an exact (case/space-insensitive) match", () => {
  const list = fixture("companies-zefix.json").zefixRestSearch.list.map(normalizeFirm);
  const hit = resolveByName("  beispiel   holding ag ", list);
  assert.equal(hit.match?.ehraid, 111111);
  const fuzzy = resolveByName("Beispiel", list);
  assert.equal(fuzzy.match, undefined);
  assert.equal(fuzzy.candidates.length, 3);
});

test("companies: status labels for both back-ends", () => {
  assert.equal(statusLabel("EXISTIEREND"), "active");
  assert.equal(statusLabel("ACTIVE"), "active");
  assert.equal(statusLabel("GELOESCHT"), "deleted");
  assert.equal(statusLabel("CANCELLED"), "deleted");
  assert.equal(statusLabel("BEING_CANCELLED"), "in liquidation");
});

test("companies: SOGC publications are listed newest first", () => {
  const pubs = mapSogcPublications(fixture("companies-zefix.json").sogcContent);
  assert.deepEqual(pubs.map((p) => p.date), ["2024-05-10", "2024-04-20", "2024-03-01"]);
});

// ── hydrology ──────────────────────────────────────────────────────────────

test("hydrology: tool descriptions no longer hard-code example station IDs; existenz.ch credited", () => {
  for (const t of hydrologyModule.tools) {
    assert.doesNotMatch(t.description, /\b\d{4}\s*=/, `${t.name} still maps IDs to places`);
  }
  const src = hydrologyModule.sources[0];
  assert.match(src.attribution, /existenz\.ch/);
  assert.match(src.licence, /existenz\.ch/);
});

// ── energy ─────────────────────────────────────────────────────────────────

test("energy: EV records are grouped per charging station (EVSEs aggregated)", () => {
  const stations = indexEvData(fixture("energy-ev-oicp.json"));
  // 7 EVSE records (one without coordinates) → 3 physical stations.
  assert.equal(stations.length, 3);
  const a = stations.find((s) => s.charging_station_id === "CH*AAA*S1");
  assert.equal(a.evse_count, 3);
  assert.equal(a.max_power_kw, 150);
  assert.deepEqual(a.plugs.sort(), ["CCS Combo 2 Plug (Cable Attached)", "Type 2 Outlet"]);
  assert.equal(a.open_24h, true);
  assert.equal(a.name, "Example car park");
  assert.equal(a.address, "Bahnhofplatz 1, 8001 Zürich");
  // No ChargingStationId → grouped by operator + position + address.
  const b = stations.find((s) => s.name === "Dorfplatz");
  assert.equal(b.evse_count, 2);
  for (const s of stations) assert.ok(inSwitzerland(s.lat, s.lon), `${s.name} ${s.lat},${s.lon}`);
});

test("energy: single-element OICP lists collapsed to objects/strings still index", () => {
  // The SFOE export (XML → JSON) sometimes emits a lone list item as a bare value.
  const stations = indexEvData({
    EVSEData: {
      OperatorName: "Solo",
      EVSEDataRecord: {
        EvseID: "CH*SOL*E1",
        ChargingStationId: 42,
        ChargingStationNames: { lang: "de", value: "Bahnhof" },
        GeoCoordinates: { Google: "47.37 8.54" },
        Plugs: "Type 2 Outlet",
        ChargingFacilities: { power: "11" },
        IsOpen24Hours: "true",
      },
    },
  });
  assert.equal(stations.length, 1);
  assert.equal(stations[0].name, "Bahnhof");
  assert.equal(stations[0].charging_station_id, "42");
  assert.deepEqual(stations[0].plugs, ["Type 2 Outlet"]);
  assert.equal(stations[0].max_power_kw, 11);
  assert.equal(stations[0].open_24h, true);
  assert.equal(evseName("Plain"), "Plain");
  assert.equal(evseName([{ lang: "de", value: "A" }, { lang: "en-GB", value: "B" }]), "B");
  assert.equal(evseName([{ lang: "en", value: " " }, { lang: "fr", value: "C" }]), "C");
  assert.equal(evseName(null), undefined);
  assert.deepEqual(asArray(undefined), []);
});

test("energy: nearby search filters by radius and sorts nearest first", () => {
  const stations = indexEvData(fixture("energy-ev-oicp.json"));
  const hits = nearbyEvStations(stations, 47.3769, 8.5417, 10);
  assert.deepEqual(hits.map((h) => h.name), ["Example car park", "Dorfplatz"]);
  assert.ok(hits[0].distance_km < 1);
  assert.equal(nearbyEvStations(stations, 46.0, 9.0, 1).length, 0);
});

test("energy: OICP coordinates in Google 'lat lon', swapped, and DecimalDegree forms", () => {
  assert.deepEqual(evseCoords({ Google: "47.1 8.2" }), { lat: 47.1, lon: 8.2 });
  assert.deepEqual(evseCoords({ Google: "8.2,47.1" }), { lat: 47.1, lon: 8.2 });
  assert.deepEqual(evseCoords({ DecimalDegree: { Latitude: "46.5", Longitude: "6.6" } }), { lat: 46.5, lon: 6.6 });
  assert.equal(evseCoords({ Google: "" }), undefined);
});

test("energy: one bad municipality yields a per-item error, not a failed comparison", () => {
  const settled = [
    { status: "fulfilled", value: { bfs: 261, label: "Zürich" } },
    { status: "rejected", reason: new MunicipalityNotFound("Atlantis") },
    { status: "rejected", reason: new SourceError("Source 'x' responded with HTTP 503.", "x", 503) },
  ];
  const { resolved, errors } = splitResolutions(["Zürich", "Atlantis", "Baden"], settled);
  assert.deepEqual(resolved, [{ input: "Zürich", bfs: 261, label: "Zürich" }]);
  assert.deepEqual(errors.map((e) => e.input), ["Atlantis", "Baden"]);
  assert.equal(errors[0].error, "municipality not found");
});

// ── statistics ─────────────────────────────────────────────────────────────

test("statistics: JSON-encoded organization.title, non-empty download_url, license|rights", () => {
  const d = compactDataset(fixture("statistics-pxweb-ckan.json").ckanPackage, true);
  assert.equal(d.publisher, "Federal Statistical Office FSO");
  assert.equal(d.title, "Beispiel"); // empty 'en' falls through to 'de'
  assert.equal(d.resources[0].download_url, "https://example.admin.ch/a.csv");
  assert.equal(d.resources[0].licence, "terms_by");
  assert.equal(d.resources[1].download_url, "https://example.admin.ch/b.json");
  assert.match(d.resources[1].licence, /ReferenceRequired/);
  assert.equal(pickLang("plain text"), "plain text");
  assert.equal(pickLang("{not json"), "{not json");
});

test("statistics: PXWeb query built from metadata; population values parsed", () => {
  const fx = fixture("statistics-pxweb-ckan.json");
  const { query, year, cantonNames, assumptions } = buildPopulationQuery(fx.pxMeta);
  assert.equal(year, "2023");
  const byCode = Object.fromEntries(query.query.map((q) => [q.code, q.selection.values]));
  assert.deepEqual(byCode["Jahr"], ["2023"]);
  assert.equal(byCode["Kanton"].length, 4);
  assert.deepEqual(byCode["Geschlecht"], ["-99999"]);
  assert.deepEqual(byCode["Bevölkerungstyp"], ["1"]);
  assert.ok(assumptions.some((a) => /Permanent resident/.test(a)));
  const rows = parsePopulationRows(fx.pxData, cantonNames);
  const ch = rows.find((r) => r.region === "Switzerland");
  assert.ok(ch.population > 8_000_000 && ch.population < 10_000_000);
  assert.equal(rows.find((r) => r.region === "Zürich").population, 1605508);
});

test("statistics: missing PXWeb dimensions fail loudly", () => {
  const fx = fixture("statistics-pxweb-ckan.json");
  assert.throws(() => buildPopulationQuery(fx.pxMetaBroken), PxShapeError);
  assert.throws(() => buildPopulationQuery({}), PxShapeError);
  assert.throws(() => parsePopulationRows({ data: [] }, new Map([["1", "Zürich"]])), PxShapeError);
});

// ── parliament ─────────────────────────────────────────────────────────────

test("parliament: /Date()/ parsing — offsets, negative epochs, VoteEnd keeps time", () => {
  assert.equal(parseODataDate("/Date(1678785153000+0100)/", true), "2023-03-14T10:12:33+01:00");
  assert.equal(parseODataDate("/Date(1678785153000+0100)/"), "2023-03-14");
  assert.equal(parseODataDate("/Date(1678785153000-0230)/", true), "2023-03-14T06:42:33-02:30");
  // No offset: rendered in Swiss local time, so local midnight keeps its date.
  assert.equal(parseODataDate("/Date(1600898400000)/"), "2020-09-24");
  assert.equal(parseODataDate("/Date(-157766400000)/"), "1965-01-01");
  assert.equal(parseODataDate("not a date"), undefined);

  const [row] = rowsOf(fixture("parliament-odata.json")).map(clean);
  assert.equal(row.VoteEnd, "2023-03-14T10:12:33+01:00");
  assert.equal(row.SubmissionDate, "2020-09-24");
  assert.equal(row.DateOfBirth, "1965-01-01");
  assert.equal(row.__metadata, undefined);
  assert.equal(row.Business, undefined);
  assert.ok(!("Empty" in row));
});

test("parliament: case-insensitive filters keep quote escaping", () => {
  assert.equal(containsCI("Title", "klimaschutz"), "substringof(tolower('klimaschutz'), tolower(Title))");
  assert.equal(containsCI("LastName", "O'Brien"), "substringof(tolower('O''Brien'), tolower(LastName))");
  assert.equal(equalsCI("PartyAbbreviation", "svp"), "tolower(PartyAbbreviation) eq tolower('svp')");
});

// ── transport ──────────────────────────────────────────────────────────────

test("transport: /locations mapping drops POIs without id; coordinate x=lat, y=lon", () => {
  const stations = mapStations(fixture("transport-locations.json").stations);
  assert.deepEqual(stations.map((s) => s.id), ["8503000", "8587349"]);
  for (const s of stations) assert.ok(inSwitzerland(s.wgs84.lat, s.wgs84.lon));
  assert.equal(stations[0].distance_m, 120);
});
