/**
 * Law module — Fedlex, the official publication platform for federal law,
 * queried via its public SPARQL endpoint.
 */

import { z } from "zod";
import { fetchJson } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";
import { swissDate } from "./_time.js";

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

type Binding = Record<string, { value?: string } | undefined>;

interface SparqlResponse {
  results?: {
    bindings?: Binding[];
  };
}

export function sanitizeLiteral(s: string): string {
  // Keep only characters valid inside a SPARQL string literal for a title
  // search: letters (incl. accented), digits, whitespace and light punctuation.
  // This drops the quote/backslash breakout chars and any control chars or
  // newlines that would otherwise produce an invalid literal.
  return s.replace(/[^\p{L}\p{N}\s.'-]/gu, " ").replace(/\s+/g, " ").trim();
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

/**
 * Type-safe "no longer in force by `today`" test. `jolux:dateNoLongerInForce`
 * is typed xsd:date; comparing it with NOW() (xsd:dateTime) is a type error in
 * strict SPARQL engines, so the FILTER silently evaluates to false. Instead we
 * compare the first 10 characters of its lexical form with today's Swiss date
 * (computed in JS), which behaves identically for xsd:date and xsd:dateTime.
 */
export function endedFilter(variable: string, today: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`invalid date literal '${today}'`);
  return `FILTER(SUBSTR(STR(${variable}), 1, 10) <= "${today}")`;
}

/**
 * Title/abbreviation search. `term` must already be sanitised + lower-cased.
 * Exact abbreviation matches rank first, then exact titles, then prefix
 * matches, then substring matches; ties by shorter title, then SR number.
 */
export function buildSearchSparql(opts: {
  term: string;
  langUri: string;
  inForceOnly: boolean;
  limit: number;
  today: string;
}): string {
  const q = opts.term;
  const inForce = opts.inForceOnly
    ? `FILTER NOT EXISTS { ?consoAbstract jolux:dateNoLongerInForce ?end . ${endedFilter("?end", opts.today)} }`
    : "";
  return `${PREFIXES}
SELECT ?consoAbstract ?sr ?titleStr ?abbrStr (MIN(?r) AS ?rank) WHERE {
  ?consoAbstract a jolux:ConsolidationAbstract .
  ?consoAbstract jolux:classifiedByTaxonomyEntry/skos:notation ?srNotation .
  FILTER(datatype(?srNotation) = <https://fedlex.data.admin.ch/vocabulary/notation-type/id-systematique>)
  ${inForce}
  ?consoAbstract jolux:isRealizedBy ?expr .
  ?expr jolux:language <${opts.langUri}> .
  ?expr jolux:title ?title .
  OPTIONAL { ?expr jolux:titleShort ?abbr }
  BIND(STR(?srNotation) AS ?sr)
  BIND(STR(?title) AS ?titleStr)
  BIND(STR(COALESCE(?abbr, "")) AS ?abbrStr)
  BIND(LCASE(?titleStr) AS ?lt)
  BIND(LCASE(?abbrStr) AS ?la)
  FILTER(CONTAINS(?lt, "${q}") || CONTAINS(?la, "${q}"))
  BIND(IF(?la = "${q}", 0, IF(?lt = "${q}", 1, IF(STRSTARTS(?la, "${q}"), 2, IF(STRSTARTS(?lt, "${q}"), 3, 4)))) AS ?r)
}
GROUP BY ?consoAbstract ?sr ?titleStr ?abbrStr
ORDER BY ?rank STRLEN(?titleStr) ?sr
LIMIT ${opts.limit}`;
}

export interface LawSearchHit {
  sr_number?: string;
  title?: string;
  abbreviation?: string;
  consoUri?: string;
  rank: number;
}

/** Map search bindings and re-apply the ranking client-side (stable, engine-independent). */
export function rankSearchResults(bindings: Binding[], term: string): LawSearchHit[] {
  const q = term.toLowerCase();
  const rankOf = (title: string, abbr: string): number => {
    const t = title.toLowerCase();
    const a = abbr.toLowerCase();
    if (a && a === q) return 0;
    if (t === q) return 1;
    if (a && a.startsWith(q)) return 2;
    if (t.startsWith(q)) return 3;
    return 4;
  };
  return bindings
    .map((b, i) => {
      const title = b["titleStr"]?.value ?? "";
      const abbr = b["abbrStr"]?.value ?? "";
      return {
        i,
        hit: {
          sr_number: b["sr"]?.value,
          title: title || undefined,
          abbreviation: abbr || undefined,
          consoUri: b["consoAbstract"]?.value,
          rank: rankOf(title, abbr),
        },
      };
    })
    .sort(
      (x, y) =>
        x.hit.rank - y.hit.rank || (x.hit.title ?? "").length - (y.hit.title ?? "").length || x.i - y.i,
    )
    .map((x) => x.hit);
}

export function buildSrSparql(sr: string): string {
  return `${PREFIXES}
SELECT DISTINCT ?consoAbstract ?langUri (STR(?title) AS ?titleStr) (STR(COALESCE(?abbr, "")) AS ?abbrStr) (STR(COALESCE(?noLonger, "")) AS ?endDate) (STR(COALESCE(?inForceFrom, "")) AS ?startDate) WHERE {
  ?consoAbstract a jolux:ConsolidationAbstract .
  ?consoAbstract jolux:classifiedByTaxonomyEntry/skos:notation ?srNotation .
  FILTER(datatype(?srNotation) = <https://fedlex.data.admin.ch/vocabulary/notation-type/id-systematique>)
  FILTER(STR(?srNotation) = "${sanitizeLiteral(sr)}")
  OPTIONAL { ?consoAbstract jolux:dateNoLongerInForce ?noLonger }
  OPTIONAL { ?consoAbstract jolux:dateEntryInForce ?inForceFrom }
  ?consoAbstract jolux:isRealizedBy ?expr .
  ?expr jolux:language ?langUri .
  ?expr jolux:title ?title .
  OPTIONAL { ?expr jolux:titleShort ?abbr }
}
ORDER BY ?consoAbstract ?langUri
LIMIT 200`;
}

export interface LawAct {
  consoUri: string;
  in_force: boolean;
  entry_into_force?: string;
  no_longer_in_force_from?: string;
  titles: Record<string, { title?: string; abbreviation?: string }>;
}

function langOf(uri?: string): string {
  return Object.entries(LANG_URIS).find(([, v]) => v === uri)?.[0] ?? uri ?? "?";
}

/**
 * Group SR-lookup bindings per ConsolidationAbstract. Several acts can share
 * an SR number (e.g. the repealed 1992 DSG and the current 2020 DSG are both
 * 235.1); titles and dates are NEVER merged across acts.
 *
 * Primary act: one in force on `today` (entered into force, and no
 * dateNoLongerInForce or one in the future), preferring acts with no end date
 * at all, then the latest entry into force. If none is in force (e.g. a
 * successor not yet in force and a repealed predecessor), acts without an end
 * date are still preferred, then the latest entry into force.
 */
export function selectActs(
  bindings: Binding[],
  today: string,
): { primary: LawAct; others: LawAct[] } | undefined {
  const acts = new Map<string, LawAct>();
  for (const b of bindings) {
    const uri = b["consoAbstract"]?.value;
    if (!uri) continue;
    let act = acts.get(uri);
    if (!act) {
      act = { consoUri: uri, in_force: true, titles: {} };
      acts.set(uri, act);
    }
    const end = (b["endDate"]?.value ?? "").slice(0, 10);
    const start = (b["startDate"]?.value ?? "").slice(0, 10);
    if (end && (!act.no_longer_in_force_from || end < act.no_longer_in_force_from)) {
      act.no_longer_in_force_from = end;
    }
    if (start && (!act.entry_into_force || start > act.entry_into_force)) act.entry_into_force = start;
    const lang = langOf(b["langUri"]?.value);
    if (!act.titles[lang]) {
      act.titles[lang] = {
        title: b["titleStr"]?.value,
        abbreviation: b["abbrStr"]?.value || undefined,
      };
    }
  }
  const list = [...acts.values()];
  if (!list.length) return undefined;
  for (const a of list) {
    const started = !a.entry_into_force || a.entry_into_force <= today;
    const notEnded = !a.no_longer_in_force_from || a.no_longer_in_force_from > today;
    a.in_force = started && notEnded;
  }
  const inForce = list.filter((a) => a.in_force);
  const pool = [...(inForce.length ? inForce : list)];
  pool.sort((a, b) => {
    const aEnded = a.no_longer_in_force_from ? 1 : 0;
    const bEnded = b.no_longer_in_force_from ? 1 : 0;
    if (aEnded !== bEnded) return aEnded - bEnded;
    const s = (b.entry_into_force ?? "").localeCompare(a.entry_into_force ?? "");
    if (s !== 0) return s;
    return (b.no_longer_in_force_from ?? "").localeCompare(a.no_longer_in_force_from ?? "");
  });
  const primary = pool[0]!;
  return { primary, others: list.filter((a) => a !== primary) };
}

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
        "Search the Swiss Classified Compilation (SR/RS) of federal law by title or abbreviation (e.g. 'data protection', 'OR', 'Datenschutz'). Exact abbreviation/title matches are ranked first. Returns SR number, title, abbreviation and the official Fedlex link. Search in the language of your query term (German titles for German terms, etc.).",
      inputSchema: {
        query: z.string().min(2).describe("Title keyword or abbreviation, e.g. 'Datenschutz', 'obligations', 'DSG'"),
        language: z.enum(["de", "fr", "it", "rm", "en"]).default("de").describe("Language of titles to search"),
        in_force_only: z.boolean().default(true),
        limit: z.number().int().min(1).max(50).default(15),
      },
      handler: async ({ query, language, in_force_only, limit }) => {
        try {
          const langUri = LANG_URIS[language] ?? LANG_URIS["de"]!;
          const q = sanitizeLiteral(query).toLowerCase();
          if (q.length < 2) {
            return toolError(`The search term '${query}' contains no searchable letters or digits.`, [
              "Use a title keyword or abbreviation, e.g. 'Datenschutz' or 'DSG'.",
            ]);
          }
          const sparql = buildSearchSparql({
            term: q,
            langUri,
            inForceOnly: in_force_only,
            limit,
            today: swissDate(),
          });
          const { data, cacheStatus, retrievedAt } = await runSparql(sparql);
          const results = rankSearchResults(data.results?.bindings ?? [], q).map((h) => ({
            sr_number: h.sr_number,
            title: h.title,
            abbreviation: h.abbreviation,
            exact_match: h.rank <= 1,
            fedlex_url: webUrl(h.consoUri, language),
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
        "Look up one act of the Classified Compilation by its SR number (e.g. '220' Code of Obligations, '235.1' Data Protection Act). Returns titles in all official languages, in-force status and Fedlex links for the act currently in force; other acts sharing the SR number (e.g. repealed predecessors) are listed separately under other_acts.",
      inputSchema: {
        sr_number: z.string().regex(/^[\d.]+$/).describe("SR number, e.g. '220', '235.1', '101'"),
      },
      handler: async ({ sr_number }) => {
        try {
          const { data, cacheStatus, retrievedAt } = await runSparql(buildSrSparql(sr_number));
          const selection = selectActs(data.results?.bindings ?? [], swissDate());
          if (!selection) {
            return toolError(`No legislation found with SR number '${sr_number}'.`, [
              "Check the number on fedlex.admin.ch; sub-acts use dotted numbers like '235.11'.",
            ]);
          }
          const { primary, others } = selection;
          const linksFor = (act: LawAct) =>
            Object.fromEntries(Object.keys(act.titles).map((l) => [`fedlex_${l}`, webUrl(act.consoUri, l) ?? ""]));
          const titleFor = (act: LawAct) =>
            act.titles["de"]?.title ?? act.titles["en"]?.title ?? Object.values(act.titles)[0]?.title;
          return respond(
            {
              sr_number,
              in_force: primary.in_force,
              ...(primary.entry_into_force ? { entry_into_force: primary.entry_into_force } : {}),
              ...(primary.no_longer_in_force_from
                ? { no_longer_in_force_from: primary.no_longer_in_force_from }
                : {}),
              titles: primary.titles,
              links: linksFor(primary),
              ...(others.length
                ? {
                    other_acts: others.map((a) => ({
                      title: titleFor(a),
                      in_force: a.in_force,
                      ...(a.entry_into_force ? { entry_into_force: a.entry_into_force } : {}),
                      ...(a.no_longer_in_force_from ? { no_longer_in_force_from: a.no_longer_in_force_from } : {}),
                      fedlex_url: webUrl(a.consoUri, "de"),
                    })),
                    other_acts_note:
                      "Other acts classified under the same SR number (e.g. repealed predecessors). The top-level fields describe the primary act only.",
                  }
                : {}),
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
