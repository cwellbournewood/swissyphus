/**
 * energiedashboard.ch — the Swiss Federal Office of Energy's (SFOE/BFE) daily
 * energy-supply indicators: electricity production by source, national
 * consumption (incl. estimate and forecast), cross-border electricity and gas
 * flows, the day-ahead spot price, monthly gas net imports and EU gas storage
 * levels. Each series is a small CSV on www.bfe-ogd.ch (listed on
 * opendata.swiss); the tools here are merged into the `energy` module.
 */

import { z } from "zod";
import { allowHosts, fetchCached } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type ToolDef } from "../core/module.js";
import type { HealthProbe, SourceManifest } from "../core/types.js";
import { parseCsv, type Row } from "../core/tabular.js";

allowHosts("www.bfe-ogd.ch");

export const bfeDashboard: SourceManifest = {
  id: "bfe-energiedashboard",
  name: "energiedashboard.ch — SFOE energy supply indicators",
  operator: "Swiss Federal Office of Energy (SFOE/BFE); data from Swissgrid, EEX/EPEX, ENTSOG, VSG, SDSC",
  url: "https://www.energiedashboard.admin.ch",
  licence:
    "opendata.swiss terms per series: 'terms_by' (open use, cite source) for flows, gas, storage and forecasts; 'terms_by_ask' (commercial use needs permission) for electricity production, consumption and spot prices",
  attribution: "Source: Swiss Federal Office of Energy, energiedashboard.ch (www.bfe-ogd.ch)",
  updateFrequency: "daily (gas net imports monthly)",
  cacheTtlSeconds: 3 * 3600,
  notes:
    "CSV files at www.bfe-ogd.ch/ogd1xx_*.csv. Swissgrid figures for the last ~6 months are provisional. " +
    "Aggregation sums energy quantities (GWh) and averages prices, percentages and storage levels.",
};

const BASE = "https://www.bfe-ogd.ch";

interface SeriesDef {
  id: string;
  file: string;
  label: string;
  unit: string;
  /** How to aggregate values over a period. */
  agg: "sum" | "mean";
  licence: "terms_by" | "terms_by_ask";
  /** Column holding a category (energy source, storage region), if long format. */
  dimension?: string;
}

export const SERIES: SeriesDef[] = [
  { id: "electricity_production", file: "ogd104_stromproduktion_swissgrid.csv", label: "Electricity production by energy source (Swissgrid)", unit: "GWh/day", agg: "sum", licence: "terms_by_ask", dimension: "Energietraeger" },
  { id: "electricity_consumption", file: "ogd103_stromverbrauch_swissgrid_lv_und_endv.csv", label: "National and final electricity consumption (Swissgrid)", unit: "GWh/day", agg: "sum", licence: "terms_by_ask" },
  { id: "electricity_consumption_estimate", file: "ogd103_stromverbrauch_geschaetzt_swissgrid.csv", label: "Model-based estimate of national electricity consumption (recent days)", unit: "GWh/day", agg: "sum", licence: "terms_by" },
  { id: "electricity_consumption_forecast", file: "ogd110_strom_verbrauch_prognose.csv", label: "Electricity final-consumption forecast min/mean/max (SDSC)", unit: "GWh/day", agg: "sum", licence: "terms_by" },
  { id: "electricity_cross_border", file: "ogd107_strom_import_export.csv", label: "Cross-border electricity flows per neighbour and net import", unit: "GWh/day", agg: "sum", licence: "terms_by" },
  { id: "electricity_spot_price", file: "ogd106_preise_strom_boerse.csv", label: "Day-ahead spot price Switzerland, baseload", unit: "EUR/MWh", agg: "mean", licence: "terms_by_ask" },
  { id: "gas_cross_border", file: "ogd101_gas_import_export.csv", label: "Cross-border gas flows per neighbour and net import", unit: "GWh/day", agg: "sum", licence: "terms_by" },
  { id: "gas_net_imports_monthly", file: "ogd111/ogd111_gas_nettoimport.csv", label: "Monthly gas net imports (VSG)", unit: "GWh/month", agg: "sum", licence: "terms_by" },
  { id: "gas_storage_eu", file: "ogd102_fuellstand_gasspeicher.csv", label: "Gas storage levels EU and neighbouring countries", unit: "TWh / % of capacity", agg: "mean", licence: "terms_by", dimension: "Speicherregion" },
];

const SERIES_IDS = SERIES.map((s) => s.id) as [string, ...string[]];

/** Normalise a series table to rows with a `date` (YYYY-MM-DD or YYYY-MM) key. */
export function normalizeSeries(table: { columns: string[]; rows: Row[] }): { dateCol: string; rows: Row[] } {
  const cols = table.columns;
  if (cols.includes("Jahr") && cols.includes("Monat")) {
    return {
      dateCol: "date",
      rows: table.rows.map((r) => {
        const { Jahr, Monat, ...rest } = r;
        return { date: `${Jahr}-${String(Monat).padStart(2, "0")}`, ...rest };
      }),
    };
  }
  const dateCol = cols.find((c) => /^(datum|date)$/i.test(c.trim())) ?? cols[0]!;
  return {
    dateCol,
    rows: table.rows.map((r) => {
      const { [dateCol]: d, ...rest } = r;
      return { date: String(d), ...rest };
    }),
  };
}

function periodKey(date: string, aggregate: string): string {
  if (aggregate === "year") return date.slice(0, 4);
  if (aggregate === "month") return date.slice(0, 7);
  if (aggregate === "week") {
    const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return date;
    const day = (d.getUTCDay() + 6) % 7; // Monday = 0
    d.setUTCDate(d.getUTCDate() - day + 3); // Thursday of this ISO week
    const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  }
  return date;
}

