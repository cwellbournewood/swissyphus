/**
 * Avalanche module — WSL Institute for Snow and Avalanche Research SLF.
 * Official avalanche bulletin (CAAML/GeoJSON). Outside the winter season the
 * bulletin is empty — the tools degrade gracefully and say so.
 */

import { z } from "zod";
import { fetchJson } from "../core/http.js";
import { respond, errorToResult } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

const slf: SourceManifest = {
  id: "slf-bulletin",
  name: "SLF Avalanche Bulletin",
  operator: "WSL Institute for Snow and Avalanche Research SLF",
  url: "https://www.slf.ch/en/avalanche-bulletin-and-snow-situation/",
  licence: "SLF open data — free use with attribution",
  attribution: "© SLF/WSL",
  updateFrequency: "twice daily in winter season; not published in summer",
  cacheTtlSeconds: 1800,
};

const BULLETIN_URL = "https://aws.slf.ch/api/bulletin/caaml/en/geojson";

type Ring = Array<[number, number]>;

interface BulletinFeature {
  properties?: Record<string, unknown>;
  geometry?: { type?: string; coordinates?: unknown };
}

function pointInRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const pi = ring[i];
    const pj = ring[j];
    if (!pi || !pj) continue;
    const [xi, yi] = pi;
    const [xj, yj] = pj;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function featureContains(f: BulletinFeature, lat: number, lon: number): boolean {
  const g = f.geometry;
  if (!g?.coordinates) return false;
  if (g.type === "Polygon") {
    const rings = g.coordinates as Ring[];
    return rings.length > 0 && pointInRing(lon, lat, rings[0] as Ring);
  }
  if (g.type === "MultiPolygon") {
    const polys = g.coordinates as Ring[][];
    return polys.some((rings) => rings.length > 0 && pointInRing(lon, lat, rings[0] as Ring));
  }
  return false;
}

function summarize(props: Record<string, unknown> | undefined) {
  if (!props) return {};
  // CAAML property names vary between bulletin versions — pick the useful ones,
  // fall back to passing everything through.
  const keys = Object.keys(props);
  const pick = (fragment: string) => {
    const k = keys.find((x) => x.toLowerCase().includes(fragment));
    return k ? props[k] : undefined;
  };
  return {
    region_id: pick("regionid") ?? pick("id"),
    region_name: pick("name"),
    danger_rating: pick("dangerrating") ?? pick("danger") ?? pick("maxdanger"),
    valid_time: pick("validtime") ?? pick("valid"),
    all_properties: props,
  };
}

const offSeasonNote =
  "No avalanche bulletin is currently published. SLF publishes bulletins during the winter season (typically November–May); in summer only exceptional situation reports appear.";

export const avalancheModule: SwissyphusModule = {
  id: "avalanche",
  emoji: "🏔️",
  title: "Avalanche (SLF)",
  description: "Official SLF avalanche bulletin: danger levels by warning region",
  sources: [slf],
  healthProbes: [{ sourceId: "slf-bulletin", url: BULLETIN_URL }],
  tools: [
    tool({
      name: "get_avalanche_bulletin",
      title: "Current avalanche bulletin",
      description:
        "The current official SLF avalanche bulletin for Switzerland: danger ratings per warning region (EAWS scale 1 low – 5 very high). Outside winter the bulletin is empty and this tool reports that clearly.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(30).describe("Max regions to return"),
      },
      handler: async ({ limit }) => {
        try {
          const { data, cacheStatus, retrievedAt } = await fetchJson<{ features?: BulletinFeature[] }>(
            BULLETIN_URL,
            { ttlMs: slf.cacheTtlSeconds * 1000 },
          );
          const features = data.features ?? [];
          if (!features.length) {
            return respond(
              { status: "no_bulletin_published", message: offSeasonNote, regions: [] },
              { source: slf, cacheStatus, retrievedAt },
            );
          }
          return respond(
            {
              status: "bulletin_active",
              region_count: features.length,
              regions: features.slice(0, limit).map((f) => summarize(f.properties)),
              danger_scale: "1=low, 2=moderate, 3=considerable, 4=high, 5=very high (EAWS)",
            },
            { source: slf, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "SLF avalanche bulletin");
        }
      },
    }),

    tool({
      name: "get_avalanche_danger_at",
      title: "Avalanche danger at coordinates",
      description:
        "Avalanche danger level for a specific WGS84 point (e.g. a ski-touring destination), resolved against the SLF warning-region polygons.",
      inputSchema: {
        lat: z.number().min(45.5).max(48).describe("WGS84 latitude"),
        lon: z.number().min(5.5).max(11).describe("WGS84 longitude"),
      },
      handler: async ({ lat, lon }) => {
        try {
          const { data, cacheStatus, retrievedAt } = await fetchJson<{ features?: BulletinFeature[] }>(
            BULLETIN_URL,
            { ttlMs: slf.cacheTtlSeconds * 1000 },
          );
          const features = data.features ?? [];
          if (!features.length) {
            return respond(
              { status: "no_bulletin_published", message: offSeasonNote, query: { lat, lon } },
              { source: slf, cacheStatus, retrievedAt },
            );
          }
          const hit = features.find((f) => featureContains(f, lat, lon));
          if (!hit) {
            return respond(
              {
                status: "outside_warning_regions",
                message: "The point is not inside any current SLF warning region polygon.",
                query: { lat, lon },
              },
              { source: slf, cacheStatus, retrievedAt },
            );
          }
          return respond(
            { status: "bulletin_active", query: { lat, lon }, region: summarize(hit.properties) },
            { source: slf, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "SLF avalanche bulletin");
        }
      },
    }),
  ],
};
