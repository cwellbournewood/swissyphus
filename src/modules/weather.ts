/**
 * Weather module — MeteoSwiss official data.
 *
 * - Local forecast + warnings: MeteoSwiss app service (plzDetail, official
 *   MeteoSwiss infrastructure, keyless).
 * - Live 10-minute station measurements: MeteoSwiss open government data
 *   published on data.geo.admin.ch (official OGD).
 */

import { z } from "zod";
import { fetchJson } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { byDistance } from "../core/coords.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

const meteo: SourceManifest = {
  id: "meteoswiss",
  name: "MeteoSwiss — Federal Office of Meteorology and Climatology",
  operator: "MeteoSwiss",
  url: "https://www.meteoswiss.admin.ch",
  licence: "Swiss OGD — free use with attribution",
  attribution: "© MeteoSwiss",
  updateFrequency: "10 min (measurements) / multiple daily (forecast)",
  cacheTtlSeconds: 600,
};

const ICONS: Record<number, string> = {
  1: "sunny",
  2: "mostly sunny",
  3: "partly cloudy",
  4: "cloudy",
  5: "overcast",
  6: "light rain showers",
  7: "rain and snow showers",
  8: "snow showers",
  9: "heavy rain showers",
  10: "heavy rain/snow showers",
  11: "heavy snow showers",
  12: "isolated thunderstorms",
  13: "thunderstorms",
  14: "very cloudy, light rain",
  15: "very cloudy, rain and snow",
  16: "very cloudy, light snow",
  17: "very cloudy, intermittent rain",
  18: "very cloudy, intermittent rain/snow",
  19: "very cloudy, intermittent snow",
  20: "very cloudy, rain",
  21: "very cloudy, rain and snow",
  22: "very cloudy, snow",
  23: "very cloudy, heavy rain",
  24: "very cloudy, heavy rain/snow",
  25: "very cloudy, heavy snow",
  26: "high fog",
  27: "stratus",
  28: "fog",
  29: "isolated showers, thunderstorms possible",
  30: "heavy showers, thunderstorms",
};

function iconText(code: number | undefined): string | undefined {
  if (code === undefined) return undefined;
  const base = code > 100 ? code - 100 : code;
  const text = ICONS[base];
  return text ? (code > 100 ? `${text} (night)` : text) : `icon ${code}`;
}

const WARN_TYPES: Record<number, string> = {
  0: "thunderstorm",
  1: "rain",
  2: "wind",
  3: "snow",
  4: "slippery roads",
  5: "frost",
  6: "heat wave",
  7: "avalanche",
  8: "earthquake",
  9: "forest fire",
  10: "flood",
  11: "drought",
};

interface PlzDetail {
  currentWeather?: { time?: number; temperature?: number; icon?: number };
  forecast?: Array<{
    dayDate?: string;
    iconDay?: number;
    temperatureMax?: number;
    temperatureMin?: number;
    precipitation?: number;
  }>;
  warnings?: Array<{
    warnType?: number;
    warnLevel?: number;
    text?: string;
    validFrom?: number;
    validTo?: number;
  }>;
}

async function plzDetail(plz: string): Promise<{ data: PlzDetail; cacheStatus: "hit" | "miss" | "stale" | "computed"; retrievedAt: string }> {
  // The MeteoSwiss app API keys locations as PLZ*100 (e.g. Zürich 8001 → 800100).
  const padded = plz.length === 4 ? `${plz}00` : plz;
  return fetchJson<PlzDetail>(`https://app-prod-ws.meteoswiss-app.ch/v1/plzDetail?plz=${padded}`, {
    ttlMs: meteo.cacheTtlSeconds * 1000,
  });
}

function mapWarnings(w: PlzDetail["warnings"]) {
  return (w ?? []).map((x) => ({
    type: WARN_TYPES[x.warnType ?? -1] ?? `type ${x.warnType}`,
    level: x.warnLevel,
    level_meaning: "1=minor, 2=moderate, 3=considerable, 4=high, 5=very high",
    text: x.text,
    valid_from: x.validFrom ? new Date(x.validFrom).toISOString() : undefined,
    valid_to: x.validTo ? new Date(x.validTo).toISOString() : undefined,
  }));
}

