/**
 * Snow module — SLF IMIS automatic measurement network (300+ high-alpine
 * stations): snow depth, air/surface temperature, wind.
 */

import { z } from "zod";
import { fetchJson } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { distanceKm } from "../core/coords.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

const imis: SourceManifest = {
  id: "slf-imis",
  name: "SLF IMIS measurement network",
  operator: "WSL Institute for Snow and Avalanche Research SLF",
  url: "https://measurement.slf.ch",
  licence: "SLF measurement open data — free use with attribution",
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

interface ImisMeasurement {
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

function compactMeasurement(m: ImisMeasurement) {
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
        try {
          const { data, cacheStatus, retrievedAt } = await fetchJson<ImisStation[]>(`${BASE}/stations`, {
            ttlMs: 24 * 3600 * 1000,
          });
          let stations = data.map((s) => ({
            code: s.code,
            name: s.label,
            elevation_m: s.elevation,
            canton: s.canton_code,
            type: s.type,
            wgs84: s.lat !== undefined && s.lon !== undefined ? { lat: s.lat, lon: s.lon } : undefined,
            distance_km: undefined as number | undefined,
          }));
          if (canton) stations = stations.filter((s) => s.canton === canton.toUpperCase());
          if (query) {
            const q = query.toLowerCase();
            stations = stations.filter((s) => (s.name ?? "").toLowerCase().includes(q));
          }
          if (near_lat !== undefined && near_lon !== undefined) {
            for (const s of stations) {
              if (s.wgs84) s.distance_km = distanceKm(near_lat, near_lon, s.wgs84.lat, s.wgs84.lon);
            }
            stations.sort((a, b) => (a.distance_km ?? 1e9) - (b.distance_km ?? 1e9));
          }
          if (!stations.length) return toolError("No IMIS stations matched the filters.");
          return respond(
            { count: stations.length, stations: stations.slice(0, limit) },
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
        "Latest measurements (snow depth, temperatures, wind) from IMIS stations. Filter by station code (from list_snow_stations) or get the deepest-snow stations right now.",
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
          let rows = data;
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
            { measurements, total_reporting_stations: data.length },
            { source: imis, cacheStatus, retrievedAt, dataAsOf: newest || undefined },
          );
        } catch (err) {
          return errorToResult(err, "SLF IMIS API");
        }
      },
    }),
  ],
};
