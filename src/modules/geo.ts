/**
 * Geodata module — swisstopo api3.geo.admin.ch.
 * Geocoding, reverse geocoding, elevation, elevation profiles, municipality
 * lookup, solar potential (Sonnendach) and generic layer identify.
 */

import { z } from "zod";
import { fetchJson, withParams, sourceCache } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { wgs84ToLv95, lv95ToWgs84, inSwitzerland } from "../core/coords.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

const swisstopo: SourceManifest = {
  id: "swisstopo-api",
  name: "swisstopo geo.admin.ch API",
  operator: "Federal Office of Topography swisstopo",
  url: "https://api3.geo.admin.ch",
  licence: "Free use with source attribution (geo.admin.ch terms of use)",
  attribution: "© swisstopo / geo.admin.ch",
  updateFrequency: "continuous (varies per layer)",
  cacheTtlSeconds: 3600,
  // geodata changes slowly
  maxStaleSeconds: 30 * 86400,
};

const BASE = "https://api3.geo.admin.ch/rest/services";

interface SearchResult {
  results?: Array<{
    attrs?: {
      label?: string;
      detail?: string;
      lat?: number;
      lon?: number;
      x?: number;
      y?: number;
      origin?: string;
      featureId?: string | number;
    };
  }>;
}

export interface IdentifyFeature {
  layerBodId?: string;
  featureId?: string | number;
  attributes?: Record<string, unknown>;
  properties?: Record<string, unknown>;
  geometry?: unknown;
}

interface IdentifyResult {
  results?: IdentifyFeature[];
}

function stripHtml(s: string | undefined): string {
  return (s ?? "").replace(/<[^>]*>/g, "").trim();
}

/**
 * The identify service measures `tolerance` in screen pixels of the given
 * mapExtent/imageDisplay. We send a 200 m × 200 m extent rendered at
 * 200 × 200 px, so 1 px = 1 m and `toleranceM` really is metres.
 */
export function identifyParams(easting: number, northing: number, layers: string, toleranceM: number, returnGeometry: boolean) {
  const half = Math.max(100, toleranceM);
  const px = half * 2; // 1 px per metre
  return {
    geometry: `${easting},${northing}`,
    geometryType: "esriGeometryPoint",
    sr: 2056,
    layers: `all:${layers}`,
    tolerance: toleranceM,
    mapExtent: `${easting - half},${northing - half},${easting + half},${northing + half}`,
    imageDisplay: `${px},${px},96`,
    returnGeometry,
    lang: "en",
  };
}

async function identify(
  layers: string,
  lat: number,
  lon: number,
  toleranceM: number,
  returnGeometry = false,
): Promise<{ data: IdentifyResult; cacheStatus: "hit" | "miss" | "stale" | "computed"; retrievedAt: string }> {
  const { easting, northing } = wgs84ToLv95(lat, lon);
  const url = withParams(
    `${BASE}/api/MapServer/identify`,
    identifyParams(easting, northing, layers, toleranceM, returnGeometry),
  );
  return fetchJson<IdentifyResult>(url, { ...sourceCache(swisstopo) });
}

type Pt = [number, number];

