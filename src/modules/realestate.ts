/**
 * Real estate module — Swiss residential property price indices and rent
 * indices as published on the SNB data portal (cube plimoinch*): the Federal
 * Statistical Office's IMPI plus Wüest Partner, IAZI and Fahrländer Partner,
 * quarterly or annual. Plus new-dwelling construction (BFS) and a housing
 * dataset search on opendata.swiss.
 */

import { z } from "zod";
import { fetchJson, withParams } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";
import { compactDataset, type CkanDataset } from "./statistics.js";

const snb: SourceManifest = {
  id: "snb-realestate",
  name: "Swiss real estate price and rent indices (SNB data portal)",
  operator: "Swiss National Bank (compiling BFS, Wüest Partner, IAZI, Fahrländer Partner)",
  url: "https://data.snb.ch/en/topics/ziredev/cube/plimoinchq",
  licence: "SNB data portal terms — free use with attribution",
  attribution: "© Swiss National Bank, data.snb.ch; index providers as stated per series",
  updateFrequency: "quarterly",
  cacheTtlSeconds: 86_400,
};

const ckan: SourceManifest = {
  id: "opendata-swiss-housing",
  name: "opendata.swiss — housing & construction datasets",
  operator: "Federal Statistical Office (BFS) / OGD office",
  url: "https://opendata.swiss/en/group/soci",
  licence: "Catalogue metadata: open; each dataset carries its own OGD licence",
  attribution: "Catalogue © opendata.swiss; datasets © their respective publishers",
  updateFrequency: "continuous",
  cacheTtlSeconds: 3600,
};

const SNB = "https://data.snb.ch/api/cube";

export const PROPERTY = { apartments: "EW", houses: "EH", apartment_buildings: "MH" } as const;
export const SPACE = { residential: "MW", office: "BF", industrial: "GF", retail: "VF" } as const;
export const PROVIDER = { bfs: "TP3", wuest_transaction: "TP", wuest_asking: "AP", iazi: "TP2", fahrlaender: "TP1" } as const;

interface SnbSeries {
  header?: Array<{ dim?: string; dimItem?: string }>;
  metadata?: { key?: string; unit?: string; frequency?: string };
  values?: Array<{ date?: string; value?: number | null }>;
}

export function mapSeries(s: SnbSeries) {
  const values = (s.values ?? []).filter((v) => typeof v.value === "number").map((v) => ({ period: v.date, index: Math.round((v.value as number) * 100) / 100 }));
  const last = values[values.length - 1];
  const yearAgoIdx = values.length - (s.metadata?.frequency === "P1Y" ? 2 : 5);
  const yearAgo = yearAgoIdx >= 0 ? values[yearAgoIdx] : undefined;
  return {
    series: s.header?.map((h) => h.dimItem).join(" · "),
    unit: s.metadata?.unit,
    latest: last,
    change_yoy_pct: last && yearAgo ? Math.round((last.index / yearAgo.index - 1) * 1000) / 10 : undefined,
    values,
  };
}

async function snbCube(frequency: "quarterly" | "annual", d0: string[], d1: string[], from?: string) {
  const cube = frequency === "annual" ? "plimoincha" : "plimoinchq";
  const url = withParams(`${SNB}/${cube}/data/json/en`, {
    dimSel: `D0(${d0.join(",")}),D1(${d1.join(",")})`,
    fromDate: from,
  });
  return fetchJson<{ timeseries?: SnbSeries[] }>(url, { ttlMs: snb.cacheTtlSeconds * 1000, timeoutMs: 30_000 });
}

/** "2020" → "2020-Q1" for quarterly cubes; keeps "2020-Q3" and annual "2020". */
export function fromPeriod(from: string | undefined, frequency: "quarterly" | "annual"): string | undefined {
  if (!from) return undefined;
  const y = from.slice(0, 4);
  if (frequency === "annual") return y;
  const q = /^\d{4}-Q[1-4]$/i.test(from) ? from.toUpperCase() : `${y}-Q1`;
  return q;
}

const providerArg = z
  .array(z.enum(["bfs", "wuest_transaction", "wuest_asking", "iazi", "fahrlaender"]))
  .optional()
  .describe("Index providers (default: all with data). bfs = Federal Statistical Office IMPI (transaction prices)");

function defaultFrom(frequency: "quarterly" | "annual"): string {
  const y = new Date().getUTCFullYear() - (frequency === "annual" ? 10 : 3);
  return frequency === "annual" ? String(y) : `${y}-Q1`;
}

function handleSeries(data: { timeseries?: SnbSeries[] }, maxPoints: number) {
  return (data.timeseries ?? [])
    .map(mapSeries)
    .filter((s) => s.values.length)
    .map((s) => ({ ...s, values: s.values.slice(-maxPoints) }));
}

