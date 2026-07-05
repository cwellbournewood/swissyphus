/**
 * Energy module.
 * - Electricity tariffs: official ElCom data published as a linked-data cube
 *   on LINDAS (the same data behind strompreis.elcom.admin.ch).
 * - EV charging stations: SFOE ich-tanke-strom.ch national dataset (OICP).
 */

import { z } from "zod";
import { fetchJson, withParams } from "../core/http.js";
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
  if (!first?.featureId) {
    throw new Error(`Municipality '${nameOrBfs}' not found. Pass a name like 'Baden' or a BFS number.`);
  }
  return {
    bfs: Number(first.featureId),
    label: (first.label ?? trimmed).replace(/<[^>]*>/g, ""),
  };
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

function mapTariffRows(data: SparqlResponse) {
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

interface EvseRecord {
  ChargingStationNames?: Array<{ lang?: string; value?: string }>;
  Address?: { City?: string; Street?: string; PostalCode?: string };
  GeoCoordinates?: { Google?: string };
  Plugs?: string[];
  ChargingFacilities?: Array<{ power?: number | string; powertype?: string; Power?: number | string }>;
  IsOpen24Hours?: boolean;
  EvseID?: string;
}

interface EvData {
  EVSEData?: Array<{ OperatorName?: string; EVSEDataRecord?: EvseRecord[] }>;
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
          return errorToResult(err, "ElCom/LINDAS");
        }
      },
    }),

    tool({
      name: "compare_electricity_tariffs",
      title: "Compare electricity tariffs across municipalities",
      description:
        "Compare official electricity tariffs (total Rp./kWh, standard product) across up to 10 Swiss municipalities for one category and year.",
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
          const resolved = await Promise.all(municipalities.map((m) => resolveBfs(m)));
          const { data, cacheStatus, retrievedAt } = await sparql(
            tariffQuery(resolved.map((r) => r.bfs), category, y),
          );
          const rows = mapTariffRows(data).sort((a, b) => a.total_rp_kwh - b.total_rp_kwh);
          if (!rows.length) return toolError(`No ${y} tariffs found for the given municipalities.`);
          return respond(
            { category, year: y, cheapest_first: rows },
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
        "EV charging stations from the national ich-tanke-strom.ch dataset near WGS84 coordinates: operator, plugs, power, 24h access, address. Sorted by distance.",
      inputSchema: {
        lat: z.number().min(45.5).max(48).describe("WGS84 latitude"),
        lon: z.number().min(5.5).max(11).describe("WGS84 longitude"),
        radius_km: z.number().min(0.2).max(50).default(5),
        limit: z.number().int().min(1).max(50).default(15),
      },
      handler: async ({ lat, lon, radius_km, limit }) => {
        try {
          const { data, cacheStatus, retrievedAt } = await fetchJson<EvData>(EV_URL, {
            ttlMs: sfoe.cacheTtlSeconds * 1000,
            timeoutMs: 45_000,
          });
          const hits: Array<Record<string, unknown> & { distance_km: number }> = [];
          for (const op of data.EVSEData ?? []) {
            for (const r of op.EVSEDataRecord ?? []) {
              const coords = r.GeoCoordinates?.Google?.split(/[ ,]+/).map(Number);
              if (!coords || coords.length < 2 || Number.isNaN(coords[0])) continue;
              const d = distanceKm(lat, lon, coords[0] as number, coords[1] as number);
              if (d > radius_km) continue;
              hits.push({
                name: r.ChargingStationNames?.find((n) => n.lang === "en")?.value ?? r.ChargingStationNames?.[0]?.value,
                operator: op.OperatorName,
                distance_km: d,
                address: r.Address
                  ? `${r.Address.Street ?? ""}, ${r.Address.PostalCode ?? ""} ${r.Address.City ?? ""}`.trim()
                  : undefined,
                plugs: r.Plugs,
                max_power_kw: (r.ChargingFacilities ?? [])
                  .map((f) => Number(f.power ?? f.Power))
                  .filter((n) => !Number.isNaN(n))
                  .sort((a, b) => b - a)[0],
                open_24h: r.IsOpen24Hours,
                evse_id: r.EvseID,
              });
            }
          }
          hits.sort((a, b) => a.distance_km - b.distance_km);
          if (!hits.length) {
            return toolError(`No charging stations within ${radius_km} km of ${lat}, ${lon}.`, [
              "Increase radius_km (max 50).",
            ]);
          }
          return respond(
            { query: { lat, lon, radius_km }, count: hits.length, chargers: hits.slice(0, limit) },
            { source: sfoe, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "ich-tanke-strom.ch dataset");
        }
      },
    }),
  ],
};
