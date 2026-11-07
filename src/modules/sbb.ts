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

interface EdgeRecord {
  designationofficial?: string;
  designation?: string;
  sloid?: string;
  length?: number;
  height?: number;
  boardingareaheight?: number;
  compassdirection?: number;
  municipalityname?: string;
  cantonabbreviation?: string;
  meansoftransport?: string;
  businessorganisationabbreviationde?: string;
  validto?: string;
}

/** Platform height classes used by Swiss operators (BehiG): 55 cm = level boarding on most mainline trains. */
export function platformClass(heightCm: number | undefined): string | undefined {
  if (heightCm === undefined || heightCm === null) return undefined;
  if (heightCm >= 76) return "high platform (76 cm+): level boarding on high-floor stock";
  if (heightCm >= 55) return "standard 55 cm: level or near-level boarding on most SBB low-floor trains";
  if (heightCm >= 35) return "35 cm: level boarding on some regional low-floor trains; a step on most mainline trains";
  return "low platform (<35 cm): step or ramp needed";
}

export function mapEdge(r: EdgeRecord) {
  return {
    platform_edge: r.designation,
    length_m: r.length,
    height_cm: r.height,
    boarding_area_height_cm: r.boardingareaheight,
    assessment: platformClass(r.height),
    id: r.sloid,
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
            const late = await records<IstRecord>("ist-daten-sbb", { where: `${where} and ankunftsverspatung="true"`, limit: 100 }, 3_600_000);
            const rows = late.data.results ?? [];
            day = rows[0]?.betriebstag;
            delayed = rows
              .map((r) => ({ line: r.linien_text, type: r.verkehrsmittel_text, operator: r.betreiber_abk, scheduled_arrival: r.ankunftszeit, actual_arrival: r.an_prognose, delay_min: Math.round(Number(r.an_versp_sek ?? 0) / 6) / 10 }))
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
        "Platform edges at a stop with length and height, and what the height means for step-free boarding (55 cm = level boarding on most SBB low-floor trains, per the Swiss Disability Discrimination Act standards). Use for wheelchair, pram or luggage trip planning.",
      inputSchema: { station: stationArg },
      handler: async ({ station }) => {
        try {
          const { data, cacheStatus, retrievedAt } = await findByName<EdgeRecord>("haltestelle-haltekante", "designationofficial", station, { limit: 100 }, 86_400_000);
          const rows = data.results ?? [];
          if (!rows.length) return toolError(`No platform data for '${station}'.`, ["Use the official stop name, e.g. 'Bern' or 'Zürich HB'"], { kind: "not_found" });
          const stopName = rows[0]!.designationofficial;
          const edges = rows.filter((r) => r.designationofficial === stopName).map(mapEdge).sort((a, b) => String(a.platform_edge).localeCompare(String(b.platform_edge), "de", { numeric: true }));
          const heights = edges.map((e) => e.height_cm).filter((h): h is number => typeof h === "number");
          const level = heights.filter((h) => h >= 55).length;
          return respond(
            {
              stop: stopName,
              municipality: rows[0]!.municipalityname,
              canton: rows[0]!.cantonabbreviation,
              platform_edges: edges.length,
              edges_55cm_or_higher: level,
              summary: heights.length ? `${level} of ${heights.length} platform edges with a known height are 55 cm or higher.` : "No platform heights recorded.",
              edges,
            },
            { source: { ...source, updateFrequency: "when the stop register changes" }, cacheStatus, retrievedAt },
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