const MEASUREMENT_LAYERS: Record<string, { layer: string; unit: string }> = {
  temperature: { layer: "ch.meteoschweiz.messwerte-lufttemperatur-10min", unit: "°C" },
  precipitation: { layer: "ch.meteoschweiz.messwerte-niederschlag-10min", unit: "mm/10min" },
  wind: { layer: "ch.meteoschweiz.messwerte-windgeschwindigkeit-kmh-10min", unit: "km/h" },
  humidity: { layer: "ch.meteoschweiz.messwerte-luftfeuchtigkeit-10min", unit: "%" },
  sunshine: { layer: "ch.meteoschweiz.messwerte-sonnenscheindauer-10min", unit: "min/10min" },
};

interface MeasurementCollection {
  creation_time?: string;
  features?: Array<{
    id?: string;
    properties?: {
      station_name?: string;
      value?: number | string;
      unit?: string;
      altitude?: number | string;
      reference_ts?: string;
    };
    geometry?: { coordinates?: [number, number] };
  }>;
}

async function fetchMeasurements(parameter: string) {
  const cfg = MEASUREMENT_LAYERS[parameter];
  if (!cfg) throw new Error(`Unknown parameter '${parameter}'`);
  const url = `https://data.geo.admin.ch/${cfg.layer}/${cfg.layer}_en.json`;
  return fetchJson<MeasurementCollection>(url, { ttlMs: meteo.cacheTtlSeconds * 1000 });
}

