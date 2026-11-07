/**
 * Local politics module — cantonal and municipal parliaments via
 * OpenParlData.ch (opendata.ch), which harmonises data from 70+ Swiss
 * parliaments: bodies (cantons, cities, municipalities), parliamentary
 * business (motions, postulates, interpellations, bills…), politicians.
 *
 * API: https://api.openparldata.ch/v1 (OpenAPI at /openapi.json), no key.
 * Collections accept `search`, `body_key` (canton code or BFS municipality
 * number), `sort_by` (prefix '-' for descending) and offset/limit paging.
 * `lang_format=flat` returns multilingual fields as title_de/title_fr/….
 */

import { z } from "zod";
import { allowHosts, fetchJson, SourceError } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

allowHosts("api.openparldata.ch");

const opd: SourceManifest = {
  id: "openparldata",
  name: "OpenParlData.ch — harmonised Swiss parliamentary data",
  operator: "opendata.ch (OpenParlData project); data from the cantonal and municipal parliaments",
  url: "https://openparldata.ch",
  licence: "CC BY 4.0 — attribute as \"Source: OpenParlData.ch\"",
  attribution: "Source: OpenParlData.ch",
  updateFrequency: "daily imports from the parliaments' websites and APIs",
  cacheTtlSeconds: 3600,
  notes:
    "Beta service: harmonisation (e.g. business states) is partial and coverage differs by parliament. " +
    "For the Federal Assembly prefer the parliament module (Curia Vista); this module covers cantonal and municipal parliaments.",
};

const BASE = "https://api.openparldata.ch/v1";
const LANGS = ["de", "fr", "it", "en"] as const;

type Rec = Record<string, unknown>;

/** Pick `${field}_${lang}` with fallbacks across languages (flat language format). */
export function flat(r: Rec, field: string, lang: string): string | undefined {
  for (const l of [lang, "de", "fr", "it", "rm", "en"]) {
    const v = r[`${field}_${l}`];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const v = r[field];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (v && typeof v === "object") {
    for (const l of [lang, "de", "fr", "it", "en"]) {
      const x = (v as Rec)[l];
      if (typeof x === "string" && x.trim()) return x.trim();
    }
  }
  return undefined;
}

const date = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 10) : undefined);

export function mapBody(b: Rec, lang: string) {
  return {
    body_key: b["body_key"],
    name: flat(b, "name", lang),
    type: b["type"],
    canton: b["canton_key"],
    has_parliament: b["has_parliament"] ?? undefined,
    parliament: flat(b, "legislative_name", lang),
    seats: b["legislative_seats"] ?? undefined,
    population: b["population"] ?? undefined,
  };
}

export function mapAffair(a: Rec, lang: string) {
  return {
    id: a["id"],
    body_key: a["body_key"],
    number: a["number"] ?? undefined,
    title: flat(a, "title", lang),
    type: flat(a, "type_harmonized", lang) ?? flat(a, "type_name", lang),
    state: flat(a, "state_name_harmonized", lang) ?? flat(a, "state_name", lang),
    submitted: date(a["begin_date"]),
    closed: date(a["end_date"]),
    url: flat(a, "url_external", lang),
  };
}

export function mapPerson(p: Rec, lang: string) {
  return {
    id: p["id"],
    body_key: p["body_key"],
    name: p["fullname"] ?? [p["firstname"], p["lastname"]].filter(Boolean).join(" "),
    party: flat(p, "party_harmonized", lang) ?? flat(p, "party", lang),
    electoral_district: flat(p, "electoral_district", lang),
    occupation: flat(p, "occupation", lang),
    url: flat(p, "website_parliament_url", lang),
  };
}

interface Page {
  meta?: { total_records?: number; has_more?: boolean; offset?: number };
  data?: Rec[];
}

async function list(path: string, params: Record<string, string | number | undefined>) {
  const qs = new URLSearchParams({ lang_format: "flat" });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
  return fetchJson<Page>(`${BASE}/${path}?${qs.toString()}`, { ttlMs: opd.cacheTtlSeconds * 1000, timeoutMs: 20_000 });
}

