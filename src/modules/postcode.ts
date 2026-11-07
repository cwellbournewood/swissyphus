/**
 * Postcode / locality module — swisstopo official directory of localities
 * via the geo.admin.ch SearchServer (origin=zipcode).
 */

import { z } from "zod";
import { fetchBinary, fetchJson, withParams } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";
import { readZip } from "./_zip.js";
import { parseDsvObjects } from "./_csv.js";
import { resolveCanton } from "./_cantons.js";

const source: SourceManifest = {
  id: "swisstopo-plz",
  name: "Official directory of localities (PLZ/Ortschaften)",
  operator: "Federal Office of Topography swisstopo / Swiss Post",
  url: "https://api3.geo.admin.ch",
  licence: "Free use with source attribution (geo.admin.ch terms of use)",
  attribution: "© swisstopo / Swiss Post",
  updateFrequency: "monthly",
  cacheTtlSeconds: 24 * 3600,
};

interface SearchResult {
  results?: Array<{
    attrs?: { label?: string; detail?: string; lat?: number; lon?: number; y?: number; x?: number };
  }>;
}

async function zipSearch(query: string, limit: number) {
  const url = withParams("https://api3.geo.admin.ch/rest/services/api/SearchServer", {
    searchText: query,
    type: "locations",
    origins: "zipcode",
    limit,
    sr: 2056,
  });
  return fetchJson<SearchResult>(url, { ttlMs: source.cacheTtlSeconds * 1000 });
}

/**
 * Split a SearchServer zipcode label ("<b>8001</b> Zürich", "8001 - Zürich",
 * "8001 – Zürich (ZH)") into postal code and locality name.
 */
export function splitZipLabel(raw: string): { postal_code: string | null; locality: string } {
  const label = raw.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  const m = label.match(/^(\d{4})(?:\s*[-–—]\s*|\s+)(.+)$/);
  return m ? { postal_code: m[1] ?? null, locality: (m[2] ?? "").trim() } : { postal_code: null, locality: label };
}

export function mapResults(data: SearchResult) {
  return (data.results ?? []).map((r) => {
    const { postal_code, locality } = splitZipLabel(r.attrs?.label ?? "");
    return {
      postal_code,
      locality,
      detail: r.attrs?.detail,
      wgs84: { lat: r.attrs?.lat, lon: r.attrs?.lon },
      lv95: { easting: r.attrs?.y, northing: r.attrs?.x },
    };
  });
}

const PLZ_ZIP =
  "https://data.geo.admin.ch/ch.swisstopo-vd.ortschaftenverzeichnis_plz/ortschaftenverzeichnis_plz/ortschaftenverzeichnis_plz_4326.csv.zip";

export interface PlzRow {
  postal_code: string;
  additional_digit: string;
  locality: string;
  municipality: string;
  municipality_bfs_number: number;
  canton: string;
  address_share: string;
  language: string;
  lat: number;
  lon: number;
}

let plzIndex: { at: number; rows: PlzRow[]; retrievedAt: string } | undefined;

/** The full official directory (~4'000 rows) from the zipped CSV, parsed once per day. */
export async function loadPlzDirectory() {
  if (plzIndex && Date.now() - plzIndex.at < 86_400_000) return { rows: plzIndex.rows, cacheStatus: "hit" as const, retrievedAt: plzIndex.retrievedAt };
  const r = await fetchBinary(PLZ_ZIP, { ttlMs: 86_400_000, timeoutMs: 30_000, noStore: true });
  const entry = readZip(r.data).find((e) => e.name.toLowerCase().endsWith(".csv"));
  if (!entry) throw new Error("The locality directory archive contains no CSV.");
  const rows = parseDsvObjects(entry.data().toString("utf8")).map((o) => ({
    postal_code: o["PLZ4"] ?? "",
    additional_digit: o["Zusatzziffer"] ?? "",
    locality: o["Ortschaftsname"] ?? "",
    municipality: o["Gemeindename"] ?? "",
    municipality_bfs_number: Number(o["BFS-Nr"]),
    canton: o["Kantonskürzel"] ?? "",
    address_share: o["Adressenanteil"] ?? "",
    language: o["Sprache"] ?? "",
    lat: Math.round(Number(o["N"]) * 1e5) / 1e5,
    lon: Math.round(Number(o["E"]) * 1e5) / 1e5,
  }));
  plzIndex = { at: Date.now(), rows, retrievedAt: r.retrievedAt };
  return { rows, cacheStatus: r.cacheStatus, retrievedAt: r.retrievedAt };
}

/** One entry per postal code + locality, listing every municipality it spans. */
export function groupPostcodes(rows: PlzRow[]) {
  const by = new Map<string, { postal_code: string; locality: string; municipalities: string[]; language: string; lat: number; lon: number }>();
  for (const r of rows) {
    const k = `${r.postal_code}|${r.locality}`;
    const g = by.get(k);
    if (g) {
      if (!g.municipalities.includes(r.municipality)) g.municipalities.push(r.municipality);
    } else by.set(k, { postal_code: r.postal_code, locality: r.locality, municipalities: [r.municipality], language: r.language, lat: r.lat, lon: r.lon });
  }
  return [...by.values()].sort((a, b) => a.postal_code.localeCompare(b.postal_code) || a.locality.localeCompare(b.locality));
}

