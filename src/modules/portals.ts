/**
 * Opendatasoft portals module — one adapter for the Opendatasoft Explore API
 * v2.1, covering every Swiss open-data portal that runs on Opendatasoft:
 * SBB and the cantonal / city OGD portals of Basel-Stadt,
 * Basel-Landschaft, St. Gallen (canton + city) and Thurgau.
 *
 * Endpoints (Explore API v2.1, https://help.opendatasoft.com/apis/ods-explore-v2/):
 *   GET /api/explore/v2.1/catalog/datasets                        → {total_count, results:[dataset]}
 *   GET /api/explore/v2.1/catalog/datasets/{dataset_id}           → dataset {dataset_id, metas.default, fields[]}
 *   GET /api/explore/v2.1/catalog/datasets/{dataset_id}/records   → {total_count, results:[record]}
 *
 * Records are queried with ODSQL (where / select / order_by / group_by), which
 * is read-only; user ODSQL is passed through (length-limited) and every value
 * we interpolate ourselves (search text, field names, coordinates) is
 * sanitised first.
 */

import { z } from "zod";
import { allowHosts, fetchJson, withParams, SourceError, TooLargeError } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { CacheStatus, SourceManifest } from "../core/types.js";
import { registerSearcher, interleave, type DataHit } from "../core/discovery.js";
import { distanceKm } from "../core/coords.js";
import { summarizeGeometry } from "../core/tabular.js";

// ── Portal registry ───────────────────────────────────────────────────────

export interface OdsPortal {
  /** Stable id used as the `portal` argument. */
  id: string;
  name: string;
  operator: string;
  /** Hostname serving the Explore API (custom domain or *.opendatasoft.com). */
  domain: string;
  /** Licence note; the authoritative licence is per dataset (metas.default.license). */
  licence: string;
  /** How confident we are that this portal runs on Opendatasoft (Explore API v2.1). */
  confidence: "high" | "medium";
  /** Extra accepted spellings for the `portal` argument. */
  aliases: string[];
  /** What is worth looking for there (search terms that hit). */
  highlights: string;
}

export const PORTALS: OdsPortal[] = [
  {
    id: "sbb",
    name: "SBB Open Data",
    operator: "Swiss Federal Railways (SBB CFF FFS)",
    domain: "data.sbb.ch",
    licence: "Per dataset (SBB open-data terms; mostly free use with attribution)",
    confidence: "high",
    aliases: ["sbb-cff-ffs", "cff", "ffs", "data.sbb.ch"],
    highlights:
      "station passenger frequency (search 'passagierfrequenz'), rolling stock fleet ('rollmaterial'), actual vs. planned train times / punctuality ('ist-daten'), station facilities, platforms, parking & bike parking at stations, lines and kilometre posts",
  },
  {
    id: "basel-stadt",
    name: "Open Data Basel-Stadt",
    operator: "Canton of Basel-Stadt (Statistisches Amt)",
    domain: "data.bs.ch",
    licence: "CC BY 4.0 for most datasets (check per dataset)",
    confidence: "high",
    aliases: ["bs", "basel", "data.bs.ch"],
    highlights:
      "real-time parking occupancy ('Parkhäuser'), Rhine water temperature & level ('Rhein'), air quality ('Luftqualität'), election & vote results ('Wahlen', 'Abstimmung'), population, trees, traffic counts, energy",
  },
  {
    id: "basel-landschaft",
    name: "Open Data Basel-Landschaft",
    operator: "Canton of Basel-Landschaft (Statistisches Amt)",
    domain: "data.bl.ch",
    licence: "CC BY 4.0 for most datasets (check per dataset)",
    confidence: "high",
    aliases: ["bl", "baselland", "data.bl.ch"],
    highlights: "population by municipality, elections & votes, tax statistics, building permits, school data, traffic counts",
  },
  {
    id: "st-gallen",
    name: "Open Data Kanton St. Gallen",
    operator: "Canton of St. Gallen (Fachstelle für Statistik)",
    domain: "daten.sg.ch",
    licence: "Per dataset (mostly Swiss OGD terms / CC BY)",
    confidence: "high",
    aliases: ["sg", "kanton-st-gallen", "daten.sg.ch"],
    highlights: "cantonal statistics by municipality, elections & votes, population, economy, health, mobility",
  },
  {
    id: "stadt-st-gallen",
    name: "Open Data Stadt St. Gallen",
    operator: "City of St. Gallen",
    domain: "daten.stadt.sg.ch",
    licence: "Per dataset (mostly Swiss OGD terms / CC BY)",
    confidence: "high",
    aliases: ["stadt-sg", "city-st-gallen", "daten.stadt.sg.ch"],
    highlights: "parking occupancy, public toilets, waste collection, city statistics, events, points of interest",
  },
  {
    id: "thurgau",
    name: "Open Data Thurgau",
    operator: "Canton of Thurgau (Dienststelle für Statistik)",
    domain: "data.tg.ch",
    licence: "Per dataset (mostly Swiss OGD terms / CC BY)",
    confidence: "high",
    aliases: ["tg", "kanton-thurgau", "data.tg.ch"],
    highlights: "elections & votes, population, municipal finances, building activity, agriculture",
  },
];

