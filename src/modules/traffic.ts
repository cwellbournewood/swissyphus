/**
 * Traffic module: FEDRO/ASTRA road traffic counting stations on the
 * national and main road network (geo.admin.ch layer
 * ch.astra.strassenverkehrszaehlung-uebergeordnet): annual average daily
 * traffic, weekday and peak-hour volumes, and heavy-goods shares. The whole
 * network (~340 stations) is loaded once and indexed.
 */

import { z } from "zod";
import { withParams } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { distanceKm } from "../core/coords.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";
import { fold, loadWholeLayer, mapLink, num, type LayerPoint } from "./layerIndex.js";

const LAYER = "ch.astra.strassenverkehrszaehlung-uebergeordnet";

const astraCounts: SourceManifest = {
  id: "astra-traffic-counts",
  name: "Road traffic counts, national and main roads",
  operator: "Federal Roads Office (FEDRO/ASTRA)",
  url: `https://map.geo.admin.ch/?layers=${LAYER}`,
  licence: "Free use with source attribution (geo.admin.ch / federal geodata terms)",
  attribution: "© FEDRO (ASTRA), via geo.admin.ch",
  updateFrequency: "yearly (annual averages of the previous year)",
  cacheTtlSeconds: 24 * 3600,
  maxStaleSeconds: 120 * 86_400,
  notes:
    "Annual averages per automatic counting station. Daily figures are motor vehicles per day in both directions; peak-hour figures are vehicles per hour.",
};

export interface CountingStation {
  id: string;
  station: string;
  number?: string;
  canton?: string;
  road?: string;
  direction_1?: string;
  direction_2?: string;
  lanes_direction_1: number | null;
  lanes_direction_2: number | null;
  network?: string;
  year: number | null;
  daily_avg: number | null;
  weekday_avg: number | null;
  morning_peak_hour: number | null;
  evening_peak_hour: number | null;
  weekday_morning_peak_hour: number | null;
  weekday_evening_peak_hour: number | null;
  hourly_avg_day: number | null;
  hourly_avg_night: number | null;
  heavy_traffic_pct: number | null;
  heavy_traffic_day_pct: number | null;
  heavy_traffic_night_pct: number | null;
  lat: number;
  lon: number;
  map_url: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : v == null ? undefined : String(v));

export function mapStation(p: LayerPoint): CountingStation {
  const a = p.attributes;
  return {
    id: p.id,
    station: str(a["mlocname"]) ?? str(a["label"]) ?? p.id,
    number: str(a["mlocnr"]),
    canton: str(a["canton"]),
    road: str(a["streetdesignation"]),
    direction_1: str(a["targetlocation1"]),
    direction_2: str(a["targetlocation2"]),
    lanes_direction_1: num(a["numberoflanes1"]),
    lanes_direction_2: num(a["numberoflanes2"]),
    network: str(a["en_networktype"]),
    year: num(a["year"]),
    daily_avg: num(a["dtv"]),
    weekday_avg: num(a["dwv"]),
    morning_peak_hour: num(a["msp"]),
    evening_peak_hour: num(a["asp"]),
    weekday_morning_peak_hour: num(a["mspw"]),
    weekday_evening_peak_hour: num(a["aspw"]),
    hourly_avg_day: num(a["nt"]),
    hourly_avg_night: num(a["nn"]),
    heavy_traffic_pct: num(a["prctheavytraffic"]),
    heavy_traffic_day_pct: num(a["prctheavytrafficday"]),
    heavy_traffic_night_pct: num(a["prctheavytrafficnight"]),
    lat: p.lat,
    lon: p.lon,
    map_url: mapLink(LAYER, p.lat, p.lon),
  };
}

/** "a1", "A 1", "A1" → "a1"; "H 18" → "h18". */
const roadKey = (s: string | undefined) => fold(s).replace(/\s+/g, "");

const SORT = { daily: "daily_avg", heavy_share: "heavy_traffic_pct", evening_peak: "evening_peak_hour" } as const;

export function filterStations(
  all: CountingStation[],
  q: { station?: string; road?: string; canton?: string; sort_by: keyof typeof SORT },
): CountingStation[] {
  const needle = q.station ? fold(q.station) : "";
  const road = q.road ? roadKey(q.road) : "";
  const canton = q.canton ? q.canton.trim().toUpperCase() : "";
  const key = SORT[q.sort_by];
  return all
    .filter((s) => !needle || fold(s.station).includes(needle) || fold(s.direction_1).includes(needle) || fold(s.direction_2).includes(needle))
    .filter((s) => !road || roadKey(s.road) === road)
    .filter((s) => !canton || (s.canton ?? "").toUpperCase() === canton)
    .sort((a, b) => (b[key] ?? -Infinity) - (a[key] ?? -Infinity));
}

