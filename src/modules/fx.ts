/**
 * Exchange rates module — Swiss National Bank data portal (data.snb.ch).
 *
 * - cube devkum: monthly average CHF exchange rates (get_exchange_rate*, list_currencies)
 * - generic cube access: any SNB cube's dimensions and labelled time series
 *   (get_snb_cube_dimensions, get_snb_data), plus a curated list of
 *   well-known cube ids (list_snb_datasets) registered with find_data.
 */

import { z } from "zod";
import { fetchJson, withParams, SourceError, TooLargeError } from "../core/http.js";
import { registerSearcher, type DataHit } from "../core/discovery.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { HealthProbe, SourceManifest } from "../core/types.js";
import { swissMonth } from "./_time.js";

const snb: SourceManifest = {
  id: "snb-fx",
  name: "SNB Data Portal — CHF exchange rates (monthly)",
  operator: "Swiss National Bank",
  url: "https://data.snb.ch",
  licence: "SNB data portal terms — free use with attribution",
  attribution: "© Swiss National Bank, data.snb.ch",
  updateFrequency: "monthly",
  cacheTtlSeconds: 6 * 3600,
  notes: "Cube 'devkum' = monthly averages, rates at 11am in CHF. D0=M0 monthly average, M1 end-of-month.",
};

const BASE = "https://data.snb.ch/api/cube/devkum/data/json/en";

interface SnbSeries {
  header?: Array<{ dim?: string; dimItem?: string }>;
  metadata?: { key?: string; unit?: string };
  values?: Array<{ date?: string; value?: number | null }>;
}

interface SnbResponse {
  timeseries?: SnbSeries[];
}

function currencyOf(series: SnbSeries): { code: string; per_units: number; label: string } | undefined {
  const key = series.metadata?.key ?? "";
  // key looks like: EPB@SNB.devkum{M0,EUR1}
  const m = key.match(/\{(M[01]),([A-Z]{3})(\d+)\}/);
  if (!m) return undefined;
  const dimLabel = series.header?.find((h) => h.dim === "Currency")?.dimItem ?? "";
  return { code: m[2] ?? "", per_units: Number(m[3]), label: dimLabel };
}

function isMonthlyAverage(series: SnbSeries): boolean {
  return (series.metadata?.key ?? "").includes("{M0,");
}

async function fetchRates(fromMonth: string, toMonth: string) {
  const url = withParams(BASE, { fromDate: fromMonth, toDate: toMonth });
  return fetchJson<SnbResponse>(url, { ttlMs: snb.cacheTtlSeconds * 1000 });
}

/** Current Swiss month (YYYY-MM) shifted by `offset` months (anchored to day 1, no rollover). */
function currentMonth(offset = 0): string {
  return swissMonth(offset);
}

/** Drop missing values (SNB publishes `null` for months without a rate). */
export function validValues(series: SnbSeries): Array<{ date: string; value: number }> {
  return (series.values ?? []).filter(
    (v): v is { date: string; value: number } => v.value != null && Number.isFinite(v.value) && typeof v.date === "string",
  );
}

/** Maximum span of a history request, in months (keeps responses well under the size cap). */
export const MAX_HISTORY_MONTHS = 240;

function monthIndex(ym: string): number {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return y * 12 + (m - 1);
}

/** Validate a YYYY-MM range; returns an error message or undefined. */
export function monthRangeError(from: string, to: string): string | undefined {
  for (const [name, v] of [["from_month", from], ["to_month", to]] as const) {
    const m = Number(v.slice(5, 7));
    if (!/^\d{4}-\d{2}$/.test(v) || m < 1 || m > 12) return `${name} '${v}' is not a valid YYYY-MM month.`;
  }
  if (from > to) return `from_month (${from}) is after to_month (${to}).`;
  const span = monthIndex(to) - monthIndex(from) + 1;
  if (span > MAX_HISTORY_MONTHS) {
    return `Range ${from} – ${to} spans ${span} months; the maximum is ${MAX_HISTORY_MONTHS}. Split the request.`;
  }
  return undefined;
}

