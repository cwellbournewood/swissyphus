/**
 * Geodata module — swisstopo api3.geo.admin.ch.
 * Geocoding, reverse geocoding, elevation, elevation profiles, municipality
 * lookup, solar potential (Sonnendach) and generic layer identify.
 */

import { z } from "zod";
import { fetchJson, withParams } from "../core/http.js";
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

interface IdentifyResult {
  results?: Array<{
    layerBodId?: string;
    featureId?: string | number;
    attributes?: Record<string, unknown>;
  }>;
}

function stripHtml(s: string | undefined): string {
  return (s ?? "").replace(/<[^>]*>/g, "").trim();
}

async function identify(
  layers: string,
  lat: number,
  lon: number,
  tolerance: number,
): Promise<{ data: IdentifyResult; cacheStatus: "hit" | "miss" | "stale" | "computed"; retrievedAt: string }> {
  const { easting, northing } = wgs84ToLv95(lat, lon);
  const url = withParams(`${BASE}/api/MapServer/identify`, {
    geometry: `${easting},${northing}`,
    geometryType: "esriGeometryPoint",
    sr: 2056,
    layers: `all:${layers}`,
    tolerance,
    mapExtent: `${easting - 100},${northing - 100},${easting + 100},${northing + 100}`,
    imageDisplay: "100,100,96",
    returnGeometry: false,
    lang: "en",
  });
  return fetchJson<IdentifyResult>(url, { ttlMs: swisstopo.cacheTtlSeconds * 1000 });
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
            ttlMs: swisstopo.cacheTtlSeconds * 1000,
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
          );
          const results = (data.results ?? []).slice(0, 5).map((r) => {
            const a = r.attributes ?? {};
            return {
              street: a["strname_deinr"] ?? `${a["strname1"] ?? ""} ${a["deinr"] ?? ""}`.trim(),
              postal_code: a["dplz4"] ?? a["plz4"],
              locality: a["dplzname"] ?? a["plzname"],
              municipality: a["ggdename"] ?? a["gdename"],
              municipality_bfs_number: a["ggdenr"] ?? a["gdenr"],
              egid: a["egid"],
              building_category: a["gkat"],
              construction_year: a["gbauj"],
            };
          });
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
          const first = data.results?.[0];
          if (!first) {
            return toolError(`No municipality found at ${lat}, ${lon}.`);
          }
          const a = first.attributes ?? {};
          return respond(
            {
              municipality: a["gemname"] ?? a["name"],
              bfs_number: a["gemnummer"] ?? a["id"] ?? first.featureId,
              canton: a["kanton"],
              district: a["bezirksname"],
              area_ha: a["gem_flaeche"],
              all_attributes: a,
            },
            { source: swisstopo, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "swisstopo municipal boundaries");
        }
      },
    }),

    tool({
      name: "get_solar_potential",
      title: "Get roof solar potential (Sonnendach)",
      description:
        "Return the federal Sonnendach solar-energy suitability of the roof(s) at the given WGS84 coordinates: suitability class, irradiation, roof area, orientation and slope.",
      inputSchema: { ...coordArgs },
      handler: async ({ lat, lon }) => {
        try {
          const { data, cacheStatus, retrievedAt } = await identify(
            "ch.bfe.solarenergie-eignung-daecher",
            lat,
            lon,
            5,
          );
          const suitability = ["", "low", "medium", "good", "very good", "excellent"];
          const roofs = (data.results ?? []).slice(0, 10).map((r) => {
            const a = r.attributes ?? {};
            const klasse = typeof a["klasse"] === "number" ? a["klasse"] : Number(a["klasse"] ?? 0);
            return {
              suitability_class: klasse,
              suitability: suitability[klasse] ?? String(klasse),
              irradiation_kwh_m2_year: a["gstrahlung"] ?? a["mstrahlung"],
              roof_area_m2: a["flaeche"],
              orientation_deg: a["ausrichtung"],
              slope_deg: a["neigung"],
              building_id: a["building_id"] ?? a["sb_uuid"],
            };
          });
          if (!roofs.length) {
            return toolError(`No roof found at ${lat}, ${lon}.`, [
              "Solar potential data exists only where a building roof is mapped; geocode the address first and use its coordinates.",
            ]);
          }
          return respond(
            { query: { lat, lon }, roofs },
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
        tolerance: z.number().int().min(0).max(100).default(10).describe("Search tolerance in map pixels"),
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
