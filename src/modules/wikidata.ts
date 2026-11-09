/**
 * Wikidata module: the universal join key for Swiss entities.
 *
 * Not an official Swiss source, but CC0 and uniquely useful: every Swiss
 * municipality, canton, mountain, lake, river, company, person and institution
 * has a Q-id, and many carry Swiss identifiers (BFS municipality number P771,
 * Historical Dictionary of Switzerland id P902, …) that join to the official
 * federal sources exposed by the other Swissyphus modules.
 *
 * Endpoints (both public, keyless; Wikimedia requires a descriptive
 * User-Agent, which core/http.ts always sends):
 *   - https://www.wikidata.org/w/api.php  (wbsearchentities, wbgetentities, list=search)
 *   - https://query.wikidata.org/sparql   (read-only SPARQL, JSON results)
 */

import { z } from "zod";
import { allowHosts, fetchJson, withParams } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { CacheStatus, SourceManifest } from "../core/types.js";

allowHosts("www.wikidata.org", "query.wikidata.org");

const API = "https://www.wikidata.org/w/api.php";
const SPARQL = "https://query.wikidata.org/sparql";

const source: SourceManifest = {
  id: "wikidata",
  name: "Wikidata: the free knowledge base",
  operator: "Wikimedia Foundation (community-curated)",
  url: "https://www.wikidata.org",
  licence: "CC0 1.0 (Wikidata structured data); linked Wikipedia articles are CC BY-SA 4.0; Commons images carry their own licences",
  attribution: "Wikidata (CC0), wikidata.org",
  updateFrequency: "continuous (community edits); query service lags edits by seconds to minutes",
  cacheTtlSeconds: 6 * 3600,
  notes:
    "Community-maintained, not an official Swiss source: cross-check figures (population, area) against BFS/swisstopo tools. " +
    "Useful Swiss properties: P771 Swiss municipality code (BFS number), P902 HDS/HLS/DHS id, P1307 Swiss parliament id, P381 PCP (Swiss cultural property) reference number. " +
    "Query service has a 60 s server-side timeout; property labels in get_wikidata_entity are resolved live, so they are authoritative even for properties not in the curated priority list.",
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const WD_LANGS = ["de", "fr", "it", "rm", "en"] as const;
const SITELINK_LANGS = ["de", "fr", "it", "rm", "en"] as const;

/** Switzerland. */
export const Q_SWITZERLAND = "Q39";
/** "canton of Switzerland" class. */
export const Q_CANTON = "Q23058";

/**
 * Swiss identifier properties surfaced separately in entity output.
 * P771 and P902 are well established; P1307 and P381 are included on good
 * (not absolute) confidence: their labels are resolved live anyway.
 */
export const SWISS_ID_PROPS: Record<string, string> = {
  P771: "swiss_municipality_code_bfs",
  P902: "hls_dhs_dss_id",
  P1307: "swiss_parliament_id",
  P381: "pcp_cultural_property_id",
};

/**
 * Properties shown first in get_wikidata_entity (roughly: identity → place →
 * figures → organisation → person → geography → media/links).
 */
export const PRIORITY_PROPS = [
  "P31", "P279", "P17", "P131", "P150", "P36", "P625", "P1082", "P2046", "P2044",
  "P2048", "P281", "P856", "P1448", "P1705", "P37", "P571", "P576", "P138",
  "P159", "P452", "P1454", "P112", "P169", "P749", "P355", "P1128", "P2139", "P414", "P946", "P1278",
  "P106", "P27", "P569", "P19", "P570", "P20", "P69", "P108", "P39", "P102",
  "P4552", "P610", "P885", "P403", "P2043", "P206", "P4614", "P47",
  "P94", "P18", "P41", "P242", "P300", "P1566", "P227", "P214",
] as const;

/** Common unit Q-ids → short symbols (anything else is resolved as a label). */
const UNIT_SYMBOLS: Record<string, string> = {
  Q11573: "m",
  Q828224: "km",
  Q712226: "km²",
  Q25343: "m²",
  Q35852: "ha",
  Q11570: "kg",
  Q25344: "CHF",
  Q4916: "EUR",
  Q4917: "USD",
};

// ---------------------------------------------------------------------------
// Raw API shapes (defensive: everything optional)
// ---------------------------------------------------------------------------

interface LangValue {
  language?: string;
  value?: string;
}

interface WdDataValue {
  type?: string;
  value?: unknown;
}

interface WdSnak {
  snaktype?: string;
  property?: string;
  datatype?: string;
  datavalue?: WdDataValue;
}

export interface WdClaim {
  mainsnak?: WdSnak;
  rank?: string;
  qualifiers?: Record<string, WdSnak[]>;
}

export interface WdEntity {
  id?: string;
  type?: string;
  missing?: string;
  labels?: Record<string, LangValue>;
  descriptions?: Record<string, LangValue>;
  aliases?: Record<string, LangValue[]>;
  claims?: Record<string, WdClaim[]>;
  sitelinks?: Record<string, { site?: string; title?: string }>;
}

interface WbGetEntitiesResponse {
  entities?: Record<string, WdEntity>;
  error?: { code?: string; info?: string };
}

interface WbSearchResponse {
  search?: Array<{
    id?: string;
    label?: string;
    description?: string;
    concepturi?: string;
    match?: { type?: string; language?: string; text?: string };
    aliases?: string[];
  }>;
  error?: { code?: string; info?: string };
}

interface CirrusSearchResponse {
  query?: { searchinfo?: { totalhits?: number }; search?: Array<{ title?: string; snippet?: string }> };
  error?: { code?: string; info?: string };
}

export interface SparqlJson {
  head?: { vars?: string[] };
  boolean?: boolean;
  results?: { bindings?: Array<Record<string, { type?: string; value?: string; "xml:lang"?: string; datatype?: string }>> };
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Normalise "q42", "Q42", or a full entity URI to "Q42"; undefined if invalid. */
export function normaliseQid(input: string): string | undefined {
  const m = input.trim().match(/(?:^|\/)([QqPp])(\d{1,12})$/);
  if (!m) return undefined;
  return `${m[1]!.toUpperCase()}${m[2]}`;
}

/** Strip characters that could break out of a SPARQL string literal. */
export function sanitizeSparqlLiteral(s: string): string {
  return s.replace(/[^\p{L}\p{N}\s.'()-]/gu, " ").replace(/\s+/g, " ").trim();
}

/** Strip characters that have meaning in CirrusSearch syntax. */
export function sanitizeSearchText(s: string): string {
  return s.replace(/[^\p{L}\p{N}\s.'-]/gu, " ").replace(/\s+/g, " ").trim();
}

/** Pick a label in the preferred language, falling back through de/fr/it/en/any. */
export function pickLang(values: Record<string, LangValue> | undefined, lang: string): string | undefined {
  if (!values) return undefined;
  for (const l of [lang, "en", "de", "fr", "it", "rm"]) {
    const v = values[l]?.value;
    if (v) return v;
  }
  for (const v of Object.values(values)) if (v?.value) return v.value;
  return undefined;
}

/** Commons file name → stable Special:FilePath URL. */
export function commonsFileUrl(fileName: string): string {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(fileName.replace(/ /g, "_"))}`;
}

function entityIdFromUri(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  const m = uri.match(/\/entity\/([QPL]\d+)$/);
  return m ? m[1] : undefined;
}

/** Format a Wikidata time value ("+2021-12-31T00:00:00Z", precision 9/10/11). */
export function formatWdTime(time: string | undefined, precision?: number): string | undefined {
  if (!time) return undefined;
  const m = time.match(/^([+-])(\d+)-(\d{2})-(\d{2})/);
  if (!m) return time;
  const year = `${m[1] === "-" ? "-" : ""}${Number(m[2])}`;
  if (precision !== undefined && precision <= 9) return year;
  if (precision === 10) return `${year}-${m[3]}`;
  return `${year}-${m[3]}-${m[4]}`;
}

export type SimpleValue =
  | { type: "item"; id: string; label?: string }
  | { type: "string"; value: string; url?: string }
  | { type: "time"; value: string }
  | { type: "quantity"; amount: number; unit?: string; unit_id?: string }
  | { type: "coordinates"; lat: number; lon: number }
  | { type: "text"; value: string; language?: string }
  | { type: "novalue" | "somevalue" }
  | { type: "other"; raw: unknown };

/** Flatten a Wikidata snak's datavalue into a compact JSON value. */
export function simplifySnak(snak: WdSnak | undefined): SimpleValue | undefined {
  if (!snak) return undefined;
  if (snak.snaktype === "novalue") return { type: "novalue" };
  if (snak.snaktype === "somevalue") return { type: "somevalue" };
  const dv = snak.datavalue;
  if (!dv) return undefined;
  const v = dv.value as Record<string, unknown> | string | undefined;
  switch (dv.type) {
    case "wikibase-entityid": {
      const id = typeof v === "object" && v ? (v.id as string | undefined) : undefined;
      return id ? { type: "item", id } : undefined;
    }
    case "string": {
      if (typeof v !== "string") return undefined;
      if (snak.datatype === "commonsMedia") return { type: "string", value: v, url: commonsFileUrl(v) };
      return { type: "string", value: v };
    }
    case "time": {
      const o = (typeof v === "object" && v) || {};
      const t = formatWdTime(o.time as string | undefined, o.precision as number | undefined);
      return t ? { type: "time", value: t } : undefined;
    }
    case "quantity": {
      const o = (typeof v === "object" && v) || {};
      const amount = Number(String(o.amount ?? "").replace(/^\+/, ""));
      if (!Number.isFinite(amount)) return undefined;
      const unitId = entityIdFromUri(o.unit as string | undefined);
      return {
        type: "quantity",
        amount,
        ...(unitId ? { unit_id: unitId, ...(UNIT_SYMBOLS[unitId] ? { unit: UNIT_SYMBOLS[unitId] } : {}) } : {}),
      };
    }
    case "globecoordinate": {
      const o = (typeof v === "object" && v) || {};
      const lat = Number(o.latitude);
      const lon = Number(o.longitude);
      return Number.isFinite(lat) && Number.isFinite(lon) ? { type: "coordinates", lat, lon } : undefined;
    }
    case "monolingualtext": {
      const o = (typeof v === "object" && v) || {};
      return typeof o.text === "string"
        ? { type: "text", value: o.text, language: o.language as string | undefined }
        : undefined;
    }
    default:
      return { type: "other", raw: v };
  }
}

/** Non-deprecated claims, preferred-rank first (if any are preferred, only those). */
export function bestClaims(claims: WdClaim[] | undefined): WdClaim[] {
  const live = (claims ?? []).filter((c) => c.rank !== "deprecated");
  const preferred = live.filter((c) => c.rank === "preferred");
  return preferred.length ? preferred : live;
}

/** Qualifier P585 (point in time) as a sortable string, or "". */
function pointInTime(c: WdClaim): string {
  const s = simplifySnak(c.qualifiers?.P585?.[0]);
  return s && s.type === "time" ? s.value : "";
}

/**
 * The most recent value of a time-varying property (e.g. population):
 * the non-deprecated claim with the latest P585 qualifier, preferring
 * preferred-rank claims.
 */
export function latestClaim(claims: WdClaim[] | undefined): { value?: SimpleValue; as_of?: string } {
  const live = bestClaims(claims);
  if (!live.length) return {};
  const sorted = [...live].sort((a, b) => pointInTime(b).localeCompare(pointInTime(a)));
  const top = sorted[0]!;
  const asOf = pointInTime(top);
  return { value: simplifySnak(top.mainsnak), ...(asOf ? { as_of: asOf } : {}) };
}

/** Wikipedia article URLs for the given languages from an entity's sitelinks. */
export function wikipediaLinks(
  sitelinks: WdEntity["sitelinks"],
  langs: readonly string[] = SITELINK_LANGS,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of langs) {
    const title = sitelinks?.[`${l}wiki`]?.title;
    if (title) out[l] = `https://${l}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
  }
  return out;
}

/** Order property ids: curated priority list first, then the rest as they appear. */
export function orderProperties(propIds: string[]): string[] {
  const set = new Set(propIds);
  const first = PRIORITY_PROPS.filter((p) => set.has(p));
  const rest = propIds.filter((p) => !(PRIORITY_PROPS as readonly string[]).includes(p));
  return [...first, ...rest];
}

/** Collect every Q/P id referenced by simplified values (for label resolution). */
function referencedIds(values: SimpleValue[]): string[] {
  const ids: string[] = [];
  for (const v of values) {
    if (v.type === "item") ids.push(v.id);
    if (v.type === "quantity" && v.unit_id && !v.unit) ids.push(v.unit_id);
  }
  return ids;
}

const SPARQL_IRIREF = /<[^<>"{}|^`\\\u0000- ]*>/y;

/**
 * Blank out comments, string literals and IRIs in a SPARQL query while
 * keeping every other character at its original offset (the masked text has
 * the same length as the input). Keyword and LIMIT detection run on this
 * copy, so `# … with population` or `rdfs:label "Add"` are not mistaken for
 * update keywords, and `LIMIT 5000000 # LIMIT 5` cannot hide the real LIMIT.
 * Delimiters (quotes, angle brackets) and newlines are kept.
 */
export function maskSparql(query: string): string {
  const out = query.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < query.length) {
    const c = query[i]!;
    if (c === "#") {
      const nl = query.indexOf("\n", i);
      const end = nl === -1 ? query.length : nl;
      blank(i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      const delim = query.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      const long = delim.length === 3;
      let j = i + delim.length;
      let closed = false;
      while (j < query.length) {
        if (query[j] === "\\") j += 2;
        else if (query.startsWith(delim, j)) {
          closed = true;
          break;
        } else if (!long && query[j] === "\n") break; // short strings cannot span lines
        else j++;
      }
      j = Math.min(j, query.length);
      blank(i + delim.length, j);
      i = closed ? j + delim.length : j;
    } else if (c === "<") {
      SPARQL_IRIREF.lastIndex = i;
      const m = SPARQL_IRIREF.exec(query);
      if (m) {
        blank(i + 1, i + m[0].length - 1);
        i += m[0].length;
      } else i++;
    } else i++;
  }
  return out.join("");
}

/** Guard for user-supplied SPARQL: SELECT/ASK only, no update keywords, LIMIT injected/clamped. */
export function guardSparql(
  query: string,
  { defaultLimit = 100, maxLimit = 1000 } = {},
): { ok: true; query: string } | { ok: false; error: string } {
  const FORBIDDEN = /\b(INSERT|DELETE|DROP|CLEAR|CREATE|LOAD|MOVE|COPY|ADD|WITH)\b/i;
  // Every check runs on the masked copy (comments, strings and IRIs blanked),
  // whose offsets match the real query one-to-one.
  const masked = maskSparql(query);
  let body = masked;
  const prologue = /^\s*(?:PREFIX\s+[\w-]*:\s*<[^>]*>|BASE\s*<[^>]*>)/i;
  while (prologue.test(body)) body = body.replace(prologue, "");
  const form = body.trimStart().match(/^(SELECT|ASK)\b/i)?.[1]?.toUpperCase();
  if (!form) {
    return { ok: false, error: "Only read-only SPARQL SELECT (or ASK) queries are allowed." };
  }
  if (FORBIDDEN.test(masked)) {
    return { ok: false, error: "Query contains a forbidden SPARQL update keyword (INSERT/DELETE/DROP/CLEAR/CREATE/LOAD/MOVE/COPY/ADD/WITH)." };
  }
  if (form === "ASK") return { ok: true, query };
  // Every real LIMIT with its brace depth: only a depth-0 LIMIT bounds the
  // result size, but subquery LIMITs over the ceiling are clamped as well.
  const limits: Array<{ start: number; end: number; value: number; depth: number }> = [];
  const re = /\bLIMIT(\s+)(\d+)/gi;
  let depth = 0;
  let scanned = 0;
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    for (; scanned < m.index; scanned++) {
      if (masked[scanned] === "{") depth++;
      else if (masked[scanned] === "}") depth = Math.max(0, depth - 1);
    }
    const start = m.index + "LIMIT".length + m[1]!.length;
    limits.push({ start, end: start + m[2]!.length, value: Number(m[2]), depth });
  }
  let out = query;
  // Rewrite back to front so earlier offsets stay valid.
  for (const l of [...limits].reverse()) {
    if (l.value > maxLimit) out = `${out.slice(0, l.start)}${maxLimit}${out.slice(l.end)}`;
  }
  if (!limits.some((l) => l.depth === 0)) out = `${out}\nLIMIT ${defaultLimit}`;
  return { ok: true, query: out };
}

/** Longest cell kept when a single oversized row would not fit the budget otherwise. */
const MAX_CELL = 1_000;

/**
 * Trim SPARQL rows to a JSON byte budget (respond() withholds anything over
 * 50 KB). Long cells are shortened only when not even one row fits.
 */
export function fitSparqlRows(
  rows: Record<string, string | undefined>[],
  budget = 44_000,
): { rows: Record<string, string | undefined>[]; dropped: number; cells_truncated: boolean } {
  const take = (xs: Record<string, string | undefined>[]) => {
    let size = 2;
    for (let i = 0; i < xs.length; i++) {
      size += JSON.stringify(xs[i]).length + 1;
      if (size > budget) return xs.slice(0, i);
    }
    return xs;
  };
  let kept = take(rows);
  let cells_truncated = false;
  if (!kept.length && rows.length) {
    const short = rows.map((r) =>
      Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v && v.length > MAX_CELL ? `${v.slice(0, MAX_CELL)}…` : v])),
    );
    kept = take(short);
    cells_truncated = true;
  }
  return { rows: kept, dropped: rows.length - kept.length, cells_truncated };
}

/** SPARQL JSON bindings → flat rows (values only, Q-id shortened where the value is an entity URI). */
export function sparqlRows(data: SparqlJson): { variables: string[]; rows: Record<string, string | undefined>[] } {
  const vars = data.head?.vars ?? [];
  const rows = (data.results?.bindings ?? []).map((b) =>
    Object.fromEntries(vars.map((v) => [v, b[v]?.value])),
  );
  return { variables: vars, rows };
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

const TTL = source.cacheTtlSeconds * 1000;

function worstCache(a: CacheStatus, b: CacheStatus): CacheStatus {
  const order: CacheStatus[] = ["hit", "computed", "stale", "miss"];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

async function getEntities(ids: string[], props: string, languages: string[]) {
  const url = withParams(API, {
    action: "wbgetentities",
    ids: ids.join("|"),
    props,
    languages: [...new Set(languages)].join("|"),
    format: "json",
  });
  const res = await fetchJson<WbGetEntitiesResponse>(url, { ttlMs: TTL, timeoutMs: 20_000 });
  if (res.data.error) {
    throw new Error(`Wikidata API error ${res.data.error.code ?? ""}: ${res.data.error.info ?? "unknown"}`);
  }
  return res;
}

/** Resolve labels for up to `max` ids in batches of 50 (API limit). */
async function resolveLabels(ids: string[], lang: string, max = 150) {
  const unique = [...new Set(ids)].slice(0, max);
  const labels: Record<string, string> = {};
  let cacheStatus: CacheStatus = "hit";
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const res = await getEntities(chunk, "labels", [lang, "en", "de", "fr", "it"]);
    cacheStatus = worstCache(cacheStatus, res.cacheStatus);
    for (const [id, e] of Object.entries(res.data.entities ?? {})) {
      const l = pickLang(e.labels, lang);
      if (l) labels[id] = l;
    }
  }
  return { labels, cacheStatus };
}

export async function runWikidataSparql(query: string, timeoutMs = 60_000) {
  const url = withParams(SPARQL, { query, format: "json" });
  return fetchJson<SparqlJson>(url, {
    ttlMs: TTL,
    timeoutMs,
    init: { headers: { Accept: "application/sparql-results+json" } },
  });
}

const langSchema = z.enum(["de", "fr", "it", "rm", "en"]).default("en");

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export const wikidataModule: SwissyphusModule = {
  id: "wikidata",
  emoji: "🔗",
  title: "Wikidata (entity join key)",
  description:
    "Search and read Wikidata entities (Q-ids) for Swiss places, companies, people and institutions; municipality facts by BFS number; read-only SPARQL",
  sources: [source],
  healthProbes: [
    {
      sourceId: "wikidata",
      url: withParams(API, { action: "wbgetentities", ids: Q_SWITZERLAND, props: "labels", languages: "en", format: "json" }),
    },
    {
      sourceId: "wikidata",
      url: withParams(SPARQL, { query: 'SELECT ?item WHERE { ?item wdt:P771 "261" } LIMIT 1', format: "json" }),
      headers: { Accept: "application/sparql-results+json" },
    },
  ],
  tools: [
    tool({
      name: "search_wikidata",
      title: "Search Wikidata entities",
      description:
        "Find Wikidata items (Q-ids) by name; the universal join key for Swiss municipalities, cantons, mountains, lakes, rivers, companies, people and institutions. Returns id, label, description and match. Set swiss_only=true to keep only items whose country (P17) or citizenship (P27) is Switzerland (Q39). Examples: 'Matterhorn', 'Lac Léman', 'Nestlé', 'ETH Zürich', 'Winterthur' (swiss_only=true). Follow up with get_wikidata_entity.",
      inputSchema: {
        query: z.string().min(1).max(200).describe("Name or label to search, e.g. 'Matterhorn', 'Roche', 'Aare'"),
        language: langSchema.describe("Search/label language: de, fr, it, rm or en (default en)"),
        swiss_only: z.boolean().default(false).describe("Restrict to items with country or citizenship = Switzerland"),
        limit: z.number().int().min(1).max(50).default(10).describe("Max results (1-50, default 10)"),
      },
      handler: async ({ query, language, swiss_only, limit }) => {
        try {
          if (!swiss_only) {
            const url = withParams(API, {
              action: "wbsearchentities",
              search: query,
              language,
              uselang: language,
              type: "item",
              limit,
              format: "json",
            });
            const { data, cacheStatus, retrievedAt } = await fetchJson<WbSearchResponse>(url, { ttlMs: TTL });
            if (data.error) return toolError(`Wikidata search failed: ${data.error.info ?? data.error.code}`);
            const results = (data.search ?? []).slice(0, limit).map((r) => ({
              id: r.id,
              label: r.label,
              description: r.description,
              matched: r.match?.text && r.match.text !== r.label ? r.match.text : undefined,
              url: r.id ? `https://www.wikidata.org/wiki/${r.id}` : undefined,
            }));
            if (!results.length) {
              return toolError(`No Wikidata items match '${query}'.`, [
                "Try another language (language='de'/'fr'/'it') or a shorter name.",
              ]);
            }
            return respond({ query, count: results.length, results }, { source, cacheStatus, retrievedAt, language });
          }

          // Swiss-restricted: full-text search with CirrusSearch's haswbstatement filter.
          const text = sanitizeSearchText(query);
          if (!text) return toolError("Query contains no searchable characters.");
          const searchUrl = withParams(API, {
            action: "query",
            list: "search",
            srsearch: `${text} haswbstatement:P17=${Q_SWITZERLAND}|P27=${Q_SWITZERLAND}`,
            srnamespace: 0,
            srlimit: limit,
            format: "json",
          });
          const s = await fetchJson<CirrusSearchResponse>(searchUrl, { ttlMs: TTL });
          if (s.data.error) return toolError(`Wikidata search failed: ${s.data.error.info ?? s.data.error.code}`);
          const ids = (s.data.query?.search ?? [])
            .map((h) => h.title)
            .filter((t): t is string => !!t && /^Q\d+$/.test(t))
            .slice(0, limit);
          if (!ids.length) {
            return toolError(`No Swiss Wikidata items match '${query}'.`, [
              "Retry with swiss_only=false: some Swiss items lack a country (P17) statement.",
            ]);
          }
          const e = await getEntities(ids, "labels|descriptions", [language, "en", "de", "fr", "it"]);
          const results = ids.map((id) => {
            const ent = e.data.entities?.[id];
            return {
              id,
              label: pickLang(ent?.labels, language),
              description: pickLang(ent?.descriptions, language),
              url: `https://www.wikidata.org/wiki/${id}`,
            };
          });
          return respond(
            { query, swiss_only: true, total_hits: s.data.query?.searchinfo?.totalhits, count: results.length, results },
            { source, cacheStatus: worstCache(s.cacheStatus, e.cacheStatus), retrievedAt: e.retrievedAt, language },
          );
        } catch (err) {
          return errorToResult(err, "Wikidata API");
        }
      },
    }),

    tool({
      name: "get_wikidata_entity",
      title: "Wikidata entity details",
      description:
        "Read one Wikidata item by Q-id: labels in de/fr/it/rm/en, description, the key statements with values resolved to labels (instance of, country, located in, coordinates, population, area, elevation, website, inception, headquarters, industry, …; up to max_properties), Swiss identifiers (BFS municipality code P771, HLS/DHS id P902, parliament id P1307), and de/fr/it/rm/en Wikipedia links. Examples: 'Q72' (Zürich), 'Q1374' (Matterhorn), 'Q11943' (ETH Zürich).",
      inputSchema: {
        id: z.string().min(2).max(80).describe("Wikidata Q-id, e.g. 'Q72', or an entity URI"),
        language: langSchema.describe("Language for resolved value labels (default en)"),
        max_properties: z.number().int().min(1).max(80).default(30).describe("Max properties to include (default 30)"),
        max_values_per_property: z.number().int().min(1).max(20).default(5).describe("Max values per property (default 5)"),
      },
      handler: async ({ id, language, max_properties, max_values_per_property }) => {
        const qid = normaliseQid(id);
        if (!qid || !qid.startsWith("Q")) {
          return toolError(`'${id}' is not a Wikidata item id.`, ["Use an id like 'Q72'; find one with search_wikidata."]);
        }
        try {
          const res = await getEntities([qid], "labels|descriptions|aliases|claims|sitelinks", [...WD_LANGS]);
          const ent = res.data.entities?.[qid] ?? Object.values(res.data.entities ?? {})[0];
          if (!ent || ent.missing !== undefined) {
            return toolError(`Wikidata item ${qid} does not exist.`, ["Find the right id with search_wikidata."]);
          }
          const claims = ent.claims ?? {};
          const ordered = orderProperties(Object.keys(claims)).filter((p) => !(p in SWISS_ID_PROPS));
          const chosen = ordered.slice(0, max_properties);

          const statements: Array<{ property: string; values: SimpleValue[]; as_of?: string }> = [];
          for (const p of chosen) {
            const best = bestClaims(claims[p]);
            if (p === "P1082") {
              const l = latestClaim(claims[p]);
              if (l.value) statements.push({ property: p, values: [l.value], ...(l.as_of ? { as_of: l.as_of } : {}) });
              continue;
            }
            const values = best
              .slice(0, max_values_per_property)
              .map((c) => simplifySnak(c.mainsnak))
              .filter((v): v is SimpleValue => v !== undefined);
            if (values.length) statements.push({ property: p, values });
          }

          const swissIds: Record<string, string> = {};
          for (const [p, key] of Object.entries(SWISS_ID_PROPS)) {
            const v = simplifySnak(bestClaims(claims[p])[0]?.mainsnak);
            if (v && v.type === "string") swissIds[key] = v.value;
          }

          const toResolve = [...statements.map((s) => s.property), ...referencedIds(statements.flatMap((s) => s.values))];
          let cacheStatus = res.cacheStatus;
          let labels: Record<string, string> = {};
          try {
            const r = await resolveLabels(toResolve, language);
            labels = r.labels;
            cacheStatus = worstCache(cacheStatus, r.cacheStatus);
          } catch {
            // Labels are an enhancement; return ids if resolution fails.
          }

          const properties = statements.map((s) => ({
            property: s.property,
            label: labels[s.property],
            values: s.values.map((v) => {
              if (v.type === "item") return { ...v, label: labels[v.id] };
              if (v.type === "quantity" && v.unit_id && !v.unit) return { ...v, unit: labels[v.unit_id] ?? v.unit_id };
              return v;
            }),
            ...(s.as_of ? { as_of: s.as_of } : {}),
          }));

          const labelsOut: Record<string, string> = {};
          for (const l of WD_LANGS) if (ent.labels?.[l]?.value) labelsOut[l] = ent.labels[l]!.value!;

          return respond(
            {
              id: ent.id ?? qid,
              url: `https://www.wikidata.org/wiki/${ent.id ?? qid}`,
              label: pickLang(ent.labels, language),
              description: pickLang(ent.descriptions, language),
              labels: labelsOut,
              aliases: (ent.aliases?.[language] ?? ent.aliases?.en ?? []).slice(0, 8).map((a) => a.value),
              swiss_identifiers: swissIds,
              wikipedia: wikipediaLinks(ent.sitelinks),
              property_count_total: Object.keys(claims).length,
              properties,
            },
            {
              source,
              cacheStatus,
              retrievedAt: res.retrievedAt,
              language,
              links: { wikidata: `https://www.wikidata.org/wiki/${qid}` },
              notes: "Wikipedia article text is CC BY-SA 4.0; Wikidata statements are CC0.",
            },
          );
        } catch (err) {
          return errorToResult(err, "Wikidata API");
        }
      },
    }),

    tool({
      name: "query_wikidata",
      title: "SPARQL query on Wikidata",
      description:
        "Run a read-only SPARQL SELECT (or ASK) against the Wikidata Query Service. Prefixes wd:, wdt:, p:, ps:, pq:, rdfs:, schema:, wikibase:, bd: are predefined; use SERVICE wikibase:label { bd:serviceParam wikibase:language \"de,fr,en\". } for labels. Swiss hooks: wd:Q39 = Switzerland, wdt:P771 = BFS municipality code, wdt:P17 = country, wdt:P131 = located in. Example: SELECT ?m ?mLabel ?bfs WHERE { ?m wdt:P771 ?bfs . SERVICE wikibase:label { bd:serviceParam wikibase:language \"de\". } }. LIMIT 100 is injected when absent; larger LIMITs are clamped to 1000. 60 s timeout.",
      inputSchema: {
        query: z.string().min(10).max(20_000).describe("SPARQL SELECT/ASK query (read-only)"),
      },
      handler: async ({ query }) => {
        const g = guardSparql(query);
        if (!g.ok) {
          return toolError(g.error, [
            "Start the query with optional PREFIX declarations followed by SELECT.",
            "Update operations are never allowed.",
          ]);
        }
        try {
          const { data, cacheStatus, retrievedAt } = await runWikidataSparql(g.query);
          if (typeof data.boolean === "boolean") {
            return respond({ ask: data.boolean }, { source, cacheStatus, retrievedAt });
          }
          const { variables, rows } = sparqlRows(data);
          const fit = fitSparqlRows(rows);
          const notes: string[] = [];
          if (fit.dropped) {
            notes.push(
              `Rows trimmed from ${rows.length} to ${fit.rows.length} to fit the 50 KB response cap; select fewer/shorter variables, add filters or a lower LIMIT (page with OFFSET).`,
            );
          }
          if (fit.cells_truncated) notes.push(`Values longer than ${MAX_CELL} characters were shortened.`);
          return respond(
            {
              variables,
              row_count: fit.rows.length,
              ...(fit.dropped ? { rows_total: rows.length } : {}),
              rows: fit.rows,
            },
            { source, cacheStatus, retrievedAt, ...(notes.length ? { notes: notes.join(" ") } : {}) },
          );
        } catch (err) {
          return errorToResult(err, "Wikidata Query Service");
        }
      },
    }),

    tool({
      name: "get_swiss_municipality_facts",
      title: "Swiss municipality facts (Wikidata)",
      description:
        "Wikidata facts for a Swiss municipality by name or BFS number (P771): Q-id, labels, canton, population (latest, with date), area km², elevation m, coordinates, postal codes, official website, coat of arms image, HLS/DHS id and Wikipedia link. Examples: bfs_number=261 (Zürich), name='Lugano', name='Val de Bagnes'. For official BFS statistics prefer get_population / get_municipality; use this for the Q-id join key and enrichment.",
      inputSchema: {
        name: z.string().min(2).max(100).optional().describe("Municipality name in any national language, e.g. 'Bern', 'Genève', 'Chur'"),
        bfs_number: z.number().int().min(1).max(9999).optional().describe("BFS municipality number, e.g. 261 (Zürich), 351 (Bern)"),
        language: langSchema.describe("Language for labels and the Wikipedia link (default en)"),
        include_former: z.boolean().default(false).describe("Also match dissolved/merged municipalities"),
      },
      handler: async ({ name, bfs_number, language, include_former }) => {
        if (name === undefined && bfs_number === undefined) {
          return toolError("Provide either 'name' or 'bfs_number'.", ["Example: bfs_number=261 or name='Lugano'."]);
        }
        try {
          let match: string;
          let lc = "";
          let order = "";
          if (bfs_number !== undefined) {
            match = `?item wdt:P771 "${bfs_number}" . BIND("${bfs_number}" AS ?bfs)`;
          } else {
            lc = sanitizeSparqlLiteral(name ?? "").toLowerCase();
            if (!lc) return toolError("Municipality name contains no usable characters.");
            // Substring match, but exact label matches (any national language)
            // sort first and shorter labels next, otherwise LIMIT can cut
            // 'Au' or 'Wil' in favour of dozens of longer names containing them.
            match =
              `?item wdt:P771 ?bfs ; rdfs:label ?l . FILTER(LANG(?l) IN ("de","fr","it","rm","en")) FILTER(CONTAINS(LCASE(STR(?l)), "${lc}"))\n` +
              `  BIND(IF(LCASE(STR(?l)) = "${lc}", 1, 0) AS ?exact)`;
            order = "\nORDER BY DESC(?exact) STRLEN(STR(?l))";
          }
          // Dissolved municipalities are excluded server-side so they cannot
          // use up the LIMIT before current ones are reached.
          const current = include_former ? "" : "\n  FILTER NOT EXISTS { ?item wdt:P576 [] }";
          const sparql = `SELECT DISTINCT ?item ?itemLabel ?bfs ?canton ?cantonLabel ?dissolved${order ? " ?exact" : ""} WHERE {
  ${match}${current}
  OPTIONAL { ?item wdt:P576 ?dissolved . }
  OPTIONAL { ?item wdt:P131+ ?canton . ?canton wdt:P31 wd:${Q_CANTON} . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "${language},de,fr,it,en". }
}${order}
LIMIT 40`;
          const sq = await runWikidataSparql(sparql, 45_000);
          const { rows } = sparqlRows(sq.data);
          type Cand = {
            id: string;
            label?: string;
            bfs?: string;
            canton?: string;
            canton_id?: string;
            dissolved?: string;
            exact?: boolean;
          };
          const byId = new Map<string, Cand>();
          for (const r of rows) {
            const qid = entityIdFromUri(r.item);
            if (!qid) continue;
            const exact = r.exact === "1" || r.exact === "true";
            const seen = byId.get(qid);
            if (seen) {
              if (exact) seen.exact = true;
              continue;
            }
            byId.set(qid, {
              exact,
              id: qid,
              label: r.itemLabel,
              bfs: r.bfs,
              canton: r.cantonLabel,
              canton_id: entityIdFromUri(r.canton),
              dissolved: r.dissolved?.slice(0, 10),
            });
          }
          let cands = [...byId.values()];
          if (!include_former) cands = cands.filter((c) => !c.dissolved);
          if (!cands.length) {
            return toolError(
              bfs_number !== undefined
                ? `No ${include_former ? "" : "current "}Swiss municipality with BFS number ${bfs_number} on Wikidata.`
                : `No ${include_former ? "" : "current "}Swiss municipality matching '${name}' on Wikidata.`,
              [
                "Check the spelling or try the name in another national language.",
                "Set include_former=true for merged/dissolved municipalities.",
                "lookup_postcode / get_municipality can resolve a place name to its BFS number.",
              ],
            );
          }
          // Rank: exact label match (any language, from SPARQL, or the display
          // label) first; otherwise keep the server's order (shorter labels first).
          const isExact = (c: Cand) => Number(!!c.exact || (c.label ?? "").toLowerCase() === lc);
          cands.sort((a, b) => isExact(b) - isExact(a));
          const top = cands[0]!;

          const e = await getEntities([top.id], "labels|claims|sitelinks", [...WD_LANGS]);
          const ent = e.data.entities?.[top.id] ?? {};
          const c = ent.claims ?? {};
          const first = (p: string) => simplifySnak(bestClaims(c[p])[0]?.mainsnak);
          const pop = latestClaim(c.P1082);
          const area = first("P2046");
          const elev = first("P2044");
          const coord = first("P625");
          const website = first("P856");
          const coa = first("P94");
          const hls = first("P902");
          const postcodes = bestClaims(c.P281)
            .map((x) => simplifySnak(x.mainsnak))
            .filter((v): v is Extract<SimpleValue, { type: "string" }> => v?.type === "string")
            .map((v) => v.value)
            .slice(0, 20);
          const wp = wikipediaLinks(ent.sitelinks);
          const labelsOut: Record<string, string> = {};
          for (const l of WD_LANGS) if (ent.labels?.[l]?.value) labelsOut[l] = ent.labels[l]!.value!;
          const str = (v: SimpleValue | undefined) => (v && v.type === "string" ? v : undefined);
          const qty = (v: SimpleValue | undefined) => (v && v.type === "quantity" ? v : undefined);

          return respond(
            {
              id: top.id,
              url: `https://www.wikidata.org/wiki/${top.id}`,
              name: pickLang(ent.labels, language) ?? top.label,
              labels: labelsOut,
              bfs_number: top.bfs ? Number(top.bfs) || top.bfs : undefined,
              canton: top.canton,
              canton_id: top.canton_id,
              dissolved: top.dissolved,
              population: qty(pop.value)?.amount,
              population_as_of: pop.as_of,
              area: qty(area) ? { value: qty(area)!.amount, unit: qty(area)!.unit ?? qty(area)!.unit_id } : undefined,
              elevation: qty(elev) ? { value: qty(elev)!.amount, unit: qty(elev)!.unit ?? qty(elev)!.unit_id } : undefined,
              coordinates: coord && coord.type === "coordinates" ? { lat: coord.lat, lon: coord.lon } : undefined,
              postal_codes: postcodes.length ? postcodes : undefined,
              official_website: str(website)?.value,
              coat_of_arms: str(coa) ? { file: str(coa)!.value, url: str(coa)!.url } : undefined,
              hls_dhs_id: str(hls)?.value,
              hls_url: str(hls) ? `https://hls-dhs-dss.ch/de/articles/${str(hls)!.value}/` : undefined,
              wikipedia: wp[language] ?? wp.en ?? Object.values(wp)[0],
              other_matches: cands.slice(1, 10).map((x) => ({ id: x.id, name: x.label, bfs_number: x.bfs, canton: x.canton })),
            },
            {
              source,
              cacheStatus: worstCache(sq.cacheStatus, e.cacheStatus),
              retrievedAt: e.retrievedAt,
              language,
              links: { wikidata: `https://www.wikidata.org/wiki/${top.id}` },
              notes:
                "Community-maintained figures; official population/area come from BFS (get_population). Wikipedia link content is CC BY-SA 4.0; coat of arms image licence per Wikimedia Commons file page.",
            },
          );
        } catch (err) {
          return errorToResult(err, "Wikidata");
        }
      },
    }),
  ],
};