/** Health probe with a URL computed at probe time, not frozen at import. */
const lazyProbe: HealthProbe = {
  sourceId: "snb-fx",
  get url() {
    return withParams(BASE, { fromDate: currentMonth(-2), toDate: currentMonth() });
  },
};
// ---------------------------------------------------------------------------
// Generic SNB cube access
// ---------------------------------------------------------------------------

const snbPortal: SourceManifest = {
  id: "snb-data",
  name: "SNB Data Portal — statistical cubes",
  operator: "Swiss National Bank",
  url: "https://data.snb.ch",
  licence: "SNB data portal terms — free use with attribution",
  attribution: "© Swiss National Bank, data.snb.ch",
  updateFrequency: "per cube (daily to annual)",
  cacheTtlSeconds: 6 * 3600,
  notes:
    "Endpoints: /api/cube/{id}/data/json/{lang} (fromDate/toDate/dimSel) and /api/cube/{id}/dimensions/{lang}. " +
    "The dimSel syntax 'D0(M0),D1(EUR1,USD1)' and the nested dimensionItems shape are implemented from documentation/observed use, not verified live in this build. " +
    "Curated cube ids other than devkum carry a confidence flag and should be verified against the live portal.",
};

const SNB_CUBE = "https://data.snb.ch/api/cube";

export interface SnbDataset {
  id: string;
  title: string;
  description: string;
  frequency: string;
  keywords: string[];
  /** How sure we are that this cube id exists on data.snb.ch. */
  confidence: "high" | "medium" | "low";
}

/**
 * Well-known SNB cube ids. Only devkum is exercised by existing tools; the
 * others are recalled from SNB portal usage and must be verified live.
 */
export const SNB_DATASETS: SnbDataset[] = [
  {
    id: "devkum",
    title: "Foreign exchange rates — monthly",
    description: "CHF exchange rates against ~30 currencies: monthly averages (M0) and end-of-month rates (M1).",
    frequency: "monthly",
    keywords: ["fx", "exchange rate", "currency", "devisen", "wechselkurs", "eur", "usd", "chf"],
    confidence: "high",
  },
  {
    id: "devkua",
    title: "Foreign exchange rates — annual",
    description: "CHF exchange rates against foreign currencies: annual averages and end-of-year rates.",
    frequency: "annual",
    keywords: ["fx", "exchange rate", "currency", "annual", "devisen", "wechselkurs"],
    confidence: "medium",
  },
  {
    id: "zimoma",
    title: "Money market rates",
    description: "Swiss franc money market rates including SARON and the SNB policy rate (monthly).",
    frequency: "monthly",
    keywords: ["interest", "rate", "saron", "money market", "policy rate", "leitzins", "zins", "libor"],
    confidence: "medium",
  },
  {
    id: "snbgwdzid",
    title: "SNB official interest rates — daily",
    description: "SNB policy rate and related official/reference rates at daily frequency.",
    frequency: "daily",
    keywords: ["interest", "policy rate", "leitzins", "saron", "daily", "snb"],
    confidence: "low",
  },
  {
    id: "rendoblim",
    title: "Yields on Swiss Confederation bonds",
    description: "Spot interest rates / yields on Swiss Confederation bonds by maturity (monthly).",
    frequency: "monthly",
    keywords: ["bond", "yield", "government bond", "confederation", "rendite", "obligationen", "interest"],
    confidence: "medium",
  },
  {
    id: "snbbipo",
    title: "SNB balance sheet items",
    description:
      "Swiss National Bank balance sheet positions: foreign currency investments, gold, sight deposits, banknotes in circulation.",
    frequency: "monthly",
    keywords: ["balance sheet", "bilanz", "reserves", "gold", "sight deposits", "giro", "snb"],
    confidence: "medium",
  },
  {
    id: "snbmonagg",
    title: "Monetary aggregates",
    description: "Swiss monetary aggregates M1, M2, M3 and the monetary base.",
    frequency: "monthly",
    keywords: ["money supply", "m1", "m2", "m3", "monetary aggregates", "geldmenge"],
    confidence: "medium",
  },
  {
    id: "plkopr",
    title: "Consumer prices (CPI)",
    description: "Swiss consumer price index and inflation as published on the SNB portal.",
    frequency: "monthly",
    keywords: ["cpi", "inflation", "consumer prices", "teuerung", "landesindex", "prices"],
    confidence: "low",
  },
  {
    id: "devwkieffich",
    title: "Effective exchange rate indices of the franc",
    description: "Nominal and real trade-weighted effective CHF exchange rate indices.",
    frequency: "monthly",
    keywords: ["effective exchange rate", "trade-weighted", "real exchange rate", "index", "chf", "fx"],
    confidence: "low",
  },
];

