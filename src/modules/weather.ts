/**
 * Weather module: MeteoSwiss data.
 *
 * - Local forecast + warnings: the MeteoSwiss **app back-end**
 *   (app-prod-ws.meteoswiss-app.ch, plzDetail). Keyless but undocumented and
 *   NOT an OGD dataset: labelled honestly in its own source manifest below.
 *   Planned: migrate to the MeteoSwiss OGD local-forecast product published on
 *   data.geo.admin.ch (STAC) once it can be verified against the live API.
 * - Live 10-minute station measurements + pollen: MeteoSwiss open government
 *   data published on data.geo.admin.ch (official OGD).
 * - Station history: the api.existenz.ch third-party proxy of the SwissMetNet
 *   feed (credited as such).
 */

import { z } from "zod";
import { fetchJson, sourceCache } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { byDistance, isLikelyLv95, lv95ToWgs84, type Wgs84 } from "../core/coords.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

/** MeteoSwiss OGD on data.geo.admin.ch (measurements, pollen, station lists). */
const meteo: SourceManifest = {
  id: "meteoswiss",
  name: "MeteoSwiss: Federal Office of Meteorology and Climatology (OGD)",
  operator: "MeteoSwiss",
  url: "https://www.meteoswiss.admin.ch",
  licence: "Swiss OGD: free use with attribution",
  attribution: "© MeteoSwiss",
  updateFrequency: "10 min (measurements) / hourly (pollen)",
  cacheTtlSeconds: 600,
};

/**
 * Forecast + warnings come from the MeteoSwiss mobile-app back-end, which is
 * not published as open government data. Do not label it "Swiss OGD".
 */
const meteoApp: SourceManifest = {
  id: "meteoswiss-app",
  name: "MeteoSwiss app service (local forecast & warnings)",
  operator: "MeteoSwiss",
  url: "https://www.meteoswiss.admin.ch",
  licence:
    "Not an OGD dataset: undocumented MeteoSwiss app back-end (app-prod-ws.meteoswiss-app.ch) with no published terms of use; data © MeteoSwiss. Migration to MeteoSwiss OGD local forecasts on data.geo.admin.ch is planned.",
  attribution: "© MeteoSwiss",
  updateFrequency: "multiple daily (forecast) / event-driven (warnings)",
  cacheTtlSeconds: 600,
  // forecast: a few hours old is still useful
  maxStaleSeconds: 6 * 3600,
  notes:
    "Keyless app back-end that may change without notice. For authoritative warnings consult meteoswiss.admin.ch or the official MeteoSwiss app.",
};

/** SwissMetNet history via the third-party api.existenz.ch proxy. */
const existenzSmn: SourceManifest = {
  id: "existenz-smn",
  name: "SwissMetNet station history via api.existenz.ch",
  operator: "MeteoSwiss (data); api.existenz.ch (third-party proxy, not affiliated with MeteoSwiss)",
  url: "https://api.existenz.ch",
  licence:
    "Underlying data: MeteoSwiss OGD: free use with attribution. Delivery: api.existenz.ch, a free third-party service (fair use; see its terms).",
  attribution: "© MeteoSwiss; delivered by api.existenz.ch",
  updateFrequency: "10 min",
  cacheTtlSeconds: 3600,
  // history does not change
  maxStaleSeconds: 7 * 86400,
  notes: "Third-party proxy of the official SwissMetNet feed; retains roughly the last few weeks of data.",
};

// ── Pure helpers (exported for offline unit tests) ─────────────────────────

/**
 * Convert a GeoJSON point coordinate pair to WGS84, whatever CRS it is in.
 * The MeteoSwiss `messwerte-*` files have been reported in LV95 (EPSG:2056);
 * other data.geo.admin.ch exports use WGS84 [lon, lat]. Detect by magnitude
 * rather than assume: LV95 (millions), LV03 (hundreds of thousands), else
 * degrees in [lon, lat] (GeoJSON order) or, defensively, a swapped [lat, lon].
 */
