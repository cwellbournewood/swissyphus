/**
 * Trails module — official hiking trail closures and detours
 * (SwitzerlandMobility/ASTRA layer on geo.admin.ch).
 */

import { z } from "zod";
import { fetchJson, withParams } from "../core/http.js";
import { respond, errorToResult } from "../core/envelope.js";
import { wgs84ToLv95 } from "../core/coords.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

const source: SourceManifest = {
  id: "astra-trails",
  name: "Hiking trail closures and detours (Wanderland)",
  operator: "FEDRO/ASTRA and SwitzerlandMobility",
  url: "https://map.geo.admin.ch/?layers=ch.astra.wanderland-sperrungen_umleitungen",
  licence: "Free use with source attribution (geo.admin.ch terms)",
  attribution: "© ASTRA / SwitzerlandMobility",
  updateFrequency: "continuous",
  cacheTtlSeconds: 1800,
};

interface IdentifyResult {
  results?: Array<{ featureId?: string | number; attributes?: Record<string, unknown> }>;
}

async function identifyClosures(e: number, n: number, halfWidth: number, tolerancePx: number) {
  const url = withParams("https://api3.geo.admin.ch/rest/services/api/MapServer/identify", {
    geometry: `${e},${n}`,
    geometryType: "esriGeometryPoint",
    sr: 2056,
    layers: "all:ch.astra.wanderland-sperrungen_umleitungen",
    tolerance: tolerancePx,
    mapExtent: `${e - halfWidth},${n - halfWidth},${e + halfWidth},${n + halfWidth}`,
    imageDisplay: "100,100,96",
    returnGeometry: false,
    lang: "en",
  });
  return fetchJson<IdentifyResult>(url, { ttlMs: source.cacheTtlSeconds * 1000, timeoutMs: 30_000 });
}

function mapClosure(r: NonNullable<IdentifyResult["results"]>[number]) {
  const a = r.attributes ?? {};
  const pick = (base: string) => a[`${base}_en`] ?? a[base] ?? a[`${base}_de`];
  return {
    id: r.featureId,
    type: pick("sperrungen_type"),
    title: pick("title"),
    description: pick("description"),
    reason: pick("grund") ?? pick("reason"),
    valid_from: a["date_from"] ?? a["gueltig_von"],
    valid_to: a["date_to"] ?? a["gueltig_bis"],
    url: a["url"] ?? a["link"],
  };
}

export const trailsModule: SwissyphusModule = {
  id: "trails",
  emoji: "🥾",
  title: "Trail closures",
  description: "Official hiking-trail closures and detours near a point (search radius up to 100 km)",
  sources: [source],
  healthProbes: [
    {
      sourceId: "astra-trails",
      url: withParams("https://api3.geo.admin.ch/rest/services/api/MapServer/identify", {
        geometry: "2660000,1183000",
        geometryType: "esriGeometryPoint",
        sr: 2056,
        layers: "all:ch.astra.wanderland-sperrungen_umleitungen",
        tolerance: 100,
        mapExtent: "2600000,1120000,2720000,1240000",
        imageDisplay: "100,100,96",
        returnGeometry: false,
      }),
    },
  ],
  tools: [
    tool({
      name: "get_trail_closures",
      title: "Hiking trail closures near a point",
      description:
        "Current official hiking-trail closures and detours near a WGS84 point. The search covers roughly radius_km (default 20 km, max 100 km) around the point; it is a map-tolerance buffer that may be a square box, so features up to ~1.4× radius_km away can be included, and distances are not computed. There is no nationwide listing. Use before recommending any hike.",
      inputSchema: {
        lat: z.number().min(45.5).max(48).describe("WGS84 latitude"),
        lon: z.number().min(5.5).max(11).describe("WGS84 longitude"),
        radius_km: z.number().min(1).max(100).default(20),
        limit: z.number().int().min(1).max(50).default(15),
      },
      handler: async ({ lat, lon, radius_km, limit }) => {
        try {
          const { easting, northing } = wgs84ToLv95(lat, lon);
          const halfWidth = radius_km * 1000;
          // With a 100px display over a 2×radius extent, 1px = radius/50 m, so a
          // 50px tolerance = radius. The tolerance buffer may be box-shaped rather
          // than a circle, hence the "approx." search-window wording.
          const { data, cacheStatus, retrievedAt } = await identifyClosures(easting, northing, halfWidth, 50);
          const all = data.results ?? [];
          const closures = all.slice(0, limit).map(mapClosure);
          return respond(
            {
              query: { lat, lon, radius_km },
              search_window: `approx. ±${radius_km} km around the point (identify tolerance buffer; not an exact circle)`,
              closure_count: all.length,
              returned: closures.length,
              status: all.length
                ? `${all.length} closure(s)/detour(s) in the search window`
                : "no closures reported in the search window",
              closures,
            },
            { source, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "trail closures layer");
        }
      },
    }),
  ],
};
