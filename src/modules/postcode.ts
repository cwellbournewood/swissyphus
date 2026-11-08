/**
 * Postcode / locality module — swisstopo official directory of localities
 * via the geo.admin.ch SearchServer (origin=zipcode).
 */

import { z } from "zod";
import { fetchJson, withParams, sourceCache } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

const source: SourceManifest = {
  id: "swisstopo-plz",
  name: "Official directory of localities (PLZ/Ortschaften)",
  operator: "Federal Office of Topography swisstopo / Swiss Post",
  url: "https://api3.geo.admin.ch",
  licence: "Free use with source attribution (geo.admin.ch terms of use)",
  attribution: "© swisstopo / Swiss Post",
  updateFrequency: "monthly",
  cacheTtlSeconds: 24 * 3600,
  maxStaleSeconds: 90 * 86400,
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
  return fetchJson<SearchResult>(url, { ...sourceCache(source) });
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
          }>(url, { ...sourceCache(source) });
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
  ],
};
