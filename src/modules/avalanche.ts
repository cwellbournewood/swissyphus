/**
 * Avalanche module — WSL Institute for Snow and Avalanche Research SLF.
 * Official avalanche bulletin (CAAML/GeoJSON). Outside the winter season the
 * bulletin is empty — the tools degrade gracefully and say so.
 *
 * Two feature shapes are handled (the live shape needs a canary check):
 *  1. CAAML v6 per-bulletin features: properties carry `bulletinID`,
 *     `regions: [{regionID, name}]`, `dangerRatings: [{mainValue: "considerable",
 *     elevation: {...}, validTimePeriod}]`; one feature covers several regions.
 *  2. The legacy per-region shape (flat properties with a region id/name and
 *     a numeric or word danger rating).
 */

import { z } from "zod";
import { fetchJson } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

const slf: SourceManifest = {
  id: "slf-bulletin",
  name: "SLF Avalanche Bulletin",
  operator: "WSL Institute for Snow and Avalanche Research SLF",
  url: "https://www.slf.ch/en/avalanche-bulletin-and-snow-situation/",
  licence:
    "© SLF/WSL — publicly accessible bulletin; attribution required. Terms for commercial redistribution are not yet confirmed and are to be clarified with SLF.",
  attribution: "© SLF/WSL",
  updateFrequency: "twice daily in winter season; not published in summer",
  cacheTtlSeconds: 1800,
  notes: "Always consult the full official bulletin at slf.ch before any backcountry decision.",
};

const BULLETIN_URL = "https://aws.slf.ch/api/bulletin/caaml/en/geojson";

type Ring = Array<[number, number]>;

export interface BulletinFeature {
  properties?: Record<string, unknown>;
  geometry?: { type?: string; coordinates?: unknown };
}

function pointInRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const pi = ring[i];
    const pj = ring[j];
    if (!pi || !pj) continue;
    const [xi, yi] = pi;
    const [xj, yj] = pj;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Point in a GeoJSON polygon: inside the outer ring and outside every hole. */
export function pointInPolygon(lon: number, lat: number, rings: Ring[]): boolean {
  if (!rings.length || !rings[0] || !pointInRing(lon, lat, rings[0])) return false;
  for (let h = 1; h < rings.length; h++) {
    const hole = rings[h];
    if (hole && pointInRing(lon, lat, hole)) return false;
  }
  return true;
}

export function featureContains(f: BulletinFeature, lat: number, lon: number): boolean {
  const g = f.geometry;
  if (!g?.coordinates || !Array.isArray(g.coordinates)) return false;
  if (g.type === "Polygon") return pointInPolygon(lon, lat, g.coordinates as Ring[]);
  if (g.type === "MultiPolygon") {
    return (g.coordinates as Ring[][]).some((rings) => Array.isArray(rings) && pointInPolygon(lon, lat, rings));
  }
  return false;
}

const DANGER_WORDS: Record<string, number> = {
  low: 1,
  moderate: 2,
  considerable: 3,
  high: 4,
  very_high: 5,
  veryhigh: 5,
  "very high": 5,
};
const LEVEL_WORDS = ["", "low", "moderate", "considerable", "high", "very_high"];

/** EAWS danger level 1–5 from a word ("considerable"), a number, or a numeric string. null for no_rating/no_snow/unknown. */
export function dangerLevel(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5) return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (/^[1-5]$/.test(s)) return Number(s);
    // Some encodings add sub-levels like "3+" or "3-".
    const m = s.match(/^([1-5])[+-]$/);
    if (m) return Number(m[1]);
    return DANGER_WORDS[s] ?? null;
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return dangerLevel(o["mainValue"] ?? o["value"] ?? o["level"]);
  }
  return null;
}

function str(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return undefined;
}

function elevationText(e: unknown): string | undefined {
  if (!e || typeof e !== "object") return str(e);
  const o = e as Record<string, unknown>;
  const lower = str(o["lowerBound"]);
  const upper = str(o["upperBound"]);
  if (lower && upper) return `${lower}–${upper} m`;
  if (lower) return `above ${lower} m`;
  if (upper) return `below ${upper} m`;
  return undefined;
}

