/**
 * SBB open data (data.sbb.ch, Opendatasoft Explore API v2.1): station
 * passenger frequencies, previous-day punctuality per station, platform-edge
 * accessibility, and current rail traffic disruptions.
 */

import { z } from "zod";
import { fetchJson, withParams } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";
import { normalizeText } from "./_cantons.js";

const API = "https://data.sbb.ch/api/explore/v2.1/catalog/datasets";

const source: SourceManifest = {
  id: "sbb-opendata",
  name: "SBB Open Data",
  operator: "Swiss Federal Railways (SBB CFF FFS)",
  url: "https://data.sbb.ch",
  licence: "SBB Open Data terms — free use with attribution",
  attribution: "© SBB CFF FFS",
  updateFrequency: "per dataset: disruptions continuous, punctuality daily, passenger counts yearly",
  cacheTtlSeconds: 3600,
};

interface OdsResponse<T> {
  total_count?: number;
  results?: T[];
}

/** Quote a user string as an ODSQL string literal (double quotes and backslashes escaped). */
export function odsString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function records<T>(dataset: string, params: Record<string, string | number | undefined>, ttlMs: number) {
  return fetchJson<OdsResponse<T>>(withParams(`${API}/${dataset}/records`, params), { ttlMs, timeoutMs: 30_000 });
}

/** Exact field match first, then a case-insensitive "contains" fallback. */
async function findByName<T>(dataset: string, field: string, name: string, extra: Record<string, string | number | undefined>, ttlMs: number) {
  const exact = await records<T>(dataset, { ...extra, where: `${field}=${odsString(name)}` }, ttlMs);
  if (exact.data.results?.length) return exact;
  return records<T>(dataset, { ...extra, where: `${field} like ${odsString(`%${name}%`)}` }, ttlMs);
}

// ── passengers ──────────────────────────────────────────────────────────────

interface FreqRecord {
  code_codice?: string;
  uic?: number;
  bahnhof_gare_stazione?: string;
  kt_ct_cantone?: string;
  isb_gi?: string;
  jahr_annee_anno?: string;
  dtv_tjm_tgm?: number;
  dwv_tmjo_tfm?: number;
  dnwv_tmjno_tmgnl?: number;
  remarks?: string;
  geopos?: { lat?: number; lon?: number };
}

export function groupFrequencies(rows: FreqRecord[]) {
  const by = new Map<string, { station: string; uic?: number; code?: string; canton?: string; infrastructure_manager?: string; lat?: number; lon?: number; years: Array<Record<string, unknown>> }>();
  for (const r of rows) {
    const name = r.bahnhof_gare_stazione ?? "?";
    const g = by.get(name) ?? { station: name, uic: r.uic, code: r.code_codice, canton: r.kt_ct_cantone, infrastructure_manager: r.isb_gi, lat: r.geopos?.lat, lon: r.geopos?.lon, years: [] };
    g.years.push({
      year: Number(r.jahr_annee_anno),
      avg_daily_passengers: r.dtv_tjm_tgm,
      avg_weekday_passengers: r.dwv_tmjo_tfm,
      avg_non_working_day_passengers: r.dnwv_tmjno_tmgnl,
      ...(r.remarks ? { remarks: r.remarks } : {}),
    });
    by.set(name, g);
  }
  for (const g of by.values()) g.years.sort((a, b) => (b["year"] as number) - (a["year"] as number));
  return [...by.values()];
}

// ── punctuality ─────────────────────────────────────────────────────────────

interface IstRecord {
  betriebstag?: string;
  linien_text?: string;
  verkehrsmittel_text?: string;
  betreiber_abk?: string;
  haltestellen_name?: string;
  ankunftszeit?: string;
  an_prognose?: string;
  abfahrtszeit?: string;
  ab_prognose?: string;
  an_versp_sek?: string;
  faellt_aus_tf?: boolean;
}

interface GroupRow {
  ankunftsverspatung?: string;
  faellt_aus_tf?: boolean;
  n?: number;
}

/** Minutes between scheduled and actual time (positive = late). Times are local ISO without offset. */
export function delayMinutes(scheduled: string | undefined, actual: string | undefined): number | undefined {
  if (!scheduled || !actual) return undefined;
  const a = Date.parse(`${actual}Z`);
  const s = Date.parse(`${scheduled}Z`);
  if (Number.isNaN(a) || Number.isNaN(s)) return undefined;
  return Math.round((a - s) / 6000) / 10;
}

/** SBB definition: a stop is punctual when the delay is under 3 minutes; cancellations count separately. */
export function punctualityFromGroups(groups: GroupRow[]) {
  let onTime = 0;
  let late = 0;
  let cancelled = 0;
  for (const g of groups) {
    const n = g.n ?? 0;
    if (g.faellt_aus_tf) cancelled += n;
    else if (g.ankunftsverspatung === "true") late += n;
    else onTime += n;
  }
  const operated = onTime + late;
  return {
    scheduled_stops: operated + cancelled,
    operated_stops: operated,
    punctual_stops: onTime,
    delayed_stops_3min_plus: late,
    cancelled_stops: cancelled,
    punctuality_pct: operated ? Math.round((onTime / operated) * 1000) / 10 : undefined,
    cancellation_rate_pct: operated + cancelled ? Math.round((cancelled / (operated + cancelled)) * 1000) / 10 : undefined,
  };
}

