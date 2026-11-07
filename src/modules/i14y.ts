/**
 * I14Y module — the Swiss federal interoperability platform (i14y.admin.ch),
 * run by the Federal Statistical Office: the national catalogue of
 * government datasets, data services and public services, plus the official
 * code lists and concepts (NOGA industry codes, legal forms, nationalities,
 * municipality numbers, eCH standards, health codes, …).
 *
 * Public API (no key): https://api.i14y.admin.ch/api/public/v1
 *   /search?query=&types=…      catalogue + concept search
 *   /concepts?conceptIdentifier= resolve a code list by its identifier
 *   /concepts/{id}/codelist-entries/search?query=&language=
 */

import { z } from "zod";
import { allowHosts, fetchJson, SourceError } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

allowHosts("api.i14y.admin.ch");

const i14y: SourceManifest = {
  id: "i14y",
  name: "I14Y — Swiss interoperability platform (federal data catalogue and code lists)",
  operator: "Federal Statistical Office (FSO/BFS), on behalf of the federal administration",
  url: "https://www.i14y.admin.ch",
  licence: "Metadata published openly by the respective public bodies; free to reuse with attribution",
  attribution: "Source: I14Y interoperability platform, i14y.admin.ch",
  updateFrequency: "continuous",
  cacheTtlSeconds: 24 * 3600,
  notes:
    "Public API v1. The catalogue describes datasets and services across federal, cantonal and municipal bodies — " +
    "including non-public ones (access rights are stated per entry); it is metadata, not the data itself.",
};

const BASE = "https://api.i14y.admin.ch/api/public/v1";
const LANGS = ["de", "fr", "it", "en"] as const;
const TYPES = ["Dataset", "DataService", "Concept", "PublicService", "MappingTable"] as const;

type Ml = Record<string, string | null | undefined> | null | undefined;
type Rec = Record<string, unknown>;

export function pick(v: Ml, lang: string): string | undefined {
  if (!v || typeof v !== "object") return undefined;
  for (const k of [lang, "en", "de", "fr", "it", "rm"]) {
    const s = v[k];
    if (typeof s === "string" && s.trim()) return s.trim();
  }
  return undefined;
}

