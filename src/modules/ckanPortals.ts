/**
 * Swiss CKAN portals: configuration plus pure helpers used by the statistics
 * module to turn catalogue metadata into queryable data.
 *
 * - Portal registry (opendata.swiss, City of Zürich) — both expose the
 *   standard CKAN action API (/api/3/action/package_search, package_show,
 *   organization_list).
 * - Multilingual field picking (opendata.swiss returns {de,fr,it,en} objects,
 *   and some endpoints return those objects JSON-encoded as strings).
 * - Resource classification / ranking (CSV > JSON > GeoJSON; HTML, ZIP,
 *   XLSX, PDF, services are reported as not parseable).
 * - Group-by aggregation over parsed tables.
 *
 * No I/O here — everything is unit-tested offline.
 */

import type { SourceManifest } from "../core/types.js";
import { queryRows, resolveColumn, type Row, type Table } from "../core/tabular.js";

// ── Portals ──────────────────────────────────────────────────────────────

export const PORTAL_IDS = ["opendata.swiss", "stadt-zuerich"] as const;
export type PortalId = (typeof PORTAL_IDS)[number];

export interface CkanPortal {
  id: PortalId;
  /** Catalogue name used for find_data hits. */
  catalogue: string;
  apiBase: string;
  datasetUrl: (name: string, lang: string) => string;
  source: SourceManifest;
}

export const PORTALS: Record<PortalId, CkanPortal> = {
  "opendata.swiss": {
    id: "opendata.swiss",
    catalogue: "opendata.swiss",
    apiBase: "https://ckan.opendata.swiss/api/3/action",
    datasetUrl: (name, lang) => `https://opendata.swiss/${lang}/dataset/${encodeURIComponent(name)}`,
    source: {
      id: "opendata-swiss",
      name: "opendata.swiss — Swiss OGD catalogue",
      operator: "Federal Statistical Office (BFS) / OGD office",
      url: "https://opendata.swiss",
      licence: "Catalogue metadata: open; each dataset carries its own OGD licence (stated per result)",
      attribution: "Catalogue © opendata.swiss; datasets © their respective publishers",
      updateFrequency: "continuous",
      cacheTtlSeconds: 3600,
      notes:
        "CKAN action API at ckan.opendata.swiss. Resource files are fetched from each publisher's own host " +
        "(SSRF-guarded, 15 MB cap, first 100'000 rows parsed). organization_list with all_fields is paged " +
        "because CKAN caps it (default 25 per call).",
    },
  },
  "stadt-zuerich": {
    id: "stadt-zuerich",
    catalogue: "data.stadt-zuerich.ch",
    apiBase: "https://data.stadt-zuerich.ch/api/3/action",
    datasetUrl: (name) => `https://data.stadt-zuerich.ch/dataset/${encodeURIComponent(name)}`,
    source: {
      id: "stadt-zuerich-ogd",
      name: "Open Data Stadt Zürich (CKAN catalogue)",
      operator: "City of Zürich — Open Government Data office (Statistik Stadt Zürich)",
      url: "https://data.stadt-zuerich.ch",
      licence: "Per dataset (predominantly CC0 / Creative Commons Zero); stated per result",
      attribution: "© Stadt Zürich, Open Government Data",
      updateFrequency: "continuous (per dataset: daily to yearly)",
      cacheTtlSeconds: 3600,
      notes:
        "Standard CKAN action API (/api/3/action). Titles are plain strings (German). Not live-verified from " +
        "the build sandbox: field names assumed to follow stock CKAN (license_id/license_title, resource format/url/mimetype).",
    },
  },
};

export function getPortal(id: string | undefined): CkanPortal {
  return PORTALS[(id ?? "opendata.swiss") as PortalId] ?? PORTALS["opendata.swiss"];
}

// ── CKAN shapes (defensive: every field optional) ─────────────────────────

export type LangText = string | Record<string, string | undefined> | null;

export interface CkanResource {
  id?: string;
  name?: LangText;
  title?: LangText;
  description?: LangText;
  format?: string;
  media_type?: string;
  mimetype?: string;
  download_url?: string;
  url?: string;
  rights?: string;
  license?: string;
  byte_size?: number | string;
  size?: number | string;
}

export interface CkanDataset {
  id?: string;
  name?: string;
  title?: LangText;
  notes?: LangText;
  description?: LangText;
  metadata_modified?: string;
  metadata_created?: string;
  license_id?: string;
  license_title?: string;
  organization?: { title?: LangText; name?: string; display_name?: LangText };
  resources?: CkanResource[];
  num_resources?: number;
}

