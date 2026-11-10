/**
 * Statistics / open data module: opendata.swiss, the Swiss federal open
 * government data catalogue (CKAN API), plus the City of Zürich CKAN portal.
 * Gateway to 12'000+ datasets from BFS, FOEN, swisstopo, cantons and cities,
 * with actual data access: the best machine-readable resource of a dataset
 * is fetched from its publisher, parsed (CSV / JSON / GeoJSON) and can be
 * filtered, profiled and aggregated.
 */

import { z } from "zod";
import { allowHosts, fetchJson, fetchPublicResource, SourceError, TooLargeError, sourceCache } from "../core/http.js";
export { pickLang } from "./ckanPortals.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { CacheStatus, SourceManifest } from "../core/types.js";
import { parseResource, profileColumns, queryRows, type Table } from "../core/tabular.js";
import { registerSearcher, type DataHit } from "../core/discovery.js";
import { heavyParse } from "../core/limit.js";
import { allowArbitraryUrls } from "../core/policy.js";
import {
  PORTALS,
  PORTAL_IDS,
  LANGS,
  SEARCH_SORTS,
  aggregateRows,
  buildSearchUrl,
  datasetFormats,
  describeLicence,
  findResource,
  fitRows,
  fitColumnProfiles,
  getPortal,
  MAX_WHERE_KEYS,
  MAX_SELECTED_COLUMNS,
  MAX_COLUMN_NAME,
  hasQueryableResource,
  pickLang,
  rankResources,
  resourceUrl,
  classifyResource,
  skippedOf,
  PARSEABLE_KINDS,
  type CkanDataset,
  type CkanOrganization,
  type CkanPortal,
  type ResourceChoice,
  type SearchSort,
  type SkippedResource,
} from "./ckanPortals.js";

allowHosts("ckan.opendata.swiss", "opendata.swiss", "data.stadt-zuerich.ch", "www.envidat.ch", "www.pxweb.bfs.admin.ch");

const source = PORTALS["opendata.swiss"].source;
const zurichSource = PORTALS["stadt-zuerich"].source;

/** Ceiling for a single fetched resource file. */
const RESOURCE_MAX_BYTES = 15 * 1024 * 1024;
/** Rows parsed per resource (beyond this the table is truncated and flagged). */
const RESOURCE_MAX_ROWS = 100_000;

// ── CKAN access ───────────────────────────────────────────────────────────

/** opendata.swiss (CKAN) regularly needs 10–20 s for search/package_show; 15–20 s cut it off. */
const CKAN_TIMEOUT_MS = 25_000;

interface CkanEnvelope<T> {
  success?: boolean;
  result?: T;
  error?: { message?: string; __type?: string };
}

async function ckan<T>(url: string, portal: CkanPortal, ttlSeconds = portal.source.cacheTtlSeconds) {
  const res = await fetchJson<CkanEnvelope<T>>(url, {
    ...sourceCache({ cacheTtlSeconds: ttlSeconds, maxStaleSeconds: portal.source.maxStaleSeconds }),
    timeoutMs: CKAN_TIMEOUT_MS,
  });
  if (res.data?.success === false) {
    const host = new URL(url).hostname;
    throw new SourceError(`CKAN error: ${res.data.error?.message ?? res.data.error?.__type ?? "unknown"}`, host);
  }
  return { result: res.data?.result, cacheStatus: res.cacheStatus, retrievedAt: res.retrievedAt };
}

async function showDataset(portal: CkanPortal, id: string) {
  const url = `${portal.apiBase}/package_show?id=${encodeURIComponent(id)}`;
  return ckan<CkanDataset>(url, portal);
}

export function compactDataset(d: CkanDataset, portal: CkanPortal, lang = "en", withResources = false) {
  const resources = d.resources ?? [];
  return {
    id: d.name,
    title: pickLang(d.title, lang),
    publisher: pickLang(d.organization?.title ?? d.organization?.display_name, lang),
    publisher_id: d.organization?.name,
    modified: d.metadata_modified?.slice(0, 10),
    description: pickLang(d.notes ?? d.description, lang)?.slice(0, withResources ? 2000 : 240),
    url: d.name ? portal.datasetUrl(d.name, lang) : undefined,
    ...(portal.id !== "opendata.swiss" ? { portal: portal.id } : {}),
    ...(withResources
      ? {
          licence: describeLicence(d.license_title ?? d.license_id),
          resource_count: resources.length,
          resources: resources.slice(0, 25).map((r, i) => {
            const kind = classifyResource(r);
            return {
              index: i,
              title: pickLang(r.title, lang) ?? pickLang(r.name, lang),
              format: r.format,
              queryable: PARSEABLE_KINDS.has(kind) && !!resourceUrl(r),
              licence: describeLicence(r.license || r.rights),
              download_url: resourceUrl(r),
            };
          }),
        }
      : {
          formats: datasetFormats(d),
          queryable: hasQueryableResource(d),
        }),
  };
}

// ── Resource loading (fetch + parse, small parsed-table cache) ────────────

interface LoadedTable {
  table: Table;
  cacheStatus: CacheStatus;
  retrievedAt: string;
  finalUrl: string;
}

const TABLE_CACHE_MAX = 3;
/**
 * Parsed tables are far larger in memory than their source text, so the cache
 * is bounded by the total number of cached rows, not just the entry count.
 */
const TABLE_CACHE_MAX_ROWS_DEFAULT = 300_000;
let tableCacheMaxRows = TABLE_CACHE_MAX_ROWS_DEFAULT;
const TABLE_CACHE_TTL_MS = 10 * 60_000;
const tableCache = new Map<string, { at: number; rows: number; value: LoadedTable }>();
let tableCacheRows = 0;

