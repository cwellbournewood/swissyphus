/**
 * Earthquakes module — Swiss Seismological Service (SED) at ETH Zürich,
 * via the standard FDSN event web service.
 */

import { z } from "zod";
import { fetchTextCached, withParams, SourceError, sourceCache } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";
import { isValidIsoDate } from "./_time.js";

const sed: SourceManifest = {
  id: "sed-fdsn",
  name: "SED — Swiss Seismological Service (FDSN event service)",
  operator: "Swiss Seismological Service at ETH Zürich",
  url: "https://eida.ethz.ch/fdsnws/event/1/",
  licence: "Free scientific/public use with attribution",
  attribution: "© Swiss Seismological Service (SED) at ETH Zürich",
  updateFrequency: "near real-time",
  cacheTtlSeconds: 300,
};

/**
 * SED FDSN event endpoints, tried in order. SED serves the same catalogue on
 * its EIDA node (HTTPS) and on the legacy arclink host. arclink.ethz.ch does
 * not listen on 443 (v0.5.0 switched it to https:// and every call failed
 * with ECONNREFUSED), so it is kept only as a plain-HTTP fallback.
 */
export const SED_BASES = [
  "https://eida.ethz.ch/fdsnws/event/1/query",
  "http://arclink.ethz.ch/fdsnws/event/1/query",
] as const;
const BASE = SED_BASES[0];

/** Index of the endpoint that answered last, so a dead primary is not retried first on every call. */
let preferredBase = 0;

/** A failure that another SED endpoint might not have (transport, 5xx, refused, garbage). */
function isEndpointFailure(err: unknown): boolean {
  if (!(err instanceof SourceError)) return false;
  if (err.status === 204 || err.status === 404 || err.status === 400 || err.status === 413) return false;
  return err.reason !== "http" || (err.status ?? 0) >= 500 || err.status === 403 || err.status === 429;
}

/**
 * GET an FDSN event query (params only, no base) against the SED endpoints,
 * falling over to the next one on transport/5xx failures. "No data" (204/404)
 * and bad-request answers are authoritative and returned/thrown immediately.
 */
