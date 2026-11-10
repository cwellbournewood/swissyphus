/**
 * Load a whole (small) geo.admin.ch point layer once and index it in memory.
 *
 * Some federal layers are registries of a few hundred points (dams under
 * federal supervision, road traffic counting stations). Loading them whole,
 * two paged identify requests over the Swiss extent, lets a tool search,
 * rank and measure distance locally instead of guessing with a map-tolerance
 * buffer. Requests go through the shared fetch layer, so caching, circuit
 * breakers, stale-if-error and provenance all apply.
 */

import { fetchJson, sourceCache, withParams } from "../core/http.js";
import { lv95ToWgs84 } from "../core/coords.js";
import { mapUrl } from "./geodata.js";
import type { CacheStatus, SourceManifest } from "../core/types.js";

/** LV95 envelope covering Switzerland and Liechtenstein with a margin. */
const SWISS_ENVELOPE = "2480000,1070000,2840000,1300000";
const PAGE = 200;
const MAX_PAGES = 10;

export interface LayerPoint {
  id: string;
  lat: number;
  lon: number;
  easting: number;
  northing: number;
  attributes: Record<string, unknown>;
}

interface IdentifyPage {
  results?: Array<{
    id?: string | number;
    featureId?: string | number;
    geometry?: { type?: string; coordinates?: [number, number] };
    attributes?: Record<string, unknown>;
    /** geometryFormat=geojson puts the fields here instead of `attributes`. */
    properties?: Record<string, unknown>;
  }>;
}

export function identifyPageUrl(layer: string, offset: number): string {
  return withParams("https://api3.geo.admin.ch/rest/services/api/MapServer/identify", {
    geometry: SWISS_ENVELOPE,
    geometryType: "esriGeometryEnvelope",
    sr: 2056,
    layers: `all:${layer}`,
    tolerance: 0,
    returnGeometry: true,
    geometryFormat: "geojson",
    limit: PAGE,
    offset,
    lang: "en",
  });
}

export function toPoints(page: IdentifyPage): LayerPoint[] {
  const out: LayerPoint[] = [];
  for (const r of page.results ?? []) {
    const c = r.geometry?.coordinates;
    if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    const [easting, northing] = c;
    const { lat, lon } = lv95ToWgs84(easting, northing);
    out.push({ id: String(r.featureId ?? r.id ?? ""), lat, lon, easting, northing, attributes: r.properties ?? r.attributes ?? {} });
  }
  return out;
}

/** Every feature of a point layer (paged), with the oldest fetch time and the least fresh cache status. */
export async function loadWholeLayer(
  layer: string,
  source: SourceManifest,
): Promise<{ points: LayerPoint[]; cacheStatus: CacheStatus; retrievedAt: string }> {
  const points: LayerPoint[] = [];
  const rank: Record<CacheStatus, number> = { computed: 0, hit: 1, miss: 2, stale: 3 };
  let cacheStatus: CacheStatus = "computed";
  let retrievedAt = new Date().toISOString();
  for (let p = 0; p < MAX_PAGES; p++) {
    const res = await fetchJson<IdentifyPage>(identifyPageUrl(layer, p * PAGE), {
      ...sourceCache(source),
      timeoutMs: 30_000,
      validate: (v) => typeof v === "object" && v !== null && Array.isArray((v as IdentifyPage).results),
    });
    if (rank[res.cacheStatus] > rank[cacheStatus]) cacheStatus = res.cacheStatus;
    if (res.retrievedAt < retrievedAt) retrievedAt = res.retrievedAt;
    const batch = toPoints(res.data);
    points.push(...batch);
    if ((res.data.results ?? []).length < PAGE) break;
  }
  return { points, cacheStatus, retrievedAt };
}

/** Lower-case, strip diacritics and punctuation, for forgiving name matching. */
export function fold(s: unknown): string {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export function mapLink(layer: string, lat: number, lon: number): string {
  return mapUrl([layer], lat, lon);
}