function tableCacheDelete(key: string): void {
  const e = tableCache.get(key);
  if (!e) return;
  tableCache.delete(key);
  tableCacheRows -= e.rows;
}

function tableCachePut(key: string, value: LoadedTable): void {
  tableCacheDelete(key);
  const rows = value.table.rows.length;
  // A table bigger than the whole budget is served but never cached.
  if (rows > tableCacheMaxRows) return;
  tableCache.set(key, { at: Date.now(), rows, value });
  tableCacheRows += rows;
  while (tableCache.size > TABLE_CACHE_MAX || tableCacheRows > tableCacheMaxRows) {
    const oldest = tableCache.keys().next().value;
    if (oldest === undefined) break;
    tableCacheDelete(oldest);
  }
}

/** Parsed-table cache footprint (tests / diagnostics). */
export function tableCacheStats(): { entries: number; rows: number; maxRows: number } {
  return { entries: tableCache.size, rows: tableCacheRows, maxRows: tableCacheMaxRows };
}

/** Test hook: override the row budget of the parsed-table cache (undefined = default) and clear it. */
export function setTableCacheMaxRowsForTests(rows: number | undefined): void {
  tableCacheMaxRows = rows ?? TABLE_CACHE_MAX_ROWS_DEFAULT;
  tableCache.clear();
  tableCacheRows = 0;
}

async function loadTable(url: string, formatHint?: string): Promise<LoadedTable> {
  const key = `${formatHint ?? ""} ${url}`;
  const hit = tableCache.get(key);
  if (hit && Date.now() - hit.at < TABLE_CACHE_TTL_MS) return { ...hit.value, cacheStatus: "hit" };
  // Download + parse of a multi-MB file is CPU/memory heavy: run it through
  // the shared limiter so a burst of such requests cannot starve the server.
  const value = await heavyParse(async (): Promise<LoadedTable> => {
    const res = await fetchPublicResource(url, { maxBytes: RESOURCE_MAX_BYTES, timeoutMs: 45_000 });
    const table = parseResource(res.data, { format: formatHint, contentType: res.contentType, maxRows: RESOURCE_MAX_ROWS });
    return { table, cacheStatus: res.cacheStatus, retrievedAt: res.retrievedAt, finalUrl: res.finalUrl };
  });
  tableCachePut(key, value);
  return value;
}

function kindHint(kind: string | undefined): string | undefined {
  return kind === "csv" || kind === "json" || kind === "geojson" ? kind : undefined;
}

interface Target {
  table: Table;
  cacheStatus: CacheStatus;
  retrievedAt: string;
  manifest: SourceManifest;
  dataAsOf?: string;
  dataset?: { id?: string; title?: string; publisher?: string; url?: string; portal: string };
  resource: { index?: number; title?: string; format?: string; url: string };
  licence?: string;
  notes: string[];
  skipped: SkippedResource[];
}

type Resolved = { ok: true; target: Target } | { ok: false; result: ReturnType<typeof toolError> };

interface TargetArgs {
  id?: string;
  resource_url?: string;
  portal?: string;
  resource?: string;
  format?: string;
  lang?: string;
}

function isTruncated(t: Table): boolean {
  return (t.notes ?? []).some((n) => n.includes("truncated"));
}