function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Extract rings (polygons), paths (lines) and points from Esri-JSON or GeoJSON geometry. */
function geometryParts(g: unknown): { rings: Pt[][]; paths: Pt[][]; points: Pt[] } {
  const out = { rings: [] as Pt[][], paths: [] as Pt[][], points: [] as Pt[] };
  if (!g || typeof g !== "object") return out;
  const o = g as Record<string, unknown>;
  const toPts = (arr: unknown): Pt[] =>
    Array.isArray(arr)
      ? (arr as unknown[])
          .map((p) => (Array.isArray(p) ? ([num(p[0]), num(p[1])] as const) : undefined))
          .filter((p): p is readonly [number, number] => !!p && p[0] !== undefined && p[1] !== undefined)
          .map((p) => [p[0], p[1]] as Pt)
      : [];
  const x = num(o["x"]);
  const y = num(o["y"]);
  if (x !== undefined && y !== undefined) out.points.push([x, y]);
  if (Array.isArray(o["rings"])) for (const r of o["rings"] as unknown[]) out.rings.push(toPts(r));
  if (Array.isArray(o["paths"])) for (const p of o["paths"] as unknown[]) out.paths.push(toPts(p));
  if (Array.isArray(o["points"])) out.points.push(...toPts(o["points"]));
  const type = o["type"];
  const c = o["coordinates"];
  if (typeof type === "string" && Array.isArray(c)) {
    if (type === "Point") out.points.push(...toPts([c]));
    else if (type === "MultiPoint") out.points.push(...toPts(c));
    else if (type === "LineString") out.paths.push(toPts(c));
    else if (type === "MultiLineString") for (const l of c) out.paths.push(toPts(l));
    else if (type === "Polygon") for (const r of c) out.rings.push(toPts(r));
    else if (type === "MultiPolygon") for (const poly of c) if (Array.isArray(poly)) for (const r of poly) out.rings.push(toPts(r));
  }
  return out;
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * Planar distance in metres from an LV95 point to a feature geometry (Esri
 * JSON or GeoJSON, in LV95). 0 when the point lies inside a polygon.
 * Undefined when the geometry is missing/unparseable.
 */
export function distanceToGeometryM(geometry: unknown, easting: number, northing: number): number | undefined {
  const { rings, paths, points } = geometryParts(geometry);
  const p: Pt = [easting, northing];
  // Even-odd rule across all rings (holes handled naturally).
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i] as Pt;
      const b = ring[j] as Pt;
      if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
  }
  if (inside) return 0;
  let best = Infinity;
  for (const line of [...rings, ...paths]) {
    for (let i = 1; i < line.length; i++) best = Math.min(best, segDist(p, line[i - 1] as Pt, line[i] as Pt));
  }
  for (const q of points) best = Math.min(best, Math.hypot(q[0] - p[0], q[1] - p[1]));
  return Number.isFinite(best) ? Math.round(best * 10) / 10 : undefined;
}

/**
 * Sort identify features nearest-first. Uses the returned geometry, falling
 * back to GWR building coordinates (gkode/gkodn, LV95) in the attributes.
 */
export function sortFeaturesByDistance<T extends IdentifyFeature>(
  features: T[],
  easting: number,
  northing: number,
): Array<T & { distance_m: number | undefined }> {
  return features
    .map((f) => {
      let d = distanceToGeometryM(f.geometry, easting, northing);
      if (d === undefined) {
        const a = f.attributes ?? f.properties ?? {};
        const ge = num(a["gkode"]);
        const gn = num(a["gkodn"]);
        if (ge !== undefined && gn !== undefined) d = Math.round(Math.hypot(ge - easting, gn - northing) * 10) / 10;
      }
      return { ...f, distance_m: d };
    })
    .sort((a, b) => (a.distance_m ?? Infinity) - (b.distance_m ?? Infinity));
}

/** Map a GWR identify feature to an address row. */
export function mapGwrBuilding(f: IdentifyFeature & { distance_m?: number }) {
  const a = f.attributes ?? f.properties ?? {};
  return {
    street: a["strname_deinr"] ?? (`${a["strname1"] ?? ""} ${a["deinr"] ?? ""}`.trim() || undefined),
    postal_code: a["dplz4"] ?? a["plz4"],
    locality: a["dplzname"] ?? a["plzname"],
    municipality: a["ggdename"] ?? a["gdename"],
    municipality_bfs_number: a["ggdenr"] ?? a["gdenr"],
    egid: a["egid"],
    building_category: a["gkat"],
    construction_year: a["gbauj"],
    distance_m: f.distance_m,
  };
}

/**
 * Pick the current municipality feature. swissBOUNDARIES3D identify can return
 * one feature per boundary year; prefer `is_current_jahr`, else the latest `jahr`.
 */
export function pickCurrentMunicipality<T extends IdentifyFeature>(features: T[]): T | undefined {
  const attrs = (f: T) => f.attributes ?? f.properties ?? {};
  const isCurrent = (v: unknown) => v === true || v === 1 || v === "true" || v === "1" || v === "t";
  const current = features.filter((f) => isCurrent(attrs(f)["is_current_jahr"]));
  const pool = current.length ? current : features;
  return [...pool].sort((a, b) => (num(attrs(b)["jahr"]) ?? 0) - (num(attrs(a)["jahr"]) ?? 0))[0];
}