/** Keyword search over the curated SNB cube list (datasets matching all tokens rank first). */
export function searchSnbDatasets(query: string, limit = 10): SnbDataset[] {
  const tokens = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1);
  if (!tokens.length) return SNB_DATASETS.slice(0, limit);
  const scored = SNB_DATASETS.map((d) => {
    const hay = [d.id, d.title, d.description, ...d.keywords].join(" ").toLowerCase();
    const kw = d.keywords.join(" ").toLowerCase();
    let score = 0;
    let all = true;
    for (const t of tokens) {
      if (!hay.includes(t)) all = false;
      else score += (kw.includes(t) ? 2 : 1) + (d.id === t ? 5 : 0);
    }
    return { d, score, all };
  }).filter((x) => x.score > 0);
  scored.sort((a, b) => Number(b.all) - Number(a.all) || b.score - a.score);
  return scored.slice(0, limit).map((x) => x.d);
}

interface SnbDimItemRaw {
  id?: string;
  name?: string;
  dimensionItems?: SnbDimItemRaw[];
}

interface SnbDimensionsResponse {
  cubeId?: string;
  dimensions?: Array<{ id?: string; name?: string; dimensionItems?: SnbDimItemRaw[] }>;
}

export interface SnbDimension {
  id: string;
  name?: string;
  item_count: number;
  items: Array<{ id: string; name?: string; depth: number; is_group: boolean; parent?: string }>;
}

/** Flatten SNB's (possibly nested) dimension tree; groups are kept but flagged. */
export function parseSnbDimensions(data: SnbDimensionsResponse, maxItemsPerDim = 200): SnbDimension[] {
  return (data.dimensions ?? []).map((d, i) => {
    const items: SnbDimension["items"] = [];
    let count = 0;
    const walk = (list: SnbDimItemRaw[] | undefined, depth: number, parent?: string) => {
      for (const it of list ?? []) {
        count++;
        const kids = it.dimensionItems ?? [];
        if (it.id !== undefined && items.length < maxItemsPerDim) {
          items.push({
            id: String(it.id),
            name: it.name,
            depth,
            is_group: kids.length > 0,
            ...(parent ? { parent } : {}),
          });
        }
        walk(kids, depth + 1, it.id !== undefined ? String(it.id) : parent);
      }
    };
    walk(d.dimensionItems, 0);
    return { id: d.id ?? `D${i}`, name: d.name, item_count: count, items };
  });
}

/** {D0: ["M0"], D1: ["EUR1","USD1"]} → "D0(M0),D1(EUR1,USD1)". Ids are sanitised. */
export function buildDimSel(sel: Record<string, string[]> | undefined): string | undefined {
  if (!sel) return undefined;
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "");
  const parts = Object.entries(sel)
    .map(([dim, items]) => [clean(dim), items.map(clean).filter(Boolean)] as const)
    .filter(([dim, items]) => dim && items.length)
    .map(([dim, items]) => `${dim}(${items.join(",")})`);
  return parts.length ? parts.join(",") : undefined;
}

export interface SnbLabelledSeries {
  key?: string;
  dimensions: Record<string, string>;
  unit?: string;
  scale?: string;
  frequency?: string;
  value_count_total: number;
  first_date?: string;
  last_date?: string;
  latest?: { date?: string; value?: number | null };
  values: Array<{ date?: string; value?: number | null }>;
}

interface SnbSeriesGeneric {
  header?: Array<{ dim?: string; dimItem?: string }>;
  metadata?: Record<string, unknown>;
  values?: Array<{ date?: string; value?: number | null }>;
}

