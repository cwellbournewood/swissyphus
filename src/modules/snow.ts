/**
 * Snow module — SLF IMIS automatic measurement network (300+ high-alpine
 * stations): snow depth, air/surface temperature, wind.
 */

import { z } from "zod";
import { fetchJson } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { byDistance } from "../core/coords.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";
import { pairError } from "./_args.js";

const imis: SourceManifest = {
  id: "slf-imis",
  name: "SLF IMIS measurement network",
  operator: "WSL Institute for Snow and Avalanche Research SLF",
  url: "https://measurement.slf.ch",
  licence:
    "© SLF/WSL IMIS — publicly accessible measurements; attribution required. Terms for commercial redistribution are not yet confirmed and are to be clarified with SLF.",
  attribution: "© SLF/WSL IMIS",
  updateFrequency: "30 min",
  cacheTtlSeconds: 900,
};

const BASE = "https://measurement-api.slf.ch/public/api/imis";

interface ImisStation {
  code?: string;
  label?: string;
  lon?: number;
  lat?: number;
  elevation?: number;
  canton_code?: string;
  type?: string;
}

export interface ImisMeasurement {
  station_code?: string;
  measure_date?: string;
  HS?: number | null;
  TA_30MIN_MEAN?: number | null;
  TSS_30MIN_MEAN?: number | null;
  RH_30MIN_MEAN?: number | null;
  VW_30MIN_MEAN?: number | null;
  VW_30MIN_MAX?: number | null;
  DW_30MIN_MEAN?: number | null;
}

/**
 * The measurements endpoint can return several 30-min rows per station.
 * Keep only the newest row per station (by parsed timestamp;
 * rows without a station code are dropped).
 */
export function latestPerStation(rows: ImisMeasurement[]): ImisMeasurement[] {
  const latest = new Map<string, ImisMeasurement>();
  for (const m of rows) {
    const code = m?.station_code;
    if (!code) continue;
    const prev = latest.get(code);
    const t = (d?: string) => (d ? Date.parse(d) : NaN);
    const tm = t(m.measure_date);
    const tp = t(prev?.measure_date);
    const newer = Number.isNaN(tm) || Number.isNaN(tp) ? (m.measure_date ?? "") > (prev?.measure_date ?? "") : tm > tp;
    if (!prev || newer) latest.set(code, m);
  }
  return [...latest.values()];
}

export function compactMeasurement(m: ImisMeasurement) {
  return {
    station_code: m.station_code,
    measured_at: m.measure_date,
    snow_depth_cm: m.HS ?? undefined,
    air_temp_c: m.TA_30MIN_MEAN ?? undefined,
    snow_surface_temp_c: m.TSS_30MIN_MEAN ?? undefined,
    relative_humidity_pct: m.RH_30MIN_MEAN ?? undefined,
    wind_mean_ms: m.VW_30MIN_MEAN ?? undefined,
    wind_max_ms: m.VW_30MIN_MAX ?? undefined,
    wind_direction_deg: m.DW_30MIN_MEAN ?? undefined,
  };
}

export const snowModule: SwissyphusModule = {
  id: "snow",
  emoji: "❄️",
  title: "Snow (SLF IMIS)",
  description: "Live snow depth, temperature and wind from 300+ high-alpine IMIS stations",
  sources: [imis],
  healthProbes: [{ sourceId: "slf-imis", url: `${BASE}/stations` }],
  tools: [
    tool({
      name: "list_snow_stations",
      title: "List IMIS snow stations",
      description:
        "List SLF IMIS high-alpine measurement stations with code, name, elevation and coordinates. Filter by canton or name, or sort by distance from a point.",
      inputSchema: {
        canton: z.string().length(2).optional().describe("Canton code filter, e.g. 'GR', 'VS'"),
        query: z.string().optional().describe("Name fragment filter"),
        near_lat: z.number().optional(),
        near_lon: z.number().optional(),
        limit: z.number().int().min(1).max(100).default(25),
      },
      handler: async ({ canton, query, near_lat, near_lon, limit }) => {
        const pe = pairError(near_lat, near_lon, "near_lat", "near_lon");
        if (pe) return toolError(pe);
        try {
          const { data, cacheStatus, retrievedAt } = await fetchJson<ImisStation[]>(`${BASE}/stations`, {
            ttlMs: 24 * 3600 * 1000,
            // 300+ IMIS stations: never cache an empty/garbled list for a day.
            validate: (d) => Array.isArray(d) && d.length > 0,
          });
          if (!Array.isArray(data)) return toolError("SLF IMIS returned an unrecognised station list format.", [], { kind: "unavailable" });
          let stations = data.map((s) => ({
            code: s.code,
            name: s.label,
            elevation_m: s.elevation,
            canton: s.canton_code,
            type: s.type,
            wgs84: s.lat !== undefined && s.lon !== undefined ? { lat: s.lat, lon: s.lon } : undefined,
          }));
          if (canton) stations = stations.filter((s) => s.canton === canton.toUpperCase());
          if (query) {
            const q = query.toLowerCase();
            stations = stations.filter((s) => (s.name ?? "").toLowerCase().includes(q));
          }
          if (!stations.length) return toolError("No IMIS stations matched the filters.");
          const near = near_lat !== undefined && near_lon !== undefined ? { lat: near_lat, lon: near_lon } : undefined;
          const sorted = byDistance(stations, near, (s) => s.wgs84);
          return respond(
            { count: sorted.length, stations: sorted.slice(0, limit) },
            { source: imis, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "SLF IMIS API");
        }
      },
    }),

    tool({
      name: "get_snow_conditions",
      title: "Live snow conditions",
      description:
        "Latest measurement per IMIS station (snow depth, temperatures, wind). Filter by station code (from list_snow_stations) or get the deepest-snow stations right now.",
      inputSchema: {
        station_code: z.string().optional().describe("IMIS station code, e.g. 'DAV2'"),
        top_snow: z.boolean().default(false).describe("If true, return stations sorted by current snow depth"),
        limit: z.number().int().min(1).max(50).default(10),
      },
      handler: async ({ station_code, top_snow, limit }) => {
        try {
          const { data, cacheStatus, retrievedAt } = await fetchJson<ImisMeasurement[]>(
            `${BASE}/measurements`,
            { ttlMs: imis.cacheTtlSeconds * 1000 },
          );
          if (!Array.isArray(data)) return toolError("SLF IMIS returned an unrecognised measurement format.", [], { kind: "unavailable" });
          const all = latestPerStation(data);
          let rows = all;
          if (station_code) {
            rows = rows.filter((m) => m.station_code === station_code.toUpperCase());
            if (!rows.length) {
              return toolError(`No current measurements for station '${station_code}'.`, [
                "Verify the code with list_snow_stations; wind-only stations do not report snow depth.",
              ]);
            }
          }
          if (top_snow) {
            rows = [...rows].sort((a, b) => (b.HS ?? -1) - (a.HS ?? -1));
          }
          const measurements = rows.slice(0, limit).map(compactMeasurement);
          const newest = rows
            .map((m) => m.measure_date ?? "")
            .sort()
            .pop();
          return respond(
            { measurements, total_reporting_stations: all.length },
            { source: imis, cacheStatus, retrievedAt, dataAsOf: newest || undefined },
          );
        } catch (err) {
          return errorToResult(err, "SLF IMIS API");
        }
      },
    }),
  ],
};
