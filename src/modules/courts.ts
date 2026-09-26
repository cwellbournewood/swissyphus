/**
 * Courts module — Swiss court decisions via entscheidsuche.ch, the open-access
 * aggregator of federal (BGer, BVGer, BStGer, BPatGer) and cantonal court
 * decisions, queried through its public Elasticsearch search proxy.
 *
 * User text never gets concatenated into JSON: queries are built as JS
 * objects (simple_query_string, which cannot throw on syntax errors) and
 * serialised with JSON.stringify.
 */

import { z } from "zod";
import { allowHosts, fetchCached, SourceError } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

allowHosts("entscheidsuche.ch", "www.entscheidsuche.ch");

const entscheidsuche: SourceManifest = {
  id: "entscheidsuche",
  name: "entscheidsuche.ch — Swiss court decisions",
  operator: "Verein entscheidsuche.ch (decisions published by the federal and cantonal courts)",
  url: "https://entscheidsuche.ch",
  licence: "Court decisions are official acts not protected by copyright (Art. 5 CopA); aggregation by entscheidsuche.ch, attribution requested",
  attribution: "Source: entscheidsuche.ch; decisions © the respective Swiss courts (public domain)",
  updateFrequency: "daily crawls of court publication sites",
  cacheTtlSeconds: 3600,
  notes:
    "Queries the Elasticsearch proxy POST https://entscheidsuche.ch/_search.php. Medium-low confidence in the exact proxy " +
    "path and that it forwards _source/highlight/sort unchanged; medium confidence in the document fields (id, date, canton, " +
    "hierarchy, title.{de,fr,it}, abstract.{de,fr,it}, reference, attachment.content_url, attachment.content). Parsing is " +
    "defensive (missing fields are omitted). Court filters match either the 'hierarchy' field or the id prefix (e.g. " +
    "'CH_BGer_'), since the exact court codes used by the index are not guaranteed. 'language' prefers/boosts that language's " +
    "title and abstract; it is not a hard filter. Decisions are anonymised by the courts; coverage and anonymisation vary by canton.",
};

const BASE = "https://entscheidsuche.ch";
const SEARCH_URL = `${BASE}/_search.php`;

// ---------------------------------------------------------------------------
// Court codes
// ---------------------------------------------------------------------------

/** Friendly aliases → candidate index codes (both spellings seen in the wild). */
export const COURT_ALIASES: Record<string, string[]> = {
  BGER: ["CH_BGer"],
  BGE: ["CH_BGE"],
  BVGER: ["CH_BVGer", "CH_BVGE"],
  BVGE: ["CH_BVGer", "CH_BVGE"],
  BSTGER: ["CH_BStGer", "CH_BSTG"],
  BSTG: ["CH_BStGer", "CH_BSTG"],
  BPATGER: ["CH_BPatGer", "CH_BPatG"],
  BPATG: ["CH_BPatGer", "CH_BPatG"],
};

const COURT_LABELS: Record<string, string> = {
  CH_BGer: "Federal Supreme Court (BGer)",
  CH_BGE: "Federal Supreme Court — leading decisions (BGE)",
  CH_BVGer: "Federal Administrative Court (BVGer)",
  CH_BVGE: "Federal Administrative Court (BVGer)",
  CH_BStGer: "Federal Criminal Court (BStGer)",
  CH_BSTG: "Federal Criminal Court (BStGer)",
  CH_BPatGer: "Federal Patent Court (BPatGer)",
  CH_BPatG: "Federal Patent Court (BPatGer)",
};

const CANTON_CODES = new Set([
  "CH", "AG", "AI", "AR", "BE", "BL", "BS", "FR", "GE", "GL", "GR", "JU", "LU", "NE", "NW", "OW",
  "SG", "SH", "SO", "SZ", "TG", "TI", "UR", "VD", "VS", "ZG", "ZH",
]);

/** Resolve a court argument ('BGer', 'bvger', 'ZH_OG', 'CH_BGer') to index codes. */
export function courtCodes(court: string): string[] {
  const t = court.trim();
  const alias = COURT_ALIASES[t.toUpperCase()];
  if (alias) return alias;
  return [t];
}

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

export interface SearchParams {
  query: string;
  court?: string;
  canton?: string;
  date_from?: string;
  date_to?: string;
  language?: "de" | "fr" | "it";
  sort?: "relevance" | "date";
  limit: number;
}

/** Expand a partial date to the last day of its period: '2020' → '2020-12-31', '2021-02' → '2021-02-28'. */
export function endOfPeriod(d: string): string {
  if (/^\d{4}$/.test(d)) return `${d}-12-31`;
  const m = d.match(/^(\d{4})-(\d{2})$/);
  if (m) {
    const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
    return `${d}-${String(last).padStart(2, "0")}`;
  }
  return d;
}