export interface CkanOrganization {
  name?: string;
  title?: LangText;
  display_name?: LangText;
  package_count?: number;
  description?: LangText;
}

export const LANGS = ["de", "fr", "it", "en"] as const;

/**
 * Pick one language from a multilingual CKAN field. Accepts plain strings,
 * {de,fr,it,en} objects, and those objects JSON-encoded as a string (which
 * opendata.swiss emits for organization titles on some endpoints).
 */
export function pickLang(t: LangText | undefined, lang = "en"): string | undefined {
  if (t === undefined || t === null) return undefined;
  let v: unknown = t;
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("{") && s.endsWith("}")) {
      try {
        v = JSON.parse(s);
      } catch {
        return v as string;
      }
    } else return s || undefined;
  }
  if (!v || typeof v !== "object") return typeof v === "string" ? v : undefined;
  const o = v as Record<string, unknown>;
  for (const k of [lang, "en", "de", "fr", "it"]) {
    const x = o[k];
    if (typeof x === "string" && x.trim()) return x;
  }
  const any = Object.values(o).find((x) => typeof x === "string" && x.trim());
  return typeof any === "string" ? any : undefined;
}

// ── Resource classification & ranking ─────────────────────────────────────

export type ResourceKind =
  | "csv"
  | "json"
  | "geojson"
  | "xlsx"
  | "zip"
  | "pdf"
  | "html"
  | "xml"
  | "service"
  | "parquet"
  | "other"
  | "unknown";

export const PARSEABLE_KINDS: ReadonlySet<ResourceKind> = new Set(["csv", "json", "geojson"]);

