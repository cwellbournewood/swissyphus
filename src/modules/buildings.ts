/**
 * Buildings module — federal Register of Buildings and Dwellings (GWR/RegBL)
 * via the official BFS Madd API (eCH-0206). Look up any building by EGID.
 */

import { z } from "zod";
import { fetchTextCached, sourceCache } from "../core/http.js";
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
  // building register changes slowly
  maxStaleSeconds: 30 * 86400,
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
  const m = xml.match(new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([^<]+)</(?:[\\w.-]+:)?${name}>`));
  return m?.[1]?.trim();
}

function tagAll(xml: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([^<]+)</(?:[\\w.-]+:)?${name}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push((m[1] ?? "").trim());
  return out;
}

/** All inner-XML blocks of an element (namespace-agnostic; `name` must match exactly, not as a prefix). */
function blocks(xml: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1] ?? "");
  return out;
}

export interface BuildingEntrance {
  egaid?: string;
  street?: string;
  house_number?: string;
  postal_code?: string;
  locality?: string;
  coordinates_lv95?: { easting?: string; northing?: string };
}

function parseEntrance(xml: string): BuildingEntrance {
  return {
    egaid: tag(xml, "EGAID"),
    street: tag(xml, "descriptionLong") ?? tag(xml, "streetDesignationText") ?? tag(xml, "descriptionShort"),
    house_number: tag(xml, "buildingEntranceNo") ?? tag(xml, "houseNumber"),
    postal_code: tag(xml, "swissZipCode"),
    locality: tag(xml, "placeName") ?? tag(xml, "town"),
    coordinates_lv95: tag(xml, "east") ? { easting: tag(xml, "east"), northing: tag(xml, "north") } : undefined,
  };
}

/**
 * Parse an eCH-0206 Madd response. Returns `undefined` when it contains no
 * building record (unknown EGID, error payload, empty response) — the caller
 * reports "not found" rather than an empty building.
 *
 * Buildings with several entrances (e.g. corner buildings, Bahnhofstrasse
 * 1 + 3) return every entrance with its own address.
 */
export function parseBuildingXml(xml: string, egid: string) {
  if (!xml.includes("<")) return undefined;
  const statusCode = tag(xml, "buildingStatus");
  const categoryCode = tag(xml, "buildingCategory");
  const egids = tagAll(xml, "EGID");
  // A real record carries at least a status or category code; if EGIDs are
  // present, the requested one must be among them.
  if (!statusCode && !categoryCode) return undefined;
  if (egids.length && !egids.includes(String(Number(egid))) && !egids.includes(egid)) return undefined;

  const entranceBlocks = blocks(xml, "buildingEntrance");
  // Building-level fields come from the XML with entrance blocks removed, so
  // an entrance's coordinates/address don't masquerade as the building's.
  let buildingXml = xml;
  for (const b of entranceBlocks) buildingXml = buildingXml.replace(b, "");
  const entrances = entranceBlocks.map(parseEntrance).filter((e) => e.street || e.house_number || e.egaid);
  const dwellings = tagAll(xml, "EWID");
  const first = entrances[0];
  return {
    egid,
    status: statusCode ? (BUILDING_STATUS[statusCode] ?? statusCode) : undefined,
    category: categoryCode ? (BUILDING_CATEGORIES[categoryCode] ?? categoryCode) : undefined,
    building_class_code: tag(xml, "buildingClass"),
    construction_year: tag(xml, "yearOfConstruction") ?? tag(xml, "constructionDate"),
    municipality: tag(xml, "municipalityName"),
    canton: tag(xml, "cantonAbbreviation"),
    // Primary address = first entrance (kept for backwards compatibility);
    // `entrances` lists every address of the building.
    street: first?.street ?? tag(xml, "streetDesignationText") ?? tag(xml, "descriptionLong"),
    house_number: first?.house_number ?? tag(xml, "houseNumber"),
    postal_code: first?.postal_code ?? tag(xml, "swissZipCode"),
    locality: first?.locality ?? tag(xml, "town") ?? tag(xml, "placeName"),
    entrance_count: entrances.length || undefined,
    entrances: entrances.length ? entrances : undefined,
    building_area_m2: tag(xml, "surfaceAreaOfBuilding"),
    floors: tag(xml, "numberOfFloors"),
    dwelling_count: dwellings.length || undefined,
    dwelling_ewids: dwellings.length ? dwellings.slice(0, 30) : undefined,
    heating_energy_source_code: tag(xml, "energySourceHeating"),
    coordinates_lv95: {
      easting: tag(buildingXml, "east") ?? first?.coordinates_lv95?.easting,
      northing: tag(buildingXml, "north") ?? first?.coordinates_lv95?.northing,
    },
  };
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
            { ...sourceCache(source) },
          );
          const building = parseBuildingXml(data, egid);
          if (!building) {
            return toolError(`No building found in the GWR/RegBL register for EGID ${egid}.`, [
              "Check the EGID; get it from reverse_geocode for an address or point.",
            ]);
          }
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