// Custom domains need registering; *.opendatasoft.com is suffix-allowlisted.
allowHosts(...PORTALS.map((p) => p.domain).filter((d) => !d.endsWith(".opendatasoft.com")));

/**
 * Resolve a `portal` argument: registry id, alias or domain (case-insensitive),
 * or any other `<tenant>.opendatasoft.com` host (suffix-allowlisted, so safe).
 */
export function resolvePortal(input: string): OdsPortal | undefined {
  const q = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!q) return undefined;
  const hit = PORTALS.find((p) => p.id === q || p.domain === q || p.aliases.includes(q));
  if (hit) return hit;
  if (/^[a-z0-9][a-z0-9-]{0,62}\.opendatasoft\.com$/.test(q)) {
    return {
      id: q,
      name: `Opendatasoft portal ${q}`,
      operator: "Opendatasoft tenant (not in the Swissyphus registry)",
      domain: q,
      licence: "Per dataset (see metas.license)",
      confidence: "medium",
      aliases: [],
      highlights: "",
    };
  }
  return undefined;
}

// ── Source manifests ──────────────────────────────────────────────────────

const CATALOGUE_TTL_MS = 6 * 3600_000;
const RECORDS_TTL_MS = 10 * 60_000;

const API_NOTES =
  "Opendatasoft Explore API v2.1. Catalogue/schema cached 6 h, records 10 min (many datasets are real-time, e.g. parking). " +
  "Written without live access: dataset search uses an ODSQL full-text string literal in `where` (falls back to the legacy `q=` parameter on HTTP 400); " +
  "`near` uses within_distance() and tries order_by distance() first, falling back to client-side distance sorting if the portal rejects it. " +
  "Portal list: only portals believed with high confidence to run Opendatasoft; Geneva, Lausanne, Winterthur, Lucerne, Solothurn, Zug and Aargau were deliberately left out (platform not confirmed).";

export function portalManifest(p: OdsPortal): SourceManifest {
  return {
    id: `ods-${p.id}`,
    name: `${p.name} (Opendatasoft)`,
    operator: p.operator,
    url: `https://${p.domain}`,
    licence: p.licence,
    attribution: `Data © ${p.operator}, via ${p.domain}`,
    updateFrequency: "varies per dataset (real-time to yearly)",
    cacheTtlSeconds: RECORDS_TTL_MS / 1000,
    notes: `${API_NOTES} Platform confidence: ${p.confidence}.`,
  };
}

const allPortalsSource: SourceManifest = {
  id: "ods-portals",
  name: "Swiss Opendatasoft portals (SBB, cantons, cities)",
  operator: "Various (see per-result portal)",
  url: "https://help.opendatasoft.com/apis/ods-explore-v2/",
  licence: "Per dataset; each portal's datasets carry their own licence",
  attribution: "Data © the respective portal operators (SBB, cantons and cities)",
  updateFrequency: "continuous",
  cacheTtlSeconds: CATALOGUE_TTL_MS / 1000,
  notes: API_NOTES,
};

// ── API shapes (defensive) ────────────────────────────────────────────────

interface OdsField {
  name?: string;
  label?: string;
  type?: string;
  description?: string | null;
  annotations?: unknown;
}

interface OdsMetasDefault {
  title?: string;
  description?: string | null;
  theme?: string[] | string | null;
  keyword?: string[] | string | null;
  license?: string | null;
  license_url?: string | null;
  publisher?: string | null;
  attributions?: string[] | string | null;
  modified?: string | null;
  data_processed?: string | null;
  records_count?: number | null;
  language?: string | null;
  territory?: string[] | string | null;
  references?: string | null;
}

export interface OdsDataset {
  dataset_id?: string;
  datasetid?: string;
  has_records?: boolean;
  metas?: { default?: OdsMetasDefault };
  fields?: OdsField[];
  /** v2.0 wraps each dataset as {dataset: {...}}. */
  dataset?: OdsDataset;
}

interface OdsCatalogResponse {
  total_count?: number;
  results?: OdsDataset[];
  datasets?: OdsDataset[];
}

