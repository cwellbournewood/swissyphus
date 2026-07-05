/**
 * Holidays module — OpenHolidays API (openholidaysapi.org), which aggregates
 * official cantonal holiday calendars for Switzerland.
 */

import { z } from "zod";
import { fetchJson, withParams } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

const source: SourceManifest = {
  id: "openholidays",
  name: "OpenHolidays API — Swiss public & school holidays",
  operator: "OpenHolidays API project (openholidaysapi.org)",
  url: "https://openholidaysapi.org",
  licence: "Open Data Commons ODbL — free use with attribution",
  attribution: "Holiday data via OpenHolidays API (ODbL)",
  updateFrequency: "as cantonal calendars are published",
  cacheTtlSeconds: 24 * 3600,
};

const BASE = "https://openholidaysapi.org";

const CANTONS = [
  "AG","AI","AR","BE","BL","BS","FR","GE","GL","GR","JU","LU","NE","NW","OW","SG","SH","SO","SZ","TG","TI","UR","VD","VS","ZG","ZH",
] as const;

interface Holiday {
  startDate?: string;
  endDate?: string;
  name?: Array<{ language?: string; text?: string }>;
  nationwide?: boolean;
  subdivisions?: Array<{ code?: string; shortName?: string }>;
  type?: string;
}

function holidayName(h: Holiday): string {
  const en = h.name?.find((n) => n.language === "EN")?.text;
  return en ?? h.name?.[0]?.text ?? "";
}

function mapHolidays(data: Holiday[]) {
  return data.map((h) => ({
    name: holidayName(h),
    start_date: h.startDate,
    end_date: h.endDate !== h.startDate ? h.endDate : undefined,
    nationwide: h.nationwide,
    type: h.type,
    cantons: h.nationwide ? "all" : (h.subdivisions ?? []).map((s) => s.shortName ?? s.code).join(","),
  }));
}

function cantonParam(canton?: string): string | undefined {
  if (!canton) return undefined;
  const c = canton.toUpperCase().replace(/^CH-/, "");
  if (!(CANTONS as readonly string[]).includes(c)) {
    throw new Error(`Unknown canton '${canton}'. Use a two-letter code like ZH, BE, VD.`);
  }
  return `CH-${c}`;
}

export const holidaysModule: SwissyphusModule = {
  id: "holidays",
  emoji: "🎉",
  title: "Holidays",
  description: "Public and school holidays for all 26 cantons; is-today-a-holiday check",
  sources: [source],
  healthProbes: [
    {
      sourceId: "openholidays",
      url: `${BASE}/PublicHolidays?countryIsoCode=CH&languageIsoCode=EN&validFrom=2026-01-01&validTo=2026-01-31`,
    },
  ],
  tools: [
    tool({
      name: "get_public_holidays",
      title: "Public holidays",
      description:
        "Public holidays in Switzerland for a year, optionally scoped to a canton (two-letter code). Includes nationwide and cantonal holidays.",
      inputSchema: {
        year: z.number().int().min(2020).max(2035).optional().describe("Year (default: current year)"),
        canton: z.string().optional().describe("Canton code, e.g. 'ZH', 'GE' (default: whole country)"),
      },
      handler: async ({ year, canton }) => {
        try {
          const y = year ?? new Date().getFullYear();
          const url = withParams(`${BASE}/PublicHolidays`, {
            countryIsoCode: "CH",
            languageIsoCode: "EN",
            validFrom: `${y}-01-01`,
            validTo: `${y}-12-31`,
            subdivisionCode: cantonParam(canton),
          });
          const { data, cacheStatus, retrievedAt } = await fetchJson<Holiday[]>(url, {
            ttlMs: source.cacheTtlSeconds * 1000,
          });
          return respond(
            { year: y, canton: canton?.toUpperCase(), holidays: mapHolidays(data) },
            { source, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "OpenHolidays API");
        }
      },
    }),

    tool({
      name: "get_school_holidays",
      title: "School holidays",
      description: "School holiday periods for a Swiss canton and year.",
      inputSchema: {
        canton: z.string().describe("Canton code, e.g. 'ZH', 'BE', 'VD'"),
        year: z.number().int().min(2020).max(2035).optional().describe("Year (default: current year)"),
      },
      handler: async ({ canton, year }) => {
        try {
          const y = year ?? new Date().getFullYear();
          const url = withParams(`${BASE}/SchoolHolidays`, {
            countryIsoCode: "CH",
            languageIsoCode: "EN",
            validFrom: `${y}-01-01`,
            validTo: `${y}-12-31`,
            subdivisionCode: cantonParam(canton),
          });
          const { data, cacheStatus, retrievedAt } = await fetchJson<Holiday[]>(url, {
            ttlMs: source.cacheTtlSeconds * 1000,
          });
          if (!data.length) {
            return toolError(`No school holidays published for ${canton.toUpperCase()} in ${y}.`);
          }
          return respond(
            { year: y, canton: canton.toUpperCase(), school_holidays: mapHolidays(data) },
            { source, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "OpenHolidays API");
        }
      },
    }),

    tool({
      name: "is_holiday_today",
      title: "Is today a holiday?",
      description: "Check whether today (or a given date) is a public holiday in a canton or nationwide.",
      inputSchema: {
        canton: z.string().optional().describe("Canton code (default: nationwide check)"),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Date YYYY-MM-DD (default: today)"),
      },
      handler: async ({ canton, date }) => {
        try {
          const d = date ?? new Date().toISOString().slice(0, 10);
          const url = withParams(`${BASE}/PublicHolidays`, {
            countryIsoCode: "CH",
            languageIsoCode: "EN",
            validFrom: d,
            validTo: d,
            subdivisionCode: cantonParam(canton),
          });
          const { data, cacheStatus, retrievedAt } = await fetchJson<Holiday[]>(url, {
            ttlMs: 3600 * 1000,
          });
          const holidays = mapHolidays(data);
          return respond(
            {
              date: d,
              canton: canton?.toUpperCase() ?? "nationwide",
              is_holiday: holidays.length > 0,
              holidays,
            },
            { source, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "OpenHolidays API");
        }
      },
    }),
  ],
};
