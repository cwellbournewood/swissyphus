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

function pickLang(t: LangText | undefined, lang = "en"): string | undefined {
  if (t === undefined) return undefined;
  if (typeof t === "string") return t;
  return t[lang] || t["en"] || t["de"] || Object.values(t).find(Boolean);
}

interface CkanDataset {
  name?: string;
  title?: LangText;
  notes?: LangText;
  metadata_modified?: string;
  organization?: { title?: LangText; name?: string };
  keywords?: Record<string, string[]>;
  resources?: Array<{
    title?: LangText;
    format?: string;
    download_url?: string;
    url?: string;
    rights?: string;
  }>;
}

function compactDataset(d: CkanDataset, withResources = false) {
  return {
    id: d.name,
    title: pickLang(d.title),
    publisher: pickLang(d.organization?.title),
    modified: d.metadata_modified?.slice(0, 10),
    description: pickLang(d.notes)?.slice(0, withResources ? 2000 : 240),
    url: `https://opendata.swiss/en/dataset/${d.name}`,
    ...(withResources
      ? {
          resources: (d.resources ?? []).slice(0, 15).map((r) => ({
            title: pickLang(r.title),
            format: r.format,
            licence: r.rights,
            download_url: r.download_url ?? r.url,
          })),
        }
      : {}),
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

interface PxMeta {
  variables?: Array<{ code?: string; values?: string[]; valueTexts?: string[] }>;
}

interface PxData {
  data?: Array<{ key?: string[]; values?: string[] }>;
}

async function fetchPopulation(): Promise<{
  year: string;
  rows: Array<{ region: string; population: number }>;
  cacheStatus: "hit" | "miss" | "stale" | "computed";
  retrievedAt: string;
}> {
  const metaUrl = `https://www.pxweb.bfs.admin.ch/api/v1/en/${POP_TABLE}/${POP_TABLE}.px`;
  const { data: meta } = await fetchJson<PxMeta>(metaUrl, { ttlMs: bfsPx.cacheTtlSeconds * 1000 });
  const variables = meta.variables ?? [];
  const years = variables.find((v) => v.code === "Jahr")?.values ?? [];
  const year = years[years.length - 1] ?? String(new Date().getFullYear() - 2);
  const kanton = variables.find((v) => v.code === "Kanton");
  const cantonNames = new Map<string, string>();
  (kanton?.values ?? []).forEach((v, i) => cantonNames.set(v, kanton?.valueTexts?.[i] ?? v));

  // Build the query from the live metadata so variable codes (incl. umlauts)
  // always match. Kanton must be selected explicitly — PXWeb eliminates
  // (sums over) any dimension that is omitted.
  const query = {
    query: variables.map((v) => {
      const code = v.code ?? "";
      let values: string[];
      if (code === "Jahr") values = [year];
      else if (code === "Kanton") values = v.values ?? [];
      else if (code.toLowerCase().includes("typ")) values = [v.values?.[0] ?? "1"];
      else values = v.values?.includes("-99999") ? ["-99999"] : [v.values?.[0] ?? ""];
      return { code, selection: { filter: "item", values } };
    }),
    response: { format: "json" },
  };
  const { data, cacheStatus, retrievedAt } = await fetchJson<PxData>(metaUrl, {
    ttlMs: bfsPx.cacheTtlSeconds * 1000,
    timeoutMs: 30_000,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(query),
    },
  });
  const rows = (data.data ?? [])
    .map((d) => {
      const cantonCode = (d.key ?? []).find((k) => cantonNames.has(k));
      return {
        region: cantonNames.get(cantonCode ?? "") ?? cantonCode ?? "?",
        population: Number(d.values?.[0]),
      };
    })
    .filter((r) => !Number.isNaN(r.population));
  return { year, rows, cacheStatus, retrievedAt };
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
          const { year, rows, cacheStatus, retrievedAt } = await fetchPopulation();
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
            { year, population: result },
            { source: bfsPx, cacheStatus, retrievedAt, dataAsOf: year },
          );
        } catch (err) {
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
            fq: publisher ? `organization:${publisher}` : undefined,
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