function extOf(url: string | undefined): string {
  if (!url) return "";
  try {
    const p = new URL(url).pathname.toLowerCase();
    const m = p.match(/\.([a-z0-9]+)$/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

function kindFromToken(t: string): ResourceKind | undefined {
  const s = t.toLowerCase().trim();
  if (!s) return undefined;
  if (s.includes("geojson") || s.includes("geo+json")) return "geojson";
  if (s.includes("zip") || s === "gz" || s === "gzip" || s.includes("tar")) return "zip";
  if (/(^|[^a-z])(xlsx?|ods|excel|spreadsheet)([^a-z]|$)/.test(s) || s.includes("officedocument.spreadsheet") || s.includes("ms-excel"))
    return "xlsx";
  if (s.includes("parquet")) return "parquet";
  if (s.includes("pdf")) return "pdf";
  if (/(^|[^a-z])(csv|tsv)([^a-z]|$)/.test(s) || s === "text/csv" || s.includes("comma-separated")) return "csv";
  if (s.includes("json")) return "json";
  if (/(^|[^a-z])(html?|php|aspx?|jsp)([^a-z]|$)/.test(s) || s.includes("text/html")) return "html";
  if (/(^|[^a-z])(wms|wmts|wfs|wcs|api|service|sparql|esri|rest|ogc|oai-pmh)([^a-z]|$)/.test(s)) return "service";
  if (/(^|[^a-z])(xml|rdf|kml|kmz|gml|interlis|xtf|atom|rss|ttl|turtle|n-triples)([^a-z]|$)/.test(s)) return "xml";
  return undefined;
}

/** Best URL to download a resource from (download_url wins over url). */
export function resourceUrl(r: CkanResource): string | undefined {
  const pick = (x: string | null | undefined) => (typeof x === "string" && x.trim() ? x.trim() : undefined);
  return pick(r.download_url) ?? pick(r.url);
}

/** Classify a resource by declared format, media type and URL extension. */
export function classifyResource(r: CkanResource): ResourceKind {
  const url = resourceUrl(r);
  const ext = extOf(url);
  // A zipped file is a zip regardless of the declared payload format.
  if (["zip", "gz", "7z", "tar", "tgz"].includes(ext)) return "zip";
  const fromFormat = kindFromToken(r.format ?? "");
  if (fromFormat) return fromFormat;
  const fromMedia = kindFromToken(r.media_type ?? r.mimetype ?? "");
  if (fromMedia) return fromMedia;
  const fromExt = kindFromToken(ext);
  if (fromExt) return fromExt;
  return (r.format ?? "").trim() ? "other" : "unknown";
}

const KIND_SCORE: Partial<Record<ResourceKind, number>> = { csv: 30, json: 20, geojson: 10, unknown: 1 };

export interface ResourceChoice {
  index: number;
  title?: string;
  format?: string;
  kind: ResourceKind;
  url?: string;
  licence?: string;
  resource: CkanResource;
}

export interface SkippedResource {
  index: number;
  title?: string;
  format?: string;
  kind: ResourceKind;
  url?: string;
  reason: string;
}

function skipReason(kind: ResourceKind): string {
  switch (kind) {
    case "html":
      return "landing page / HTML, not a data file";
    case "zip":
      return "compressed archive (ZIP) — download and unpack manually";
    case "xlsx":
      return "spreadsheet (XLS/XLSX/ODS) — not parsed; look for a CSV twin";
    case "pdf":
      return "PDF document";
    case "service":
      return "web service / API endpoint (WMS/WFS/SPARQL…), not a file";
    case "xml":
      return "XML/RDF/KML/INTERLIS — not parsed";
    case "parquet":
      return "Parquet (binary) — not parsed";
    default:
      return "format not machine-readable by Swissyphus";
  }
}

export function toChoice(r: CkanResource, index: number, lang = "en"): ResourceChoice {
  return {
    index,
    title: pickLang(r.title, lang) ?? pickLang(r.name, lang),
    format: r.format || undefined,
    kind: classifyResource(r),
    url: resourceUrl(r),
    licence: describeLicence(r.license || r.rights),
    resource: r,
  };
}

/**
 * Rank a dataset's resources for tabular querying. Returns parseable
 * candidates (best first) and the resources that were skipped, with reasons.
 * `prefer` boosts one kind (e.g. "json").
 */
export function rankResources(
  resources: CkanResource[],
  opts: { prefer?: string; lang?: string } = {},
): { candidates: ResourceChoice[]; skipped: SkippedResource[] } {
  const candidates: ResourceChoice[] = [];
  const skipped: SkippedResource[] = [];
  resources.forEach((r, i) => {
    const c = toChoice(r, i, opts.lang);
    if (!c.url) {
      skipped.push({ index: i, title: c.title, format: c.format, kind: c.kind, reason: "no download URL" });
    } else if (PARSEABLE_KINDS.has(c.kind) || c.kind === "unknown") {
      candidates.push(c);
    } else {
      skipped.push({ index: i, title: c.title, format: c.format, kind: c.kind, url: c.url, reason: skipReason(c.kind) });
    }
  });
  const score = (c: ResourceChoice) =>
    (KIND_SCORE[c.kind] ?? 0) + (opts.prefer && c.kind === opts.prefer.toLowerCase() ? 100 : 0) + (c.resource.download_url ? 1 : 0);
  candidates.sort((a, b) => score(b) - score(a) || a.index - b.index);
  return { candidates, skipped };
}

/**
 * Resolve an explicit resource selector: a 0-based index ("2"), a CKAN
 * resource id, or a case-insensitive substring of the resource title/name.
 */
export function findResource(resources: CkanResource[], selector: string, lang = "en"): ResourceChoice | undefined {
  const s = selector.trim();
  if (/^\d+$/.test(s)) {
    const i = Number(s);
    return resources[i] ? toChoice(resources[i], i, lang) : undefined;
  }
  const byId = resources.findIndex((r) => r.id === s);
  if (byId >= 0) return toChoice(resources[byId], byId, lang);
  const needle = s.toLowerCase();
  const byName = resources.findIndex((r) =>
    [r.title, r.name].some((t) => {
      if (!t) return false;
      if (typeof t === "string") return t.toLowerCase().includes(needle);
      return Object.values(t).some((x) => typeof x === "string" && x.toLowerCase().includes(needle));
    }),
  );
  return byName >= 0 ? toChoice(resources[byName], byName, lang) : undefined;
}

export function skippedOf(c: ResourceChoice): SkippedResource {
  return { index: c.index, title: c.title, format: c.format, kind: c.kind, url: c.url, reason: skipReason(c.kind) };
}

// ── Licences ──────────────────────────────────────────────────────────────

const TERMS: Record<string, string> = {
  terms_open: "Open use",
  terms_by: "Open use. Must provide the source.",
  terms_ask: "Open use. Use for commercial purposes requires permission of the data owner.",
  terms_by_ask:
    "Open use. Must provide the source. Use for commercial purposes requires permission of the data owner.",
};

const RIGHTS: Record<string, string> = {
  "noncommercialallowed-commercialallowed-referencenotrequired": "terms_open",
  "noncommercialallowed-commercialallowed-referencerequired": "terms_by",
  "noncommercialallowed-commercialwithpermission-referencenotrequired": "terms_ask",
  "noncommercialallowed-commercialwithpermission-referencerequired": "terms_by_ask",
};

/**
 * Human-readable licence from an opendata.swiss `license` URL
 * (…/terms-of-use#terms_by), a legacy `rights` code, or a CKAN license id.
 */
export function describeLicence(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;
  const hash = s.match(/#(terms_[a-z_]+)$/i)?.[1]?.toLowerCase();
  const key = hash ?? (TERMS[s.toLowerCase()] ? s.toLowerCase() : RIGHTS[s.toLowerCase()]);
  if (key && TERMS[key]) return `${TERMS[key]} (opendata.swiss ${key})`;
  if (/cc-?zero|\bcc0\b/i.test(s)) return "CC0 1.0 — public domain dedication (cc-zero)";
  return s;
}

// ── Search URL building ───────────────────────────────────────────────────

export const SEARCH_SORTS = {
  relevance: "score desc, metadata_modified desc",
  modified: "metadata_modified desc",
  created: "metadata_created desc",
  name: "name asc",
} as const;
export type SearchSort = keyof typeof SEARCH_SORTS;

/** Keep only characters that are safe inside a quoted Solr term. */
export function sanitizeSolrTerm(s: string): string {
  return s.replace(/[^\p{L}\p{N} ._+\-/]/gu, "").trim().slice(0, 100);
}

/** Case variants for a format name, since publishers are inconsistent (CSV/csv, GeoJSON/GEOJSON). */
export function formatVariants(fmt: string): string[] {
  const f = sanitizeSolrTerm(fmt);
  if (!f) return [];
  const known: Record<string, string> = { geojson: "GeoJSON", json: "JSON", csv: "CSV", xlsx: "XLSX", xls: "XLS", zip: "ZIP", pdf: "PDF", xml: "XML", parquet: "Parquet" };
  return [...new Set([f, f.toUpperCase(), f.toLowerCase(), known[f.toLowerCase()] ?? f])];
}

export function buildSearchUrl(
  portal: CkanPortal,
  opts: { query?: string; publisher?: string; format?: string; sort?: SearchSort; rows: number; start?: number },
): string {
  const url = new URL(`${portal.apiBase}/package_search`);
  // Strip control characters; free-text q is CKAN's documented user query.
  const q = (opts.query ?? "").replace(/[\u0000-\u001f]/g, " ").trim();
  url.searchParams.set("q", q || "*:*");
  url.searchParams.set("rows", String(opts.rows));
  if (opts.start) url.searchParams.set("start", String(opts.start));
  const fq: string[] = [];
  if (opts.publisher) {
    const p = opts.publisher.toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (p) fq.push(`organization:"${p}"`);
  }
  if (opts.format) {
    const v = formatVariants(opts.format);
    if (v.length) fq.push(`res_format:(${v.map((x) => `"${x}"`).join(" OR ")})`);
  }
  if (fq.length) url.searchParams.set("fq", fq.join(" AND "));
  if (opts.sort && opts.sort !== "relevance") url.searchParams.set("sort", SEARCH_SORTS[opts.sort]);
  else if (!q) url.searchParams.set("sort", SEARCH_SORTS.modified);
  return url.toString();
}

/** Unique, upper-cased resource formats of a dataset. */
export function datasetFormats(d: CkanDataset): string[] {
  const out = new Set<string>();
  for (const r of d.resources ?? []) {
    const f = (r.format ?? "").trim();
    if (f) out.add(f.toUpperCase());
  }
  return [...out].slice(0, 12);
}

export function hasQueryableResource(d: CkanDataset): boolean {
  return (d.resources ?? []).some((r) => resourceUrl(r) && PARSEABLE_KINDS.has(classifyResource(r)));
}

// ── Aggregation ───────────────────────────────────────────────────────────

export type AggOp = "count" | "sum" | "avg" | "min" | "max";

export interface AggregateSpec {
  groupBy?: string[];
  op: AggOp;
  valueColumn?: string;
  search?: string;
  where?: Record<string, string>;
  /** desc/asc by aggregated value (default desc), or "group" to sort by group key. */
  order?: "desc" | "asc" | "group";
  limit?: number;
}

export interface AggregateResult {
  op: AggOp;
  group_by: string[];
  value_column?: string;
  rows_matched: number;
  rows_used: number;
  rows_skipped_non_numeric: number;
  total_groups: number;
  groups: Row[];
  unknown_columns: string[];
}

/**
 * Parse a number from a cell, tolerating Swiss formatting: apostrophe /
 * thin-space thousands separators ("1'234.5", "1 234") and decimal commas
 * ("12,5"). Returns NaN for non-numeric cells.
 */
export function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return NaN;
  const s = v.trim().replace(/['’   ]/g, "");
  if (/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) return Number(s);
  if (/^[-+]?\d+,\d+$/.test(s)) return Number(s.replace(",", "."));
  return NaN;
}

const round = (x: number) => (Number.isFinite(x) ? Number(x.toPrecision(12)) : x);

/**
 * Group rows by up to two columns and compute count/sum/avg/min/max of a
 * numeric column, after an optional search/where filter (same syntax as
 * queryRows). Pure.
 */
export function aggregateRows(table: Table, spec: AggregateSpec): AggregateResult {
  const unknown: string[] = [];
  const groupCols: string[] = [];
  for (const g of spec.groupBy ?? []) {
    const c = resolveColumn(table.columns, g);
    if (c) groupCols.push(c);
    else unknown.push(g);
  }
  let valueCol: string | undefined;
  if (spec.op !== "count" || spec.valueColumn) {
    if (!spec.valueColumn) unknown.push("(value_column required for " + spec.op + ")");
    else {
      valueCol = resolveColumn(table.columns, spec.valueColumn);
      if (!valueCol) unknown.push(spec.valueColumn);
    }
  }
  const filtered = queryRows(table, {
    search: spec.search,
    where: spec.where,
    offset: 0,
    limit: Number.MAX_SAFE_INTEGER,
  });
  unknown.push(...filtered.unknown_columns);
  const base = {
    op: spec.op,
    group_by: groupCols,
    ...(valueCol ? { value_column: valueCol } : {}),
    rows_matched: filtered.total,
  };
  if (unknown.length) {
    return { ...base, rows_used: 0, rows_skipped_non_numeric: 0, total_groups: 0, groups: [], unknown_columns: unknown };
  }

  interface Acc {
    key: unknown[];
    count: number;
    n: number;
    sum: number;
    min: number;
    max: number;
  }
  const groups = new Map<string, Acc>();
  let used = 0;
  let skipped = 0;
  for (const r of filtered.rows) {
    const keyVals = groupCols.map((c) => (r[c] === undefined ? null : r[c]));
    const k = JSON.stringify(keyVals);
    let a = groups.get(k);
    if (!a) {
      a = { key: keyVals, count: 0, n: 0, sum: 0, min: Infinity, max: -Infinity };
      groups.set(k, a);
    }
    a.count++;
    if (valueCol) {
      const x = toNumber(r[valueCol]);
      if (Number.isNaN(x)) {
        skipped++;
        continue;
      }
      a.n++;
      a.sum += x;
      if (x < a.min) a.min = x;
      if (x > a.max) a.max = x;
    }
    used++;
  }

  const valueOf = (a: Acc): number | null => {
    switch (spec.op) {
      case "count":
        return valueCol ? a.n : a.count;
      case "sum":
        return a.n ? round(a.sum) : null;
      case "avg":
        return a.n ? round(a.sum / a.n) : null;
      case "min":
        return a.n ? a.min : null;
      case "max":
        return a.n ? a.max : null;
    }
  };
  const out = [...groups.values()].map((a) => ({ a, v: valueOf(a) }));
  const order = spec.order ?? "desc";
  if (order === "group") {
    out.sort((x, y) => {
      for (let i = 0; i < groupCols.length; i++) {
        const p = x.a.key[i];
        const q = y.a.key[i];
        if (p === q) continue;
        if (p === null) return 1;
        if (q === null) return -1;
        const c = typeof p === "number" && typeof q === "number" ? p - q : String(p).localeCompare(String(q), "de", { numeric: true });
        if (c) return c;
      }
      return 0;
    });
  } else {
    out.sort((x, y) => {
      if (x.v === y.v) return 0;
      if (x.v === null) return 1;
      if (y.v === null) return -1;
      return order === "asc" ? x.v - y.v : y.v - x.v;
    });
  }
  const limit = spec.limit ?? 50;
  const rows: Row[] = out.slice(0, limit).map(({ a, v }) => {
    const row: Row = {};
    groupCols.forEach((c, i) => (row[c] = a.key[i]));
    row.count = a.count;
    if (spec.op !== "count" || valueCol) row[spec.op === "count" ? "count_numeric" : spec.op] = v;
    return row;
  });
  return {
    ...base,
    rows_used: used,
    rows_skipped_non_numeric: skipped,
    total_groups: groups.size,
    groups: rows,
    unknown_columns: [],
  };
}

// ── Response-size discipline ──────────────────────────────────────────────

/**
 * Trim long cell strings and drop trailing rows until the rows serialise
 * under `budget` characters, so the envelope never hits the 50 KB cap.
 */
export function fitRows(rows: Row[], budget = 38_000, maxCell = 400): { rows: Row[]; dropped: number; trimmedCells: number } {
  let trimmedCells = 0;
  const trimmed = rows.map((r) => {
    const o: Row = {};
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === "string" && v.length > maxCell) {
        o[k] = v.slice(0, maxCell) + "…";
        trimmedCells++;
      } else o[k] = v;
    }
    return o;
  });
  let size = JSON.stringify(trimmed).length;
  let n = trimmed.length;
  while (n > 0 && size > budget) {
    size -= JSON.stringify(trimmed[n - 1]).length + 1;
    n--;
  }
  return { rows: trimmed.slice(0, n), dropped: trimmed.length - n, trimmedCells };
}

// ── Input caps (shared by the query/describe/aggregate schemas) ───────────

/** Max column filters in a `where` object. */
export const MAX_WHERE_KEYS = 20;
/** Max entries in a `columns` selection. */
export const MAX_SELECTED_COLUMNS = 50;
/** Max length of a column name (or other short selector) in tool input. */
export const MAX_COLUMN_NAME = 200;

/** Budget for describe_dataset_columns' data payload (envelope withholds > 50 KB). */
export const DESCRIBE_BUDGET = 44_000;

export interface ColumnProfile {
  column: string;
  type: string;
  non_null: number;
  examples: unknown[];
}

const clip = (v: unknown, n: number) => (typeof v === "string" && v.length > n ? v.slice(0, n) + "…" : v);

/**
 * Fit a column profile under `budget` serialised characters: first shorten
 * example values and use fewer of them, then profile fewer columns. `build`
 * assembles the full payload from the shown profiles, the numeric column
 * names and extra notes, so fixed parts of the response count too.
 */
export function fitColumnProfiles<T>(
  profiles: ColumnProfile[],
  build: (columns: ColumnProfile[], numericColumns: string[], notes: string[]) => T,
  opts: { budget?: number; maxColumns?: number } = {},
): T {
  const budget = opts.budget ?? DESCRIBE_BUDGET;
  const maxColumns = opts.maxColumns ?? 150;
  const total = profiles.length;
  // [examples per column, example length]
  const stages: Array<[number, number]> = [
    [Infinity, 80],
    [3, 60],
    [2, 40],
    [1, 30],
    [0, 0],
  ];
  const shape = (n: number, ex: number, len: number) =>
    profiles.slice(0, n).map((p) => ({
      ...p,
      column: clip(p.column, MAX_COLUMN_NAME) as string,
      examples: p.examples.slice(0, ex).map((v) => clip(v, len)),
    }));
  const numericOf = (cols: ColumnProfile[]) => cols.filter((p) => p.type === "number").map((p) => p.column);
  const assemble = (n: number, stage: number) => {
    const [ex, len] = stages[stage];
    const cols = shape(n, ex, len);
    const notes: string[] = [];
    if (n < total) notes.push(`Only the first ${n} of ${total} columns are profiled${n < Math.min(total, maxColumns) ? " (response size cap)" : ""}.`);
    if (stage > 0) notes.push(`Example values were shortened/reduced to keep the response under ~45 KB.`);
    return build(cols, numericOf(cols), notes);
  };
  let n = Math.min(total, maxColumns);
  for (let s = 0; s < stages.length; s++) {
    const out = assemble(n, s);
    if (JSON.stringify(out).length <= budget) return out;
  }
  const last = stages.length - 1;
  let out = assemble(n, last);
  while (n > 0 && JSON.stringify(out).length > budget) {
    n = Math.floor(n * 0.75);
    out = assemble(n, last);
  }
  return out;
}
