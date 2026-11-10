/**
 * Cadastre module: the ÖREB cadastre (Kataster der öffentlich-rechtlichen
 * Eigentumsbeschränkungen / cadastre RDPPF): every public-law restriction on
 * a land parcel: zoning, building lines, noise sensitivity, protected areas,
 * groundwater protection, contaminated sites, forest, airport zones, …
 *
 * Each canton runs its own ÖREB web service (federal standard, swisstopo
 * "DATA-Extract" v2). swisstopo's layer ch.swisstopo-vd.stand-oerebkataster
 * tells us, for any point or EGRID, the parcel's EGRID and its canton's
 * service base URL; we then request <service>/extract/json/?EGRID=… .
 * Cantonal hosts are not on the static allowlist: the URL comes from the
 * federal geo.admin.ch register and is fetched through fetchPublicResource
 * (public-address-only, DNS-pinned, redirect-checked).
 */

import { z } from "zod";
import { fetchJson, fetchPublicResource, withParams, SourceError } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";
import { wgs84ToLv95 } from "../core/coords.js";

const oereb: SourceManifest = {
  id: "oereb",
  name: "ÖREB cadastre: public-law restrictions on landownership",
  operator: "Cantonal ÖREB cadastre offices; federal coordination by swisstopo (Federal Office of Topography)",
  url: "https://www.cadastre.ch/en/cadastre-rdppf",
  licence: "Official cadastre information (ÖREBKV, SR 510.622.4); public and free to consult, cite the responsible cantonal cadastre office",
  attribution: "Source: ÖREB cadastre of the respective canton (via geo.admin.ch / swisstopo)",
  updateFrequency: "continuous (cantonal services)",
  cacheTtlSeconds: 24 * 3600,
  notes:
    "Service base URLs come from geo.admin.ch layer ch.swisstopo-vd.stand-oerebkataster. Only the official certified PDF extract " +
    "(link included) has legal force; the JSON summary here is informational.",
};

const GEO = "https://api3.geo.admin.ch/rest/services/api/MapServer";
const LAYER = "ch.swisstopo-vd.stand-oerebkataster";
const LANGS = ["de", "fr", "it", "rm", "en"] as const;

type Rec = Record<string, unknown>;
type Ml = Array<{ Language?: string; Text?: string }> | { Language?: string; Text?: string } | string | undefined | null;

/** Pick a language from the ÖREB multilingual text structure. */
export function txt(v: Ml, lang: string): string | undefined {
  if (!v) return undefined;
  if (typeof v === "string") return v;
  const arr = Array.isArray(v) ? v : [v];
  return (arr.find((x) => x.Language === lang) ?? arr.find((x) => x.Language === "de") ?? arr[0])?.Text ?? undefined;
}

export interface ParcelRef {
  egrid: string;
  number?: string;
  municipality?: string;
  canton?: string;
  realestate_type?: string;
  status?: string;
  service?: string;
  pdf?: string;
  office?: { name?: string; email?: string; phone?: string };
}

export function parcelFromAttrs(a: Rec, lang: string): ParcelRef | undefined {
  const egrid = a["egris_egrid"];
  if (typeof egrid !== "string" || !egrid) return undefined;
  return {
    egrid,
    number: a["number"] as string | undefined,
    municipality: a["gemeindename"] as string | undefined,
    canton: a["kanton"] as string | undefined,
    realestate_type: a["realestate_type"] as string | undefined,
    status: (a[`oereb_status_${lang}`] ?? a["oereb_status_de"]) as string | undefined,
    service: a["oereb_webservice"] as string | undefined,
    pdf: a["oereb_extract_pdf"] as string | undefined,
    office: {
      name: a["firmenname"] as string | undefined,
      email: a["email"] as string | undefined,
      phone: a["telefon"] as string | undefined,
    },
  };
}