/** Build the Elasticsearch request body. User text only ever appears as a JSON string value. */
export function buildSearchQuery(p: SearchParams): Record<string, unknown> {
  const lang = p.language;
  const fields = [
    "reference^6",
    lang ? `title.${lang}^4` : "title.*^3",
    ...(lang ? ["title.*^2"] : []),
    lang ? `abstract.${lang}^3` : "abstract.*^2",
    ...(lang ? ["abstract.*"] : []),
    "attachment.content",
  ];
  const filter: unknown[] = [];
  if (p.court) {
    const codes = courtCodes(p.court);
    filter.push({
      bool: {
        should: [{ terms: { hierarchy: codes } }, ...codes.map((c) => ({ prefix: { id: `${c}_` } }))],
        minimum_should_match: 1,
      },
    });
  }
  if (p.canton) {
    const c = p.canton.toUpperCase();
    filter.push({
      bool: {
        should: [{ term: { canton: c } }, { prefix: { id: `${c}_` } }],
        minimum_should_match: 1,
      },
    });
  }
  if (p.date_from || p.date_to) {
    filter.push({
      range: {
        date: {
          ...(p.date_from ? { gte: p.date_from.length === 4 ? `${p.date_from}-01-01` : p.date_from.length === 7 ? `${p.date_from}-01` : p.date_from } : {}),
          ...(p.date_to ? { lte: endOfPeriod(p.date_to) } : {}),
        },
      },
    });
  }
  return {
    size: p.limit,
    _source: { excludes: ["attachment.content"] },
    query: {
      bool: {
        must: [{ simple_query_string: { query: p.query, fields, default_operator: "and" } }],
        ...(filter.length ? { filter } : {}),
      },
    },
    highlight: {
      fields: { "attachment.content": { fragment_size: 220, number_of_fragments: 2 } },
      pre_tags: ["«"],
      post_tags: ["»"],
    },
    ...(p.sort === "date" ? { sort: [{ date: { order: "desc" } }, "_score"] } : {}),
  };
}

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

type Localised = string | Record<string, string | undefined> | undefined;

interface EsSource {
  id?: string;
  date?: string;
  canton?: string;
  hierarchy?: string[] | string;
  title?: Localised;
  abstract?: Localised;
  reference?: string[] | string;
  attachment?: { content_url?: string; content_type?: string; content?: string; language?: string };
  [k: string]: unknown;
}

interface EsHit {
  _id?: string;
  _score?: number | null;
  _source?: EsSource;
  highlight?: Record<string, string[]>;
}

export interface EsResponse {
  hits?: { total?: number | { value?: number; relation?: string }; hits?: EsHit[] };
  error?: unknown;
}

/** Pick the preferred language from a {de,fr,it} object, falling back to any non-empty value. */
export function pickLang(v: Localised, lang?: string): string | undefined {
  if (!v) return undefined;
  if (typeof v === "string") return v || undefined;
  if (lang && v[lang]) return v[lang];
  for (const l of ["de", "fr", "it", "rm", "en"]) if (v[l]) return v[l];
  for (const val of Object.values(v)) if (typeof val === "string" && val) return val;
  return undefined;
}

/** Resolve a (possibly relative) attachment URL against entscheidsuche.ch/docs/. */
export function resolveDocUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("/")) return `${BASE}${u}`;
  return `${BASE}/docs/${u}`;
}

function courtCodeOf(id: string | undefined, hierarchy: string[]): string | undefined {
  const fromId = id?.match(/^([A-Z]{2}_[A-Za-z]+)/)?.[1];
  return fromId ?? hierarchy.find((h) => h.includes("_"));
}