export const postcodeModule: SwissyphusModule = {
  id: "postcode",
  emoji: "📮",
  title: "Postcodes & localities",
  description: "PLZ ↔ locality ↔ coordinates lookup from the official directory",
  sources: [source],
  healthProbes: [
    {
      sourceId: "swisstopo-plz",
      url: "https://api3.geo.admin.ch/rest/services/api/SearchServer?searchText=8001&type=locations&origins=zipcode&limit=1",
    },
  ],
  tools: [
    tool({
      name: "lookup_postcode",
      title: "Look up a Swiss postal code",
      description: "Resolve a 4-digit Swiss postal code (PLZ/NPA) to its locality/localities with coordinates.",
      inputSchema: {
        plz: z.string().regex(/^\d{4}$/).describe("4-digit Swiss postal code, e.g. '8001'"),
      },
      handler: async ({ plz }) => {
        try {
          const { data, cacheStatus, retrievedAt } = await zipSearch(plz, 20);
          const results = mapResults(data).filter((r) => r.postal_code === plz);
          if (!results.length) return toolError(`Postal code ${plz} not found.`);
          return respond({ results }, { source, cacheStatus, retrievedAt });
        } catch (err) {
          return errorToResult(err, "swisstopo locality directory");
        }
      },
    }),

    tool({
      name: "search_locality",
      title: "Find postal codes for a locality",
      description: "Search Swiss localities by name in the official directory and return their postal code(s).",
      inputSchema: {
        name: z.string().min(2).describe("Locality name, e.g. 'Winterthur'"),
        limit: z.number().int().min(1).max(50).default(10),
      },
      handler: async ({ name, limit }) => {
        try {
          const url = withParams("https://api3.geo.admin.ch/rest/services/api/MapServer/find", {
            layer: "ch.swisstopo-vd.ortschaftenverzeichnis_plz",
            searchField: "langtext",
            searchText: name,
            contains: true,
            returnGeometry: false,
          });
          const { data, cacheStatus, retrievedAt } = await fetchJson<{
            results?: Array<{ attributes?: { plz?: number; langtext?: string; status?: string } }>;
          }>(url, { ttlMs: source.cacheTtlSeconds * 1000 });
          const results = (data.results ?? [])
            .filter((r) => r.attributes?.status !== "PROJEKTIERT")
            .slice(0, limit)
            .map((r) => ({
              postal_code: r.attributes?.plz != null ? String(r.attributes.plz) : null,
              locality: r.attributes?.langtext,
            }));
          if (!results.length) return toolError(`No locality matching '${name}' found.`);
          return respond({ results }, { source, cacheStatus, retrievedAt });
        } catch (err) {
          return errorToResult(err, "swisstopo locality directory");
        }
      },
    }),
    tool({
      name: "track_parcel",
      title: "Swiss Post parcel tracking link",
      description:
        "Generate the official Swiss Post tracking URL for a shipment number (parcels, registered mail). Returns the link — tracking status itself requires the Swiss Post site.",
      inputSchema: {
        tracking_number: z
          .string()
          .min(8)
          .max(40)
          .describe("Swiss Post shipment number, e.g. '99.60.126xxx.xxxxxxxx' or 'RX...CH'"),
      },
      handler: async ({ tracking_number }) => {
        const clean = tracking_number.replace(/\s/g, "");
        return respond(
          {
            tracking_number: clean,
            tracking_url: `https://service.post.ch/ekp-web/ui/entry/search/${encodeURIComponent(clean)}`,
            note: "Open the URL for live tracking status (Swiss Post requires a browser session).",
          },
          {
            source: {
              id: "swisspost",
              name: "Swiss Post shipment tracking",
              operator: "Swiss Post Ltd",
              url: "https://service.post.ch",
              licence: "Link generation only; tracking data © Swiss Post",
              attribution: "© Swiss Post",
              updateFrequency: "real-time on the Swiss Post site",
              cacheTtlSeconds: 0,
            },
            cacheStatus: "computed",
            retrievedAt: new Date().toISOString(),
          },
        );
      },
    }),
    tool({
      name: "list_postcodes_in_canton",
      title: "Postal codes in a canton",
      description:
        "All postal codes (PLZ/NPA) and localities in a canton from the official locality directory, with the municipality/municipalities each covers, main language and coordinates. Optionally filter to one municipality.",
      inputSchema: {
        canton: z.string().min(2).describe("Canton code or name, e.g. 'ZG', 'Ticino'"),
        municipality: z.string().optional().describe("Optional municipality name filter"),
        limit: z.number().int().min(1).max(500).default(200),
      },
      handler: async ({ canton, municipality, limit }) => {
        const code = resolveCanton(canton);
        if (!code) return toolError(`Unknown canton '${canton}'.`, ["Use a two-letter code such as ZG or TI"], { kind: "invalid_input" });
        try {
          const { rows, cacheStatus, retrievedAt } = await loadPlzDirectory();
          let inCanton = rows.filter((r) => r.canton === code);
          if (municipality) {
            const m = municipality.trim().toLowerCase();
            inCanton = inCanton.filter((r) => r.municipality.toLowerCase().includes(m));
          }
          const postcodes = groupPostcodes(inCanton);
          if (!postcodes.length) return toolError(`No postal codes found for ${code}${municipality ? ` / ${municipality}` : ""}.`, [], { kind: "not_found" });
          return respond(
            { canton: code, postcode_count: new Set(postcodes.map((p) => p.postal_code)).size, locality_count: postcodes.length, returned: Math.min(limit, postcodes.length), postcodes: postcodes.slice(0, limit) },
            { source: { ...source, name: "Official directory of localities (swisstopo download)" }, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "swisstopo locality directory");
        }
      },
    }),
  ],
};