function describeLoadError(err: unknown): string {
  if (err instanceof TooLargeError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Shared by query_dataset / describe_dataset_columns / aggregate_dataset:
 * resolve a dataset id (or direct resource URL) to a parsed table.
 */
async function resolveTarget(args: TargetArgs): Promise<Resolved> {
  const lang = args.lang ?? "en";
  const portal = getPortal(args.portal);
  const prefer = args.format;

  if (args.resource_url) {
    if (!allowArbitraryUrls()) {
      return {
        ok: false,
        result: toolError(
          "Direct 'resource_url' downloads are disabled on this deployment: it only reads resources listed in the catalogue. Pass the dataset 'id' instead (optionally with 'resource').",
          [
            "Find the dataset with search_datasets, then call this tool with {id: '<dataset-id>', resource: '<index from get_dataset>'}.",
            "Server operators can allow arbitrary resource URLs by setting SWISSYPHUS_ALLOW_RESOURCE_URL=1.",
          ],
        ),
      };
    }
    let u: URL;
    try {
      u = new URL(args.resource_url);
    } catch {
      return { ok: false, result: toolError(`'${args.resource_url}' is not a valid URL.`) };
    }
    const kind = classifyResource({ url: u.toString(), format: prefer });
    if (!PARSEABLE_KINDS.has(kind) && kind !== "unknown") {
      return {
        ok: false,
        result: toolError(`Resource looks like ${kind.toUpperCase()}, which Swissyphus cannot parse (CSV, JSON and GeoJSON only).`, [
          `Download it directly: ${u.toString()}`,
          "If it is actually CSV/JSON, pass format='csv' or format='json' to override.",
        ]),
      };
    }
    try {
      const loaded = await loadTable(u.toString(), kindHint(kind));
      return {
        ok: true,
        target: {
          ...loaded,
          manifest: {
            id: "publisher-resource",
            name: `Open-data resource on ${u.hostname}`,
            operator: `Publisher operating ${u.hostname}`,
            url: u.toString(),
            licence: "As stated by the publisher; check the catalogue entry for this resource",
            attribution: `Data © the publisher at ${u.hostname}`,
            updateFrequency: "unknown",
            cacheTtlSeconds: 3600,
          },
          resource: { url: loaded.finalUrl, format: loaded.table.format },
          notes: [],
          skipped: [],
        },
      };
    } catch (err) {
      return { ok: false, result: loadFailure([{ url: u.toString(), error: describeLoadError(err) }], [], err) };
    }
  }

  if (!args.id) {
    return {
      ok: false,
      result: toolError("Provide either 'id' (dataset slug from search_datasets) or 'resource_url'.", [
        "Find datasets with search_datasets, e.g. {query: 'Bevölkerung Gemeinde', format: 'CSV'}.",
      ]),
    };
  }

  let meta: Awaited<ReturnType<typeof showDataset>>;
  try {
    meta = await showDataset(portal, args.id);
  } catch (err) {
    if (err instanceof SourceError && err.status === 404) {
      return { ok: false, result: notFound(args.id, portal) };
    }
    return { ok: false, result: errorToResult(err, portal.catalogue) as ReturnType<typeof toolError> };
  }
  const d = meta.result;
  if (!d) return { ok: false, result: notFound(args.id, portal) };
  const resources = d.resources ?? [];
  const { candidates, skipped } = rankResources(resources, { prefer, lang });

  let queue: ResourceChoice[];
  if (args.resource !== undefined && args.resource !== "") {
    const chosen = findResource(resources, args.resource, lang);
    if (!chosen) {
      return {
        ok: false,
        result: toolError(`Dataset '${args.id}' has no resource matching '${args.resource}'.`, [
          `Resources are indexed 0..${Math.max(0, resources.length - 1)}; see get_dataset for the list.`,
        ]),
      };
    }
    if (!chosen.url || (!PARSEABLE_KINDS.has(chosen.kind) && chosen.kind !== "unknown")) {
      const s = skippedOf(chosen);
      return {
        ok: false,
        result: toolError(`Resource ${chosen.index} (${chosen.format ?? chosen.kind}) is not parseable: ${s.reason}.`, [
          ...(chosen.url ? [`Download it directly: ${chosen.url}`] : []),
          ...(candidates.length ? [`Queryable alternatives: ${candidates.map((c) => `#${c.index} ${c.format ?? c.kind}`).join(", ")}`] : []),
        ]),
      };
    }
    queue = [chosen];
  } else {
    queue = candidates.slice(0, 3);
  }

  if (!queue.length) {
    return {
      ok: false,
      result: toolError(`Dataset '${args.id}' has no machine-readable resource (CSV/JSON/GeoJSON) Swissyphus can parse.`, [
        ...skipped.slice(0, 10).map((s) => `#${s.index} ${s.format ?? s.kind}: ${s.reason}${s.url ? `, ${s.url}` : ""}`),
        "Look for a related dataset with format='CSV' via search_datasets.",
      ]),
    };
  }

  const attempts: Array<{ url: string; error: string }> = [];
  for (const c of queue) {
    try {
      const loaded = await loadTable(c.url!, kindHint(c.kind));
      const publisher = pickLang(d.organization?.title ?? d.organization?.display_name, lang);
      const licence = c.licence ?? describeLicence(d.license_title ?? d.license_id);
      return {
        ok: true,
        target: {
          table: loaded.table,
          cacheStatus: loaded.cacheStatus === "hit" && meta.cacheStatus === "hit" ? "hit" : loaded.cacheStatus,
          retrievedAt: loaded.retrievedAt,
          manifest: {
            ...portal.source,
            licence: licence ?? portal.source.licence,
            attribution: publisher ? `© ${publisher}, via ${portal.catalogue}` : portal.source.attribution,
          },
          dataAsOf: d.metadata_modified,
          dataset: { id: d.name, title: pickLang(d.title, lang), publisher, url: d.name ? portal.datasetUrl(d.name, lang) : undefined, portal: portal.id },
          resource: { index: c.index, title: c.title, format: c.format ?? loaded.table.format, url: loaded.finalUrl },
          licence,
          notes: attempts.map((a) => `Skipped ${a.url}: ${a.error}`),
          skipped,
        },
      };
    } catch (err) {
      attempts.push({ url: c.url!, error: describeLoadError(err) });
    }
  }
  return { ok: false, result: loadFailure(attempts, skipped) };
}

function notFound(id: string, portal: CkanPortal) {
  return toolError(`Dataset '${id}' not found on ${portal.catalogue}.`, [
    "Use the exact dataset ID (slug) returned by search_datasets (with the same 'portal').",
  ]);
}

function loadFailure(attempts: Array<{ url: string; error: string }>, skipped: SkippedResource[], err?: unknown) {
  const tooLarge = err instanceof TooLargeError || attempts.some((a) => /too large/i.test(a.error));
  return toolError(
    `Could not load a parseable resource: ${attempts.map((a) => `${a.url} → ${a.error}`).join(" | ")}`,
    [
      ...(tooLarge ? ["The file exceeds the 15 MB limit; download it directly or pick a smaller resource via 'resource'."] : []),
      "Pick another resource with 'resource' (index from get_dataset) or pass a different 'format'.",
      ...skipped.slice(0, 5).map((s) => `Not parseable: #${s.index} ${s.format ?? s.kind}${s.url ? `, ${s.url}` : ""}`),
    ],
  );
}

// ── Shared input schema pieces ────────────────────────────────────────────

const portalParam = z
  .enum(PORTAL_IDS)
  .optional()
  .describe("Catalogue: 'opendata.swiss' (default, national), 'stadt-zuerich' (City of Zürich, data.stadt-zuerich.ch) or 'envidat' (WSL/ETH environmental research data: snow, glaciers, forests, biodiversity, climate)");
const langParam = z.enum(LANGS).optional().describe("Language for titles/descriptions: de, fr, it or en (default en; falls back to de)");
const targetShape = {
  id: z.string().optional().describe("Dataset ID (slug): the 'id' of a search_datasets hit"),
  resource_url: z
    .string()
    .url()
    .optional()
    .describe(
      "Alternatively, a direct https URL of a CSV/JSON/GeoJSON file (e.g. a download_url from get_dataset). May be disabled on public deployments, prefer 'id'",
    ),
  portal: portalParam,
  resource: z
    .string()
    .max(MAX_COLUMN_NAME)
    .optional()
    .describe("Optional resource selector: 0-based index from get_dataset, resource id, or part of its title. Default: best CSV > JSON > GeoJSON"),
  format: z.enum(["csv", "json", "geojson"]).optional().describe("Preferred resource format (overrides the CSV-first default)"),
  lang: langParam,
};
const columnName = z.string().max(MAX_COLUMN_NAME);
const whereParam = z
  .record(z.string(), z.union([z.string().max(500), z.number(), z.boolean()]))
  .refine((w) => Object.keys(w).length <= MAX_WHERE_KEYS, { message: `At most ${MAX_WHERE_KEYS} column filters are allowed in 'where'.` })
  .refine((w) => Object.keys(w).every((k) => k.length <= MAX_COLUMN_NAME), { message: `Column names in 'where' are limited to ${MAX_COLUMN_NAME} characters.` })
  .optional()
  .describe("Column filters: {column: value}. Exact (case-insensitive) match; prefix '~' for substring, '>'/'<' for numeric compare, e.g. {\"Kanton\": \"ZH\", \"Jahr\": \">2019\"}");

function whereStrings(w: Record<string, string | number | boolean> | undefined): Record<string, string> | undefined {
  if (!w) return undefined;
  return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, String(v)]));
}

function tableNotes(t: Table, extra: string[] = []): string[] {
  const notes = [...extra];
  if (isTruncated(t)) notes.push(`Only the first ${RESOURCE_MAX_ROWS.toLocaleString("en")} rows of the file were parsed; totals cover those rows only.`);
  return notes;
}

// ── Publishers ────────────────────────────────────────────────────────────

async function fetchAllOrganizations(portal: CkanPortal): Promise<{ orgs: CkanOrganization[]; cacheStatus: CacheStatus; retrievedAt: string }> {
  // CKAN caps organization_list?all_fields=true per call
  // (ckan.group_and_organization_list_all_fields_max, default 25), so page.
  const page = (offset: number, limit: number) =>
    ckan<CkanOrganization[]>(
      `${portal.apiBase}/organization_list?all_fields=true&limit=${limit}&offset=${offset}&sort=${encodeURIComponent("name asc")}`,
      portal,
      24 * 3600,
    );
  const first = await page(0, 1000);
  const orgs: CkanOrganization[] = [...(first.result ?? [])];
  const seen = new Set(orgs.map((o) => o.name));
  const size = orgs.length;
  let cacheStatus = first.cacheStatus;
  if (size > 0 && size < 1000) {
    let offset = size;
    for (let round = 0; round < 8; round++) {
      const batch = await Promise.all([0, 1, 2, 3, 4].map((i) => page(offset + i * size, size)));
      let added = 0;
      let short = false;
      for (const b of batch) {
        const rows = b.result ?? [];
        if (b.cacheStatus !== "hit") cacheStatus = b.cacheStatus;
        if (rows.length < size) short = true;
        for (const o of rows) {
          if (!seen.has(o.name)) {
            seen.add(o.name);
            orgs.push(o);
            added++;
          }
        }
      }
      // Stop at the last page, or if the server ignores limit/offset (no new names).
      if (short || added === 0) break;
      offset += 5 * size;
    }
  }
  return { orgs, cacheStatus, retrievedAt: first.retrievedAt };
}

// ── Discovery (find_data) ─────────────────────────────────────────────────

for (const portal of Object.values(PORTALS)) {
  registerSearcher({
    placeAware: true,
    catalogue: portal.catalogue,
    module: "statistics",
    search: async (query: string, limit: number, lang: string): Promise<DataHit[]> => {
      const l = (LANGS as readonly string[]).includes(lang) ? lang : "en";
      const url = buildSearchUrl(portal, { query, rows: Math.min(Math.max(limit, 1), 50) });
      const { result } = await ckan<{ results?: CkanDataset[] }>(url, portal);
      return (result?.results ?? [])
        .filter((d) => d.name)
        .map((d) => {
          const queryable = hasQueryableResource(d);
          const args: Record<string, unknown> = { id: d.name };
          if (portal.id !== "opendata.swiss") args.portal = portal.id;
          return {
            catalogue: portal.catalogue,
            id: d.name!,
            title: pickLang(d.title, l) ?? d.name!,
            description: pickLang(d.notes ?? d.description, l)?.slice(0, 200),
            publisher: pickLang(d.organization?.title ?? d.organization?.display_name, l),
            url: portal.datasetUrl(d.name!, l),
            next: { tool: queryable ? "query_dataset" : "get_dataset", args },
          };
        });
    },
  });
}

// ── Population (BFS PXWeb) ───────────────────────────────────────────────

const bfsPx: SourceManifest = {
  id: "bfs-pxweb",
  name: "BFS STAT-TAB (PXWeb): STATPOP population statistics",
  operator: "Federal Statistical Office (BFS)",
  url: "https://www.pxweb.bfs.admin.ch",
  licence: "Swiss OGD: free use with attribution",
  attribution: "© BFS, STATPOP",
  updateFrequency: "yearly",
  cacheTtlSeconds: 24 * 3600,
  // population tables are annual
  maxStaleSeconds: 400 * 86400,
};

const POP_TABLE = "px-x-0102010000_102";

export interface PxMeta {
  title?: string;
  variables?: Array<{ code?: string; text?: string; values?: string[]; valueTexts?: string[]; time?: boolean }>;
}

export interface PxData {
  data?: Array<{ key?: string[]; values?: string[] }>;
}

/** The PXWeb table no longer has the shape this tool relies on. Surfaced as a tool error, never as silent wrong data. */
export class PxShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PxShapeError";
  }
}

