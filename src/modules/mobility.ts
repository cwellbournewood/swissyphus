/**
 * Mobility beyond timetables.
 *
 * - Shared mobility (bikes, e-bikes, e-scooters, mopeds, cars, cargo bikes)
 *   from sharedmobility.ch, the Swiss Federal Office of Energy's national
 *   aggregator. Nearby queries go to the sharedmobility.ch REST "identify"
 *   endpoint first (small, spatially filtered response); if that fails or
 *   returns something unparseable we fall back to the national GBFS 2.x feeds
 *   (discovered from gbfs.json, joined station_information × station_status).
 * - Public-transport disruptions and realtime delays from
 *   opentransportdata.swiss (GTFS-RT service alerts / trip updates, SIRI-SX
 *   fallback). These need a FREE API key: set OPENTRANSPORTDATA_API_KEY.
 *   Without it the tools return an actionable error; Swissyphus stays zero-key.
 */

import { z } from "zod";
import { allowHosts, fetchJson, fetchTextCached, withParams, SourceError } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { CacheStatus, SourceManifest } from "../core/types.js";

allowHosts("sharedmobility.ch", "www.sharedmobility.ch", "api.sharedmobility.ch", "api.opentransportdata.swiss");

/** respond() withholds any payload over 50 KB, so list tools trim to this first. */
const RESPONSE_BUDGET = 45_000;

/** Shrink a list until the serialized payload fits the response budget (same pattern as geodata). */
export function fitToBudget<T>(items: T[], build: (xs: T[]) => unknown, budget = RESPONSE_BUDGET): { data: unknown; dropped: number } {
  let n = items.length;
  let data = build(items);
  while (n > 0 && JSON.stringify(data).length > budget) {
    n = n > 1 ? Math.max(1, Math.floor(n * 0.75)) : 0;
    data = build(items.slice(0, n));
  }
  return { data, dropped: items.length - n };
}

// ---------------------------------------------------------------------------
// Source manifests
// ---------------------------------------------------------------------------

const sharedGbfs: SourceManifest = {
  id: "sharedmobility-gbfs",
  name: "sharedmobility.ch — national shared-mobility GBFS feeds",
  operator: "Swiss Federal Office of Energy (SFOE)",
  url: "https://sharedmobility.ch/v2/gbfs/",
  licence: "Swiss OGD — free use with attribution (opendata.swiss 'open use, must provide the source')",
  attribution: "© SFOE / sharedmobility.ch and the participating sharing providers",
  updateFrequency: "status feeds ~every minute; information feeds daily",
  cacheTtlSeconds: 60,
  notes:
    "GBFS 2.x aggregate of all Swiss sharing providers. Uses the GBFS 2.3 endpoint (/v2/gbfs/, needs " +
    "`Authorization: <email>`, set SWISSYPHUS_CONTACT_EMAIL) when a contact is configured, otherwise the " +
    "unauthenticated GBFS 2.0 aggregate (sharedmobility.ch/gbfs.json). Feed URLs are discovered from gbfs.json (fallback: " +
    "<root>/<feed_name>). Status feeds cached 60 s, information feeds 1 h; national feeds may be several MB (25 MB cap). " +
    "The aggregate carries provider ids on stations/vehicles; the 'providers' feed is a sharedmobility.ch extension. " +
    "Confidence: discovery root high, exact feed names/extension and provider_id field medium.",
};

const sharedApi: SourceManifest = {
  id: "sharedmobility-api",
  name: "sharedmobility.ch REST API (identify / providers)",
  operator: "Swiss Federal Office of Energy (SFOE)",
  url: "https://api.sharedmobility.ch/v1/sharedmobility/",
  licence: "Swiss OGD — free use with attribution",
  attribution: "© SFOE / sharedmobility.ch and the participating sharing providers",
  updateFrequency: "near-realtime (~1 min)",
  cacheTtlSeconds: 60,
  notes:
    "geo.admin-style 'identify' endpoint (Geometry=lon,lat&Tolerance=<m>&geometryFormat=esrijson). Endpoint path: " +
    "medium-high confidence; attribute keys (provider_id, vehicle_type, pickup_type, station_*) medium — parsing " +
    "accepts plain and 'ch.bfe.sharedmobility.'-prefixed keys. Distances are recomputed client-side; if the API fails " +
    "Swissyphus falls back to the national GBFS feeds.",
};

const otd: SourceManifest = {
  id: "opentransportdata",
  name: "opentransportdata.swiss — GTFS-RT service alerts, trip updates, SIRI-SX",
  operator: "Open Data Platform Mobility Switzerland (on behalf of the Federal Office of Transport FOT)",
  url: "https://opentransportdata.swiss",
  licence: "opentransportdata.swiss terms of use — free, attribution required; free API key required",
  attribution: "© opentransportdata.swiss (SKI / FOT)",
  updateFrequency: "realtime (feeds regenerate every ~30–60 s)",
  cacheTtlSeconds: 60,
  notes:
    "Requires a free API key in env OPENTRANSPORTDATA_API_KEY (sent as 'Authorization: Bearer <key>', retried as the " +
    "bare token on 401/403). Endpoints: la/gtfs-sa?format=JSON (service alerts), la/gtfs-rt?format=JSON (trip updates), " +
    "la/siri-sx (XML, disruption fallback). Path confidence: medium; the platform enforces low per-minute rate limits, " +
    "so responses are cached 60 s. The national trip-update feed is large (tens of MB).",
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v : typeof v === "number" ? String(v) : undefined;
const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};
const bool = (v: unknown): boolean | undefined =>
  typeof v === "boolean" ? v : v === 1 || v === "true" ? true : v === 0 || v === "false" ? false : undefined;

/** First defined value among alternative keys (camelCase / snake_case tolerant). */
function pick(o: unknown, ...keys: string[]): unknown {
  if (!isRec(o)) return undefined;
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

/** Great-circle distance in metres (rounded). */
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

function worstCache(...s: CacheStatus[]): CacheStatus {
  if (s.includes("miss")) return "miss";
  if (s.includes("stale")) return "stale";
  return s[0] ?? "miss";
}

function oldest(...isoDates: string[]): string {
  return isoDates.filter(Boolean).sort()[0] ?? new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Vehicle classification
// ---------------------------------------------------------------------------

export const VEHICLE_CLASSES = ["bike", "e-bike", "cargo_bike", "scooter", "moped", "car"] as const;
export type VehicleClass = (typeof VEHICLE_CLASSES)[number] | "other";

/**
 * Map either a GBFS vehicle_type (form_factor + propulsion_type) or a free-text
 * provider vehicle type ("E-Scooter", "E-Bike", "Car", "E-CargoBike") to one of
 * our coarse classes.
 */
export function classifyVehicle(input: { form_factor?: unknown; propulsion_type?: unknown; label?: unknown }): VehicleClass {
  const ff = str(input.form_factor)?.toLowerCase();
  const prop = str(input.propulsion_type)?.toLowerCase();
  if (ff) {
    if (ff === "cargo_bicycle") return "cargo_bike";
    if (ff === "bicycle") return prop && prop !== "human" ? "e-bike" : "bike";
    if (ff.startsWith("scooter")) return "scooter";
    if (ff === "moped") return "moped";
    if (ff === "car") return "car";
  }
  const s = str(input.label)?.toLowerCase().replace(/[\s_]+/g, "") ?? "";
  if (!s) return "other";
  if (s.includes("cargo")) return "cargo_bike";
  if (s.includes("scooter") || s.includes("trottinett") || s.includes("kickboard")) return "scooter";
  if (s.includes("moped") || s.includes("motorroller")) return "moped";
  if (s.includes("car") || s.includes("auto")) return "car";
  if (/e-?bike|pedelec|ebicycle|e-?velo/.test(s)) return "e-bike";
  if (s.includes("bike") || s.includes("bicycle") || s.includes("velo")) return "bike";
  return "other";
}

/** Split a provider vehicle_type that may be a string, "A,B" list or array into labels. */
function labelsOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str).filter((x): x is string => !!x);
  const s = str(v);
  return s ? s.split(/\s*[,;/]\s*/).filter(Boolean) : [];
}

