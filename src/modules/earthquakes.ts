/**
 * Earthquakes module — Swiss Seismological Service (SED) at ETH Zürich,
 * via the standard FDSN event web service.
 */

import { z } from "zod";
import { fetchTextCached, withParams } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

const sed: SourceManifest = {
  id: "sed-fdsn",
  name: "SED — Swiss Seismological Service (FDSN event service)",
  operator: "Swiss Seismological Service at ETH Zürich",
  url: "http://arclink.ethz.ch/fdsnws/event/1/",
  licence: "Free scientific/public use with attribution",
  attribution: "© Swiss Seismological Service (SED) at ETH Zürich",
  updateFrequency: "near real-time",
  cacheTtlSeconds: 300,
};

const BASE = "http://arclink.ethz.ch/fdsnws/event/1/query";

interface Quake {
  event_id: string;
  time: string;
  wgs84: { lat: number; lon: number };
  depth_km: number;
  magnitude: number;
  magnitude_type: string;
  location: string;
  event_type: string;
}

function parseFdsnText(text: string): Quake[] {
  const lines = text.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  const quakes: Quake[] = [];
  for (const line of lines) {
    const p = line.split("|");
    if (p.length < 13) continue;
    quakes.push({
      event_id: (p[0] ?? "").split("/").pop() ?? p[0] ?? "",
      time: p[1] ?? "",
      wgs84: { lat: Number(p[2]), lon: Number(p[3]) },
      depth_km: Math.round(Number(p[4]) * 10) / 10,
      magnitude: Math.round(Number(p[10]) * 10) / 10,
      magnitude_type: p[9] ?? "",
      location: p[12] ?? "",
      event_type: p[13]?.trim() ?? "earthquake",
    });
  }
  return quakes;
}

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
        "The most recent seismic events recorded by the Swiss Seismological Service, newest first. Optionally filter by minimum magnitude.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(15),
        min_magnitude: z.number().min(-1).max(9).optional().describe("Only events at or above this magnitude"),
        days_back: z.number().int().min(1).max(365).default(30).describe("Search window in days"),
      },
      handler: async ({ limit, min_magnitude, days_back }) => {
        try {
          const start = new Date(Date.now() - days_back * 86400_000).toISOString().slice(0, 19);
          const url = withParams(BASE, {
            format: "text",
            orderby: "time",
            limit,
            minmagnitude: min_magnitude,
            starttime: start,
          });
          const { data, cacheStatus, retrievedAt } = await fetchTextCached(url, {
            ttlMs: sed.cacheTtlSeconds * 1000,
          });
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
        "Full record for one seismic event by its SED event ID (the event_id returned by get_recent_earthquakes).",
      inputSchema: {
        event_id: z.string().min(4).describe("SED event ID, e.g. '2026nbzmeg'"),
      },
      handler: async ({ event_id }) => {
        try {
          const full = event_id.startsWith("smi:")
            ? event_id
            : `smi:ch.ethz.sed/sc25a/Event/${event_id}`;
          const url = withParams(BASE, { format: "text", eventid: full });
          const { data, cacheStatus, retrievedAt } = await fetchTextCached(url, {
            ttlMs: 24 * 3600 * 1000,
          });
          const quake = parseFdsnText(data)[0];
          if (!quake) {
            return toolError(`Event '${event_id}' not found.`, [
              "Use the event_id exactly as returned by get_recent_earthquakes.",
            ]);
          }
          return respond(
            {
              ...quake,
              seismo_portal: `http://www.seismoportal.ethz.ch/`,
            },
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
        "Search historical seismic events near a WGS84 point within a radius, with optional date range and magnitude filter.",
      inputSchema: {
        lat: z.number().describe("WGS84 latitude of search centre"),
        lon: z.number().describe("WGS84 longitude of search centre"),
        radius_km: z.number().min(1).max(300).default(30),
        date_from: z.string().optional().describe("Start date YYYY-MM-DD (default: 1 year back)"),
        date_to: z.string().optional().describe("End date YYYY-MM-DD"),
        min_magnitude: z.number().optional(),
        limit: z.number().int().min(1).max(200).default(30),
      },
      handler: async ({ lat, lon, radius_km, date_from, date_to, min_magnitude, limit }) => {
        try {
          const start = date_from ?? new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10);
          const url = withParams(BASE, {
            format: "text",
            orderby: "time",
            latitude: lat,
            longitude: lon,
            maxradius: radius_km / 111,
            starttime: start,
            endtime: date_to,
            minmagnitude: min_magnitude,
            limit,
          });
          const { data, cacheStatus, retrievedAt } = await fetchTextCached(url, {
            ttlMs: sed.cacheTtlSeconds * 1000,
          });
          const quakes = parseFdsnText(data);
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