export interface BulletinSummary {
  bulletin_id?: string;
  regions: Array<{ id?: string; name?: string }>;
  danger_rating: number | null;
  danger_rating_word?: string;
  danger_breakdown?: Array<{ level: number | null; word?: string; elevation?: string; time_period?: string }>;
  valid_time?: unknown;
  all_properties?: Record<string, unknown>;
}

/** Normalise one feature (either shape) into a bulletin summary. */
export function summarizeFeature(f: BulletinFeature): BulletinSummary {
  const props = f.properties ?? {};
  const keys = Object.keys(props);
  const pick = (...fragments: string[]) => {
    for (const fragment of fragments) {
      const k = keys.find((x) => x.toLowerCase() === fragment) ?? keys.find((x) => x.toLowerCase().includes(fragment));
      if (k !== undefined) return props[k];
    }
    return undefined;
  };

  // Regions: CAAML v6 `regions: [{regionID, name}]`, else a flat id/name.
  let regions: Array<{ id?: string; name?: string }> = [];
  const rawRegions = props["regions"];
  if (Array.isArray(rawRegions)) {
    regions = rawRegions
      .filter((r) => r && typeof r === "object")
      .map((r) => {
        const o = r as Record<string, unknown>;
        return { id: str(o["regionID"] ?? o["regionId"] ?? o["id"]), name: str(o["name"]) };
      });
  } else {
    const id = str(pick("regionid", "region_id"));
    const name = str(pick("regionname", "region_name", "name"));
    if (id || name) regions = [{ id, name }];
  }

  // Danger: CAAML v6 `dangerRatings: [...]`, else a flat rating (number, word or array of words).
  const rawRatings = props["dangerRatings"] ?? pick("dangerratings", "dangerrating", "danger_rating", "maxdanger", "danger");
  let breakdown: BulletinSummary["danger_breakdown"];
  let level: number | null = null;
  if (Array.isArray(rawRatings)) {
    breakdown = rawRatings.map((r) => {
      const lvl = dangerLevel(r);
      const o = r && typeof r === "object" ? (r as Record<string, unknown>) : {};
      return {
        level: lvl,
        word: lvl ? LEVEL_WORDS[lvl] : str(o["mainValue"] ?? r),
        elevation: elevationText(o["elevation"]),
        time_period: str(o["validTimePeriod"]),
      };
    });
    const levels = breakdown.map((b) => b.level).filter((x): x is number => x !== null);
    level = levels.length ? Math.max(...levels) : null;
    if (breakdown.every((b) => !b.elevation && !b.time_period) && breakdown.length <= 1) breakdown = undefined;
  } else {
    level = dangerLevel(rawRatings);
  }

  const summary: BulletinSummary = {
    bulletin_id: str(props["bulletinID"] ?? props["bulletinId"]),
    regions,
    danger_rating: level,
    danger_rating_word: level ? LEVEL_WORDS[level] : undefined,
    ...(breakdown ? { danger_breakdown: breakdown } : {}),
    valid_time: props["validTime"] ?? pick("validtime", "valid"),
  };
  // Only fall back to the raw property bag when every heuristic missed (a
  // CAAML schema change), so a normal bulletin doesn't ship the raw dump.
  const anyPicked = regions.length > 0 || level !== null || summary.valid_time !== undefined || !!summary.bulletin_id;
  return anyPicked ? summary : { ...summary, all_properties: props };
}

/** Count warning regions across features (a per-bulletin feature covers many regions). */
export function countRegions(summaries: BulletinSummary[]): number {
  const ids = new Set<string>();
  let anonymous = 0;
  for (const s of summaries) {
    if (!s.regions.length) anonymous += 1;
    for (const r of s.regions) {
      const key = r.id ?? r.name;
      if (key) ids.add(key);
      else anonymous += 1;
    }
  }
  return ids.size + anonymous;
}

