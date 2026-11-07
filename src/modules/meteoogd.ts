/**
 * MeteoSwiss Open Government Data (OGD) — official station measurements from
 * the STAC/CSV distribution on data.geo.admin.ch: the automatic weather
 * network (SwissMetNet), automatic precipitation stations and tower stations.
 * Latest 10-minute/hourly values and full history (10-minute, hourly, daily,
 * monthly, yearly), back to the start of each station's record.
 */

import { z } from "zod";
import { fetchCached } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { distanceKm } from "../core/coords.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";
import { parseDsvObjects } from "./_csv.js";
import { normalizeText, resolveCanton } from "./_cantons.js";

const source: SourceManifest = {
  id: "meteoswiss-ogd",
  name: "MeteoSwiss Open Data — station measurements",
  operator: "Federal Office of Meteorology and Climatology MeteoSwiss",
  url: "https://www.meteoswiss.admin.ch/services-and-publications/service/open-data.html",
  licence: "Swiss OGD — CC BY 4.0 (free use with attribution)",
  attribution: "© MeteoSwiss",
  updateFrequency: "10-minute values ~every 10 min; daily files once a day",
  cacheTtlSeconds: 600,
  notes: "Timestamps are UTC (reference_timestamp marks the start of the interval). Daily precipitation runs 06 UTC to 06 UTC.",
};

const DATA = "https://data.geo.admin.ch";

export const NETWORKS = {
  smn: { collection: "ch.meteoschweiz.ogd-smn", prefix: "ogd-smn", label: "Automatic weather stations (SwissMetNet)" },
  precip: { collection: "ch.meteoschweiz.ogd-smn-precip", prefix: "ogd-smn-precip", label: "Automatic precipitation stations" },
  tower: { collection: "ch.meteoschweiz.ogd-smn-tower", prefix: "ogd-smn-tower", label: "Tower stations" },
  pollen: { collection: "ch.meteoschweiz.ogd-pollen", prefix: "ogd-pollen", label: "Pollen monitoring stations" },
} as const;

/** OGD pollen parameter species codes → English names. */
export const POLLEN_SPECIES: Record<string, string> = {
  alnu: "alder",
  betu: "birch",
  cory: "hazel",
  fagu: "beech",
  frax: "ash",
  quer: "oak",
  poac: "grasses",
};

/** e.g. "kabetud1" → "birch"; undefined for non-pollen codes. */
export function pollenSpecies(code: string): string | undefined {
  const m = /^k[ah]([a-z]{4})[dhy]\d$/.exec(code);
  return m ? POLLEN_SPECIES[m[1]!] : undefined;
}

/** Rename pollen columns to species names, keeping one aggregation (suffix) only. */
export function pollenRows(objs: Array<Record<string, string>>, suffix: string) {
  const header = objs[0] ? Object.keys(objs[0]) : [];
  const cols = header.filter((h) => h.endsWith(suffix) && pollenSpecies(h));
  return objs.map((o) => {
    const row: Record<string, string | number | null> = { time: ogdTime(o["reference_timestamp"] ?? "") };
    for (const c of cols) row[pollenSpecies(c)!] = o[c] === undefined || o[c] === "" ? null : Number(o[c]);
    return row as { time: string } & Record<string, number | null>;
  });
}
type Network = keyof typeof NETWORKS;

const networkArg = z.enum(["smn", "precip", "tower", "pollen"]).default("smn").describe("smn = full weather stations (default), precip = rain gauges, tower = tower stations, pollen = pollen monitoring");

function fileUrl(net: Network, name: string): string {
  const n = NETWORKS[net];
  return `${DATA}/${n.collection}/${n.prefix}_${name}`;
}
function stationFileUrl(net: Network, abbr: string, suffix: string): string {
  const n = NETWORKS[net];
  const a = abbr.toLowerCase();
  return `${DATA}/${n.collection}/${a}/${n.prefix}_${a}_${suffix}.csv`;
}

export interface OgdStation {
  abbr: string;
  name: string;
  canton: string;
  height_m_asl?: number;
  lat?: number;
  lon?: number;
  data_since?: string;
  owner?: string;
  url?: string;
}

const num = (s: string | undefined) => (s === undefined || s === "" ? undefined : Number.isFinite(Number(s)) ? Number(s) : undefined);