interface OdsRecordsResponse {
  total_count?: number;
  results?: Array<Record<string, unknown>>;
  /** v2.0 shape. */
  records?: Array<{ record?: { fields?: Record<string, unknown> }; fields?: Record<string, unknown> }>;
}

// ── Pure helpers (exported for tests) ─────────────────────────────────────

/** Strip HTML tags/entities from ODS descriptions and collapse whitespace. */
export function stripHtml(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function trimText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function asArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.length > 0);
  if (typeof v === "string" && v) return [v];
  return [];
}

/**
 * Make user text safe to embed inside an ODSQL double-quoted string literal:
 * drop quotes, backslashes, backticks and control characters.
 */
export function sanitizeOdsText(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f"'`\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** ODSQL field identifiers: letters, digits, underscore (dataset field names are always this shape). */
export function isSafeFieldName(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(s);
}

export function isSafeDatasetId(s: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,199}$/.test(s);
}

/** Validate a user-supplied ODSQL fragment (read-only API, so we only bound size and reject control chars). */
export function validateOdsql(label: string, s: string | undefined, max: number): string | undefined {
  if (s === undefined) return undefined;
  if (typeof s !== "string") return `${label} must be a string.`;
  if (s.length > max) return `${label} is too long (${s.length} > ${max} characters).`;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) return `${label} contains control characters.`;
  return undefined;
}

/** within_distance() clause for a geo_point_2d field. Numbers are formatted, never interpolated raw. */
export function buildNearClause(field: string, lat: number, lon: number, radiusM: number): string {
  if (!isSafeFieldName(field)) throw new Error(`Unsafe geo field name '${field}'.`);
  if (![lat, lon, radiusM].every(Number.isFinite)) throw new Error("near: lat, lon and radius_m must be finite numbers.");
  return `within_distance(${field}, geom'POINT(${lon.toFixed(6)} ${lat.toFixed(6)})', ${Math.round(radiusM)}m)`;
}

export function buildDistanceOrder(field: string, lat: number, lon: number): string {
  if (!isSafeFieldName(field)) throw new Error(`Unsafe geo field name '${field}'.`);
  return `distance(${field}, geom'POINT(${lon.toFixed(6)} ${lat.toFixed(6)})')`;
}

/** Unwrap v2.0 `{dataset: {...}}` and return the dataset object. */
function unwrap(d: OdsDataset): OdsDataset {
  return d.dataset && typeof d.dataset === "object" ? d.dataset : d;
}

export function datasetUrl(p: OdsPortal, id: string): string {
  return `https://${p.domain}/explore/dataset/${encodeURIComponent(id)}/`;
}

/** Compact search hit. */
export function summarizeDataset(raw: OdsDataset, p: OdsPortal) {
  const d = unwrap(raw);
  const m = d.metas?.default ?? {};
  const id = d.dataset_id ?? d.datasetid ?? "";
  return {
    portal: p.id,
    dataset_id: id,
    title: m.title || id,
    description: trimText(stripHtml(m.description), 240) || undefined,
    records: typeof m.records_count === "number" ? m.records_count : undefined,
    modified: m.modified?.slice(0, 10) ?? undefined,
    themes: asArray(m.theme),
    publisher: m.publisher || undefined,
    url: datasetUrl(p, id),
  };
}

function fieldAnnotations(a: unknown): string[] {
  // v2.1: {facet: true, sortable: true, ...}; older: [{name: "facet"}, ...]
  if (Array.isArray(a)) return a.map((x) => (x && typeof x === "object" ? String((x as { name?: unknown }).name ?? "") : String(x))).filter(Boolean);
  if (a && typeof a === "object") return Object.entries(a).filter(([, v]) => v !== false && v != null).map(([k]) => k);
  return [];
}

/** Full schema view for get_portal_dataset. */
export function describeDataset(raw: OdsDataset, p: OdsPortal) {
  const d = unwrap(raw);
  const m = d.metas?.default ?? {};
  const id = d.dataset_id ?? d.datasetid ?? "";
  const allFields = d.fields ?? [];
  const fields = allFields.slice(0, 150).map((f) => {
    const ann = fieldAnnotations(f.annotations);
    return {
      name: f.name,
      label: f.label && f.label !== f.name ? f.label : undefined,
      type: f.type,
      description: f.description ? trimText(stripHtml(f.description), 200) || undefined : undefined,
      facet: ann.includes("facet") || undefined,
    };
  });
  const geo = allFields.find((f) => f.type === "geo_point_2d")?.name;
  return {
    portal: p.id,
    portal_name: p.name,
    dataset_id: id,
    title: m.title || id,
    description: trimText(stripHtml(m.description), 2000) || undefined,
    records: typeof m.records_count === "number" ? m.records_count : undefined,
    modified: m.modified ?? undefined,
    data_processed: m.data_processed ?? undefined,
    licence: m.license ?? undefined,
    licence_url: m.license_url ?? undefined,
    publisher: m.publisher ?? undefined,
    attributions: asArray(m.attributions),
    themes: asArray(m.theme),
    keywords: asArray(m.keyword).slice(0, 20),
    language: m.language ?? undefined,
    references: m.references ?? undefined,
    geo_point_field: geo,
    fields,
    ...(allFields.length > fields.length ? { fields_truncated: `${allFields.length - fields.length} more fields not shown` } : {}),
    url: datasetUrl(p, id),
    api: `https://${p.domain}/api/explore/v2.1/catalog/datasets/${encodeURIComponent(id)}/records`,
  };
}