/**
 * Turn SNB timeseries into labelled series, keeping the most recent
 * `maxValues` observations of at most `maxSeries` series.
 */
export function labelSnbSeries(
  data: { timeseries?: SnbSeriesGeneric[] },
  maxSeries = 20,
  maxValues = 60,
): { series_count_total: number; series: SnbLabelledSeries[] } {
  const all = data.timeseries ?? [];
  const series = all.slice(0, maxSeries).map((s) => {
    const values = (s.values ?? []).filter((v) => v && v.date !== undefined);
    const nonNull = values.filter((v) => v.value !== null && v.value !== undefined);
    const md = s.metadata ?? {};
    const strOf = (k: string) => (md[k] === undefined || md[k] === null ? undefined : String(md[k]));
    const dimensions: Record<string, string> = {};
    for (const h of s.header ?? []) if (h.dim) dimensions[h.dim] = h.dimItem ?? "";
    return {
      key: strOf("key"),
      dimensions,
      unit: strOf("unit"),
      scale: strOf("scale"),
      frequency: strOf("frequency"),
      value_count_total: values.length,
      first_date: values[0]?.date,
      last_date: values[values.length - 1]?.date,
      latest: nonNull[nonNull.length - 1],
      values: values.slice(-maxValues),
    };
  });
  return { series_count_total: all.length, series };
}

/** Response budget (chars of compact JSON) — respond() withholds anything over 50 KB. */
export const SNB_RESPONSE_BUDGET = 45_000;

/**
 * Shrink labelled series until `build(series)` serialises under `budget`:
 * first cut each series' history (keeping the most recent values, down to
 * 12), then drop whole series, and as a last resort keep only the latest
 * value. Reports what was cut so the caller can say so.
 */
export function fitSnbSeries(
  series: SnbLabelledSeries[],
  build: (xs: SnbLabelledSeries[]) => unknown,
  budget = SNB_RESPONSE_BUDGET,
): { series: SnbLabelledSeries[]; values_per_series?: number; dropped_series: number } {
  const fits = (xs: SnbLabelledSeries[]) => JSON.stringify(build(xs)).length <= budget;
  if (fits(series)) return { series, dropped_series: 0 };
  const cutTo = (xs: SnbLabelledSeries[], k: number) =>
    xs.map((s) => (s.values.length > k ? { ...s, values: s.values.slice(-k) } : s));
  let perSeries = Math.max(0, ...series.map((s) => s.values.length));
  let current = series;
  let cut: number | undefined;
  while (perSeries > 12 && !fits(current)) {
    perSeries = Math.max(12, Math.floor(perSeries * 0.75));
    cut = perSeries;
    current = cutTo(series, perSeries);
  }
  let n = current.length;
  while (n > 1 && !fits(current.slice(0, n))) n = Math.max(1, Math.floor(n * 0.75));
  let kept = current.slice(0, n);
  if (!fits(kept)) {
    kept = cutTo(kept, 1);
    cut = 1;
  }
  return { series: kept, values_per_series: cut, dropped_series: series.length - n };
}

const cubeIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_]{3,40}$/)
  .describe("SNB cube id, e.g. 'devkum' (monthly FX), 'zimoma' (money market rates); see list_snb_datasets");
const snbLangSchema = z.enum(["en", "de"]).default("en").describe("Label language: en or de (default en)");
const snbDateSchema = z
  .string()
  .regex(/^\d{4}(-(\d{2}|Q[1-4])(-\d{2})?)?$/)
  .optional();

function snbPortalError(err: unknown, cubeId: string) {
  if (err instanceof TooLargeError) {
    return toolError(`SNB cube '${cubeId}' returned more data than Swissyphus will download.`, [
      "Narrow the request with from_date/to_date or dimension_selection.",
    ]);
  }
  if (err instanceof SourceError && err.status === 404) {
    return toolError(`SNB cube '${cubeId}' was not found on data.snb.ch.`, [
      "Check the id with list_snb_datasets or on https://data.snb.ch (the id is in each table's URL).",
    ]);
  }
  return errorToResult(err, "SNB data portal");
}