/**
 * Build the STATPOP PXWeb query from live table metadata. Requires a year
 * dimension and a canton dimension; throws PxShapeError otherwise. Other
 * dimensions are pinned to their total ("-99999") when available; a
 * dimension without a total is pinned to its first value and reported in
 * `assumptions` so the caller can surface it.
 */
export function buildPopulationQuery(meta: PxMeta) {
  const variables = meta.variables ?? [];
  if (!variables.length) throw new PxShapeError(`PXWeb table ${POP_TABLE} returned no variables.`);
  const matches = (v: (typeof variables)[number], re: RegExp) => re.test(v.code ?? "") || re.test(v.text ?? "");
  const yearVar = variables.find((v) => v.code === "Jahr") ?? variables.find((v) => v.time === true || matches(v, /^(jahr|year|année|anno)$/i));
  const cantonVar = variables.find((v) => v.code === "Kanton") ?? variables.find((v) => matches(v, /kanton|canton|cantone/i));
  const missing = [!yearVar && "year (Jahr)", !cantonVar && "canton (Kanton)"].filter(Boolean);
  if (missing.length || !yearVar || !cantonVar) {
    throw new PxShapeError(
      `PXWeb table ${POP_TABLE} no longer has the expected dimension(s): ${missing.join(", ")}. Found: ${variables
        .map((v) => v.code)
        .join(", ")}.`,
    );
  }
  const years = yearVar.values ?? [];
  const year = years[years.length - 1];
  if (!year) throw new PxShapeError(`PXWeb table ${POP_TABLE} lists no years.`);
  if (!cantonVar.values?.length) throw new PxShapeError(`PXWeb table ${POP_TABLE} lists no cantons.`);
  const cantonNames = new Map<string, string>();
  cantonVar.values.forEach((v, i) => cantonNames.set(v, cantonVar.valueTexts?.[i] ?? v));

  // Build the query from the live metadata so variable codes (incl. umlauts)
  // always match. Kanton must be selected explicitly; PXWeb eliminates
  // (sums over) any dimension that is omitted.
  const assumptions: string[] = [];
  const query = {
    query: variables.map((v) => {
      const code = v.code ?? "";
      let values: string[];
      if (v === yearVar) values = [year];
      else if (v === cantonVar) values = cantonVar.values ?? [];
      else if (code.toLowerCase().includes("typ")) {
        values = [v.values?.[0] ?? "1"];
        assumptions.push(`${v.text ?? code}: ${v.valueTexts?.[0] ?? values[0]}`);
      } else if (v.values?.includes("-99999")) values = ["-99999"];
      else {
        values = [v.values?.[0] ?? ""];
        assumptions.push(`${v.text ?? code}: ${v.valueTexts?.[0] ?? values[0]} (no total available)`);
      }
      return { code, selection: { filter: "item", values } };
    }),
    response: { format: "json" },
  };
  return { query, year, cantonNames, assumptions };
}

