/**
 * Waste module — collection calendars via OpenERZ (open service built on the
 * official ERZ Zürich open data; community-operated, documented as such).
 */

import { z } from "zod";
import { fetchJson, withParams } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";
import { swissDate } from "./_time.js";

const source: SourceManifest = {
  id: "openerz",
  name: "OpenERZ — waste collection calendar (Zürich region)",
  operator: "Community service (metaodi) on official ERZ Zürich open data",
  url: "https://openerz.metaodi.ch",
  licence: "Open data (source: ERZ Entsorgung + Recycling Zürich); fair use",
  attribution: "Waste calendar data © ERZ Zürich via OpenERZ",
  updateFrequency: "yearly calendar, served live",
  cacheTtlSeconds: 12 * 3600,
  notes: "OpenERZ covers the city of Zürich, Winterthur and Uster (by ZIP) and Basel-Stadt (by collection area a–?); other municipalities are not yet covered.",
};

const WASTE_TYPES = [
  "waste", "cardboard", "paper", "organic", "special", "textile", "metal", "cargotram", "etram", "glass", "chipping_service",
] as const;

interface ErzResult {
  _metadata?: { total_count?: number };
  result?: Array<{ date?: string; waste_type?: string; zip?: number; area?: string; station?: string }>;
}

/** Group collection rows into a per-day calendar plus a per-type summary. */
export function wasteCalendar(rows: NonNullable<ErzResult["result"]>) {
  const byDay = new Map<string, Set<string>>();
  const byType = new Map<string, { next: string; count: number }>();
  for (const r of rows) {
    if (!r.date || !r.waste_type) continue;
    if (!byDay.has(r.date)) byDay.set(r.date, new Set());
    byDay.get(r.date)!.add(r.waste_type);
    const t = byType.get(r.waste_type);
    if (t) t.count++;
    else byType.set(r.waste_type, { next: r.date, count: 1 });
  }
  return {
    summary: Object.fromEntries([...byType.entries()].sort((a, b) => a[1].next.localeCompare(b[1].next))),
    calendar: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, types]) => ({ date, waste_types: [...types] })),
  };
}

