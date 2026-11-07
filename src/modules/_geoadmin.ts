/**
 * Shared helpers for layers served by the geo.admin.ch MapServer API
 * (find / identify / layer search). Used by dams, traffic and geo.
 */

import { fetchJson, withParams } from "../core/http.js";
import type { CantonCode } from "./_cantons.js";

export const GEOADMIN_API = "https://api3.geo.admin.ch/rest/services/api/MapServer";
export const GEOADMIN_ECH = "https://api3.geo.admin.ch/rest/services/ech/MapServer";

export interface GeoFeature {
  layerBodId?: string;
  featureId?: string | number;
  id?: string | number;
  attributes?: Record<string, unknown>;
  geometry?: { x?: number; y?: number; [k: string]: unknown };
  bbox?: number[];
}

/**
 * `find` on one layer. An empty `searchText` returns every feature of small
 * layers (the dam register has ~200). `contains=false` means exact match.
 */
export async function findFeatures(
  layer: string,
  searchField: string,
  searchText: string,
  opts: { ttlMs: number; contains?: boolean; returnGeometry?: boolean; sr?: number; timeoutMs?: number },
) {
  const url = withParams(`${GEOADMIN_API}/find`, {
    layer,
    searchField,
    searchText,
    contains: opts.contains === false ? false : undefined,
    returnGeometry: opts.returnGeometry ?? false,
    sr: opts.sr ?? 2056,
    lang: "en",
  });
  return fetchJson<{ results?: GeoFeature[] }>(url, { ttlMs: opts.ttlMs, timeoutMs: opts.timeoutMs ?? 30_000 });
}

/**
 * `identify` around an LV95 point with a radius in metres. The extent/display
 * pair makes 1 px = radius/50 m, so a 50 px tolerance ≈ radius (box-shaped buffer).
 */
export async function identifyAround(
  layer: string,
  easting: number,
  northing: number,
  radiusM: number,
  opts: { ttlMs: number; returnGeometry?: boolean },
) {
  const url = withParams(`${GEOADMIN_API}/identify`, {
    geometry: `${Math.round(easting)},${Math.round(northing)}`,
    geometryType: "esriGeometryPoint",
    sr: 2056,
    layers: `all:${layer}`,
    tolerance: 50,
    mapExtent: `${easting - radiusM},${northing - radiusM},${easting + radiusM},${northing + radiusM}`,
    imageDisplay: "100,100,96",
    returnGeometry: opts.returnGeometry ?? true,
    lang: "en",
  });
  return fetchJson<{ results?: GeoFeature[] }>(url, { ttlMs: opts.ttlMs, timeoutMs: 30_000 });
}

/** Canton containing an LV95 point (exact polygon test upstream), or undefined outside CH. */
export async function cantonAt(easting: number, northing: number): Promise<string | undefined> {
  const url = withParams(`${GEOADMIN_API}/identify`, {
    geometry: `${Math.round(easting)},${Math.round(northing)}`,
    geometryType: "esriGeometryPoint",
    sr: 2056,
    layers: "all:ch.swisstopo.swissboundaries3d-kanton-flaeche.fill",
    tolerance: 0,
    returnGeometry: false,
  });
  const { data } = await fetchJson<{ results?: GeoFeature[] }>(url, { ttlMs: 30 * 86_400_000, timeoutMs: 20_000 });
  const ak = data.results?.[0]?.attributes?.["ak"];
  return typeof ak === "string" ? ak : undefined;
}

/**
 * Bounding boxes (LV95, [minE, minN, maxE, maxN]) of the 26 cantons, from
 * swissBOUNDARIES3D. Used as a cheap pre-filter before the exact cantonAt() test.
 */
export const CANTON_BBOX_LV95: Record<CantonCode, [number, number, number, number]> = {
  AG: [2620698, 1221173, 2676827, 1274772],
  AI: [2741442, 1233274, 2764416, 1257039],
  AR: [2732375, 1234615, 2765346, 1259712],
  BE: [2556241, 1130585, 2677745, 1243835],
  BL: [2591443, 1243060, 2639481, 1268190],
  BS: [2608733, 1263185, 2619191, 1272279],
  FR: [2546837, 1143053, 2595531, 1206220],
  GE: [2485410, 1109645, 2512974, 1135578],
  GL: [2709274, 1183890, 2738138, 1225967],
  GR: [2692838, 1114569, 2833858, 1214817],
  JU: [2554671, 1222309, 2609051, 1261608],
  LU: [2630128, 1180568, 2681764, 1237691],
  NE: [2523392, 1188830, 2573336, 1224027],
  NW: [2659304, 1180482, 2686449, 1208075],
  OW: [2646045, 1178345, 2681479, 1203582],
  SG: [2702742, 1193269, 2768769, 1268610],
  SH: [2672515, 1267448, 2707983, 1295934],
  SO: [2592561, 1213703, 2644760, 1261330],
  SZ: [2672167, 1193657, 2718719, 1231067],
  TG: [2692317, 1248320, 2755680, 1283504],
  TI: [2672484, 1075268, 2732913, 1165700],
  UR: [2673345, 1153451, 2715796, 1205339],
  VD: [2494306, 1115149, 2585462, 1204076],
  VS: [2548579, 1078560, 2679787, 1167428],
  ZG: [2672419, 1215061, 2695750, 1233506],
  ZH: [2669245, 1223896, 2716900, 1283343],
};

export function inBbox(e: number, n: number, b: [number, number, number, number]): boolean {
  return e >= b[0] && e <= b[2] && n >= b[1] && n <= b[3];
}

/** Run async work over items with a small concurrency limit. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

export function numOrUndef(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}