export function pointToWgs84(coords: unknown): Wgs84 | undefined {
  if (!Array.isArray(coords) || coords.length < 2) return undefined;
  const a = Number(coords[0]);
  const b = Number(coords[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  if (isLikelyLv95(a, b)) return lv95ToWgs84(a, b);
  // LV03 = LV95 minus the 2'000'000 / 1'000'000 false offsets.
  if (a > 400_000 && a < 900_000 && b > 0 && b < 400_000) return lv95ToWgs84(a + 2_000_000, b + 1_000_000);
  if (Math.abs(a) > 180 || Math.abs(b) > 180) return undefined; // unknown projected CRS
  // GeoJSON order is [lon, lat]. In Switzerland lon ≈ 5.9–10.5 and lat ≈ 45.8–47.8,
  // so a swapped pair is unambiguous.
  if (a >= 45 && a <= 48.5 && b >= 5 && b <= 11) return { lat: a, lon: b };
  return { lat: b, lon: a };
}

const ZURICH_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Zurich",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** UTC offset of Europe/Zurich in minutes (+60 CET, +120 CEST) at a UTC instant. */
export function zurichOffsetMinutes(utcMs: number): number {
  const secMs = Math.floor(utcMs / 1000) * 1000;
  const p: Record<string, number> = {};
  for (const part of ZURICH_PARTS.formatToParts(new Date(secMs))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const wall = Date.UTC(
    p["year"] ?? 1970,
    (p["month"] ?? 1) - 1,
    p["day"] ?? 1,
    p["hour"] ?? 0,
    p["minute"] ?? 0,
    p["second"] ?? 0,
  );
  return Math.round((wall - secMs) / 60_000);
}

/** Format a UTC instant as local ISO-8601 with the given offset ("2024-03-14T10:12:00+01:00"), or the local date only. */
export function isoWithOffset(utcMs: number, offsetMin: number, keepTime = true): string {
  const local = new Date(utcMs + offsetMin * 60_000).toISOString();
  if (!keepTime) return local.slice(0, 10);
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${local.slice(0, 19)}${sign}${hh}:${mm}`;
}

/** Format a UTC instant in Swiss local time (Europe/Zurich) with its offset. */
export function zurichIso(utcMs: number, keepTime = true): string {
  return isoWithOffset(utcMs, zurichOffsetMinutes(utcMs), keepTime);
}

/**
 * Parse a MeteoSwiss `creation_time` ("dd.mm.yyyy HH:MM", Swiss local wall
 * time) to ISO-8601 with the Europe/Zurich offset. ISO input passes through.
 * Returns undefined when the value can't be understood.
 */
export function parseSwissLocalTime(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.trim();
  const m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) {
    if (/^\d{4}-\d{2}-\d{2}T/.test(t) && !Number.isNaN(Date.parse(t))) return t;
    return undefined;
  }
  const wall = Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  if (Number.isNaN(wall)) return undefined;
  // Wall time → UTC: guess the offset, then re-check once (handles DST edges).
  let off = zurichOffsetMinutes(wall - 60 * 60_000);
  let utc = wall - off * 60_000;
  const off2 = zurichOffsetMinutes(utc);
  if (off2 !== off) {
    off = off2;
    utc = wall - off * 60_000;
  }
  return isoWithOffset(utc, off, true);
}

export type Aggregation = "sum" | "mean";

export interface SeriesPoint {
  time: string | undefined;
  value: number | undefined;
  min?: number;
  max?: number;
}

/**
 * Downsample a time series into at most `maxPoints` buckets of consecutive
 * samples. Accumulating quantities (precipitation, sunshine per interval) are
 * SUMMED per bucket so totals are preserved; instantaneous quantities
 * (temperature, water level, discharge…) are AVERAGED, keeping bucket
 * min/max. Input timestamps are epoch seconds; output is sorted and each
 * bucket is stamped with the time of its first sample.
 */
export function downsampleSeries(
  points: Array<{ timestamp?: number; val?: number | null }>,
  maxPoints: number,
  aggregation: Aggregation,
): { series: SeriesPoint[]; bucket_size: number; downsampled: boolean } {
  const sorted = points
    .filter((p) => typeof p.timestamp === "number" && Number.isFinite(p.timestamp))
    .sort((a, b) => (a.timestamp as number) - (b.timestamp as number));
  const bucket = Math.max(1, Math.ceil(sorted.length / Math.max(1, maxPoints)));
  const series: SeriesPoint[] = [];
  for (let i = 0; i < sorted.length; i += bucket) {
    const chunk = sorted.slice(i, i + bucket);
    const vals = chunk
      .map((p) => p.val)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const time = new Date((chunk[0]?.timestamp as number) * 1000).toISOString();
    if (bucket === 1) {
      series.push({ time, value: vals[0] });
    } else if (!vals.length) {
      series.push({ time, value: undefined });
    } else if (aggregation === "sum") {
      series.push({ time, value: round3(vals.reduce((s, v) => s + v, 0)) });
    } else {
      series.push({
        time,
        value: round3(vals.reduce((s, v) => s + v, 0) / vals.length),
        min: Math.min(...vals),
        max: Math.max(...vals),
      });
    }
  }
  return { series, bucket_size: bucket, downsampled: bucket > 1 };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Both or neither of near_lat/near_lon must be given. */
export function nearPoint(
  near_lat: number | undefined,
  near_lon: number | undefined,
): { ok: true; point: Wgs84 | undefined } | { ok: false } {
  if ((near_lat === undefined) !== (near_lon === undefined)) return { ok: false };
  return {
    ok: true,
    point: near_lat !== undefined && near_lon !== undefined ? { lat: near_lat, lon: near_lon } : undefined,
  };
}

function nearError() {
  return toolError("Pass both near_lat and near_lon (WGS84) to sort by distance, or neither.", [
    "Use geocode to turn a place name into coordinates.",
  ]);
}

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

/**
 * Numeric warnType → hazard. UNVERIFIED: this mapping was reconstructed from
 * the MeteoSwiss app and has not been checked against a published code list.
 * When the payload carries a textual type, that text is preferred (see
 * mapWarnings). Verify against live warnings before relying on it.
 */
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

export interface PlzWarning {
  warnType?: number;
  warnLevel?: number;
  text?: string;
  validFrom?: number;
  validTo?: number;
  /** Textual type fields some payload versions may carry (not confirmed). */
  warnTypeText?: string;
  warnTypeName?: string;
  typeText?: string;
  type?: string | number;
}

interface PlzDetail {
  currentWeather?: { time?: number; temperature?: number; icon?: number };
  forecast?: Array<{
    dayDate?: string;
    iconDay?: number;
    temperatureMax?: number;
    temperatureMin?: number;
    precipitation?: number;
  }>;
  warnings?: PlzWarning[];
}

async function plzDetail(plz: string): Promise<{ data: PlzDetail; cacheStatus: "hit" | "miss" | "stale" | "computed"; retrievedAt: string }> {
  // The MeteoSwiss app API keys locations as PLZ*100 (e.g. Zürich 8001 → 800100).
  const padded = plz.length === 4 ? `${plz}00` : plz;
  return fetchJson<PlzDetail>(`https://app-prod-ws.meteoswiss-app.ch/v1/plzDetail?plz=${padded}`, {
    ...sourceCache(meteoApp),
  });
}

export function mapWarnings(w: PlzWarning[] | undefined) {
  return (w ?? []).map((x) => {
    const textual = [x.warnTypeText, x.warnTypeName, x.typeText, typeof x.type === "string" ? x.type : undefined].find(
      (t) => typeof t === "string" && t.trim(),
    );
    return {
      type: textual ?? WARN_TYPES[x.warnType ?? -1] ?? `type ${x.warnType}`,
      type_code: x.warnType,
      level: x.warnLevel,
      level_meaning: "1=minor, 2=moderate, 3=considerable, 4=high, 5=very high",
      text: x.text,
      valid_from: x.validFrom ? new Date(x.validFrom).toISOString() : undefined,
      valid_to: x.validTo ? new Date(x.validTo).toISOString() : undefined,
    };
  });
}

const MEASUREMENT_LAYERS: Record<string, { layer: string; unit: string }> = {
  temperature: { layer: "ch.meteoschweiz.messwerte-lufttemperatur-10min", unit: "°C" },
  precipitation: { layer: "ch.meteoschweiz.messwerte-niederschlag-10min", unit: "mm/10min" },
  wind: { layer: "ch.meteoschweiz.messwerte-windgeschwindigkeit-kmh-10min", unit: "km/h" },
  humidity: { layer: "ch.meteoschweiz.messwerte-luftfeuchtigkeit-10min", unit: "%" },
  sunshine: { layer: "ch.meteoschweiz.messwerte-sonnenscheindauer-10min", unit: "min/10min" },
};

export interface MeasurementCollection {
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
    geometry?: { coordinates?: unknown };
  }>;
}

