/**
 * Glaciers module — Swiss Glacier Monitoring Network (GLAMOS): the official
 * glacier list, front-variation (length change) series since the 1880s,
 * glaciological mass balance and geodetic volume change.
 *
 * Data: CSV files at https://doi.glamos.ch/data/… (each with a free-text
 * preamble, a column-name line starting "glacier name"/"SGI-ID", then two
 * lines of units/descriptions before the data rows).
 *
 * Licence: GLAMOS data "may be used with indication of the source for
 * scientific and non-commercial use" — flagged in the manifest and in every
 * response; a hosted commercial deployment needs GLAMOS's permission.
 */

import { z } from "zod";
import { allowHosts, fetchTextCached } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";
import { lv95ToWgs84 } from "../core/coords.js";

allowHosts("doi.glamos.ch");

const glamos: SourceManifest = {
  id: "glamos",
  name: "GLAMOS — Swiss Glacier Monitoring Network",
  operator: "GLAMOS (ETH Zurich VAW, Universities of Fribourg and Zurich, on behalf of FOEN, MeteoSwiss and SCNAT)",
  url: "https://www.glamos.ch",
  licence: "Free for scientific and non-commercial use with indication of the source (GLAMOS terms); commercial use requires permission",
  attribution: "Source: GLAMOS — Glacier Monitoring Switzerland, doi:10.18750 (cite the release, e.g. 'GLAMOS (2025), Swiss Glacier Length Change, release 2025')",
  updateFrequency: "annual releases (autumn) after the measurement season",
  cacheTtlSeconds: 7 * 86400,
  notes: "CSV releases from doi.glamos.ch: glacier list, length change, mass balance (observation period), volume change (geodetic).",
};

const BASE = "https://doi.glamos.ch/data";
const FILES = {
  list: `${BASE}/glacier_list/glacier_list.csv`,
  length: `${BASE}/lengthchange/lengthchange.csv`,
  mass: `${BASE}/massbalance/massbalance_observation.csv`,
  volume: `${BASE}/volumechange/volumechange.csv`,
};

/** Split a GLAMOS CSV into its preamble (citation) and data rows keyed by the header line. */
export function parseGlamosCsv(text: string): { citation?: string; header: string[]; rows: string[][] } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const hi = lines.findIndex((l) => /^(glacier name,|SGI-ID,)/i.test(l));
  if (hi < 0) return { header: [], rows: [] };
  const citation = lines.slice(0, hi).join(" ").match(/please cite as:?\s*(.+?)(?:\s{2,}|$)/i)?.[1]?.trim();
  const header = lines[hi]!.split(",").map((s) => s.trim());
  const rows: string[][] = [];
  for (const l of lines.slice(hi + 1)) {
    if (!l.trim()) continue;
    const f = l.split(",").map((s) => s.trim());
    // Skip the unit/description lines below the header (first cell empty).
    if (!f[0]) continue;
    rows.push(f);
  }
  return { ...(citation ? { citation } : {}), header, rows };
}

const n = (v: string | undefined) => {
  if (v === undefined || v === "" || v === "-" || v.toUpperCase() === "NAN") return undefined;
  const x = Number(v);
  return Number.isFinite(x) ? x : undefined;
};

const fold = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();

interface GlacierRef {
  name: string;
  id: string;
}

export function findGlacier(list: { rows: string[][] }, q: string): GlacierRef[] {
  const f = fold(q.trim());
  const exactId = list.rows.find((r) => r[1]?.toLowerCase() === f);
  if (exactId) return [{ name: exactId[0]!, id: exactId[1]! }];
  return list.rows.filter((r) => fold(r[0] ?? "").includes(f)).map((r) => ({ name: r[0]!, id: r[1]! }));
}

const yearOf = (d: string | undefined) => d?.slice(0, 4);

