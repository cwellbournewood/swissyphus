/**
 * SBB station data — ridership per station, yesterday's punctuality and
 * platform access, from SBB's open-data platform (data.sbb.ch, Opendatasoft
 * Explore API v2.1). Complements the live timetable in `transport`.
 */

import { z } from "zod";
import { allowHosts, fetchJson, sourceCache, withParams } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { CacheStatus, SourceManifest } from "../core/types.js";

allowHosts("data.sbb.ch");

const API = "https://data.sbb.ch/api/explore/v2.1/catalog/datasets";

function sbbSource(id: string, name: string, dataset: string, ttl: number, maxStale: number, freq: string): SourceManifest {
  return {
    id,
    name,
    operator: "Swiss Federal Railways (SBB CFF FFS)",
    url: `https://data.sbb.ch/explore/dataset/${dataset}/`,
    licence: "SBB open-data terms: free use with attribution",
    attribution: "Data © SBB CFF FFS, data.sbb.ch",
    updateFrequency: freq,
    cacheTtlSeconds: ttl,
    maxStaleSeconds: maxStale,
  };
}

const ridershipSrc = sbbSource("sbb-ridership", "SBB passenger frequency per station", "passagierfrequenz", 24 * 3600, 400 * 86_400, "yearly");
const actualsSrc = sbbSource("sbb-actuals", "SBB actual train times (previous operating day)", "ist-daten-sbb", 3600, 2 * 86_400, "daily, previous operating day");
const platformSrc = sbbSource("sbb-platforms", "SBB platforms", "perron", 24 * 3600, 90 * 86_400, "as infrastructure changes");

interface OdsRecords<T = Record<string, unknown>> {
  total_count?: number;
  results?: T[];
}

/** ODSQL string literal: double-quoted, quotes and backslashes removed (station names never contain them). */
export function odsString(s: string): string {
  return `"${s.replace(/["\\]/g, "").trim()}"`;
}