/** Condense a GetExtractByIdResponse into themes and restrictions. */
export function summarizeExtract(doc: Rec, lang: string) {
  const ex = ((doc["GetExtractByIdResponse"] as Rec | undefined)?.["Extract"] ?? doc["Extract"] ?? doc) as Rec;
  const re = (ex["RealEstate"] ?? {}) as Rec;
  const restrictions = ((re["RestrictionOnLandownership"] as Rec[] | undefined) ?? []).map((r) => {
    const theme = (r["Theme"] ?? {}) as Rec;
    const provisions = ((r["LegalProvisions"] as Rec[] | undefined) ?? []).map((p) => ({
      kind: (p["Type"] as Rec | undefined)?.["Code"],
      title: txt(p["Title"] as Ml, lang),
      number: txt(p["OfficialNumber"] as Ml, lang),
      url: txt(p["TextAtWeb"] as Ml, lang),
    }));
    return {
      theme: txt(theme["Text"] as Ml, lang),
      theme_code: theme["SubCode"] ?? theme["code"],
      restriction: txt(r["LegendText"] as Ml, lang),
      law_status: txt(((r["Lawstatus"] ?? {}) as Rec)["Text"] as Ml, lang) ?? ((r["Lawstatus"] ?? {}) as Rec)["Code"],
      ...(typeof r["AreaShare"] === "number" ? { area_m2: r["AreaShare"] } : {}),
      ...(typeof r["LengthShare"] === "number" ? { length_m: r["LengthShare"] } : {}),
      ...(typeof r["PartInPercent"] === "number" ? { percent_of_parcel: r["PartInPercent"] } : {}),
      responsible_office: txt(((r["ResponsibleOffice"] ?? {}) as Rec)["Name"] as Ml, lang),
      legal_provisions: provisions.filter((p) => p.kind !== "Law").slice(0, 4),
      legal_basis: provisions.filter((p) => p.kind === "Law").map((p) => p.title).slice(0, 4),
    };
  });
  const themeNames = (k: string) => ((ex[k] as Rec[] | undefined) ?? []).map((t) => txt(t["Text"] as Ml, lang) ?? String(t["code"]));
  return {
    parcel: {
      egrid: re["EGRID"],
      number: re["Number"],
      municipality: re["MunicipalityName"],
      bfs_number: re["MunicipalityCode"],
      canton: re["Canton"],
      area_m2: re["LandRegistryArea"],
      type: txt(((re["Type"] ?? {}) as Rec)["Text"] as Ml, lang),
    },
    extract_date: ex["CreationDate"] ?? ex["UpdateDateCS"],
    concerned_themes: themeNames("ConcernedTheme"),
    restrictions,
    not_concerned_themes: themeNames("NotConcernedTheme"),
    themes_without_data: themeNames("ThemeWithoutData"),
    cadastre_authority: txt(((ex["PLRCadastreAuthority"] ?? {}) as Rec)["Name"] as Ml, lang),
  };
}

async function locate(args: { lat?: number; lon?: number; egrid?: string }, lang: string) {
  if (args.egrid) {
    const url = withParams(`${GEO}/find`, {
      layer: LAYER,
      searchText: args.egrid.toUpperCase(),
      searchField: "egris_egrid",
      returnGeometry: false,
      contains: false,
    });
    const r = await fetchJson<{ results?: Array<{ attributes?: Rec }> }>(url, { ttlMs: 7 * 86400_000, timeoutMs: 15_000 });
    return (r.data.results ?? []).map((x) => parcelFromAttrs(x.attributes ?? {}, lang)).find(Boolean);
  }
  const { easting, northing } = wgs84ToLv95(args.lat!, args.lon!);
  const url = withParams(`${GEO}/identify`, {
    geometry: `${easting.toFixed(1)},${northing.toFixed(1)}`,
    geometryType: "esriGeometryPoint",
    layers: `all:${LAYER}`,
    tolerance: 0,
    returnGeometry: false,
    sr: 2056,
    imageDisplay: "100,100,96",
    mapExtent: `${easting - 50},${northing - 50},${easting + 50},${northing + 50}`,
  });
  const r = await fetchJson<{ results?: Array<{ attributes?: Rec }> }>(url, { ttlMs: 7 * 86400_000, timeoutMs: 15_000 });
  return (r.data.results ?? []).map((x) => parcelFromAttrs(x.attributes ?? {}, lang)).find(Boolean);
}