/** Map a MeteoSwiss measurement GeoJSON collection to station rows (CRS-safe). */
export function mapMeasurementStations(data: MeasurementCollection, defaultUnit?: string) {
  return (data.features ?? []).map((f) => ({
    id: f.id,
    name: f.properties?.station_name,
    value: f.properties?.value,
    unit: f.properties?.unit ?? defaultUnit,
    altitude_m: f.properties?.altitude,
    measured_at: f.properties?.reference_ts,
    wgs84: pointToWgs84(f.geometry?.coordinates),
  }));
}

async function fetchMeasurements(parameter: string) {
  const cfg = MEASUREMENT_LAYERS[parameter];
  if (!cfg) throw new Error(`Unknown parameter '${parameter}'`);
  const url = `https://data.geo.admin.ch/${cfg.layer}/${cfg.layer}_en.json`;
  return fetchJson<MeasurementCollection>(url, { ...sourceCache(meteo) });
}

/**
 * api.existenz.ch SwissMetNet parameter codes, units (per api.existenz.ch's
 * parameter list: unverified offline) and how to aggregate when downsampling.
 */
export const HISTORY_PARAMS: Record<string, { code: string; unit: string; aggregation: Aggregation }> = {
  temperature: { code: "tt", unit: "°C", aggregation: "mean" },
  precipitation: { code: "rr", unit: "mm per 10 min", aggregation: "sum" },
  wind: { code: "ff", unit: "km/h", aggregation: "mean" },
  humidity: { code: "rh", unit: "%", aggregation: "mean" },
  pressure: { code: "qff", unit: "hPa", aggregation: "mean" },
  sunshine: { code: "ss", unit: "min per 10 min", aggregation: "sum" },
};