function classesOf(v: unknown): VehicleClass[] {
  return [...new Set(labelsOf(v).map((label) => classifyVehicle({ label })))];
}

// ---------------------------------------------------------------------------
// sharedmobility.ch REST identify
// ---------------------------------------------------------------------------

const API_BASE = "https://api.sharedmobility.ch/v1/sharedmobility";

export interface MobilityItem {
  kind: "vehicle" | "station";
  id?: string;
  provider_id?: string;
  provider?: string;
  vehicle_classes: VehicleClass[];
  vehicle_type?: string;
  lat?: number;
  lon?: number;
  distance_m?: number;
  available?: boolean;
  station_name?: string;
  vehicles_available?: number;
  docks_available?: number;
  range_km?: number;
  rental_url?: string;
}

/** Look up an identify attribute under its plain or 'ch.bfe.sharedmobility.'-prefixed key. */
function smAttr(a: Rec, key: string): unknown {
  const dotted = key.replace(/_/g, ".");
  return pick(a, key, `ch.bfe.sharedmobility.${key}`, `ch.bfe.sharedmobility.${dotted}`, dotted);
}

function geomLatLon(g: unknown): { lat: number; lon: number } | undefined {
  if (!isRec(g)) return undefined;
  const x = num(g["x"]);
  const y = num(g["y"]);
  if (x !== undefined && y !== undefined) return { lon: x, lat: y };
  const c = asArr(g["coordinates"]);
  const lon = num(c[0]);
  const lat = num(c[1]);
  if (lon !== undefined && lat !== undefined) return { lon, lat };
  return undefined;
}

/**
 * Parse the identify response (array of esrijson features, or {results:[...]})
 * into normalised items with distance from the origin. Returns undefined if the
 * payload does not look like an identify response at all.
 */
export function parseIdentifyResults(json: unknown, origin: { lat: number; lon: number }): MobilityItem[] | undefined {
  const list = Array.isArray(json)
    ? json
    : isRec(json) && Array.isArray(json["results"])
      ? json["results"]
      : isRec(json) && Array.isArray(json["features"])
        ? json["features"]
        : undefined;
  if (!list) return undefined;
  const out: MobilityItem[] = [];
  for (const f of list) {
    if (!isRec(f)) continue;
    const a = (isRec(f["attributes"]) ? f["attributes"] : isRec(f["properties"]) ? f["properties"] : f) as Rec;
    const pos =
      geomLatLon(f["geometry"]) ??
      (num(smAttr(a, "lat")) !== undefined && num(smAttr(a, "lon")) !== undefined
        ? { lat: num(smAttr(a, "lat")) as number, lon: num(smAttr(a, "lon")) as number }
        : undefined);
    const pickup = str(smAttr(a, "pickup_type"))?.toLowerCase();
    const stationName = str(smAttr(a, "station_name"));
    const isStation = pickup ? pickup.includes("station") : stationName !== undefined;
    const vt = smAttr(a, "vehicle_type");
    const labels = labelsOf(vt);
    out.push({
      kind: isStation ? "station" : "vehicle",
      id: str(smAttr(a, "id")) ?? str(f["featureId"]) ?? str(f["id"]),
      provider_id: str(smAttr(a, "provider_id")),
      provider: str(smAttr(a, "provider_name")),
      vehicle_classes: classesOf(vt),
      vehicle_type: labels.length ? labels.join(", ") : undefined,
      lat: pos?.lat,
      lon: pos?.lon,
      distance_m: pos ? distanceM(origin.lat, origin.lon, pos.lat, pos.lon) : undefined,
      available: bool(smAttr(a, "available")),
      station_name: stationName,
      vehicles_available: num(
        smAttr(a, "station_status_num_vehicle_available") ?? smAttr(a, "station_status_num_vehicles_available") ?? smAttr(a, "num_vehicles_available"),
      ),
      docks_available: num(smAttr(a, "station_status_num_docks_available") ?? smAttr(a, "num_docks_available")),
      range_km: (() => {
        const m = num(smAttr(a, "vehicle_status_current_range_meters") ?? smAttr(a, "current_range_meters"));
        return m !== undefined ? Math.round(m / 100) / 10 : undefined;
      })(),
    });
  }
  return out;
}

