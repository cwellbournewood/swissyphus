/**
 * Energy module.
 * - Electricity tariffs: official ElCom data published as a linked-data cube
 *   on LINDAS (the same data behind strompreis.elcom.admin.ch).
 * - EV charging stations: SFOE ich-tanke-strom.ch national dataset (OICP).
 */

import { z } from "zod";
import { fetchJson, fetchCached, withParams, SourceError } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { distanceKm } from "../core/coords.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

const elcom: SourceManifest = {
  id: "elcom-lindas",
  name: "ElCom electricity tariffs (LINDAS linked data)",
  operator: "Federal Electricity Commission ElCom",
  url: "https://www.strompreis.elcom.admin.ch",
  licence: "Swiss OGD — free use with attribution",
  attribution: "© ElCom, via LINDAS (lindas.admin.ch)",
  updateFrequency: "yearly tariff publication",
  cacheTtlSeconds: 24 * 3600,
  notes: "Prices in Rp./kWh. Categories: H1–H8 households, C1–C7 commercial. H4 ≈ 4-room flat, 4500 kWh/a.",
};

const sfoe: SourceManifest = {
  id: "sfoe-ev",
  name: "ich-tanke-strom.ch — national EV charging infrastructure",
  operator: "Swiss Federal Office of Energy (SFOE)",
  url: "https://ich-tanke-strom.ch",
  licence: "Swiss OGD — free use with attribution",
  attribution: "© SFOE / ich-tanke-strom.ch",
  updateFrequency: "daily (infrastructure)",
  cacheTtlSeconds: 6 * 3600,
};

const LINDAS = "https://lindas.admin.ch/query";
const EV_URL =
  "https://data.geo.admin.ch/ch.bfe.ladestellen-elektromobilitaet/data/oicp/ch.bfe.ladestellen-elektromobilitaet.json";

const CATEGORIES = [
  "H1","H2","H3","H4","H5","H6","H7","H8","C1","C2","C3","C4","C5","C6","C7",
] as const;

interface SparqlResponse {
  results?: { bindings?: Array<Record<string, { value?: string }>> };
}

async function sparql(query: string) {
  return fetchJson<SparqlResponse>(LINDAS, {
    ttlMs: elcom.cacheTtlSeconds * 1000,
    timeoutMs: 30_000,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/sparql-results+json",
      },
      body: `query=${encodeURIComponent(query)}`,
    },
  });
}

/** Thrown when a municipality name can't be resolved (a user error, not a source outage). */
export class MunicipalityNotFound extends Error {
  constructor(public readonly input: string) {
    super(`Municipality '${input}' not found. Pass a name like 'Baden' or a BFS number.`);
    this.name = "MunicipalityNotFound";
  }
}

/** Resolve a municipality name to its BFS number via the official gg25 index. */
async function resolveBfs(nameOrBfs: string): Promise<{ bfs: number; label: string }> {
  const trimmed = nameOrBfs.trim();
  if (/^\d+$/.test(trimmed)) return { bfs: Number(trimmed), label: `BFS ${trimmed}` };
  const url = withParams("https://api3.geo.admin.ch/rest/services/api/SearchServer", {
    searchText: trimmed,
    type: "locations",
    origins: "gg25",
    limit: 1,
  });
  const { data } = await fetchJson<{
    results?: Array<{ attrs?: { featureId?: string | number; label?: string } }>;
  }>(url, { ttlMs: 24 * 3600 * 1000 });
  const first = data.results?.[0]?.attrs;
  if (!first?.featureId || !Number.isFinite(Number(first.featureId))) {
    throw new MunicipalityNotFound(nameOrBfs);
  }
  return {
    bfs: Number(first.featureId),
    label: (first.label ?? trimmed).replace(/<[^>]*>/g, ""),
  };
}

/** Split Promise.allSettled municipality resolutions into successes and per-item errors. */
export function splitResolutions(
  inputs: string[],
  settled: Array<PromiseSettledResult<{ bfs: number; label: string }>>,
): {
  resolved: Array<{ input: string; bfs: number; label: string }>;
  errors: Array<{ input: string; error: string }>;
} {
  const resolved: Array<{ input: string; bfs: number; label: string }> = [];
  const errors: Array<{ input: string; error: string }> = [];
  settled.forEach((s, i) => {
    const input = inputs[i] ?? "";
    if (s.status === "fulfilled") resolved.push({ input, ...s.value });
    else {
      const e = s.reason;
      errors.push({
        input,
        error:
          e instanceof MunicipalityNotFound
            ? "municipality not found"
            : e instanceof SourceError
              ? `lookup failed (${e.message})`
              : String(e instanceof Error ? e.message : e),
      });
    }
  });
  return { resolved, errors };
}