/** Build the history result body from an api.existenz.ch payload (pure). */
export function buildHistory(
  payload: Array<{ timestamp?: number; par?: string; val?: number | null }>,
  parameter: string,
  maxPoints = 200,
) {
  const cfg = HISTORY_PARAMS[parameter] ?? HISTORY_PARAMS["temperature"]!;
  const rows = payload.filter((p) => p.par === cfg.code);
  const { series, bucket_size, downsampled } = downsampleSeries(rows, maxPoints, cfg.aggregation);
  const values = rows.map((p) => p.val).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const bucketMinutes = bucket_size * 10;
  return {
    raw_points: rows.length,
    points: series.length,
    downsampled,
    aggregation: downsampled
      ? cfg.aggregation === "sum"
        ? `sum over ${bucketMinutes}-minute buckets (totals preserved)`
        : `mean over ${bucketMinutes}-minute buckets (min/max per bucket included)`
      : "none (raw 10-minute values)",
    unit: downsampled && cfg.aggregation === "sum" ? `${cfg.unit.split(" per ")[0]} per ${bucketMinutes} min` : cfg.unit,
    ...(cfg.aggregation === "sum" && values.length
      ? { total: round3(values.reduce((s, v) => s + v, 0)), total_unit: cfg.unit.split(" per ")[0] }
      : {}),
    series,
  };
}

