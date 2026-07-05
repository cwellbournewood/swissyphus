/**
 * Coordinate conversion module — LV95 (EPSG:2056) ↔ WGS84 (EPSG:4326),
 * with LV03 legacy values included. Computed locally with official swisstopo
 * approximation formulas (~1 m accuracy).
 */

import { z } from "zod";
import { respond } from "../core/envelope.js";
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
        "Convert WGS84 latitude/longitude to Swiss LV95 coordinates (EPSG:2056). Also returns legacy LV03 values.",
      inputSchema: {
        lat: z.number().min(45).max(48.5).describe("WGS84 latitude"),
        lon: z.number().min(5).max(11.5).describe("WGS84 longitude"),
      },
      handler: async ({ lat, lon }) => {
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
        "Convert Swiss LV95 coordinates (EPSG:2056, easting ~2'600'000 / northing ~1'200'000) to WGS84 latitude/longitude. LV03 legacy values (600'000/200'000 range) are auto-detected and shifted.",
      inputSchema: {
        easting: z.number().describe("LV95 easting (E, ~2'480'000–2'840'000) or LV03 easting (~480'000–840'000)"),
        northing: z.number().describe("LV95 northing (N, ~1'070'000–1'300'000) or LV03 northing (~70'000–300'000)"),
      },
      handler: async ({ easting, northing }) => {
        const isLv03 = easting < 1_000_000;
        const e95 = isLv03 ? easting + 2_000_000 : easting;
        const n95 = isLv03 ? northing + 1_000_000 : northing;
        const wgs = lv95ToWgs84(e95, n95);
        return respond(
          {
            input_interpreted_as: isLv03 ? "LV03 (auto-shifted to LV95)" : "LV95",
            lv95: { easting: e95, northing: n95, epsg: 2056 },
            wgs84: wgs,
          },
          { source: formulas, cacheStatus: "computed", retrievedAt: new Date().toISOString() },
        );
      },
    }),
  ],
};
