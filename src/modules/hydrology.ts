/**
 * Hydrology module — FOEN/BAFU river and lake monitoring.
 *
 * Data origin is the Federal Office for the Environment hydrology network
 * (~600 stations). Keyless delivery path is the api.existenz.ch proxy of the
 * official FOEN feed (documented fallback per RFP §4.1); the official
 * hydrodaten.admin.ch station page is linked on every response.
 */

import { z } from "zod";
import { fetchJson } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

const foen: SourceManifest = {
  id: "foen-hydro",
  name: "FOEN Hydrology — river & lake levels, discharge, temperature",
  operator: "Federal Office for the Environment (FOEN/BAFU)",
  url: "https://www.hydrodaten.admin.ch",
  licence: "FOEN hydrological data terms — free use with attribution",
  attribution: "© FOEN/BAFU Hydrology",
  updateFrequency: "10 min – hourly per station",
  cacheTtlSeconds: 600,
  notes:
    "Keyless delivery via api.existenz.ch proxy of the official FOEN feed; official station pages linked per response.",
};

const PARAMS: Record<string, string> = {
  height: "water level (m a.s.l. or gauge m)",
  flow: "discharge (m³/s)",
  temperature: "water temperature (°C)",
};

export const hydrologyModule: SwissyphusModule = {
  id: "hydrology",
  emoji: "🌊",
  title: "Hydrology (FOEN)",
  description: "Live river/lake levels, discharge and water temperature from ~600 federal stations",
  sources: [foen],
  healthProbes: [
    { sourceId: "foen-hydro", url: "https://api.existenz.ch/apiv1/hydro/latest?locations=2099" },
  ],
  tools: [
    tool({
      name: "get_water_data",
      title: "Live water data for a station",
      description:
        "Latest water level, discharge and temperature for a FOEN hydrology station. Use the numeric station ID (e.g. 2099 = Aare Bern, 2243 = Rhône Geneva, 2606 = Lake Zurich). If you don't know the ID, call list_hydro_stations first.",
      inputSchema: {
        station_id: z.string().regex(/^\d{2,5}$/).describe("FOEN station number, e.g. '2099'"),
      },
      handler: async ({ station_id }) => {
        try {
          const { data, cacheStatus, retrievedAt } = await fetchJson<{
            payload?: Array<{ timestamp?: number; loc?: string; par?: string; val?: number }>;
          }>(`https://api.existenz.ch/apiv1/hydro/latest?locations=${station_id}`, {
            ttlMs: foen.cacheTtlSeconds * 1000,
          });
          const payload = data.payload ?? [];
          if (!payload.length) {
            return toolError(`No live data for station ${station_id}.`, [
              "Verify the station ID with list_hydro_stations.",
            ]);
          }
          const readings = payload.map((p) => ({
            parameter: p.par,
            parameter_description: PARAMS[p.par ?? ""] ?? p.par,
            value: p.val,
            measured_at: p.timestamp ? new Date(p.timestamp * 1000).toISOString() : undefined,
          }));
          const newest = Math.max(...payload.map((p) => p.timestamp ?? 0));
          return respond(
            { station_id, readings },
            {
              source: foen,
              cacheStatus,
              retrievedAt,
              dataAsOf: newest ? new Date(newest * 1000).toISOString() : undefined,
              links: { official_station_page: `https://www.hydrodaten.admin.ch/en/${station_id}.html` },
            },
          );
        } catch (err) {
          return errorToResult(err, "FOEN hydrology feed");
        }
      },
    }),

    tool({
      name: "get_water_history",
      title: "Historical water data for a station",
      description:
        "Historical water level, discharge or temperature for a FOEN station over a date range (recent weeks). Data is downsampled to stay compact.",
      inputSchema: {
        station_id: z.string().regex(/^\d{2,5}$/).describe("FOEN station number, e.g. '2099'"),
        date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date YYYY-MM-DD"),
        date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date (default: today)"),
        parameter: z.enum(["height", "flow", "temperature"]).default("flow"),
      },
      handler: async ({ station_id, date_from, date_to, parameter }) => {
        try {
          const url = `https://api.existenz.ch/apiv1/hydro/daterange?locations=${station_id}&startdate=${date_from}&enddate=${
            date_to ?? new Date().toISOString().slice(0, 10)
          }&parameters=${parameter}`;
          const { data, cacheStatus, retrievedAt } = await fetchJson<{
            payload?: Array<{ timestamp?: number; par?: string; val?: number }>;
          }>(url, { ttlMs: 3600 * 1000, timeoutMs: 30_000 });
          const payload = (data.payload ?? []).filter((p) => p.par === parameter || !p.par);
          if (!payload.length) {
            return toolError(`No ${parameter} history for station ${station_id} in that range.`, [
              "The keyless history feed retains roughly the last few weeks.",
              "Verify the station with list_hydro_stations.",
            ]);
          }
          const step = Math.max(1, Math.floor(payload.length / 200));
          const series = payload
            .filter((_, i) => i % step === 0)
            .map((p) => ({
              time: p.timestamp ? new Date(p.timestamp * 1000).toISOString() : undefined,
              value: p.val,
            }));
          return respond(
            {
              station_id,
              parameter,
              parameter_description: PARAMS[parameter],
              points: series.length,
              downsampled: step > 1,
              series,
            },
            {
              source: foen,
              cacheStatus,
              retrievedAt,
              links: { official_station_page: `https://www.hydrodaten.admin.ch/en/${station_id}.html` },
            },
          );
        } catch (err) {
          return errorToResult(err, "FOEN hydrology feed");
        }
      },
    }),

    tool({
      name: "list_hydro_stations",
      title: "List FOEN hydrology stations",
      description:
        "List FOEN river/lake monitoring stations with their IDs and water bodies. Optionally filter by name (river, lake or place).",
      inputSchema: {
        query: z.string().optional().describe("Filter by water body or place name, e.g. 'Aare' or 'Bern'"),
        limit: z.number().int().min(1).max(100).default(25),
      },
      handler: async ({ query, limit }) => {
        try {
          const { data, cacheStatus, retrievedAt } = await fetchJson<Record<string, unknown>>(
            "https://api.existenz.ch/apiv1/hydro/locations",
            { ttlMs: 24 * 3600 * 1000 },
          );
          // The locations payload maps station IDs to { details: {...} } objects.
          interface LocDetails {
            name?: string;
            "water-body-name"?: string;
            "water-body-type"?: string;
            lat?: number;
            lon?: number;
          }
          const raw =
            (data as { payload?: Record<string, { details?: LocDetails }> }).payload ?? {};
          let stations = Object.entries(raw).map(([id, meta]) => ({
            station_id: id,
            place: meta.details?.name,
            water_body: meta.details?.["water-body-name"],
            type: meta.details?.["water-body-type"],
            wgs84:
              meta.details?.lat !== undefined
                ? { lat: meta.details.lat, lon: meta.details.lon }
                : undefined,
            official_page: `https://www.hydrodaten.admin.ch/en/${id}.html`,
          }));
          if (query) {
            const q = query.toLowerCase();
            stations = stations.filter(
              (s) =>
                String(s.place ?? "").toLowerCase().includes(q) ||
                String(s.water_body ?? "").toLowerCase().includes(q),
            );
          }
          if (!stations.length) {
            return toolError(`No hydrology stations matching '${query ?? ""}'.`);
          }
          return respond(
            { count: stations.length, stations: stations.slice(0, limit) },
            { source: foen, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "FOEN hydrology feed");
        }
      },
    }),
  ],
};
