/**
 * Federal geodata infrastructure — the full geo.admin.ch layer catalogue
 * (~900 map layers served by api3.geo.admin.ch) plus the geo.admin.ch STAC
 * data catalogue on data.geo.admin.ch (downloadable datasets, incl. the
 * MeteoSwiss open-data collections such as `ch.meteoschweiz.ogd-smn`).
 *
 * Complements `geo.ts` (which offers fixed-purpose tools like geocode or
 * get_solar_potential plus a thin identify): here every layer is reachable
 * generically — search the catalogue, inspect a layer's fields, identify at a
 * point / radius / bbox on many layers with per-layer error isolation,
 * attribute search, single-feature fetch, a composite location report, and
 * STAC collection/item/asset access that turns CSV/JSON assets into rows.
 */

import { z } from "zod";
import { allowHosts, fetchCached, fetchJson, withParams, SourceError, TooLargeError } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { wgs84ToLv95, lv95ToWgs84, inSwitzerland, isLikelyLv95 } from "../core/coords.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { CacheStatus, SourceManifest } from "../core/types.js";
import { registerSearcher, type DataHit } from "../core/discovery.js";
import { parseResource, queryRows, type Row, type Table } from "../core/tabular.js";
import { heavyParse } from "../core/limit.js";

allowHosts("api3.geo.admin.ch", "data.geo.admin.ch");

// ── Sources ───────────────────────────────────────────────────────────────

const mapServerSource: SourceManifest = {
  id: "geoadmin-mapserver",
  name: "geo.admin.ch federal geodata layers (api3 REST: SearchServer / MapServer)",
  operator: "Federal Office of Topography swisstopo (on behalf of the federal geodata producers)",
  url: "https://api3.geo.admin.ch/services/sdiservices.html",
  licence: "Free use with source attribution (geo.admin.ch terms of use / OGD); some layers carry their own terms",
  attribution: "© swisstopo / geo.admin.ch and the respective federal data owners (BAFU, BFS, ARE, BFE, BAG, BAKOM, …)",
  updateFrequency: "continuous (varies per layer)",
  cacheTtlSeconds: 3600,
  notes:
    "Identify requests are sent in LV95 (sr=2056, metric) after converting WGS84 input (~1 m accuracy); mapExtent/imageDisplay are " +
    "chosen so that tolerance pixels × pixel size = the requested radius in metres. Layer-level scale limits on the server can hide " +
    "very detailed layers for large radii/bboxes. The location-report layer list is best-effort (layer ids chosen from knowledge of " +
    "the catalogue, not verified live); every layer reports its own status. Layer metadata (abstract, owner) comes from the " +
    "'MapServer?searchText=' layer-metadata endpoint and queryability from 'MapServer/layersConfig'; both are optional enrichments.",
};

const stacSource: SourceManifest = {
  id: "geoadmin-stac",
  name: "geo.admin.ch STAC data catalogue (data.geo.admin.ch)",
  operator: "Federal Office of Topography swisstopo (catalogue); datasets by their federal producers incl. MeteoSwiss",
  url: "https://data.geo.admin.ch/api/stac/v0.9/",
  licence: "Catalogue open; each collection states its own licence (mostly OGD / CC BY 4.0-style free use with attribution)",
  attribution: "© swisstopo / geo.admin.ch and the collection providers",
  updateFrequency: "continuous (MeteoSwiss OGD: 10-minute to yearly files)",
  cacheTtlSeconds: 6 * 3600,
  notes:
    "Uses STAC API v0.9 (/api/stac/v0.9) and falls back to /api/stac/v1 when v0.9 answers 404/410/5xx; which version is live was " +
    "not verifiable offline. Asset sizes are taken from 'file:size' when the catalogue provides it.",
};

const meteoSource: SourceManifest = {
  ...stacSource,
  id: "meteoswiss-ogd",
  name: "MeteoSwiss Open Government Data (via data.geo.admin.ch STAC)",
  operator: "Federal Office of Meteorology and Climatology MeteoSwiss",
  url: "https://opendatadocs.meteoswiss.ch",
  licence: "MeteoSwiss OGD — free use with attribution (CC BY 4.0)",
  attribution: "Source: MeteoSwiss",
  cacheTtlSeconds: 600,
};

const API = "https://api3.geo.admin.ch/rest/services/api";
const STAC_HOST = "data.geo.admin.ch";
export const STAC_BASES = ["https://data.geo.admin.ch/api/stac/v0.9", "https://data.geo.admin.ch/api/stac/v1"] as const;

const MAP_TTL = mapServerSource.cacheTtlSeconds * 1000;
const STAC_TTL = stacSource.cacheTtlSeconds * 1000;
const RESPONSE_BUDGET = 44_000;

const LANGS = ["de", "fr", "it", "rm", "en"] as const;
type Lang = (typeof LANGS)[number];
const langArg = z.enum(LANGS).default("en").describe("Language for labels/attributes: de, fr, it, rm or en (default en)");

// ── Pure helpers (exported for tests) ─────────────────────────────────────

export const LAYER_ID_RE = /^[a-z0-9][a-z0-9_.-]{2,150}$/i;
const FEATURE_ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,80}$/;
const COLLECTION_ID_RE = /^[a-z0-9][a-z0-9_.-]{2,150}$/i;
const ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,200}$/;
const DATETIME_RE = /^[0-9TZtz:.+\-/]{4,60}$/;

export function stripHtml(s: unknown): string {
  return typeof s === "string" ? s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim() : "";
}

export function normLang(lang: string | undefined): Lang {
  return (LANGS as readonly string[]).includes(lang ?? "") ? (lang as Lang) : "en";
}

/** Split, trim, de-duplicate and validate a comma/space separated layer id list. */
export function parseLayerIds(input: string | string[]): { valid: string[]; invalid: string[] } {
  const raw = (Array.isArray(input) ? input : input.split(/[\s,;]+/))
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^all:/, ""));
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const id of raw) {
    if (!LAYER_ID_RE.test(id)) invalid.push(id);
    else if (!valid.includes(id)) valid.push(id);
  }
  return { valid, invalid };
}

/**
 * Check a WGS84 point is inside Switzerland; returns an actionable message
 * (swapped lat/lon, LV95 given as WGS84, foreign point) or undefined when ok.
 */
export function swissPointProblem(lat: number, lon: number): { message: string; suggestions: string[] } | undefined {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { message: "lat/lon must be finite numbers.", suggestions: [] };
  }
  if (inSwitzerland(lat, lon)) return undefined;
  if (inSwitzerland(lon, lat)) {
    return {
      message: `(${lat}, ${lon}) is outside Switzerland, but (${lon}, ${lat}) is inside — latitude and longitude look swapped.`,
      suggestions: [`Retry with lat=${lon}, lon=${lat}.`],
    };
  }
  if (isLikelyLv95(lat, lon) || isLikelyLv95(lon, lat)) {
    return {
      message: "These look like Swiss LV95 coordinates (E 2'xxx'xxx / N 1'xxx'xxx), not WGS84 degrees.",
      suggestions: ["Convert them to WGS84 lat/lon first (e.g. with the coordinate conversion tool), or geocode an address."],
    };
  }
  return {
    message: `(${lat}, ${lon}) is outside Switzerland (lat 45.7–47.9, lon 5.8–10.6). geo.admin.ch layers cover Swiss territory only.`,
    suggestions: ["Use the geocode tool to get Swiss coordinates for an address or place name."],
  };
}

export interface IdentifyWindow {
  /** LV95 "minE,minN,maxE,maxN". */
  mapExtent: string;
  /** "widthPx,heightPx,dpi". */
  imageDisplay: string;
  /** Tolerance in pixels (integer, what the API expects). */
  tolerance: number;
  /** Metres per pixel implied by mapExtent/imageDisplay. */
  pixelSizeM: number;
  /** Effective search radius in metres (= tolerance × pixelSizeM). */
  radiusM: number;
}

/**
 * The identify service interprets `tolerance` in *screen pixels* of a virtual
 * map described by mapExtent + imageDisplay. To make a radius in metres mean
 * what it says, build a square virtual map around the point whose pixel size
 * (metres/pixel) makes `tolerance × pixelSize = radius`, keeping tolerance ≤
 * 100 px. The map is 200 px wide, so the extent (± 100 px) always contains
 * the full search circle. Radius 0 → point-in-polygon at 1 m/px.
 */
export function identifyWindow(easting: number, northing: number, radiusM: number): IdentifyWindow {
  const r = Math.max(0, Number.isFinite(radiusM) ? radiusM : 0);
  const tolerance = r === 0 ? 0 : Math.min(100, Math.max(1, Math.ceil(r)));
  const pixelSizeM = r === 0 ? 1 : r / tolerance;
  const half = 100 * pixelSizeM;
  const f = (n: number) => Math.round(n * 100) / 100;
  return {
    mapExtent: `${f(easting - half)},${f(northing - half)},${f(easting + half)},${f(northing + half)}`,
    imageDisplay: "200,200,96",
    tolerance,
    pixelSizeM: f(pixelSizeM),
    radiusM: f(tolerance * pixelSizeM),
  };
}