// ── accessibility ───────────────────────────────────────────────────────────

interface PlatformRecord {
  bps_name?: string;
  bps?: string;
  bpuic?: string;
  linie?: number;
  perrontyp?: string;
  p_nr?: string;
  p_lange?: number;
  perronflach_netto_m2?: number;
  z_schienenfrei?: string;
  dok_pfm?: string;
  geopos?: { lat?: number; lon?: number };
}

const PLATFORM_TYPES: Record<string, string> = {
  Mittelperron: "island platform",
  Hausperron: "side platform (station-building side)",
  Seitenperron: "side platform",
  Aussenperron: "outer side platform",
  Zwischenperron: "intermediate platform",
};

export function mapPlatform(r: PlatformRecord) {
  const access = r.z_schienenfrei?.toLowerCase();
  return {
    platform: r.p_nr,
    type: r.perrontyp ? PLATFORM_TYPES[r.perrontyp] ?? r.perrontyp : undefined,
    length_m: r.p_lange,
    usable_area_m2: r.perronflach_netto_m2,
    step_free_access: access === "ja" ? true : access === "nein" ? false : undefined,
    line: r.linie,
  };
}

// ── disruptions ─────────────────────────────────────────────────────────────

interface DisruptionRecord {
  title?: string;
  link?: string;
  description?: string;
  published?: string;
  startdatetime?: string;
  enddatetime?: string;
  cause?: string | null;
  author?: string;
  type?: string;
}

export function mapDisruption(r: DisruptionRecord) {
  return {
    title: r.title,
    description: r.description?.replace(/\s+/g, " ").trim(),
    start: r.startdatetime,
    end: r.enddatetime,
    published: r.published,
    cause: r.cause ?? undefined,
    operator: r.author,
    link: r.link,
  };
}

const stationArg = z.string().min(2).describe("Station name as signposted, e.g. 'Zürich HB', 'Bern', 'Lausanne'");