/** Read the records array from either v2.1 ({results}) or v2.0 ({records:[{record:{fields}}]}) shapes. */
export function extractOdsRecords(data: OdsRecordsResponse): Array<Record<string, unknown>> {
  if (Array.isArray(data.results)) return data.results;
  if (Array.isArray(data.records)) return data.records.map((r) => r.record?.fields ?? r.fields ?? {});
  return [];
}

function isGeometryLike(v: Record<string, unknown>): boolean {
  return "geometry" in v || "coordinates" in v || v.type === "Feature" || v.type === "FeatureCollection";
}

/** Keep records compact: long strings truncated, big geometries summarised. */
export function trimRecord(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === "string") {
      out[k] = v.length > 500 ? `${v.slice(0, 499)}…` : v;
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      const size = JSON.stringify(obj).length;
      if (isGeometryLike(obj) && size > 300) {
        const g = (obj.geometry ?? obj) as { type?: string; coordinates?: unknown };
        out[k] = { geometry_summary: summarizeGeometry(g) };
      } else if (size > 2000) {
        out[k] = `[object omitted: ${size} chars — exclude it or pick sub-fields with select]`;
      } else {
        out[k] = obj;
      }
    } else if (Array.isArray(v) && JSON.stringify(v).length > 2000) {
      out[k] = `[array of ${v.length} omitted — too large]`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Pull {lat, lon} from a geo_point_2d value ({lon, lat} object, [lat, lon] array or "lat,lon" string). */
export function readGeoPoint(v: unknown): { lat: number; lon: number } | undefined {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as { lat?: unknown; lon?: unknown };
    const lat = Number(o.lat);
    const lon = Number(o.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  }
  if (Array.isArray(v) && v.length === 2) {
    const [lat, lon] = v.map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  }
  if (typeof v === "string") {
    const m = v.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) return { lat: Number(m[1]), lon: Number(m[2]) };
  }
  return undefined;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────

const apiBase = (p: OdsPortal) => `https://${p.domain}/api/explore/v2.1`;

/** Try each URL in order, moving on only when the portal rejects the query with HTTP 400. */
async function fetchWithFallbacks<T>(
  urls: string[],
  opts: { ttlMs: number; timeoutMs?: number },
): Promise<{ data: T; cacheStatus: CacheStatus; retrievedAt: string; usedIndex: number }> {
  let lastErr: unknown;
  for (let i = 0; i < urls.length; i++) {
    try {
      const r = await fetchJson<T>(urls[i], { ttlMs: opts.ttlMs, timeoutMs: opts.timeoutMs ?? 15_000 });
      return { ...r, usedIndex: i };
    } catch (err) {
      lastErr = err;
      if (!(err instanceof SourceError && err.status === 400)) throw err;
    }
  }
  throw lastErr;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SourceError(`${label} did not answer within ${Math.round(ms / 1000)} s.`, label)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** Search (or list) one portal's catalogue. */
export async function searchPortal(p: OdsPortal, query: string | undefined, limit: number, timeoutMs = 15_000) {
  const base = `${apiBase(p)}/catalog/datasets`;
  const text = query ? sanitizeOdsText(query) : "";
  const urls = text
    ? [
        withParams(base, { where: `"${text}"`, limit }),
        withParams(base, { q: text, limit }), // legacy full-text parameter
      ]
    : [withParams(base, { order_by: "modified desc", limit }), withParams(base, { limit })];
  const r = await fetchWithFallbacks<OdsCatalogResponse>(urls, { ttlMs: CATALOGUE_TTL_MS, timeoutMs });
  const list = r.data.results ?? r.data.datasets ?? [];
  return {
    total_count: r.data.total_count,
    results: list.map((d) => summarizeDataset(d, p)),
    cacheStatus: r.cacheStatus,
    retrievedAt: r.retrievedAt,
  };
}

export async function fetchDataset(p: OdsPortal, datasetId: string) {
  const url = `${apiBase(p)}/catalog/datasets/${encodeURIComponent(datasetId)}`;
  return fetchJson<OdsDataset>(url, { ttlMs: CATALOGUE_TTL_MS });
}

/** Portals that rejected order_by distance(); skip that attempt next time. */
const noDistanceOrder = new Set<string>();

function combineStatus(a: CacheStatus, b: CacheStatus): CacheStatus {
  if (a === b) return a;
  if (a === "miss" || b === "miss") return "miss";
  if (a === "stale" || b === "stale") return "stale";
  return "computed";
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const portalArg = z
  .string()
  .min(2)
  .describe(
    `Portal id, alias or domain: ${PORTALS.map((p) => `'${p.id}' (${p.domain})`).join(", ")}; any other '<tenant>.opendatasoft.com' host also works`,
  );

function unknownPortal(portal: string) {
  return toolError(`Unknown portal '${portal}'.`, [
    `Known portals: ${PORTALS.map((p) => `${p.id} (${p.domain})`).join(", ")}.`,
    "Call list_data_portals for the full registry, or pass a '<tenant>.opendatasoft.com' host.",
  ]);
}

const RESPONSE_BUDGET = 45_000;

// ── Discovery (find_data) ─────────────────────────────────────────────────

registerSearcher({
  catalogue: "Opendatasoft portals",
  module: "portals",
  search: async (query, limit) => {
    const per = Math.max(2, Math.min(5, limit));
    const failures: string[] = [];
    const lists = await Promise.all(
      PORTALS.map(async (p) => {
        try {
          const r = await withTimeout(searchPortal(p, query, per, 8_000), 8_000, p.domain);
          return r.results.map(
            (d): DataHit => ({
              catalogue: "Opendatasoft portals",
              id: `${p.id}/${d.dataset_id}`,
              title: `${d.title} (${p.name})`,
              description: d.description,
              publisher: d.publisher ?? p.operator,
              url: d.url,
              next: { tool: "get_portal_dataset", args: { portal: p.id, dataset_id: d.dataset_id } },
            }),
          );
        } catch (err) {
          failures.push(`${p.domain}: ${err instanceof Error ? err.message : String(err)}`);
          return [] as DataHit[];
        }
      }),
    );
    // One portal down is normal; all of them down must not look like "no hits"
    // to find_data, which reports unreachable catalogues only on a throw.
    if (failures.length === PORTALS.length) {
      const shown = failures.slice(0, 4).map((f) => f.slice(0, 160));
      throw new Error(
        `All ${PORTALS.length} Opendatasoft portals failed: ${shown.join("; ")}${failures.length > shown.length ? `; +${failures.length - shown.length} more` : ""}`,
      );
    }
    return interleave(lists, limit);
  },
});

// ── Module ────────────────────────────────────────────────────────────────

export const portalsModule: SwissyphusModule = {
  id: "portals",
  emoji: "🗂️",
  title: "Opendatasoft portals (SBB, cantons, cities)",
  description:
    "Search and query the Swiss open-data portals running on Opendatasoft — SBB, Basel-Stadt, Basel-Landschaft, St. Gallen (canton & city), Thurgau — with ODSQL filters, aggregations and radius search",
  sources: [...PORTALS.map(portalManifest), allPortalsSource],
  healthProbes: PORTALS.map((p) => ({
    sourceId: `ods-${p.id}`,
    url: `${apiBase(p)}/catalog/datasets?limit=1`,
  })),
  tools: [
    tool({
      name: "list_data_portals",
      title: "List Swiss Opendatasoft data portals",
      description:
        "Registry of Swiss open-data portals that run on Opendatasoft and can be searched/queried with search_portal_datasets, get_portal_dataset and query_portal_records: " +
        "SBB (data.sbb.ch — station passenger frequency, rolling stock, actual train times), " +
        "Basel-Stadt (real-time parking, Rhine temperature, air quality, elections), Basel-Landschaft, Canton & City of St. Gallen, Thurgau. " +
        "Returns id, name, operator, domain, licence note, platform confidence and what each portal is good for.",
      inputSchema: {},
      handler: async () =>
        respond(
          {
            portals: PORTALS.map((p) => ({
              id: p.id,
              name: p.name,
              operator: p.operator,
              domain: p.domain,
              licence: p.licence,
              platform_confidence: p.confidence,
              good_for: p.highlights,
              url: `https://${p.domain}/explore/`,
            })),
            hint: "Search with search_portal_datasets {query, portal?}; omit portal to search all portals in parallel.",
          },
          { source: allPortalsSource, cacheStatus: "computed", retrievedAt: new Date().toISOString() },
        ),
    }),

    tool({
      name: "search_portal_datasets",
      title: "Search datasets on Swiss Opendatasoft portals",
      description:
        "Full-text search of dataset catalogues on SBB and cantonal/city Opendatasoft portals — one portal or all in parallel (per-portal errors are reported, not fatal). " +
        "Returns portal, dataset_id, title, short description, record count, last-modified date and themes; pass portal + dataset_id to get_portal_dataset / query_portal_records. " +
        "Examples: {query:'passagierfrequenz', portal:'sbb'} (passengers per station), {query:'rollmaterial', portal:'sbb'}, {query:'Parkhaus'} (real-time parking), " +
        "{query:'Rhein Temperatur', portal:'basel-stadt'}, {query:'Wahlen'}. " +
        "Metadata is mostly German — use German terms. Omit query (with a portal) to list its most recently modified datasets.",
      inputSchema: {
        query: z.string().min(2).max(200).optional().describe("Search terms, e.g. 'Parkhaus', 'Luftqualität', 'Haltestellen', 'Bevölkerung'"),
        portal: portalArg.optional().describe("Optional portal (id/alias/domain). Omit to search all registered portals in parallel."),
        limit: z.number().int().min(1).max(50).default(8).describe("Max results per portal (capped at 15 when searching all portals)"),
      },
      handler: async ({ query, portal, limit }) => {
        if (!query && !portal) {
          return toolError("Give a search query, or a portal to list its latest datasets.", [
            "Example: {query:'Parkhaus'} or {portal:'sbb'}.",
          ]);
        }
        if (query !== undefined && !sanitizeOdsText(query)) {
          return toolError("The search query contains no searchable characters.", ["Use plain words, e.g. 'Parkhaus'."]);
        }
        if (portal) {
          const p = resolvePortal(portal);
          if (!p) return unknownPortal(portal);
          try {
            const r = await searchPortal(p, query, limit);
            if (!r.results.length) {
              return toolError(`No datasets on ${p.domain} match '${query ?? ""}'.`, [
                "Try German terms or a broader word (e.g. 'Verkehr', 'Bevölkerung').",
                "Omit portal to search all Swiss Opendatasoft portals.",
              ]);
            }
            return respond(
              { portal: p.id, total_matches: r.total_count, results: r.results },
              { source: portalManifest(p), cacheStatus: r.cacheStatus, retrievedAt: r.retrievedAt },
            );
          } catch (err) {
            return errorToResult(err, p.name);
          }
        }
        const per = Math.min(limit, 15);
        const settled = await Promise.all(
          PORTALS.map(async (p) => {
            try {
              const r = await withTimeout(searchPortal(p, query, per, 12_000), 12_000, p.domain);
              return { p, r };
            } catch (err) {
              return { p, error: describeError(err) };
            }
          }),
        );
        const results = interleave(
          settled.map((s) => s.r?.results ?? []),
          per * PORTALS.length,
        );
        const perPortal = settled.map((s) =>
          s.r ? { portal: s.p.id, total_matches: s.r.total_count, returned: s.r.results.length } : { portal: s.p.id, error: s.error },
        );
        const ok = settled.filter((s) => s.r);
        if (!ok.length) {
          return toolError("All Opendatasoft portals failed to answer.", [
            ...perPortal.map((x) => `${x.portal}: ${"error" in x ? x.error : "ok"}`),
            "Try again in a minute, or run check_source_health.",
          ]);
        }
        if (!results.length) {
          return toolError(`No datasets on any portal match '${query}'.`, [
            "Try German terms (metadata is German-first), e.g. 'Parkhaus', 'Abstimmung', 'Haltestelle'.",
          ]);
        }
        const status = ok.map((s) => s.r!.cacheStatus).reduce(combineStatus);
        const retrievedAt = ok.map((s) => s.r!.retrievedAt).sort()[0];
        return respond(
          { query, per_portal: perPortal, results },
          { source: allPortalsSource, cacheStatus: status, retrievedAt },
        );
      },
    }),

    tool({
      name: "get_portal_dataset",
      title: "Get Opendatasoft dataset schema & licence",
      description:
        "Schema and metadata of one dataset on a Swiss Opendatasoft portal (SBB, Basel, St. Gallen, Thurgau…): fields (name, label, type, description, facet), record count, licence, publisher, attributions, themes, last modified, and the geo_point field usable for radius search. " +
        "Call this before query_portal_records to learn field names for where/select/order_by. Example: {portal:'sbb', dataset_id:'passagierfrequenz'}.",
      inputSchema: {
        portal: portalArg,
        dataset_id: z.string().min(1).max(200).describe("Dataset id from search_portal_datasets, e.g. 'passagierfrequenz' (SBB) or '100088' (Basel-Stadt ids are numeric)"),
      },
      handler: async ({ portal, dataset_id }) => {
        const p = resolvePortal(portal);
        if (!p) return unknownPortal(portal);
        if (!isSafeDatasetId(dataset_id)) {
          return toolError(`'${dataset_id}' is not a valid dataset id.`, ["Use the dataset_id exactly as returned by search_portal_datasets."]);
        }
        try {
          const { data, cacheStatus, retrievedAt } = await fetchDataset(p, dataset_id);
          const d = describeDataset(data, p);
          if (!d.dataset_id) return toolError(`Dataset '${dataset_id}' not found on ${p.domain}.`);
          return respond(d, {
            source: portalManifest(p),
            cacheStatus,
            retrievedAt,
            dataAsOf: d.data_processed ?? d.modified,
            links: { explore: d.url, records_api: d.api },
          });
        } catch (err) {
          if (err instanceof SourceError && (err.status === 404 || err.status === 403)) {
            return toolError(`Dataset '${dataset_id}' not found (or not public) on ${p.domain}.`, [
              "Use search_portal_datasets to find the exact dataset_id.",
            ]);
          }
          return errorToResult(err, p.name);
        }
      },
    }),

    tool({
      name: "query_portal_records",
      title: "Query records of an Opendatasoft dataset",
      description:
        "Fetch records from a dataset on a Swiss Opendatasoft portal with ODSQL: where (e.g. \"kanton = 'BS'\", \"jahr >= 2020\", \"search(name, 'Bahnhof')\"), select (e.g. 'bahnhof_haltestelle, dtv, jahr'), " +
        "order_by (e.g. 'dtv desc'), group_by with aggregates (select 'kanton, count(*) as n, sum(dtv) as total', group_by 'kanton'), limit/offset. " +
        "Convenience `near` {lat, lon, radius_m} finds the dataset's geo_point_2d field and returns only records within the radius, sorted by distance (e.g. parking garages within 800 m of Basel SBB: portal 'basel-stadt', near {lat:47.5476, lon:7.5896, radius_m:800}). " +
        "Real-time datasets (parking occupancy, SBB data) are cached only 10 min. Get field names first with get_portal_dataset.",
      inputSchema: {
        portal: portalArg,
        dataset_id: z.string().min(1).max(200).describe("Dataset id from search_portal_datasets"),
        where: z.string().max(2000).optional().describe("ODSQL filter, e.g. \"jahr = 2023 AND dtv > 10000\" (string literals in single or double quotes)"),
        select: z.string().max(1000).optional().describe("Fields/expressions to return, e.g. 'name, belegung, geo_point_2d' or 'kanton, count(*) as n'"),
        order_by: z.string().max(500).optional().describe("e.g. 'dtv desc' or 'n desc'"),
        group_by: z.string().max(500).optional().describe("e.g. 'kanton' or 'year(datum)'; combine with aggregates in select"),
        limit: z.number().int().min(1).max(100).default(20).describe("Records to return (max 100)"),
        offset: z.number().int().min(0).max(9900).default(0).describe("Paging offset (offset + limit ≤ 10000)"),
        near: z
          .object({
            lat: z.number().min(-90).max(90),
            lon: z.number().min(-180).max(180),
            radius_m: z.number().positive().max(100_000).default(1000),
          })
          .optional()
          .describe("Radius search around a WGS84 point, e.g. {lat: 47.5476, lon: 7.5896, radius_m: 500}"),
        geo_field: z.string().max(128).optional().describe("geo_point_2d field to use for `near` (auto-detected if omitted)"),
        lang: z.enum(["de", "fr", "it", "en"]).optional().describe("Language for localized values where the portal supports it"),
      },
      handler: async ({ portal, dataset_id, where, select, order_by, group_by, limit, offset, near, geo_field, lang }) => {
        const p = resolvePortal(portal);
        if (!p) return unknownPortal(portal);
        if (!isSafeDatasetId(dataset_id)) {
          return toolError(`'${dataset_id}' is not a valid dataset id.`, ["Use the dataset_id exactly as returned by search_portal_datasets."]);
        }
        for (const [label, v, max] of [
          ["where", where, 2000],
          ["select", select, 1000],
          ["order_by", order_by, 500],
          ["group_by", group_by, 500],
        ] as const) {
          const e = validateOdsql(label, v, max);
          if (e) return toolError(e);
        }
        if (offset + limit > 10_000) {
          return toolError("offset + limit must not exceed 10000 (Explore API limit).", ["Narrow the query with where instead of paging deeper."]);
        }

        const source = portalManifest(p);
        try {
          let geoField: string | undefined;
          let schemaStatus: CacheStatus | undefined;
          let nearClause: string | undefined;
          if (near) {
            if (geo_field) {
              if (!isSafeFieldName(geo_field)) return toolError(`'${geo_field}' is not a valid field name.`);
              geoField = geo_field;
            } else {
              const schema = await fetchDataset(p, dataset_id);
              schemaStatus = schema.cacheStatus;
              const fields = unwrap(schema.data).fields ?? [];
              geoField = fields.find((f) => f.type === "geo_point_2d" && f.name && isSafeFieldName(f.name))?.name;
              if (!geoField) {
                return toolError(`Dataset '${dataset_id}' on ${p.domain} has no geo_point_2d field, so 'near' cannot be used.`, [
                  `Field types: ${fields.slice(0, 30).map((f) => `${f.name}:${f.type}`).join(", ") || "unknown"}.`,
                  "Filter by place with 'where' instead (e.g. a municipality or postcode field).",
                ]);
              }
            }
            nearClause = buildNearClause(geoField, near.lat, near.lon, near.radius_m);
          }

          const fullWhere = [where ? `(${where})` : undefined, nearClause].filter(Boolean).join(" AND ") || undefined;
          const base = `${apiBase(p)}/catalog/datasets/${encodeURIComponent(dataset_id)}/records`;
          const params = { where: fullWhere, select, group_by, limit, offset: offset || undefined, lang };
          const urls: string[] = [];
          const tryDistanceOrder = near && geoField && !order_by && !group_by && !noDistanceOrder.has(p.domain);
          if (tryDistanceOrder) {
            urls.push(withParams(base, { ...params, order_by: buildDistanceOrder(geoField!, near!.lat, near!.lon) }));
          }
          urls.push(withParams(base, { ...params, order_by }));

          const r = await fetchWithFallbacks<OdsRecordsResponse>(urls, { ttlMs: RECORDS_TTL_MS });
          if (tryDistanceOrder && r.usedIndex > 0) noDistanceOrder.add(p.domain);

          let records = extractOdsRecords(r.data).map(trimRecord);
          if (near && geoField) {
            records = records.map((rec) => {
              const pt = readGeoPoint(rec[geoField!]);
              return pt ? { distance_m: Math.round(distanceKm(near.lat, near.lon, pt.lat, pt.lon) * 1000), ...rec } : rec;
            });
            if (!order_by) {
              records.sort((a, b) => Number(a.distance_m ?? Infinity) - Number(b.distance_m ?? Infinity));
            }
          }

          // Keep well under the 50 KB envelope cap.
          let dropped = 0;
          const payload = () => ({
            portal: p.id,
            dataset_id,
            total_count: r.data.total_count,
            returned: records.length,
            offset,
            ...(near ? { near: { ...near, geo_field: geoField } } : {}),
            records,
          });
          while (records.length > 1 && JSON.stringify(payload()).length > RESPONSE_BUDGET) {
            records.pop();
            dropped++;
          }
          const notes: string[] = [];
          if (dropped) notes.push(`${dropped} records dropped to stay under the 50 KB response cap — use select to return fewer fields or lower limit.`);
          if (near && !order_by && (r.usedIndex > 0 || !tryDistanceOrder) && (r.data.total_count ?? 0) > records.length) {
            notes.push("Portal did not sort by distance server-side; records were sorted by distance within this page only — lower radius_m to be sure you have the nearest.");
          }
          return respond(payload(), {
            source,
            cacheStatus: schemaStatus ? combineStatus(schemaStatus, r.cacheStatus) : r.cacheStatus,
            retrievedAt: r.retrievedAt,
            links: { explore: datasetUrl(p, dataset_id) },
            ...(notes.length ? { notes: notes.join(" ") } : {}),
          });
        } catch (err) {
          if (err instanceof SourceError && err.status === 400) {
            return toolError(`${p.domain} rejected the query (HTTP 400) — most likely an ODSQL syntax error or unknown field name.`, [
              "Check field names with get_portal_dataset (use `name`, not `label`).",
              "ODSQL examples: where \"jahr = 2023\", \"name like 'Bahnhof*'\", \"search(name, 'Bahnhof')\"; select 'kanton, count(*) as n' with group_by 'kanton'.",
              "String literals need quotes; dates as date'2024-01-01'.",
            ]);
          }
          if (err instanceof SourceError && (err.status === 404 || err.status === 403)) {
            return toolError(`Dataset '${dataset_id}' not found (or not public) on ${p.domain}.`, [
              "Use search_portal_datasets to find the exact dataset_id.",
            ]);
          }
          if (err instanceof TooLargeError) {
            return toolError(`Response from ${p.domain} was too large.`, ["Use select to return fewer fields, or lower limit."]);
          }
          return errorToResult(err, p.name);
        }
      },
    }),
  ],
};
