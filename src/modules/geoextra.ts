/**
 * Extra geo.admin.ch tools: place-name search (swissNAMES3D gazetteer),
 * map-layer catalogue search, attribute search on any layer, and building
 * register lookups by address or around a point.
 */

import { z } from "zod";
import { fetchJson, withParams } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { wgs84ToLv95 } from "../core/coords.js";
import { tool, type ToolDef } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";
import { GEOADMIN_API, identifyAround, type GeoFeature } from "./_geoadmin.js";

const swisstopo: SourceManifest = {
  id: "swisstopo",
  name: "swisstopo geo.admin.ch API",
  operator: "Federal Office of Topography swisstopo",
  url: "https://api3.geo.admin.ch",
  licence: "Swiss OGD — free use with attribution (geo.admin.ch terms)",
  attribution: "© swisstopo",
  updateFrequency: "continuous",
  cacheTtlSeconds: 86_400,
};

const gwr: SourceManifest = {
  id: "gwr-geoadmin",
  name: "Federal Register of Buildings and Dwellings (GWR) on geo.admin.ch",
  operator: "Federal Statistical Office (BFS)",
  url: "https://map.geo.admin.ch/?layers=ch.bfs.gebaeude_wohnungs_register",
  licence: "Public register data — free use with attribution",
  attribution: "© BFS, GWR/RegBL",
  updateFrequency: "weekly",
  cacheTtlSeconds: 86_400,
};

const SEARCH = "https://api3.geo.admin.ch/rest/services/api/SearchServer";

interface SearchHit {
  id?: number | string;
  attrs?: {
    label?: string;
    detail?: string;
    origin?: string;
    lat?: number;
    lon?: number;
    featureId?: string;
    layer?: string;
    objectclass?: string;
  };
}

