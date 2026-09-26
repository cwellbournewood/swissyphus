/**
 * Holidays module — OpenHolidays API (openholidaysapi.org), which aggregates
 * official cantonal holiday calendars for Switzerland.
 */

import { z } from "zod";
import { fetchJson, withParams } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { HealthProbe, SourceManifest } from "../core/types.js";
import { swissDate, swissYear, isValidIsoDate } from "./_time.js";
import { resolveCanton } from "./_cantons.js";

const source: SourceManifest = {
  id: "openholidays",
  name: "OpenHolidays API — Swiss public & school holidays",
  operator: "OpenHolidays API project (openholidaysapi.org)",
  url: "https://openholidaysapi.org",
  licence:
    "Open Data Commons Open Database License (ODbL) v1.0 — attribution required; share-alike: adapted databases built from this data must be shared under the ODbL",
  attribution: "Holiday data © OpenHolidays API contributors, licensed under ODbL (https://opendatacommons.org/licenses/odbl/)",
  updateFrequency: "as cantonal calendars are published",
  cacheTtlSeconds: 24 * 3600,
};

const BASE = "https://openholidaysapi.org";

export interface Holiday {
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

export function mapHolidays(data: Holiday[]) {
  return data.map((h) => ({
    name: holidayName(h),
    start_date: h.startDate,
    end_date: h.endDate !== h.startDate ? h.endDate : undefined,
    nationwide: h.nationwide,
    type: h.type,
    cantons: h.nationwide ? "all" : (h.subdivisions ?? []).map((s) => s.shortName ?? s.code).join(","),
  }));
}

/**
 * Resolve a canton argument (code like 'ZH'/'CH-ZH' or a name in DE/FR/IT/EN)
 * to the OpenHolidays subdivision code. Unknown input yields an error message
 * so the handler can return a proper tool error instead of throwing.
 */
export function cantonParam(canton?: string): { code?: string; subdivision?: string; error?: string } {
  if (canton === undefined || canton.trim() === "") return {};
  const c = resolveCanton(canton);
  if (!c) return { error: `Unknown canton '${canton}'. Use a two-letter code like ZH, BE, VD.` };
  return { code: c, subdivision: `CH-${c}` };
}

/**
 * Holidays that make `date` a public holiday for the requested scope. Without
 * a canton, only holidays flagged `nationwide === true` count — a cantonal
 * holiday (e.g. Berchtoldstag in some cantons) does not make a day a
 * nationwide holiday.
 */
export function holidaysForScope(data: Holiday[], canton: string | undefined): Holiday[] {
  return canton ? data : data.filter((h) => h.nationwide === true);
}

const lazyProbe: HealthProbe = {
  sourceId: "openholidays",
  get url() {
    const y = swissYear();
    return `${BASE}/PublicHolidays?countryIsoCode=CH&languageIsoCode=EN&validFrom=${y}-01-01&validTo=${y}-01-31`;
  },
};

const unknownCantonSuggestions = [
  "Use a two-letter canton code (e.g. ZH, BE, VD, TI) or the canton's name.",
];

export const holidaysModule: SwissyphusModule = {
  id: "holidays",
  emoji: "🎉",
  title: "Holidays",
  description: "Public and school holidays for all 26 cantons; is-today-a-holiday check",
  sources: [source],
  healthProbes: [lazyProbe],
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
        const cp = cantonParam(canton);
        if (cp.error) return toolError(cp.error, unknownCantonSuggestions);
        try {
          const y = year ?? swissYear();
          const url = withParams(`${BASE}/PublicHolidays`, {
            countryIsoCode: "CH",
            languageIsoCode: "EN",
            validFrom: `${y}-01-01`,
            validTo: `${y}-12-31`,
            subdivisionCode: cp.subdivision,
          });
          const { data, cacheStatus, retrievedAt } = await fetchJson<Holiday[]>(url, {
            ttlMs: source.cacheTtlSeconds * 1000,
          });
          if (!Array.isArray(data)) return toolError("OpenHolidays API returned an unrecognised format.", [], { kind: "unavailable" });
          return respond(
            { year: y, canton: cp.code, holidays: mapHolidays(data) },
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
        const cp = cantonParam(canton);
        if (cp.error || !cp.code) return toolError(cp.error ?? "A canton is required.", unknownCantonSuggestions);
        try {
          const y = year ?? swissYear();
          const url = withParams(`${BASE}/SchoolHolidays`, {
            countryIsoCode: "CH",
            languageIsoCode: "EN",
            validFrom: `${y}-01-01`,
            validTo: `${y}-12-31`,
            subdivisionCode: cp.subdivision,
          });
          const { data, cacheStatus, retrievedAt } = await fetchJson<Holiday[]>(url, {
            ttlMs: source.cacheTtlSeconds * 1000,
          });
          if (!Array.isArray(data)) return toolError("OpenHolidays API returned an unrecognised format.", [], { kind: "unavailable" });
          if (!data.length) {
            return toolError(`No school holidays published for ${cp.code} in ${y}.`);
          }
          return respond(
            { year: y, canton: cp.code, school_holidays: mapHolidays(data) },
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
      description:
        "Check whether today (Swiss local date) or a given date is a public holiday in a canton, or — without a canton — whether it is a nationwide public holiday (cantonal-only holidays are listed separately and do not count).",
      inputSchema: {
        canton: z.string().optional().describe("Canton code (default: nationwide check)"),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Date YYYY-MM-DD (default: today)"),
      },
      handler: async ({ canton, date }) => {
        const cp = cantonParam(canton);
        if (cp.error) return toolError(cp.error, unknownCantonSuggestions);
        if (date !== undefined && !isValidIsoDate(date)) return toolError(`'${date}' is not a valid calendar date.`);
        try {
          const d = date ?? swissDate();
          const url = withParams(`${BASE}/PublicHolidays`, {
            countryIsoCode: "CH",
            languageIsoCode: "EN",
            validFrom: d,
            validTo: d,
            subdivisionCode: cp.subdivision,
          });
          const { data, cacheStatus, retrievedAt } = await fetchJson<Holiday[]>(url, {
            ttlMs: 3600 * 1000,
          });
          if (!Array.isArray(data)) return toolError("OpenHolidays API returned an unrecognised format.", [], { kind: "unavailable" });
          const matching = holidaysForScope(data, cp.code);
          const cantonalOnly = cp.code ? [] : data.filter((h) => h.nationwide !== true);
          return respond(
            {
              date: d,
              canton: cp.code ?? "nationwide",
              is_holiday: matching.length > 0,
              holidays: mapHolidays(matching),
              ...(cantonalOnly.length ? { cantonal_holidays_elsewhere: mapHolidays(cantonalOnly) } : {}),
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
