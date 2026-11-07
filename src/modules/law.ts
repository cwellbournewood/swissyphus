/**
 * Law module — Fedlex, the official publication platform for federal law,
 * queried via its public SPARQL endpoint (JOLux ontology).
 *
 * Covers the Classified Compilation (SR), international treaties (SR 0.*),
 * consolidation changes / entries into force / repeals, and the Federal
 * Gazette (BBl).
 */

import { z } from "zod";
import { allowHosts, fetchJson } from "../core/http.js";
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
  notes:
    "Queried via the public Fedlex SPARQL endpoint (JOLux). Treaties are the international part of the Classified Compilation (SR numbers starting '0.'), i.e. treaties binding Switzerland. Change tracking relies on jolux:dateApplicability of consolidations (isMemberOf the ConsolidationAbstract), jolux:dateEntryInForce and jolux:dateNoLongerInForce; date comparisons are lexical on the ISO date string. Consultations (Vernehmlassungen) are not covered.",
};

const fedlexGazette: SourceManifest = {
  id: "fedlex-fga",
  name: "Fedlex — Federal Gazette (Bundesblatt / Feuille fédérale / Foglio federale)",
  operator: "Federal Chancellery",
  url: "https://www.fedlex.admin.ch/de/fga",
  licence: "Official publications, public domain (Art. 5 CopA); attribution appreciated",
  attribution: "© Federal Chancellery, Fedlex",
  updateFrequency: "daily (BBl publishes on working days)",
  cacheTtlSeconds: 3600,
  notes:
    "Federal Gazette items are selected as Fedlex resources whose ELI starts with https://fedlex.data.admin.ch/eli/fga/ and that carry jolux:publicationDate, with titles from their jolux:isRealizedBy expressions. This selection pattern is best-knowledge and not verified live; the scan is bounded by a date range and LIMIT.",
};

allowHosts("fedlex.data.admin.ch");

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