/** Map PXWeb data rows to {region, population}; fails loudly if nothing usable came back. */
export function parsePopulationRows(data: PxData, cantonNames: Map<string, string>) {
  const rows = (data.data ?? [])
    .map((d) => {
      const cantonCode = (d.key ?? []).find((k) => cantonNames.has(k));
      return {
        region: cantonNames.get(cantonCode ?? "") ?? cantonCode ?? "?",
        population: Number(d.values?.[0]),
      };
    })
    .filter((r) => r.region !== "?" && Number.isFinite(r.population));
  if (!rows.length) throw new PxShapeError(`PXWeb table ${POP_TABLE} returned no usable population rows.`);
  return rows;
}

async function fetchPopulation(): Promise<{
  year: string;
  rows: Array<{ region: string; population: number }>;
  assumptions: string[];
  cacheStatus: "hit" | "miss" | "stale" | "computed";
  retrievedAt: string;
}> {
  const metaUrl = `https://www.pxweb.bfs.admin.ch/api/v1/en/${POP_TABLE}/${POP_TABLE}.px`;
  const { data: meta } = await fetchJson<PxMeta>(metaUrl, { ...sourceCache(bfsPx) });
  const { query, year, cantonNames, assumptions } = buildPopulationQuery(meta);
  const { data, cacheStatus, retrievedAt } = await fetchJson<PxData>(metaUrl, {
    ...sourceCache(bfsPx),
    timeoutMs: 30_000,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(query),
    },
  });
  const rows = parsePopulationRows(data, cantonNames);
  return { year, rows, assumptions, cacheStatus, retrievedAt };
}

// ── Module ────────────────────────────────────────────────────────────────

