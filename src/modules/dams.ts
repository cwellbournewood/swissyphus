/**
 * Dams module — the ~200 dams under federal supervision (SFOE register,
 * served by geo.admin.ch). Name/reservoir/river search, canton listing,
 * nearby search and full technical details.
 */

import { z } from "zod";
import { withParams } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { lv95ToWgs84, distanceKm } from "../core/coords.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";
import { normalizeText, resolveCanton } from "./_cantons.js";
import {
  CANTON_BBOX_LV95,
  GEOADMIN_API,
  cantonAt,
  findFeatures,
  inBbox,
  mapLimit,
  numOrUndef,
  type GeoFeature,
} from "./_geoadmin.js";

const LAYER = "ch.bfe.stauanlagen-bundesaufsicht";

const source: SourceManifest = {
  id: "sfoe-dams",
  name: "Dams under federal supervision",
  operator: "Swiss Federal Office of Energy (SFOE)",
  url: `https://map.geo.admin.ch/?layers=${LAYER}`,
  licence: "Swiss OGD — free use with attribution (geo.admin.ch terms)",
  attribution: "© SFOE / swisstopo",
  updateFrequency: "irregular (when the register changes)",
  cacheTtlSeconds: 86_400,
};

export interface Dam {
  id: number | string | undefined;
  name: string;
  facility?: string;
  reservoir?: string;
  dam_type?: string;
  purpose?: string;
  height_m?: number;
  crest_length_m?: number;
  crest_level_m_asl?: number;
  reservoir_volume_mio_m3?: number;
  impoundment_level_m_asl?: number;
  storage_level_m?: number;
  construction_year?: number;
  in_operation_since?: string;
  federal_supervision_since?: string;
  lat?: number;
  lon?: number;
  /** LV95, kept for canton tests; not returned to callers. */
  e?: number;
  n?: number;
}

export function mapDam(f: GeoFeature): Dam {
  const a = f.attributes ?? {};
  const s = (k: string) => (typeof a[k] === "string" && a[k] !== "" ? (a[k] as string) : undefined);
  const x = numOrUndef(f.geometry?.x);
  const y = numOrUndef(f.geometry?.y);
  const pos = x !== undefined && y !== undefined ? lv95ToWgs84(x, y) : undefined;
  return {
    id: f.featureId ?? f.id,
    name: s("damname") ?? s("label") ?? "?",
    facility: s("facilityname"),
    reservoir: s("reservoirname"),
    dam_type: s("damtype_en") ?? s("damtype_de"),
    purpose: s("facaim_en") ?? s("facaim_de"),
    height_m: numOrUndef(a["damheight"]),
    crest_length_m: numOrUndef(a["crestlength"]),
    crest_level_m_asl: numOrUndef(a["crestlevel"]),
    reservoir_volume_mio_m3: numOrUndef(a["impoundmentvolume"]),
    impoundment_level_m_asl: numOrUndef(a["impoundmentlevel"]),
    storage_level_m: numOrUndef(a["storagelevel"]),
    construction_year: numOrUndef(a["baujahr"]),
    in_operation_since: s("beginningofoperation"),
    federal_supervision_since: s("startsupervision"),
    lat: pos ? Math.round(pos.lat * 1e5) / 1e5 : undefined,
    lon: pos ? Math.round(pos.lon * 1e5) / 1e5 : undefined,
    e: x,
    n: y,
  };
}

/** Public shape: drop the internal LV95 fields. */
function pub(d: Dam & { distance_km?: number; canton?: string }) {
  const { e: _e, n: _n, ...rest } = d;
  return rest;
}

async function loadDams() {
  const r = await findFeatures(LAYER, "damname", "", {
    ttlMs: source.cacheTtlSeconds * 1000,
    returnGeometry: true,
    timeoutMs: 45_000,
  });
  return { ...r, dams: (r.data.results ?? []).map(mapDam) };
}

/** Diacritic-insensitive match on dam, facility and reservoir names. */
export function matchDams(dams: Dam[], query: string): Dam[] {
  const q = normalizeText(query);
  const scored = dams
    .map((d) => {
      const names = [d.name, d.facility, d.reservoir].filter((x): x is string => !!x).map(normalizeText);
      const score = names.some((n) => n === q) ? 0 : names.some((n) => n.startsWith(q)) ? 1 : names.some((n) => n.includes(q)) ? 2 : -1;
      return { d, score };
    })
    .filter((x) => x.score >= 0);
  scored.sort((a, b) => a.score - b.score || (b.d.height_m ?? 0) - (a.d.height_m ?? 0));
  return scored.map((x) => x.d);
}

