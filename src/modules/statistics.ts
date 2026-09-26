/**
 * Statistics / open data module — opendata.swiss, the Swiss federal open
 * government data catalogue (CKAN API). Gateway to 12'000+ datasets from
 * BFS, FOEN, swisstopo, cantons and cities.
 */

import { z } from "zod";
import { fetchJson, withParams, SourceError } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

const source: SourceManifest = {
  id: "opendata-swiss",
  name: "opendata.swiss — Swiss OGD catalogue",
  operator: "Federal Statistical Office (BFS) / OGD office",
  url: "https://opendata.swiss",
  licence: "Catalogue metadata: open; each dataset carries its own OGD licence (stated per result)",
  attribution: "Catalogue © opendata.swiss; datasets © their respective publishers",
  updateFrequency: "continuous",
  cacheTtlSeconds: 3600,
};

const BASE = "https://ckan.opendata.swiss/api/3/action";

type LangText = string | Record<string, string>;

/**
 * Pick a language from CKAN multilingual text. opendata.swiss sometimes
 * returns the multilingual object JSON-encoded as a string (notably
 * `organization.title`), e.g. '{"de": "…", "fr": "…"}' — decode that too.
 */
export function pickLang(t: LangText | undefined | null, lang = "en"): string | undefined {
  if (t === undefined || t === null) return undefined;
  if (typeof t === "string") {
    const s = t.trim();
    if (s.startsWith("{") && s.endsWith("}")) {
      try {
        const parsed = JSON.parse(s) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return pickLang(parsed as Record<string, string>, lang);
        }
      } catch {
        /* not JSON — use as plain text */
      }
    }
    return t || undefined;
  }
  const val = (k: string) => (typeof t[k] === "string" && t[k].trim() ? t[k] : undefined);
  return val(lang) ?? val("en") ?? val("de") ?? val("fr") ?? val("it") ?? Object.values(t).find((v) => typeof v === "string" && v.trim());
}

export interface CkanResource {
  title?: LangText;
  name?: LangText;
  format?: string;
  download_url?: string | null;
  url?: string | null;
  rights?: string;
  license?: string;
}

export interface CkanDataset {
  name?: string;
  title?: LangText;
  notes?: LangText;
  metadata_modified?: string;
  organization?: { title?: LangText; name?: string };
  keywords?: Record<string, string[]>;
  resources?: CkanResource[];
}

function nonEmpty(s: string | null | undefined): string | undefined {
  return typeof s === "string" && s.trim() ? s.trim() : undefined;
}

export function mapResource(r: CkanResource) {
  return {
    title: pickLang(r.title) ?? pickLang(r.name),
    format: r.format || undefined,
    licence: nonEmpty(r.license) ?? nonEmpty(r.rights),
    download_url: nonEmpty(r.download_url) ?? nonEmpty(r.url),
  };
}

export function compactDataset(d: CkanDataset, withResources = false) {
  return {
    id: d.name,
    title: pickLang(d.title),
    publisher: pickLang(d.organization?.title) ?? d.organization?.name,
    modified: d.metadata_modified?.slice(0, 10),
    description: pickLang(d.notes)?.slice(0, withResources ? 2000 : 240),
    url: `https://opendata.swiss/en/dataset/${d.name}`,
    ...(withResources ? { resources: (d.resources ?? []).slice(0, 15).map(mapResource) } : {}),
  };
}

const bfsPx: SourceManifest = {
  id: "bfs-pxweb",
  name: "BFS STAT-TAB (PXWeb) — STATPOP population statistics",
  operator: "Federal Statistical Office (BFS)",
  url: "https://www.pxweb.bfs.admin.ch",
  licence: "Swiss OGD — free use with attribution",
  attribution: "© BFS, STATPOP",
  updateFrequency: "yearly",
  cacheTtlSeconds: 24 * 3600,
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
  // always match. Kanton must be selected explicitly — PXWeb eliminates
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
  const { data: meta } = await fetchJson<PxMeta>(metaUrl, { ttlMs: bfsPx.cacheTtlSeconds * 1000 });
  const { query, year, cantonNames, assumptions } = buildPopulationQuery(meta);
  const { data, cacheStatus, retrievedAt } = await fetchJson<PxData>(metaUrl, {
    ttlMs: bfsPx.cacheTtlSeconds * 1000,
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

export const statisticsModule: SwissyphusModule = {
  id: "statistics",
  emoji: "📊",
  title: "Statistics & open data",
  description: "Search 12'000+ Swiss OGD datasets (BFS, FOEN, cantons, cities) and get download links",
  sources: [source, bfsPx],
  healthProbes: [
    { sourceId: "opendata-swiss", url: `${BASE}/package_search?q=population&rows=1` },
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
            ]);
          }
          return errorToResult(err, "BFS STAT-TAB (PXWeb)");
        }
      },
    }),
    tool({
      name: "search_datasets",
      title: "Search Swiss open-data catalogue",
      description:
        "Full-text search over the national open-data catalogue opendata.swiss: statistics (population, prices, energy…), geodata, transport, health and more. Returns dataset IDs for get_dataset.",
      inputSchema: {
        query: z.string().min(2).describe("Search terms, e.g. 'rent index', 'STATPOP', 'electricity tariffs'"),
        publisher: z.string().optional().describe("Optional publisher filter, e.g. 'bundesamt-fur-statistik-bfs'"),
        limit: z.number().int().min(1).max(50).default(10),
      },
      handler: async ({ query, publisher, limit }) => {
        try {
          const url = withParams(`${BASE}/package_search`, {
            q: query,
            rows: limit,
            // Quote and strip quotes/backslashes so a publisher value can't
            // inject extra Solr filter syntax into the fq clause.
            fq: publisher ? `organization:"${publisher.replace(/["\\]/g, "")}"` : undefined,
          });
          const { data, cacheStatus, retrievedAt } = await fetchJson<{
            result?: { count?: number; results?: CkanDataset[] };
          }>(url, { ttlMs: source.cacheTtlSeconds * 1000 });
          const results = (data.result?.results ?? []).map((d) => compactDataset(d));
          if (!results.length) {
            return toolError(`No datasets found for '${query}'.`, [
              "Try German search terms — most dataset metadata is German-first.",
            ]);
          }
          return respond(
            { total_matches: data.result?.count, results },
            { source, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "opendata.swiss");
        }
      },
    }),

    tool({
      name: "get_dataset",
      title: "Get dataset details & download links",
      description:
        "Full metadata for one opendata.swiss dataset: description, publisher, licence and direct download links for every resource (CSV, JSON, geodata…).",
      inputSchema: {
        id: z.string().describe("Dataset ID (slug) from search_datasets"),
      },
      handler: async ({ id }) => {
        try {
          const url = withParams(`${BASE}/package_show`, { id });
          const { data, cacheStatus, retrievedAt } = await fetchJson<{ result?: CkanDataset }>(url, {
            ttlMs: source.cacheTtlSeconds * 1000,
          });
          if (!data.result) return toolError(`Dataset '${id}' not found.`);
          return respond(compactDataset(data.result, true), { source, cacheStatus, retrievedAt });
        } catch (err) {
          if (err instanceof SourceError && err.status === 404) {
            return toolError(`Dataset '${id}' not found on opendata.swiss.`, [
              "Use the exact dataset ID (slug) returned by search_datasets.",
            ]);
          }
          return errorToResult(err, "opendata.swiss");
        }
      },
    }),
  ],
};