export const wasteModule: SwissyphusModule = {
  id: "waste",
  emoji: "♻️",
  title: "Waste collection",
  description: "Waste/recycling collection dates and calendars: Zürich, Winterthur and Uster by ZIP code, Basel by collection area",
  sources: [source],
  healthProbes: [
    { sourceId: "openerz", url: "https://openerz.metaodi.ch/api/calendar.json?zip=8001&limit=1" },
  ],
  tools: [
    tool({
      name: "get_waste_collection",
      title: "Next waste collection dates",
      description:
        "Upcoming waste and recycling collection dates for a Zürich-region ZIP code. Types: waste (household), cardboard, paper, organic (green), special, textile, metal, cargotram, etram, glass.",
      inputSchema: {
        zip: z.string().regex(/^\d{4}$/).describe("ZIP code in the Zürich region, e.g. '8001'"),
        waste_type: z.enum(WASTE_TYPES).optional().describe("Filter by one waste type"),
        limit: z.number().int().min(1).max(50).default(10),
      },
      handler: async ({ zip, waste_type, limit }) => {
        try {
          // Swiss local date: the UTC date is still "yesterday" for 1–2 h after Swiss midnight.
          const today = swissDate();
          const url = withParams("https://openerz.metaodi.ch/api/calendar.json", {
            zip,
            types: waste_type,
            start: today,
            sort: "date",
            limit,
          });
          const { data, cacheStatus, retrievedAt } = await fetchJson<ErzResult>(url, {
            ttlMs: source.cacheTtlSeconds * 1000,
          });
          const collections = (data.result ?? []).map((r) => ({
            date: r.date,
            waste_type: r.waste_type,
            zip: r.zip,
            area: r.area || undefined,
            station: r.station || undefined,
          }));
          if (!collections.length) {
            return toolError(`No upcoming collections found for ZIP ${zip}.`, [
              "OpenERZ covers the Zürich region; other municipalities are on the roadmap.",
              "Check the ZIP or drop the waste_type filter.",
            ]);
          }
          return respond({ zip, collections }, { source, cacheStatus, retrievedAt });
        } catch (err) {
          return errorToResult(err, "OpenERZ");
        }
      },
    }),

    tool({
      name: "list_waste_types",
      title: "List waste collection types",
      description: "All waste/recycling collection types supported by the waste calendar.",
      inputSchema: {},
      handler: async () => {
        return respond(
          {
            waste_types: [
              { type: "waste", description: "household waste (Kehricht)" },
              { type: "cardboard", description: "cardboard (Karton)" },
              { type: "paper", description: "paper (Papier)" },
              { type: "organic", description: "organic/green waste (Bioabfall)" },
              { type: "special", description: "special/hazardous waste (Sonderabfall)" },
              { type: "textile", description: "textiles" },
              { type: "metal", description: "metal" },
              { type: "cargotram", description: "Cargo-Tram bulky goods stops (Zürich)" },
              { type: "etram", description: "E-Tram electronics disposal stops (Zürich)" },
              { type: "glass", description: "glass collection points" },
              { type: "chipping_service", description: "garden chipping service" },
            ],
          },
          { source, cacheStatus: "computed", retrievedAt: new Date().toISOString() },
        );
      },
    }),
    tool({
      name: "get_waste_calendar",
      title: "Waste collection calendar",
      description:
        "Full collection calendar for the coming weeks, grouped by day, with a per-type summary (next date and number of collections). Zürich, Winterthur and Uster: pass a ZIP code. Basel-Stadt: pass region 'basel' and the collection area letter (see the city's waste plan).",
      inputSchema: {
        zip: z.string().regex(/^\d{4}$/).optional().describe("ZIP code (Zürich, Winterthur, Uster)"),
        region: z.enum(["basel"]).optional().describe("For Basel-Stadt, which uses collection areas instead of ZIP codes"),
        area: z.string().regex(/^[a-z0-9]{1,3}$/i).optional().describe("Basel collection area, e.g. 'a'"),
        days: z.number().int().min(1).max(120).default(30),
      },
      handler: async ({ zip, region, area, days }) => {
        if (!zip && !(region && area)) return toolError("Pass a ZIP code, or region 'basel' with an area.", [], { kind: "invalid_input" });
        try {
          const start = swissDate();
          const end = new Date(Date.parse(`${start}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
          const url = withParams("https://openerz.metaodi.ch/api/calendar.json", {
            zip,
            region: zip ? undefined : region,
            area: zip ? undefined : area?.toLowerCase(),
            start,
            end,
            sort: "date",
            limit: 500,
          });
          const { data, cacheStatus, retrievedAt } = await fetchJson<ErzResult>(url, { ttlMs: source.cacheTtlSeconds * 1000 });
          const rows = data.result ?? [];
          if (!rows.length) return toolError(`No collections scheduled in the next ${days} days for ${zip ? `ZIP ${zip}` : `${region} area ${area}`}.`, ["OpenERZ covers Zürich, Winterthur, Uster and Basel-Stadt"], { kind: "not_found" });
          const areas = [...new Set(rows.map((r) => r.area || ""))].sort((a, b) => a.localeCompare(b, "de", { numeric: true }));
          const calendars = areas.map((a) => ({ area: a || undefined, ...wasteCalendar(rows.filter((r) => (r.area || "") === a)) }));
          return respond(
            {
              location: zip ? { zip, region: (rows[0] as { region?: string }).region } : { region, area },
              from: start,
              to: end,
              ...(calendars.length > 1
                ? { note: `ZIP ${zip} spans ${calendars.length} collection areas with different schedules; find your area on the municipality's waste plan.`, areas: calendars }
                : calendars[0]),
            },
            { source, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "OpenERZ");
        }
      },
    }),
  ],
};
