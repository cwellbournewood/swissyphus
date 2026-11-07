/**
 * Traffic module — FEDRO/ASTRA automatic road-traffic counting stations on the
 * principal network (national roads and main roads), with annual averages
 * (ADT/AAWT), peak hours, day/night flows and heavy-goods share.
 */

import { z } from "zod";
import { withParams } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { lv95ToWgs84, wgs84ToLv95, distanceKm } from "../core/coords.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";
import { normalizeText, resolveCanton } from "./_cantons.js";
import { GEOADMIN_API, findFeatures, identifyAround, numOrUndef, type GeoFeature } from "./_geoadmin.js";

const LAYER = "ch.astra.strassenverkehrszaehlung-uebergeordnet";

const source: SourceManifest = {
  id: "astra-traffic",
  name: "Swiss road traffic counts (principal network)",
  operator: "Federal Roads Office (FEDRO/ASTRA)",
  url: `https://map.geo.admin.ch/?layers=${LAYER}`,
  licence: "Swiss OGD — free use with attribution (geo.admin.ch terms)",
  attribution: "© FEDRO/ASTRA",
  updateFrequency: "annual (yearly averages)",
  cacheTtlSeconds: 86_400,
  notes: "Values are annual averages for the year given in each record; some stations have no published values for the latest year.",
};

export function mapStation(f: GeoFeature) {
  const a = f.attributes ?? {};
  const s = (k: string) => (typeof a[k] === "string" && a[k] !== "" ? (a[k] as string) : undefined);
  let e = numOrUndef(f.geometry?.x);
  let n = numOrUndef(f.geometry?.y);
  const loc = s("locationlv95");
  if ((e === undefined || n === undefined) && loc) {
    const [x, y] = loc.split(",").map(Number);
    if (Number.isFinite(x) && Number.isFinite(y)) [e, n] = [x, y];
  }
  const pos = e !== undefined && n !== undefined ? lv95ToWgs84(e, n) : undefined;
  const adt = numOrUndef(a["dtv"]);
  return {
    id: f.featureId ?? f.id,
    station_number: s("mlocnr"),
    name: s("mlocname") ?? s("label"),
    canton: s("canton"),
    road: s("streetdesignation"),
    direction_1: s("targetlocation1"),
    direction_2: s("targetlocation2"),
    lanes: { direction_1: numOrUndef(a["numberoflanes1"]), direction_2: numOrUndef(a["numberoflanes2"]) },
    network: s("en_networktype") ?? s("de_networktype"),
    year: numOrUndef(a["year"]),
    has_counts: adt !== undefined,
    counts:
      adt === undefined
        ? undefined
        : {
            annual_average_daily_traffic: adt,
            annual_average_weekday_traffic: numOrUndef(a["dwv"]),
            morning_peak_hour: numOrUndef(a["msp"]),
            evening_peak_hour: numOrUndef(a["asp"]),
            morning_peak_hour_weekdays: numOrUndef(a["mspw"]),
            evening_peak_hour_weekdays: numOrUndef(a["aspw"]),
            avg_hourly_day: numOrUndef(a["nt"]),
            avg_hourly_night: numOrUndef(a["nn"]),
            heavy_goods_share_pct: numOrUndef(a["prctheavytraffic"]),
            heavy_goods_share_day_pct: numOrUndef(a["prctheavytrafficday"]),
            heavy_goods_share_night_pct: numOrUndef(a["prctheavytrafficnight"]),
          },
    lat: pos ? Math.round(pos.lat * 1e5) / 1e5 : undefined,
    lon: pos ? Math.round(pos.lon * 1e5) / 1e5 : undefined,
  };
}

type Station = ReturnType<typeof mapStation>;

const ttlMs = source.cacheTtlSeconds * 1000;

