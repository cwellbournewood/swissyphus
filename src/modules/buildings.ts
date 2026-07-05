/**
 * Buildings module — federal Register of Buildings and Dwellings (GWR/RegBL)
 * via the official BFS Madd API (eCH-0206). Look up any building by EGID.
 */

import { z } from "zod";
import { fetchTextCached } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

const source: SourceManifest = {
  id: "gwr-madd",
  name: "GWR/RegBL — Register of Buildings and Dwellings (Madd API)",
  operator: "Federal Statistical Office (BFS)",
  url: "https://www.housing-stat.ch",
  licence: "Public register data — free use with attribution",
  attribution: "© BFS, GWR/RegBL",
  updateFrequency: "continuous (municipal updates)",
  cacheTtlSeconds: 24 * 3600,
};

const BUILDING_CATEGORIES: Record<string, string> = {
  "1010": "provisional accommodation",
  "1020": "residential building (residential only)",
  "1030": "residential building with secondary use",
  "1040": "building with partial residential use",
  "1060": "building without residential use",
  "1080": "special structure",
};

const BUILDING_STATUS: Record<string, string> = {
  "1001": "planned",
  "1002": "authorised",
  "1003": "under construction",
  "1004": "existing",
  "1005": "not usable",
  "1007": "demolished",
  "1008": "not built",
};

/** Extract the text of the first occurrence of an eCH-0206 element (namespace-agnostic). */
function tag(xml: string, name: string): string | undefined {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([^<]+)</(?:\\w+:)?${name}>`));
  return m?.[1]?.trim();
}

function tagAll(xml: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([^<]+)</(?:\\w+:)?${name}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push((m[1] ?? "").trim());
  return out;
}

export const buildingsModule: SwissyphusModule = {
  id: "buildings",
  emoji: "🏠",
  title: "Buildings (GWR/RegBL)",
  description: "Official building register: construction year, category, floors, dwellings — by EGID",
  sources: [source],
  healthProbes: [{ sourceId: "gwr-madd", url: "https://madd.bfs.admin.ch/eCH-0206?egid=150404" }],
  tools: [
    tool({
      name: "get_building",
      title: "Get building register entry by EGID",
      description:
        "Official GWR/RegBL record for a building identified by its federal EGID: status, category, construction year, floors, dwelling count, area, heating info. Get the EGID from reverse_geocode.",
      inputSchema: {
        egid: z.string().regex(/^\d{1,9}$/).describe("Federal building ID (EGID), e.g. from reverse_geocode"),
      },
      handler: async ({ egid }) => {
        try {
          const { data, cacheStatus, retrievedAt } = await fetchTextCached(
            `https://madd.bfs.admin.ch/eCH-0206?egid=${egid}`,
            { ttlMs: source.cacheTtlSeconds * 1000 },
          );
          if (!data.includes("<") || data.length < 100) {
            return toolError(`No GWR record returned for EGID ${egid}.`);
          }
          const categoryCode = tag(data, "buildingCategory");
          const statusCode = tag(data, "buildingStatus");
          const dwellings = tagAll(data, "EWID");
          const building = {
            egid,
            status: statusCode ? (BUILDING_STATUS[statusCode] ?? statusCode) : undefined,
            category: categoryCode ? (BUILDING_CATEGORIES[categoryCode] ?? categoryCode) : undefined,
            building_class_code: tag(data, "buildingClass"),
            construction_year: tag(data, "yearOfConstruction") ?? tag(data, "constructionDate"),
            municipality: tag(data, "municipalityName"),
            canton: tag(data, "cantonAbbreviation"),
            street: tag(data, "streetDesignationText") ?? tag(data, "descriptionLong"),
            house_number: tag(data, "houseNumber"),
            postal_code: tag(data, "swissZipCode"),
            locality: tag(data, "town") ?? tag(data, "placeName"),
            building_area_m2: tag(data, "surfaceAreaOfBuilding"),
            floors: tag(data, "numberOfFloors"),
            dwelling_count: dwellings.length || undefined,
            dwelling_ewids: dwellings.length ? dwellings.slice(0, 30) : undefined,
            heating_energy_source_code: tag(data, "energySourceHeating"),
            coordinates_lv95: {
              easting: tag(data, "east"),
              northing: tag(data, "north"),
            },
          };
          return respond(building, {
            source,
            cacheStatus,
            retrievedAt,
            links: { housing_stat: `https://www.housing-stat.ch/de/madd/public.html` },
            notes:
              "Fields are extracted from the official eCH-0206 XML; codes follow the GWR feature catalogue.",
          });
        } catch (err) {
          return errorToResult(err, "GWR Madd API");
        }
      },
    }),
  ],
};