export const statisticsModule: SwissyphusModule = {
  id: "statistics",
  emoji: "📊",
  title: "Statistics & open data",
  description:
    "Search 12'000+ Swiss OGD datasets (opendata.swiss + City of Zürich) and query their actual data: filter, profile and aggregate CSV/JSON/GeoJSON resources",
  sources: [source, zurichSource, PORTALS["envidat"].source, bfsPx],
  healthProbes: [
    { sourceId: "opendata-swiss", url: `${PORTALS["opendata.swiss"].apiBase}/package_search?q=population&rows=1` },
    { sourceId: "stadt-zuerich-ogd", url: `${PORTALS["stadt-zuerich"].apiBase}/package_search?rows=1` },
    { sourceId: "envidat", url: `${PORTALS["envidat"].apiBase}/package_search?rows=1` },
    { sourceId: "bfs-pxweb", url: `https://www.pxweb.bfs.admin.ch/api/v1/en/${POP_TABLE}` },
  ],
  tools: [
    tool({
      name: "get_population",
      title: "Population of Switzerland and its cantons",
      description:
        "Official permanent resident population (BFS STATPOP) for Switzerland and every canton, latest available year. Optionally filter to one canton by name.",
      inputSchema: {
        canton: z.string().optional().describe("Optional canton name filter, e.g. 'Zürich', 'Vaud'"),
      },
      handler: async ({ canton }) => {
        try {
          const { year, rows, assumptions, cacheStatus, retrievedAt } = await fetchPopulation();
          let result = rows;
          if (canton) {
            const q = canton.toLowerCase();
            result = rows.filter((r) => r.region.toLowerCase().includes(q));
            if (!result.length) {
              return toolError(`No canton matching '${canton}'.`, [
                `Regions: ${rows.map((r) => r.region).join(", ")}`,
              ]);
            }
          }
          return respond(
            { year, population: result, ...(assumptions.length ? { selection: assumptions } : {}) },
            { source: bfsPx, cacheStatus, retrievedAt, dataAsOf: year },
          );
        } catch (err) {
          if (err instanceof PxShapeError) {
            return toolError(`BFS population table has changed shape: ${err.message}`, [
              "This needs a Swissyphus update; use search_datasets('STATPOP') to find the data meanwhile.",
            ], { kind: "unavailable" });
          }
          return errorToResult(err, "BFS STAT-TAB (PXWeb)");
        }
      },
    }),

    tool({
      name: "search_datasets",
      title: "Search Swiss open-data catalogues",
      description:
        "Full-text search over the national open-data catalogue opendata.swiss (default) or the City of Zürich portal (portal='stadt-zuerich'): statistics (population, prices, energy…), geodata, transport, health and more. Each hit lists its resource formats and whether it is queryable (has CSV/JSON/GeoJSON). " +
        "Filter by publisher (slug from list_data_publishers), by format (e.g. 'CSV'), sort by 'modified' for the newest. Then call query_dataset {id} for the actual rows, or get_dataset {id} for metadata. " +
        "Examples: {query: 'Mietpreisindex'}, {query: 'Bevölkerung Gemeinde', format: 'CSV'}, {publisher: 'bundesamt-fur-statistik-bfs', sort: 'modified'}, {query: 'Velo', portal: 'stadt-zuerich'}.",
      inputSchema: {
        query: z
          .string()
          .min(2)
          .optional()
          .describe("Search terms, e.g. 'rent index', 'STATPOP', 'Luftqualität'. German terms match best. Optional if publisher/format is given"),
        publisher: z.string().optional().describe("Optional publisher (organization) slug, e.g. 'bundesamt-fur-statistik-bfs'; see list_data_publishers"),
        format: z.string().optional().describe("Only datasets with a resource of this format, e.g. 'CSV', 'JSON', 'GeoJSON', 'XLSX'"),
        sort: z
          .enum(Object.keys(SEARCH_SORTS) as [SearchSort, ...SearchSort[]])
          .optional()
          .describe("relevance (default), modified (newest updates first), created, name"),
        lang: langParam,
        portal: portalParam,
        offset: z.number().int().min(0).max(10_000).optional().describe("Skip this many hits (paging)"),
        limit: z.number().int().min(1).max(50).default(10),
      },
      handler: async ({ query, publisher, format, sort, lang, portal: portalId, offset, limit }) => {
        const portal = getPortal(portalId);
        const l = lang ?? "en";
        if (!query && !publisher && !format) {
          return toolError("Provide a 'query' (or at least a 'publisher' or 'format' filter).", [
            "Example: {query: 'Bevölkerung', format: 'CSV'}",
          ]);
        }
        try {
          const url = buildSearchUrl(portal, { query, publisher, format, sort, rows: limit ?? 10, start: offset });
          const { result, cacheStatus, retrievedAt } = await ckan<{ count?: number; results?: CkanDataset[] }>(url, portal);
          const results = (result?.results ?? []).map((d) => compactDataset(d, portal, l));
          if (!results.length) {
            return toolError(`No datasets found for '${query ?? ""}'${publisher ? ` (publisher ${publisher})` : ""}${format ? ` (format ${format})` : ""}.`, [
              portal.id === "envidat" ? "EnviDat metadata is in English; search English terms." : "Try German search terms; most dataset metadata is German-first.",
              ...(format ? ["Drop the format filter; publishers label formats inconsistently."] : []),
              ...(publisher ? ["Check the publisher slug with list_data_publishers."] : []),
            ]);
          }
          return respond(
            {
              total_matches: result?.count,
              offset: offset ?? 0,
              results,
              hint: "query_dataset {id} returns rows of the best CSV/JSON resource (queryable=true); get_dataset {id} lists all resources.",
            },
            { source: portal.source, cacheStatus, retrievedAt, language: l },
          );
        } catch (err) {
          if (err instanceof SourceError && err.status === 409) {
            return toolError("The catalogue rejected the search parameters.", ["Simplify the query (avoid Solr syntax like ':' or brackets)."]);
          }
          return errorToResult(err, portal.catalogue);
        }
      },
    }),

    tool({
      name: "get_dataset",
      title: "Get dataset details & download links",
      description:
        "Full metadata for one dataset on opendata.swiss (or portal='stadt-zuerich'): description, publisher, licence and every resource with its 0-based index, format, whether it is queryable by query_dataset, and its direct download link.",
      inputSchema: {
        id: z.string().describe("Dataset ID (slug) from search_datasets"),
        portal: portalParam,
        lang: langParam,
      },
      handler: async ({ id, portal: portalId, lang }) => {
        const portal = getPortal(portalId);
        try {
          const { result, cacheStatus, retrievedAt } = await showDataset(portal, id);
          if (!result) return notFound(id, portal);
          return respond(compactDataset(result, portal, lang ?? "en", true), {
            source: portal.source,
            cacheStatus,
            retrievedAt,
            dataAsOf: result.metadata_modified,
            language: lang ?? "en",
          });
        } catch (err) {
          if (err instanceof SourceError && err.status === 404) return notFound(id, portal);
          return errorToResult(err, portal.catalogue);
        }
      },
    }),

    tool({
      name: "query_dataset",
      title: "Query the rows of an open-data dataset",
      description:
        "Fetch the actual data of an opendata.swiss / City of Zürich dataset and return matching rows. Picks the best machine-readable resource (CSV > JSON > GeoJSON; HTML landing pages, ZIP, XLSX, PDF and services are skipped and reported with their download URLs), parses it and applies search / column filters / sort / paging. " +
        "Returns columns, total matched, rows, the resource used and its licence. Works with a dataset id or a direct resource_url. Run describe_dataset_columns first to learn column names and values. " +
        "Examples: {id: '<dataset-id>', where: {Kanton: 'ZH'}, sort: '-Einwohner', limit: 10}; {id: '<dataset-id>', search: 'Winterthur', columns: ['Jahr','Wert']}; {resource_url: 'https://…/data.csv', where: {Jahr: '>2020'}}.",
      inputSchema: {
        ...targetShape,
        search: z.string().max(200).optional().describe("Case-insensitive substring matched against every field"),
        where: whereParam,
        columns: z
          .array(columnName)
          .max(MAX_SELECTED_COLUMNS)
          .optional()
          .describe(`Only return these columns (names are matched case/accent-insensitively; max ${MAX_SELECTED_COLUMNS})`),
        sort: columnName.optional().describe("Sort column; prefix '-' for descending, e.g. '-Jahr'"),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).default(25).describe("Rows to return (default 25, max 200; large rows are trimmed to fit 50 KB)"),
      },
      handler: async (args) => {
        const r = await resolveTarget(args);
        if (!r.ok) return r.result;
        const t = r.target;
        const q = queryRows(t.table, {
          search: args.search,
          where: whereStrings(args.where),
          columns: args.columns,
          sort: args.sort,
          offset: args.offset ?? 0,
          limit: args.limit ?? 25,
        });
        const fit = fitRows(q.rows);
        const notes = tableNotes(t.table, t.notes);
        if (fit.dropped) notes.push(`${fit.dropped} of the requested rows were withheld to stay under the 50 KB response cap; page with offset or select fewer columns.`);
        if (fit.trimmedCells) notes.push(`${fit.trimmedCells} long text cells were shortened to 400 characters.`);
        if (q.unknown_columns.length) notes.push(`Unknown columns ignored: ${q.unknown_columns.join(", ")}. Filters on them were NOT applied.`);
        const cols = t.table.columns;
        return respond(
          {
            dataset: t.dataset,
            resource: t.resource,
            licence: t.licence ?? t.manifest.licence,
            columns: cols.length > 100 ? cols.slice(0, 100) : cols,
            ...(cols.length > 100 ? { column_count: cols.length } : {}),
            total_rows: t.table.rows.length,
            total_matched: q.total,
            offset: args.offset ?? 0,
            returned: fit.rows.length,
            truncated: isTruncated(t.table) || fit.dropped > 0 || (args.offset ?? 0) + fit.rows.length < q.total,
            rows: fit.rows,
            ...(q.unknown_columns.length ? { unknown_columns: q.unknown_columns } : {}),
            ...(t.skipped.length ? { not_parseable_resources: t.skipped.slice(0, 8) } : {}),
            ...(notes.length ? { notes } : {}),
          },
          { source: t.manifest, cacheStatus: t.cacheStatus, retrievedAt: t.retrievedAt, dataAsOf: t.dataAsOf, language: args.lang ?? "en" },
        );
      },
    }),

    tool({
      name: "describe_dataset_columns",
      title: "Profile the columns of an open-data dataset",
      description:
        "Fetch and parse a dataset's best CSV/JSON/GeoJSON resource (or a direct resource_url) and return its row count and, per column, the detected type (number/string/mixed), non-null count and example values; use it to plan query_dataset filters or aggregate_dataset group-bys. " +
        "Examples: {id: '<dataset-id>'} or {id: '<dataset-id>', portal: 'stadt-zuerich', resource: '1'}.",
      inputSchema: {
        ...targetShape,
        examples: z.number().int().min(1).max(15).default(5).describe("Distinct example values per column (default 5)"),
      },
      handler: async (args) => {
        const r = await resolveTarget(args);
        if (!r.ok) return r.result;
        const t = r.target;
        const n = args.examples ?? 5;
        const prof = profileColumns(t.table, n);
        const baseNotes = [
          ...tableNotes(t.table, t.notes),
          ...(t.table.notes ?? []).filter((x) => !x.includes("truncated")).map((x) => `Parser: ${x}`),
        ];
        const fit = fitColumnProfiles(prof, (columns, numeric, fitNotes) => ({
          dataset: t.dataset,
          resource: t.resource,
          licence: t.licence ?? t.manifest.licence,
          parsed_format: t.table.format,
          row_count: t.table.rows.length,
          column_count: t.table.columns.length,
          truncated: isTruncated(t.table),
          columns,
          numeric_columns: numeric,
          ...(t.skipped.length ? { not_parseable_resources: t.skipped.slice(0, 8) } : {}),
          notes: [...baseNotes, ...fitNotes],
        }));
        return respond(
          fit,
          { source: t.manifest, cacheStatus: t.cacheStatus, retrievedAt: t.retrievedAt, dataAsOf: t.dataAsOf, language: args.lang ?? "en" },
        );
      },
    }),

    tool({
      name: "aggregate_dataset",
      title: "Group-by aggregation over an open-data dataset",
      description:
        "Group a dataset's rows by one or two columns and compute count, sum, avg, min or max of a numeric column (after optional where/search filters), e.g. total population per canton, average rent per year. Numbers with Swiss formatting (1'234.5) are understood. " +
        "Examples: {id: '<dataset-id>', group_by: ['Kanton'], op: 'sum', value_column: 'Einwohner'}; {id: '<dataset-id>', group_by: ['Jahr','Kanton'], op: 'avg', value_column: 'Wert', where: {Jahr: '>2015'}, order: 'group'}; {id: '<dataset-id>', group_by: ['Kategorie'], op: 'count'}.",
      inputSchema: {
        ...targetShape,
        group_by: z.array(columnName).max(2).optional().describe("0–2 column names to group by (omit for one overall total)"),
        op: z.enum(["count", "sum", "avg", "min", "max"]).default("count").describe("Aggregation (default count)"),
        value_column: columnName.optional().describe("Numeric column to aggregate (required for sum/avg/min/max)"),
        search: z.string().max(200).optional().describe("Case-insensitive substring pre-filter across all fields"),
        where: whereParam,
        order: z.enum(["desc", "asc", "group"]).default("desc").describe("Sort groups by value desc (default), asc, or by group key"),
        limit: z.number().int().min(1).max(500).default(50).describe("Max groups returned (default 50)"),
      },
      handler: async (args) => {
        const op = args.op ?? "count";
        if (op !== "count" && !args.value_column) {
          return toolError(`'value_column' is required for op='${op}'.`, ["Use describe_dataset_columns to find numeric columns."]);
        }
        const r = await resolveTarget(args);
        if (!r.ok) return r.result;
        const t = r.target;
        const agg = aggregateRows(t.table, {
          groupBy: args.group_by,
          op,
          valueColumn: args.value_column,
          search: args.search,
          where: whereStrings(args.where),
          order: args.order ?? "desc",
          limit: args.limit ?? 50,
        });
        if (agg.unknown_columns.length) {
          const cols = t.table.columns;
          return toolError(`Unknown column(s): ${agg.unknown_columns.join(", ")}.`, [
            `Available columns: ${cols.slice(0, 60).join(", ")}${cols.length > 60 ? ", …" : ""}`,
          ]);
        }
        const fit = fitRows(agg.groups);
        const notes = tableNotes(t.table, t.notes);
        if (agg.rows_skipped_non_numeric) notes.push(`${agg.rows_skipped_non_numeric} rows had a non-numeric '${agg.value_column}' and were ignored for ${op}.`);
        if (fit.dropped) notes.push(`${fit.dropped} groups withheld to stay under the 50 KB cap; lower 'limit'.`);
        return respond(
          {
            dataset: t.dataset,
            resource: t.resource,
            licence: t.licence ?? t.manifest.licence,
            ...agg,
            groups: fit.rows,
            returned: fit.rows.length,
            ...(notes.length ? { notes } : {}),
          },
          { source: t.manifest, cacheStatus: "computed", retrievedAt: t.retrievedAt, dataAsOf: t.dataAsOf, language: args.lang ?? "en" },
        );
      },
    }),

    tool({
      name: "list_data_publishers",
      title: "List open-data publishers",
      description:
        "List the organisations publishing on opendata.swiss (federal offices, cantons, cities, companies) or on the City of Zürich portal (departments), with their slug and dataset count. Use the slug as 'publisher' in search_datasets. " +
        "Examples: {} (largest publishers first), {query: 'statistik'}, {query: 'Kanton Zürich', lang: 'de'}, {portal: 'stadt-zuerich'}.",
      inputSchema: {
        query: z.string().optional().describe("Filter by name/title substring (any language), e.g. 'BFS', 'Bern', 'meteo'"),
        portal: portalParam,
        lang: langParam,
        limit: z.number().int().min(1).max(300).default(50).describe("Max publishers returned (default 50)"),
      },
      handler: async ({ query, portal: portalId, lang, limit }) => {
        const portal = getPortal(portalId);
        const l = lang ?? "en";
        try {
          const { orgs, cacheStatus, retrievedAt } = await fetchAllOrganizations(portal);
          const needle = query?.toLowerCase().trim();
          const all = orgs
            .map((o) => ({
              slug: o.name,
              title: pickLang(o.title ?? o.display_name, l) ?? o.name,
              datasets: typeof o.package_count === "number" ? o.package_count : undefined,
              _hay: [o.name, ...LANGS.map((x) => pickLang(o.title ?? o.display_name, x))].join(" ").toLowerCase(),
            }))
            .filter((o) => o.slug && (!needle || o._hay.includes(needle)))
            .sort((a, b) => (b.datasets ?? 0) - (a.datasets ?? 0) || String(a.title).localeCompare(String(b.title)));
          if (!all.length) {
            return toolError(`No publisher matching '${query}' on ${portal.catalogue}.`, ["Try a shorter or German/French term, e.g. 'statistik', 'Bern'."]);
          }
          const max = limit ?? 50;
          return respond(
            {
              total: all.length,
              returned: Math.min(max, all.length),
              publishers: all.slice(0, max).map(({ _hay, ...rest }) => rest),
              hint: "Pass 'slug' as 'publisher' to search_datasets.",
            },
            { source: portal.source, cacheStatus, retrievedAt, language: l },
          );
        } catch (err) {
          return errorToResult(err, portal.catalogue);
        }
      },
    }),
  ],
};