export const trafficModule: SwissyphusModule = {
  id: "traffic",
  emoji: "🚗",
  title: "Road traffic counts",
  description: "ASTRA counting stations: daily/weekday volumes, peak hours, heavy-goods share — by name, canton or nearby",
  sources: [source],
  healthProbes: [
    { sourceId: "astra-traffic", url: withParams(`${GEOADMIN_API}/find`, { layer: LAYER, searchField: "canton", searchText: "UR", contains: false, returnGeometry: false }) },
  ],
  tools: [
    tool({
      name: "get_traffic_count",
      title: "Traffic counts at a station",
      description:
        "Annual traffic figures for ASTRA counting stations matching a name or road (e.g. 'Gotthard', 'Baregg', 'A 1'), or a station number: average daily and weekday traffic, morning/evening peak hours, day/night hourly flow and heavy-goods share.",
      inputSchema: {
        query: z.string().min(1).describe("Station name fragment, road (e.g. 'A 2') or station number"),
        canton: z.string().optional().describe("Optional canton filter"),
        limit: z.number().int().min(1).max(30).default(10),
      },
      handler: async ({ query, canton, limit }) => {
        const code = canton ? resolveCanton(canton) : undefined;
        if (canton && !code) return toolError(`Unknown canton '${canton}'.`, [], { kind: "invalid_input" });
        try {
          const q = query.trim();
          const isRoad = /^[AH]\s?\d+[a-z]?$/i.test(q);
          const isNumber = /^\d+$/.test(q);
          const field = isRoad ? "streetdesignation" : isNumber ? "mlocnr" : "mlocname";
          const text = isRoad ? q.toUpperCase().replace(/^([AH])\s?/, "$1 ") : q.toUpperCase();
          const { data, cacheStatus, retrievedAt } = await findFeatures(LAYER, field, text, { ttlMs, returnGeometry: true, contains: !isNumber });
          let stations: Station[] = (data.results ?? []).map(mapStation);
          if (code) stations = stations.filter((s) => s.canton === code);
          if (!isRoad && !isNumber) {
            const nq = normalizeText(q);
            stations.sort((a, b) => Number(!normalizeText(a.name ?? "").startsWith(nq)) - Number(!normalizeText(b.name ?? "").startsWith(nq)));
          }
          stations.sort((a, b) => Number(b.has_counts) - Number(a.has_counts));
          if (!stations.length) return toolError(`No counting station matches '${query}'.`, ["Try a place name in capitals as signposted (e.g. 'GOTTHARD')", "Use get_traffic_nearby with coordinates"], { kind: "not_found" });
          return respond({ match_count: stations.length, stations: stations.slice(0, limit) }, { source, cacheStatus, retrievedAt });
        } catch (err) {
          return errorToResult(err, "ASTRA traffic counts");
        }
      },
    }),
    tool({
      name: "get_traffic_by_canton",
      title: "Traffic counting stations in a canton",
      description:
        "All ASTRA counting stations on the principal network in a canton, sorted by annual average daily traffic (busiest first). Canton as code or name in any language.",
      inputSchema: {
        canton: z.string().min(2),
        limit: z.number().int().min(1).max(100).default(25),
      },
      handler: async ({ canton, limit }) => {
        const code = resolveCanton(canton);
        if (!code) return toolError(`Unknown canton '${canton}'.`, ["Use a two-letter code such as ZH or TI"], { kind: "invalid_input" });
        try {
          const { data, cacheStatus, retrievedAt } = await findFeatures(LAYER, "canton", code, { ttlMs, returnGeometry: true, contains: false });
          const stations = (data.results ?? []).map(mapStation);
          stations.sort((a, b) => (b.counts?.annual_average_daily_traffic ?? -1) - (a.counts?.annual_average_daily_traffic ?? -1));
          return respond(
            { canton: code, station_count: stations.length, with_counts: stations.filter((s) => s.has_counts).length, stations: stations.slice(0, limit) },
            { source, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "ASTRA traffic counts");
        }
      },
    }),
    tool({
      name: "get_traffic_nearby",
      title: "Traffic counting stations near a point",
      description: "ASTRA counting stations near a WGS84 point (default 10 km), closest first, with their annual traffic figures.",
      inputSchema: {
        lat: z.number().min(45.5).max(48),
        lon: z.number().min(5.5).max(11),
        radius_km: z.number().min(0.5).max(50).default(10),
        limit: z.number().int().min(1).max(30).default(10),
      },
      handler: async ({ lat, lon, radius_km, limit }) => {
        try {
          const { easting, northing } = wgs84ToLv95(lat, lon);
          const { data, cacheStatus, retrievedAt } = await identifyAround(LAYER, easting, northing, radius_km * 1000, { ttlMs });
          const stations = (data.results ?? [])
            .map(mapStation)
            .map((s) => ({ ...s, distance_km: s.lat !== undefined && s.lon !== undefined ? Math.round(distanceKm(lat, lon, s.lat, s.lon) * 10) / 10 : undefined }))
            .filter((s) => s.distance_km === undefined || s.distance_km <= radius_km)
            .sort((a, b) => (a.distance_km ?? 1e9) - (b.distance_km ?? 1e9));
          return respond(
            { query: { lat, lon, radius_km }, station_count: stations.length, stations: stations.slice(0, limit) },
            { source, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "ASTRA traffic counts");
        }
      },
    }),
  ],
};