/** WGS84 bbox → LV95 envelope + a matching virtual map (≈ ≤ 1000 px on the long side, ≥ 1 m/px). */
export function bboxWindow(bbox: [number, number, number, number]): {
  geometry: string;
  mapExtent: string;
  imageDisplay: string;
  widthM: number;
  heightM: number;
} {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const corners = [
    wgs84ToLv95(minLat, minLon),
    wgs84ToLv95(minLat, maxLon),
    wgs84ToLv95(maxLat, minLon),
    wgs84ToLv95(maxLat, maxLon),
  ];
  const minE = Math.min(...corners.map((c) => c.easting));
  const maxE = Math.max(...corners.map((c) => c.easting));
  const minN = Math.min(...corners.map((c) => c.northing));
  const maxN = Math.max(...corners.map((c) => c.northing));
  const widthM = maxE - minE;
  const heightM = maxN - minN;
  const px = Math.max(1, Math.max(widthM, heightM) / 1000);
  const w = Math.max(1, Math.round(widthM / px));
  const h = Math.max(1, Math.round(heightM / px));
  const env = `${minE},${minN},${maxE},${maxN}`;
  return { geometry: env, mapExtent: env, imageDisplay: `${w},${h},96`, widthM: Math.round(widthM), heightM: Math.round(heightM) };
}

/** Max column filters / selected columns / column-name length accepted by read_geodata_asset. */
const MAX_WHERE_KEYS = 20;
const MAX_SELECTED_COLUMNS = 40;
const MAX_COLUMN_NAME = 200;

/** Drop empty values and truncate long strings so feature attributes stay compact. */
export function compactAttributes(attrs: unknown, maxKeys = 40, maxStr = 300): Record<string, unknown> {
  if (!attrs || typeof attrs !== "object") return {};
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(attrs as Record<string, unknown>)) {
    if (v === null || v === undefined || v === "") continue;
    if (n >= maxKeys) {
      out["_truncated_fields"] = true;
      break;
    }
    if (typeof v === "string") out[k] = v.length > maxStr ? `${v.slice(0, maxStr)}…` : v;
    else if (typeof v === "object") {
      const s = JSON.stringify(v);
      out[k] = s.length > maxStr ? `${s.slice(0, maxStr)}…` : v;
    } else out[k] = v;
    n++;
  }
  return out;
}

/** Compact a returned geometry (LV95 GeoJSON or esriJSON) into one WGS84 anchor point. */
export function geometryAnchor(g: unknown): { type?: string; lat: number; lon: number } | undefined {
  if (!g || typeof g !== "object") return undefined;
  const o = g as Record<string, unknown>;
  let xy: [number, number] | undefined;
  if (typeof o.x === "number" && typeof o.y === "number") xy = [o.x, o.y];
  else {
    let c: unknown = o.coordinates ?? o.rings ?? o.paths ?? o.points;
    while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
    if (Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number") xy = [c[0], c[1]];
  }
  if (!xy) return undefined;
  const type = typeof o.type === "string" ? o.type : o.rings ? "Polygon" : o.paths ? "LineString" : o.x !== undefined ? "Point" : undefined;
  if (isLikelyLv95(xy[0], xy[1])) {
    const w = lv95ToWgs84(xy[0], xy[1]);
    return { type, lat: w.lat, lon: w.lon };
  }
  return { type, lat: xy[1], lon: xy[0] };
}

interface GeoFeature {
  layerBodId?: string;
  layerName?: string;
  featureId?: string | number;
  id?: string | number;
  attributes?: Record<string, unknown>;
  properties?: Record<string, unknown>;
  geometry?: unknown;
}

export function compactFeature(f: GeoFeature, withGeometry = false, maxStr = 300) {
  const anchor = withGeometry ? geometryAnchor(f.geometry) : undefined;
  return {
    layer_id: f.layerBodId,
    layer_name: f.layerName,
    feature_id: f.featureId ?? f.id,
    attributes: compactAttributes(f.attributes ?? f.properties, 40, maxStr),
    ...(anchor ? { location: anchor } : {}),
  };
}

/** Group identify results per requested layer, capped per layer; layers without hits get count 0. */
export function groupByLayer(results: GeoFeature[], requested: string[], perLayer: number, withGeometry = false) {
  const groups = new Map<string, GeoFeature[]>();
  for (const id of requested) groups.set(id, []);
  for (const r of results) {
    const id = r.layerBodId ?? "unknown";
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id)!.push(r);
  }
  return [...groups.entries()].map(([layer_id, feats]) => ({
    layer_id,
    layer_name: feats[0]?.layerName,
    count: feats.length,
    ...(feats.length > perLayer ? { truncated: true } : {}),
    features: feats.slice(0, perLayer).map((f) => {
      const { layer_id: _l, layer_name: _n, ...rest } = compactFeature(f, withGeometry);
      return rest;
    }),
  }));
}

interface LayerSearchResponse {
  results?: Array<{ id?: number | string; weight?: number; attrs?: Record<string, unknown> }>;
}

export function parseLayerSearch(data: LayerSearchResponse) {
  const out: Array<{ layer_id: string; title: string; detail?: string }> = [];
  for (const r of data.results ?? []) {
    const a = r.attrs ?? {};
    const id = [a.layer, a.bodId, a.id].find((v) => typeof v === "string" && LAYER_ID_RE.test(v)) as string | undefined;
    if (!id || out.some((o) => o.layer_id === id)) continue;
    const title = stripHtml(a.title) || stripHtml(a.label) || id;
    const detail = stripHtml(a.detail);
    out.push({ layer_id: id, title, ...(detail && detail !== title ? { detail: detail.slice(0, 200) } : {}) });
  }
  return out;
}

export function mapUrl(layerIds: string[], lat?: number, lon?: number): string {
  const u = new URL("https://map.geo.admin.ch/");
  u.searchParams.set("layers", layerIds.join(","));
  if (lat !== undefined && lon !== undefined) {
    const { easting, northing } = wgs84ToLv95(lat, lon);
    u.searchParams.set("E", String(Math.round(easting)));
    u.searchParams.set("N", String(Math.round(northing)));
    u.searchParams.set("zoom", "10");
  }
  return u.toString();
}

// ── STAC helpers ──────────────────────────────────────────────────────────

interface StacLink {
  rel?: string;
  href?: string;
}
interface StacAsset {
  href?: string;
  type?: string;
  title?: string;
  description?: string;
  "file:size"?: number;
  size?: number;
  created?: string;
  updated?: string;
}
export interface StacCollection {
  id?: string;
  title?: string;
  description?: string;
  license?: string;
  keywords?: string[];
  providers?: Array<{ name?: string; roles?: string[] }>;
  extent?: { spatial?: { bbox?: number[][] }; temporal?: { interval?: Array<Array<string | null>> } };
  created?: string;
  updated?: string;
  assets?: Record<string, StacAsset>;
  links?: StacLink[];
}
interface StacItem {
  id?: string;
  bbox?: number[];
  geometry?: unknown;
  properties?: Record<string, unknown>;
  assets?: Record<string, StacAsset>;
}
interface StacItemsPage {
  type?: string;
  features?: StacItem[];
  links?: StacLink[];
  numberMatched?: number;
  context?: { matched?: number; returned?: number };
}

export function nextLink(links: StacLink[] | undefined): string | undefined {
  return links?.find((l) => l.rel === "next" && typeof l.href === "string")?.href;
}

/** A STAC paging link or asset href must stay on data.geo.admin.ch. */
export function isStacHostUrl(url: string, pathPrefix = "/"): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === STAC_HOST && u.pathname.startsWith(pathPrefix);
  } catch {
    return false;
  }
}