async function loadStations() {
  const { points, cacheStatus, retrievedAt } = await loadWholeLayer(LAYER, astraCounts);
  const stations = points.map(mapStation);
  const year = stations.reduce((y, s) => Math.max(y, s.year ?? 0), 0);
  return { stations, cacheStatus, retrievedAt, dataAsOf: year ? String(year) : undefined };
}

export const trafficModule: SwissyphusModule = {
  id: "traffic",
  emoji: "🛣️",
  title: "Road traffic counts (FEDRO)",
  description:
    "Annual road traffic at ~340 FEDRO counting stations on national and main roads: daily and weekday volumes, peak hours and heavy-goods share, by station, road, canton or distance",
  sources: [astraCounts],
  healthProbes: [{ sourceId: "astra-traffic-counts", url: withParams(`https://api3.geo.admin.ch/rest/services/api/MapServer/${LAYER}`, { lang: "en" }) }],
  tools: [
    tool({
      name: "get_traffic_counts",
      title: "Road traffic counts by station, road or canton",
      description:
        "Annual average traffic from FEDRO's automatic counting stations: vehicles per day (all days and weekdays), morning and evening peak hours, day and night hourly averages, and heavy-goods share. Filter by station or place name, road (A1, A 2, H 18) or canton (UR, GR, …); sorted by daily volume or heavy-goods share. With no filter it ranks the busiest stations nationwide. Examples: {station:'Gotthard'}, {road:'A1', canton:'ZH'}, {sort_by:'heavy_share'}.",
      inputSchema: {
        station: z.string().max(80).optional().describe("Station or place name, partial (e.g. 'Gotthard', 'Muttenz')"),
        road: z.string().max(10).optional().describe("Road designation, e.g. A1, A 13, H 18"),
        canton: z.string().length(2).optional().describe("Two-letter canton code, e.g. UR"),
        sort_by: z.enum(["daily", "heavy_share", "evening_peak"]).default("daily"),
        limit: z.number().int().min(1).max(50).default(10),
      },
      handler: async ({ station, road, canton, sort_by, limit }) => {
        try {
          const { stations, cacheStatus, retrievedAt, dataAsOf } = await loadStations();
          const hits = filterStations(stations, { station, road, canton, sort_by });
          if (!hits.length) {
            return toolError(`No FEDRO counting station matches ${JSON.stringify({ station, road, canton })}.`, [
              "Use a place name on the road (e.g. 'Gotthard', 'Bern', 'Chiasso') or a road such as 'A1'.",
              "get_traffic_counts_nearby finds stations around a point.",
            ], { kind: "not_found" });
          }
          return respond(
            {
              query: { station, road, canton, sort_by },
              units: "daily: vehicles/day, both directions; peak and hourly: vehicles/hour; shares: % of all vehicles",
              total_matches: hits.length,
              stations: hits.slice(0, limit),
            },
            { source: astraCounts, cacheStatus, retrievedAt, ...(dataAsOf ? { dataAsOf } : {}) },
          );
        } catch (err) {
          return errorToResult(err, "FEDRO traffic counts");
        }
      },
    }),
    tool({
      name: "get_traffic_counts_nearby",
      title: "Traffic counting stations near a point",
      description:
        "FEDRO counting stations within radius_km of a WGS84 point, nearest first, with exact distances and their annual traffic figures. Example: {lat: 47.05, lon: 8.31, radius_km: 10}.",
      inputSchema: {
        lat: z.number().min(45.5).max(48).describe("WGS84 latitude"),
        lon: z.number().min(5.5).max(11).describe("WGS84 longitude"),
        radius_km: z.number().min(1).max(100).default(15),
        limit: z.number().int().min(1).max(30).default(8),
      },
      handler: async ({ lat, lon, radius_km, limit }) => {
        try {
          const { stations, cacheStatus, retrievedAt, dataAsOf } = await loadStations();
          const near = stations
            .map((s) => ({ ...s, distance_km: Math.round(distanceKm(lat, lon, s.lat, s.lon) * 10) / 10 }))
            .filter((s) => s.distance_km <= radius_km)
            .sort((a, b) => a.distance_km - b.distance_km);
          return respond(
            { query: { lat, lon, radius_km }, count: near.length, stations: near.slice(0, limit) },
            { source: astraCounts, cacheStatus, retrievedAt, ...(dataAsOf ? { dataAsOf } : {}) },
          );
        } catch (err) {
          return errorToResult(err, "FEDRO traffic counts");
        }
      },
    }),
  ],
};
