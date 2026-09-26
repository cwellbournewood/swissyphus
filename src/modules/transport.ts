/**
 * Public transport module — Swiss timetable, connections, departure boards.
 *
 * Delivery path: transport.opendata.ch (Opendata.ch community API over official
 * SBB/opentransportdata.swiss data). The RFP designates opentransportdata.swiss
 * as the primary for the hosted product (API key, SLA); for the zero-key local
 * server the community API is the documented keyless path — recorded as such
 * in the source manifest.
 */

import { z } from "zod";
import { fetchJson, withParams } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

const source: SourceManifest = {
  id: "transport-opendata",
  name: "Swiss public transport API (transport.opendata.ch)",
  operator: "Opendata.ch (data: SBB / opentransportdata.swiss)",
  url: "https://transport.opendata.ch",
  licence: "Open use, fair-use rate limits (1000 req/day guideline)",
  attribution: "Timetable data © SBB/opentransportdata.swiss via transport.opendata.ch",
  updateFrequency: "real-time",
  cacheTtlSeconds: 30,
  notes:
    "Keyless community delivery path. Hosted/enterprise Swissyphus uses opentransportdata.swiss (GTFS-RT, API key) as primary per RFP §4.1.",
};

const BASE = "https://transport.opendata.ch/v1";

interface Stop {
  station?: { id?: string; name?: string; coordinate?: { x?: number; y?: number } };
  departure?: string;
  arrival?: string;
  platform?: string | null;
  delay?: number | null;
}

interface Connection {
  from?: Stop;
  to?: Stop;
  duration?: string;
  transfers?: number;
  products?: string[];
  sections?: Array<{
    journey?: { category?: string; number?: string; operator?: string; to?: string } | null;
    walk?: { duration?: number | null } | null;
    departure?: Stop;
    arrival?: Stop;
  }>;
}

interface Location {
  id?: string;
  name?: string;
  coordinate?: { x?: number; y?: number };
  distance?: number | null;
  icon?: string;
}

/**
 * Map /locations results to stations. Requests are sent with type=station;
 * as a second line of defence, entries without a station id (addresses, POIs)
 * are dropped. transport.opendata.ch's `coordinate` is WGS84 with x = lat, y = lon.
 */
export function mapStations(list: Location[] | undefined) {
  return (list ?? [])
    .filter((s) => s.id && s.name)
    .map((s) => ({
      id: s.id,
      name: s.name,
      type: s.icon,
      distance_m: s.distance ?? undefined,
      wgs84:
        s.coordinate && typeof s.coordinate.x === "number" && typeof s.coordinate.y === "number"
          ? { lat: s.coordinate.x, lon: s.coordinate.y }
          : undefined,
    }));
}

function compactConnection(c: Connection) {
  return {
    from: c.from?.station?.name,
    departure: c.from?.departure,
    departure_platform: c.from?.platform ?? undefined,
    departure_delay_min: c.from?.delay ?? undefined,
    to: c.to?.station?.name,
    arrival: c.to?.arrival,
    arrival_platform: c.to?.platform ?? undefined,
    duration: c.duration,
    transfers: c.transfers,
    products: c.products,
    legs: (c.sections ?? []).map((s) =>
      s.journey
        ? {
            type: "ride",
            line: `${s.journey.category ?? ""}${s.journey.number ?? ""}`,
            operator: s.journey.operator,
            direction: s.journey.to,
            from: s.departure?.station?.name,
            departure: s.departure?.departure,
            platform: s.departure?.platform ?? undefined,
            to: s.arrival?.station?.name,
            arrival: s.arrival?.arrival,
          }
        : {
            type: "walk",
            from: s.departure?.station?.name,
            to: s.arrival?.station?.name,
            duration_s: s.walk?.duration ?? undefined,
          },
    ),
  };
}