function tariffQuery(bfsList: number[], category: string, period: string): string {
  const values = bfsList.map((b) => `<https://ld.admin.ch/municipality/${b}>`).join(" ");
  return `
PREFIX cube: <https://cube.link/>
PREFIX dim: <https://energy.ld.admin.ch/elcom/electricityprice/dimension/>
PREFIX schema: <http://schema.org/>
SELECT ?municipality ?muniName ?operatorName ?total ?energy ?gridusage ?charge ?aidfee ?fixcosts
FROM <https://lindas.admin.ch/elcom/electricityprice>
WHERE {
  VALUES ?municipality { ${values} }
  ?obs a cube:Observation ;
    dim:municipality ?municipality ;
    dim:category <https://energy.ld.admin.ch/elcom/electricityprice/category/${category}> ;
    dim:product <https://energy.ld.admin.ch/elcom/electricityprice/product/standard> ;
    dim:period ?period ;
    dim:total ?total ;
    dim:energy ?energy ;
    dim:gridusage ?gridusage ;
    dim:charge ?charge ;
    dim:aidfee ?aidfee ;
    dim:operator ?operator .
  OPTIONAL { ?obs dim:fixcosts ?fixcosts }
  OPTIONAL { ?operator schema:name ?operatorName }
  OPTIONAL { ?municipality schema:name ?muniName }
  FILTER(STR(?period) = "${period}")
}
LIMIT 100`;
}

export function mapTariffRows(data: SparqlResponse) {
  return (data.results?.bindings ?? []).map((b) => ({
    municipality: b["muniName"]?.value ?? b["municipality"]?.value?.split("/").pop(),
    bfs_number: Number(b["municipality"]?.value?.split("/").pop()),
    operator: b["operatorName"]?.value,
    total_rp_kwh: Number(b["total"]?.value),
    components_rp_kwh: {
      energy: Number(b["energy"]?.value),
      grid_usage: Number(b["gridusage"]?.value),
      community_charges: Number(b["charge"]?.value),
      grid_surcharge: Number(b["aidfee"]?.value),
    },
    fixed_costs_chf_year: b["fixcosts"] ? Number(b["fixcosts"].value) : undefined,
  }));
}

export interface EvseRecord {
  ChargingStationId?: string;
  ChargingPoolId?: string;
  ChargingStationNames?: Array<{ lang?: string; value?: string }>;
  Address?: { City?: string; Street?: string; HouseNum?: string; PostalCode?: string };
  GeoCoordinates?: {
    Google?: string;
    DecimalDegree?: { Latitude?: number | string; Longitude?: number | string };
  };
  Plugs?: string[];
  ChargingFacilities?: Array<{ power?: number | string; powertype?: string; Power?: number | string }>;
  IsOpen24Hours?: boolean;
  EvseID?: string;
}

export interface EvData {
  EVSEData?: Array<{ OperatorName?: string; OperatorID?: string; EVSEDataRecord?: EvseRecord[] }>;
}

/** One physical charging station, aggregating its EVSEs (charge points/connectors). */
export interface EvStation {
  charging_station_id: string | undefined;
  name: string | undefined;
  operator: string | undefined;
  lat: number;
  lon: number;
  address: string | undefined;
  plugs: string[];
  max_power_kw: number | undefined;
  open_24h: boolean | undefined;
  evse_count: number;
  evse_ids: string[];
}

/** OICP GeoCoordinates → WGS84. "Google" format is "lat lon"; tolerate a swapped pair. */
export function evseCoords(g: EvseRecord["GeoCoordinates"]): { lat: number; lon: number } | undefined {
  let a: number | undefined;
  let b: number | undefined;
  if (g?.DecimalDegree) {
    a = Number(g.DecimalDegree.Latitude);
    b = Number(g.DecimalDegree.Longitude);
  } else if (g?.Google) {
    const parts = g.Google.trim().split(/[\s,]+/).map(Number);
    a = parts[0];
    b = parts[1];
  }
  if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  if (a >= 5 && a <= 11 && b >= 45 && b <= 48.5) return { lat: b, lon: a };
  return { lat: a, lon: b };
}

/**
 * Build a per-station index from the OICP dataset. The file lists one record
 * per EVSE (charge point), so a station with 4 connectors appears 4 times;
 * group by ChargingStationId (fallback: operator + rounded position + address).
 */