async function loadStations(net: Network) {
  const r = await fetchCached(fileUrl(net, "meta_stations.csv"), { ttlMs: 86_400_000, timeoutMs: 30_000 });
  const stations: OgdStation[] = parseDsvObjects(r.data).map((o) => ({
    abbr: o["station_abbr"] ?? "",
    name: o["station_name"] ?? "",
    canton: o["station_canton"] ?? "",
    height_m_asl: num(o["station_height_masl"]),
    lat: num(o["station_coordinates_wgs84_lat"]),
    lon: num(o["station_coordinates_wgs84_lon"]),
    data_since: o["station_data_since"] || undefined,
    owner: o["station_dataowner"] || undefined,
    url: o["station_url_en"] || undefined,
  }));
  return { ...r, stations: stations.filter((s) => s.abbr) };
}

export interface OgdParameter {
  code: string;
  description: string;
  group?: string;
  granularity?: string;
  unit?: string;
}

async function loadParameters(net: Network): Promise<Map<string, OgdParameter>> {
  const r = await fetchCached(fileUrl(net, "meta_parameters.csv"), { ttlMs: 86_400_000, timeoutMs: 30_000 });
  const m = new Map<string, OgdParameter>();
  for (const o of parseDsvObjects(r.data)) {
    const code = o["parameter_shortname"];
    if (!code) continue;
    m.set(code, {
      code,
      description: o["parameter_description_en"] || o["parameter_description_de"] || code,
      group: o["parameter_group_en"] || undefined,
      granularity: o["parameter_granularity"] || undefined,
      unit: o["parameter_unit"] || undefined,
    });
  }
  return m;
}

/** "07.11.2026 00:10" (UTC) → "2026-11-07T00:10Z". */
export function ogdTime(s: string): string {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})(?: (\d{2}):(\d{2}))?$/.exec(s.trim());
  if (!m) return s;
  return `${m[3]}-${m[2]}-${m[1]}T${m[4] ?? "00"}:${m[5] ?? "00"}Z`;
}

/** Headline parameters (by code prefix) returned unless the caller asks for specific codes. */
export const DEFAULT_PREFIXES = ["tre200", "ure200", "rre150", "fu3010", "dkl010", "sre000", "pp0qnh", "htoaut", "gre000"];

export function selectColumns(header: string[], requested: string[] | undefined): string[] {
  const data = header.filter((h) => h !== "station_abbr" && h !== "reference_timestamp");
  if (requested?.length) {
    if (requested.some((r) => r.toLowerCase() === "all")) return data;
    const want = new Set(requested.map((r) => r.trim()));
    return data.filter((h) => want.has(h));
  }
  return data.filter((h) => DEFAULT_PREFIXES.some((p) => h.startsWith(p)));
}

export type OgdRow = { time: string } & Record<string, number | string | null>;

export function toRows(objs: Array<Record<string, string>>, cols: string[]): OgdRow[] {
  return objs.map((o) => {
    const row: OgdRow = { time: ogdTime(o["reference_timestamp"] ?? "") };
    for (const c of cols) {
      const v = o[c];
      row[c] = v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : v;
    }
    return row;
  });
}

async function resolveStation(net: Network, input: string) {
  const loaded = await loadStations(net);
  const q = input.trim();
  const byAbbr = loaded.stations.find((s) => s.abbr.toLowerCase() === q.toLowerCase());
  if (byAbbr) return { station: byAbbr, loaded };
  const nq = normalizeText(q);
  const byName =
    loaded.stations.find((s) => normalizeText(s.name) === nq) ?? loaded.stations.find((s) => normalizeText(s.name).startsWith(nq)) ?? loaded.stations.find((s) => normalizeText(s.name).includes(nq));
  return { station: byName, loaded };
}

function paramDict(params: Map<string, OgdParameter>, cols: string[]) {
  return Object.fromEntries(cols.map((c) => [c, params.get(c) ? { description: params.get(c)!.description, unit: params.get(c)!.unit } : { description: c }]));
}

const GRAN = { "10min": "t", hourly: "h", daily: "d", monthly: "m", yearly: "y" } as const;
type Gran = keyof typeof GRAN;