function snippet(s: string | undefined, max = 400): string | undefined {
  if (!s) return undefined;
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export interface Decision {
  id?: string;
  reference?: string;
  date?: string;
  court_code?: string;
  court?: string;
  canton?: string;
  title?: string;
  abstract?: string;
  highlights?: string[];
  url?: string;
  format?: string;
  score?: number;
}

export function normaliseHit(h: EsHit, lang?: string): Decision {
  const s = h._source ?? {};
  const id = s.id ?? h._id;
  const hierarchy = Array.isArray(s.hierarchy) ? s.hierarchy : s.hierarchy ? [s.hierarchy] : [];
  const code = courtCodeOf(id, hierarchy);
  const refs = Array.isArray(s.reference) ? s.reference.filter(Boolean) : s.reference ? [s.reference] : [];
  const url = resolveDocUrl(s.attachment?.content_url);
  const hl = h.highlight?.["attachment.content"]?.map((x) => snippet(x, 300)!).filter(Boolean);
  const out: Decision = {
    id,
    reference: refs.join(", ") || undefined,
    date: s.date?.slice(0, 10),
    court_code: code,
    court: code ? (COURT_LABELS[code] ?? code) : undefined,
    canton: s.canton,
    title: snippet(pickLang(s.title, lang), 300),
    abstract: snippet(pickLang(s.abstract, lang), 500),
    highlights: hl?.length ? hl : undefined,
    url,
    format: url?.match(/\.(pdf|html?)(?:$|\?)/i)?.[1]?.toLowerCase() ?? s.attachment?.content_type,
    score: typeof h._score === "number" ? Math.round(h._score * 100) / 100 : undefined,
  };
  for (const k of Object.keys(out) as (keyof Decision)[]) if (out[k] === undefined) delete out[k];
  return out;
}

export function totalOf(r: EsResponse): number | undefined {
  const t = r.hits?.total;
  if (typeof t === "number") return t;
  return t?.value;
}

/** Convert an HTML decision page to plain text (drops script/style, keeps paragraph breaks). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/h\d|\/li|\/tr|\/table)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e: string) => {
      const l = e.toLowerCase();
      if (l === "lt") return "<";
      if (l === "gt") return ">";
      if (l === "amp") return "&";
      if (l === "quot") return '"';
      if (l === "apos") return "'";
      const code = l.startsWith("#x") ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return "";
      }
    })
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function esSearch(body: Record<string, unknown>, ttlMs: number) {
  const res = await fetchCached(SEARCH_URL, {
    ttlMs,
    timeoutMs: 25_000,
    maxBytes: 6 * 1024 * 1024,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    },
  });
  let data: EsResponse;
  try {
    data = JSON.parse(res.data) as EsResponse;
  } catch {
    throw new SourceError("entscheidsuche.ch returned a non-JSON response (possibly down or changed format).", "entscheidsuche.ch");
  }
  if (data.error) {
    const reason =
      typeof data.error === "string"
        ? data.error
        : ((data.error as { reason?: string; root_cause?: Array<{ reason?: string }> }).root_cause?.[0]?.reason ??
          (data.error as { reason?: string }).reason ??
          "query rejected");
    throw new SourceError(`entscheidsuche.ch search error: ${reason}`, "entscheidsuche.ch");
  }
  return { data, cacheStatus: res.cacheStatus, retrievedAt: res.retrievedAt };
}

const DATE = z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, "Use YYYY, YYYY-MM or YYYY-MM-DD");

export const courtsModule: SwissyphusModule = {
  id: "courts",
  emoji: "🏛️",
  title: "Court decisions (entscheidsuche.ch)",
  description: "Full-text search of Swiss federal and cantonal court decisions, with links to the decision documents",
  sources: [entscheidsuche],
  healthProbes: [
    {
      sourceId: "entscheidsuche",
      url: SEARCH_URL,
      method: "POST",
      body: JSON.stringify({ size: 0, query: { match_all: {} } }),
      headers: { "Content-Type": "application/json" },
    },
  ],
  tools: [
    tool({
      name: "search_court_decisions",
      title: "Search Swiss court decisions",
      description:
        "Full-text search across Swiss court decisions aggregated by entscheidsuche.ch: Federal Supreme Court (BGer/BGE), Federal Administrative Court (BVGer), " +
        "Federal Criminal Court (BStGer), Federal Patent Court and the courts of all 26 cantons. Returns docket/reference number, decision date, court, canton, title, " +
        "abstract snippet, matching text excerpts and a link to the decision (PDF/HTML). Query syntax: words are AND-ed; use \"quotes\" for phrases, | for OR, - to exclude. " +
        "Examples: query='Mietzins Kündigung' canton='ZH'; query='\"Art. 336 OR\"' court='BGer' date_from='2020'; query='5A_123/2020'.",
      inputSchema: {
        query: z.string().min(2).max(500).describe("Search terms, a legal provision or a docket number"),
        court: z
          .string()
          .regex(/^[A-Za-z]{2,8}(_[A-Za-z0-9]{1,16}){0,3}$/)
          .optional()
          .describe("Court: 'BGer', 'BGE', 'BVGer', 'BStGer', 'BPatGer', or an index code like 'ZH_OG' / 'CH_BGer'"),
        canton: z.string().length(2).optional().describe("Canton code, e.g. 'ZH'; 'CH' = federal courts"),
        date_from: DATE.optional().describe("Earliest decision date, e.g. '2020' or '2020-01-31'"),
        date_to: DATE.optional().describe("Latest decision date"),
        language: z.enum(["de", "fr", "it"]).optional().describe("Preferred language for titles/abstracts (boosted, not filtered)"),
        sort: z.enum(["relevance", "date"]).default("relevance"),
        limit: z.number().int().min(1).max(20).default(10),
      },
      handler: async (args) => {
        if (args.canton && !CANTON_CODES.has(args.canton.toUpperCase())) {
          return toolError(`Unknown canton '${args.canton}'.`, ["Use a two-letter canton code like 'ZH', 'VD', or 'CH' for federal courts."]);
        }
        try {
          const body = buildSearchQuery(args);
          const { data, cacheStatus, retrievedAt } = await esSearch(body, entscheidsuche.cacheTtlSeconds * 1000);
          const decisions = (data.hits?.hits ?? []).map((h) => normaliseHit(h, args.language));
          if (!decisions.length) {
            return toolError(`No court decisions found for '${args.query}'.`, [
              "Decisions are in German, French or Italian — search in the language of the court (e.g. 'Kündigung' / 'résiliation').",
              "Drop the court/canton/date filters or use fewer words (terms are AND-ed).",
            ]);
          }
          return respond(
            { total: totalOf(data), returned: decisions.length, decisions },
            {
              source: entscheidsuche,
              cacheStatus,
              retrievedAt,
              ...(args.language ? { language: args.language } : {}),
              notes: "Use get_court_decision with a decision id for a longer text excerpt.",
            },
          );
        } catch (err) {
          return errorToResult(err, "entscheidsuche.ch");
        }
      },
    }),

    tool({
      name: "get_court_decision",
      title: "Get a Swiss court decision",
      description:
        "Fetch one court decision from entscheidsuche.ch by its id (from search_court_decisions, e.g. 'CH_BGer_005_5A-123-2020_2020-06-15'). " +
        "Returns metadata (reference, date, court, canton, title, abstract), the document link and a plain-text excerpt of the decision (up to ~20 KB).",
      inputSchema: {
        id: z
          .string()
          .regex(/^[A-Za-z0-9_.\-]{3,200}$/, "Decision ids contain only letters, digits, '_', '-' and '.'")
          .describe("Decision id from search_court_decisions"),
        language: z.enum(["de", "fr", "it"]).optional().describe("Preferred language for title/abstract"),
        max_chars: z.number().int().min(500).max(20_000).default(20_000).describe("Maximum excerpt length in characters"),
      },
      handler: async ({ id, language, max_chars }) => {
        try {
          const { data, cacheStatus, retrievedAt } = await esSearch(
            {
              size: 1,
              query: { bool: { should: [{ ids: { values: [id] } }, { term: { id } }], minimum_should_match: 1 } },
            },
            24 * 3600_000,
          );
          const hit = data.hits?.hits?.[0];
          if (!hit) {
            return toolError(`No court decision with id '${id}'.`, [
              "Use search_court_decisions to find the id; ids look like 'CH_BGer_005_5A-123-2020_2020-06-15'.",
            ]);
          }
          const meta = normaliseHit({ ...hit, highlight: undefined }, language);
          let text = hit._source?.attachment?.content;
          let textSource = text ? "index" : undefined;
          let note: string | undefined;
          if (!text && meta.url && /^https:\/\/(www\.)?entscheidsuche\.ch\//.test(meta.url) && /\.html?(\?|$)/i.test(meta.url)) {
            try {
              const page = await fetchCached(meta.url, { ttlMs: 24 * 3600_000, maxBytes: 3 * 1024 * 1024 });
              text = htmlToText(page.data);
              textSource = "html";
            } catch {
              note = "The decision text could not be retrieved; open the url.";
            }
          }
          if (!text) note ??= "No text available in the index for this decision (often PDF-only); open the url.";
          const clean = text ? text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim() : undefined;
          const truncated = clean ? clean.length > max_chars : false;
          return respond(
            {
              ...meta,
              ...(clean
                ? {
                    text_excerpt: truncated ? `${clean.slice(0, max_chars)}…` : clean,
                    text_length: clean.length,
                    truncated,
                    text_source: textSource,
                  }
                : {}),
            },
            {
              source: entscheidsuche,
              cacheStatus,
              retrievedAt,
              ...(language ? { language } : {}),
              ...(meta.url ? { links: { document: meta.url } } : {}),
              ...(note ? { notes: note } : truncated ? { notes: "Excerpt truncated; the full decision is at the document link." } : {}),
            },
          );
        } catch (err) {
          return errorToResult(err, "entscheidsuche.ch");
        }
      },
    }),
  ],
};
