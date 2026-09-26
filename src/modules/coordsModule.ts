/**
 * Coordinate conversion module — LV95 (EPSG:2056) ↔ WGS84 (EPSG:4326),
 * with LV03 legacy values included. Computed locally with official swisstopo
 * approximation formulas (~1 m accuracy).
 */

import { z } from "zod";
import { respond, toolError } from "../core/envelope.js";
import { lv95ToWgs84, wgs84ToLv95 } from "../core/coords.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

const formulas: SourceManifest = {
  id: "swisstopo-formulas",
  name: "swisstopo reference frame conversion formulas",
  operator: "Federal Office of Topography swisstopo",
  url: "https://www.swisstopo.admin.ch/en/coordinates-conversion-navref",
  licence: "Public formulas, free use",
  attribution: "Conversion per swisstopo approximation formulas (~1 m accuracy)",
  updateFrequency: "static",
  cacheTtlSeconds: 0,
};

/** Accepted ranges (Switzerland + margin). Outside them the approximation formulas are meaningless. */
export const LV95_E = [2_400_000, 2_900_000] as const;
export const LV95_N = [1_050_000, 1_350_000] as const;
export const LV03_E = [400_000, 900_000] as const;
export const LV03_N = [50_000, 350_000] as const;
export const WGS_LAT = [45.4, 48.3] as const;
export const WGS_LON = [5.5, 11.0] as const;

const within = (v: number, [lo, hi]: readonly [number, number]) => v >= lo && v <= hi;

export type LvInterpretation =
  | { ok: true; system: "LV95" | "LV03"; e95: number; n95: number }
  | { ok: false; error: string; hint?: string };

/** Classify an easting/northing pair as LV95 or LV03, or explain why it is neither. */
export function interpretLv(easting: number, northing: number): LvInterpretation {
  if (!Number.isFinite(easting) || !Number.isFinite(northing)) {
    return { ok: false, error: "Easting and northing must be finite numbers." };
  }
  if (within(easting, LV95_E) && within(northing, LV95_N)) return { ok: true, system: "LV95", e95: easting, n95: northing };
  if (within(easting, LV03_E) && within(northing, LV03_N)) {
    return { ok: true, system: "LV03", e95: easting + 2_000_000, n95: northing + 1_000_000 };
  }
  if ((within(northing, LV95_E) && within(easting, LV95_N)) || (within(northing, LV03_E) && within(easting, LV03_N))) {
    return {
      ok: false,
      error: `Easting ${easting} / northing ${northing} look swapped: in Switzerland the easting (E, Y) is the larger value (LV95 ~2'600'000, LV03 ~600'000) and the northing (N, X) the smaller (LV95 ~1'200'000, LV03 ~200'000).`,
      hint: `Retry with easting=${northing}, northing=${easting}.`,
    };
  }
  if (within(easting, WGS_LON) && within(northing, WGS_LAT)) {
    return {
      ok: false,
      error: `${easting} / ${northing} look like WGS84 longitude/latitude, not Swiss projected coordinates.`,
      hint: "Use convert_wgs84_to_lv95 for WGS84 input.",
    };
  }
  return {
    ok: false,
    error: `Coordinates E ${easting} / N ${northing} are outside Switzerland. Expected LV95 (E ${LV95_E[0]}–${LV95_E[1]}, N ${LV95_N[0]}–${LV95_N[1]}) or LV03 (E ${LV03_E[0]}–${LV03_E[1]}, N ${LV03_N[0]}–${LV03_N[1]}).`,
  };
}

/** Validate a WGS84 point for LV95 conversion, detecting swapped lat/lon. */
export function checkWgs84(lat: number, lon: number): { ok: true } | { ok: false; error: string; hint?: string } {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ok: false, error: "lat and lon must be finite numbers." };
  if (within(lat, WGS_LAT) && within(lon, WGS_LON)) return { ok: true };
  if (within(lon, WGS_LAT) && within(lat, WGS_LON)) {
    return {
      ok: false,
      error: `lat ${lat} / lon ${lon} look swapped: Swiss latitudes are ~45.8–47.8 and longitudes ~5.9–10.5.`,
      hint: `Retry with lat=${lon}, lon=${lat}.`,
    };
  }
  if (lat > 1000 || lon > 1000) {
    return {
      ok: false,
      error: `lat ${lat} / lon ${lon} look like projected (LV95/LV03) coordinates, not WGS84 degrees.`,
      hint: "Use convert_lv95_to_wgs84 for Swiss projected coordinates.",
    };
  }
  return {
    ok: false,
    error: `WGS84 point ${lat}, ${lon} is outside the Swiss area supported by the LV95 formulas (lat ${WGS_LAT[0]}–${WGS_LAT[1]}, lon ${WGS_LON[0]}–${WGS_LON[1]}).`,
  };
}

export const coordsModule: SwissyphusModule = {
  id: "coords",
  emoji: "📐",
  title: "Coordinate conversion",
  description: "LV95 (EPSG:2056) ↔ WGS84, with LV03 legacy output — computed locally, instant",
  sources: [formulas],
  tools: [
    tool({
      name: "convert_wgs84_to_lv95",
      title: "Convert WGS84 → LV95",
      description:
        "Convert WGS84 latitude/longitude (Switzerland and surroundings) to Swiss LV95 coordinates (EPSG:2056). Also returns legacy LV03 values.",
      inputSchema: {
        lat: z.number().describe("WGS84 latitude (Switzerland ≈ 45.8–47.8)"),
        lon: z.number().describe("WGS84 longitude (Switzerland ≈ 5.9–10.5)"),
      },
      handler: async ({ lat, lon }) => {
        const chk = checkWgs84(lat, lon);
        if (!chk.ok) return toolError(chk.error, chk.hint ? [chk.hint] : []);
        const lv95 = wgs84ToLv95(lat, lon);
        return respond(
          {
            wgs84: { lat, lon },
            lv95: { easting: lv95.easting, northing: lv95.northing, epsg: 2056 },
            lv03: {
              easting: Math.round((lv95.easting - 2_000_000) * 100) / 100,
              northing: Math.round((lv95.northing - 1_000_000) * 100) / 100,
              epsg: 21781,
            },
          },
          { source: formulas, cacheStatus: "computed", retrievedAt: new Date().toISOString() },
        );
      },
    }),

    tool({
      name: "convert_lv95_to_wgs84",
      title: "Convert LV95 → WGS84",
      description:
        "Convert Swiss LV95 coordinates (EPSG:2056, easting ~2'600'000 / northing ~1'200'000) to WGS84 latitude/longitude. LV03 legacy values (600'000/200'000 range) are auto-detected and shifted. Swapped easting/northing and out-of-range values are rejected with an explanation.",
      inputSchema: {
        easting: z.number().describe("LV95 easting (E, ~2'480'000–2'840'000) or LV03 easting (~480'000–840'000)"),
        northing: z.number().describe("LV95 northing (N, ~1'070'000–1'300'000) or LV03 northing (~70'000–300'000)"),
      },
      handler: async ({ easting, northing }) => {
        const r = interpretLv(easting, northing);
        if (!r.ok) return toolError(r.error, r.hint ? [r.hint] : []);
        const wgs = lv95ToWgs84(r.e95, r.n95);
        return respond(
          {
            input_interpreted_as: r.system === "LV03" ? "LV03 (auto-shifted to LV95)" : "LV95",
            lv95: { easting: r.e95, northing: r.n95, epsg: 2056 },
            wgs84: wgs,
          },
          { source: formulas, cacheStatus: "computed", retrievedAt: new Date().toISOString() },
        );
      },
    }),
  ],
};