export const glaciersModule: SwissyphusModule = {
  id: "glaciers",
  emoji: "🧊",
  title: "Glaciers (GLAMOS)",
  description:
    "Swiss glacier monitoring (GLAMOS): official list of ~170 measured glaciers with area and coordinates; length change since the 1880s, annual mass balance and geodetic volume change per glacier",
  sources: [glamos],
  healthProbes: [{ sourceId: "glamos", url: FILES.list }],
  tools: [
    tool({
      name: "list_glaciers",
      title: "Swiss monitored glaciers (GLAMOS)",
      description:
        "Glaciers in the Swiss monitoring network with SGI id, area (km²), coordinates and which measurement series exist (length change, mass balance, volume change). Filter by name; sorted by area. Example: {query: 'Aletsch'}.",
      inputSchema: {
        query: z.string().min(2).max(80).optional().describe("Name fragment, e.g. 'Rhone', 'Aletsch', 'Morteratsch'"),
        limit: z.number().int().min(1).max(200).default(30),
      },
      handler: async ({ query, limit }) => {
        try {
          const { data, cacheStatus, retrievedAt } = await fetchTextCached(FILES.list, { ttlMs: glamos.cacheTtlSeconds * 1000, timeoutMs: 30_000 });
          const list = parseGlamosCsv(data);
          let rows = list.rows;
          if (query) {
            const f = fold(query);
            rows = rows.filter((r) => fold(r[0] ?? "").includes(f) || fold(r[1] ?? "") === f);
          }
          if (!rows.length) return toolError(`No monitored glacier matches '${query}'.`, ["Call without query to list all ~170 glaciers."]);
          const out = rows
            .map((r) => {
              const e = n(r[2]);
              const no = n(r[3]);
              const wgs = e && no ? lv95ToWgs84(e, no) : undefined;
              return {
                name: r[0],
                id: r[1],
                area_km2: n(r[4]),
                area_year: r[5],
                ...(wgs ? { lat: Math.round(wgs.lat * 1e5) / 1e5, lon: Math.round(wgs.lon * 1e5) / 1e5 } : {}),
                series: {
                  length_change: r[6] === "1",
                  mass_balance: r[7] === "1",
                  volume_change: r[8] === "1",
                },
              };
            })
            .sort((a, b) => (b.area_km2 ?? 0) - (a.area_km2 ?? 0));
          return respond(
            { total: out.length, glaciers: out.slice(0, limit), citation: list.citation },
            { source: glamos, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "GLAMOS");
        }
      },
    }),
    tool({
      name: "get_glacier_changes",
      title: "Glacier length, mass and volume change (GLAMOS)",
      description:
        "Measured changes of one Swiss glacier: front variation per survey interval (m) with cumulative retreat, annual/winter/summer mass balance (mm water equivalent) with ELA, and geodetic volume change (km³, mean thickness change). " +
        "Give a name or SGI id. Example: {glacier: 'Rhonegletscher'}, {glacier: 'B43-03', series: 'length'}.",
      inputSchema: {
        glacier: z.string().min(2).max(80).describe("Glacier name (or part) or SGI id from list_glaciers"),
        series: z.enum(["all", "length", "mass_balance", "volume"]).default("all"),
        last: z.number().int().min(1).max(200).default(20).describe("Most recent N observations per series"),
      },
      handler: async ({ glacier, series, last }) => {
        try {
          const listRes = await fetchTextCached(FILES.list, { ttlMs: glamos.cacheTtlSeconds * 1000, timeoutMs: 30_000 });
          const matches = findGlacier(parseGlamosCsv(listRes.data), glacier);
          if (!matches.length) return toolError(`No monitored glacier matches '${glacier}'.`, ["Find names and ids with list_glaciers."]);
          if (matches.length > 1 && !matches.some((m) => fold(m.name) === fold(glacier))) {
            return toolError(`'${glacier}' matches several glaciers.`, [`Be specific: ${matches.slice(0, 10).map((m) => `${m.name} (${m.id})`).join(", ")}.`]);
          }
          const g = matches.find((m) => fold(m.name) === fold(glacier)) ?? matches[0]!;
          const want = (s: string) => series === "all" || series === s;
          const out: Record<string, unknown> = { glacier: g.name, id: g.id };
          const citations: string[] = [];
          let retrievedAt = listRes.retrievedAt;
          if (want("length")) {
            const r = await fetchTextCached(FILES.length, { ttlMs: glamos.cacheTtlSeconds * 1000, timeoutMs: 30_000, maxBytes: 20 * 1024 * 1024 });
            retrievedAt = r.retrievedAt;
            const p = parseGlamosCsv(r.data);
            if (p.citation) citations.push(p.citation);
            const rows = p.rows.filter((x) => x[1] === g.id);
            const total = rows.reduce((s, x) => s + (n(x[6]) ?? 0), 0);
            out["length_change"] = rows.length
              ? {
                  observations: rows.length,
                  period: `${yearOf(rows[0]![2])}–${yearOf(rows[rows.length - 1]![4])}`,
                  cumulative_m: Math.round(total),
                  recent: rows.slice(-last).map((x) => ({ from: x[2], to: x[4], change_m: n(x[6]), tongue_elevation_m: n(x[7]) })),
                }
              : "not measured";
          }
          if (want("mass_balance")) {
            const r = await fetchTextCached(FILES.mass, { ttlMs: glamos.cacheTtlSeconds * 1000, timeoutMs: 30_000, maxBytes: 20 * 1024 * 1024 });
            const p = parseGlamosCsv(r.data);
            if (p.citation) citations.push(p.citation);
            const rows = p.rows.filter((x) => x[1] === g.id);
            out["mass_balance"] = rows.length
              ? {
                  unit: "mm water equivalent",
                  observations: rows.length,
                  recent: rows.slice(-last).map((x) => ({
                    hydrological_year: yearOf(x[4]),
                    winter: n(x[5]),
                    summer: n(x[6]),
                    annual: n(x[7]),
                    ela_m: n(x[8]),
                    aar_pct: n(x[9]),
                    area_km2: n(x[10]),
                  })),
                }
              : "not measured";
          }
          if (want("volume")) {
            const r = await fetchTextCached(FILES.volume, { ttlMs: glamos.cacheTtlSeconds * 1000, timeoutMs: 30_000, maxBytes: 20 * 1024 * 1024 });
            const p = parseGlamosCsv(r.data);
            if (p.citation) citations.push(p.citation);
            const rows = p.rows.filter((x) => x[0] === g.id);
            const d = (s: string | undefined) => (s ? `${s.slice(0, 4)}${/9999$/.test(s) ? "" : `-${s.slice(4, 6)}-${s.slice(6, 8)}`}` : undefined);
            out["volume_change"] = rows.length
              ? rows.slice(-last).map((x) => ({
                  from: d(x[3]),
                  to: d(x[4]),
                  area_start_km2: n(x[5]),
                  area_end_km2: n(x[7]),
                  volume_change_km3: n(x[9]),
                  mean_thickness_change_m: n(x[10]),
                  geodetic_balance_mwe_per_year: n(x[11]),
                }))
              : "not measured";
          }
          return respond(
            { ...out, citation: [...new Set(citations)], licence_note: "GLAMOS data: free for scientific and non-commercial use with citation." },
            { source: glamos, cacheStatus: listRes.cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "GLAMOS");
        }
      },
    }),
  ],
};