export async function sedQuery(
  params: Record<string, string | number | boolean | undefined>,
  opts: { ttlMs: number },
  fetcher: typeof fetchTextCached = fetchTextCached,
): Promise<Awaited<ReturnType<typeof fetchTextCached>>> {
  let lastErr: unknown;
  for (let i = 0; i < SED_BASES.length; i++) {
    const idx = (preferredBase + i) % SED_BASES.length;
    try {
      const r = await fetcher(withParams(SED_BASES[idx]!, params), opts);
      preferredBase = idx;
      return r;
    } catch (err) {
      if (!isEndpointFailure(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Test hook: reset the endpoint preference. */
export function _resetSedPreference() {
  preferredBase = 0;
}

export interface Quake {
  /** Full SED publicID (e.g. smi:ch.ethz.sed/sc25a/Event/2026abcd) — pass it back unchanged. */
  event_id: string;
  /** Last path segment of the publicID, for display. */
  event_id_short: string;
  time: string;
  wgs84: { lat: number; lon: number };
  depth_km: number | null;
  magnitude: number | null;
  magnitude_type: string | null;
  location: string;
  /** Only present when the service returns an EventType column. */
  event_type?: string | null;
}

const STANDARD_COLUMNS = [
  "eventid", "time", "latitude", "longitude", "depth/km", "author", "catalog", "contributor",
  "contributorid", "magtype", "magnitude", "magauthor", "eventlocationname",
];

function numOrNull(s: string | undefined, digits = 1): number | null {
  if (s === undefined || s.trim() === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * Parse FDSN event "text" output. The standard format has 13 pipe-separated
 * columns: EventID|Time|Latitude|Longitude|Depth/km|Author|Catalog|
 * Contributor|ContributorID|MagType|Magnitude|MagAuthor|EventLocationName.
 * SeisComP-based services may append a 14th `EventType` column. The column
 * is read from the `#` header when present (else by position 13) and
 * `event_type` is exposed ONLY when that column actually exists — it is never
 * defaulted, so quarry blasts are not relabelled as earthquakes.
 */
export function parseFdsnText(text: string): Quake[] {
  const allLines = text.split(/\r?\n/);
  const header = allLines.find((l) => l.startsWith("#"));
  let typeIdx = -1;
  if (header) {
    const cols = header.slice(1).split("|").map((c) => c.trim().toLowerCase());
    typeIdx = cols.indexOf("eventtype");
  }
  const quakes: Quake[] = [];
  for (const line of allLines) {
    if (!line.trim() || line.startsWith("#")) continue;
    const p = line.split("|");
    if (p.length < STANDARD_COLUMNS.length) continue;
    // A header is authoritative; without one, a 14th column is EventType.
    const idx = header ? typeIdx : p.length >= 14 ? 13 : -1;
    const lat = Number(p[2]);
    const lon = Number(p[3]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const id = (p[0] ?? "").trim();
    const q: Quake = {
      event_id: id,
      event_id_short: id.split("/").pop() ?? id,
      time: (p[1] ?? "").trim(),
      wgs84: { lat, lon },
      depth_km: numOrNull(p[4]),
      magnitude: numOrNull(p[10]),
      magnitude_type: (p[9] ?? "").trim() || null,
      location: (p[12] ?? "").trim(),
    };
    if (idx >= 0 && idx < p.length) q.event_type = (p[idx] ?? "").trim() || null;
    quakes.push(q);
  }
  return quakes;
}

/** Normalise a date filter to an FDSN time: date-only `to` values cover the whole day. */
export function fdsnTime(date: string, endOfDay: boolean): string {
  return endOfDay ? `${date}T23:59:59` : `${date}T00:00:00`;
}

const isNoData = (err: unknown) => err instanceof SourceError && (err.status === 404 || err.status === 204);

async function fetchEvent(publicId: string) {
  try {
    const r = await sedQuery({ format: "text", eventid: publicId }, { ttlMs: 24 * 3600 * 1000 });
    return { ...r, quake: parseFdsnText(r.data)[0] };
  } catch (err) {
    // FDSN services answer "no such event" with 204/404.
    if (isNoData(err)) return undefined;
    throw err;
  }
}

/**
 * Fallback namespaces tried for a bare (short) event ID. The primary path is
 * the full publicID that get_recent_earthquakes returns; these are only for
 * callers that pass a short ID copied from elsewhere.
 */
const SHORT_ID_NAMESPACES = ["smi:ch.ethz.sed/sc25a/Event/", "smi:ch.ethz.sed/sc20a/Event/", "smi:ch.ethz.sed/Event/"];

export const earthquakesModule: SwissyphusModule = {
  id: "earthquakes",
  emoji: "🌍",
  title: "Earthquakes (SED/ETH)",
  description: "Recent seismic events in and around Switzerland from the national seismic network",
  sources: [sed],
  healthProbes: [{ sourceId: "sed-fdsn", url: `${BASE}?format=text&limit=1&orderby=time` }],
  tools: [
    tool({
      name: "get_recent_earthquakes",
      title: "Recent earthquakes",
      description:
        "The most recent seismic events recorded by the Swiss Seismological Service, newest first. Optionally filter by minimum magnitude. event_type is included only when the service reports it (it may include quarry blasts).",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(15),
        min_magnitude: z.number().min(-1).max(9).optional().describe("Only events at or above this magnitude"),
        days_back: z.number().int().min(1).max(365).default(30).describe("Search window in days"),
      },
      handler: async ({ limit, min_magnitude, days_back }) => {
        try {
          const start = new Date(Date.now() - days_back * 86400_000).toISOString().slice(0, 19);
          const params = {
            format: "text",
            orderby: "time",
            limit,
            minmagnitude: min_magnitude,
            starttime: start,
          };
          let data: string;
          let cacheStatus: Awaited<ReturnType<typeof fetchTextCached>>["cacheStatus"];
          let retrievedAt: string;
          try {
            ({ data, cacheStatus, retrievedAt } = await sedQuery(params, { ...sourceCache(sed) }));
          } catch (err) {
            if (!isNoData(err)) throw err;
            data = "";
            cacheStatus = "miss";
            retrievedAt = new Date().toISOString();
          }
          const quakes = parseFdsnText(data);
          if (!quakes.length) {
            return respond(
              { events: [], message: `No events ≥ M${min_magnitude ?? "any"} in the last ${days_back} days.` },
              { source: sed, cacheStatus, retrievedAt },
            );
          }
          return respond(
            { events: quakes, count: quakes.length },
            { source: sed, cacheStatus, retrievedAt, dataAsOf: quakes[0]?.time },
          );
        } catch (err) {
          return errorToResult(err, "SED FDSN event service");
        }
      },
    }),

    tool({
      name: "get_earthquake_details",
      title: "Details of one seismic event",
      description:
        "Full record for one seismic event by its SED event ID — pass the event_id returned by get_recent_earthquakes unchanged (a full 'smi:ch.ethz.sed/…' ID; a short ID is also accepted on a best-effort basis).",
      inputSchema: {
        event_id: z.string().min(4).max(200).describe("SED event ID, e.g. 'smi:ch.ethz.sed/sc25a/Event/2026nbzmeg'"),
      },
      handler: async ({ event_id }) => {
        try {
          const id = event_id.trim();
          const candidates = id.startsWith("smi:")
            ? [id]
            : /^[A-Za-z0-9_.-]+$/.test(id)
              ? SHORT_ID_NAMESPACES.map((ns) => ns + id)
              : [];
          let found: Awaited<ReturnType<typeof fetchEvent>> = undefined;
          for (const c of candidates) {
            found = await fetchEvent(c);
            if (found?.quake) break;
          }
          if (!found?.quake) {
            return toolError(`Event '${event_id}' not found.`, [
              "Use the full event_id exactly as returned by get_recent_earthquakes (it starts with 'smi:').",
            ]);
          }
          const { quake, cacheStatus, retrievedAt } = found;
          return respond(
            { ...quake, seismo_portal: "https://www.seismo.ethz.ch/" },
            { source: sed, cacheStatus, retrievedAt, dataAsOf: quake.time },
          );
        } catch (err) {
          return errorToResult(err, "SED FDSN event service");
        }
      },
    }),

    tool({
      name: "search_earthquakes",
      title: "Search earthquakes near a location",
      description:
        "Search historical seismic events near a WGS84 point within a radius, with optional date range (inclusive; date_to covers the whole day) and magnitude filter.",
      inputSchema: {
        lat: z.number().min(-90).max(90).describe("WGS84 latitude of search centre"),
        lon: z.number().min(-180).max(180).describe("WGS84 longitude of search centre"),
        radius_km: z.number().min(1).max(300).default(30),
        date_from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Start date YYYY-MM-DD (default: 1 year back)"),
        date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date YYYY-MM-DD (inclusive)"),
        min_magnitude: z.number().min(-1).max(9).optional(),
        limit: z.number().int().min(1).max(200).default(30),
      },
      handler: async ({ lat, lon, radius_km, date_from, date_to, min_magnitude, limit }) => {
        for (const [name, v] of [["date_from", date_from], ["date_to", date_to]] as const) {
          if (v !== undefined && !isValidIsoDate(v)) return toolError(`${name} '${v}' is not a valid calendar date.`);
        }
        if (date_from && date_to && date_from > date_to) {
          return toolError(`date_from (${date_from}) is after date_to (${date_to}).`);
        }
        try {
          const start = date_from
            ? fdsnTime(date_from, false)
            : new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 19);
          const params = {
            format: "text",
            orderby: "time",
            latitude: lat,
            longitude: lon,
            maxradius: radius_km / 111.195,
            starttime: start,
            endtime: date_to ? fdsnTime(date_to, true) : undefined,
            minmagnitude: min_magnitude,
            limit,
          };
          let quakes: Quake[] = [];
          let cacheStatus: Awaited<ReturnType<typeof fetchTextCached>>["cacheStatus"] = "miss";
          let retrievedAt = new Date().toISOString();
          try {
            const r = await sedQuery(params, { ...sourceCache(sed) });
            quakes = parseFdsnText(r.data);
            cacheStatus = r.cacheStatus;
            retrievedAt = r.retrievedAt;
          } catch (err) {
            if (!isNoData(err)) throw err;
          }
          if (!quakes.length) {
            return toolError(
              `No seismic events found within ${radius_km} km of ${lat}, ${lon} for the given filters.`,
              ["Widen the radius or the date range, or lower min_magnitude."],
            );
          }
          return respond({ events: quakes, count: quakes.length }, { source: sed, cacheStatus, retrievedAt });
        } catch (err) {
          return errorToResult(err, "SED FDSN event service");
        }
      },
    }),
  ],
};