export function stripHtml(s: string | undefined): string {
  return (s ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

/** Gazetteer labels look like "<i>Gipfel</i> <b>Matterhorn</b> (VS) - Zermatt". */
export function parsePlaceLabel(label: string | undefined) {
  const l = label ?? "";
  const kind = /<i>([^<]+)<\/i>/.exec(l)?.[1];
  const name = /<b>([^<]+)<\/b>/.exec(l)?.[1] ?? stripHtml(l);
  const canton = /\(([A-Z]{2})\)/.exec(l)?.[1];
  const municipality = /\)\s*-\s*(.+)$/.exec(stripHtml(l))?.[1];
  return { name: name.trim(), kind, canton, municipality };
}

const round5 = (n: number | undefined) => (typeof n === "number" ? Math.round(n * 1e5) / 1e5 : undefined);

export const geoExtraTools: ToolDef[] = [
  tool({
    name: "search_places",
    title: "Search Swiss place names",
    description:
      "Search the official swissNAMES3D gazetteer for named places of every kind: mountains and peaks, lakes, rivers, passes, valleys, glaciers, localities, huts, cable cars, landmarks. Returns type, canton, municipality and coordinates (WGS84). Use geocode for street addresses.",
    inputSchema: {
      query: z.string().min(2).describe("Place name, e.g. 'Eiger', 'Lac de Joux', 'Grimselpass'"),
      limit: z.number().int().min(1).max(30).default(10),
    },
    handler: async ({ query, limit }) => {
      try {
        const url = withParams(SEARCH, { type: "locations", origins: "gazetteer", searchText: query, limit, sr: 4326, lang: "en" });
        const { data, cacheStatus, retrievedAt } = await fetchJson<{ results?: SearchHit[] }>(url, { ttlMs: swisstopo.cacheTtlSeconds * 1000 });
        const places = (data.results ?? []).map((r) => ({ ...parsePlaceLabel(r.attrs?.label), lat: round5(r.attrs?.lat), lon: round5(r.attrs?.lon) }));
        if (!places.length) return toolError(`No named place matches '${query}'.`, ["Check the spelling, or try the name in the local language"], { kind: "not_found" });
        return respond({ query, places }, { source: { ...swisstopo, name: "swissNAMES3D gazetteer (swisstopo)" }, cacheStatus, retrievedAt });
      } catch (err) {
        return errorToResult(err, "swisstopo search");
      }
    },
  }),
  tool({
    name: "search_map_layers",
    title: "Search federal map layers",
    description:
      "Search the catalogue of ~900 federal geodata layers on geo.admin.ch (noise, natural hazards, building zones, protected areas, radon, groundwater, solar, cadastre…) and return their layer ids for identify_map_layers and find_map_features.",
    inputSchema: {
      query: z.string().min(2).describe("Topic, e.g. 'road noise', 'flood hazard', 'radon', 'Bauzonen'"),
      lang: z.enum(["en", "de", "fr", "it"]).default("en"),
      limit: z.number().int().min(1).max(30).default(10),
    },
    handler: async ({ query, lang, limit }) => {
      try {
        const url = withParams(SEARCH, { type: "layers", searchText: query, limit, lang });
        const { data, cacheStatus, retrievedAt } = await fetchJson<{ results?: SearchHit[] }>(url, { ttlMs: swisstopo.cacheTtlSeconds * 1000 });
        const layers = (data.results ?? []).map((r) => {
          const detail = r.attrs?.detail ?? "";
          const [, description] = detail.split(" | ");
          return { layer_id: r.attrs?.layer, title: stripHtml(r.attrs?.label), description: description ? `${description.slice(0, 220)}${description.length > 220 ? "…" : ""}` : undefined, map: r.attrs?.layer ? `https://map.geo.admin.ch/?layers=${r.attrs.layer}` : undefined };
        });
        if (!layers.length) return toolError(`No map layer matches '${query}'.`, ["Try German terms (e.g. 'Lärm', 'Gefahren')", "Try lang 'de'"], { kind: "not_found" });
        return respond({ query, layers }, { source: swisstopo, cacheStatus, retrievedAt });
      } catch (err) {
        return errorToResult(err, "swisstopo layer search");
      }
    },
  }),
  tool({
    name: "find_map_features",
    title: "Find features on a map layer by attribute",
    description:
      "Search one federal map layer for features whose attribute matches a value (e.g. layer 'ch.bfe.stauanlagen-bundesaufsicht', field 'damname', value 'Dixence'). Call without 'field' to list the layer's searchable fields and sample values.",
    inputSchema: {
      layer: z.string().regex(/^[a-z0-9_.-]+$/i).describe("Layer id from search_map_layers"),
      field: z.string().regex(/^[a-z0-9_]+$/i).optional(),
      value: z.string().optional(),
      exact: z.boolean().default(false),
      limit: z.number().int().min(1).max(50).default(15),
    },
    handler: async ({ layer, field, value, exact, limit }) => {
      try {
        if (!field || value === undefined) {
          const { data, cacheStatus, retrievedAt } = await fetchJson<{ name?: string; fields?: Array<{ name?: string; type?: string; alias?: string; values?: unknown[] }> }>(
            withParams(`${GEOADMIN_API}/${layer}`, { lang: "en" }),
            { ttlMs: swisstopo.cacheTtlSeconds * 1000 },
          );
          return respond(
            { layer, name: data.name, hint: "Call again with 'field' and 'value'.", fields: (data.fields ?? []).map((f) => ({ field: f.name, type: f.type, label: f.alias, examples: f.values?.slice(0, 5) })) },
            { source: swisstopo, cacheStatus, retrievedAt },
          );
        }
        const url = withParams(`${GEOADMIN_API}/find`, { layer, searchField: field, searchText: value, contains: exact ? false : undefined, returnGeometry: false, lang: "en" });
        const { data, cacheStatus, retrievedAt } = await fetchJson<{ results?: GeoFeature[] }>(url, { ttlMs: 3_600_000, timeoutMs: 30_000 });
        const all = data.results ?? [];
        if (!all.length) return toolError(`No feature on ${layer} has ${field} ${exact ? "=" : "containing"} '${value}'.`, ["Call without 'field' to see valid fields and example values"], { kind: "not_found" });
        return respond(
          { layer, match_count: all.length, features: all.slice(0, limit).map((f) => ({ feature_id: f.featureId ?? f.id, attributes: f.attributes })) },
          { source: swisstopo, cacheStatus, retrievedAt },
        );
      } catch (err) {
        return errorToResult(err, "swisstopo find");
      }
    },
  }),
];

export const buildingExtraTools: ToolDef[] = [
  tool({
    name: "search_buildings",
    title: "Find buildings by address",
    description:
      "Find buildings in the federal building register by street address (e.g. 'Bundesplatz 3, Bern'). Returns the official address, EGID (federal building id) and coordinates; pass the EGID to get_building for the full record.",
    inputSchema: {
      address: z.string().min(3),
      limit: z.number().int().min(1).max(20).default(5),
    },
    handler: async ({ address, limit }) => {
      try {
        const url = withParams(SEARCH, { type: "locations", origins: "address", searchText: address, limit, sr: 4326 });
        const { data, cacheStatus, retrievedAt } = await fetchJson<{ results?: SearchHit[] }>(url, { ttlMs: gwr.cacheTtlSeconds * 1000 });
        const buildings = (data.results ?? []).map((r) => {
          const fid = r.attrs?.featureId ?? "";
          const [egid, edid] = fid.split("_");
          return { address: stripHtml(r.attrs?.label), egid: egid ? Number(egid) : undefined, entrance_id: edid, lat: round5(r.attrs?.lat), lon: round5(r.attrs?.lon) };
        });
        if (!buildings.length) return toolError(`No registered building at '${address}'.`, ["Include the house number and locality, e.g. 'Marktgasse 1 Bern'"], { kind: "not_found" });
        return respond({ query: address, buildings }, { source: gwr, cacheStatus, retrievedAt });
      } catch (err) {
        return errorToResult(err, "building register search");
      }
    },
  }),
  tool({
    name: "buildings_near",
    title: "Buildings near a point",
    description:
      "Buildings from the federal building register closest to a WGS84 point (default within 100 m), nearest first: address, EGID, building category and construction year.",
    inputSchema: {
      lat: z.number().min(45.5).max(48),
      lon: z.number().min(5.5).max(11),
      radius_m: z.number().min(10).max(1000).default(100),
      limit: z.number().int().min(1).max(50).default(10),
    },
    handler: async ({ lat, lon, radius_m, limit }) => {
      try {
        // Lazy import: geo.ts spreads geoExtraTools, so a static import would be circular.
        const { mapGwrBuilding, sortFeaturesByDistance } = await import("./geo.js");
        const { easting, northing } = wgs84ToLv95(lat, lon);
        const { data, cacheStatus, retrievedAt } = await identifyAround("ch.bfs.gebaeude_wohnungs_register", easting, northing, radius_m, { ttlMs: gwr.cacheTtlSeconds * 1000 });
        const rows = sortFeaturesByDistance(data.results ?? [], easting, northing)
          .filter((f) => f.distance_m === undefined || f.distance_m <= radius_m * 1.42)
          .slice(0, limit)
          .map(mapGwrBuilding);
        if (!rows.length) return toolError("No registered buildings in that radius.", ["Increase radius_m"], { kind: "not_found" });
        return respond({ query: { lat, lon, radius_m }, buildings: rows }, { source: gwr, cacheStatus, retrievedAt });
      } catch (err) {
        return errorToResult(err, "building register");
      }
    },
  }),
];