function norm(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/** Keyword filter + rank collections (all query tokens must appear in id/title/description/keywords/providers). */
export function filterCollections(cols: StacCollection[], query: string | undefined): StacCollection[] {
  const tokens = norm(query ?? "").split(/[\s,]+/).filter((t) => t.length > 1);
  if (!tokens.length) return [...cols].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const scored: Array<{ c: StacCollection; s: number }> = [];
  for (const c of cols) {
    const id = norm(c.id ?? "");
    const title = norm(c.title ?? "");
    const rest = norm([c.description ?? "", ...(c.keywords ?? []), ...(c.providers ?? []).map((p) => p.name ?? "")].join(" "));
    let s = 0;
    let all = true;
    for (const t of tokens) {
      const inId = id.includes(t);
      const inTitle = title.includes(t);
      const inRest = rest.includes(t);
      if (!inId && !inTitle && !inRest) {
        all = false;
        break;
      }
      s += (inId ? 3 : 0) + (inTitle ? 3 : 0) + (inRest ? 1 : 0);
    }
    if (all) scored.push({ c, s });
  }
  scored.sort((a, b) => b.s - a.s || String(a.c.id).localeCompare(String(b.c.id)));
  return scored.map((x) => x.c);
}

export function compactCollection(c: StacCollection, descLen = 240) {
  const interval = c.extent?.temporal?.interval?.[0];
  return {
    id: c.id,
    title: c.title,
    description: c.description ? stripHtml(c.description).slice(0, descLen) : undefined,
    license: c.license,
    providers: (c.providers ?? []).map((p) => p.name).filter(Boolean),
    temporal_extent: interval ? { start: interval[0] ?? null, end: interval[1] ?? null } : undefined,
    bbox: c.extent?.spatial?.bbox?.[0],
    updated: c.updated,
  };
}

export function compactAssets(assets: Record<string, StacAsset> | undefined, filter?: string, max = 40) {
  const f = filter ? norm(filter) : undefined;
  const all = Object.entries(assets ?? {}).filter(([k, a]) => !f || norm(`${k} ${a.title ?? ""}`).includes(f));
  return {
    total: all.length,
    assets: all.slice(0, max).map(([key, a]) => {
      const size = a["file:size"] ?? a.size;
      return {
        key,
        href: a.href,
        type: a.type?.split(";")[0],
        ...(typeof size === "number" ? { size_bytes: size } : {}),
        ...(a.title && a.title !== key ? { title: a.title } : {}),
        ...(a.updated ? { updated: a.updated } : {}),
      };
    }),
  };
}

export function compactItem(it: StacItem, assetFilter?: string, maxAssets = 40) {
  const p = it.properties ?? {};
  const anchor = geometryAnchor(it.geometry);
  const { total, assets } = compactAssets(it.assets, assetFilter, maxAssets);
  return {
    id: it.id,
    ...(typeof p.title === "string" ? { title: p.title } : {}),
    datetime: p.datetime ?? null,
    ...(p.start_datetime || p.end_datetime ? { start_datetime: p.start_datetime, end_datetime: p.end_datetime } : {}),
    ...(p.updated ? { updated: p.updated } : {}),
    ...(anchor && anchor.type === "Point" ? { location: { lat: anchor.lat, lon: anchor.lon } } : {}),
    ...(!anchor || anchor.type !== "Point" ? (it.bbox ? { bbox: it.bbox } : {}) : {}),
    asset_count: total,
    assets,
  };
}

/** Tabular format guessed from an asset href / media type, or undefined when not parseable. */
export function tabularFormat(href: string, type?: string): "csv" | "json" | undefined {
  const t = (type ?? "").toLowerCase();
  const path = (() => {
    try {
      return new URL(href).pathname.toLowerCase();
    } catch {
      return href.toLowerCase();
    }
  })();
  if (t.includes("csv") || /\.(csv|txt|tsv)$/.test(path)) return "csv";
  if (t.includes("json") || /\.(geo)?json$/.test(path)) return "json";
  return undefined;
}

/**
 * Shrink a list until the serialized payload fits the response budget. By
 * default the first items are kept; with `keepLast` the last ones are (e.g.
 * the newest rows of a time series read with tail=true).
 */
export function fitToBudget<T>(
  items: T[],
  build: (xs: T[]) => unknown,
  budget = RESPONSE_BUDGET,
  opts: { keepLast?: boolean } = {},
): { data: unknown; dropped: number } {
  const take = (n: number) => (opts.keepLast ? items.slice(items.length - n) : items.slice(0, n));
  let n = items.length;
  let data = build(items);
  while (n > 1 && JSON.stringify(data).length > budget) {
    n = Math.max(1, Math.floor(n * 0.75));
    data = build(take(n));
  }
  return { data, dropped: items.length - n };
}

async function mapLimit<T, R>(xs: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(xs.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, xs.length) }, async () => {
    while (i < xs.length) {
      const idx = i++;
      out[idx] = await fn(xs[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

function worstCache(statuses: CacheStatus[]): CacheStatus {
  if (statuses.includes("miss")) return "miss";
  if (statuses.includes("stale")) return "stale";
  return statuses.length ? statuses[0] : "computed";
}

function describeFailure(err: unknown): string {
  if (err instanceof SourceError) {
    if (err.status === 400 || err.status === 404) return `HTTP ${err.status}: layer unknown, not queryable, or parameter rejected`;
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

// ── geo.admin.ch calls ────────────────────────────────────────────────────

interface IdentifyResponse {
  results?: GeoFeature[];
}

interface IdentifyParams {
  layers: string[];
  lang: Lang;
  point?: { lat: number; lon: number; radiusM: number };
  bbox?: [number, number, number, number];
  returnGeometry?: boolean;
  timeInstant?: number;
  timeoutMs?: number;
}

export function buildIdentifyUrl(p: IdentifyParams): string {
  const common = {
    layers: `all:${p.layers.join(",")}`,
    sr: 2056,
    returnGeometry: p.returnGeometry ?? false,
    ...(p.returnGeometry ? { geometryFormat: "geojson" } : {}),
    lang: p.lang,
    timeInstant: p.timeInstant,
  };
  if (p.bbox) {
    const w = bboxWindow(p.bbox);
    return withParams(`${API}/MapServer/identify`, {
      geometry: w.geometry,
      geometryType: "esriGeometryEnvelope",
      mapExtent: w.mapExtent,
      imageDisplay: w.imageDisplay,
      tolerance: 0,
      ...common,
    });
  }
  const pt = p.point!;
  const { easting, northing } = wgs84ToLv95(pt.lat, pt.lon);
  const w = identifyWindow(easting, northing, pt.radiusM);
  return withParams(`${API}/MapServer/identify`, {
    geometry: `${easting},${northing}`,
    geometryType: "esriGeometryPoint",
    mapExtent: w.mapExtent,
    imageDisplay: w.imageDisplay,
    tolerance: w.tolerance,
    ...common,
  });
}

async function identifyRaw(p: IdentifyParams) {
  return fetchJson<IdentifyResponse>(buildIdentifyUrl(p), { ttlMs: MAP_TTL, timeoutMs: p.timeoutMs });
}

async function searchLayers(query: string, lang: Lang, limit: number) {
  const url = withParams(`${API}/SearchServer`, { searchText: query, type: "layers", lang, limit });
  const res = await fetchJson<LayerSearchResponse>(url, { ttlMs: MAP_TTL });
  return { ...res, layers: parseLayerSearch(res.data).slice(0, limit) };
}

type LayersConfig = Record<string, Record<string, unknown>>;
/**
 * Parsed layersConfig per language (at most one entry per LANGS value). A
 * single-slot memo re-parsed the multi-MB JSON whenever callers alternated
 * languages; the raw text is cached by fetchCached, the parse is memoised here
 * and invalidated when the underlying fetch is refreshed (new retrievedAt).
 */
const layersConfigMemo = new Map<Lang, { retrievedAt: string; data: LayersConfig }>();

async function layersConfig(lang: Lang): Promise<LayersConfig> {
  const url = withParams(`${API}/MapServer/layersConfig`, { lang });
  const res = await fetchCached(url, { ttlMs: 24 * 3600 * 1000, maxBytes: 20 * 1024 * 1024, timeoutMs: 20_000 });
  const memo = layersConfigMemo.get(lang);
  if (memo && memo.retrievedAt === res.retrievedAt) return memo.data;
  const data = JSON.parse(res.data) as LayersConfig;
  layersConfigMemo.set(lang, { retrievedAt: res.retrievedAt, data });
  return data;
}

async function geocodeFirst(address: string) {
  const url = withParams(`${API}/SearchServer`, { searchText: address, type: "locations", limit: 1, sr: 2056 });
  const res = await fetchJson<{ results?: Array<{ attrs?: Record<string, unknown> }> }>(url, { ttlMs: MAP_TTL });
  const a = res.data.results?.[0]?.attrs;
  if (!a) return undefined;
  let lat = typeof a.lat === "number" ? a.lat : undefined;
  let lon = typeof a.lon === "number" ? a.lon : undefined;
  if ((lat === undefined || lon === undefined) && typeof a.y === "number" && typeof a.x === "number") {
    const w = lv95ToWgs84(a.y, a.x);
    lat = w.lat;
    lon = w.lon;
  }
  if (lat === undefined || lon === undefined) return undefined;
  return { label: stripHtml(a.label), lat, lon, cacheStatus: res.cacheStatus, retrievedAt: res.retrievedAt };
}

// ── STAC calls (v0.9 with v1 fallback) ────────────────────────────────────

let stacBaseIdx = 0;
/** Test hook: forget which STAC API version answered last. */
export function resetStacVersion(): void {
  stacBaseIdx = 0;
}
export function currentStacBase(): string {
  return STAC_BASES[stacBaseIdx];
}

async function stacGet<T>(path: string, params: Record<string, string | number | undefined> = {}) {
  let firstErr: unknown;
  for (let i = stacBaseIdx; i < STAC_BASES.length; i++) {
    try {
      const res = await fetchJson<T>(withParams(`${STAC_BASES[i]}${path}`, params), { ttlMs: STAC_TTL });
      stacBaseIdx = i;
      return { ...res, base: STAC_BASES[i] };
    } catch (err) {
      firstErr ??= err;
      const st = err instanceof SourceError ? err.status : undefined;
      // Only fall through to the next API version on "gone / not here / broken";
      // anything else (e.g. 400 bad bbox) is a real answer.
      if (!(st === 404 || st === 410 || (st !== undefined && st >= 500))) throw err;
    }
  }
  throw firstErr;
}

async function stacGetUrl<T>(url: string) {
  return fetchJson<T>(url, { ttlMs: STAC_TTL });
}

const MAX_COLLECTION_PAGES = 12;

async function allCollections() {
  const first = await stacGet<{ collections?: StacCollection[]; links?: StacLink[] }>("/collections", { limit: 100 });
  const cols = [...(first.data.collections ?? [])];
  const statuses: CacheStatus[] = [first.cacheStatus];
  let next = nextLink(first.data.links);
  let pages = 1;
  let truncated = false;
  while (next) {
    if (pages >= MAX_COLLECTION_PAGES) {
      truncated = true;
      break;
    }
    if (!isStacHostUrl(next, "/api/stac/")) break;
    const page = await stacGetUrl<{ collections?: StacCollection[]; links?: StacLink[] }>(next);
    cols.push(...(page.data.collections ?? []));
    statuses.push(page.cacheStatus);
    next = nextLink(page.data.links);
    pages++;
  }
  return { collections: cols, cacheStatus: worstCache(statuses), retrievedAt: first.retrievedAt, base: first.base, truncated };
}

// ── Location report layer set ─────────────────────────────────────────────

export type ReportTopic = "admin" | "buildings" | "mobility" | "noise" | "hazards" | "environment" | "heritage" | "energy";

export interface ReportLayer {
  id: string;
  topic: ReportTopic;
  label: string;
  /** Search radius in metres around the point (0 = point-in-polygon). */
  radiusM: number;
  maxFeatures: number;
  /** How sure we are this layer id exists and is queryable (not verified live). */
  confidence: "high" | "medium";
}

/** Best-effort curated set of high-value federal layers for a location report. */
export const REPORT_LAYERS: ReportLayer[] = [
  { id: "ch.swisstopo.swissboundaries3d-gemeinde-flaeche.fill", topic: "admin", label: "Municipality", radiusM: 0, maxFeatures: 1, confidence: "high" },
  { id: "ch.swisstopo-vd.ortschaftenverzeichnis_plz", topic: "admin", label: "Postal code / locality", radiusM: 0, maxFeatures: 1, confidence: "high" },
  { id: "ch.bfs.gebaeude_wohnungs_register", topic: "buildings", label: "Registered buildings within 25 m (GWR)", radiusM: 25, maxFeatures: 3, confidence: "high" },
  { id: "ch.are.bauzonen", topic: "buildings", label: "Building zone (harmonised cantonal zoning)", radiusM: 0, maxFeatures: 1, confidence: "high" },
  { id: "ch.are.gueteklassen_oev", topic: "mobility", label: "Public transport quality class (ARE)", radiusM: 0, maxFeatures: 1, confidence: "high" },
  { id: "ch.bafu.laerm-strassenlaerm_tag", topic: "noise", label: "Road traffic noise, day", radiusM: 0, maxFeatures: 1, confidence: "high" },
  { id: "ch.bafu.laerm-strassenlaerm_nacht", topic: "noise", label: "Road traffic noise, night", radiusM: 0, maxFeatures: 1, confidence: "high" },
  { id: "ch.bafu.laerm-bahnlaerm_tag", topic: "noise", label: "Railway noise, day", radiusM: 0, maxFeatures: 1, confidence: "high" },
  { id: "ch.bafu.laerm-bahnlaerm_nacht", topic: "noise", label: "Railway noise, night", radiusM: 0, maxFeatures: 1, confidence: "high" },
  { id: "ch.bag.radonkarte", topic: "hazards", label: "Radon probability (FOPH radon map)", radiusM: 0, maxFeatures: 1, confidence: "high" },
  { id: "ch.bafu.gefahren-oberflaechenabfluss", topic: "hazards", label: "Surface runoff (pluvial flooding) hazard", radiusM: 0, maxFeatures: 1, confidence: "medium" },
  { id: "ch.bafu.gefahren-baugrundklassen", topic: "hazards", label: "Seismic subsoil class (earthquake)", radiusM: 0, maxFeatures: 1, confidence: "medium" },
  { id: "ch.bafu.grundwasserschutzzonen", topic: "environment", label: "Groundwater protection zones", radiusM: 0, maxFeatures: 2, confidence: "high" },
  { id: "ch.bav.kataster-belasteter-standorte-oev", topic: "environment", label: "Contaminated sites within 50 m (public transport)", radiusM: 50, maxFeatures: 2, confidence: "medium" },
  { id: "ch.vbs.kataster-belasteter-standorte-militaer", topic: "environment", label: "Contaminated sites within 50 m (military)", radiusM: 50, maxFeatures: 2, confidence: "medium" },
  { id: "ch.bakom.standorte-mobilfunkanlagen", topic: "environment", label: "Mobile network antennas within 300 m", radiusM: 300, maxFeatures: 5, confidence: "high" },
  { id: "ch.bak.bundesinventar-schuetzenswerte-ortsbilder", topic: "heritage", label: "ISOS protected townscape", radiusM: 0, maxFeatures: 1, confidence: "high" },
  { id: "ch.bafu.bundesinventare-bln", topic: "heritage", label: "BLN protected landscape", radiusM: 0, maxFeatures: 1, confidence: "high" },
  { id: "ch.bfe.solarenergie-eignung-daecher", topic: "energy", label: "Roof solar suitability within 10 m (Sonnendach)", radiusM: 10, maxFeatures: 3, confidence: "high" },
  { id: "ch.bfe.thermische-netze", topic: "energy", label: "District heating/cooling networks within 200 m", radiusM: 200, maxFeatures: 2, confidence: "medium" },
];

const REPORT_TOPICS = ["admin", "buildings", "mobility", "noise", "hazards", "environment", "heritage", "energy"] as const;

export async function runReportLayer(
  layer: ReportLayer,
  lat: number,
  lon: number,
  lang: Lang,
): Promise<{
  entry: Record<string, unknown>;
  cacheStatus?: CacheStatus;
}> {
  const base = {
    layer_id: layer.id,
    topic: layer.topic,
    label: layer.label,
    radius_m: layer.radiusM,
    ...(layer.confidence !== "high" ? { id_confidence: layer.confidence } : {}),
  };
  try {
    const res = await identifyRaw({ layers: [layer.id], lang, point: { lat, lon, radiusM: layer.radiusM }, timeoutMs: 8000 });
    const feats = (res.data.results ?? []).filter((r) => !r.layerBodId || r.layerBodId === layer.id);
    return {
      cacheStatus: res.cacheStatus,
      entry: {
        ...base,
        status: feats.length ? "match" : "no_match",
        count: feats.length,
        features: feats.slice(0, layer.maxFeatures).map((f) => ({
          feature_id: f.featureId ?? f.id,
          attributes: compactAttributes(f.attributes ?? f.properties, 25, 160),
        })),
      },
    };
  } catch (err) {
    return { entry: { ...base, status: "error", error: describeFailure(err) } };
  }
}

// ── Discovery searchers ───────────────────────────────────────────────────

registerSearcher({
  catalogue: "geo.admin.ch",
  module: "geodata",
  search: async (query: string, limit: number, lang: string): Promise<DataHit[]> => {
    const { layers } = await searchLayers(query, normLang(lang), Math.min(Math.max(limit, 1), 30));
    return layers.map((l) => ({
      catalogue: "geo.admin.ch",
      id: l.layer_id,
      title: l.title,
      description: l.detail,
      publisher: "geo.admin.ch",
      url: mapUrl([l.layer_id]),
      next: { tool: "get_layer_info", args: { layer_id: l.layer_id } },
    }));
  },
});

registerSearcher({
  catalogue: "geo.admin.ch STAC",
  module: "geodata",
  warm: async () => {
    await allCollections();
  },
  search: async (query: string, limit: number): Promise<DataHit[]> => {
    const { collections } = await allCollections();
    return filterCollections(collections, query)
      .slice(0, limit)
      .filter((c) => typeof c.id === "string")
      .map((c) => ({
        catalogue: "geo.admin.ch STAC",
        id: c.id as string,
        title: c.title ?? (c.id as string),
        description: c.description ? stripHtml(c.description).slice(0, 240) : undefined,
        publisher: (c.providers ?? []).map((p) => p.name).filter(Boolean).join(", ") || undefined,
        url: `https://data.geo.admin.ch/browser/index.html#/collections/${encodeURIComponent(c.id as string)}`,
        next: { tool: "get_geodata_collection_items", args: { collection: c.id } },
      }));
  },
});

// ── Arguments ─────────────────────────────────────────────────────────────

const latArg = z.number().min(-90).max(90).describe("WGS84 latitude, e.g. 46.9480 (Switzerland ≈ 45.8–47.8)");
const lonArg = z.number().min(-180).max(180).describe("WGS84 longitude, e.g. 7.4474 (Switzerland ≈ 5.9–10.5)");
const layerIdArg = z
  .string()
  .regex(LAYER_ID_RE, "Layer ids look like 'ch.bafu.laerm-strassenlaerm_tag'")
  .describe("geo.admin.ch layer id (BOD id), e.g. 'ch.bafu.laerm-strassenlaerm_tag' — find ids with search_map_layers");
const bboxArg = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .describe("WGS84 bbox [minLon, minLat, maxLon, maxLat], e.g. [7.43, 46.94, 7.46, 46.96]");

function layerHttpError(err: unknown, what: string, layerId?: string) {
  if (err instanceof SourceError && (err.status === 400 || err.status === 404)) {
    return toolError(`geo.admin.ch rejected the ${what} request (HTTP ${err.status}).`, [
      layerId ? `Check that '${layerId}' is a valid layer id (search_map_layers) and is queryable (get_layer_info).` : "Check the layer ids with search_map_layers.",
      "Field names are case-sensitive; get_layer_info lists a layer's attribute fields.",
    ]);
  }
  return errorToResult(err, `geo.admin.ch ${what}`);
}

// ── Module ────────────────────────────────────────────────────────────────

export const geodataModule: SwissyphusModule = {
  id: "geodata",
  emoji: "🧭",
  title: "Federal geodata catalogue (geo.admin.ch layers + STAC)",
  description:
    "All ~900 geo.admin.ch map layers (search, metadata, point/radius/bbox identify, attribute search, features, location report) and the data.geo.admin.ch STAC catalogue incl. MeteoSwiss open data files",
  sources: [mapServerSource, stacSource, meteoSource],
  healthProbes: [
    { sourceId: "geoadmin-mapserver", url: `${API}/SearchServer?searchText=wasser&type=layers&limit=1` },
    { sourceId: "geoadmin-stac", url: `${STAC_BASES[0]}/collections?limit=1` },
  ],
  tools: [
    tool({
      name: "search_map_layers",
      title: "Search the geo.admin.ch map layer catalogue",
      description:
        "Full-text search over the ~900 federal map layers on geo.admin.ch (noise, natural hazards, radon, zoning, protected areas, energy, transport, geology, …). Returns layer ids (e.g. 'ch.bafu.laerm-strassenlaerm_tag') with titles. Next: get_layer_info for fields/metadata, or query_layer_at_point to read values at a location. Examples: query='Strassenlärm', 'radon', 'Grundwasserschutz', 'solar', 'Bauzonen'.",
      inputSchema: {
        query: z.string().min(2).max(120).describe("Keywords (any national language or English), e.g. 'noise', 'Hochwasser', 'antennas'"),
        lang: langArg,
        limit: z.number().int().min(1).max(30).default(15).describe("Max layers (default 15, max 30)"),
      },
      handler: async ({ query, lang, limit }) => {
        try {
          const l = normLang(lang);
          const { layers, cacheStatus, retrievedAt } = await searchLayers(query, l, limit);
          if (!layers.length) {
            return toolError(`No geo.admin.ch layers match '${query}'.`, [
              "Try German/French keywords (e.g. 'Lärm', 'bruit', 'Gefahren') or a broader term.",
              "For downloadable datasets (incl. MeteoSwiss), try search_geodata_collections.",
            ]);
          }
          return respond(
            { query, count: layers.length, layers: layers.map((x) => ({ ...x, map_url: mapUrl([x.layer_id]) })) },
            { source: mapServerSource, cacheStatus, retrievedAt, language: l },
          );
        } catch (err) {
          return errorToResult(err, "geo.admin.ch SearchServer (layers)");
        }
      },
    }),

    tool({
      name: "get_layer_info",
      title: "Get a geo.admin.ch layer's fields and metadata",
      description:
        "Describe one geo.admin.ch layer: title, abstract, data owner, whether it is queryable (identify/find work), time-enabled, attribute fields (name/alias/type + sample values) and legend/map links. Use before find_layer_features (to pick a search field) or to interpret query_layer_at_point attributes. Example: layer_id='ch.bag.radonkarte'.",
      inputSchema: { layer_id: layerIdArg, lang: langArg },
      handler: async ({ layer_id, lang }) => {
        const l = normLang(lang);
        const [attrsRes, metaRes, cfgRes] = await Promise.allSettled([
          fetchJson<{ fields?: Array<Record<string, unknown>>; name?: string; layerId?: string }>(
            withParams(`${API}/MapServer/${encodeURIComponent(layer_id)}`, { lang: l }),
            { ttlMs: 24 * 3600 * 1000 },
          ),
          fetchJson<{ layers?: Array<Record<string, unknown>> }>(withParams(`${API}/MapServer`, { searchText: layer_id, lang: l }), {
            ttlMs: 24 * 3600 * 1000,
          }),
          layersConfig(l),
        ]);
        const cfg = cfgRes.status === "fulfilled" ? cfgRes.value[layer_id] : undefined;
        const metaLayer =
          metaRes.status === "fulfilled"
            ? (metaRes.value.data.layers ?? []).find((x) => x.layerBodId === layer_id || x.id === layer_id)
            : undefined;
        const fieldsRaw = attrsRes.status === "fulfilled" ? attrsRes.value.data.fields ?? [] : [];
        if (!cfg && !metaLayer && attrsRes.status === "rejected") {
          const err = attrsRes.reason;
          if (err instanceof SourceError && (err.status === 400 || err.status === 404)) {
            return toolError(`Layer '${layer_id}' was not found on geo.admin.ch.`, [
              "Use search_map_layers to find the exact layer id.",
            ]);
          }
          return errorToResult(err, "geo.admin.ch MapServer");
        }
        const ma = (metaLayer?.attributes ?? {}) as Record<string, unknown>;
        const fields = fieldsRaw.slice(0, 80).map((f) => ({
          name: f.name,
          ...(f.alias && f.alias !== f.name ? { alias: f.alias } : {}),
          type: f.type,
          ...(Array.isArray(f.values) && f.values.length ? { sample_values: f.values.slice(0, 5) } : {}),
        }));
        const queryable =
          typeof cfg?.queryable === "boolean" ? cfg.queryable : fields.length ? true : attrsRes.status === "rejected" ? false : null;
        const data = {
          layer_id,
          title: stripHtml(cfg?.label) || stripHtml(metaLayer?.fullName) || stripHtml(attrsRes.status === "fulfilled" ? attrsRes.value.data.name : "") || layer_id,
          abstract: stripHtml(ma.abstract).slice(0, 1500) || undefined,
          data_owner: stripHtml(ma.dataOwner) || stripHtml(cfg?.attribution) || undefined,
          data_status: ma.dataStatus,
          url_details: ma.urlDetails,
          download_url: ma.downloadUrl,
          queryable,
          time_enabled: typeof cfg?.timeEnabled === "boolean" ? cfg.timeEnabled : undefined,
          time_instants: Array.isArray(cfg?.timestamps) ? (cfg!.timestamps as unknown[]).slice(0, 20) : undefined,
          layer_type: cfg?.type,
          fields,
          ...(fieldsRaw.length > 80 ? { fields_truncated: fieldsRaw.length } : {}),
          legend_url: withParams(`${API}/MapServer/${encodeURIComponent(layer_id)}/legend`, { lang: l }),
          map_url: mapUrl([layer_id]),
          enrichment_status: {
            attributes: attrsRes.status,
            metadata: metaRes.status === "fulfilled" ? (metaLayer ? "fulfilled" : "not_listed") : "rejected",
            layers_config: cfgRes.status === "fulfilled" ? (cfg ? "fulfilled" : "not_listed") : "rejected",
          },
          next:
            queryable === false
              ? "Layer is display-only (not queryable); consider search_geodata_collections for a downloadable dataset with the same id."
              : "Use query_layer_at_point (lat/lon) or find_layer_features (search_field from 'fields').",
        };
        const statuses = [attrsRes, metaRes]
          .filter((r): r is PromiseFulfilledResult<{ cacheStatus: CacheStatus; retrievedAt: string; data: never }> => r.status === "fulfilled")
          .map((r) => r.value.cacheStatus);
        return respond(data, {
          source: mapServerSource,
          cacheStatus: worstCache(statuses),
          retrievedAt: new Date().toISOString(),
          language: l,
        });
      },
    }),

    tool({
      name: "query_layer_at_point",
      title: "Query up to 15 geo.admin.ch layers at a point, radius or bbox",
      description:
        "Read the attributes of any federal map layers at a WGS84 location: point-in-polygon (radius_m=0), everything within a radius in metres (e.g. antennas within 300 m), or everything inside a bbox. Up to 15 layers per call; results grouped per layer, with per-layer errors isolated if a layer id is bad. Examples: layers='ch.bafu.laerm-strassenlaerm_tag,ch.bag.radonkarte', lat=46.948, lon=7.4474; layers='ch.bakom.standorte-mobilfunkanlagen', radius_m=300, return_geometry=true. Use search_map_layers to find layer ids; for a ready-made multi-layer summary use get_location_report.",
      inputSchema: {
        layers: z.string().min(3).describe("Comma-separated layer ids (max 15), e.g. 'ch.bafu.laerm-strassenlaerm_tag,ch.are.bauzonen'"),
        lat: latArg.optional(),
        lon: lonArg.optional(),
        radius_m: z.number().min(0).max(2000).default(0).describe("Search radius in metres around lat/lon (0 = exactly at the point; max 2000)"),
        bbox: bboxArg.optional().describe("Alternative to lat/lon: WGS84 bbox [minLon,minLat,maxLon,maxLat], max ~5 km per side"),
        time_instant: z.number().int().min(1800).max(2100).optional().describe("Year for time-enabled layers (see get_layer_info)"),
        return_geometry: z.boolean().default(false).describe("Include a WGS84 anchor point per feature (useful with radius/bbox)"),
        per_layer_limit: z.number().int().min(1).max(50).default(5).describe("Max features returned per layer (default 5)"),
        lang: langArg,
      },
      handler: async ({ layers, lat, lon, radius_m, bbox, time_instant, return_geometry, per_layer_limit, lang }) => {
        const l = normLang(lang);
        const { valid, invalid } = parseLayerIds(layers);
        if (!valid.length) {
          return toolError("No valid layer ids given.", ["Layer ids look like 'ch.bafu.laerm-strassenlaerm_tag'; use search_map_layers."]);
        }
        if (valid.length > 15) {
          return toolError(`Too many layers (${valid.length}); the maximum is 15 per call.`, ["Split the layers over several calls."]);
        }
        let query: Record<string, unknown>;
        let params: Omit<IdentifyParams, "layers">;
        if (bbox) {
          const [minLon, minLat, maxLon, maxLat] = bbox;
          if (!(minLon < maxLon && minLat < maxLat)) {
            return toolError("bbox must be [minLon, minLat, maxLon, maxLat] with min < max.");
          }
          const p1 = swissPointProblem(minLat, minLon) ?? swissPointProblem(maxLat, maxLon);
          if (p1) return toolError(`bbox: ${p1.message}`, p1.suggestions);
          const w = bboxWindow(bbox);
          if (w.widthM > 5000 || w.heightM > 5000) {
            return toolError(`bbox is ${w.widthM} × ${w.heightM} m; the maximum is 5000 m per side.`, [
              "Use a smaller bbox or a point with radius_m.",
            ]);
          }
          query = { bbox, bbox_size_m: [w.widthM, w.heightM] };
          params = { lang: l, bbox, returnGeometry: return_geometry, timeInstant: time_instant };
        } else {
          if (lat === undefined || lon === undefined) {
            return toolError("Give either lat+lon (optionally radius_m) or bbox.", ["Use geocode to turn an address into lat/lon."]);
          }
          const prob = swissPointProblem(lat, lon);
          if (prob) return toolError(prob.message, prob.suggestions);
          const { easting, northing } = wgs84ToLv95(lat, lon);
          const w = identifyWindow(easting, northing, radius_m);
          query = { lat, lon, lv95: { easting, northing }, radius_m: w.radiusM };
          params = { lang: l, point: { lat, lon, radiusM: radius_m }, returnGeometry: return_geometry, timeInstant: time_instant };
        }
        const statuses: CacheStatus[] = [];
        let retrievedAt = new Date().toISOString();
        let results: GeoFeature[] = [];
        const layerErrors: Record<string, string> = {};
        try {
          const res = await identifyRaw({ ...params, layers: valid });
          results = res.data.results ?? [];
          statuses.push(res.cacheStatus);
          retrievedAt = res.retrievedAt;
        } catch (err) {
          const isParamErr = err instanceof SourceError && (err.status === 400 || err.status === 404);
          if (!isParamErr) return errorToResult(err, "geo.admin.ch identify");
          if (valid.length === 1) return layerHttpError(err, "identify", valid[0]);
          // One bad layer id poisons a combined request: retry each layer on its own.
          const per = await mapLimit(valid, 5, async (id) => {
            try {
              const r = await identifyRaw({ ...params, layers: [id] });
              return { id, r };
            } catch (e) {
              return { id, e };
            }
          });
          for (const p of per) {
            if ("r" in p && p.r) {
              results.push(...(p.r.data.results ?? []));
              statuses.push(p.r.cacheStatus);
            } else layerErrors[p.id] = describeFailure(p.e);
          }
          if (Object.keys(layerErrors).length === valid.length) {
            return toolError("geo.admin.ch rejected every requested layer.", [
              "Check the ids with search_map_layers; display-only layers cannot be queried (get_layer_info shows 'queryable').",
            ]);
          }
        }
        const grouped = groupByLayer(results, valid, per_layer_limit, return_geometry).map((g) =>
          layerErrors[g.layer_id] ? { ...g, status: "error", error: layerErrors[g.layer_id] } : { ...g, status: g.count ? "match" : "no_match" },
        );
        const { data, dropped } = fitToBudget(grouped, (gs) => ({
          query,
          layers_requested: valid,
          ...(invalid.length ? { ignored_invalid_ids: invalid } : {}),
          total_features: results.length,
          layers: gs,
        }));
        return respond(data, {
          source: mapServerSource,
          cacheStatus: worstCache(statuses),
          retrievedAt,
          language: l,
          links: { map: mapUrl(valid, lat ?? (bbox ? (bbox[1] + bbox[3]) / 2 : undefined), lon ?? (bbox ? (bbox[0] + bbox[2]) / 2 : undefined)) },
          notes: dropped
            ? `${dropped} layer group(s) omitted to stay under the response size cap; lower per_layer_limit.`
            : "The server may cap the number of features per request; narrow the radius/bbox if counts look capped.",
        });
      },
    }),

    tool({
      name: "find_layer_features",
      title: "Search a geo.admin.ch layer by attribute value",
      description:
        "Attribute search within one geo.admin.ch layer (MapServer/find): returns features whose field contains (or equals) the text. Examples: layer_id='ch.bfs.gebaeude_wohnungs_register', search_field='egid', search_text='1231641', contains=false; layer_id='ch.bafu.bundesinventare-bln', search_field='bln_name', search_text='Aletsch'. Use get_layer_info to see field names.",
      inputSchema: {
        layer_id: layerIdArg,
        search_field: z.string().regex(FIELD_RE, "Field names are identifiers like 'egid' or 'gemname'").describe("Attribute field to search (see get_layer_info 'fields')"),
        search_text: z.string().min(1).max(200).describe("Value or substring to look for"),
        contains: z.boolean().default(true).describe("true = substring match (default), false = exact match"),
        limit: z.number().int().min(1).max(50).default(10).describe("Max features (default 10)"),
        lang: langArg,
      },
      handler: async ({ layer_id, search_field, search_text, contains, limit, lang }) => {
        const l = normLang(lang);
        try {
          const url = withParams(`${API}/MapServer/find`, {
            layer: layer_id,
            searchText: search_text,
            searchField: search_field,
            contains,
            returnGeometry: false,
            lang: l,
          });
          const { data, cacheStatus, retrievedAt } = await fetchJson<IdentifyResponse>(url, { ttlMs: MAP_TTL, timeoutMs: 20_000 });
          const all = data.results ?? [];
          if (!all.length) {
            return toolError(`No features in '${layer_id}' where ${search_field} ${contains ? "contains" : "equals"} '${search_text}'.`, [
              contains ? "Try a shorter substring or a different field." : "Retry with contains=true.",
              "get_layer_info lists the layer's fields and sample values.",
            ]);
          }
          const { data: out, dropped } = fitToBudget(all.slice(0, limit), (xs) => ({
            layer_id,
            search: { field: search_field, text: search_text, contains },
            total_found: all.length,
            features: xs.map((f) => {
              const { layer_id: _l, ...rest } = compactFeature(f);
              return rest;
            }),
          }));
          return respond(out, {
            source: mapServerSource,
            cacheStatus,
            retrievedAt,
            language: l,
            ...(dropped ? { notes: `${dropped} feature(s) omitted to stay under the response size cap.` } : {}),
          });
        } catch (err) {
          return layerHttpError(err, "find", layer_id);
        }
      },
    }),

    tool({
      name: "get_layer_feature",
      title: "Get geo.admin.ch feature(s) by id",
      description:
        "Fetch the full attributes of one or more features of a geo.admin.ch layer by feature id (ids come from query_layer_at_point or find_layer_features). Example: layer_id='ch.bfs.gebaeude_wohnungs_register', feature_id='1231641_0'. Up to 10 comma-separated ids.",
      inputSchema: {
        layer_id: layerIdArg,
        feature_id: z.string().min(1).max(600).describe("Feature id, or up to 10 comma-separated ids"),
        return_geometry: z.boolean().default(false).describe("Include a WGS84 anchor point"),
        lang: langArg,
      },
      handler: async ({ layer_id, feature_id, return_geometry, lang }) => {
        const l = normLang(lang);
        const ids = feature_id.split(",").map((s) => s.trim()).filter(Boolean);
        const bad = ids.filter((i) => !FEATURE_ID_RE.test(i));
        if (!ids.length || bad.length || ids.length > 10) {
          return toolError("feature_id must be 1–10 comma-separated ids made of letters, digits, '_', '-', '.', ':'.", bad.length ? [`Invalid: ${bad.join(", ")}`] : []);
        }
        try {
          const url = withParams(`${API}/MapServer/${encodeURIComponent(layer_id)}/${ids.map(encodeURIComponent).join(",")}`, {
            returnGeometry: return_geometry,
            ...(return_geometry ? { geometryFormat: "geojson", sr: 2056 } : {}),
            lang: l,
          });
          const { data, cacheStatus, retrievedAt } = await fetchJson<{ feature?: GeoFeature; features?: GeoFeature[] }>(url, { ttlMs: MAP_TTL });
          const feats = data.features ?? (data.feature ? [data.feature] : []);
          if (!feats.length) {
            return toolError(`No feature '${feature_id}' in layer '${layer_id}'.`, ["Feature ids come from query_layer_at_point or find_layer_features."]);
          }
          // Up to 10 features × 40 attributes × 300 chars can exceed the
          // 50 KB envelope cap: shorten attribute values first, then drop features.
          const build = (fs: ReturnType<typeof compactFeature>[]) => ({ layer_id, returned: fs.length, features: fs });
          let maxStr = 300;
          let compacted = feats.map((f) => compactFeature(f, return_geometry, maxStr));
          for (const m of [120, 60, 30]) {
            if (JSON.stringify(build(compacted)).length <= RESPONSE_BUDGET) break;
            maxStr = m;
            compacted = feats.map((f) => compactFeature(f, return_geometry, maxStr));
          }
          const { data: out, dropped } = fitToBudget(compacted, build);
          const notes = [
            maxStr < 300 ? `Attribute values were shortened to ${maxStr} characters to fit the ~45 KB response cap.` : "",
            dropped ? `${dropped} of ${feats.length} feature(s) omitted to fit the size cap; request fewer ids per call.` : "",
          ].filter(Boolean);
          return respond(out, {
            source: mapServerSource,
            cacheStatus,
            retrievedAt,
            language: l,
            ...(notes.length ? { notes: notes.join(" ") } : {}),
          });
        } catch (err) {
          return layerHttpError(err, "feature", layer_id);
        }
      },
    }),

    tool({
      name: "get_location_report",
      title: "Federal geodata report for a Swiss address or point",
      description:
        "One-call location due-diligence: geocodes an address (or takes lat/lon) and queries ~20 curated federal layers in parallel — municipality & postcode, registered buildings (GWR), building zone, public-transport quality class, road & rail noise day/night, radon, surface-runoff flooding, seismic subsoil class, groundwater protection zones, contaminated sites, mobile antennas within 300 m, ISOS townscape, BLN landscape, roof solar suitability and district heating networks. Each layer reports status match/no_match/error independently. Examples: address='Bundesplatz 3, Bern'; lat=47.3769, lon=8.5417, topics=['noise','hazards'].",
      inputSchema: {
        address: z.string().min(3).max(200).optional().describe("Swiss address or place, e.g. 'Bahnhofstrasse 1, Zürich'"),
        lat: latArg.optional(),
        lon: lonArg.optional(),
        topics: z
          .array(z.enum(REPORT_TOPICS))
          .optional()
          .describe("Restrict to topics: admin, buildings, mobility, noise, hazards, environment, heritage, energy (default all)"),
        extra_layers: z.string().optional().describe("Up to 5 additional comma-separated layer ids to include (point query)"),
        lang: langArg,
      },
      handler: async ({ address, lat, lon, topics, extra_layers, lang }) => {
        const l = normLang(lang);
        let location: Record<string, unknown>;
        const statuses: CacheStatus[] = [];
        if (lat !== undefined && lon !== undefined) {
          const prob = swissPointProblem(lat, lon);
          if (prob) return toolError(prob.message, prob.suggestions);
          location = { lat, lon, source: "coordinates" };
        } else if (address) {
          try {
            const g = await geocodeFirst(address);
            if (!g) {
              return toolError(`Could not geocode '${address}'.`, ["Check the spelling or add the town/PLZ; or pass lat/lon directly."]);
            }
            const prob = swissPointProblem(g.lat, g.lon);
            if (prob) return toolError(prob.message, prob.suggestions);
            lat = g.lat;
            lon = g.lon;
            statuses.push(g.cacheStatus);
            location = { query: address, matched: g.label, lat, lon, source: "geo.admin.ch SearchServer" };
          } catch (err) {
            return errorToResult(err, "geo.admin.ch SearchServer (geocoding)");
          }
        } else {
          return toolError("Give an address or lat+lon.", ["Example: address='Bundesplatz 3, Bern'."]);
        }
        const pLat = lat as number;
        const pLon = lon as number;
        const { easting, northing } = wgs84ToLv95(pLat, pLon);
        location.lv95 = { easting, northing };

        const selected = REPORT_LAYERS.filter((x) => !topics?.length || topics.includes(x.topic));
        const extra = extra_layers ? parseLayerIds(extra_layers) : { valid: [], invalid: [] };
        if (extra.valid.length > 5) return toolError("extra_layers accepts at most 5 layer ids.");
        for (const id of extra.valid) {
          if (!selected.some((s) => s.id === id)) {
            selected.push({ id, topic: "admin", label: "Extra layer (user-requested)", radiusM: 0, maxFeatures: 3, confidence: "high" });
          }
        }
        const results = await mapLimit(selected, 8, (layer) => runReportLayer(layer, pLat, pLon, l));
        for (const r of results) if (r.cacheStatus) statuses.push(r.cacheStatus);
        const layers = results.map((r) => r.entry);
        const count = (s: string) => layers.filter((x) => x.status === s).length;
        if (count("error") === layers.length) {
          return toolError("Every layer query failed; geo.admin.ch may be unavailable.", [
            "Retry in a minute or run check_source_health.",
          ]);
        }
        const muni = layers.find((x) => x.layer_id === REPORT_LAYERS[0].id) as { features?: Array<{ attributes: Record<string, unknown> }> } | undefined;
        const ma = muni?.features?.[0]?.attributes ?? {};
        const { data, dropped } = fitToBudget(layers, (ls) => ({
          location: { ...location, municipality: ma["gemname"] ?? ma["name"], canton: ma["kanton"] },
          summary: { layers_queried: layers.length, match: count("match"), no_match: count("no_match"), error: count("error") },
          ...(extra.invalid.length ? { ignored_invalid_ids: extra.invalid } : {}),
          layers: ls,
        }));
        return respond(data, {
          source: mapServerSource,
          cacheStatus: worstCache(statuses),
          retrievedAt: new Date().toISOString(),
          language: l,
          links: { map: mapUrl(selected.map((s) => s.id).slice(0, 10), pLat, pLon) },
          notes:
            "Best-effort curated layer list (ids not verified live; 'id_confidence: medium' marks less certain ones). 'no_match' means the point is outside every " +
            "feature of that layer (e.g. no noise exposure mapped, not in a protected zone). Attributes are raw layer fields; use get_layer_info to interpret them." +
            (dropped ? ` ${dropped} layer(s) omitted to fit the size cap; use topics to narrow.` : ""),
        });
      },
    }),

    tool({
      name: "search_geodata_collections",
      title: "Search the geo.admin.ch STAC data catalogue",
      description:
        "Keyword search over the downloadable federal geodata collections on data.geo.admin.ch (STAC): swisstopo elevation/imagery/maps, BAFU/BFE/ARE datasets and MeteoSwiss open data — e.g. 'ch.meteoschweiz.ogd-smn' (SwissMetNet automatic weather stations), 'ch.meteoschweiz.ogd-nime' (manual precipitation), 'ch.meteoschweiz.ogd-pollen'. Returns collection ids, titles, licence, providers and time extent. Next: get_geodata_collection_items. Examples: query='meteoschweiz', 'swissalti3d', 'Lärm'. Omit query to page through all collections.",
      inputSchema: {
        query: z.string().max(120).optional().describe("Keywords matched against id, title, description, keywords and providers (all must match)"),
        limit: z.number().int().min(1).max(50).default(20).describe("Max collections (default 20)"),
        offset: z.number().int().min(0).default(0).describe("Skip this many matches (paging)"),
      },
      handler: async ({ query, limit, offset }) => {
        try {
          const { collections, cacheStatus, retrievedAt, base, truncated } = await allCollections();
          const matched = filterCollections(collections, query);
          if (!matched.length) {
            return toolError(`No STAC collections match '${query}'.`, [
              "Use fewer or broader keywords (e.g. 'meteoschweiz', 'bafu', 'swissimage').",
              "For map layers (not files) use search_map_layers.",
            ]);
          }
          const page = matched.slice(offset, offset + limit).map((c) => compactCollection(c));
          return respond(
            {
              query: query ?? null,
              total_collections: collections.length,
              total_matched: matched.length,
              offset,
              collections: page,
              ...(offset + limit < matched.length ? { next_offset: offset + limit } : {}),
            },
            {
              source: stacSource,
              cacheStatus,
              retrievedAt,
              links: { stac_api: base, browser: "https://data.geo.admin.ch/browser/index.html" },
              ...(truncated ? { notes: `Catalogue listing stopped after ${MAX_COLLECTION_PAGES} pages; some collections may be missing.` } : {}),
            },
          );
        } catch (err) {
          return errorToResult(err, "geo.admin.ch STAC");
        }
      },
    }),

    tool({
      name: "get_geodata_collection_items",
      title: "List items and downloadable assets of a STAC collection",
      description:
        "List the items (tiles, stations, time slices) of a data.geo.admin.ch STAC collection with their downloadable assets (href, media type, size), plus collection-level assets (e.g. MeteoSwiss station/parameter metadata CSVs). Filter by WGS84 bbox, datetime or a single item id; asset_filter narrows asset keys. Examples: collection='ch.meteoschweiz.ogd-smn', item_id='ber' (Bern-Zollikofen station), asset_filter='_d_' (daily data); collection='ch.swisstopo.swissalti3d', bbox=[7.43,46.94,7.46,46.96]. Next: read_geodata_asset on a CSV/JSON href.",
      inputSchema: {
        collection: z.string().regex(COLLECTION_ID_RE, "Collection ids look like 'ch.meteoschweiz.ogd-smn'").describe("STAC collection id"),
        item_id: z.string().regex(ITEM_ID_RE).optional().describe("Fetch one item by id (e.g. a MeteoSwiss station abbreviation in lower case, 'ber')"),
        bbox: bboxArg.optional(),
        datetime: z
          .string()
          .regex(DATETIME_RE, "RFC 3339 instant or interval, e.g. '2024-01-01T00:00:00Z/..'")
          .optional()
          .describe("RFC 3339 instant or interval, e.g. '2023-01-01T00:00:00Z/2023-12-31T23:59:59Z' or '2024-01-01T00:00:00Z/..'"),
        asset_filter: z.string().max(60).optional().describe("Only assets whose key/title contains this text, e.g. '.csv', '_h_recent', '2m'"),
        include_collection_assets: z.boolean().default(true).describe("Also list collection-level assets (metadata files)"),
        limit: z.number().int().min(1).max(100).default(10).describe("Items per page (default 10)"),
        page_url: z.string().url().optional().describe("The 'next_page_url' from a previous call, to continue paging"),
      },
      handler: async ({ collection, item_id, bbox, datetime, asset_filter, include_collection_assets, limit, page_url }) => {
        try {
          if (page_url && !isStacHostUrl(page_url, "/api/stac/")) {
            return toolError("page_url must be a data.geo.admin.ch STAC link returned by this tool.");
          }
          const statuses: CacheStatus[] = [];
          let colData: { data: StacCollection; cacheStatus: CacheStatus } | undefined;
          if (include_collection_assets && !page_url) {
            try {
              colData = await stacGet<StacCollection>(`/collections/${encodeURIComponent(collection)}`);
              statuses.push(colData.cacheStatus);
            } catch (e) {
              if (e instanceof SourceError && e.status === 404) {
                return toolError(`STAC collection '${collection}' not found.`, ["Use search_geodata_collections to find the id."]);
              }
              // Collection metadata is an enrichment; the items request below decides success.
            }
          }
          let items: StacItem[];
          let next: string | undefined;
          let retrievedAt: string;
          let matched: number | undefined;
          /** URL of the items page just read (for the size-cap re-read below). */
          let pageRequested: string | undefined;
          if (item_id) {
            const r = await stacGet<StacItem>(`/collections/${encodeURIComponent(collection)}/items/${encodeURIComponent(item_id)}`);
            items = [r.data];
            retrievedAt = r.retrievedAt;
            statuses.push(r.cacheStatus);
          } else {
            const firstParams = { limit, bbox: bbox?.join(","), datetime };
            let r;
            if (page_url) {
              r = await stacGetUrl<StacItemsPage>(page_url);
              pageRequested = page_url;
            } else {
              const first = await stacGet<StacItemsPage>(`/collections/${encodeURIComponent(collection)}/items`, firstParams);
              pageRequested = withParams(`${first.base}/collections/${encodeURIComponent(collection)}/items`, firstParams);
              r = first;
            }
            items = r.data.features ?? [];
            next = nextLink(r.data.links);
            if (next && !isStacHostUrl(next, "/api/stac/")) next = undefined;
            retrievedAt = r.retrievedAt;
            matched = r.data.numberMatched ?? r.data.context?.matched;
            statuses.push(r.cacheStatus);
          }
          const colAssets = colData ? compactAssets(colData.data.assets, asset_filter, 30) : undefined;
          const build = (xs: ReturnType<typeof compactItem>[], nextUrl: string | undefined) => ({
            collection: colData ? compactCollection(colData.data, 400) : { id: collection },
            ...(colAssets && colAssets.total ? { collection_assets: colAssets } : {}),
            ...(matched !== undefined ? { items_matched: matched } : {}),
            returned: xs.length,
            items: xs,
            ...(nextUrl ? { next_page_url: nextUrl } : {}),
          });
          let compact = items.map((it) => compactItem(it, asset_filter, 40));
          let fit = fitToBudget(compact, (xs) => build(xs, next));
          let resumeUrl: string | undefined;
          if (fit.dropped && pageRequested) {
            // The server's next link starts after the FULL page, so following it
            // would silently skip the items trimmed for size. Re-read this page
            // with a page size that fits: its next link then continues right
            // after the last item returned here.
            const smaller = new URL(pageRequested);
            smaller.searchParams.set("limit", String(compact.length - fit.dropped));
            resumeUrl = smaller.toString();
            try {
              const r2 = await stacGetUrl<StacItemsPage>(resumeUrl);
              const items2 = r2.data.features ?? [];
              let next2 = nextLink(r2.data.links);
              if (next2 && !isStacHostUrl(next2, "/api/stac/")) next2 = undefined;
              const compact2 = items2.map((it) => compactItem(it, asset_filter, 40));
              const fit2 = fitToBudget(compact2, (xs) => build(xs, next2));
              if (!fit2.dropped) {
                statuses.push(r2.cacheStatus);
                compact = compact2;
                fit = fit2;
                resumeUrl = undefined;
              }
            } catch {
              // Keep the trimmed page; the loss is reported explicitly below.
            }
          }
          const dropped = fit.dropped;
          let data = fit.data as Record<string, unknown>;
          if (dropped) {
            // Never hand out a next link that skips the trimmed items.
            const { next_page_url: _skipping, ...rest } = data;
            data = { ...rest, dropped_items: dropped, ...(resumeUrl ? { resume_page_url: resumeUrl } : {}) };
          }
          const isMeteo = collection.startsWith("ch.meteoschweiz.");
          return respond(data, {
            source: isMeteo ? meteoSource : stacSource,
            cacheStatus: worstCache(statuses),
            retrievedAt,
            links: { stac_api: currentStacBase(), browser: `https://data.geo.admin.ch/browser/index.html#/collections/${encodeURIComponent(collection)}` },
            notes: [
              dropped
                ? `${dropped} item(s) omitted to fit the size cap; lower limit or use asset_filter.` +
                  (resumeUrl
                    ? ` To continue without skipping them, call again with page_url=resume_page_url (this page with limit=${compact.length - dropped}; the items above repeat, then its next_page_url continues gap-free).`
                    : "")
                : "",
              isMeteo
                ? "MeteoSwiss OGD file naming: <collection>_<station>_<granularity t=10min|h|d|m|y>_<period historical|recent|now>.csv; CSVs are ';'-separated. Parameter codes are explained in the collection's *_meta_parameters.csv asset."
                : "",
            ]
              .filter(Boolean)
              .join(" ") || undefined,
          });
        } catch (err) {
          if (err instanceof SourceError && err.status === 404) {
            return toolError(`Not found in STAC: collection '${collection}'${item_id ? ` / item '${item_id}'` : ""}.`, [
              "Use search_geodata_collections for collection ids; list items without item_id to see valid ids.",
            ]);
          }
          if (err instanceof SourceError && err.status === 400) {
            return toolError("The STAC API rejected the query (HTTP 400).", ["Check bbox order [minLon,minLat,maxLon,maxLat] and the datetime format."]);
          }
          return errorToResult(err, "geo.admin.ch STAC");
        }
      },
    }),

    tool({
      name: "read_geodata_asset",
      title: "Read and query a CSV/JSON data file from data.geo.admin.ch",
      description:
        "Download a CSV or JSON asset from data.geo.admin.ch (href from get_geodata_collection_items) and return it as rows you can filter, sort and page — e.g. MeteoSwiss SwissMetNet station files. Filters: where={column: value} (exact), '~text' (substring), '>n'/'<n' (numeric). tail=true returns the latest rows of a time series. Example: url='https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/ber/ogd-smn_ber_d_recent.csv', tail=true, limit=7, columns=['reference_timestamp','tre200d0','rre150d0']. Large historical files may exceed max_mb — prefer '_recent' or '_now' files.",
      inputSchema: {
        url: z.string().url().describe("Asset href on https://data.geo.admin.ch/ (CSV, TXT or JSON/GeoJSON)"),
        where: z
          .record(z.string().max(500))
          .refine((w) => Object.keys(w).length <= MAX_WHERE_KEYS, { message: `At most ${MAX_WHERE_KEYS} column filters are allowed in 'where'.` })
          .refine((w) => Object.keys(w).every((k) => k.length <= MAX_COLUMN_NAME), { message: `Column names in 'where' are limited to ${MAX_COLUMN_NAME} characters.` })
          .optional()
          .describe("Column filters, e.g. {\"station_abbr\": \"BER\"} or {\"tre200d0\": \">25\"}"),
        search: z.string().max(100).optional().describe("Case-insensitive text search across all columns"),
        columns: z.array(z.string().max(MAX_COLUMN_NAME)).max(MAX_SELECTED_COLUMNS).optional().describe(`Columns to return (default all; max ${MAX_SELECTED_COLUMNS})`),
        sort: z.string().max(MAX_COLUMN_NAME).optional().describe("Sort column; prefix '-' for descending"),
        tail: z.boolean().default(false).describe("Return the LAST matching rows (latest values of a time series)"),
        offset: z.number().int().min(0).default(0).describe("Skip this many matching rows (ignored with tail)"),
        limit: z.number().int().min(1).max(500).default(50).describe("Max rows (default 50)"),
        max_mb: z.number().min(0.1).max(20).default(8).describe("Download size cap in MB (default 8, max 20)"),
      },
      handler: async ({ url, where, search, columns, sort, tail, offset, limit, max_mb }) => {
        if (!isStacHostUrl(url)) {
          return toolError("Only https://data.geo.admin.ch/ asset URLs are accepted by this tool.", [
            "Get asset hrefs from get_geodata_collection_items.",
          ]);
        }
        const fmt = tabularFormat(url);
        if (!fmt) {
          return toolError("This asset is not a CSV/TXT/JSON file and cannot be parsed into rows.", [
            "Binary assets (GeoTIFF, ZIP, LAS, …) must be downloaded directly from the href.",
          ]);
        }
        const isMeteo = new URL(url).pathname.startsWith("/ch.meteoschweiz.");
        try {
          // Download + parse through the shared heavy-work limiter.
          const loaded = await heavyParse(async () => {
            const res = await fetchCached(url, {
              ttlMs: (isMeteo ? meteoSource : stacSource).cacheTtlSeconds * 1000,
              timeoutMs: 45_000,
              maxBytes: Math.round(max_mb * 1024 * 1024),
            });
            try {
              return { res, table: parseResource(res.data, { format: fmt, maxRows: 200_000 }) as Table };
            } catch (e) {
              return { res, parseError: e instanceof Error ? e.message : String(e) };
            }
          });
          if (!("table" in loaded) || !loaded.table) {
            return toolError(`Could not parse the asset: ${"parseError" in loaded ? loaded.parseError : "unknown error"}`);
          }
          const { res, table } = loaded;
          const q = { search, where, sort, columns };
          const count = queryRows(table, { ...q, limit: 0 }).total;
          const first = tail ? Math.max(0, count - limit) : offset;
          const r = queryRows(table, { ...q, offset: first, limit });
          const all = r.rows as Row[];
          // With tail=true the newest rows are the point of the call: when the
          // payload must shrink, drop from the start and keep the last rows.
          const { data, dropped } = fitToBudget(
            all,
            (rows) => ({
              url,
              format: table.format,
              columns: table.columns,
              total_rows: table.rows.length,
              matched_rows: r.total,
              offset: tail ? first + (all.length - rows.length) : first,
              returned: rows.length,
              ...(r.unknown_columns.length ? { unknown_columns: r.unknown_columns } : {}),
              ...(table.notes?.length ? { parser_notes: table.notes } : {}),
              rows,
            }),
            undefined,
            { keepLast: tail },
          );
          return respond(data, {
            source: isMeteo ? meteoSource : stacSource,
            cacheStatus: res.cacheStatus,
            retrievedAt: res.retrievedAt,
            ...(dropped
              ? {
                  notes: tail
                    ? `${dropped} older row(s) omitted to fit the size cap (the latest rows are kept); select fewer columns or lower limit.`
                    : `${dropped} row(s) omitted to fit the size cap; select fewer columns or lower limit.`,
                }
              : {}),
          });
        } catch (err) {
          if (err instanceof TooLargeError) {
            return toolError(err.message, [
              "Raise max_mb (max 20) or pick a smaller file, e.g. a '_recent' or '_now' instead of '_historical' MeteoSwiss file.",
            ]);
          }
          if (err instanceof SourceError && err.status === 404) {
            return toolError("Asset not found (HTTP 404).", ["Re-list the item's assets with get_geodata_collection_items; file names change over time."]);
          }
          return errorToResult(err, "data.geo.admin.ch asset");
        }
      },
    }),
  ],
};