export const sbbModule: SwissyphusModule = {
  id: "sbb",
  emoji: "🚉",
  title: "SBB open data",
  description: "Station passenger numbers, yesterday's punctuality per station, platform accessibility, live rail disruptions",
  sources: [source],
  healthProbes: [{ sourceId: "sbb-opendata", url: `${API}/rail-traffic-information/records?limit=1` }],
  tools: [
    tool({
      name: "get_station_passengers",
      title: "Station passenger numbers",
      description:
        "Average daily, weekday and non-working-day passengers (boardings + alightings) at an SBB station, per survey year (newest first). Also canton, infrastructure manager and coordinates.",
      inputSchema: { station: stationArg, years: z.number().int().min(1).max(20).default(5) },
      handler: async ({ station, years }) => {
        try {
          const { data, cacheStatus, retrievedAt } = await findByName<FreqRecord>("passagierfrequenz", "bahnhof_gare_stazione", station, { limit: 100, order_by: "jahr_annee_anno desc" }, 86_400_000);
          const groups = groupFrequencies(data.results ?? []);
          if (!groups.length) return toolError(`No SBB passenger counts for '${station}'.`, ["Use the official station name, e.g. 'Zürich HB'", "Only stations served by SBB-network trains are counted"], { kind: "not_found" });
          const nq = normalizeText(station);
          groups.sort((a, b) => Number(normalizeText(b.station) === nq) - Number(normalizeText(a.station) === nq));
          return respond(
            { stations: groups.slice(0, 5).map((g) => ({ ...g, years: g.years.slice(0, years) })) },
            { source: { ...source, updateFrequency: "yearly" }, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "SBB passenger frequencies");
        }
      },
    }),
    tool({
      name: "get_station_punctuality",
      title: "Station punctuality (previous day)",
      description:
        "Punctuality at a station for the most recent operating day in SBB's actual-data feed (usually yesterday): stops operated, share punctual (delay < 3 min, SBB's definition), delayed and cancelled stops, and the most-delayed arrivals. Covers all operators reporting to the national feed.",
      inputSchema: { station: stationArg, worst: z.number().int().min(0).max(20).default(5).describe("How many most-delayed arrivals to list") },
      handler: async ({ station, worst }) => {
        try {
          const where = `haltestellen_name=${odsString(station)}`;
          const groups = await records<GroupRow>("ist-daten-sbb", { select: "count(*) as n", where, group_by: "ankunftsverspatung,faellt_aus_tf", limit: 10 }, 3_600_000);
          const stats = punctualityFromGroups(groups.data.results ?? []);
          if (!stats.scheduled_stops) return toolError(`No actual-data records for '${station}' on the latest operating day.`, ["Use the exact stop name, e.g. 'Zürich HB', 'Bern', 'Genève'"], { kind: "not_found" });
          let delayed: Array<Record<string, unknown>> = [];
          let day: string | undefined;
          if (worst > 0) {
            const pages = Math.min(5, Math.ceil(stats.delayed_stops_3min_plus / 100));
            const lateSets = await Promise.all(
              Array.from({ length: Math.max(1, pages) }, (_, i) =>
                records<IstRecord>("ist-daten-sbb", { where: `${where} and ankunftsverspatung="true"`, limit: 100, offset: i * 100 }, 3_600_000),
              ),
            );
            const rows = lateSets.flatMap((l) => l.data.results ?? []);
            day = rows[0]?.betriebstag;
            delayed = rows
              .map((r) => ({ line: r.linien_text, type: r.verkehrsmittel_text, operator: r.betreiber_abk, scheduled_arrival: r.ankunftszeit, actual_arrival: r.an_prognose, delay_min: delayMinutes(r.ankunftszeit, r.an_prognose) }))
              .filter((r): r is typeof r & { delay_min: number } => r.delay_min !== undefined)
              .sort((a, b) => b.delay_min - a.delay_min)
              .slice(0, worst);
          }
          return respond(
            { station, operating_day: day, ...stats, most_delayed_arrivals: worst ? delayed : undefined },
            { source: { ...source, updateFrequency: "daily (previous operating day)" }, cacheStatus: groups.cacheStatus, retrievedAt: groups.retrievedAt, ...(day ? { dataAsOf: day } : {}) },
          );
        } catch (err) {
          return errorToResult(err, "SBB actual data");
        }
      },
    }),
    tool({
      name: "get_station_accessibility",
      title: "Station platform accessibility",
      description:
        "Platforms at an SBB station: platform number, type (island/side), length, usable area, and whether it can be reached step-free without crossing tracks ('rail-free access'). Use for wheelchair, pram or heavy-luggage trip planning; confirm lift status with SBB on the day.",
      inputSchema: { station: stationArg },
      handler: async ({ station }) => {
        try {
          const { data, cacheStatus, retrievedAt } = await findByName<PlatformRecord>("perron", "bps_name", station, { limit: 100 }, 86_400_000);
          const rows = data.results ?? [];
          if (!rows.length) return toolError(`No platform data for '${station}'.`, ["Use the official station name, e.g. 'Bern Wankdorf'", "The platform register covers stations on the SBB infrastructure network"], { kind: "not_found" });
          const nq = normalizeText(station);
          const names = [...new Set(rows.map((r) => r.bps_name ?? "?"))];
          const name = names.find((n) => normalizeText(n) === nq) ?? names[0]!;
          const platforms = rows
            .filter((r) => r.bps_name === name)
            .map(mapPlatform)
            .sort((a, b) => String(a.platform).localeCompare(String(b.platform), "de", { numeric: true }));
          const known = platforms.filter((p) => p.step_free_access !== undefined);
          const stepFree = known.filter((p) => p.step_free_access).length;
          return respond(
            {
              station: name,
              other_matches: names.length > 1 ? names.filter((n) => n !== name).slice(0, 10) : undefined,
              platform_count: platforms.length,
              step_free_platforms: stepFree,
              summary: known.length
                ? stepFree === known.length
                  ? `All ${known.length} platforms have step-free (rail-free) access.`
                  : `${stepFree} of ${known.length} platforms have step-free (rail-free) access.`
                : "No access information recorded.",
              platforms,
            },
            { source: { ...source, updateFrequency: "when the platform register changes" }, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "SBB platform register");
        }
      },
    }),
    tool({
      name: "get_rail_disruptions",
      title: "Current rail traffic disruptions",
      description:
        "Current and recent SBB rail traffic information: interruptions, restrictions and replacement buses, newest first. Optionally filter by a place or line in the text (e.g. 'Gotthard', 'S12', 'Lausanne').",
      inputSchema: {
        query: z.string().min(2).optional(),
        active_only: z.boolean().default(true).describe("Only messages whose validity has not yet ended"),
        limit: z.number().int().min(1).max(30).default(10),
      },
      handler: async ({ query, active_only, limit }) => {
        try {
          const clauses: string[] = [];
          if (active_only) clauses.push(`enddatetime >= now()`);
          if (query) clauses.push(`search(${odsString(query)})`);
          const { data, cacheStatus, retrievedAt } = await records<DisruptionRecord>(
            "rail-traffic-information",
            { where: clauses.length ? clauses.join(" and ") : undefined, order_by: "published desc", limit },
            300_000,
          );
          const items = (data.results ?? []).map(mapDisruption);
          return respond(
            { match_count: data.total_count ?? items.length, status: items.length ? `${items.length} message(s)` : "no matching disruptions reported", disruptions: items },
            { source: { ...source, updateFrequency: "continuous", cacheTtlSeconds: 300 }, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "SBB rail traffic information");
        }
      },
    }),
  ],
};
