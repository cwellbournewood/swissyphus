/**
 * Exchange rates module — Swiss National Bank data portal (data.snb.ch),
 * cube devkum: monthly average CHF exchange rates published by the SNB.
 */

import { z } from "zod";
import { fetchJson, withParams } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

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
  values?: Array<{ date?: string; value?: number }>;
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

function currentMonth(offset = 0): string {
  // Anchor to day 1 before shifting months: setMonth on a 29–31st day rolls
  // over (e.g. 2026-07-31 + (-3) → April 31 → May 1), skipping a month.
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return d.toISOString().slice(0, 7);
}

export const fxModule: SwissyphusModule = {
  id: "fx",
  emoji: "💱",
  title: "Exchange rates (SNB)",
  description: "Official CHF exchange rates from the Swiss National Bank (monthly averages)",
  sources: [snb],
  healthProbes: [
    { sourceId: "snb-fx", url: withParams(BASE, { fromDate: currentMonth(-2), toDate: currentMonth() }) },
  ],
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
          const values = (match.values ?? []).filter((v) => v.value !== undefined);
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
        from_month: z.string().regex(/^\d{4}-\d{2}$/).describe("Start month YYYY-MM"),
        to_month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("End month YYYY-MM (default: current)"),
      },
      handler: async ({ currency, from_month, to_month }) => {
        try {
          const code = currency.toUpperCase();
          const { data, cacheStatus, retrievedAt } = await fetchRates(from_month, to_month ?? currentMonth());
          const match = (data.timeseries ?? []).filter(isMonthlyAverage).find((s) => currencyOf(s)?.code === code);
          if (!match) return toolError(`SNB publishes no CHF rate for '${code}'.`);
          const cur = currencyOf(match);
          const history = (match.values ?? []).map((v) => ({ month: v.date, rate_chf: v.value }));
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
  ],
};
