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
  assert.equal(map.get(5), "Cooperative");
  assert.equal(parseLegalForms({ list: [{ id: 9, name: "Zweigniederlassung" }] }).get(9), "Zweigniederlassung");
  assert.equal(parseLegalForms("nonsense").size, 0);
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