export function indexEvData(data: EvData): EvStation[] {
  const byKey = new Map<string, EvStation & { _plugs: Set<string> }>();
  for (const op of data.EVSEData ?? []) {
    for (const r of op.EVSEDataRecord ?? []) {
      const c = evseCoords(r.GeoCoordinates);
      if (!c) continue;
      const address = r.Address
        ? `${[r.Address.Street, r.Address.HouseNum].filter(Boolean).join(" ")}, ${r.Address.PostalCode ?? ""} ${r.Address.City ?? ""}`
            .replace(/^,\s*/, "")
            .trim() || undefined
        : undefined;
      const key =
        r.ChargingStationId?.trim() ||
        `${op.OperatorName ?? op.OperatorID ?? "?"}|${c.lat.toFixed(5)}|${c.lon.toFixed(5)}|${address ?? ""}`;
      let s = byKey.get(key);
      if (!s) {
        s = {
          charging_station_id: r.ChargingStationId?.trim() || undefined,
          name: r.ChargingStationNames?.find((n) => n.lang === "en")?.value ?? r.ChargingStationNames?.[0]?.value,
          operator: op.OperatorName,
          lat: c.lat,
          lon: c.lon,
          address,
          plugs: [],
          _plugs: new Set<string>(),
          max_power_kw: undefined,
          open_24h: undefined,
          evse_count: 0,
          evse_ids: [],
        };
        byKey.set(key, s);
      }
      s.evse_count += 1;
      if (r.EvseID) s.evse_ids.push(r.EvseID);
      for (const p of r.Plugs ?? []) s._plugs.add(p);
      for (const f of r.ChargingFacilities ?? []) {
        const kw = Number(f.power ?? f.Power);
        if (Number.isFinite(kw) && (s.max_power_kw === undefined || kw > s.max_power_kw)) s.max_power_kw = kw;
      }
      if (r.IsOpen24Hours !== undefined) s.open_24h = (s.open_24h ?? false) || r.IsOpen24Hours;
    }
  }
  return [...byKey.values()].map(({ _plugs, ...s }) => ({ ...s, plugs: [..._plugs] }));
}

/** Stations within radius, nearest first. */
export function nearbyEvStations(stations: EvStation[], lat: number, lon: number, radiusKm: number) {
  const hits: Array<EvStation & { distance_km: number }> = [];
  for (const s of stations) {
    const d = distanceKm(lat, lon, s.lat, s.lon);
    if (d <= radiusKm) hits.push({ ...s, distance_km: d });
  }
  return hits.sort((a, b) => a.distance_km - b.distance_km);
}

/** Parsed/indexed EV dataset memoised by the fetch's retrievedAt (the multi-MB JSON is parsed once per refresh). */
let evMemo: { key: string; stations: EvStation[] } | undefined;

async function evStations() {
  const r = await fetchCached(EV_URL, {
    ttlMs: sfoe.cacheTtlSeconds * 1000,
    timeoutMs: 45_000,
    // The national OICP dump is tens of MB — above the default 25 MB upstream cap.
    maxBytes: 150 * 1024 * 1024,
    init: { headers: { Accept: "application/json" } },
  });
  const key = `${r.retrievedAt}|${r.data.length}`;
  if (evMemo?.key !== key) {
    let parsed: EvData;
    try {
      parsed = JSON.parse(r.data) as EvData;
    } catch {
      throw new SourceError("Source 'data.geo.admin.ch' returned a non-JSON EV dataset.", "data.geo.admin.ch");
    }
    evMemo = { key, stations: indexEvData(parsed) };
  }
  return { stations: evMemo.stations, cacheStatus: r.cacheStatus, retrievedAt: r.retrievedAt };
}

