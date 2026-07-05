/**
 * Law module — Fedlex, the official publication platform for federal law,
 * queried via its public SPARQL endpoint.
 */

import { z } from "zod";
import { fetchJson } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

const fedlex: SourceManifest = {
  id: "fedlex",
  name: "Fedlex — Classified Compilation of Federal Legislation",
  operator: "Federal Chancellery",
  url: "https://www.fedlex.admin.ch",
  licence: "Official legal texts, public domain (Art. 5 CopA); attribution appreciated",
  attribution: "© Federal Chancellery, Fedlex",
  updateFrequency: "continuous consolidation",
  cacheTtlSeconds: 12 * 3600,
};

const ENDPOINT = "https://fedlex.data.admin.ch/sparqlendpoint";

const LANG_URIS: Record<string, string> = {
  de: "http://publications.europa.eu/resource/authority/language/DEU",
  fr: "http://publications.europa.eu/resource/authority/language/FRA",
  it: "http://publications.europa.eu/resource/authority/language/ITA",
  rm: "http://publications.europa.eu/resource/authority/language/ROH",
  en: "http://publications.europa.eu/resource/authority/language/ENG",
};

interface SparqlResponse {
  results?: {
    bindings?: Array<Record<string, { value?: string }>>;
  };
}

function sanitizeLiteral(s: string): string {
  return s.replace(/[\\"]/g, " ").trim();
}

async function runSparql(query: string) {
  const url = `${ENDPOINT}?query=${encodeURIComponent(query)}`;
  return fetchJson<SparqlResponse>(url, {
    ttlMs: fedlex.cacheTtlSeconds * 1000,
    timeoutMs: 30_000,
    init: { headers: { Accept: "application/sparql-results+json" } },
  });
}

function webUrl(dataUri: string | undefined, lang: string): string | undefined {
  if (!dataUri) return undefined;
  return dataUri.replace("https://fedlex.data.admin.ch/eli/", "https://www.fedlex.admin.ch/eli/") + `/${lang}`;
}

const PREFIXES = `
PREFIX jolux: <http://data.legilux.public.lu/resource/ontology/jolux#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
`;

export const lawModule: SwissyphusModule = {
  id: "law",
  emoji: "⚖️",
  title: "Federal law (Fedlex)",
  description: "Search the Classified Compilation of federal legislation; SR-number lookup with in-force status",
  sources: [fedlex],
  healthProbes: [
    {
      sourceId: "fedlex",
      url: `${ENDPOINT}?query=${encodeURIComponent("SELECT ?s WHERE {?s ?p ?o} LIMIT 1")}`,
      headers: { Accept: "application/sparql-results+json" },
    },
  ],
  tools: [
    tool({
      name: "search_federal_law",
      title: "Search federal legislation",
      description:
        "Search the Swiss Classified Compilation (SR/RS) of federal law by title or abbreviation (e.g. 'data protection', 'OR', 'Datenschutz'). Returns SR number, title, abbreviation and the official Fedlex link. Search in the language of your query term (German titles for German terms, etc.).",
      inputSchema: {
        query: z.string().min(2).describe("Title keyword or abbreviation, e.g. 'Datenschutz', 'obligations', 'DSG'"),
        language: z.enum(["de", "fr", "it", "rm", "en"]).default("de").describe("Language of titles to search"),
        in_force_only: z.boolean().default(true),
        limit: z.number().int().min(1).max(50).default(15),
      },
      handler: async ({ query, language, in_force_only, limit }) => {
        try {
          const langUri = LANG_URIS[language] ?? LANG_URIS["de"];
          const q = sanitizeLiteral(query).toLowerCase();
          const sparql = `${PREFIXES}
SELECT DISTINCT ?consoAbstract (STR(?srNotation) AS ?sr) (STR(?title) AS ?titleStr) (STR(COALESCE(?abbr, "")) AS ?abbrStr) WHERE {
  ?consoAbstract a jolux:ConsolidationAbstract .
  ?consoAbstract jolux:classifiedByTaxonomyEntry/skos:notation ?srNotation .
  FILTER(datatype(?srNotation) = <https://fedlex.data.admin.ch/vocabulary/notation-type/id-systematique>)
  ${in_force_only ? "FILTER NOT EXISTS { ?consoAbstract jolux:dateNoLongerInForce ?end . FILTER(?end <= NOW()) }" : ""}
  ?consoAbstract jolux:isRealizedBy ?expr .
  ?expr jolux:language <${langUri}> .
  ?expr jolux:title ?title .
  OPTIONAL { ?expr jolux:titleShort ?abbr }
  FILTER(CONTAINS(LCASE(?title), "${q}") || CONTAINS(LCASE(COALESCE(?abbr, "")), "${q}"))
}
LIMIT ${limit}`;
          const { data, cacheStatus, retrievedAt } = await runSparql(sparql);
          const results = (data.results?.bindings ?? []).map((b) => ({
            sr_number: b["sr"]?.value,
            title: b["titleStr"]?.value,
            abbreviation: b["abbrStr"]?.value || undefined,
            fedlex_url: webUrl(b["consoAbstract"]?.value, language),
          }));
          if (!results.length) {
            return toolError(`No federal legislation found for '${query}' in ${language}.`, [
              "Titles are language-specific: search German terms with language='de', French with 'fr'.",
              "Try the official abbreviation (e.g. 'OR', 'ZGB', 'DSG').",
            ]);
          }
          return respond({ results }, { source: fedlex, cacheStatus, retrievedAt, language });
        } catch (err) {
          return errorToResult(err, "Fedlex SPARQL endpoint");
        }
      },
    }),

    tool({
      name: "get_law_by_sr",
      title: "Get legislation by SR number",
      description:
        "Look up one act of the Classified Compilation by its SR number (e.g. '220' Code of Obligations, '235.1' Data Protection Act). Returns titles in all official languages, in-force status and Fedlex links.",
      inputSchema: {
        sr_number: z.string().regex(/^[\d.]+$/).describe("SR number, e.g. '220', '235.1', '101'"),
      },
      handler: async ({ sr_number }) => {
        try {
          const sparql = `${PREFIXES}
SELECT DISTINCT ?consoAbstract ?langUri (STR(?title) AS ?titleStr) (STR(COALESCE(?abbr, "")) AS ?abbrStr) (STR(COALESCE(?noLonger, "")) AS ?endDate) WHERE {
  ?consoAbstract a jolux:ConsolidationAbstract .
  ?consoAbstract jolux:classifiedByTaxonomyEntry/skos:notation ?srNotation .
  FILTER(datatype(?srNotation) = <https://fedlex.data.admin.ch/vocabulary/notation-type/id-systematique>)
  FILTER(STR(?srNotation) = "${sanitizeLiteral(sr_number)}")
  OPTIONAL { ?consoAbstract jolux:dateNoLongerInForce ?noLonger }
  ?consoAbstract jolux:isRealizedBy ?expr .
  ?expr jolux:language ?langUri .
  ?expr jolux:title ?title .
  OPTIONAL { ?expr jolux:titleShort ?abbr }
}
LIMIT 20`;
          const { data, cacheStatus, retrievedAt } = await runSparql(sparql);
          const bindings = data.results?.bindings ?? [];
          if (!bindings.length) {
            return toolError(`No legislation found with SR number '${sr_number}'.`, [
              "Check the number on fedlex.admin.ch; sub-acts use dotted numbers like '235.11'.",
            ]);
          }
          const langOf = (uri?: string) =>
            Object.entries(LANG_URIS).find(([, v]) => v === uri)?.[0] ?? uri ?? "?";
          const titles: Record<string, { title?: string; abbreviation?: string }> = {};
          let endDate = "";
          let consoUri: string | undefined;
          for (const b of bindings) {
            const lang = langOf(b["langUri"]?.value);
            titles[lang] = {
              title: b["titleStr"]?.value,
              abbreviation: b["abbrStr"]?.value || undefined,
            };
            endDate = b["endDate"]?.value ?? "";
            consoUri = b["consoAbstract"]?.value ?? consoUri;
          }
          const inForce = !endDate || new Date(endDate) > new Date();
          return respond(
            {
              sr_number,
              in_force: inForce,
              ...(endDate ? { no_longer_in_force_from: endDate } : {}),
              titles,
              links: Object.fromEntries(
                Object.keys(titles).map((l) => [`fedlex_${l}`, webUrl(consoUri, l) ?? ""]),
              ),
            },
            { source: fedlex, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "Fedlex SPARQL endpoint");
        }
      },
    }),
  ],
};