function cleanStation(s: string): string {
  return s.replace(/["\\%*]/g, "").replace(/\s+/g, " ").trim();
}

async function records<T>(dataset: string, src: SourceManifest, params: Record<string, string | number | undefined>) {
  return fetchJson<OdsRecords<T>>(withParams(`${API}/${dataset}/records`, params), {
    ...sourceCache(src),
    timeoutMs: 20_000,
    validate: (v) => typeof v === "object" && v !== null && Array.isArray((v as OdsRecords).results),
  });
}

const rank: Record<CacheStatus, number> = { computed: 0, hit: 1, miss: 2, stale: 3 };
function worst(a: CacheStatus, b: CacheStatus): CacheStatus {
  return rank[b] > rank[a] ? b : a;
}

/** Exact station match first; otherwise the closest names, so the caller can pick. */
async function resolveStation(dataset: string, src: SourceManifest, field: string, station: string): Promise<{ exact: boolean; candidates: string[] }> {
  const exact = await records<Record<string, unknown>>(dataset, src, { where: `${field}=${odsString(station)}`, limit: 1, select: field });
  if ((exact.data.total_count ?? exact.data.results?.length ?? 0) > 0) return { exact: true, candidates: [station] };
  const like = await records<Record<string, unknown>>(dataset, src, {
    where: `${field} like ${odsString(station)}`,
    group_by: field,
    select: field,
    limit: 10,
  });
  return { exact: false, candidates: (like.data.results ?? []).map((r) => String(r[field] ?? "")).filter(Boolean) };
}

function notFound(station: string, candidates: string[], what: string) {
  return toolError(
    candidates.length
      ? `No SBB ${what} for exactly '${station}'. Did you mean: ${candidates.slice(0, 8).join(", ")}?`
      : `No SBB ${what} found for '${station}'.`,
    candidates.length
      ? ["Call again with one of the exact station names above."]
      : ["Use the official station name, e.g. 'Zürich HB', 'Bern', 'Lausanne'. search_stations finds it."],
    { kind: "not_found" },
  );
}

// ── Ridership ────────────────────────────────────────────────────────────

interface RidershipRow {
  bahnhof_gare_stazione?: string;
  uic?: number | string;
  code_codice?: string;
  kt_ct_cantone?: string;
  jahr_annee_anno?: string | number;
  dtv_tjm_tgm?: number;
  dwv_tmjo_tfm?: number;
  dnwv_tmjno_tmgnl?: number;
  evu_ef_itf?: string;
}

export function summariseRidership(rows: RidershipRow[]) {
  const years = rows
    .map((r) => ({
      year: Number(String(r.jahr_annee_anno ?? "").slice(0, 4)),
      daily_avg: r.dtv_tjm_tgm ?? null,
      weekday_avg: r.dwv_tmjo_tfm ?? null,
      weekend_avg: r.dnwv_tmjno_tmgnl ?? null,
    }))
    .filter((r) => Number.isFinite(r.year))
    .sort((a, b) => b.year - a.year);
  const withChange = years.map((y, i) => {
    const prev = years[i + 1];
    const change =
      prev && y.daily_avg != null && prev.daily_avg ? Math.round(((y.daily_avg - prev.daily_avg) / prev.daily_avg) * 1000) / 10 : null;
    return { ...y, change_vs_previous_year_pct: change };
  });
  const first = rows[0] ?? {};
  return {
    station: first.bahnhof_gare_stazione,
    code: first.code_codice,
    uic: first.uic ?? null,
    canton: first.kt_ct_cantone,
    operators: first.evu_ef_itf,
    unit: "boardings and alightings per day (annual average)",
    latest: withChange[0] ?? null,
    by_year: withChange,
  };
}

// ── Punctuality ──────────────────────────────────────────────────────────

export function onTimePct(delayed: number, total: number): number | null {
  return total > 0 ? Math.round(((total - delayed) / total) * 1000) / 10 : null;
}

// ── Platforms ────────────────────────────────────────────────────────────

interface PlatformRow {
  bps?: string;
  bps_name?: string;
  p_nr?: string | number;
  p_lange?: number;
  z_schienenfrei?: string;
  perrontyp?: string;
}

export function isTrackFree(v: unknown): boolean | null {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return null;
  if (["ja", "yes", "oui", "si", "sì", "true", "1"].includes(s)) return true;
  if (["nein", "no", "non", "false", "0"].includes(s)) return false;
  return null;
}

export const sbbModule: SwissyphusModule = {
  id: "sbb",
  emoji: "🚉",
  title: "SBB station data",
  description:
    "SBB station statistics: daily ridership per station with year-on-year change, yesterday's punctuality with the lines behind the delays, and platform lengths and track-free access",
  sources: [ridershipSrc, actualsSrc, platformSrc],
  healthProbes: [{ sourceId: "sbb-ridership", url: `${API}/passagierfrequenz/records?limit=1` }],
  tools: [
    tool({
      name: "get_station_ridership",
      title: "Passengers per day at an SBB station",
      description:
        "Average daily boardings and alightings at an SBB station (all days, weekdays, weekends), by year, with the change against the previous year. Use the official station name; close matches are suggested if it is not exact. Example: {station:'Zürich HB'}.",
      inputSchema: {
        station: z.string().min(2).max(80).describe("Official station name, e.g. 'Bern', 'Zürich HB', 'Lausanne'"),
        years: z.number().int().min(1).max(20).default(5).describe("How many recent years to return"),
      },
      handler: async ({ station, years }) => {
        try {
          const name = cleanStation(station);
          const r = await records<RidershipRow>("passagierfrequenz", ridershipSrc, {
            where: `bahnhof_gare_stazione=${odsString(name)}`,
            order_by: "jahr_annee_anno desc",
            limit: years,
          });
          if (!r.data.results?.length) {
            const { candidates } = await resolveStation("passagierfrequenz", ridershipSrc, "bahnhof_gare_stazione", name);
            return notFound(name, candidates, "ridership figures");
          }
          const summary = summariseRidership(r.data.results);
          return respond(summary, {
            source: ridershipSrc,
            cacheStatus: r.cacheStatus,
            retrievedAt: r.retrievedAt,
            ...(summary.latest ? { dataAsOf: String(summary.latest.year) } : {}),
          });
        } catch (err) {
          return errorToResult(err, "SBB passenger frequency");
        }
      },
    }),
    tool({
      name: "get_station_punctuality",
      title: "Yesterday's punctuality at an SBB station",
      description:
        "Punctuality at a station on the previous operating day, from SBB's published actual times: number of stops, share of on-time arrivals and departures (SBB's delay threshold, about 3 minutes), cancellations, and the lines with the most delayed arrivals. Optional line filter (e.g. 'IC1', 'S3'). Example: {station:'Olten'}.",
      inputSchema: {
        station: z.string().min(2).max(80).describe("Official stop name, e.g. 'Olten', 'Zürich HB'"),
        line: z.string().max(20).optional().describe("Only this line, e.g. IC1, IR15, S3"),
      },
      handler: async ({ station, line }) => {
        try {
          const name = cleanStation(station);
          const base = [`haltestellen_name=${odsString(name)}`, line ? `linien_text=${odsString(line)}` : ""].filter(Boolean).join(" and ");
          const [all, lateArr, lateDep, cancelled, byLine] = await Promise.all([
            records<{ betriebstag?: string }>("ist-daten-sbb", actualsSrc, { where: base, limit: 1, select: "betriebstag" }),
            records("ist-daten-sbb", actualsSrc, { where: `${base} and ankunftsverspatung="true"`, limit: 1, select: "betriebstag" }),
            records("ist-daten-sbb", actualsSrc, { where: `${base} and abfahrtsverspatung="true"`, limit: 1, select: "betriebstag" }),
            records("ist-daten-sbb", actualsSrc, { where: `${base} and faellt_aus_tf=true`, limit: 1, select: "betriebstag" }),
            records<{ linien_text?: string; n?: number }>("ist-daten-sbb", actualsSrc, {
              where: `${base} and ankunftsverspatung="true"`,
              select: "linien_text, count(*) as n",
              group_by: "linien_text",
              order_by: "n desc",
              limit: 5,
            }),
          ]);
          const stops = all.data.total_count ?? 0;
          if (!stops) {
            const { candidates } = await resolveStation("ist-daten-sbb", actualsSrc, "haltestellen_name", name);
            return notFound(name, candidates, `stops${line ? ` for line ${line}` : ""} on the last operating day`);
          }
          const delayedArr = lateArr.data.total_count ?? 0;
          const delayedDep = lateDep.data.total_count ?? 0;
          const day = all.data.results?.[0]?.betriebstag;
          const status = [lateArr, lateDep, cancelled, byLine].reduce((s, r) => worst(s, r.cacheStatus), all.cacheStatus);
          return respond(
            {
              station: name,
              ...(line ? { line } : {}),
              operating_day: day ?? null,
              stops,
              on_time_arrivals_pct: onTimePct(delayedArr, stops),
              on_time_departures_pct: onTimePct(delayedDep, stops),
              delayed_arrivals: delayedArr,
              delayed_departures: delayedDep,
              cancellations: cancelled.data.total_count ?? 0,
              most_delayed_lines: (byLine.data.results ?? []).map((r) => ({ line: r.linien_text ?? "", delayed_arrivals: r.n ?? 0 })),
              note: "Previous operating day as published by SBB. 'Delayed' follows SBB's own flag (about 3 minutes or more).",
            },
            { source: actualsSrc, cacheStatus: status, retrievedAt: all.retrievedAt, ...(day ? { dataAsOf: day } : {}) },
          );
        } catch (err) {
          return errorToResult(err, "SBB actual train times");
        }
      },
    }),
    tool({
      name: "get_station_platforms",
      title: "Platforms and track-free access at an SBB station",
      description:
        "The platforms of an SBB station: number, type, length in metres, and whether passengers can reach them without crossing tracks (underpass, overpass or level access). Useful for accessibility and for long trains. Example: {station:'Bern'}.",
      inputSchema: {
        station: z.string().min(2).max(80).describe("Official station name, e.g. 'Bern'"),
      },
      handler: async ({ station }) => {
        try {
          const name = cleanStation(station);
          const r = await records<PlatformRow>("perron", platformSrc, {
            where: `bps_name=${odsString(name)}`,
            select: "bps,bps_name,p_nr,p_lange,z_schienenfrei,perrontyp",
            order_by: "p_nr",
            limit: 80,
          });
          if (!r.data.results?.length) {
            const { candidates } = await resolveStation("perron", platformSrc, "bps_name", name);
            return notFound(name, candidates, "platform data");
          }
          const platforms = r.data.results.map((p) => ({
            platform: p.p_nr != null ? String(p.p_nr) : null,
            type: p.perrontyp ?? null,
            length_m: p.p_lange ?? null,
            track_free_access: isTrackFree(p.z_schienenfrei),
          }));
          const known = platforms.filter((p) => p.track_free_access !== null);
          return respond(
            {
              station: r.data.results[0]?.bps_name ?? name,
              abbreviation: r.data.results[0]?.bps ?? null,
              platform_count: platforms.length,
              track_free_platforms: known.filter((p) => p.track_free_access).length,
              platforms_requiring_track_crossing: known.filter((p) => p.track_free_access === false).length,
              longest_platform_m: platforms.reduce<number | null>((m, p) => (p.length_m != null && (m == null || p.length_m > m) ? p.length_m : m), null),
              platforms,
            },
            { source: platformSrc, cacheStatus: r.cacheStatus, retrievedAt: r.retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "SBB platform data");
        }
      },
    }),
  ],
};