const clip = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n)}…` : s);

export function mapSearchHit(x: Rec, lang: string) {
  const pub = x["publisher"] as Rec | undefined;
  const access = x["accessRights"] as Rec | undefined;
  return {
    id: x["id"],
    identifier: x["identifier"],
    type: x["type"],
    ...(x["conceptType"] ? { concept_type: x["conceptType"] } : {}),
    title: pick(x["title"] as Ml, lang),
    description: clip(pick(x["description"] as Ml, lang), 300),
    publisher: pick(pub?.["name"] as Ml, lang),
    ...(access ? { access: access["code"] } : {}),
    ...(x["version"] ? { version: x["version"] } : {}),
    status: x["registrationStatus"],
  };
}

export function mapCodeEntry(e: Rec, lang: string) {
  const ann = (e["annotations"] as Rec[] | undefined) ?? [];
  const abbrev = ann.find((a) => a["type"] === "ABBREV");
  const descr = ann.find((a) => a["type"] !== "ABBREV");
  return {
    code: e["code"],
    name: pick(e["name"] as Ml, lang),
    ...(abbrev ? { short_name: pick(abbrev["text"] as Ml, lang) } : {}),
    ...(descr ? { description: clip(pick(descr["text"] as Ml, lang), 400) } : {}),
    ...(e["parentCode"] ? { parent: e["parentCode"] } : {}),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve a code list given as UUID or identifier (e.g. 'NOGA_CLASS') to its concept id. */
async function resolveConcept(codelist: string): Promise<{ id: string; concept?: Rec }> {
  if (UUID.test(codelist)) return { id: codelist };
  const { data } = await fetchJson<{ data?: Rec[] }>(`${BASE}/concepts?conceptIdentifier=${encodeURIComponent(codelist)}`, {
    ttlMs: i14y.cacheTtlSeconds * 1000,
    timeoutMs: 20_000,
  });
  const list = (data.data ?? []).filter((c) => c["conceptType"] === "CodeList" || !c["conceptType"]);
  if (!list.length) throw new SourceError(`No code list with identifier '${codelist}'.`, "api.i14y.admin.ch", 404, "http");
  // Prefer the current standard, then the highest version.
  list.sort((a, b) => {
    const rank = (c: Rec) => (c["registrationStatus"] === "PreferredStandard" ? 2 : c["registrationStatus"] === "Standard" ? 1 : 0);
    return rank(b) - rank(a) || String(b["version"] ?? "").localeCompare(String(a["version"] ?? ""), undefined, { numeric: true });
  });
  return { id: String(list[0]!["id"]), concept: list[0] };
}

const langParam = z.enum(LANGS).default("en");

export const i14yModule: SwissyphusModule = {
  id: "i14y",
  emoji: "🗂️",
  title: "Federal data catalogue & code lists (I14Y)",
  description:
    "The Swiss federal interoperability platform: search the national catalogue of government datasets, data services and public services, and look up official code lists (NOGA industry codes, legal forms, countries, eCH and health codes, …)",
  sources: [i14y],
  healthProbes: [{ sourceId: "i14y", url: `${BASE}/concepts?conceptIdentifier=NOGA_CLASS` }],
  tools: [
    tool({
      name: "search_federal_metadata",
      title: "Search the federal data catalogue (I14Y)",
      description:
        "Search I14Y, the Swiss federal interoperability platform: datasets (incl. non-public registers, with their access rights), data services/APIs, public services and concepts/code lists from federal, cantonal and municipal bodies. " +
        "Use it to find which authority holds what data, or the identifier of an official code list. Example: {query: 'NOGA', types: ['Concept']}, {query: 'Gebäude', types: ['Dataset']}.",
      inputSchema: {
        query: z.string().min(2).max(200),
        types: z.array(z.enum(TYPES)).max(5).optional().describe("Restrict to Dataset, DataService, Concept (incl. code lists), PublicService, MappingTable"),
        lang: langParam,
        limit: z.number().int().min(1).max(50).default(15),
      },
      handler: async ({ query, types, lang, limit }) => {
        const qs = new URLSearchParams({ query, page: "1", pageSize: String(limit), language: lang });
        for (const t of types ?? []) qs.append("types", t);
        try {
          const { data, cacheStatus, retrievedAt } = await fetchJson<{ data?: Rec[] }>(`${BASE}/search?${qs}`, {
            ttlMs: 6 * 3600_000,
            timeoutMs: 20_000,
            maxBytes: 20 * 1024 * 1024,
          });
          const hits = (data.data ?? []).slice(0, limit).map((x) => mapSearchHit(x, lang));
          if (!hits.length) return toolError(`Nothing in I14Y matches '${query}'.`, ["Try a German or French term, or drop the type filter."]);
          return respond(
            { results: hits, hint: "For code lists (concept_type CodeList) use lookup_code_list {codelist: identifier}." },
            { source: i14y, cacheStatus, retrievedAt, language: lang },
          );
        } catch (err) {
          return errorToResult(err, "I14Y");
        }
      },
    }),
    tool({
      name: "lookup_code_list",
      title: "Look up an official code list (I14Y)",
      description:
        "Search the entries of an official Swiss code list on I14Y by code or text, e.g. NOGA industry classification ({codelist: 'NOGA_CLASS', query: 'bank'} or {codelist: 'NOGA_CLASS', query: '6419'}), " +
        "NOGA levels NOGA_SECTION/NOGA_DIVISION/NOGA_GROUP/NOGA_CLASS/NOGA_TYPE, or any code list found with search_federal_metadata (pass its identifier or id).",
      inputSchema: {
        codelist: z.string().min(2).max(100).describe("Code list identifier (e.g. 'NOGA_CLASS') or concept id (UUID)"),
        query: z.string().min(1).max(200).describe("Code or words to search for"),
        lang: langParam,
        limit: z.number().int().min(1).max(100).default(20),
      },
      handler: async ({ codelist, query, lang, limit }) => {
        try {
          const { id, concept } = await resolveConcept(codelist);
          const qs = new URLSearchParams({ query, language: lang === "en" ? "en" : lang, page: "1", pageSize: String(limit) });
          const { data, cacheStatus, retrievedAt } = await fetchJson<{ data?: Rec[] }>(`${BASE}/concepts/${id}/codelist-entries/search?${qs}`, {
            ttlMs: i14y.cacheTtlSeconds * 1000,
            timeoutMs: 20_000,
            maxBytes: 20 * 1024 * 1024,
          });
          const entries = (data.data ?? []).slice(0, limit).map((e) => mapCodeEntry(e, lang));
          if (!entries.length) return toolError(`No entry of ${codelist} matches '${query}'.`, ["Try a shorter term, the other language, or a code prefix."]);
          return respond(
            {
              codelist: {
                id,
                identifier: concept?.["identifier"] ?? (UUID.test(codelist) ? undefined : codelist),
                name: pick(concept?.["name"] as Ml, lang) ?? pick(concept?.["title"] as Ml, lang),
                version: concept?.["version"],
              },
              entries,
            },
            { source: i14y, cacheStatus, retrievedAt, language: lang },
          );
        } catch (err) {
          if (err instanceof SourceError && err.status === 404) {
            return toolError(err.message, ["Find the identifier with search_federal_metadata {query, types: ['Concept']}."]);
          }
          return errorToResult(err, "I14Y");
        }
      },
    }),
  ],
};