const offSeasonNote =
  "No avalanche bulletin is currently published. SLF publishes bulletins during the winter season (typically November–May); in summer only exceptional situation reports appear.";

async function fetchBulletin() {
  const r = await fetchJson<unknown>(BULLETIN_URL, { ttlMs: slf.cacheTtlSeconds * 1000 });
  const d = r.data as { features?: unknown } | null;
  const features = d && typeof d === "object" && Array.isArray(d.features) ? (d.features as BulletinFeature[]) : undefined;
  return { ...r, features };
}

const formatError = () =>
  toolError(
    "The SLF avalanche bulletin returned an unrecognised format — danger levels could NOT be determined.",
    ["Consult https://www.slf.ch directly for the current bulletin.", "Run check_source_health for source status."],
    { kind: "unavailable" },
  );

export const avalancheModule: SwissyphusModule = {
  id: "avalanche",
  emoji: "🏔️",
  title: "Avalanche (SLF)",
  description: "Official SLF avalanche bulletin: danger levels by warning region",
  sources: [slf],
  healthProbes: [{ sourceId: "slf-bulletin", url: BULLETIN_URL }],
  tools: [
    tool({
      name: "get_avalanche_bulletin",
      title: "Current avalanche bulletin",
      description:
        "The current official SLF avalanche bulletin for Switzerland: danger ratings (EAWS scale 1 low – 5 very high) per bulletin, each listing the warning regions it covers, with elevation/time breakdown where published. Outside winter the bulletin is empty and this tool reports that clearly.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(30).describe("Max bulletins (danger areas) to return"),
      },
      handler: async ({ limit }) => {
        try {
          const { features, cacheStatus, retrievedAt } = await fetchBulletin();
          if (!features) return formatError();
          if (!features.length) {
            return respond(
              { status: "no_bulletin_published", message: offSeasonNote, bulletins: [] },
              { source: slf, cacheStatus, retrievedAt },
            );
          }
          const summaries = features.map(summarizeFeature);
          summaries.sort((a, b) => (b.danger_rating ?? 0) - (a.danger_rating ?? 0));
          return respond(
            {
              status: "bulletin_active",
              bulletin_count: summaries.length,
              region_count: countRegions(summaries),
              max_danger_rating: Math.max(0, ...summaries.map((s) => s.danger_rating ?? 0)) || null,
              bulletins: summaries.slice(0, limit),
              danger_scale: "1=low, 2=moderate, 3=considerable, 4=high, 5=very high (EAWS)",
            },
            { source: slf, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "SLF avalanche bulletin");
        }
      },
    }),

    tool({
      name: "get_avalanche_danger_at",
      title: "Avalanche danger at coordinates",
      description:
        "Avalanche danger level for a specific WGS84 point (e.g. a ski-touring destination), resolved against the SLF warning-region polygons.",
      inputSchema: {
        lat: z.number().min(45.5).max(48).describe("WGS84 latitude"),
        lon: z.number().min(5.5).max(11).describe("WGS84 longitude"),
      },
      handler: async ({ lat, lon }) => {
        try {
          const { features, cacheStatus, retrievedAt } = await fetchBulletin();
          if (!features) return formatError();
          if (!features.length) {
            return respond(
              { status: "no_bulletin_published", message: offSeasonNote, query: { lat, lon } },
              { source: slf, cacheStatus, retrievedAt },
            );
          }
          const hit = features.find((f) => featureContains(f, lat, lon));
          if (!hit) {
            return respond(
              {
                status: "outside_warning_regions",
                message: "The point is not inside any current SLF warning region polygon.",
                query: { lat, lon },
              },
              { source: slf, cacheStatus, retrievedAt },
            );
          }
          return respond(
            { status: "bulletin_active", query: { lat, lon }, bulletin: summarizeFeature(hit) },
            { source: slf, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "SLF avalanche bulletin");
        }
      },
    }),
  ],
};
