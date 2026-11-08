/**
 * Dams module — the dams under federal supervision (SFOE), from the
 * geo.admin.ch layer ch.bfe.stauanlagen-bundesaufsicht. The whole register
 * (~225 dams) is loaded once and indexed, so search, ranking and distance are
 * exact and cost no extra upstream requests.
 */

import { z } from "zod";
import { withParams } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { distanceKm } from "../core/coords.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";
import { fold, loadWholeLayer, mapLink, num, type LayerPoint } from "./layerIndex.js";

const LAYER = "ch.bfe.stauanlagen-bundesaufsicht";

const sfoeDams: SourceManifest = {
  id: "sfoe-dams",
  name: "Dams under federal supervision",
  operator: "Swiss Federal Office of Energy (SFOE)",
  url: `https://map.geo.admin.ch/?layers=${LAYER}`,
  licence: "Free use with source attribution (geo.admin.ch / federal geodata terms)",
  attribution: "© SFOE (BFE), via geo.admin.ch",
  updateFrequency: "as the register changes (a few times a year)",
  cacheTtlSeconds: 24 * 3600,
  maxStaleSeconds: 60 * 86_400,
  notes: "Federal register of dams (Stauanlagen) supervised by the SFOE under the Water Retaining Facilities Act. Volumes in millions of m³ (hm³).",
};