async function nearbyViaApi(lat: number, lon: number, radiusM: number) {
  const items: MobilityItem[] = [];
  const seen = new Set<string>();
  let cacheStatus: CacheStatus = "hit";
  let retrievedAt = new Date().toISOString();
  let offset = 0;
  let pageSize = 0;
  let truncated = false;
  for (let page = 0; page < 5; page++) {
    const url = withParams(`${API_BASE}/identify`, {
      Geometry: `${lon.toFixed(6)},${lat.toFixed(6)}`,
      Tolerance: Math.round(radiusM),
      offset,
      geometryFormat: "esrijson",
    });
    const res = await fetchJson<unknown>(url, { ttlMs: 60_000, timeoutMs: 20_000, maxBytes: 5 * 1024 * 1024 });
    cacheStatus = worstCache(cacheStatus, res.cacheStatus);
    retrievedAt = page === 0 ? res.retrievedAt : oldest(retrievedAt, res.retrievedAt);
    const parsed = parseIdentifyResults(res.data, { lat, lon });
    if (!parsed) {
      if (page === 0) throw new SourceError("sharedmobility.ch identify returned an unexpected payload.", "api.sharedmobility.ch");
      break;
    }
    let fresh = 0;
    for (const it of parsed) {
      const key = it.id ?? `${it.lat},${it.lon},${it.provider_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(it);
      fresh++;
    }
    if (page === 0) pageSize = parsed.length;
    // Keep paging only while the API returns full, new pages.
    if (!pageSize || parsed.length < pageSize || fresh === 0) break;
    offset += parsed.length;
    if (page === 4) truncated = true;
  }
  if (items.length && items.every((i) => i.lat === undefined)) {
    throw new SourceError("sharedmobility.ch identify returned features without coordinates.", "api.sharedmobility.ch");
  }
  return { items, cacheStatus, retrievedAt, truncated };
}

// ---------------------------------------------------------------------------
// GBFS feeds
// ---------------------------------------------------------------------------

const GBFS_ROOT = "https://sharedmobility.ch/v2/gbfs/";
/** GBFS 2.0 aggregate discovery document (no Authorization header required). */
const GBFS_V20_DISCOVERY = "https://sharedmobility.ch/gbfs.json";

/**
 * Contact email for the GBFS 2.3 endpoint (sharedmobility.ch/v2), which answers
 * 401 unless the request carries `Authorization: <valid email>` (SFOE access
 * docs). Set SWISSYPHUS_CONTACT_EMAIL to the operator's address to use it;
 * without it Swissyphus uses the unauthenticated GBFS 2.0 aggregate. Read at
 * call time so tests and long-running servers pick up changes.
 */
function gbfsContact(): string | undefined {
  const v = (process.env["SWISSYPHUS_CONTACT_EMAIL"] ?? "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? v : undefined;
}

/** Request init for a sharedmobility.ch GBFS URL (adds the 2.3 Authorization header when configured). */
function gbfsInit(url: string): RequestInit | undefined {
  const contact = gbfsContact();
  return contact && url.startsWith(GBFS_ROOT) ? { headers: { Authorization: contact } } : undefined;
}
const GBFS_MAX_BYTES = 25 * 1024 * 1024;
const INFO_TTL = 3600_000;
const STATUS_TTL = 60_000;
const GBFS_HOSTS = new Set(["sharedmobility.ch", "www.sharedmobility.ch"]);

const FALLBACK_FEEDS: Record<string, string> = Object.fromEntries(
  [
    "system_information",
    "station_information",
    "station_status",
    "free_bike_status",
    "vehicle_types",
    "system_pricing_plans",
    "providers",
  ].map((n) => [n, `${GBFS_ROOT}${n}`]),
);

/**
 * Parse a GBFS discovery document (2.x: data.<lang>.feeds[]; 3.0: data.feeds[])
 * into feed name → URL, keeping only URLs on sharedmobility.ch hosts.
 */
export function parseGbfsDiscovery(json: unknown, lang = "en"): Record<string, string> {
  const data = pick(json, "data");
  let feeds: unknown[] = [];
  if (isRec(data)) {
    if (Array.isArray(data["feeds"])) feeds = data["feeds"];
    else {
      const langs = Object.keys(data);
      const chosen = [lang, "en", "de", ...langs].find((l) => isRec(data[l]) && Array.isArray((data[l] as Rec)["feeds"]));
      if (chosen) feeds = (data[chosen] as Rec)["feeds"] as unknown[];
    }
  }
  const out: Record<string, string> = {};
  for (const f of feeds) {
    const name = str(pick(f, "name"));
    const url = str(pick(f, "url"));
    if (!name || !url) continue;
    try {
      const u = new URL(url);
      if (u.protocol === "https:" && GBFS_HOSTS.has(u.hostname)) out[name] = u.toString();
    } catch {
      /* ignore malformed */
    }
  }
  return out;
}

/** Feeds advertised by the GBFS discovery document ({} when discovery failed). */
async function gbfsFeeds(): Promise<Record<string, string>> {
  const candidates = gbfsContact() ? [GBFS_ROOT, `${GBFS_ROOT}gbfs.json`, GBFS_V20_DISCOVERY] : [GBFS_V20_DISCOVERY];
  for (const url of candidates) {
    try {
      const { data } = await fetchJson<unknown>(url, { ttlMs: INFO_TTL, timeoutMs: 15_000, init: gbfsInit(url) });
      const feeds = parseGbfsDiscovery(data);
      if (Object.keys(feeds).length) return feeds;
    } catch {
      /* try next / fall back */
    }
  }
  return {};
}

/**
 * URL for the first of `names` the discovery document advertises; only if
 * none is advertised, the first hard-coded fallback. Aliases matter: GBFS 3.0
 * renamed free_bike_status to vehicle_status, and a fallback for the old name
 * must not shadow a discovered feed under the new one.
 */
export function gbfsFeedUrl(discovered: Record<string, string>, ...names: string[]): string | undefined {
  for (const n of names) if (discovered[n]) return discovered[n];
  // The hard-coded fallbacks live under the 2.3 root, which needs a contact email.
  if (gbfsContact()) for (const n of names) if (FALLBACK_FEEDS[n]) return FALLBACK_FEEDS[n];
  return undefined;
}

interface FeedResult {
  data: Rec;
  cacheStatus: CacheStatus;
  retrievedAt: string;
}

async function gbfsFeed(url: string | undefined, ttlMs: number): Promise<FeedResult> {
  if (!url) throw new SourceError("GBFS feed not advertised by sharedmobility.ch.", "sharedmobility.ch");
  const res = await fetchJson<unknown>(url, { ttlMs, timeoutMs: 60_000, maxBytes: GBFS_MAX_BYTES, init: gbfsInit(url) });
  const data = pick(res.data, "data");
  return { data: isRec(data) ? data : {}, cacheStatus: res.cacheStatus, retrievedAt: res.retrievedAt };
}

async function optionalFeed(url: string | undefined, ttlMs: number): Promise<FeedResult | undefined> {
  try {
    return await gbfsFeed(url, ttlMs);
  } catch {
    return undefined;
  }
}

export interface ProviderInfo {
  provider_id: string;
  name?: string;
  vehicle_type?: string;
  vehicle_classes: VehicleClass[];
  url?: string;
  language?: string;
  timezone?: string;
  apps?: { android?: string; ios?: string };
}

/** Normalise the sharedmobility.ch 'providers' feed (data.providers[] or bare array). */
export function normaliseProviders(json: unknown): ProviderInfo[] {
  const root = isRec(json) && isRec(json["data"]) ? json["data"] : json;
  const list = Array.isArray(root) ? root : asArr(pick(root, "providers"));
  const out: ProviderInfo[] = [];
  for (const p of list) {
    const id = str(pick(p, "provider_id", "id"));
    if (!id) continue;
    const apps = pick(p, "rental_apps");
    const android = str(pick(pick(apps, "android"), "store_uri", "discovery_uri"));
    const ios = str(pick(pick(apps, "ios"), "store_uri", "discovery_uri"));
    const vt = pick(p, "vehicle_type", "vehicle_types");
    out.push({
      provider_id: id,
      name: str(pick(p, "name")),
      vehicle_type: labelsOf(vt).join(", ") || undefined,
      vehicle_classes: classesOf(vt),
      url: str(pick(p, "url")),
      language: str(pick(p, "language")),
      timezone: str(pick(p, "timezone")),
      ...(android || ios ? { apps: { ...(android ? { android } : {}), ...(ios ? { ios } : {}) } } : {}),
    });
  }
  return out;
}

/** Provider id of an aggregated record: explicit field, else the 'provider:' id prefix. */
function providerIdOf(rec: Rec, idField: string): string | undefined {
  const explicit = str(pick(rec, "provider_id", "providerId"));
  if (explicit) return explicit;
  const id = str(rec[idField]);
  if (id && id.includes(":")) return id.split(":")[0];
  return undefined;
}

export interface GbfsInputs {
  stationInformation?: Rec;
  stationStatus?: Rec;
  freeBikeStatus?: Rec;
  vehicleTypes?: Rec;
  providers?: ProviderInfo[];
}

/**
 * Pure join of the GBFS feeds around a point: stations (information × status)
 * and free-floating vehicles within radius, with provider name + vehicle class.
 */
export function nearbyFromGbfs(inp: GbfsInputs, origin: { lat: number; lon: number }, radiusM: number): MobilityItem[] {
  const providers = new Map((inp.providers ?? []).map((p) => [p.provider_id, p]));
  const vtypes = new Map<string, { cls: VehicleClass; name?: string }>();
  for (const t of asArr(pick(inp.vehicleTypes, "vehicle_types"))) {
    const id = str(pick(t, "vehicle_type_id"));
    if (!id) continue;
    const cls = classifyVehicle({
      form_factor: pick(t, "form_factor"),
      propulsion_type: pick(t, "propulsion_type"),
      label: pick(t, "name"),
    });
    vtypes.set(id, { cls, name: str(pick(t, "name")) ?? str(pick(t, "form_factor")) });
  }
  // Rough bounding box to skip the distance maths for most of the country.
  const dLat = radiusM / 111_000 + 0.001;
  const dLon = radiusM / (111_000 * Math.cos((origin.lat * Math.PI) / 180)) + 0.001;
  const inBox = (la?: number, lo?: number) =>
    la !== undefined && lo !== undefined && Math.abs(la - origin.lat) <= dLat && Math.abs(lo - origin.lon) <= dLon;

  const out: MobilityItem[] = [];

  const statusById = new Map<string, Rec>();
  for (const s of asArr(pick(inp.stationStatus, "stations"))) {
    const id = str(pick(s, "station_id"));
    if (id && isRec(s)) statusById.set(id, s);
  }
  for (const s of asArr(pick(inp.stationInformation, "stations"))) {
    if (!isRec(s)) continue;
    const la = num(s["lat"]);
    const lo = num(s["lon"]);
    if (!inBox(la, lo)) continue;
    const d = distanceM(origin.lat, origin.lon, la as number, lo as number);
    if (d > radiusM) continue;
    const id = str(s["station_id"]);
    const st = id ? statusById.get(id) : undefined;
    const pid = providerIdOf(s, "station_id");
    const prov = pid ? providers.get(pid) : undefined;
    const typeClasses = asArr(pick(st, "vehicle_types_available"))
      .filter((v) => (num(pick(v, "count")) ?? 1) > 0)
      .map((v) => vtypes.get(str(pick(v, "vehicle_type_id")) ?? "")?.cls)
      .filter((c): c is VehicleClass => !!c);
    const classes = typeClasses.length ? [...new Set(typeClasses)] : (prov?.vehicle_classes ?? []);
    const vehiclesAvailable = num(pick(st, "num_bikes_available", "num_vehicles_available"));
    const renting = bool(pick(st, "is_renting"));
    out.push({
      kind: "station",
      id,
      provider_id: pid,
      provider: prov?.name ?? pid,
      vehicle_classes: classes,
      vehicle_type: prov?.vehicle_type,
      lat: la,
      lon: lo,
      distance_m: d,
      available: st ? renting !== false && (vehiclesAvailable ?? 0) > 0 : undefined,
      station_name: str(pick(s, "name")),
      vehicles_available: vehiclesAvailable,
      docks_available: num(pick(st, "num_docks_available")),
      rental_url: str(pick(pick(s, "rental_uris"), "web", "android", "ios")),
    });
  }

  const bikes = asArr(pick(inp.freeBikeStatus, "bikes", "vehicles"));
  for (const b of bikes) {
    if (!isRec(b)) continue;
    const la = num(b["lat"]);
    const lo = num(b["lon"]);
    if (!inBox(la, lo)) continue;
    const d = distanceM(origin.lat, origin.lon, la as number, lo as number);
    if (d > radiusM) continue;
    const idField = b["bike_id"] !== undefined ? "bike_id" : "vehicle_id";
    const pid = providerIdOf(b, idField);
    const prov = pid ? providers.get(pid) : undefined;
    const vt = vtypes.get(str(b["vehicle_type_id"]) ?? "");
    const classes = vt ? [vt.cls] : (prov?.vehicle_classes ?? []);
    const range = num(b["current_range_meters"]);
    out.push({
      kind: "vehicle",
      id: str(b[idField]),
      provider_id: pid,
      provider: prov?.name ?? pid,
      vehicle_classes: classes,
      vehicle_type: vt?.name ?? prov?.vehicle_type,
      lat: la,
      lon: lo,
      distance_m: d,
      available: !(bool(b["is_reserved"]) ?? false) && !(bool(b["is_disabled"]) ?? false),
      range_km: range !== undefined ? Math.round(range / 100) / 10 : undefined,
      rental_url: str(pick(pick(b, "rental_uris"), "web", "android", "ios")),
    });
  }
  return out;
}

async function nearbyViaGbfs(lat: number, lon: number, radiusM: number) {
  const feeds = await gbfsFeeds();
  const [info, status, bikes, types, provs] = await Promise.all([
    optionalFeed(gbfsFeedUrl(feeds, "station_information"), INFO_TTL),
    optionalFeed(gbfsFeedUrl(feeds, "station_status"), STATUS_TTL),
    optionalFeed(gbfsFeedUrl(feeds, "free_bike_status", "vehicle_status"), STATUS_TTL),
    optionalFeed(gbfsFeedUrl(feeds, "vehicle_types"), INFO_TTL),
    optionalFeed(gbfsFeedUrl(feeds, "providers"), INFO_TTL),
  ]);
  if (!info && !bikes) {
    throw new SourceError("Neither station_information nor free_bike_status could be loaded.", "sharedmobility.ch");
  }
  const loaded = [info, status, bikes, types, provs].filter((x): x is FeedResult => !!x);
  const items = nearbyFromGbfs(
    {
      stationInformation: info?.data,
      stationStatus: status?.data,
      freeBikeStatus: bikes?.data,
      vehicleTypes: types?.data,
      providers: provs ? normaliseProviders(provs.data) : [],
    },
    { lat, lon },
    radiusM,
  );
  const missing = [
    !info && "station_information",
    !status && "station_status",
    !bikes && "free_bike_status",
    !provs && "providers",
  ].filter(Boolean);
  return {
    items,
    cacheStatus: worstCache(...loaded.map((l) => l.cacheStatus)),
    retrievedAt: oldest(...loaded.map((l) => l.retrievedAt)),
    missing: missing as string[],
  };
}

function trimItem(i: MobilityItem) {
  return {
    kind: i.kind,
    distance_m: i.distance_m,
    provider: i.provider,
    ...(i.provider && i.provider_id && i.provider !== i.provider_id ? { provider_id: i.provider_id } : {}),
    vehicle_types: i.vehicle_classes,
    ...(i.vehicle_type ? { vehicle_type_label: i.vehicle_type } : {}),
    ...(i.station_name ? { station_name: i.station_name } : {}),
    ...(i.vehicles_available !== undefined ? { vehicles_available: i.vehicles_available } : {}),
    ...(i.docks_available !== undefined ? { docks_available: i.docks_available } : {}),
    ...(i.available !== undefined ? { available: i.available } : {}),
    ...(i.range_km !== undefined ? { range_km: i.range_km } : {}),
    lat: i.lat !== undefined ? Math.round(i.lat * 1e5) / 1e5 : undefined,
    lon: i.lon !== undefined ? Math.round(i.lon * 1e5) / 1e5 : undefined,
    ...(i.id ? { id: i.id } : {}),
    ...(i.rental_url ? { rental_url: i.rental_url } : {}),
  };
}

// ---------------------------------------------------------------------------
// opentransportdata.swiss
// ---------------------------------------------------------------------------

const OTD_BASE = "https://api.opentransportdata.swiss";
const GTFS_SA_URL = `${OTD_BASE}/la/gtfs-sa?format=JSON`;
const GTFS_RT_URL = `${OTD_BASE}/la/gtfs-rt?format=JSON`;
const SIRI_SX_URL = `${OTD_BASE}/la/siri-sx`;
const KEY_ENV = "OPENTRANSPORTDATA_API_KEY";

function otdKey(): string | undefined {
  const k = process.env[KEY_ENV]?.trim();
  return k ? k : undefined;
}

export function missingKeyError() {
  return toolError(
    `This tool needs a free opentransportdata.swiss API key, and ${KEY_ENV} is not set on this Swissyphus server.`,
    [
      "Register for free at https://opentransportdata.swiss (API Manager → create an application/token; subscribe it to the GTFS-RT, GTFS Service Alerts and SIRI-SX APIs).",
      `Set the environment variable ${KEY_ENV}=<your token> for the Swissyphus process and restart it.`,
      "For keyless alternatives: get_departures / get_connections (transport.opendata.ch) already include per-journey delays.",
    ],
  );
}

function keyRejectedError(status?: number) {
  return toolError(`opentransportdata.swiss rejected the API key in ${KEY_ENV} (HTTP ${status ?? "?"}).`, [
    "Check the token is active and subscribed to this API (GTFS-RT / GTFS Service Alerts / SIRI-SX) in the opentransportdata.swiss API Manager.",
    "The platform enforces per-minute rate limits; HTTP 429 means wait a minute and retry.",
  ]);
}

/** Fetch an opentransportdata.swiss endpoint with Bearer auth, retrying once with the bare token on 401/403. */
async function otdFetch(url: string, key: string, opts: { maxBytes?: number; accept: string; timeoutMs?: number; ttlMs?: number }) {
  const attempt = (auth: string) =>
    fetchTextCached(url, {
      ttlMs: opts.ttlMs ?? otd.cacheTtlSeconds * 1000,
      timeoutMs: opts.timeoutMs ?? 30_000,
      maxBytes: opts.maxBytes ?? 8 * 1024 * 1024,
      init: { headers: { Authorization: auth, Accept: opts.accept } },
    });
  try {
    return await attempt(`Bearer ${key}`);
  } catch (err) {
    if (err instanceof SourceError && (err.status === 401 || err.status === 403)) return attempt(key);
    throw err;
  }
}

function parseJsonOrThrow(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SourceError("opentransportdata.swiss returned a non-JSON response.", "api.opentransportdata.swiss");
  }
}

/** GTFS-RT timestamps are epoch seconds (number or string). */
function epochToIso(v: unknown): string | undefined {
  const n = num(v);
  if (n === undefined || n <= 0) return undefined;
  return new Date(n * 1000).toISOString();
}

/** Pick the best translation from a GTFS-RT TranslatedString. */
export function translated(ts: unknown, lang: string): string | undefined {
  const list = asArr(pick(ts, "translation"));
  const by = (l: string) => list.find((t) => str(pick(t, "language"))?.toLowerCase().startsWith(l));
  const chosen = by(lang) ?? by("en") ?? by("de") ?? list[0];
  return str(pick(chosen, "text")) ?? (typeof ts === "string" ? ts : undefined);
}

export interface Disruption {
  id?: string;
  title?: string;
  description?: string;
  cause?: string;
  effect?: string;
  severity?: string;
  active_periods: Array<{ start?: string; end?: string }>;
  operators: string[];
  routes: string[];
  stops: string[];
  url?: string;
  source: "gtfs-sa" | "siri-sx";
}

/** Parse a GTFS-RT FeedMessage (JSON; camelCase or snake_case) into service alerts. */
export function parseGtfsAlerts(json: unknown, lang = "en"): Disruption[] {
  const out: Disruption[] = [];
  for (const e of asArr(pick(json, "entity"))) {
    const a = pick(e, "alert");
    if (!isRec(a)) continue;
    const informed = asArr(pick(a, "informedEntity", "informed_entity"));
    const uniq = (xs: Array<string | undefined>) => [...new Set(xs.filter((x): x is string => !!x))];
    out.push({
      id: str(pick(e, "id")),
      title: translated(pick(a, "headerText", "header_text"), lang),
      description: translated(pick(a, "descriptionText", "description_text"), lang),
      cause: str(pick(a, "cause")),
      effect: str(pick(a, "effect")),
      severity: str(pick(a, "severityLevel", "severity_level")),
      active_periods: asArr(pick(a, "activePeriod", "active_period")).map((p) => ({
        start: epochToIso(pick(p, "start")),
        end: epochToIso(pick(p, "end")),
      })),
      operators: uniq(informed.map((i) => str(pick(i, "agencyId", "agency_id")))),
      routes: uniq(informed.map((i) => str(pick(i, "routeId", "route_id")))),
      stops: uniq(informed.map((i) => str(pick(i, "stopId", "stop_id")))),
      url: translated(pick(a, "url"), lang),
      source: "gtfs-sa",
    });
  }
  return out;
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .trim();
}

/** All inner texts of <(ns:)?Tag ...>...</(ns:)?Tag> with their xml:lang (if any). */
function xmlAll(xml: string, tag: string): Array<{ text: string; lang?: string }> {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}(\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "g");
  const out: Array<{ text: string; lang?: string }> = [];
  for (const m of xml.matchAll(re)) {
    const lang = /xml:lang="([^"]+)"/.exec(m[1] ?? "")?.[1];
    out.push({ text: m[2] ?? "", lang });
  }
  return out;
}

function xmlText(xml: string, tag: string, lang?: string): string | undefined {
  const all = xmlAll(xml, tag);
  if (!all.length) return undefined;
  const chosen =
    (lang ? all.find((x) => x.lang?.toLowerCase().startsWith(lang)) : undefined) ??
    all.find((x) => x.lang?.toLowerCase().startsWith("en")) ??
    all.find((x) => x.lang?.toLowerCase().startsWith("de")) ??
    all[0];
  const t = decodeXml((chosen?.text ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
  return t || undefined;
}

/** Minimal, defensive SIRI-SX (VDV 736) parser: one Disruption per PtSituationElement. */
export function parseSiriSx(xml: string, lang = "en"): Disruption[] {
  const out: Disruption[] = [];
  for (const { text: el } of xmlAll(xml, "PtSituationElement")) {
    const uniq = (tag: string) =>
      [...new Set(xmlAll(el, tag).map((x) => decodeXml(x.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "))).filter(Boolean))];
    const periods = xmlAll(el, "ValidityPeriod").map((p) => ({
      start: xmlText(p.text, "StartTime"),
      end: xmlText(p.text, "EndTime"),
    }));
    out.push({
      id: xmlText(el, "SituationNumber"),
      title: xmlText(el, "Summary", lang),
      description: xmlText(el, "Description", lang) ?? xmlText(el, "Detail", lang),
      cause: xmlText(el, "AlertCause") ?? xmlText(el, "ReasonName", lang),
      severity: xmlText(el, "Severity"),
      active_periods: periods,
      operators: uniq("OperatorRef"),
      routes: [...new Set([...uniq("PublishedLineName"), ...uniq("LineRef")])].slice(0, 20),
      stops: [...new Set([...uniq("StopPlaceName"), ...uniq("StopPointName")])].slice(0, 30),
      source: "siri-sx",
    });
  }
  return out;
}

export interface DisruptionFilter {
  text?: string;
  operator?: string;
  station?: string;
  activeOnly?: boolean;
  now?: Date;
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function filterDisruptions(list: Disruption[], f: DisruptionFilter): Disruption[] {
  const now = (f.now ?? new Date()).getTime();
  const text = f.text ? fold(f.text) : undefined;
  const op = f.operator ? fold(f.operator) : undefined;
  const st = f.station ? fold(f.station) : undefined;
  return list.filter((d) => {
    const hay = fold(`${d.title ?? ""} ${d.description ?? ""}`);
    if (text && !hay.includes(text)) return false;
    if (op && !d.operators.some((o) => fold(o) === op || fold(o).includes(op)) && !hay.includes(op)) return false;
    if (st) {
      const stopHit = d.stops.some((s) => fold(s).includes(st) || (/^\d+$/.test(st) && s.startsWith(st)));
      if (!stopHit && !hay.includes(st)) return false;
    }
    if (f.activeOnly !== false && d.active_periods.length) {
      const active = d.active_periods.some((p) => {
        const s = p.start ? Date.parse(p.start) : -Infinity;
        const e = p.end ? Date.parse(p.end) : Infinity;
        return s <= now && now <= e;
      });
      if (!active) return false;
    }
    return true;
  });
}

/** Normalise a GTFS stop id / SLOID to its 7-digit UIC/DiDok station number, if derivable. */
export function uicFromStopId(stopId: string): string | undefined {
  const sloid = /sloid:(\d+)/i.exec(stopId);
  if (sloid?.[1]) return `85${sloid[1].padStart(5, "0")}`;
  const m = /^(\d{7})(?::|$|P)/.exec(stopId);
  return m?.[1];
}

export interface StopDelay {
  trip_id?: string;
  route_id?: string;
  start_date?: string;
  start_time?: string;
  stop_id?: string;
  arrival_delay_min?: number;
  departure_delay_min?: number;
  arrival_time?: string;
  departure_time?: string;
  status?: string;
}

/** One indexed stop update: the output row plus its max delay (minutes) for filtering. */
interface IndexedDelay {
  row: StopDelay;
  max_delay_min: number;
}

/** Compact, per-station index of a GTFS-RT trip-update feed. */
export interface StopDelayIndex {
  byStation: Map<string, IndexedDelay[]>;
  /** Feed header timestamp (ISO), if present. */
  feed_timestamp?: string;
  rows: number;
  /** True when the row caps cut rows (on-time rows are dropped first). */
  truncated: boolean;
}

/** Row caps for the index: on-time rows are kept only while under the lower cap. */
const INDEX_MAX_ROWS = 250_000;
const INDEX_MAX_ON_TIME_ROWS = 120_000;

/**
 * Index a GTFS-RT trip-update feed (JSON) by UIC station, keeping only the
 * fields the delay tool returns. The raw national feed is tens of MB; the
 * index is what gets cached between calls.
 */
export function indexStopDelays(
  json: unknown,
  { maxRows = INDEX_MAX_ROWS, maxOnTimeRows = INDEX_MAX_ON_TIME_ROWS } = {},
): StopDelayIndex {
  const byStation = new Map<string, IndexedDelay[]>();
  let rows = 0;
  let truncated = false;
  for (const e of asArr(pick(json, "entity"))) {
    const tu = pick(e, "tripUpdate", "trip_update");
    if (!isRec(tu)) continue;
    const trip = pick(tu, "trip");
    const tripRel = str(pick(trip, "scheduleRelationship", "schedule_relationship"));
    const tripDelay = num(pick(tu, "delay"));
    for (const s of asArr(pick(tu, "stopTimeUpdate", "stop_time_update"))) {
      const stopId = str(pick(s, "stopId", "stop_id"));
      const uic = stopId ? uicFromStopId(stopId) : undefined;
      if (!stopId || !uic) continue;
      const arr = pick(s, "arrival");
      const dep = pick(s, "departure");
      const aDelay = num(pick(arr, "delay")) ?? tripDelay;
      const dDelay = num(pick(dep, "delay")) ?? tripDelay;
      const rel = str(pick(s, "scheduleRelationship", "schedule_relationship"));
      const status =
        tripRel && tripRel !== "SCHEDULED" ? tripRel : rel && rel !== "SCHEDULED" ? rel : undefined;
      const maxDelay = Math.max(aDelay ?? 0, dDelay ?? 0) / 60;
      const onTime = !status && maxDelay <= 0;
      if (rows >= maxRows || (onTime && rows >= maxOnTimeRows)) {
        truncated = true;
        continue;
      }
      const row: StopDelay = {
        trip_id: str(pick(trip, "tripId", "trip_id")),
        route_id: str(pick(trip, "routeId", "route_id")),
        start_date: str(pick(trip, "startDate", "start_date")),
        start_time: str(pick(trip, "startTime", "start_time")),
        stop_id: stopId,
        ...(aDelay !== undefined ? { arrival_delay_min: Math.round(aDelay / 6) / 10 } : {}),
        ...(dDelay !== undefined ? { departure_delay_min: Math.round(dDelay / 6) / 10 } : {}),
        ...(epochToIso(pick(arr, "time")) ? { arrival_time: epochToIso(pick(arr, "time")) } : {}),
        ...(epochToIso(pick(dep, "time")) ? { departure_time: epochToIso(pick(dep, "time")) } : {}),
        ...(status ? { status } : {}),
      };
      const list = byStation.get(uic);
      const entry = { row, max_delay_min: maxDelay };
      if (list) list.push(entry);
      else byStation.set(uic, [entry]);
      rows++;
    }
  }
  return {
    byStation,
    feed_timestamp: epochToIso(pick(pick(json, "header"), "timestamp")),
    rows,
    truncated,
  };
}

/** Delayed (≥ minDelayMin) or cancelled/skipped stop updates for one UIC station, from an index. */
export function stopDelaysFromIndex(index: StopDelayIndex, uic: string, minDelayMin = 0): StopDelay[] {
  return (index.byStation.get(uic) ?? [])
    .filter((d) => d.row.status !== undefined || d.max_delay_min >= minDelayMin)
    .map((d) => d.row);
}

/** Extract per-stop delays for one UIC station from a GTFS-RT trip-update feed (JSON). */
export function extractStopDelays(json: unknown, uic: string, minDelayMin = 0): StopDelay[] {
  return stopDelaysFromIndex(indexStopDelays(json), uic, minDelayMin);
}

// The national GTFS-RT feed is tens of MB — larger than the HTTP cache will
// hold per entry — so without this every call re-downloaded it from a
// rate-limited API. Cache the compact per-station index instead (60 s, the
// feed's refresh cadence) and share one in-flight download between callers.
const RT_INDEX_TTL_MS = 60_000;
const RT_INDEX_MAX_ENTRIES = 2;
const rtIndexCache = new Map<string, { index: StopDelayIndex; storedAt: number }>();
const rtIndexInflight = new Map<string, Promise<{ index: StopDelayIndex; storedAt: number }>>();

/** Test hook: forget cached/in-flight realtime feed indexes. */
export function clearRealtimeIndexCache(): void {
  rtIndexCache.clear();
  rtIndexInflight.clear();
}

async function realtimeIndex(url: string, key: string): Promise<{ index: StopDelayIndex; cacheStatus: CacheStatus; retrievedAt: string }> {
  const hit = rtIndexCache.get(url);
  if (hit && Date.now() - hit.storedAt < RT_INDEX_TTL_MS) {
    return { index: hit.index, cacheStatus: "hit", retrievedAt: new Date(hit.storedAt).toISOString() };
  }
  let pending = rtIndexInflight.get(url);
  if (!pending) {
    pending = (async () => {
      const res = await otdFetch(url, key, {
        accept: "application/json",
        maxBytes: 64 * 1024 * 1024,
        timeoutMs: 60_000,
        // The index is the cache: never serve (or stale-revalidate) the raw body
        // from the HTTP cache, which would duplicate the download in the background.
        ttlMs: 0,
      });
      const entry = { index: indexStopDelays(parseJsonOrThrow(res.data)), storedAt: Date.now() };
      rtIndexCache.delete(url);
      rtIndexCache.set(url, entry);
      while (rtIndexCache.size > RT_INDEX_MAX_ENTRIES) {
        const oldest = rtIndexCache.keys().next().value;
        if (oldest === undefined) break;
        rtIndexCache.delete(oldest);
      }
      return entry;
    })().finally(() => rtIndexInflight.delete(url));
    rtIndexInflight.set(url, pending);
  }
  const entry = await pending;
  return { index: entry.index, cacheStatus: "miss", retrievedAt: new Date(entry.storedAt).toISOString() };
}

function otdErrorResult(err: unknown) {
  if (err instanceof SourceError && (err.status === 401 || err.status === 403 || err.status === 429)) {
    return keyRejectedError(err.status);
  }
  return errorToResult(err, "opentransportdata.swiss");
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export const mobilityModule: SwissyphusModule = {
  id: "mobility",
  emoji: "🛴",
  title: "Mobility (shared vehicles + transport disruptions)",
  description:
    "Nearby shared bikes, e-bikes, e-scooters, mopeds, cars and cargo bikes with live availability (sharedmobility.ch, SFOE); sharing providers; public-transport disruptions and realtime delays (opentransportdata.swiss, free API key)",
  sources: [sharedApi, sharedGbfs, otd],
  healthProbes: [
    {
      sourceId: "sharedmobility-gbfs",
      // Probe what the tools actually use: 2.3 with the contact header, else the 2.0 aggregate.
      get url() {
        return gbfsContact() ? GBFS_ROOT : GBFS_V20_DISCOVERY;
      },
      get headers() {
        const c = gbfsContact();
        return c ? { Authorization: c } : undefined;
      },
    },
    {
      sourceId: "sharedmobility-api",
      url: withParams(`${API_BASE}/identify`, {
        Geometry: "7.439100,46.948800",
        Tolerance: 10,
        offset: 0,
        geometryFormat: "esrijson",
      }),
    },
  ],
  tools: [
    tool({
      name: "get_shared_vehicles_nearby",
      title: "Shared bikes, e-scooters and cars near a point",
      description:
        "Live shared-mobility availability near WGS84 coordinates from sharedmobility.ch (SFOE national aggregator: " +
        "PubliBike, Donkey Republic, Bolt, Voi, Tier, Mobility car sharing, carvelo cargo bikes, …). Returns free-floating " +
        "vehicles and docking stations (with vehicles/docks available) sorted by distance, each with provider name, " +
        "vehicle types, distance_m and battery range where published. Filter with vehicle_type: bike | e-bike | " +
        "cargo_bike | scooter | moped | car. Example: {lat: 47.3779, lon: 8.5403, radius_m: 300, vehicle_type: 'scooter'} " +
        "(Zürich HB). Use geocode first to turn an address into coordinates.",
      inputSchema: {
        lat: z.number().min(45.5).max(48).describe("WGS84 latitude, e.g. 46.9488 (Bern)"),
        lon: z.number().min(5.5).max(11).describe("WGS84 longitude, e.g. 7.4391"),
        radius_m: z.number().int().min(20).max(2000).default(500).describe("Search radius in metres (default 500)"),
        vehicle_type: z.enum(VEHICLE_CLASSES).optional().describe("Only this kind of vehicle ('bike' = non-electric)"),
        kind: z.enum(["all", "vehicles", "stations"]).default("all").describe("Free-floating vehicles, docking stations, or both"),
        only_available: z.boolean().default(true).describe("Hide reserved/disabled vehicles and empty stations"),
        limit: z.number().int().min(1).max(100).default(25),
        source: z
          .enum(["auto", "api", "gbfs"])
          .default("auto")
          .describe("auto = REST API with GBFS fallback (recommended); gbfs downloads the national feeds"),
      },
      handler: async ({ lat, lon, radius_m, vehicle_type, kind, only_available, limit, source }) => {
        let items: MobilityItem[] = [];
        let cacheStatus: CacheStatus = "miss";
        let retrievedAt = new Date().toISOString();
        let manifest = sharedApi;
        const notes: string[] = [];
        let apiError: unknown;
        if (source !== "gbfs") {
          try {
            const r = await nearbyViaApi(lat, lon, radius_m);
            items = r.items;
            cacheStatus = r.cacheStatus;
            retrievedAt = r.retrievedAt;
            if (r.truncated) notes.push("Very dense area: only the first pages of API results were read.");
          } catch (err) {
            apiError = err;
            if (source === "api") return errorToResult(err, "sharedmobility.ch API");
          }
        }
        if (source === "gbfs" || apiError !== undefined) {
          try {
            const r = await nearbyViaGbfs(lat, lon, radius_m);
            items = r.items;
            cacheStatus = r.cacheStatus;
            retrievedAt = r.retrievedAt;
            manifest = sharedGbfs;
            if (apiError !== undefined) notes.push("REST identify endpoint unavailable; answered from the national GBFS feeds.");
            if (r.missing.length) notes.push(`GBFS feeds not available: ${r.missing.join(", ")} (results may be incomplete).`);
          } catch (err) {
            return errorToResult(err, "sharedmobility.ch");
          }
        }

        const filtered = items
          .filter((i) => i.distance_m === undefined || i.distance_m <= radius_m)
          .filter((i) => kind === "all" || (kind === "vehicles" ? i.kind === "vehicle" : i.kind === "station"))
          .filter((i) => !vehicle_type || i.vehicle_classes.includes(vehicle_type))
          .filter((i) => !only_available || i.available !== false)
          .sort((a, b) => (a.distance_m ?? Infinity) - (b.distance_m ?? Infinity));

        if (!filtered.length) {
          return toolError(
            `No ${vehicle_type ?? "shared"} ${kind === "stations" ? "stations" : "vehicles"} found within ${radius_m} m of ${lat}, ${lon}.`,
            [
              "Increase radius_m (max 2000).",
              vehicle_type ? "Drop the vehicle_type filter, or try 'e-bike' / 'scooter'." : "Try another point: coverage is densest in cities.",
              "Set only_available=false to include reserved/disabled vehicles and empty stations.",
            ],
          );
        }
        const byType: Record<string, number> = {};
        const byProvider: Record<string, number> = {};
        for (const i of filtered) {
          for (const c of i.vehicle_classes.length ? i.vehicle_classes : ["other"]) byType[c] = (byType[c] ?? 0) + 1;
          const p = i.provider ?? "unknown";
          byProvider[p] = (byProvider[p] ?? 0) + 1;
        }
        return respond(
          {
            query: { lat, lon, radius_m, vehicle_type, kind, only_available },
            count: filtered.length,
            by_vehicle_type: byType,
            by_provider: byProvider,
            results: filtered.slice(0, limit).map(trimItem),
            ...(filtered.length > limit ? { truncated: `showing ${limit} of ${filtered.length}; raise limit or lower radius_m` } : {}),
          },
          { source: manifest, cacheStatus, retrievedAt, ...(notes.length ? { notes: notes.join(" ") } : {}) },
        );
      },
    }),

    tool({
      name: "list_shared_mobility_providers",
      title: "Swiss shared-mobility providers",
      description:
        "All bike/e-bike/e-scooter/moped/car/cargo-bike sharing providers in the sharedmobility.ch national aggregator: " +
        "provider_id, name, vehicle types, website, Android/iOS app links, and pricing plans where published. " +
        "Filter by name substring (query: 'publibike') or vehicle_type ('car'). Provider names match the 'provider' " +
        "field of get_shared_vehicles_nearby.",
      inputSchema: {
        query: z.string().max(80).optional().describe("Substring of provider name or id, e.g. 'mobility', 'voi'"),
        vehicle_type: z.enum(VEHICLE_CLASSES).optional(),
        include_pricing: z.boolean().default(true).describe("Attach pricing plans from system_pricing_plans if published"),
        limit: z.number().int().min(1).max(200).default(100),
      },
      handler: async ({ query, vehicle_type, include_pricing, limit }) => {
        try {
          const feeds = await gbfsFeeds();
          let providers: ProviderInfo[] = [];
          let cacheStatus: CacheStatus = "miss";
          let retrievedAt = new Date().toISOString();
          let manifest = sharedGbfs;
          const provFeed = await optionalFeed(gbfsFeedUrl(feeds, "providers"), INFO_TTL);
          if (provFeed) {
            providers = normaliseProviders(provFeed.data);
            cacheStatus = provFeed.cacheStatus;
            retrievedAt = provFeed.retrievedAt;
          }
          if (!providers.length) {
            // Fallback: the REST API's providers listing.
            const res = await fetchJson<unknown>(`${API_BASE}/providers`, { ttlMs: INFO_TTL, timeoutMs: 20_000 });
            providers = normaliseProviders(res.data);
            cacheStatus = res.cacheStatus;
            retrievedAt = res.retrievedAt;
            manifest = sharedApi;
          }
          if (!providers.length) {
            return toolError("sharedmobility.ch returned no provider list.", [
              "The providers feed may have moved; run check_source_health for module 'mobility'.",
            ]);
          }

          let pricing = new Map<string, Array<Record<string, unknown>>>();
          if (include_pricing) {
            const plans = await optionalFeed(gbfsFeedUrl(feeds, "system_pricing_plans"), INFO_TTL);
            pricing = new Map();
            for (const p of asArr(pick(plans?.data, "plans"))) {
              if (!isRec(p)) continue;
              const pid = providerIdOf(p, "plan_id");
              if (!pid) continue;
              const list = pricing.get(pid) ?? [];
              if (list.length < 3) {
                list.push({
                  name: str(pick(p, "name")),
                  currency: str(pick(p, "currency")),
                  price: num(pick(p, "price")),
                  description: str(pick(p, "description"))?.slice(0, 200),
                  per_min_rate: num(pick(asArr(pick(p, "per_min_pricing"))[0], "rate")),
                  per_km_rate: num(pick(asArr(pick(p, "per_km_pricing"))[0], "rate")),
                });
              }
              pricing.set(pid, list);
            }
          }

          const q = query ? fold(query) : undefined;
          const rows = providers
            .filter((p) => !q || fold(`${p.name ?? ""} ${p.provider_id}`).includes(q))
            .filter((p) => !vehicle_type || p.vehicle_classes.includes(vehicle_type))
            .sort((a, b) => (a.name ?? a.provider_id).localeCompare(b.name ?? b.provider_id));
          if (!rows.length) {
            return toolError(`No providers match${query ? ` '${query}'` : ""}${vehicle_type ? ` with ${vehicle_type}` : ""}.`, [
              "Call without filters to list all providers.",
            ]);
          }
          const shown = rows.slice(0, limit).map((p) => ({
            provider_id: p.provider_id,
            name: p.name,
            vehicle_types: p.vehicle_classes,
            vehicle_type_label: p.vehicle_type,
            url: p.url,
            apps: p.apps,
            ...(pricing.get(p.provider_id)?.length ? { pricing_plans: pricing.get(p.provider_id) } : {}),
          }));
          const { data, dropped } = fitToBudget(shown, (xs) => ({
            count: rows.length,
            providers: xs,
            ...(xs.length < shown.length
              ? { truncated: `showing ${xs.length} of ${rows.length} to fit the 50 KB response cap; filter with query/vehicle_type or set include_pricing=false` }
              : {}),
          }));
          return respond(data, {
            source: manifest,
            cacheStatus,
            retrievedAt,
            ...(dropped ? { notes: `${dropped} providers omitted to stay under the 50 KB response cap.` } : {}),
          });
        } catch (err) {
          return errorToResult(err, "sharedmobility.ch");
        }
      },
    }),

    tool({
      name: "get_transport_disruptions",
      title: "Current public-transport disruptions (Switzerland)",
      description:
        "Current and planned disruptions on Swiss public transport (trains, trams, buses, boats) from opentransportdata.swiss " +
        "service alerts: title, description, cause/effect, validity periods, affected operators/lines/stops. Filter by " +
        "free text (text: 'Bauarbeiten'), operator (agency id like '11' for SBB, or name), or station (name or UIC number, " +
        "e.g. 'Olten' or '8500218'). Requires the server env var OPENTRANSPORTDATA_API_KEY (free key); otherwise returns " +
        "instructions. Example: {station: 'Luzern', lang: 'de'}.",
      inputSchema: {
        text: z.string().max(100).optional().describe("Substring in title/description, e.g. 'Streckenunterbruch'"),
        operator: z.string().max(60).optional().describe("GTFS agency id (e.g. '11' = SBB) or operator name"),
        station: z.string().max(80).optional().describe("Station name or 7-digit UIC number"),
        active_only: z.boolean().default(true).describe("Only disruptions whose validity covers now"),
        lang: z.enum(["en", "de", "fr", "it"]).default("en"),
        limit: z.number().int().min(1).max(100).default(20),
      },
      handler: async ({ text, operator, station, active_only, lang, limit }) => {
        const key = otdKey();
        if (!key) return missingKeyError();
        let list: Disruption[];
        let cacheStatus: CacheStatus;
        let retrievedAt: string;
        let feedNote: string | undefined;
        try {
          try {
            const res = await otdFetch(GTFS_SA_URL, key, { accept: "application/json" });
            list = parseGtfsAlerts(parseJsonOrThrow(res.data), lang);
            cacheStatus = res.cacheStatus;
            retrievedAt = res.retrievedAt;
          } catch (err) {
            // Auth/rate-limit problems apply to SIRI-SX too; only fall back on other failures.
            if (err instanceof SourceError && [401, 403, 429].includes(err.status ?? 0)) throw err;
            const res = await otdFetch(SIRI_SX_URL, key, { accept: "application/xml", maxBytes: 25 * 1024 * 1024 });
            list = parseSiriSx(res.data, lang);
            cacheStatus = res.cacheStatus;
            retrievedAt = res.retrievedAt;
            feedNote = "GTFS service-alert feed unavailable; answered from SIRI-SX.";
          }
        } catch (err) {
          return otdErrorResult(err);
        }
        const hits = filterDisruptions(list, { text, operator, station, activeOnly: active_only });
        const cut = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n)}…` : s);
        const shown = hits.slice(0, limit).map((d) => ({
          ...d,
          title: cut(d.title, 300),
          description: cut(d.description, 600),
          stops: d.stops.slice(0, 15),
          routes: d.routes.slice(0, 15),
          operators: d.operators.slice(0, 15),
          active_periods: d.active_periods.slice(0, 10),
        }));
        const { data, dropped } = fitToBudget(shown, (xs) => ({
          query: { text, operator, station, active_only },
          total_in_feed: list.length,
          count: hits.length,
          disruptions: xs,
          ...(xs.length < shown.length
            ? { truncated: `showing ${xs.length} of ${hits.length} to fit the 50 KB response cap; narrow with text/operator/station` }
            : {}),
          ...(hits.length === 0
            ? { hint: "No matching disruption. Loosen filters (station names match text; operator ids are GTFS agency ids)." }
            : {}),
        }));
        const notes = [feedNote, dropped ? `${dropped} disruptions omitted to stay under the 50 KB response cap.` : undefined]
          .filter(Boolean)
          .join(" ");
        return respond(data, { source: otd, cacheStatus, retrievedAt, language: lang, ...(notes ? { notes } : {}) });
      },
    }),

    tool({
      name: "get_realtime_delays",
      title: "Realtime delays at a station (GTFS-RT)",
      description:
        "Realtime arrival/departure delays and cancellations at one Swiss station from the national GTFS-RT trip-update feed " +
        "(opentransportdata.swiss). Input the 7-digit UIC station number (use search_stations to find it; e.g. 8503000 = " +
        "Zürich HB, 8507000 = Bern). Returns GTFS trip_id/route_id, delay in minutes and status (CANCELED/SKIPPED). " +
        "Requires env OPENTRANSPORTDATA_API_KEY (free). For line names and platforms prefer get_departures.",
      inputSchema: {
        station_id: z.string().regex(/^85\d{5}$/).describe("7-digit UIC/DiDok number, e.g. '8503000'"),
        min_delay_minutes: z.number().min(0).max(120).default(1).describe("Only trips delayed at least this much (cancellations always shown)"),
        limit: z.number().int().min(1).max(100).default(25),
      },
      handler: async ({ station_id, min_delay_minutes, limit }) => {
        const key = otdKey();
        if (!key) return missingKeyError();
        try {
          const res = await realtimeIndex(GTFS_RT_URL, key);
          const rows = stopDelaysFromIndex(res.index, station_id, min_delay_minutes).sort(
            (a, b) =>
              Math.max(b.arrival_delay_min ?? 0, b.departure_delay_min ?? 0) -
              Math.max(a.arrival_delay_min ?? 0, a.departure_delay_min ?? 0),
          );
          const feedTs = res.index.feed_timestamp;
          const notes = res.index.truncated
            ? "The national feed exceeded Swissyphus's index cap; some on-time stop updates were not indexed (delays and cancellations are kept first)."
            : undefined;
          const { data } = fitToBudget(rows.slice(0, limit), (xs) => ({
            station_id,
            min_delay_minutes,
            count: rows.length,
            delays: xs,
            ...(xs.length < Math.min(limit, rows.length) ? { truncated: `showing ${xs.length} of ${rows.length} to fit the 50 KB response cap` } : {}),
            ...(rows.length === 0
              ? { hint: "No delayed or cancelled trips at this station in the current feed (or the UIC number is wrong — check with search_stations)." }
              : {}),
          }));
          return respond(data, {
            source: otd,
            cacheStatus: res.cacheStatus,
            retrievedAt: res.retrievedAt,
            ...(feedTs ? { dataAsOf: feedTs } : {}),
            ...(notes ? { notes } : {}),
          });
        } catch (err) {
          return otdErrorResult(err);
        }
      },
    }),
  ],
};