export function mapMunicipality(f: IdentifyFeature) {
  const a = f.attributes ?? f.properties ?? {};
  return {
    municipality: a["gemname"] ?? a["gem_name"] ?? a["name"] ?? a["label"],
    bfs_number: a["gemnummer"] ?? a["gem_nummer"] ?? a["bfs_nummer"] ?? a["id"] ?? f.featureId,
    canton: a["kanton"] ?? a["kantonsnummer"] ?? a["kanton_nr"],
    district: a["bezirksname"] ?? a["bezirk"],
    area_ha: num(a["gemflaeche"]) ?? num(a["gem_flaeche"]) ?? num(a["flaeche"]),
    boundary_year: a["jahr"],
  };
}

/** Sonnendach `ausrichtung`: 0° = south, −90° = east, +90° = west, ±180° = north. */
export function sonnendachCompass(deg: unknown): string | undefined {
  const d = num(deg);
  if (d === undefined) return undefined;
  const azimuth = (((180 + d) % 360) + 360) % 360; // north-based compass bearing
  const names = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
  return names[Math.round(azimuth / 45) % 8];
}

const SUITABILITY = ["", "low", "medium", "good", "very good", "excellent"];

/**
 * Map a Sonnendach roof. `mstrahlung` is mean irradiation per m² (kWh/m²/yr,
 * ~1000–1400 in Switzerland); `gstrahlung` is the whole-roof total (kWh/yr).
 */
export function mapRoof(f: IdentifyFeature & { distance_m?: number }) {
  const a = f.attributes ?? f.properties ?? {};
  const klasse = num(a["klasse"]) ?? 0;
  return {
    suitability_class: klasse,
    // `||` (not `??`): class 0 maps to "" in the label table, which is falsy
    // but not nullish, so fall back to the numeric string.
    suitability: SUITABILITY[klasse] || String(klasse),
    irradiation_kwh_m2_year: num(a["mstrahlung"]),
    total_irradiation_kwh_year: num(a["gstrahlung"]),
    ...(num(a["stromertrag"]) !== undefined ? { estimated_pv_yield_kwh_year: num(a["stromertrag"]) } : {}),
    roof_area_m2: num(a["flaeche"]),
    orientation_deg: num(a["ausrichtung"]),
    orientation: sonnendachCompass(a["ausrichtung"]),
    slope_deg: num(a["neigung"]),
    building_id: a["building_id"] ?? a["sb_uuid"],
    distance_m: f.distance_m,
  };
}

const coordArgs = {
  lat: z.number().min(45.5).max(48).describe("WGS84 latitude (Switzerland: ~45.8–47.9)"),
  lon: z.number().min(5.5).max(11).describe("WGS84 longitude (Switzerland: ~5.9–10.6)"),
};