export interface Dam {
  id: string;
  name: string;
  reservoir?: string;
  facility?: string;
  type?: string;
  type_de?: string;
  purpose?: string;
  height_m: number | null;
  crest_length_m: number | null;
  crest_level_m_asl: number | null;
  volume_million_m3: number | null;
  max_water_level_m_asl: number | null;
  retention_height_m: number | null;
  built: number | null;
  in_operation_since?: string;
  federal_supervision_since?: string;
  lat: number;
  lon: number;
  map_url: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function mapDam(p: LayerPoint): Dam {
  const a = p.attributes;
  return {
    id: p.id,
    name: str(a["damname"]) ?? str(a["label"]) ?? p.id,
    reservoir: str(a["reservoirname"]),
    facility: str(a["facilityname"]),
    type: str(a["damtype_en"]),
    type_de: str(a["damtype_de"]),
    purpose: str(a["facaim_en"]),
    height_m: num(a["damheight"]),
    crest_length_m: num(a["crestlength"]),
    crest_level_m_asl: num(a["crestlevel"]),
    volume_million_m3: num(a["impoundmentvolume"]),
    max_water_level_m_asl: num(a["impoundmentlevel"]),
    retention_height_m: num(a["storagelevel"]),
    built: num(a["baujahr"]),
    in_operation_since: str(a["beginningofoperation"]),
    federal_supervision_since: str(a["startsupervision"]),
    lat: p.lat,
    lon: p.lon,
    map_url: mapLink(LAYER, p.lat, p.lon),
  };
}

const SORT_KEYS = { height: "height_m", volume: "volume_million_m3", crest_length: "crest_length_m", built: "built" } as const;

export function searchDams(
  dams: Dam[],
  q: { query?: string; purpose?: string; type?: string; sort_by: keyof typeof SORT_KEYS; order: "desc" | "asc" },
): Dam[] {
  const needle = q.query ? fold(q.query) : "";
  const purpose = q.purpose ? fold(q.purpose) : "";
  const type = q.type ? fold(q.type) : "";
  const key = SORT_KEYS[q.sort_by];
  return dams
    .filter((d) => !needle || [d.name, d.reservoir, d.facility].some((s) => fold(s).includes(needle)))
    .filter((d) => !purpose || fold(d.purpose).includes(purpose))
    .filter((d) => !type || fold(d.type).includes(type) || fold(d.type_de).includes(type))
    .sort((x, y) => {
      const a = x[key] ?? (q.order === "desc" ? -Infinity : Infinity);
      const b = y[key] ?? (q.order === "desc" ? -Infinity : Infinity);
      return q.order === "desc" ? b - a : a - b;
    });
}

async function loadDams() {
  const { points, cacheStatus, retrievedAt } = await loadWholeLayer(LAYER, sfoeDams);
  return { dams: points.map(mapDam), cacheStatus, retrievedAt };
}

export const damsModule: SwissyphusModule = {
  id: "dams",
  emoji: "🏞️",
  title: "Dams (SFOE)",
  description:
    "The ~225 dams under federal supervision: search by name or reservoir, rank by height or volume, find dams near a point, with type, purpose, crest, volume and construction data",
  sources: [sfoeDams],
  healthProbes: [{ sourceId: "sfoe-dams", url: withParams(`https://api3.geo.admin.ch/rest/services/api/MapServer/${LAYER}`, { lang: "en" }) }],
  tools: [
    tool({
      name: "search_dams",
      title: "Search and rank Swiss dams",
      description:
        "Search the federal dam register (SFOE, ~225 dams) by dam, reservoir or facility name, purpose (hydroelectricity, flood protection, irrigation, …) or dam type (arch, gravity, embankment, …), ranked by height, volume, crest length or year built. With no filters it ranks all dams, e.g. the tallest or largest. Examples: {query:'Dixence'}, {sort_by:'volume'}, {purpose:'flood'}.",
      inputSchema: {
        query: z.string().max(80).optional().describe("Dam, reservoir or facility name (partial, accents optional)"),
        purpose: z.string().max(40).optional().describe("e.g. hydroelectricity, flood protection, irrigation, drinking water"),
        type: z.string().max(40).optional().describe("e.g. arch, gravity, embankment, buttress"),
        sort_by: z.enum(["height", "volume", "crest_length", "built"]).default("height"),
        order: z.enum(["desc", "asc"]).default("desc"),
        limit: z.number().int().min(1).max(50).default(10),
      },
      handler: async ({ query, purpose, type, sort_by, order, limit }) => {
        try {
          const { dams, cacheStatus, retrievedAt } = await loadDams();
          const hits = searchDams(dams, { query, purpose, type, sort_by, order });
          if (!hits.length) {
            return toolError(`No dam in the federal register matches ${JSON.stringify({ query, purpose, type })}.`, [
              "Try a shorter name or the reservoir name (e.g. 'Dixence', 'Lac de Moiry').",
              "Leave the filters out to rank all ~225 dams.",
            ], { kind: "not_found" });
          }
          return respond(
            { query: { query, purpose, type, sort_by, order }, total_matches: hits.length, register_size: dams.length, dams: hits.slice(0, limit) },
            { source: sfoeDams, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "SFOE dam register");
        }
      },
    }),
    tool({
      name: "get_dams_nearby",
      title: "Dams near a point",
      description:
        "Dams under federal supervision within radius_km of a WGS84 point, nearest first, with exact distances. Example: {lat: 46.08, lon: 7.40, radius_km: 15}.",
      inputSchema: {
        lat: z.number().min(45.5).max(48).describe("WGS84 latitude"),
        lon: z.number().min(5.5).max(11).describe("WGS84 longitude"),
        radius_km: z.number().min(1).max(200).default(25),
        limit: z.number().int().min(1).max(50).default(10),
      },
      handler: async ({ lat, lon, radius_km, limit }) => {
        try {
          const { dams, cacheStatus, retrievedAt } = await loadDams();
          const near = dams
            .map((d) => ({ ...d, distance_km: Math.round(distanceKm(lat, lon, d.lat, d.lon) * 10) / 10 }))
            .filter((d) => d.distance_km <= radius_km)
            .sort((a, b) => a.distance_km - b.distance_km);
          return respond(
            { query: { lat, lon, radius_km }, count: near.length, dams: near.slice(0, limit) },
            { source: sfoeDams, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "SFOE dam register");
        }
      },
    }),
  ],
};