export const weatherModule: SwissyphusModule = {
  id: "weather",
  emoji: "🌦️",
  title: "Weather (MeteoSwiss)",
  description: "Current conditions, 8-day forecast, official warnings, live station measurements",
  sources: [meteo],
  healthProbes: [
    { sourceId: "meteoswiss", url: "https://app-prod-ws.meteoswiss-app.ch/v1/plzDetail?plz=800100" },
  ],
  tools: [
    tool({
      name: "get_weather",
      title: "Current weather + forecast for a location",
      description:
        "Official MeteoSwiss current conditions, 8-day forecast and active weather warnings for a Swiss postal code.",
      inputSchema: {
        plz: z.string().regex(/^\d{4}$/).describe("4-digit Swiss postal code, e.g. '8001' for Zürich"),
      },
      handler: async ({ plz }) => {
        try {
          const { data, cacheStatus, retrievedAt } = await plzDetail(plz);
          if (!data.currentWeather && !data.forecast?.length) {
            return toolError(`MeteoSwiss has no data for PLZ ${plz}.`, [
              "Check the postal code with lookup_postcode; use the main PLZ of the town.",
            ]);
          }
          return respond(
            {
              plz,
              current: data.currentWeather
                ? {
                    time: data.currentWeather.time ? new Date(data.currentWeather.time).toISOString() : undefined,
                    temperature_c: data.currentWeather.temperature,
                    conditions: iconText(data.currentWeather.icon),
                  }
                : undefined,
              forecast: (data.forecast ?? []).map((d) => ({
                date: d.dayDate,
                conditions: iconText(d.iconDay),
                temp_min_c: d.temperatureMin,
                temp_max_c: d.temperatureMax,
                precipitation_mm: d.precipitation,
              })),
              active_warnings: mapWarnings(data.warnings),
            },
            {
              source: meteo,
              cacheStatus,
              retrievedAt,
              dataAsOf: data.currentWeather?.time ? new Date(data.currentWeather.time).toISOString() : undefined,
            },
          );
        } catch (err) {
          return errorToResult(err, "MeteoSwiss");
        }
      },
    }),

    tool({
      name: "get_weather_warnings",
      title: "Official weather warnings for a location",
      description:
        "Active MeteoSwiss weather warnings (wind, thunderstorms, heat, snow, flood, forest fire…) for a Swiss postal code, with danger levels 1–5.",
      inputSchema: {
        plz: z.string().regex(/^\d{4}$/).describe("4-digit Swiss postal code"),
      },
      handler: async ({ plz }) => {
        try {
          const { data, cacheStatus, retrievedAt } = await plzDetail(plz);
          const warnings = mapWarnings(data.warnings);
          return respond(
            {
              plz,
              active_warnings: warnings,
              status: warnings.length ? `${warnings.length} active warning(s)` : "no active warnings",
            },
            { source: meteo, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "MeteoSwiss");
        }
      },
    }),

    tool({
      name: "get_current_measurements",
      title: "Live measurements from MeteoSwiss stations",
      description:
        "Live 10-minute measurements from the official MeteoSwiss (SwissMetNet) station network. Choose a parameter and optionally filter to stations near a point or by name.",
      inputSchema: {
        parameter: z
          .enum(["temperature", "precipitation", "wind", "humidity", "sunshine"])
          .describe("Measured parameter"),
        near_lat: z.number().optional().describe("Optional: WGS84 latitude to sort stations by distance"),
        near_lon: z.number().optional().describe("Optional: WGS84 longitude"),
        station_name: z.string().optional().describe("Optional: filter by station name fragment"),
        limit: z.number().int().min(1).max(50).default(10),
      },
      handler: async ({ parameter, near_lat, near_lon, station_name, limit }) => {
        try {
          const { data, cacheStatus, retrievedAt } = await fetchMeasurements(parameter);
          const unit = MEASUREMENT_LAYERS[parameter]?.unit;
          let stations = (data.features ?? []).map((f) => {
            const [lon, lat] = f.geometry?.coordinates ?? [undefined, undefined];
            return {
              id: f.id,
              name: f.properties?.station_name,
              value: f.properties?.value,
              unit: f.properties?.unit ?? unit,
              altitude_m: f.properties?.altitude,
              measured_at: f.properties?.reference_ts,
              wgs84: lat !== undefined && lon !== undefined ? { lat, lon } : undefined,
            };
          });
          if (station_name) {
            const q = station_name.toLowerCase();
            stations = stations.filter((s) => (s.name ?? "").toLowerCase().includes(q));
          }
          const near = near_lat !== undefined && near_lon !== undefined ? { lat: near_lat, lon: near_lon } : undefined;
          const sliced = byDistance(stations, near, (s) => s.wgs84).slice(0, limit);
          if (!sliced.length) return toolError("No matching stations found.");
          return respond(
            { parameter, stations: sliced, total_stations: stations.length },
            { source: meteo, cacheStatus, retrievedAt, dataAsOf: data.creation_time },
          );
        } catch (err) {
          return errorToResult(err, "MeteoSwiss OGD measurements");
        }
      },
    }),

    tool({
      name: "get_weather_history",
      title: "Historical weather measurements",
      description:
        "Historical measurements from an official SwissMetNet station over a date range (recent weeks). Station codes are 3-letter MeteoSwiss codes, e.g. 'SMA' Zürich-Fluntern, 'BER' Bern, 'GVE' Geneva — see get_current_measurements station IDs. Data is downsampled to stay compact.",
      inputSchema: {
        station_code: z.string().min(3).max(4).describe("SwissMetNet station code, e.g. 'SMA'"),
        date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date YYYY-MM-DD"),
        date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date (default: today)"),
        parameter: z
          .enum(["temperature", "precipitation", "wind", "humidity", "pressure", "sunshine"])
          .default("temperature"),
      },
      handler: async ({ station_code, date_from, date_to, parameter }) => {
        try {
          const PARAM_CODES: Record<string, string> = {
            temperature: "tt",
            precipitation: "rr",
            wind: "ff",
            humidity: "rh",
            pressure: "qff",
            sunshine: "ss",
          };
          const code = PARAM_CODES[parameter] ?? "tt";
          const url = `https://api.existenz.ch/apiv1/smn/daterange?locations=${encodeURIComponent(
            station_code.toUpperCase(),
          )}&startdate=${date_from}&enddate=${date_to ?? new Date().toISOString().slice(0, 10)}`;
          const { data, cacheStatus, retrievedAt } = await fetchJson<{
            payload?: Array<{ timestamp?: number; par?: string; val?: number }>;
          }>(url, { ttlMs: 3600 * 1000, timeoutMs: 45_000 });
          const all = data.payload ?? [];
          const payload = all.filter((p) => p.par === code);
          if (!payload.length) {
            const available = [...new Set(all.map((p) => p.par))].join(", ");
            return toolError(
              `No ${parameter} history for station '${station_code}' in that range.`,
              [
                available
                  ? `The station reports these parameter codes: ${available}.`
                  : "The keyless history feed retains roughly the last few weeks only.",
                "Check the station code against get_current_measurements results.",
              ],
            );
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
              station: station_code.toUpperCase(),
              parameter,
              points: series.length,
              downsampled: step > 1,
              series,
            },
            {
              source: {
                ...meteo,
                notes: "History delivered via api.existenz.ch proxy of the official MeteoSwiss SwissMetNet feed.",
              },
              cacheStatus,
              retrievedAt,
            },
          );
        } catch (err) {
          return errorToResult(err, "SwissMetNet history feed");
        }
      },
    }),

    tool({
      name: "get_pollen",
      title: "Live pollen measurements",
      description:
        "Live hourly pollen concentrations from the official MeteoSwiss pollen monitoring network. Choose a taxon (grasses, birch, ash, alder, hazel, mugwort, ambrosia); optionally sort stations by distance from a point.",
      inputSchema: {
        taxon: z
          .enum(["graeser", "birke", "esche", "erle", "hasel", "beifuss", "ambrosia"])
          .default("graeser")
          .describe("Pollen taxon: graeser=grasses, birke=birch, esche=ash, erle=alder, hasel=hazel, beifuss=mugwort"),
        near_lat: z.number().optional(),
        near_lon: z.number().optional(),
        limit: z.number().int().min(1).max(30).default(10),
      },
      handler: async ({ taxon, near_lat, near_lon, limit }) => {
        try {
          const layer = `ch.meteoschweiz.messwerte-pollen-${taxon}-1h`;
          const url = `https://data.geo.admin.ch/${layer}/${layer}_en.json`;
          const { data, cacheStatus, retrievedAt } = await fetchJson<MeasurementCollection>(url, {
            ttlMs: 1800 * 1000,
          });
          const mapped = (data.features ?? []).map((f) => {
            const [lon, lat] = f.geometry?.coordinates ?? [undefined, undefined];
            return {
              id: f.id,
              name: f.properties?.station_name,
              concentration: f.properties?.value,
              unit: f.properties?.unit ?? "No/m³",
              measured_at: f.properties?.reference_ts,
              wgs84: lat !== undefined && lon !== undefined ? { lat, lon } : undefined,
            };
          });
          if (!mapped.length) {
            return toolError(`No live ${taxon} pollen data right now.`, [
              "Pollen taxa are seasonal — grasses peak May–July, birch March–April, hazel/alder in late winter.",
            ]);
          }
          const near = near_lat !== undefined && near_lon !== undefined ? { lat: near_lat, lon: near_lon } : undefined;
          const stations = byDistance(mapped, near, (s) => s.wgs84);
          return respond(
            { taxon, stations: stations.slice(0, limit) },
            { source: meteo, cacheStatus, retrievedAt, dataAsOf: data.creation_time },
          );
        } catch (err) {
          return errorToResult(err, "MeteoSwiss pollen network");
        }
      },
    }),

    tool({
      name: "list_weather_stations",
      title: "List MeteoSwiss measurement stations",
      description: "List official SwissMetNet stations reporting a given parameter, with coordinates and altitude.",
      inputSchema: {
        parameter: z
          .enum(["temperature", "precipitation", "wind", "humidity", "sunshine"])
          .default("temperature"),
      },
      handler: async ({ parameter }) => {
        try {
          const { data, cacheStatus, retrievedAt } = await fetchMeasurements(parameter);
          const stations = (data.features ?? []).map((f) => {
            const [lon, lat] = f.geometry?.coordinates ?? [undefined, undefined];
            return {
              id: f.id,
              name: f.properties?.station_name,
              altitude_m: f.properties?.altitude,
              wgs84: lat !== undefined && lon !== undefined ? { lat, lon } : undefined,
            };
          });
          return respond(
            { parameter, count: stations.length, stations },
            { source: meteo, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "MeteoSwiss OGD measurements");
        }
      },
    }),
  ],
};