/** Aggregate rows by period (and dimension); numeric columns summed or averaged. */
export function aggregateSeries(rows: Row[], aggregate: string, agg: "sum" | "mean", dimension?: string): Row[] {
  if (aggregate === "day" || aggregate === "none") return rows;
  const groups = new Map<string, { key: Row; sums: Map<string, number>; counts: Map<string, number>; days: number }>();
  for (const r of rows) {
    const p = periodKey(String(r["date"]), aggregate);
    const dim = dimension ? String(r[dimension]) : "";
    const k = `${p}|${dim}`;
    let g = groups.get(k);
    if (!g) {
      g = { key: { period: p, ...(dimension ? { [dimension]: r[dimension] } : {}) }, sums: new Map(), counts: new Map(), days: 0 };
      groups.set(k, g);
    }
    g.days++;
    for (const [c, v] of Object.entries(r)) {
      if (c === "date" || c === dimension || typeof v !== "number") continue;
      g.sums.set(c, (g.sums.get(c) ?? 0) + v);
      g.counts.set(c, (g.counts.get(c) ?? 0) + 1);
    }
  }
  return [...groups.values()].map((g) => {
    const out: Row = { ...g.key, days: g.days };
    for (const [c, s] of g.sums) {
      const v = agg === "sum" ? s : s / (g.counts.get(c) ?? 1);
      out[c] = Math.round(v * 100) / 100;
    }
    return out;
  });
}

export const energyDashboardProbes: HealthProbe[] = [
  { sourceId: "bfe-energiedashboard", url: `${BASE}/ogd111/ogd111_gas_nettoimport.csv` },
];

export const energyDashboardTools: ToolDef[] = [
  tool({
    name: "get_energy_dashboard",
    title: "Swiss energy supply indicators (energiedashboard.ch)",
    description:
      "Daily Swiss energy-supply data from the Federal Office of Energy's energy dashboard: " +
      SERIES.map((s) => `'${s.id}' (${s.label}, ${s.unit})`).join("; ") +
      ". Returns the last `last_days` (default 30) or a date range, optionally aggregated by week/month/year (energy summed, prices/levels averaged) and filtered to one category " +
      "(production: 'Kernkraft', 'Flusskraft', 'Speicherkraft', 'Photovoltaik', 'Wind', 'Thermische'; gas storage: 'EU', 'Germany', 'Italy', …). Example: {series: 'electricity_production', aggregate: 'month', from: '2025-01-01'}.",
    inputSchema: {
      series: z.enum(SERIES_IDS).describe("Which indicator"),
      from: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/).optional().describe("Start date YYYY-MM-DD (or YYYY-MM for monthly series)"),
      to: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/).optional().describe("End date (inclusive)"),
      last_days: z.number().int().min(1).max(4000).default(30).describe("Without `from`: how many most recent dates to return"),
      aggregate: z.enum(["day", "week", "month", "year"]).default("day").describe("Aggregate to weeks, months or years"),
      category: z.string().max(60).optional().describe("Only this category (energy source or storage region)"),
    },
    handler: async ({ series, from, to, last_days, aggregate, category }) => {
      const def = SERIES.find((s) => s.id === series)!;
      try {
        const res = await fetchCached(`${BASE}/${def.file}`, {
          ttlMs: bfeDashboard.cacheTtlSeconds * 1000,
          timeoutMs: 30_000,
          maxBytes: 20 * 1024 * 1024,
        });
        const { rows: all } = normalizeSeries(parseCsv(res.data, { delimiter: "," }));
        let rows = all;
        let categories: string[] | undefined;
        if (def.dimension) {
          categories = [...new Set(all.map((r) => String(r[def.dimension!])))].sort();
          if (category) {
            const c = category.toLowerCase();
            rows = rows.filter((r) => String(r[def.dimension!]).toLowerCase() === c);
            if (!rows.length) return toolError(`Unknown category '${category}' for ${series}.`, [`Categories: ${categories.join(", ")}.`]);
          }
        }
        const dates = [...new Set(rows.map((r) => String(r["date"])))].sort();
        let keep: Set<string>;
        if (from || to) {
          keep = new Set(dates.filter((d) => (!from || d >= from) && (!to || d.slice(0, (to as string).length) <= to)));
        } else {
          keep = new Set(dates.slice(aggregate === "day" ? -last_days : -Math.max(last_days, 1)));
        }
        rows = rows.filter((r) => keep.has(String(r["date"])));
        const out = aggregateSeries(rows, aggregate, def.agg, def.dimension);
        if (!out.length) return toolError(`No ${series} data in that range.`, [`Available: ${dates[0]} to ${dates[dates.length - 1]}.`]);
        const capped = out.slice(-500);
        return respond(
          {
            series: { id: def.id, label: def.label, unit: def.unit, aggregation: aggregate === "day" ? (def.unit.includes("month") ? "monthly values" : "daily values") : `${def.agg} per ${aggregate}` },
            available_range: { from: dates[0], to: dates[dates.length - 1] },
            ...(categories && !category ? { categories } : {}),
            rows: capped,
            ...(out.length > capped.length ? { truncated: `showing the last 500 of ${out.length} rows; aggregate or narrow the range` } : {}),
            ...(def.licence === "terms_by_ask" ? { licence_note: "Commercial use of this series requires permission from the data owner (opendata.swiss terms_by_ask)." } : {}),
          },
          { source: bfeDashboard, cacheStatus: res.cacheStatus, retrievedAt: res.retrievedAt, dataAsOf: dates[dates.length - 1] },
        );
      } catch (err) {
        return errorToResult(err, "energiedashboard.ch");
      }
    },
  }),
];