async function runSparql(query: string, ttlSeconds = fedlex.cacheTtlSeconds, timeoutMs = 30_000) {
  const url = `${ENDPOINT}?query=${encodeURIComponent(query)}`;
  return fetchJson<SparqlResponse>(url, {
    ttlMs: ttlSeconds * 1000,
    timeoutMs,
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
const SR_NOTATION_TYPE = "https://fedlex.data.admin.ch/vocabulary/notation-type/id-systematique";

/** Validate/normalise a SR-number prefix ('0.', '0.142', '2', '7'); undefined if unsafe. */
export function safeSrPrefix(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const t = p.trim();
  return /^\d+(\.\d*)*$/.test(t) ? t : undefined;
}

/** Validate an ISO date (YYYY-MM-DD) for interpolation into SPARQL; undefined otherwise. */
export function safeIsoDate(d: string | undefined): string | undefined {
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined;
}

function langUriOf(language: string): string {
  return LANG_URIS[language] ?? LANG_URIS["de"];
}

/** Title-keyword FILTER on ?title (and optionally ?abbr), or empty when no keyword. */
function keywordFilter(query: string | undefined, withAbbr: boolean): string {
  const q = query ? sanitizeLiteral(query).toLowerCase() : "";
  if (!q) return "";
  return withAbbr
    ? `FILTER(CONTAINS(LCASE(STR(?title)), "${q}") || CONTAINS(LCASE(STR(COALESCE(?abbr, ""))), "${q}"))`
    : `FILTER(CONTAINS(LCASE(STR(?title)), "${q}"))`;
}

/**
 * International treaties binding Switzerland = the international part of the
 * Classified Compilation, whose SR numbers start with '0.'.
 */
export function buildTreatyQuery(opts: {
  query?: string;
  srPrefix?: string;
  language: string;
  inForceOnly: boolean;
  limit: number;
}): string {
  const prefix = safeSrPrefix(opts.srPrefix);
  const srFilter = prefix && prefix.startsWith("0.") ? prefix : "0.";
  return `${PREFIXES}
SELECT DISTINCT ?consoAbstract (STR(?srNotation) AS ?sr) (STR(?title) AS ?titleStr) (STR(COALESCE(?abbr, "")) AS ?abbrStr) (STR(COALESCE(?eif, "")) AS ?entryInForce) (STR(COALESCE(?noLonger, "")) AS ?endDate) WHERE {
  ?consoAbstract a jolux:ConsolidationAbstract .
  ?consoAbstract jolux:classifiedByTaxonomyEntry/skos:notation ?srNotation .
  FILTER(datatype(?srNotation) = <${SR_NOTATION_TYPE}>)
  FILTER(STRSTARTS(STR(?srNotation), "${srFilter}"))
  OPTIONAL { ?consoAbstract jolux:dateNoLongerInForce ?noLonger }
  ${opts.inForceOnly ? "FILTER NOT EXISTS { ?consoAbstract jolux:dateNoLongerInForce ?end . FILTER(?end <= NOW()) }" : ""}
  OPTIONAL { ?consoAbstract jolux:dateEntryInForce ?eif }
  ?consoAbstract jolux:isRealizedBy ?expr .
  ?expr jolux:language <${langUriOf(opts.language)}> .
  ?expr jolux:title ?title .
  OPTIONAL { ?expr jolux:titleShort ?abbr }
  ${keywordFilter(opts.query, true)}
}
LIMIT ${Math.max(1, Math.min(100, Math.trunc(opts.limit)))}`;
}

export type ChangeKind = "amended" | "entered_into_force" | "repealed";

/**
 * Acts of the Classified Compilation with a change dated in [from, to]:
 *  - amended: a new consolidated version became applicable (jolux:dateApplicability
 *    of a consolidation that isMemberOf the act) — also includes a new act's first version;
 *  - entered_into_force: the act itself entered into force (jolux:dateEntryInForce);
 *  - repealed: the act ceased to be in force (jolux:dateNoLongerInForce).
 */
export function buildChangesQuery(opts: {
  kind: ChangeKind;
  from: string;
  to: string;
  language: string;
  srPrefix?: string;
  query?: string;
  limit: number;
}): string {
  const from = safeIsoDate(opts.from);
  const to = safeIsoDate(opts.to);
  if (!from || !to) throw new Error("from/to must be YYYY-MM-DD");
  const pattern =
    opts.kind === "amended"
      ? "?conso jolux:isMemberOf ?consoAbstract .\n  ?conso jolux:dateApplicability ?d ."
      : opts.kind === "entered_into_force"
        ? "?consoAbstract jolux:dateEntryInForce ?d ."
        : "?consoAbstract jolux:dateNoLongerInForce ?d .";
  const prefix = safeSrPrefix(opts.srPrefix);
  return `${PREFIXES}
SELECT DISTINCT ?consoAbstract (STR(?srNotation) AS ?sr) (STR(?title) AS ?titleStr) (SUBSTR(STR(?d), 1, 10) AS ?date) WHERE {
  ${pattern}
  FILTER(SUBSTR(STR(?d), 1, 10) >= "${from}" && SUBSTR(STR(?d), 1, 10) <= "${to}")
  ?consoAbstract a jolux:ConsolidationAbstract .
  ?consoAbstract jolux:classifiedByTaxonomyEntry/skos:notation ?srNotation .
  FILTER(datatype(?srNotation) = <${SR_NOTATION_TYPE}>)
  ${prefix ? `FILTER(STRSTARTS(STR(?srNotation), "${prefix}"))` : ""}
  ?consoAbstract jolux:isRealizedBy ?expr .
  ?expr jolux:language <${langUriOf(opts.language)}> .
  ?expr jolux:title ?title .
  ${keywordFilter(opts.query, false)}
}
ORDER BY DESC(?date) ?sr
LIMIT ${Math.max(1, Math.min(100, Math.trunc(opts.limit)))}`;
}

/** Federal Gazette (BBl/FF/FF) items: ELI under eli/fga/, by publication date and optional title keyword. */
export function buildGazetteQuery(opts: {
  from: string;
  to: string;
  language: string;
  query?: string;
  limit: number;
}): string {
  const from = safeIsoDate(opts.from);
  const to = safeIsoDate(opts.to);
  if (!from || !to) throw new Error("from/to must be YYYY-MM-DD");
  return `${PREFIXES}
SELECT DISTINCT ?act (SUBSTR(STR(?pub), 1, 10) AS ?date) (STR(?title) AS ?titleStr) WHERE {
  ?act jolux:publicationDate ?pub .
  FILTER(STRSTARTS(STR(?act), "https://fedlex.data.admin.ch/eli/fga/"))
  FILTER(SUBSTR(STR(?pub), 1, 10) >= "${from}" && SUBSTR(STR(?pub), 1, 10) <= "${to}")
  ?act jolux:isRealizedBy ?expr .
  ?expr jolux:language <${langUriOf(opts.language)}> .
  ?expr jolux:title ?title .
  ${keywordFilter(opts.query, false)}
}
ORDER BY DESC(?date)
LIMIT ${Math.max(1, Math.min(100, Math.trunc(opts.limit)))}`;
}

/** Parse the BBl reference ('BBl 2023 2345') from an eli/fga URI. */
export function gazetteReference(uri: string | undefined, language: string): string | undefined {
  const m = uri?.match(/\/eli\/fga\/(\d{4})\/([\w-]+)$/);
  if (!m) return undefined;
  const abbr = language === "fr" ? "FF" : language === "it" ? "FF" : "BBl";
  return `${abbr} ${m[1]} ${m[2]}`;
}


/** Collapse SPARQL bindings to one row per key, keeping the first binding (dedupe OPTIONAL fan-out). */
export function uniqueBy(bindings: Binding[], key: string): Binding[] {
  const seen = new Set<string>();
  const out: Binding[] = [];
  for (const b of bindings) {
    const k = b[key]?.value;
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(b);
  }
  return out;
}

/**
 * Order SR numbers the way the Classified Compilation does. SR numbering is a
 * decimal classification, so '0.142.111' < '0.142.2' and '220' < '3': a plain
 * code-unit comparison is exactly right ('.' sorts before digits).
 */
export function compareSr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function todayIso(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/** Shift a YYYY-MM-DD date by whole days. */
function shiftIso(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Widest date range the Fedlex date-range tools accept (≈ 2 years). */
const MAX_SPAN_DAYS = 366 * 2;

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");


const CONSULTATION_STATUS: Record<string, string[]> = {
  planned: ["0", "1"],
  ongoing: ["2"],
  closed: ["3", "4", "5"],
  withdrawn: ["6"],
};

/** SPARQL for federal consultations (Vernehmlassungen); user text is sanitised and lower-cased. */
export function buildConsultationQuery(opts: { query?: string; status?: string; language: string; limit: number }): string {
  const lang = ["de", "fr", "it"].includes(opts.language) ? opts.language : "de";
  const q = opts.query ? sanitizeLiteral(opts.query).toLowerCase() : "";
  const codes = opts.status && opts.status !== "all" ? CONSULTATION_STATUS[opts.status] ?? [] : [];
  const statusFilter = codes.length
    ? `FILTER(?st IN (${codes.map((c) => `<https://fedlex.data.admin.ch/vocabulary/consultation-status/${c}>`).join(", ")}))`
    : "";
  return `${PREFIXES}
SELECT ?c ?title ?status ?start ?end ?office (SAMPLE(?d) AS ?desc) WHERE {
  ?c a jolux:Consultation ; jolux:eventTitle ?title ; jolux:consultationStatus ?st .
  FILTER(lang(?title) = "${lang}")
  ${statusFilter}
  ?st skos:prefLabel ?status . FILTER(lang(?status) = "${lang}")
  OPTIONAL { ?c jolux:eventDescription ?d . FILTER(lang(?d) = "${lang}") }
  OPTIONAL { ?c jolux:hasSubTask ?t . ?t jolux:foreseenEventStartDate ?start .
             OPTIONAL { ?t jolux:foreseenEventEndDate ?end }
             OPTIONAL { ?t jolux:institutionInChargeOfTheEventLevel2 ?inst . ?inst skos:prefLabel ?office . FILTER(lang(?office) = "${lang}") } }
  ${q ? `FILTER(CONTAINS(LCASE(STR(?title)), "${q}") || CONTAINS(LCASE(STR(?d)), "${q}"))` : ""}
} GROUP BY ?c ?title ?status ?start ?end ?office ORDER BY DESC(?start) LIMIT ${Math.min(Math.max(opts.limit, 1), 50)}`;
}

export const lawModule: SwissyphusModule = {
  id: "law",
  emoji: "⚖️",
  title: "Federal law (Fedlex)",
  description:
    "Search the Classified Compilation of federal legislation and international treaties; SR-number lookup with in-force status; recent amendments, entries into force and repeals; Federal Gazette (BBl) publications",
  sources: [fedlex, fedlexGazette],
  healthProbes: [
    {
      sourceId: "fedlex",
      url: `${ENDPOINT}?query=${encodeURIComponent("SELECT ?s WHERE {?s ?p ?o} LIMIT 1")}`,
      headers: { Accept: "application/sparql-results+json" },
    },
    {
      sourceId: "fedlex-fga",
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
    tool({
      name: "search_international_treaties",
      title: "Search international treaties",
      description:
        "Search international treaties and agreements binding Switzerland (the international part of the Classified Compilation, SR numbers starting '0.': bilateral agreements with the EU, double-taxation agreements, conventions, UN/Council of Europe treaties) by title keyword and/or SR area. Returns SR number, title, short title, entry-into-force date, in-force status and the Fedlex link. Titles are language-specific: {query:'Doppelbesteuerung'} (de), {query:'double imposition', language:'fr'}, {query:'Freizügigkeit'}, {sr_prefix:'0.142.11'} (EU free movement area).",
      inputSchema: {
        query: z.string().min(2).optional().describe("Title keyword in the chosen language, e.g. 'Doppelbesteuerung', 'Deutschland', 'Menschenrechte'"),
        sr_prefix: z
          .string()
          .regex(/^0\.[\d.]*$/)
          .optional()
          .describe("Restrict to an SR area of international law, e.g. '0.1' (international law), '0.672' (double taxation)"),
        language: z.enum(["de", "fr", "it", "rm", "en"]).default("de").describe("Language of titles to search"),
        in_force_only: z.boolean().default(true),
        limit: z.number().int().min(1).max(50).default(15),
      },
      handler: async ({ query, sr_prefix, language, in_force_only, limit }) => {
        if (!query && !sr_prefix) {
          return toolError("Give a title 'query' and/or an 'sr_prefix' (e.g. '0.672').", [
            "Example: {query:'Doppelbesteuerung'} or {sr_prefix:'0.142.11'}",
          ]);
        }
        try {
          const sparql = buildTreatyQuery({ query, srPrefix: sr_prefix, language, inForceOnly: in_force_only, limit });
          const { data, cacheStatus, retrievedAt } = await runSparql(sparql);
          const results = uniqueBy(data.results?.bindings ?? [], "consoAbstract")
            .map((b) => {
              const end = b["endDate"]?.value || undefined;
              return {
                sr_number: b["sr"]?.value,
                title: b["titleStr"]?.value,
                abbreviation: b["abbrStr"]?.value || undefined,
                entry_into_force: b["entryInForce"]?.value?.slice(0, 10) || undefined,
                in_force: !end || new Date(end) > new Date(),
                ...(end ? { no_longer_in_force_from: end.slice(0, 10) } : {}),
                fedlex_url: webUrl(b["consoAbstract"]?.value, language),
              };
            })
            .sort((a, b) => compareSr(a.sr_number ?? "", b.sr_number ?? ""));
          if (!results.length) {
            return toolError(`No treaties found for ${query ? `'${query}'` : `SR ${sr_prefix}`} in ${language}.`, [
              "Titles are language-specific: use German terms with language='de', French with 'fr'.",
              "Try a country name ('Deutschland', 'Italie') or set in_force_only=false.",
            ]);
          }
          return respond({ count: results.length, results }, { source: fedlex, cacheStatus, retrievedAt, language });
        } catch (err) {
          return errorToResult(err, "Fedlex SPARQL endpoint");
        }
      },
    }),

    tool({
      name: "list_recent_legislation_changes",
      title: "Recent changes to federal legislation",
      description:
        "What changed in Swiss federal law in a date range (Classified Compilation): 'amended' = acts for which a new consolidated version became applicable (amendments taking effect, incl. new acts), 'entered_into_force' = acts that entered into force, 'repealed' = acts that ceased to be in force. Returns date, SR number, title and Fedlex link, newest first. Dates may lie in the future to see scheduled changes. Examples: {} (amendments in the last 30 days); {change:'entered_into_force', date_from:'2025-01-01', date_to:'2025-01-31'}; {sr_prefix:'8', query:'Kranken'} (health law).",
      inputSchema: {
        change: z.enum(["amended", "entered_into_force", "repealed"]).default("amended"),
        date_from: DATE.optional().describe("Start date YYYY-MM-DD (default: 30 days ago)"),
        date_to: DATE.optional().describe("End date YYYY-MM-DD (default: today)"),
        sr_prefix: z
          .string()
          .regex(/^\d+(\.\d*)*$/)
          .optional()
          .describe("Restrict to an SR area, e.g. '2' (private law), '6' (finance/tax), '8' (health/labour), '0.' (treaties)"),
        query: z.string().min(2).optional().describe("Optional title keyword in the chosen language"),
        language: z.enum(["de", "fr", "it", "rm", "en"]).default("de"),
        limit: z.number().int().min(1).max(100).default(30),
      },
      handler: async ({ change, date_from, date_to, sr_prefix, query, language, limit }) => {
        const to = date_to ?? todayIso();
        const from = date_from ?? todayIso(-30);
        if (from > to) return toolError("date_from must be on or before date_to.");
        const spanDays = (Date.parse(to) - Date.parse(from)) / 86_400_000;
        if (spanDays > MAX_SPAN_DAYS) {
          return toolError("Date range too wide (max 2 years).", ["Narrow the range or add sr_prefix/query."]);
        }
        try {
          const sparql = buildChangesQuery({ kind: change, from, to, language, srPrefix: sr_prefix, query, limit });
          const { data, cacheStatus, retrievedAt } = await runSparql(sparql, 3600, 45_000);
          const seen = new Set<string>();
          const changes = (data.results?.bindings ?? [])
            .filter((b) => {
              const k = `${b["consoAbstract"]?.value}|${b["date"]?.value}`;
              if (seen.has(k)) return false;
              seen.add(k);
              return true;
            })
            .map((b) => ({
              date: b["date"]?.value,
              sr_number: b["sr"]?.value,
              title: b["titleStr"]?.value,
              fedlex_url: webUrl(b["consoAbstract"]?.value, language),
            }));
          return respond(
            { change, date_from: from, date_to: to, count: changes.length, changes },
            {
              source: fedlex,
              cacheStatus,
              retrievedAt,
              language,
              ...(changes.length ? {} : { notes: "No matching changes in this range; try a wider range or another change type." }),
            },
          );
        } catch (err) {
          return errorToResult(err, "Fedlex SPARQL endpoint");
        }
      },
    }),

    tool({
      name: "search_consultations",
      title: "Federal consultations (Vernehmlassungen)",
      description:
        "Federal consultation procedures (Vernehmlassungen / consultations / consultazioni) on draft laws and ordinances from Fedlex: title, description, status (planned, ongoing, closed, withdrawn), consultation period and lead federal office, newest first. " +
        "Use it to see what legislation the Federal Council is preparing and until when stakeholders can respond. Example: {query: 'Energie', status: 'ongoing'}.",
      inputSchema: {
        query: z.string().min(2).max(120).optional().describe("Word in title or description (in the chosen language)"),
        status: z.enum(["all", "planned", "ongoing", "closed", "withdrawn"]).default("all"),
        language: z.enum(["de", "fr", "it"]).default("de"),
        limit: z.number().int().min(1).max(50).default(15),
      },
      handler: async ({ query, status, language, limit }) => {
        try {
          const { data, cacheStatus, retrievedAt } = await runSparql(buildConsultationQuery({ query, status, language, limit }), 3600, 45_000);
          const results = (data.results?.bindings ?? []).map((b) => ({
            title: b["title"]?.value,
            status: b["status"]?.value,
            period: b["start"]?.value ? { from: b["start"]?.value, until: b["end"]?.value } : undefined,
            lead_office: b["office"]?.value,
            description: b["desc"]?.value && b["desc"].value.length > 500 ? `${b["desc"].value.slice(0, 500)}…` : b["desc"]?.value,
            eli: b["c"]?.value,
            fedlex_url: webUrl(b["c"]?.value, language),
          }));
          if (!results.length) {
            return toolError(`No consultations found${query ? ` for '${query}'` : ""}${status !== "all" ? ` with status ${status}` : ""}.`, [
              "Use a term in the chosen language (German with language='de').",
              "Set status='all'.",
            ]);
          }
          return respond({ count: results.length, results }, { source: fedlex, cacheStatus, retrievedAt, language });
        } catch (err) {
          return errorToResult(err, "Fedlex SPARQL endpoint");
        }
      },
    }),
    tool({
      name: "search_federal_gazette",
      title: "Search the Federal Gazette (BBl)",
      description:
        "Search publications in the Federal Gazette (Bundesblatt BBl / Feuille fédérale FF / Foglio federale FF): Federal Council dispatches (Botschaften) on new bills, draft federal acts and decrees, referendum texts, reports and official notices. Filter by title keyword and publication-date range; returns date, title, BBl reference (e.g. 'BBl 2024 1234') and Fedlex link, newest first. Examples: {query:'Botschaft'}; {query:'Klima', date_from:'2023-01-01'}; {query:'énergie', language:'fr'}.",
      inputSchema: {
        query: z.string().min(2).optional().describe("Title keyword in the chosen language, e.g. 'Botschaft', 'Datenschutz'"),
        date_from: DATE.optional().describe("Earliest publication date (default: 90 days before date_to, or 2 years with a query; range max 2 years)"),
        date_to: DATE.optional().describe("Latest publication date (default: today)"),
        language: z.enum(["de", "fr", "it"]).default("de"),
        limit: z.number().int().min(1).max(50).default(20),
      },
      handler: async ({ query, date_from, date_to, language, limit }) => {
        const to = date_to ?? todayIso();
        // Default window ends at date_to (not today) so an old date_to alone still works.
        const from = date_from ?? shiftIso(to, query ? -730 : -90);
        if (from > to) return toolError("date_from must be on or before date_to.");
        const spanDays = (Date.parse(to) - Date.parse(from)) / 86_400_000;
        if (spanDays > MAX_SPAN_DAYS) {
          return toolError("Date range too wide (max 2 years).", [
            "Narrow date_from/date_to to at most 2 years; search older periods window by window.",
          ]);
        }
        try {
          const sparql = buildGazetteQuery({ from, to, language, query, limit });
          const { data, cacheStatus, retrievedAt } = await runSparql(sparql, fedlexGazette.cacheTtlSeconds, 45_000);
          const results = uniqueBy(data.results?.bindings ?? [], "act").map((b) => ({
            date: b["date"]?.value,
            title: b["titleStr"]?.value,
            reference: gazetteReference(b["act"]?.value, language),
            eli: b["act"]?.value,
            fedlex_url: webUrl(b["act"]?.value, language),
          }));
          if (!results.length) {
            return toolError(`No Federal Gazette publications found${query ? ` for '${query}'` : ""} between ${from} and ${to}.`, [
              "Titles are language-specific: search German terms with language='de', French with 'fr'.",
              "Widen the date range with date_from.",
            ]);
          }
          return respond(
            { date_from: from, date_to: to, count: results.length, results },
            { source: fedlexGazette, cacheStatus, retrievedAt, language },
          );
        } catch (err) {
          return errorToResult(err, "Fedlex SPARQL endpoint");
        }
      },
    }),
  ],
};