export const damsModule: SwissyphusModule = {
  id: "dams",
  emoji: "🏞️",
  title: "Dams & reservoirs",
  description: "The ~200 dams under federal supervision: search, by canton, nearby, technical details",
  sources: [source],
  healthProbes: [
    {
      sourceId: "sfoe-dams",
      url: withParams(`${GEOADMIN_API}/find`, { layer: LAYER, searchField: "damname", searchText: "Dixence", returnGeometry: false }),
    },
  ],
  tools: [
    tool({
      name: "search_dams",
      title: "Search dams",
      description:
        "Search the federal dam register by dam, facility or reservoir name (e.g. 'Grande Dixence', 'Sihlsee'), and/or find dams near a WGS84 point. Returns height, type, purpose, reservoir volume and coordinates. Sorted by match quality then height, or by distance when lat/lon are given.",
      inputSchema: {
        query: z.string().min(2).optional().describe("Name fragment (dam, facility or reservoir); omit to list by size or distance"),
        lat: z.number().min(45.5).max(48).optional(),
        lon: z.number().min(5.5).max(11).optional(),
        radius_km: z.number().min(1).max(200).default(25).describe("Used with lat/lon"),
        limit: z.number().int().min(1).max(50).default(15),
      },
      handler: async ({ query, lat, lon, radius_km, limit }) => {
        if ((lat === undefined) !== (lon === undefined)) return toolError("Pass both lat and lon, or neither.", [], { kind: "invalid_input" });
        try {
          const { dams, cacheStatus, retrievedAt } = await loadDams();
          let list: Array<Dam & { distance_km?: number }> = query ? matchDams(dams, query) : [...dams].sort((a, b) => (b.height_m ?? 0) - (a.height_m ?? 0));
          if (lat !== undefined && lon !== undefined) {
            list = list
              .filter((d) => d.lat !== undefined && d.lon !== undefined)
              .map((d) => ({ ...d, distance_km: Math.round(distanceKm(lat, lon, d.lat!, d.lon!) * 10) / 10 }))
              .filter((d) => d.distance_km! <= radius_km)
              .sort((a, b) => a.distance_km! - b.distance_km!);
          }
          if (!list.length) {
            return toolError(
              query ? `No dam under federal supervision matches '${query}'.` : "No dams within the search radius.",
              ["Try a shorter name fragment or the reservoir name", "Increase radius_km"],
              { kind: "not_found" },
            );
          }
          return respond(
            { register_size: dams.length, match_count: list.length, dams: list.slice(0, limit).map(pub) },
            { source, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "SFOE dam register");
        }
      },
    }),
    tool({
      name: "get_dams_by_canton",
      title: "Dams in a canton",
      description:
        "All dams under federal supervision located in a canton (code or name in any language, e.g. 'VS', 'Wallis', 'Grisons'). Canton membership is tested against the official cantonal boundary. Sorted by height.",
      inputSchema: {
        canton: z.string().min(2).describe("Canton code or name"),
        limit: z.number().int().min(1).max(100).default(50),
      },
      handler: async ({ canton, limit }) => {
        const code = resolveCanton(canton);
        if (!code) return toolError(`Unknown canton '${canton}'.`, ["Use a two-letter code such as VS, GR, BE"], { kind: "invalid_input" });
        try {
          const { dams, cacheStatus, retrievedAt } = await loadDams();
          const bbox = CANTON_BBOX_LV95[code];
          const candidates = dams.filter((d) => d.e !== undefined && d.n !== undefined && inBbox(d.e, d.n, bbox));
          const cantons = await mapLimit(candidates, 6, (d) => cantonAt(d.e!, d.n!).catch(() => undefined));
          const inCanton = candidates.filter((_, i) => cantons[i] === code).sort((a, b) => (b.height_m ?? 0) - (a.height_m ?? 0));
          const unresolved = cantons.filter((c) => c === undefined).length;
          return respond(
            {
              canton: code,
              dam_count: inCanton.length,
              total_reservoir_volume_mio_m3: Math.round(inCanton.reduce((s, d) => s + (d.reservoir_volume_mio_m3 ?? 0), 0) * 10) / 10,
              dams: inCanton.slice(0, limit).map((d) => pub({ ...d, canton: code })),
            },
            {
              source,
              cacheStatus,
              retrievedAt,
              ...(unresolved ? { notes: `${unresolved} border-area dam(s) could not be assigned to a canton and were left out.` } : {}),
            },
          );
        } catch (err) {
          return errorToResult(err, "SFOE dam register");
        }
      },
    }),
    tool({
      name: "get_dam_details",
      title: "Dam details",
      description:
        "Full technical record of one dam: type, purpose, height, crest length and level, reservoir volume, impoundment and storage levels, construction year, operation and supervision dates, coordinates and canton. Look up by exact or partial name, or by the id from search_dams.",
      inputSchema: {
        name: z.string().min(2).optional().describe("Dam, facility or reservoir name"),
        id: z.union([z.number(), z.string()]).optional().describe("Dam id from search_dams"),
      },
      handler: async ({ name, id }) => {
        if (!name && id === undefined) return toolError("Pass a dam name or id.", [], { kind: "invalid_input" });
        try {
          const { dams, cacheStatus, retrievedAt } = await loadDams();
          const dam = id !== undefined ? dams.find((d) => String(d.id) === String(id)) : matchDams(dams, name!)[0];
          if (!dam) return toolError(`No dam found for ${id !== undefined ? `id ${id}` : `'${name}'`}.`, ["Use search_dams to find the exact name"], { kind: "not_found" });
          const canton = dam.e !== undefined && dam.n !== undefined ? await cantonAt(dam.e, dam.n).catch(() => undefined) : undefined;
          return respond(
            { ...pub(dam), canton, map: `https://map.geo.admin.ch/?layers=${LAYER}&E=${dam.e}&N=${dam.n}&zoom=8` },
            { source, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "SFOE dam register");
        }
      },
    }),
  ],
};