export const transportModule: SwissyphusModule = {
  id: "transport",
  emoji: "🚆",
  title: "Public transport",
  description: "Timetable connections, departure/arrival boards, station search — live SBB data",
  sources: [source],
  healthProbes: [{ sourceId: "transport-opendata", url: `${BASE}/locations?query=Bern` }],
  tools: [
    tool({
      name: "get_connections",
      title: "Find public transport connections",
      description:
        "Find the next train/bus/tram/boat connections between two Swiss stations or addresses, with platforms, delays, transfers and per-leg details.",
      inputSchema: {
        from: z.string().describe("Origin station or address, e.g. 'Zürich HB'"),
        to: z.string().describe("Destination station or address, e.g. 'Lugano'"),
        via: z.string().optional().describe("Optional via station"),
        date: z.string().optional().describe("Date YYYY-MM-DD (default: today)"),
        time: z.string().optional().describe("Time HH:MM (default: now)"),
        is_arrival_time: z.boolean().default(false).describe("If true, date/time is the desired arrival time"),
        limit: z.number().int().min(1).max(6).default(4),
      },
      handler: async ({ from, to, via, date, time, is_arrival_time, limit }) => {
        try {
          const url = withParams(`${BASE}/connections`, {
            from,
            to,
            "via[]": via,
            date,
            time,
            isArrivalTime: is_arrival_time ? 1 : undefined,
            limit,
          });
          const { data, cacheStatus, retrievedAt } = await fetchJson<{ connections?: Connection[] }>(url, {
            ttlMs: source.cacheTtlSeconds * 1000,
          });
          const connections = (data.connections ?? []).map(compactConnection);
          if (!connections.length) {
            return toolError(`No connections found from '${from}' to '${to}'.`, [
              "Check the station spellings with search_stations.",
            ]);
          }
          return respond({ connections }, { source, cacheStatus, retrievedAt });
        } catch (err) {
          return errorToResult(err, "Swiss transport API");
        }
      },
    }),

    tool({
      name: "get_departures",
      title: "Departure board for a station",
      description: "Live departure board for a Swiss public transport station, with delays and platforms.",
      inputSchema: {
        station: z.string().describe("Station name, e.g. 'Basel SBB'"),
        limit: z.number().int().min(1).max(30).default(10),
      },
      handler: async ({ station, limit }) => {
        try {
          const url = withParams(`${BASE}/stationboard`, { station, limit });
          const { data, cacheStatus, retrievedAt } = await fetchJson<{
            station?: { name?: string };
            stationboard?: Array<{
              stop?: { departure?: string; platform?: string | null; delay?: number | null };
              category?: string;
              number?: string;
              to?: string;
              operator?: string;
            }>;
          }>(url, { ttlMs: source.cacheTtlSeconds * 1000 });
          const board = (data.stationboard ?? []).map((e) => ({
            line: `${e.category ?? ""}${e.number ?? ""}`,
            to: e.to,
            departure: e.stop?.departure,
            platform: e.stop?.platform ?? undefined,
            delay_min: e.stop?.delay ?? undefined,
            operator: e.operator,
          }));
          if (!board.length) {
            return toolError(`No departures found for station '${station}'.`, [
              "Check the station name with search_stations.",
            ]);
          }
          return respond({ station: data.station?.name ?? station, departures: board }, { source, cacheStatus, retrievedAt });
        } catch (err) {
          return errorToResult(err, "Swiss transport API");
        }
      },
    }),

    tool({
      name: "get_arrivals",
      title: "Arrival board for a station",
      description: "Live arrival board for a Swiss public transport station.",
      inputSchema: {
        station: z.string().describe("Station name, e.g. 'Bern'"),
        limit: z.number().int().min(1).max(30).default(10),
      },
      handler: async ({ station, limit }) => {
        try {
          const url = withParams(`${BASE}/stationboard`, { station, limit, type: "arrival" });
          const { data, cacheStatus, retrievedAt } = await fetchJson<{
            station?: { name?: string };
            stationboard?: Array<{
              stop?: { arrival?: string; platform?: string | null; delay?: number | null };
              category?: string;
              number?: string;
              to?: string;
              name?: string;
            }>;
          }>(url, { ttlMs: source.cacheTtlSeconds * 1000 });
          const board = (data.stationboard ?? []).map((e) => ({
            line: `${e.category ?? ""}${e.number ?? ""}`,
            arrival: e.stop?.arrival,
            platform: e.stop?.platform ?? undefined,
            delay_min: e.stop?.delay ?? undefined,
          }));
          if (!board.length) {
            return toolError(`No arrivals found for station '${station}'.`, [
              "Check the station name with search_stations.",
            ]);
          }
          return respond({ station: data.station?.name ?? station, arrivals: board }, { source, cacheStatus, retrievedAt });
        } catch (err) {
          return errorToResult(err, "Swiss transport API");
        }
      },
    }),

    tool({
      name: "search_stations",
      title: "Search public transport stations",
      description: "Search Swiss public transport stations and stops by name.",
      inputSchema: {
        query: z.string().min(2).describe("Station name or fragment, e.g. 'Interlaken'"),
        limit: z.number().int().min(1).max(50).default(15),
      },
      handler: async ({ query, limit }) => {
        try {
          const url = withParams(`${BASE}/locations`, { query, type: "station" });
          const { data, cacheStatus, retrievedAt } = await fetchJson<{ stations?: Location[] }>(url, {
            ttlMs: 3600 * 1000,
          });
          const stations = mapStations(data.stations).slice(0, limit).map(({ distance_m: _d, ...s }) => s);
          if (!stations.length) return toolError(`No stations matching '${query}'.`);
          return respond({ stations }, { source, cacheStatus, retrievedAt });
        } catch (err) {
          return errorToResult(err, "Swiss transport API");
        }
      },
    }),

    tool({
      name: "get_nearby_stations",
      title: "Find stations near coordinates",
      description: "Find public transport stations near a WGS84 point, sorted by distance.",
      inputSchema: {
        lat: z.number().describe("WGS84 latitude"),
        lon: z.number().describe("WGS84 longitude"),
        limit: z.number().int().min(1).max(50).default(15),
      },
      handler: async ({ lat, lon, limit }) => {
        try {
          const url = withParams(`${BASE}/locations`, { x: lat, y: lon, type: "station" });
          const { data, cacheStatus, retrievedAt } = await fetchJson<{ stations?: Location[] }>(url, {
            ttlMs: 3600 * 1000,
          });
          const stations = mapStations(data.stations)
            .sort((a, b) => (a.distance_m ?? Infinity) - (b.distance_m ?? Infinity))
            .slice(0, limit)
            .map(({ type: _t, ...s }) => s);
          if (!stations.length) return toolError(`No stations found near ${lat}, ${lon}.`);
          return respond({ stations }, { source, cacheStatus, retrievedAt });
        } catch (err) {
          return errorToResult(err, "Swiss transport API");
        }
      },
    }),
  ],
};
