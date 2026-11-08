/**
 * Swiss coordinate handling.
 *
 * Conversion between WGS84 (EPSG:4326) and Swiss LV95 (EPSG:2056) using the
 * official swisstopo approximation formulas (accurate to ~1 m, which is
 * sufficient for lookup and search use cases). LV03 legacy values are LV95
 * minus the 2'000'000 / 1'000'000 false offsets.
 */

export interface Lv95 {
  easting: number;
  northing: number;
}

export interface Wgs84 {
  lat: number;
  lon: number;
}

export function wgs84ToLv95(lat: number, lon: number): Lv95 {
  const phi = (lat * 3600 - 169028.66) / 10000;
  const lambda = (lon * 3600 - 26782.5) / 10000;
  const easting =
    2600072.37 +
    211455.93 * lambda -
    10938.51 * lambda * phi -
    0.36 * lambda * phi * phi -
    44.54 * lambda * lambda * lambda;
  const northing =
    1200147.07 +
    308807.95 * phi +
    3745.25 * lambda * lambda +
    76.63 * phi * phi -
    194.56 * lambda * lambda * phi +
    119.79 * phi * phi * phi;
  return { easting: round2(easting), northing: round2(northing) };
}

export function lv95ToWgs84(easting: number, northing: number): Wgs84 {
  const y = (easting - 2600000) / 1000000;
  const x = (northing - 1200000) / 1000000;
  const lambda =
    2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y * y * y;
  const phi =
    16.9023892 +
    3.238272 * x -
    0.270978 * y * y -
    0.002528 * x * x -
    0.0447 * y * y * x -
    0.014 * x * x * x;
  return { lat: round6((phi * 100) / 36), lon: round6((lambda * 100) / 36) };
}

export function isLikelyLv95(a: number, b: number): boolean {
  return a > 2_400_000 && a < 2_900_000 && b > 1_000_000 && b < 1_400_000;
}

export function inSwitzerland(lat: number, lon: number): boolean {
  return lat >= 45.7 && lat <= 47.9 && lon >= 5.8 && lon <= 10.6;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round6(n: number): number {
  return Math.round(n * 1000000) / 1000000;
}

/** Haversine distance in km between two WGS84 points. */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)) * 100) / 100;
}

/**
 * Annotate each item with `distance_km` from an origin point and return the
 * list sorted nearest-first. When `from` is undefined the items keep their
 * original order and `distance_km` is undefined; items whose coordinates can't
 * be resolved sort last. Consolidates the near-identical "map → compute
 * distance → sort" block shared by the station-directory tools (weather, snow,
 * air quality, …), so the small inconsistencies that crept into hand-rolled
 * copies can't recur.
 */
export function byDistance<T>(
  items: T[],
  from: Wgs84 | undefined,
  coordsOf: (item: T) => Wgs84 | undefined,
): Array<T & { distance_km: number | undefined }> {
  if (!from) return items.map((item) => ({ ...item, distance_km: undefined }));
  const origin = from;
  const annotated = items.map((item) => {
    const c = coordsOf(item);
    return {
      ...item,
      distance_km: c ? distanceKm(origin.lat, origin.lon, c.lat, c.lon) : undefined,
    };
  });
  annotated.sort((a, b) => (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity));
  return annotated;
}