registerSearcher({
  catalogue: "SNB data portal",
  static: true,
  module: "fx",
  search: async (query: string, limit: number): Promise<DataHit[]> =>
    searchSnbDatasets(query, limit).map((d) => ({
      catalogue: "SNB data portal",
      id: d.id,
      title: d.title,
      description: `${d.description} (${d.frequency}; cube-id confidence: ${d.confidence})`,
      publisher: "Swiss National Bank",
      url: "https://data.snb.ch",
      next: { tool: "get_snb_data", args: { cube_id: d.id } },
    })),
});

export const fxModule: SwissyphusModule = {
  id: "fx",
  emoji: "💱",
  title: "Exchange rates & SNB data",
  description:
    "Official CHF exchange rates plus any Swiss National Bank data-portal cube (interest rates, SARON, bond yields, balance sheet, monetary aggregates)",
  sources: [snb, snbPortal],
  healthProbes: [lazyProbe, { sourceId: "snb-data", url: `${SNB_CUBE}/devkum/dimensions/en` }],
  tools: [
    tool({
      name: "get_exchange_rate",
      title: "Current CHF exchange rate",
      description:
        "Latest official SNB exchange rate for a currency against CHF (monthly average, e.g. EUR, USD, GBP, JPY). Rates are 'CHF per N units of foreign currency'.",
      inputSchema: {
        currency: z.string().length(3).describe("ISO currency code, e.g. 'EUR', 'USD', 'GBP', 'JPY'"),
      },
      handler: async ({ currency }) => {
        try {
          const code = currency.toUpperCase();
          const { data, cacheStatus, retrievedAt } = await fetchRates(currentMonth(-3), currentMonth());
          const series = (data.timeseries ?? []).filter(isMonthlyAverage);
          const match = series.find((s) => currencyOf(s)?.code === code);
          if (!match) {
            const available = [...new Set(series.map((s) => currencyOf(s)?.code).filter(Boolean))].sort();
            return toolError(`SNB publishes no CHF rate for '${code}'.`, [
              `Available currencies: ${available.join(", ")}`,
            ]);
          }
          const cur = currencyOf(match);
          const values = validValues(match);
          const latest = values[values.length - 1];
          if (!latest || cur === undefined) return toolError(`No recent rate values for '${code}'.`);
          return respond(
            {
              currency: code,
              rate_chf: latest.value,
              per_units: cur.per_units,
              meaning: `${cur.per_units} ${code} = ${latest.value} CHF (monthly average)`,
              month: latest.date,
            },
            { source: snb, cacheStatus, retrievedAt, dataAsOf: latest.date },
          );
        } catch (err) {
          return errorToResult(err, "SNB data portal");
        }
      },
    }),

    tool({
      name: "get_exchange_rate_history",
      title: "CHF exchange rate history",
      description: "Monthly average CHF exchange-rate history for a currency over a month range (YYYY-MM).",
      inputSchema: {
        currency: z.string().length(3).describe("ISO currency code, e.g. 'EUR'"),
        from_month: z.string().regex(/^\d{4}-\d{2}$/).describe(`Start month YYYY-MM (range at most ${MAX_HISTORY_MONTHS} months)`),
        to_month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("End month YYYY-MM (default: current)"),
      },
      handler: async ({ currency, from_month, to_month }) => {
        try {
          const code = currency.toUpperCase();
          const to = to_month ?? currentMonth();
          const rangeErr = monthRangeError(from_month, to);
          if (rangeErr) return toolError(rangeErr);
          const { data, cacheStatus, retrievedAt } = await fetchRates(from_month, to);
          const match = (data.timeseries ?? []).filter(isMonthlyAverage).find((s) => currencyOf(s)?.code === code);
          if (!match) return toolError(`SNB publishes no CHF rate for '${code}'.`);
          const cur = currencyOf(match);
          const history = validValues(match).map((v) => ({ month: v.date, rate_chf: v.value }));
          if (!history.length) return toolError(`No values in range ${from_month} – ${to_month ?? "now"}.`);
          return respond(
            {
              currency: code,
              per_units: cur?.per_units,
              unit: match.metadata?.unit,
              history,
            },
            { source: snb, cacheStatus, retrievedAt, dataAsOf: history[history.length - 1]?.month ?? undefined },
          );
        } catch (err) {
          return errorToResult(err, "SNB data portal");
        }
      },
    }),

    tool({
      name: "list_currencies",
      title: "List SNB-published currencies",
      description: "List all currencies for which the SNB publishes official CHF exchange rates.",
      inputSchema: {},
      handler: async () => {
        try {
          const { data, cacheStatus, retrievedAt } = await fetchRates(currentMonth(-2), currentMonth());
          const currencies = (data.timeseries ?? [])
            .filter(isMonthlyAverage)
            .map((s) => currencyOf(s))
            .filter((c): c is NonNullable<typeof c> => c !== undefined)
            .map((c) => ({ code: c.code, per_units: c.per_units, label: c.label }));
          return respond({ currencies }, { source: snb, cacheStatus, retrievedAt });
        } catch (err) {
          return errorToResult(err, "SNB data portal");
        }
      },
    }),

    tool({
      name: "list_snb_datasets",
      title: "List well-known SNB data cubes",
      description:
        "Curated list of well-known Swiss National Bank data-portal cube ids (FX rates, money market rates incl. SARON, Confederation bond yields, SNB balance sheet, monetary aggregates, CPI, effective exchange rates) with frequency and a confidence flag for each id. Optional keyword filter, e.g. 'saron', 'bond yield', 'balance sheet', 'M3'. Then call get_snb_cube_dimensions or get_snb_data with the cube_id. Any other cube id from data.snb.ch also works with those tools.",
      inputSchema: {
        query: z.string().max(100).optional().describe("Optional keywords, e.g. 'saron', 'inflation', 'bond'"),
      },
      handler: async ({ query }) => {
        const list = query ? searchSnbDatasets(query, SNB_DATASETS.length) : SNB_DATASETS;
        if (!list.length) {
          return toolError(`No curated SNB cube matches '${query}'.`, [
            "Call list_snb_datasets without a query to see all curated cubes.",
            "Browse https://data.snb.ch for other cube ids (the id appears in each table's URL).",
          ]);
        }
        return respond(
          {
            count: list.length,
            datasets: list.map((d) => ({
              cube_id: d.id,
              title: d.title,
              description: d.description,
              frequency: d.frequency,
              id_confidence: d.confidence,
            })),
            note: "Cube ids other than 'devkum' are curated from memory and should be verified: get_snb_cube_dimensions returns 'not found' for an invalid id.",
          },
          { source: snbPortal, cacheStatus: "computed", retrievedAt: new Date().toISOString() },
        );
      },
    }),

    tool({
      name: "get_snb_cube_dimensions",
      title: "SNB cube dimensions",
      description:
        "List the dimensions of any SNB data-portal cube and the item ids in each (e.g. devkum: D0 = monthly average 'M0' / end of month 'M1', D1 = currency 'EUR1', 'USD1', 'JPY100', …). Use the ids in get_snb_data's dimension_selection to fetch only the series you need. Examples: cube_id='devkum', cube_id='zimoma'.",
      inputSchema: {
        cube_id: cubeIdSchema,
        language: snbLangSchema,
        max_items_per_dimension: z.number().int().min(1).max(500).default(200).describe("Max items listed per dimension (default 200)"),
      },
      handler: async ({ cube_id, language, max_items_per_dimension }) => {
        try {
          const url = `${SNB_CUBE}/${encodeURIComponent(cube_id)}/dimensions/${language}`;
          const { data, cacheStatus, retrievedAt } = await fetchJson<SnbDimensionsResponse>(url, {
            ttlMs: snbPortal.cacheTtlSeconds * 1000,
          });
          const dimensions = parseSnbDimensions(data, max_items_per_dimension);
          if (!dimensions.length) {
            return toolError(`SNB cube '${cube_id}' returned no dimensions.`, [
              "Verify the cube id with list_snb_datasets or on https://data.snb.ch.",
            ]);
          }
          return respond(
            { cube_id: data.cubeId ?? cube_id, dimensions },
            { source: snbPortal, cacheStatus, retrievedAt, language },
          );
        } catch (err) {
          return snbPortalError(err, cube_id);
        }
      },
    }),

    tool({
      name: "get_snb_data",
      title: "SNB cube time series",
      description:
        "Fetch labelled time series from any Swiss National Bank data-portal cube: each series has its dimension labels, unit, scale and the most recent values (trimmed to values_per_series). Optional date range (YYYY, YYYY-MM or YYYY-MM-DD matching the cube frequency) and dimension_selection from get_snb_cube_dimensions, e.g. {\"D0\":[\"M0\"],\"D1\":[\"EUR1\",\"USD1\"]}. Examples: cube_id='zimoma' (money market rates incl. SARON), cube_id='devkum', from_date='2024-01'.",
      inputSchema: {
        cube_id: cubeIdSchema,
        from_date: snbDateSchema.describe("Start date, e.g. '2020-01' (monthly) or '2024-06-01' (daily)"),
        to_date: snbDateSchema.describe("End date, same format as from_date"),
        dimension_selection: z
          .record(z.string(), z.array(z.string().max(40)).min(1).max(50))
          .optional()
          .describe("Dimension id → item ids, e.g. {\"D0\":[\"M0\"],\"D1\":[\"EUR1\"]}"),
        language: snbLangSchema,
        limit: z.number().int().min(1).max(100).default(20).describe("Max series returned (default 20)"),
        values_per_series: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(24)
          .describe("Most recent observations kept per series (default 24; trimmed further if the output would exceed the 50 KB response cap)"),
      },
      handler: async ({ cube_id, from_date, to_date, dimension_selection, language, limit, values_per_series }) => {
        try {
          const url = withParams(`${SNB_CUBE}/${encodeURIComponent(cube_id)}/data/json/${language}`, {
            fromDate: from_date,
            toDate: to_date,
            dimSel: buildDimSel(dimension_selection),
          });
          const { data, cacheStatus, retrievedAt } = await fetchJson<{ timeseries?: SnbSeriesGeneric[] }>(url, {
            ttlMs: snbPortal.cacheTtlSeconds * 1000,
            timeoutMs: 30_000,
          });
          const out = labelSnbSeries(data, limit, values_per_series);
          if (!out.series.length) {
            return toolError(`SNB cube '${cube_id}' returned no time series for this selection.`, [
              "Widen the date range or drop dimension_selection.",
              "Check valid dimension item ids with get_snb_cube_dimensions.",
            ]);
          }
          const lastDates = out.series.map((s) => s.last_date).filter((d): d is string => !!d).sort();
          const build = (series: SnbLabelledSeries[], note?: string) => ({
            cube_id,
            series_count_total: out.series_count_total,
            series_returned: series.length,
            ...(out.series_count_total > series.length
              ? { truncated: "More series exist: raise limit or narrow with dimension_selection." }
              : {}),
            ...(note ? { note } : {}),
            series,
          });
          // Measure with a placeholder note so the real one always fits too.
          const fit = fitSnbSeries(out.series, (xs) => build(xs, "x".repeat(300)));
          const cuts: string[] = [];
          if (fit.values_per_series !== undefined) cuts.push(`values per series cut to the most recent ${fit.values_per_series}`);
          if (fit.dropped_series > 0) cuts.push(`${fit.dropped_series} series dropped`);
          const note = cuts.length
            ? `Trimmed to fit the 50 KB response cap: ${cuts.join("; ")}. Narrow from_date/to_date or dimension_selection, or lower limit / values_per_series.`
            : undefined;
          return respond(
            build(fit.series, note),
            {
              source: snbPortal,
              cacheStatus,
              retrievedAt,
              language,
              dataAsOf: lastDates[lastDates.length - 1],
              links: { portal: "https://data.snb.ch" },
            },
          );
        } catch (err) {
          return snbPortalError(err, cube_id);
        }
      },
    }),
  ],
};