export const cadastreModule: SwissyphusModule = {
  id: "cadastre",
  emoji: "📜",
  title: "Land restrictions (ÖREB cadastre)",
  description:
    "Public-law restrictions on any Swiss land parcel from the cantonal ÖREB cadastres: zoning, building lines, noise sensitivity levels, protected areas, groundwater protection, contaminated sites, forest boundaries, with the legal provisions, by coordinates or EGRID",
  sources: [oereb],
  healthProbes: [{ sourceId: "oereb", url: `${GEO}/${LAYER}` }],
  tools: [
    tool({
      name: "get_land_restrictions",
      title: "Public-law restrictions on a parcel (ÖREB)",
      description:
        "ÖREB cadastre extract for the land parcel at a point (WGS84) or by EGRID: which restriction themes concern the parcel (land-use zoning, building lines, noise sensitivity, groundwater protection, contaminated sites, …), " +
        "each restriction with legend text, legal status, affected area/percentage and links to the legal provisions; plus the themes that do NOT concern it. " +
        "Includes the link to the official PDF extract (the only legally binding version). Use geocode first for an address. Example: {lat: 47.3769, lon: 8.5417}.",
      inputSchema: {
        lat: z.number().min(45.5).max(48).optional().describe("WGS84 latitude inside the parcel"),
        lon: z.number().min(5.5).max(11).optional().describe("WGS84 longitude inside the parcel"),
        egrid: z.string().regex(/^CH\d{12}$/i, "EGRID like CH399977799134").optional().describe("Federal parcel id (EGRID), e.g. 'CH399977799134'"),
        lang: z.enum(LANGS).default("de").describe("Language of the extract (cantons publish de/fr/it; others fall back)"),
      },
      handler: async ({ lat, lon, egrid, lang }) => {
        if (!egrid && (lat === undefined || lon === undefined)) {
          return toolError("Give lat and lon of a point inside the parcel, or its EGRID.", ["Use geocode to turn an address into coordinates."]);
        }
        try {
          const parcel = await locate({ lat, lon, egrid }, lang);
          if (!parcel) {
            return toolError("No land parcel with an ÖREB cadastre entry found there.", [
              "Make sure the point lies on land inside Switzerland (not on a lake or road gap).",
              "Check the EGRID (12 digits after 'CH').",
            ]);
          }
          if (!parcel.service) {
            return respond(
              { parcel, note: "The canton has not introduced the ÖREB cadastre web service for this parcel yet.", status: parcel.status },
              { source: oereb, cacheStatus: "miss", retrievedAt: new Date().toISOString() },
            );
          }
          const base = parcel.service.replace(/\/+$/, "");
          const url = `${base}/extract/json/?EGRID=${encodeURIComponent(parcel.egrid)}&LANG=${lang}`;
          const res = await fetchPublicResource(url, { ttlMs: oereb.cacheTtlSeconds * 1000, timeoutMs: 25_000, maxBytes: 15 * 1024 * 1024 });
          let doc: Rec;
          try {
            doc = JSON.parse(res.data) as Rec;
          } catch {
            return respond(
              {
                parcel,
                note: "This canton's ÖREB service did not return a JSON extract; use the official PDF extract.",
                pdf_extract: parcel.pdf,
              },
              { source: oereb, cacheStatus: res.cacheStatus, retrievedAt: res.retrievedAt },
            );
          }
          const s = summarizeExtract(doc, lang);
          return respond(
            {
              ...s,
              pdf_extract: parcel.pdf,
              cadastre_office: parcel.office,
              note: "Informational summary. Only the official PDF extract is legally binding.",
            },
            { source: oereb, cacheStatus: res.cacheStatus, retrievedAt: res.retrievedAt, language: lang },
          );
        } catch (err) {
          if (err instanceof SourceError && (err.status === 204 || err.status === 404)) {
            return toolError("The cantonal ÖREB service has no extract for this parcel.", ["Try the official PDF extract via the cantonal geoportal."]);
          }
          return errorToResult(err, "ÖREB cadastre");
        }
      },
    }),
  ],
};