export const weatherModule: SwissyphusModule = {
  id: "weather",
  emoji: "🌦️",
  title: "Weather (MeteoSwiss)",
  description: "Current conditions, 8-day forecast, official warnings, live station measurements",
  sources: [meteoApp, meteo, existenzSmn],
  healthProbes: [
    { sourceId: "meteoswiss-app", url: "https://app-prod-ws.meteoswiss-app.ch/v1/plzDetail?plz=800100" },
  ],
  tools: [
    tool({
      name: "get_weather",
      title: "Current weather + forecast for a location",
      description:
        "MeteoSwiss current conditions, 8-day forecast and active weather warnings for a Swiss postal code (via the MeteoSwiss app service).",
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
              source: meteoApp,
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
        "Active MeteoSwiss weather warnings (wind, thunderstorms, heat, snow, flood, forest fire…) for a Swiss postal code, with danger levels 1–5 (via the MeteoSwiss app service).",
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
            { source: meteoApp, cacheStatus, retrievedAt },
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
        "Live 10-minute measurements from the official MeteoSwiss (SwissMetNet) station network. Choose a parameter and optionally filter to stations near a point (pass both near_lat and near_lon) or by name.",
      inputSchema: {
        parameter: z
          .enum(["temperature", "precipitation", "wind", "humidity", "sunshine"])
          .describe("Measured parameter"),
        near_lat: z.number().optional().describe("Optional: WGS84 latitude to sort stations by distance (requires near_lon)"),
        near_lon: z.number().optional().describe("Optional: WGS84 longitude (requires near_lat)"),
        station_name: z.string().optional().describe("Optional: filter by station name fragment"),
        limit: z.number().int().min(1).max(50).default(10),
      },
      handler: async ({ parameter, near_lat, near_lon, station_name, limit }) => {
        const near = nearPoint(near_lat, near_lon);
        if (!near.ok) return nearError();
        try {
          const { data, cacheStatus, retrievedAt } = await fetchMeasurements(parameter);
          let stations = mapMeasurementStations(data, MEASUREMENT_LAYERS[parameter]?.unit);
          if (station_name) {
            const q = station_name.toLowerCase();
            stations = stations.filter((s) => (s.name ?? "").toLowerCase().includes(q));
          }
          const sliced = byDistance(stations, near.point, (s) => s.wgs84).slice(0, limit);
          if (!sliced.length) return toolError("No matching stations found.");
          return respond(
            { parameter, stations: sliced, total_stations: stations.length },
            { source: meteo, cacheStatus, retrievedAt, dataAsOf: parseSwissLocalTime(data.creation_time) },
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
        "Historical measurements from an official SwissMetNet station over a date range (recent weeks), delivered via the api.existenz.ch proxy. Station codes are 3-letter MeteoSwiss codes, e.g. 'SMA' Zürich-Fluntern, 'BER' Bern, 'GVE' Geneva; see get_current_measurements station IDs. Long ranges are downsampled: precipitation and sunshine are summed per bucket (totals preserved), other parameters averaged with min/max.",
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
          const url = `https://api.existenz.ch/apiv1/smn/daterange?locations=${encodeURIComponent(
            station_code.toUpperCase(),
          )}&startdate=${date_from}&enddate=${date_to ?? zurichIso(Date.now(), false)}`;
          const { data, cacheStatus, retrievedAt } = await fetchJson<{
            payload?: Array<{ timestamp?: number; par?: string; val?: number }>;
          }>(url, { ...sourceCache(existenzSmn), timeoutMs: 45_000 });
          const all = data.payload ?? [];
          const history = buildHistory(all, parameter);
          if (!history.raw_points) {
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
          return respond(
            { station: station_code.toUpperCase(), parameter, ...history },
            { source: existenzSmn, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "SwissMetNet history feed (api.existenz.ch)");
        }
      },
    }),

    tool({
      name: "get_pollen",
      title: "Live pollen measurements",
      description:
        "Live hourly pollen concentrations from the official MeteoSwiss pollen monitoring network. Choose a taxon (grasses, birch, ash, alder, hazel, mugwort, ambrosia); optionally sort stations by distance from a point (pass both near_lat and near_lon).",
      inputSchema: {
        taxon: z
          .enum(["graeser", "birke", "esche", "erle", "hasel", "beifuss", "ambrosia"])
          .default("graeser")
          .describe("Pollen taxon: graeser=grasses, birke=birch, esche=ash, erle=alder, hasel=hazel, beifuss=mugwort"),
        near_lat: z.number().optional().describe("Optional: WGS84 latitude (requires near_lon)"),
        near_lon: z.number().optional().describe("Optional: WGS84 longitude (requires near_lat)"),
        limit: z.number().int().min(1).max(30).default(10),
      },
      handler: async ({ taxon, near_lat, near_lon, limit }) => {
        const near = nearPoint(near_lat, near_lon);
        if (!near.ok) return nearError();
        try {
          const layer = `ch.meteoschweiz.messwerte-pollen-${taxon}-1h`;
          const url = `https://data.geo.admin.ch/${layer}/${layer}_en.json`;
          const { data, cacheStatus, retrievedAt } = await fetchJson<MeasurementCollection>(url, {
            ttlMs: 1800 * 1000,
          });
          const mapped = mapMeasurementStations(data, "No/m³").map((s) => ({
            id: s.id,
            name: s.name,
            concentration: s.value,
            unit: s.unit,
            measured_at: s.measured_at,
            wgs84: s.wgs84,
          }));
          if (!mapped.length) {
            return toolError(`No live ${taxon} pollen data right now.`, [
              "Pollen taxa are seasonal: grasses peak May–July, birch March–April, hazel/alder in late winter.",
            ]);
          }
          const stations = byDistance(mapped, near.point, (s) => s.wgs84);
          return respond(
            { taxon, stations: stations.slice(0, limit) },
            { source: meteo, cacheStatus, retrievedAt, dataAsOf: parseSwissLocalTime(data.creation_time) },
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
          const stations = mapMeasurementStations(data).map((s) => ({
            id: s.id,
            name: s.name,
            altitude_m: s.altitude_m,
            wgs84: s.wgs84,
          }));
          return respond(
            { parameter, count: stations.length, stations },
            { source: meteo, cacheStatus, retrievedAt, dataAsOf: parseSwissLocalTime(data.creation_time) },
          );
        } catch (err) {
          return errorToResult(err, "MeteoSwiss OGD measurements");
        }
      },
    }),
  ],
};