export const geoModule: SwissyphusModule = {
  id: "geo",
  emoji: "🗺️",
  title: "Geodata (swisstopo)",
  description: "Geocoding, elevation, municipalities, solar potential, map-layer identify",
  sources: [swisstopo],
  healthProbes: [
    {
      sourceId: "swisstopo-api",
      url: `${BASE}/api/SearchServer?searchText=Bern&type=locations&limit=1`,
    },
  ],
  tools: [
    tool({
      name: "geocode",
      title: "Geocode a Swiss address or place",
      description:
        "Search Swiss addresses, places, municipalities and postal codes and return coordinates (WGS84 + LV95). Works with street addresses ('Bundesplatz 3 Bern'), place names ('Matterhorn'), and PLZ codes.",
      inputSchema: {
        query: z.string().min(2).describe("Address, place name or postal code to search"),
        origins: z
          .string()
          .optional()
          .describe(
            "Comma-separated source filter: address, zipcode, gg25 (municipalities), district, kantone, gazetteer. Default: all",
          ),
        limit: z.number().int().min(1).max(50).default(8).describe("Max results"),
      },
      handler: async ({ query, origins, limit }) => {
        try {
          const url = withParams(`${BASE}/api/SearchServer`, {
            searchText: query,
            type: "locations",
            origins,
            limit,
            sr: 2056,
          });
          const { data, cacheStatus, retrievedAt } = await fetchJson<SearchResult>(url, {
            ...sourceCache(swisstopo),
          });
          const results = (data.results ?? []).map((r) => ({
            label: stripHtml(r.attrs?.label),
            detail: r.attrs?.detail,
            origin: r.attrs?.origin,
            wgs84: { lat: r.attrs?.lat, lon: r.attrs?.lon },
            lv95: { easting: r.attrs?.y, northing: r.attrs?.x },
          }));
          if (!results.length) {
            return toolError(`No locations found for '${query}'.`, [
              "Try a broader spelling (umlauts are supported), or drop the street number.",
              "For municipalities only, set origins='gg25'.",
            ]);
          }
          return respond({ results }, { source: swisstopo, cacheStatus, retrievedAt });
        } catch (err) {
          return errorToResult(err, "swisstopo SearchServer");
        }
      },
    }),

    tool({
      name: "reverse_geocode",
      title: "Reverse geocode coordinates to an address",
      description:
        "Find the nearest registered building/address for WGS84 coordinates using the federal Register of Buildings and Dwellings (GWR). Returns street, number, postal code, locality, municipality and EGID.",
      inputSchema: { ...coordArgs },
      handler: async ({ lat, lon }) => {
        try {
          const { data, cacheStatus, retrievedAt } = await identify(
            "ch.bfs.gebaeude_wohnungs_register",
            lat,
            lon,
            50,
            true,
          );
          const { easting, northing } = wgs84ToLv95(lat, lon);
          const results = sortFeaturesByDistance(data.results ?? [], easting, northing)
            .slice(0, 5)
            .map(mapGwrBuilding);
          if (!results.length) {
            return toolError(`No registered building found within 50 m of ${lat}, ${lon}.`, [
              "The point may be outside a settlement. Use get_municipality for administrative context.",
            ]);
          }
          return respond({ query: { lat, lon }, results }, { source: swisstopo, cacheStatus, retrievedAt });
        } catch (err) {
          return errorToResult(err, "swisstopo identify (GWR)");
        }
      },
    }),

    tool({
      name: "get_elevation",
      title: "Get elevation at a point",
      description: "Return the terrain elevation in metres above sea level for WGS84 coordinates in Switzerland.",
      inputSchema: { ...coordArgs },
      handler: async ({ lat, lon }) => {
        try {
          const { easting, northing } = wgs84ToLv95(lat, lon);
          const url = withParams(`${BASE}/height`, { easting, northing, sr: 2056 });
          const { data, cacheStatus, retrievedAt } = await fetchJson<{ height?: string }>(url, {
            ttlMs: 24 * 3600 * 1000,
          });
          return respond(
            {
              wgs84: { lat, lon },
              lv95: { easting, northing },
              elevation_m: data.height !== undefined ? Number(data.height) : null,
            },
            { source: swisstopo, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "swisstopo height service");
        }
      },
    }),

    tool({
      name: "get_elevation_profile",
      title: "Get an elevation profile along a line",
      description:
        "Compute a terrain elevation profile along a line of WGS84 points (e.g. a hike). Returns distance/elevation pairs plus total ascent and descent.",
      inputSchema: {
        points: z
          .array(z.object({ lat: z.number(), lon: z.number() }))
          .min(2)
          .max(50)
          .describe("Line as ordered WGS84 points, at least 2"),
        samples: z.number().int().min(10).max(500).default(80).describe("Number of profile samples"),
      },
      handler: async ({ points, samples }) => {
        try {
          const coords = points.map((p) => {
            const { easting, northing } = wgs84ToLv95(p.lat, p.lon);
            return [easting, northing];
          });
          const geom = JSON.stringify({ type: "LineString", coordinates: coords });
          const url = withParams(`${BASE}/profile.json`, { geom, sr: 2056, nb_points: samples });
          const { data, cacheStatus, retrievedAt } = await fetchJson<
            Array<{ dist: number; alts?: { COMB?: number } }>
          >(url, { ttlMs: 24 * 3600 * 1000 });
          const profile = data.map((p) => ({ distance_m: p.dist, elevation_m: p.alts?.COMB ?? null }));
          let ascent = 0;
          let descent = 0;
          for (let i = 1; i < profile.length; i++) {
            const prev = profile[i - 1]?.elevation_m;
            const curr = profile[i]?.elevation_m;
            if (prev != null && curr != null) {
              const d = curr - prev;
              if (d > 0) ascent += d;
              else descent -= d;
            }
          }
          const last = profile[profile.length - 1];
          return respond(
            {
              total_distance_m: last ? Math.round(last.distance_m) : 0,
              total_ascent_m: Math.round(ascent),
              total_descent_m: Math.round(descent),
              profile,
            },
            { source: swisstopo, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "swisstopo profile service");
        }
      },
    }),

    tool({
      name: "get_municipality",
      title: "Get municipality at coordinates",
      description:
        "Return the Swiss municipality (Gemeinde) containing the given WGS84 point, including its official BFS number and canton.",
      inputSchema: { ...coordArgs },
      handler: async ({ lat, lon }) => {
        try {
          if (!inSwitzerland(lat, lon)) {
            return toolError("Coordinates are outside Switzerland.", [
              "Swissyphus covers Swiss territory only (lat 45.8–47.9, lon 5.9–10.6).",
            ]);
          }
          const { data, cacheStatus, retrievedAt } = await identify(
            "ch.swisstopo.swissboundaries3d-gemeinde-flaeche.fill",
            lat,
            lon,
            0,
          );
          const current = pickCurrentMunicipality(data.results ?? []);
          if (!current) {
            return toolError(`No municipality found at ${lat}, ${lon}.`);
          }
          return respond(mapMunicipality(current), { source: swisstopo, cacheStatus, retrievedAt });
        } catch (err) {
          return errorToResult(err, "swisstopo municipal boundaries");
        }
      },
    }),

    tool({
      name: "get_solar_potential",
      title: "Get roof solar potential (Sonnendach)",
      description:
        "Return the federal Sonnendach solar-energy suitability of the roof surface(s) within 5 m of the given WGS84 coordinates, nearest first: suitability class, mean irradiation per m² (kWh/m²/yr), total roof-surface irradiation (kWh/yr), roof area, orientation and slope. Orientation follows the Sonnendach convention: 0° = south, −90° = east, +90° = west, ±180° = north.",
      inputSchema: { ...coordArgs },
      handler: async ({ lat, lon }) => {
        try {
          const { data, cacheStatus, retrievedAt } = await identify(
            "ch.bfe.solarenergie-eignung-daecher",
            lat,
            lon,
            5,
            true,
          );
          const { easting, northing } = wgs84ToLv95(lat, lon);
          const roofs = sortFeaturesByDistance(data.results ?? [], easting, northing).slice(0, 10).map(mapRoof);
          if (!roofs.length) {
            return toolError(`No roof found at ${lat}, ${lon}.`, [
              "Solar potential data exists only where a building roof is mapped; geocode the address first and use its coordinates.",
            ]);
          }
          return respond(
            {
              query: { lat, lon },
              orientation_convention: "0° = south, −90° = east, +90° = west, ±180° = north (Sonnendach)",
              roofs,
            },
            {
              source: { ...swisstopo, name: "Sonnendach (SFOE via geo.admin.ch)", attribution: "© SFOE / swisstopo" },
              cacheStatus,
              retrievedAt,
            },
          );
        } catch (err) {
          return errorToResult(err, "Sonnendach solar potential");
        }
      },
    }),

    tool({
      name: "identify_map_layers",
      title: "Identify federal map layers at a point",
      description:
        "Power tool: query any federal geodata layer(s) at a WGS84 point (e.g. 'ch.bafu.laerm-strassenlaerm_tag' for road noise, 'ch.bafu.gefahren-basiskarte' hazards, 'ch.are.bauzonen' building zones). Returns raw attributes per matching feature.",
      inputSchema: {
        ...coordArgs,
        layers: z
          .string()
          .describe("Comma-separated geo.admin.ch layer IDs (BOD IDs), e.g. 'ch.bafu.laerm-strassenlaerm_tag'"),
        tolerance: z.number().int().min(0).max(100).default(10).describe("Search tolerance in metres"),
      },
      handler: async ({ lat, lon, layers, tolerance }) => {
        try {
          const { data, cacheStatus, retrievedAt } = await identify(layers, lat, lon, tolerance);
          const results = (data.results ?? []).slice(0, 20).map((r) => ({
            layer: r.layerBodId,
            feature_id: r.featureId,
            attributes: r.attributes,
          }));
          return respond(
            { query: { lat, lon, layers }, matches: results.length, results },
            { source: swisstopo, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "swisstopo identify");
        }
      },
    }),
  ],
};