/** Which CSV files cover [from, to] for a granularity (recent = current year, historical = earlier). */
export function filesFor(gran: Gran, from: string, to: string, nowYear: number): string[] {
  const g = GRAN[gran];
  if (g === "m" || g === "y") return [g];
  const fy = Number(from.slice(0, 4));
  const ty = Number(to.slice(0, 4));
  const out: string[] = [];
  if (fy < nowYear) {
    if (g === "d") out.push("d_historical");
    else {
      for (let dec = Math.floor(fy / 10) * 10; dec <= Math.min(ty, nowYear - 1); dec += 10) out.push(`${g}_historical_${dec}-${dec + 9}`);
    }
  }
  if (ty >= nowYear) out.push(`${g}_recent`);
  return out;
}

const MAX_ROWS = 400;

export const meteoOgdModule: SwissyphusModule = {
  id: "meteoogd",
  emoji: "🌡️",
  title: "MeteoSwiss open data",
  description: "Official MeteoSwiss station network (OGD): station list, latest 10-min/hourly values, full history back to the 1800s",
  sources: [source],
  healthProbes: [{ sourceId: "meteoswiss-ogd", url: fileUrl("smn", "meta_stations.csv") }],
  tools: [
    tool({
      name: "list_ogd_stations",
      title: "MeteoSwiss OGD stations",
      description:
        "Stations of the official MeteoSwiss measurement networks (open data): abbreviation, name, canton, altitude, coordinates and start of record. Filter by canton, name, or nearness to a WGS84 point. Use the abbreviation with get_ogd_recent / get_ogd_history.",
      inputSchema: {
        network: networkArg,
        canton: z.string().optional(),
        query: z.string().optional().describe("Name fragment"),
        lat: z.number().min(45.5).max(48).optional(),
        lon: z.number().min(5.5).max(11).optional(),
        limit: z.number().int().min(1).max(200).default(30),
      },
      handler: async ({ network, canton, query, lat, lon, limit }) => {
        const code = canton ? resolveCanton(canton) : undefined;
        if (canton && !code) return toolError(`Unknown canton '${canton}'.`, [], { kind: "invalid_input" });
        if ((lat === undefined) !== (lon === undefined)) return toolError("Pass both lat and lon, or neither.", [], { kind: "invalid_input" });
        try {
          const { stations, cacheStatus, retrievedAt } = await loadStations(network);
          let list: Array<OgdStation & { distance_km?: number }> = stations;
          if (code) list = list.filter((s) => s.canton === code);
          if (query) {
            const nq = normalizeText(query);
            list = list.filter((s) => normalizeText(s.name).includes(nq) || s.abbr.toLowerCase() === nq);
          }
          if (lat !== undefined && lon !== undefined) {
            list = list
              .filter((s) => s.lat !== undefined && s.lon !== undefined)
              .map((s) => ({ ...s, distance_km: Math.round(distanceKm(lat, lon, s.lat!, s.lon!) * 10) / 10 }))
              .sort((a, b) => a.distance_km! - b.distance_km!);
          }
          return respond(
            { network: NETWORKS[network].label, station_count: list.length, stations: list.slice(0, limit).map(({ url: _u, ...s }) => s) },
            { source, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "MeteoSwiss OGD");
        }
      },
    }),
    tool({
      name: "get_ogd_recent",
      title: "Latest MeteoSwiss station measurements",
      description:
        "Latest official measurements at a MeteoSwiss station (abbreviation like 'BER' or name like 'Bern / Zollikofen'): temperature, humidity, precipitation, wind, sunshine, pressure, snow depth, radiation. 10-minute values (default) or hourly. Returns the newest row plus a short series.",
      inputSchema: {
        station: z.string().min(2).describe("Station abbreviation (BER, SMA, JUN…) or name"),
        network: networkArg,
        granularity: z.enum(["10min", "hourly"]).default("10min"),
        rows: z.number().int().min(1).max(144).default(6).describe("How many of the newest rows to return"),
        parameters: z.array(z.string()).optional().describe("Parameter codes (e.g. tre200s0), or ['all']; default = headline parameters"),
      },
      handler: async ({ station, network, granularity, rows, parameters }) => {
        try {
          const { station: st } = await resolveStation(network, station);
          if (!st) return toolError(`No ${network} station matches '${station}'.`, ["Use list_ogd_stations to find the abbreviation"], { kind: "not_found" });
          const suffix = granularity === "hourly" ? "h_now" : "t_now";
          const [csv, params] = await Promise.all([fetchCached(stationFileUrl(network, st.abbr, suffix), { ttlMs: 600_000, timeoutMs: 30_000 }), loadParameters(network)]);
          const objs = parseDsvObjects(csv.data);
          const header = objs[0] ? Object.keys(objs[0]) : [];
          const cols = selectColumns(header, parameters);
          const all = toRows(objs, cols);
          // Drop trailing rows that are entirely empty (station not yet reported).
          while (all.length && cols.every((c) => all[all.length - 1]![c] === null)) all.pop();
          const series = all.slice(-rows);
          const latest = series[series.length - 1];
          if (!latest) return toolError(`No recent data for ${st.name} (${st.abbr}).`, [], { kind: "not_found" });
          return respond(
            { station: st, granularity, latest, series: series.length > 1 ? series : undefined, parameters: paramDict(params, cols) },
            { source, cacheStatus: csv.cacheStatus, retrievedAt: csv.retrievedAt, dataAsOf: latest.time },
          );
        } catch (err) {
          return errorToResult(err, "MeteoSwiss OGD");
        }
      },
    }),
    tool({
      name: "get_ogd_history",
      title: "MeteoSwiss station history",
      description:
        "Official historical measurements at a MeteoSwiss station for a date range, at 10-minute (current year only), hourly, daily, monthly or yearly resolution — monthly/yearly series go back to the start of the station's record (often the 1800s). Default parameters: temperature (mean/min/max), humidity, precipitation, wind, sunshine, pressure, snow depth, radiation. At most 400 rows per call; use a coarser granularity for long ranges.",
      inputSchema: {
        station: z.string().min(2),
        network: networkArg,
        granularity: z.enum(["10min", "hourly", "daily", "monthly", "yearly"]).default("daily"),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD (UTC)"),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD (UTC), inclusive"),
        parameters: z.array(z.string()).optional(),
      },
      handler: async ({ station, network, granularity, from, to, parameters }) => {
        if (from > to) return toolError("'from' must not be after 'to'.", [], { kind: "invalid_input" });
        const nowYear = new Date().getUTCFullYear();
        if (granularity === "10min" && Number(from.slice(0, 4)) < nowYear) {
          return toolError("10-minute history is available for the current year only.", ["Use granularity 'hourly' or 'daily' for earlier periods"], { kind: "invalid_input" });
        }
        try {
          const { station: st } = await resolveStation(network, station);
          if (!st) return toolError(`No ${network} station matches '${station}'.`, ["Use list_ogd_stations to find the abbreviation"], { kind: "not_found" });
          const files = filesFor(granularity, from, to, nowYear);
          const ttl = granularity === "10min" || files.some((f) => f.endsWith("recent")) ? 3_600_000 : 86_400_000;
          const [csvs, params] = await Promise.all([
            Promise.all(files.map((f) => fetchCached(stationFileUrl(network, st.abbr, f), { ttlMs: ttl, timeoutMs: 45_000 }).catch((e) => ({ error: e })))),
            loadParameters(network),
          ]);
          const ok = csvs.filter((c): c is Awaited<ReturnType<typeof fetchCached>> => !("error" in c));
          if (!ok.length) throw (csvs[0] as { error: unknown }).error;
          const objs = ok.flatMap((c) => parseDsvObjects(c.data));
          const header = objs[0] ? Object.keys(objs[0]) : [];
          const cols = selectColumns(header, parameters);
          const lo = `${from}T00:00Z`;
          const hi = `${to}T23:59Z`;
          const inRange = toRows(objs, cols).filter((r) => r.time >= lo && r.time <= hi);
          const seen = new Set<string>();
          const unique = inRange.filter((r) => (seen.has(r.time) ? false : (seen.add(r.time), true))).sort((a, b) => (a.time < b.time ? -1 : 1));
          if (!unique.length) return toolError(`No ${granularity} data for ${st.name} (${st.abbr}) between ${from} and ${to}.`, [`Record starts ${st.data_since ?? "unknown"}`], { kind: "not_found" });
          const truncated = unique.length > MAX_ROWS;
          return respond(
            { station: st, granularity, from, to, row_count: unique.length, truncated, rows: unique.slice(0, MAX_ROWS), parameters: paramDict(params, cols) },
            {
              source,
              cacheStatus: ok[0]!.cacheStatus,
              retrievedAt: ok[0]!.retrievedAt,
              dataAsOf: unique[unique.length - 1]!.time,
              ...(truncated ? { notes: `Only the first ${MAX_ROWS} of ${unique.length} rows are returned; narrow the range or use a coarser granularity.` } : {}),
            },
          );
        } catch (err) {
          return errorToResult(err, "MeteoSwiss OGD");
        }
      },
    }),
    tool({
      name: "list_pollen_stations",
      title: "MeteoSwiss pollen stations",
      description: "The MeteoSwiss pollen monitoring stations (open data): abbreviation, city, canton, altitude, coordinates and start of record. Use the abbreviation with get_pollen_daily.",
      inputSchema: { canton: z.string().optional() },
      handler: async ({ canton }) => {
        const code = canton ? resolveCanton(canton) : undefined;
        if (canton && !code) return toolError(`Unknown canton '${canton}'.`, [], { kind: "invalid_input" });
        try {
          const { stations, cacheStatus, retrievedAt } = await loadStations("pollen");
          const list = (code ? stations.filter((s) => s.canton === code) : stations).map(({ url: _u, ...s }) => s);
          return respond({ station_count: list.length, species: Object.values(POLLEN_SPECIES), stations: list }, { source, cacheStatus, retrievedAt });
        } catch (err) {
          return errorToResult(err, "MeteoSwiss OGD pollen");
        }
      },
    }),
    tool({
      name: "get_pollen_daily",
      title: "Daily pollen concentrations",
      description:
        "Official daily mean pollen concentrations (pollen/m³, midnight-to-midnight UTC) per species — alder, birch, hazel, beech, ash, oak, grasses — at a MeteoSwiss pollen station for a date range (default: last 14 days). History goes back decades. For the latest hourly values use get_pollen.",
      inputSchema: {
        station: z.string().min(2).describe("Pollen station abbreviation (PBE, PBS, PZH…) or city name"),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      },
      handler: async ({ station, from, to }) => {
        const today = new Date().toISOString().slice(0, 10);
        const end = to ?? today;
        const start = from ?? new Date(Date.parse(`${end}T00:00:00Z`) - 13 * 86_400_000).toISOString().slice(0, 10);
        if (start > end) return toolError("'from' must not be after 'to'.", [], { kind: "invalid_input" });
        try {
          const { station: st } = await resolveStation("pollen", station);
          if (!st) return toolError(`No pollen station matches '${station}'.`, ["Use list_pollen_stations"], { kind: "not_found" });
          const files = filesFor("daily", start, end, new Date().getUTCFullYear());
          const csvs = await Promise.all(files.map((f) => fetchCached(stationFileUrl("pollen", st.abbr, f), { ttlMs: f.endsWith("recent") ? 3_600_000 : 86_400_000, timeoutMs: 45_000 })));
          const seen = new Set<string>();
          const rows = csvs
            .flatMap((c) => pollenRows(parseDsvObjects(c.data), "d1"))
            .filter((r) => r.time >= `${start}T00:00Z` && r.time <= `${end}T23:59Z` && (seen.has(r.time) ? false : (seen.add(r.time), true)))
            .sort((a, b) => (a.time < b.time ? -1 : 1));
          if (!rows.length) return toolError(`No pollen data for ${st.name} between ${start} and ${end}.`, ["Pollen is measured mainly from January to September"], { kind: "not_found" });
          const truncated = rows.length > MAX_ROWS;
          return respond(
            { station: st, unit: "pollen/m³ (daily mean, 00–24 UTC)", from: start, to: end, row_count: rows.length, truncated, rows: rows.slice(0, MAX_ROWS) },
            { source: { ...source, name: "MeteoSwiss Open Data — pollen" }, cacheStatus: csvs[0]!.cacheStatus, retrievedAt: csvs[0]!.retrievedAt, dataAsOf: rows[rows.length - 1]!.time },
          );
        } catch (err) {
          return errorToResult(err, "MeteoSwiss OGD pollen");
        }
      },
    }),
  ],
};
