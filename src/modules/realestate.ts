/**
 * Real-estate module — the Swiss residential property price index (IMPI) of
 * the Federal Statistical Office: quarterly purchase-price indices for
 * single-family houses and owner-occupied apartments (Q4 2019 = 100).
 *
 * The BFS publishes the series as the JSON file behind its own chart. The
 * asset id changes every quarter; the order number does not, so the current
 * file is found through the BFS asset API on each refresh.
 */

import { z } from "zod";
import { allowHosts, fetchJson, sourceCache, SourceError, withParams } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { CacheStatus, SourceManifest } from "../core/types.js";

allowHosts("dam-api.bfs.admin.ch", "www.bfs.admin.ch");

const ORDER_NR = "ds-x-05.06.03.01.02";
const ASSETS_URL = "https://dam-api.bfs.admin.ch/hub/api/dam/assets";

const impi: SourceManifest = {
  id: "bfs-impi",
  name: "Swiss residential property price index (IMPI)",
  operator: "Federal Statistical Office (FSO/BFS)",
  url: "https://www.bfs.admin.ch/bfs/en/home/statistics/prices/real-estate-prices.html",
  licence: "Swiss OGD: free use with attribution (Source: FSO)",
  attribution: "Source: FSO, residential property price index (IMPI)",
  updateFrequency: "quarterly",
  cacheTtlSeconds: 24 * 3600,
  maxStaleSeconds: 200 * 86_400,
  notes: "Transaction-based hedonic index, Q4 2019 = 100. Purchase prices, not rents.",
};

interface AssetList {
  data?: Array<{ bfs?: { lifecycle?: { code?: string } }; links?: Array<{ rel?: string; href?: string }> }>;
}
interface SeriesPoint {
  year?: string;
  value?: number;
}
interface ImpiFile {
  dataStatus?: string;
  data?: Record<string, Record<string, SeriesPoint[] | undefined> | undefined>;
}

export interface ImpiQuarter {
  period: string;
  all: number | null;
  houses: number | null;
  apartments: number | null;
}

/** The chart labels quarters by their middle month: "2.2024" → 2024-Q1, "11.2024" → 2024-Q4. */
export function quarterOf(label: string | undefined): string | undefined {
  const m = /^(\d{1,2})\.(\d{4})$/.exec(label ?? "");
  if (!m) return undefined;
  const q = Math.floor((Number(m[1]) - 1) / 3) + 1;
  return q >= 1 && q <= 4 ? `${m[2]}-Q${q}` : undefined;
}

export function parseImpi(file: ImpiFile): ImpiQuarter[] {
  const series = (key: string) => file.data?.[key]?.["geoscope1"] ?? [];
  const all = series("total");
  const houses = series("efh");
  const apts = series("egw");
  if (!all.length) throw new SourceError("BFS IMPI file has no national series (unexpected format).", "dam-api.bfs.admin.ch", undefined, "invalid_response");
  const byPeriod = new Map<string, ImpiQuarter>();
  const put = (pts: SeriesPoint[], k: "all" | "houses" | "apartments") => {
    for (const p of pts) {
      const period = quarterOf(p.year);
      if (!period || typeof p.value !== "number") continue;
      const row = byPeriod.get(period) ?? { period, all: null, houses: null, apartments: null };
      row[k] = p.value;
      byPeriod.set(period, row);
    }
  };
  put(all, "all");
  put(houses, "houses");
  put(apts, "apartments");
  return [...byPeriod.values()].sort((a, b) => a.period.localeCompare(b.period));
}

const pct = (a: number | null | undefined, b: number | null | undefined) =>
  a != null && b != null && b !== 0 ? Math.round(((a - b) / b) * 1000) / 10 : null;

