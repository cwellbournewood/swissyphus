/**
 * Air quality module — NABEL, the national air pollution monitoring network
 * (FOEN/Empa), station directory via geo.admin.ch, plus the legal limit
 * values of the Swiss Ordinance on Air Pollution Control (LRV/OAPC).
 */

import { z } from "zod";
import { fetchJson, withParams } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { byDistance, distanceKm, lv95ToWgs84 } from "../core/coords.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

const source: SourceManifest = {
  id: "nabel",
  name: "NABEL — National Air Pollution Monitoring Network",
  operator: "FOEN/BAFU and Empa",
  url: "https://www.bafu.admin.ch/bafu/en/home/topics/air/state/data.html",
  licence: "Swiss OGD — free use with attribution",
  attribution: "© FOEN/BAFU, NABEL",
  updateFrequency: "hourly (live values on the BAFU site)",
  cacheTtlSeconds: 24 * 3600,
  notes: "Station directory + legal limits served directly; live hourly values are linked per station (BAFU data page).",
};

/** LRV/OAPC annual and short-term ambient limit values. */
const LRV_LIMITS = [
  { pollutant: "PM10", limit: "20 µg/m³ annual mean; 50 µg/m³ daily mean (max 1 exceedance/year)" },
  { pollutant: "PM2.5", limit: "10 µg/m³ annual mean" },
  { pollutant: "NO2", limit: "30 µg/m³ annual mean; 80 µg/m³ daily mean" },
  { pollutant: "O3", limit: "120 µg/m³ hourly mean (max 1 exceedance/year); 100 µg/m³ 98th percentile of half-hourly means per month" },
  { pollutant: "SO2", limit: "30 µg/m³ annual mean; 100 µg/m³ daily mean" },
  { pollutant: "CO", limit: "8 mg/m³ daily mean" },
];

interface FindResult {
  results?: Array<{
    featureId?: string | number;
    attributes?: Record<string, unknown>;
    geometry?: { x?: number; y?: number };
  }>;
}

async function fetchStations(): Promise<{
  results: NonNullable<FindResult["results"]>;
  cacheStatus: "hit" | "miss" | "stale" | "computed";
  retrievedAt: string;
}> {
  // The find endpoint needs a searchText; union over vowels covers every
  // station name, deduped by feature id. Responses are cached for 24 h.
  const seen = new Map<string, NonNullable<FindResult["results"]>[number]>();
  let cacheStatus: "hit" | "miss" | "stale" | "computed" = "hit";
  let retrievedAt = new Date().toISOString();
  for (const letter of ["a", "e", "i", "o", "u"]) {
    const url = withParams("https://api3.geo.admin.ch/rest/services/api/MapServer/find", {
      layer: "ch.bafu.nabelstationen",
      searchField: "name",
      searchText: letter,
      contains: true,
      returnGeometry: true,
      sr: 2056,
      lang: "en",
    });
    const r = await fetchJson<FindResult>(url, { ttlMs: source.cacheTtlSeconds * 1000 });
    if (r.cacheStatus !== "hit") cacheStatus = r.cacheStatus;
    retrievedAt = r.retrievedAt;
    for (const res of r.data.results ?? []) {
      seen.set(String(res.featureId), res);
    }
  }
  return { results: [...seen.values()], cacheStatus, retrievedAt };
}

function mapStation(r: NonNullable<FindResult["results"]>[number]) {
  const a = r.attributes ?? {};
  const e = r.geometry?.x;
  const n = r.geometry?.y;
  const wgs = e !== undefined && n !== undefined && e > 2_000_000 ? lv95ToWgs84(e, n) : undefined;
  return {
    code: r.featureId,
    name: a["name"],
    station_type: a["typ_en"] ?? a["typ"] ?? a["station_type"],
    altitude_m: a["hoehe"] ?? a["altitude"],
    wgs84: wgs,
    live_data_url: a["url_en"] ?? a["url_de"],
  };
}

export const airQualityModule: SwissyphusModule = {
  id: "airquality",
  emoji: "💨",
  title: "Air quality (NABEL)",
  description: "National air-monitoring stations with live-data links, plus Swiss LRV legal limits",
  sources: [source],
  healthProbes: [
    {
      sourceId: "nabel",
      url: "https://api3.geo.admin.ch/rest/services/api/MapServer/find?layer=ch.bafu.nabelstationen&searchField=name&searchText=Bern&contains=true&returnGeometry=false",
    },
  ],
  tools: [
    tool({
      name: "list_air_quality_stations",
      title: "List NABEL air-monitoring stations",
      description:
        "All stations of the national NABEL air pollution monitoring network with type, altitude, coordinates and links to live hourly data. Optionally sorted by distance from a point.",
      inputSchema: {
        near_lat: z.number().optional().describe("Optional WGS84 latitude to sort by distance"),
        near_lon: z.number().optional(),
        limit: z.number().int().min(1).max(50).default(30),
      },
      handler: async ({ near_lat, near_lon, limit }) => {
        try {
          const { results, cacheStatus, retrievedAt } = await fetchStations();
          const near = near_lat !== undefined && near_lon !== undefined ? { lat: near_lat, lon: near_lon } : undefined;
          const stations = byDistance(results.map(mapStation), near, (s) => s.wgs84);
          const total = stations.length;
          if (!total) return toolError("NABEL station directory returned no stations.");
          return respond(
            { count: total, stations: stations.slice(0, limit) },
            { source, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "NABEL station directory");
        }
      },
    }),

    tool({
      name: "get_air_quality",
      title: "Air quality station info + legal limits",
      description:
        "NABEL station details (nearest to a point or by name) together with the Swiss legal ambient limit values (LRV/OAPC) for PM10, PM2.5, NO2, O3, SO2 and CO, plus the link to live hourly measurements.",
      inputSchema: {
        station_name: z.string().optional().describe("Station name fragment, e.g. 'Bern', 'Lugano'"),
        lat: z.number().optional().describe("Or: WGS84 latitude for nearest station"),
        lon: z.number().optional(),
      },
      handler: async ({ station_name, lat, lon }) => {
        try {
          const { results, cacheStatus, retrievedAt } = await fetchStations();
          let stations = results.map(mapStation);
          if (station_name) {
            const q = station_name.toLowerCase();
            stations = stations.filter((s) => String(s.name ?? "").toLowerCase().includes(q));
          } else if (lat !== undefined && lon !== undefined) {
            stations = stations
              .filter((s) => s.wgs84)
              .sort(
                (a, b) =>
                  distanceKm(lat, lon, a.wgs84!.lat, a.wgs84!.lon) -
                  distanceKm(lat, lon, b.wgs84!.lat, b.wgs84!.lon),
              )
              .slice(0, 1);
          }
          if (!stations.length) {
            return toolError("No matching NABEL station.", [
              "Pass station_name (e.g. 'Basel') or lat/lon; list_air_quality_stations shows all stations.",
            ]);
          }
          return respond(
            {
              station: stations[0],
              swiss_legal_limits_lrv: LRV_LIMITS,
              note: "Live hourly values are published on the linked BAFU page per station.",
            },
            { source, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "NABEL station directory");
        }
      },
    }),
  ],
};