const bodyKey = z
  .string()
  .regex(/^[A-Za-z]{2}$|^\d{1,4}$/, "Canton code (ZH) or BFS municipality number (261)")
  .describe("Parliament: canton code ('ZH', 'VD') or BFS municipality number ('261' = City of Zürich); see search_local_parliaments");
const langParam = z.enum(LANGS).default("de");

export const localPoliticsModule: SwissyphusModule = {
  id: "localpolitics",
  emoji: "🏘️",
  title: "Cantonal & municipal parliaments (OpenParlData)",
  description:
    "Business and members of cantonal and municipal parliaments (70+ parliaments harmonised by OpenParlData.ch): motions, postulates, interpellations, bills and their status; politicians and parties",
  sources: [opd],
  healthProbes: [{ sourceId: "openparldata", url: `${BASE}/bodies/?limit=1` }],
  tools: [
    tool({
      name: "search_local_parliaments",
      title: "Find cantonal/municipal parliaments",
      description:
        "Find Swiss cantons, cities and municipalities in OpenParlData and whether their parliament is covered; returns the body_key used by the other local-politics tools. Example: {query: 'Winterthur'} or {canton: 'BE', with_parliament: true}.",
      inputSchema: {
        query: z.string().min(2).max(80).optional().describe("Name of a canton, city or municipality"),
        canton: z.string().regex(/^[A-Za-z]{2}$/).optional().describe("Only bodies in this canton"),
        type: z.enum(["canton", "city", "municipality"]).optional(),
        with_parliament: z.boolean().default(true).describe("Only bodies whose parliament data is covered"),
        lang: langParam,
        limit: z.number().int().min(1).max(100).default(25),
      },
      handler: async ({ query, canton, type, with_parliament, lang, limit }) => {
        try {
          const { data, cacheStatus, retrievedAt } = await list("bodies/", {
            search: query,
            canton_key: canton?.toUpperCase(),
            type,
            has_parliament: with_parliament ? "true" : undefined,
            limit: 200,
            sort_by: "-population",
          });
          let rows = (data.data ?? []).map((b) => mapBody(b, lang));
          if (canton) rows = rows.filter((b) => String(b.canton).toUpperCase() === canton.toUpperCase());
          if (type) rows = rows.filter((b) => b.type === type);
          if (with_parliament) rows = rows.filter((b) => b.has_parliament === true);
          if (!rows.length) {
            return toolError(`No ${with_parliament ? "covered " : ""}parliament found${query ? ` for '${query}'` : ""}.`, [
              with_parliament ? "Set with_parliament=false to list bodies without parliament data (most small municipalities hold assemblies instead)." : "Check the spelling.",
            ]);
          }
          return respond(
            { total: rows.length, bodies: rows.slice(0, limit) },
            { source: opd, cacheStatus, retrievedAt, language: lang },
          );
        } catch (err) {
          return errorToResult(err, "OpenParlData.ch");
        }
      },
    }),
    tool({
      name: "search_local_parliament_business",
      title: "Cantonal/municipal parliamentary business",
      description:
        "Search motions, postulates, interpellations, questions and bills in cantonal and municipal parliaments, newest first. Filter by parliament (body_key) and text. " +
        "Example: {query: 'Velo', body_key: 'ZH'} or {body_key: '261'} for the latest business of Zürich city parliament.",
      inputSchema: {
        query: z.string().min(2).max(200).optional().describe("Words in the title/metadata, e.g. 'Tempo 30', 'Wohnungsnot'"),
        body_key: bodyKey.optional(),
        full_text: z.boolean().default(false).describe("Also search in documents and texts (slower)"),
        lang: langParam,
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).max(10000).default(0),
      },
      handler: async ({ query, body_key, full_text, lang, limit, offset }) => {
        if (!query && !body_key) return toolError("Give a query or a body_key.", ["Example: {query: 'Velo', body_key: 'BS'}."]);
        try {
          const { data, cacheStatus, retrievedAt } = await list("affairs/", {
            search: query,
            body_key: body_key?.toUpperCase(),
            search_scope: query && full_text ? "metadata,docs,texts" : undefined,
            sort_by: "-begin_date",
            limit,
            offset,
          });
          const rows = (data.data ?? []).map((a) => mapAffair(a, lang));
          if (!rows.length) return toolError("No parliamentary business found.", ["Try German keywords, drop body_key, or set full_text=true."]);
          return respond(
            {
              total: data.meta?.total_records,
              offset,
              results: rows,
              ...(data.meta?.has_more ? { next_offset: offset + rows.length } : {}),
              hint: "get_local_parliament_business {id} for authors, documents and votes.",
            },
            { source: opd, cacheStatus, retrievedAt, language: lang },
          );
        } catch (err) {
          return errorToResult(err, "OpenParlData.ch");
        }
      },
    }),
    tool({
      name: "get_local_parliament_business",
      title: "Cantonal/municipal business details",
      description: "One item of cantonal/municipal parliamentary business by id: title, type, status, dates, authors (contributors), documents and votes where available.",
      inputSchema: {
        id: z.number().int().positive().describe("Business id from search_local_parliament_business"),
        lang: langParam,
      },
      handler: async ({ id, lang }) => {
        try {
          const [a, contributors, docs, votings] = await Promise.all([
            fetchJson<Rec>(`${BASE}/affairs/${id}?lang_format=flat`, { ttlMs: 3600_000, timeoutMs: 20_000 }),
            list(`affairs/${id}/contributors`, { limit: 30 }).catch(() => undefined),
            list(`affairs/${id}/docs`, { limit: 20 }).catch(() => undefined),
            list(`affairs/${id}/votings`, { limit: 10 }).catch(() => undefined),
          ]);
          const affair = ((a.data["data"] as Rec | undefined) ?? a.data) as Rec;
          return respond(
            {
              ...mapAffair(affair, lang),
              title_long: flat(affair, "title_long", lang),
              contributors: (contributors?.data.data ?? []).map((c) => ({
                name: c["fullname"] ?? flat(c, "name", lang),
                role: flat(c, "role_harmonized", lang) ?? flat(c, "role", lang),
                party: flat(c, "party", lang),
                person_id: c["person_id"] ?? undefined,
              })),
              documents: (docs?.data.data ?? []).map((d) => ({
                name: flat(d, "name", lang) ?? flat(d, "title", lang),
                date: date(d["date"]),
                url: d["url"] ?? flat(d, "url_external", lang),
              })),
              votings: (votings?.data.data ?? []).map((v) => ({
                date: date(v["date"]),
                title: flat(v, "title", lang),
                yes: v["results_yes"] ?? undefined,
                no: v["results_no"] ?? undefined,
                abstention: v["results_abstention"] ?? undefined,
              })),
            },
            { source: opd, cacheStatus: a.cacheStatus, retrievedAt: a.retrievedAt, language: lang },
          );
        } catch (err) {
          if (err instanceof SourceError && err.status === 404) return toolError(`No business with id ${id}.`);
          return errorToResult(err, "OpenParlData.ch");
        }
      },
    }),
    tool({
      name: "search_local_politicians",
      title: "Cantonal/municipal politicians",
      description:
        "Find members of cantonal and municipal parliaments by name, optionally in one parliament: party, electoral district, occupation. Example: {query: 'Meier', body_key: 'ZH'}.",
      inputSchema: {
        query: z.string().min(2).max(80).optional().describe("Name or part of it"),
        body_key: bodyKey.optional(),
        lang: langParam,
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).max(10000).default(0),
      },
      handler: async ({ query, body_key, lang, limit, offset }) => {
        if (!query && !body_key) return toolError("Give a name or a body_key.");
        try {
          const { data, cacheStatus, retrievedAt } = await list("persons/", {
            search: query,
            body_key: body_key?.toUpperCase(),
            limit,
            offset,
          });
          const rows = (data.data ?? []).map((p) => mapPerson(p, lang));
          if (!rows.length) return toolError("No politicians found.", ["Check the spelling or drop body_key."]);
          return respond(
            { total: data.meta?.total_records, results: rows, ...(data.meta?.has_more ? { next_offset: offset + rows.length } : {}) },
            { source: opd, cacheStatus, retrievedAt, language: lang },
          );
        } catch (err) {
          return errorToResult(err, "OpenParlData.ch");
        }
      },
    }),
  ],
};
