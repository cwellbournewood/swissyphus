/**
 * Waste module — collection calendars via OpenERZ (open service built on the
 * official ERZ Zürich open data; community-operated, documented as such).
 */

import { z } from "zod";
import { fetchJson, withParams } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

const source: SourceManifest = {
  id: "openerz",
  name: "OpenERZ — waste collection calendar (Zürich region)",
  operator: "Community service (metaodi) on official ERZ Zürich open data",
  url: "https://openerz.metaodi.ch",
  licence: "Open data (source: ERZ Entsorgung + Recycling Zürich); fair use",
  attribution: "Waste calendar data © ERZ Zürich via OpenERZ",
  updateFrequency: "yearly calendar, served live",
  cacheTtlSeconds: 12 * 3600,
  notes: "Currently covers the city of Zürich region. Multi-municipality expansion is on the roadmap (RFP §4.2).",
};

const WASTE_TYPES = [
  "waste", "cardboard", "paper", "organic", "special", "textile", "metal", "cargotram", "etram", "glass", "chipping_service",
] as const;

interface ErzResult {
  _metadata?: { total_count?: number };
  result?: Array<{ date?: string; waste_type?: string; zip?: number; area?: string; station?: string }>;
}

export const wasteModule: SwissyphusModule = {
  id: "waste",
  emoji: "♻️",
  title: "Waste collection (Zürich)",
  description: "Next waste/recycling collection dates by ZIP code (Zürich region)",
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
          const today = new Date().toISOString().slice(0, 10);
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
  ],
};