export const energyModule: SwissyphusModule = {
  id: "energy",
  emoji: "⚡",
  title: "Energy (ElCom + SFOE)",
  description: "Official electricity tariffs per municipality with component breakdown; EV charging stations",
  sources: [elcom, sfoe],
  healthProbes: [
    {
      sourceId: "elcom-lindas",
      url: LINDAS,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/sparql-results+json",
      },
      body: `query=${encodeURIComponent("SELECT ?s WHERE {?s ?p ?o} LIMIT 1")}`,
    },
  ],
  tools: [
    tool({
      name: "get_electricity_tariff",
      title: "Electricity tariff for a municipality",
      description:
        "Official ElCom electricity tariff for a Swiss municipality, broken into energy, grid usage, community charges and federal grid surcharge (Rp./kWh). Categories: H1–H8 households (H4 = typical 4-room flat), C1–C7 commercial.",
      inputSchema: {
        municipality: z.string().describe("Municipality name (e.g. 'Baden') or BFS number"),
        category: z.enum(CATEGORIES).default("H4").describe("Consumption category (default H4)"),
        year: z.string().regex(/^\d{4}$/).optional().describe("Tariff year (default: current year)"),
      },
      handler: async ({ municipality, category, year }) => {
        try {
          const y = year ?? String(new Date().getFullYear());
          const { bfs, label } = await resolveBfs(municipality);
          const { data, cacheStatus, retrievedAt } = await sparql(tariffQuery([bfs], category, y));
          const rows = mapTariffRows(data);
          if (!rows.length) {
            return toolError(`No ${y} tariff found for ${label} (category ${category}).`, [
              "Tariffs for the coming year appear in autumn; try the current year.",
              "Some municipalities have several operators — this returns all published entries.",
            ]);
          }
          return respond(
            { municipality: label, bfs_number: bfs, category, year: y, tariffs: rows },
            { source: elcom, cacheStatus, retrievedAt, dataAsOf: y },
          );
        } catch (err) {
          if (err instanceof MunicipalityNotFound) {
            return toolError(err.message, ["Check the spelling, or pass the BFS municipality number."]);
          }
          return errorToResult(err, "ElCom/LINDAS");
        }
      },
    }),

    tool({
      name: "compare_electricity_tariffs",
      title: "Compare electricity tariffs across municipalities",
      description:
        "Compare official electricity tariffs (total Rp./kWh, standard product) across up to 10 Swiss municipalities for one category and year. Names that can't be resolved or have no tariff are reported per item in `errors` without failing the comparison.",
      inputSchema: {
        municipalities: z
          .array(z.string())
          .min(2)
          .max(10)
          .describe("Municipality names or BFS numbers, e.g. ['Zürich','Baden','Bern']"),
        category: z.enum(CATEGORIES).default("H4"),
        year: z.string().regex(/^\d{4}$/).optional(),
      },
      handler: async ({ municipalities, category, year }) => {
        try {
          const y = year ?? String(new Date().getFullYear());
          const settled = await Promise.allSettled(municipalities.map((m) => resolveBfs(m)));
          const { resolved, errors } = splitResolutions(municipalities, settled);
          if (!resolved.length) {
            return toolError("None of the municipalities could be resolved.", errors.map((e) => `${e.input}: ${e.error}`));
          }
          const { data, cacheStatus, retrievedAt } = await sparql(
            tariffQuery([...new Set(resolved.map((r) => r.bfs))], category, y),
          );
          const rows = mapTariffRows(data).sort((a, b) => a.total_rp_kwh - b.total_rp_kwh);
          const withRows = new Set(rows.map((r) => r.bfs_number));
          for (const r of resolved) {
            if (!withRows.has(r.bfs)) {
              errors.push({ input: r.input, error: `No ${y} tariff published for ${r.label} (BFS ${r.bfs}), category ${category}.` });
            }
          }
          if (!rows.length) {
            return toolError(`No ${y} tariffs found for the given municipalities.`, errors.map((e) => `${e.input}: ${e.error}`));
          }
          return respond(
            { category, year: y, cheapest_first: rows, ...(errors.length ? { errors } : {}) },
            { source: elcom, cacheStatus, retrievedAt, dataAsOf: y },
          );
        } catch (err) {
          return errorToResult(err, "ElCom/LINDAS");
        }
      },
    }),

    tool({
      name: "get_ev_chargers_nearby",
      title: "Find EV charging stations near a point",
      description:
        "EV charging stations from the national ich-tanke-strom.ch dataset near WGS84 coordinates: operator, plugs, max power, 24h access, address and number of charge points (evse_count) per station. Sorted by distance.",
      inputSchema: {
        lat: z.number().min(45.5).max(48).describe("WGS84 latitude"),
        lon: z.number().min(5.5).max(11).describe("WGS84 longitude"),
        radius_km: z.number().min(0.2).max(50).default(5),
        limit: z.number().int().min(1).max(50).default(15),
      },
      handler: async ({ lat, lon, radius_km, limit }) => {
        try {
          const { stations, cacheStatus, retrievedAt } = await evStations();
          const hits = nearbyEvStations(stations, lat, lon, radius_km);
          if (!hits.length) {
            return toolError(`No charging stations within ${radius_km} km of ${lat}, ${lon}.`, [
              "Increase radius_km (max 50).",
            ]);
          }
          const chargers = hits.slice(0, limit).map(({ lat: sLat, lon: sLon, evse_ids, ...s }) => ({
            ...s,
            wgs84: { lat: sLat, lon: sLon },
            evse_ids: evse_ids.slice(0, 10),
          }));
          return respond(
            {
              query: { lat, lon, radius_km },
              count: hits.length,
              count_unit: "charging stations (each may have several charge points; see evse_count)",
              chargers,
            },
            { source: sfoe, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "ich-tanke-strom.ch dataset");
        }
      },
    }),
  ],
};