export function withChanges(rows: ImpiQuarter[]) {
  const index = new Map(rows.map((r) => [r.period, r]));
  return rows.map((r) => {
    const [y, q] = r.period.split("-Q");
    const yearAgo = index.get(`${Number(y) - 1}-Q${q}`);
    return {
      ...r,
      yoy_change_pct: { all: pct(r.all, yearAgo?.all), houses: pct(r.houses, yearAgo?.houses), apartments: pct(r.apartments, yearAgo?.apartments) },
    };
  });
}

async function loadImpi(): Promise<{ rows: ImpiQuarter[]; cacheStatus: CacheStatus; retrievedAt: string; status?: string }> {
  const list = await fetchJson<AssetList>(withParams(ASSETS_URL, { orderNr: ORDER_NR }), { ...sourceCache(impi), timeoutMs: 30_000 });
  const asset = list.data.data?.find((a) => a.bfs?.lifecycle?.code === "CURRENT") ?? list.data.data?.[0];
  const href = asset?.links?.find((l) => l.rel === "master")?.href;
  if (!href) throw new SourceError(`BFS lists no current IMPI file for ${ORDER_NR}.`, "dam-api.bfs.admin.ch", undefined, "invalid_response");
  const file = await fetchJson<ImpiFile>(href, { ...sourceCache(impi), timeoutMs: 30_000 });
  return { rows: parseImpi(file.data), cacheStatus: file.cacheStatus, retrievedAt: file.retrievedAt, ...(file.data.dataStatus ? { status: file.data.dataStatus } : {}) };
}

const PERIOD = /^\d{4}(-Q[1-4])?$/;

export const realestateModule: SwissyphusModule = {
  id: "realestate",
  emoji: "🏡",
  title: "Real-estate prices (FSO)",
  description:
    "The official Swiss residential property price index: quarterly purchase prices for houses and apartments since 2017, with year-on-year change",
  sources: [impi],
  healthProbes: [{ sourceId: "bfs-impi", url: withParams(ASSETS_URL, { orderNr: ORDER_NR }) }],
  tools: [
    tool({
      name: "get_property_price_index",
      title: "Swiss residential property price index",
      description:
        "The FSO residential property price index (IMPI, Q4 2019 = 100), quarterly from 2017: all residential property, single-family houses and owner-occupied apartments, with year-on-year change and change over the selected period. Purchase prices, not rents. Examples: {} (latest 8 quarters), {from:'2020', to:'2025-Q2'}.",
      inputSchema: {
        from: z.string().regex(PERIOD).optional().describe("First period, e.g. 2020 or 2020-Q1"),
        to: z.string().regex(PERIOD).optional().describe("Last period, e.g. 2025 or 2025-Q2"),
        last: z.number().int().min(1).max(60).default(8).describe("Quarters to return when from/to are not given"),
      },
      handler: async ({ from, to, last }) => {
        try {
          const { rows, cacheStatus, retrievedAt, status } = await loadImpi();
          const all = withChanges(rows);
          const lo = from ? (from.includes("Q") ? from : `${from}-Q1`) : undefined;
          const hi = to ? (to.includes("Q") ? to : `${to}-Q4`) : undefined;
          const sel = lo || hi ? all.filter((r) => (!lo || r.period >= lo) && (!hi || r.period <= hi)) : all.slice(-last);
          if (!sel.length) {
            return toolError(`No IMPI quarters between ${lo ?? "start"} and ${hi ?? "latest"}. The series runs ${all[0]?.period} to ${all.at(-1)?.period}.`, [], { kind: "not_found" });
          }
          const first = sel[0]!;
          const latest = sel[sel.length - 1]!;
          return respond(
            {
              base: "Q4 2019 = 100",
              latest,
              change_over_period_pct: { from: first.period, to: latest.period, all: pct(latest.all, first.all), houses: pct(latest.houses, first.houses), apartments: pct(latest.apartments, first.apartments) },
              quarters: sel,
              ...(status ? { publication_status: status } : {}),
            },
            { source: impi, cacheStatus, retrievedAt, dataAsOf: latest.period },
          );
        } catch (err) {
          return errorToResult(err, "FSO property price index");
        }
      },
    }),
  ],
};