export const realEstateModule: SwissyphusModule = {
  id: "realestate",
  emoji: "🏘️",
  title: "Real estate",
  description: "Residential property price indices (BFS IMPI, Wüest, IAZI, Fahrländer), rent indices by space type, housing datasets",
  sources: [snb, ckan],
  healthProbes: [{ sourceId: "snb-realestate", url: `${SNB}/plimoinchq/dimensions/en` }],
  tools: [
    tool({
      name: "get_property_price_index",
      title: "Residential property price index",
      description:
        "Swiss residential property price indices — privately owned apartments, single-family houses and apartment buildings — from the Federal Statistical Office (IMPI, transaction prices) and the private index providers Wüest Partner, IAZI and Fahrländer Partner, quarterly or annual. Returns the series, latest value and year-on-year change.",
      inputSchema: {
        property_type: z.array(z.enum(["apartments", "houses", "apartment_buildings"])).default(["apartments", "houses"]),
        provider: providerArg,
        frequency: z.enum(["quarterly", "annual"]).default("quarterly"),
        from: z.string().regex(/^\d{4}(-Q[1-4])?$/i).optional().describe("Start period, e.g. '2015' or '2020-Q3' (default: last 3 years quarterly / 10 years annual)"),
      },
      handler: async ({ property_type, provider, frequency, from }) => {
        try {
          const d0 = property_type.map((p) => PROPERTY[p]);
          const d1 = (provider ?? (Object.keys(PROVIDER) as Array<keyof typeof PROVIDER>)).map((p) => PROVIDER[p]);
          const { data, cacheStatus, retrievedAt } = await snbCube(frequency, d0, d1, fromPeriod(from, frequency) ?? defaultFrom(frequency));
          const series = handleSeries(data, 80);
          if (!series.length) return toolError("No index values for that selection.", ["Try provider 'bfs' or 'wuest_transaction', or an earlier 'from'"], { kind: "not_found" });
          return respond(
            { frequency, series },
            { source: snb, cacheStatus, retrievedAt, dataAsOf: series[0]?.latest?.period, notes: "Index levels from different providers use different base periods and methods; compare changes, not levels." },
          );
        } catch (err) {
          return errorToResult(err, "SNB data portal");
        }
      },
    }),
    tool({
      name: "get_rent_index",
      title: "Rent index",
      description:
        "Swiss rent indices for rental housing units, office, retail and industrial/commercial space (Wüest Partner asking rents and other providers, via the SNB data portal), quarterly or annual, with year-on-year change. For the official CPI rent component see search_real_estate_data.",
      inputSchema: {
        space: z.array(z.enum(["residential", "office", "retail", "industrial"])).default(["residential"]),
        provider: providerArg,
        frequency: z.enum(["quarterly", "annual"]).default("quarterly"),
        from: z.string().regex(/^\d{4}(-Q[1-4])?$/i).optional(),
      },
      handler: async ({ space, provider, frequency, from }) => {
        try {
          const d0 = space.map((s) => SPACE[s]);
          const d1 = (provider ?? (Object.keys(PROVIDER) as Array<keyof typeof PROVIDER>)).map((p) => PROVIDER[p]);
          const { data, cacheStatus, retrievedAt } = await snbCube(frequency, d0, d1, fromPeriod(from, frequency) ?? defaultFrom(frequency));
          const series = handleSeries(data, 80);
          if (!series.length) return toolError("No rent index values for that selection.", ["Omit 'provider' to include all providers"], { kind: "not_found" });
          return respond({ frequency, series }, { source: snb, cacheStatus, retrievedAt, dataAsOf: series[0]?.latest?.period });
        } catch (err) {
          return errorToResult(err, "SNB data portal");
        }
      },
    }),
    tool({
      name: "search_real_estate_data",
      title: "Search housing & real-estate datasets",
      description:
        "Search opendata.swiss for housing, rents, construction, vacancy and building datasets (BFS, cantons, cities), e.g. 'Leerwohnungen' (vacant dwellings), 'Mietpreis', 'Bauinvestitionen', 'Wohnungsbestand'. Returns dataset ids for get_dataset / list_dataset_resources.",
      inputSchema: {
        query: z.string().min(2).describe("Search terms (German terms find most BFS data)"),
        limit: z.number().int().min(1).max(30).default(10),
      },
      handler: async ({ query, limit }) => {
        try {
          const url = withParams("https://ckan.opendata.swiss/api/3/action/package_search", {
            q: query,
            fq: "groups:(soci OR regi OR econ)",
            rows: limit,
          });
          const { data, cacheStatus, retrievedAt } = await fetchJson<{ result?: { count?: number; results?: CkanDataset[] } }>(url, { ttlMs: 3_600_000, timeoutMs: 25_000 });
          const results = (data.result?.results ?? []).map((d) => compactDataset(d));
          if (!results.length) return toolError(`No housing datasets found for '${query}'.`, ["Try German terms: Mietpreis, Leerwohnungen, Wohnungen, Bauinvestitionen"], { kind: "not_found" });
          return respond({ total_matches: data.result?.count, results }, { source: ckan, cacheStatus, retrievedAt });
        } catch (err) {
          return errorToResult(err, "opendata.swiss");
        }
      },
    }),
  ],
};
