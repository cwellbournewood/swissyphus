/**
 * Procurement module: Swiss public tenders and contract awards from simap.ch,
 * the joint procurement platform of the Confederation, the cantons and the
 * municipalities (read API, no key; spec at https://www.simap.ch/api-doc).
 *
 * - search: GET /api/publications/v2/project/project-search (needs a search
 *   text or at least one quick filter; rolling pagination via `lastItem`).
 * - detail: GET /api/publications/v1/project/{projectId}/publication-details/{publicationId}
 *   (award notices carry the decision: winning vendors, prices, number of bids).
 * - CPV codes: GET /api/codes/v1/cpv/search?query=…
 */

import { z } from "zod";
import { allowHosts, fetchJson, SourceError } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

allowHosts("www.simap.ch");

const simap: SourceManifest = {
  id: "simap",
  name: "simap.ch: Swiss public procurement platform",
  operator: "Verein simap.ch (Confederation, cantons and municipalities)",
  url: "https://www.simap.ch",
  licence: "Official procurement notices published under the public procurement laws (BöB/IVöB); no explicit open-data licence, reuse subject to simap.ch terms, cite simap.ch",
  attribution: "Source: simap.ch",
  updateFrequency: "continuous (notices published on working days)",
  cacheTtlSeconds: 900,
  notes:
    "Public read API v2 (project-search) and v1 (publication-details, CPV codes). Search needs a text of 3+ characters or a filter. " +
    "Pagination is rolling: pass the returned `next_cursor` as `cursor`.",
};

const BASE = "https://www.simap.ch/api";
const LANGS = ["de", "fr", "it", "en"] as const;

const PROJECT_SUBTYPES = [
  "construction",
  "service",
  "supply",
  "project_competition",
  "idea_competition",
  "overall_performance_competition",
  "project_study",
  "idea_study",
  "overall_performance_study",
  "request_for_information",
] as const;

const PUB_TYPE_FILTERS = [
  "advance_notice",
  "request_for_information",
  "tender",
  "competition",
  "study_contract",
  "award_tender",
  "award_study_contract",
  "award_competition",
  "direct_award",
  "participant_selection",
  "revocation",
  "abandonment",
  "selective_offering_phase",
] as const;

const CANTONS = [
  "AG", "AI", "AR", "BE", "BL", "BS", "FR", "GE", "GL", "GR", "JU", "LU", "NE", "NW", "OW",
  "SG", "SH", "SO", "SZ", "TG", "TI", "UR", "VD", "VS", "ZG", "ZH",
] as const;

type Ml = Record<string, string | null | undefined> | null | undefined;

/** Pick a language from a {de,fr,it,en} object, falling back across languages. */
export function ml(v: Ml, lang: string): string | undefined {
  if (!v || typeof v !== "object") return undefined;
  for (const k of [lang, "de", "fr", "it", "en"]) {
    const s = v[k];
    if (typeof s === "string" && s.trim()) return s.trim();
  }
  return undefined;
}

/** Strip HTML from notice texts and collapse whitespace. */
export function htmlText(s: string | undefined, max = 2000): string | undefined {
  if (!s) return undefined;
  const t = s
    .replace(/<(br|\/p|\/li|\/h\d)\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^<>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

interface SearchProject {
  id: string;
  title?: Ml;
  projectNumber?: string;
  projectType?: string;
  projectSubType?: string;
  processType?: string;
  lotsType?: string;
  publicationId?: string;
  publicationDate?: string;
  publicationNumber?: string;
  pubType?: string;
  corrected?: boolean;
  procOfficeName?: Ml;
  orderAddress?: { countryId?: string; cantonId?: string | null; postalCode?: string | null; city?: Ml } | null;
}

export function mapSearchProject(p: SearchProject, lang: string) {
  return {
    project_id: p.id,
    publication_id: p.publicationId,
    title: ml(p.title, lang),
    project_number: p.projectNumber,
    publication_number: p.publicationNumber,
    publication_date: p.publicationDate,
    latest_notice: p.pubType,
    project_type: p.projectSubType ?? p.projectType,
    procedure: p.processType,
    ...(p.corrected ? { corrected: true } : {}),
    contracting_authority: ml(p.procOfficeName, lang),
    ...(p.orderAddress && (p.orderAddress.cantonId || p.orderAddress.postalCode)
      ? {
          location: [p.orderAddress.postalCode, ml(p.orderAddress.city, lang), p.orderAddress.cantonId].filter(Boolean).join(" "),
        }
      : {}),
  };
}

interface Price {
  currency?: string | null;
  price?: number | null;
  vatType?: string | null;
}

/** Condense a publication-details document into an agent-friendly summary. */
export function summarizePublication(d: Record<string, unknown>, lang: string) {
  const info = (d["project-info"] ?? {}) as Record<string, unknown>;
  const proc = (d["procurement"] ?? {}) as Record<string, unknown>;
  const dates = (d["dates"] ?? {}) as Record<string, unknown>;
  const base = (d["base"] ?? {}) as Record<string, unknown>;
  const decision = d["decision"] as Record<string, unknown> | undefined;
  const office = (info["procOfficeAddress"] ?? {}) as Record<string, unknown>;
  const cpv = (proc["cpvCode"] ?? base["cpvCode"]) as { code?: string; label?: Ml } | undefined;
  const addCpv = (proc["additionalCpvCodes"] as Array<{ code?: string; label?: Ml }> | undefined) ?? [];
  const order = (proc["orderAddress"] ?? {}) as { postalCode?: string; city?: Ml; cantonId?: string };
  const priceOf = (p: Price | undefined) =>
    p && typeof p.price === "number" ? { amount: p.price, currency: (p.currency ?? "chf").toUpperCase(), vat: p.vatType ?? undefined } : undefined;
  const vendors = ((decision?.["vendors"] as Array<Record<string, unknown>> | undefined) ?? []).map((v) => {
    const a = (v["vendorAddress"] ?? {}) as Record<string, string | undefined>;
    return {
      name: v["vendorName"] as string | undefined,
      location: [a["postalCode"], a["city"], a["cantonId"] ?? a["countryId"]].filter(Boolean).join(" ") || undefined,
      price: priceOf(v["price"] as Price | undefined),
      ...(v["rank"] != null ? { rank: v["rank"] } : {}),
    };
  });
  const lots = (d["lots"] as Array<Record<string, unknown>> | undefined) ?? [];
  return {
    publication_id: d["id"],
    project_id: base["projectId"],
    notice_type: d["type"],
    title: ml((info["title"] ?? base["title"]) as Ml, lang),
    project_number: base["projectNumber"],
    publication_number: base["publicationNumber"],
    publication_date: (dates["publicationDate"] as string | undefined) ?? (base["publicationDate"] as string | undefined),
    project_type: proc["orderType"] ?? base["orderType"],
    procedure: proc["processType"] ?? base["processType"],
    contracting_authority: {
      name: ml(office["name"] as Ml, lang),
      address: [ml(office["street"] as Ml, lang), office["postalCode"], ml(office["city"] as Ml, lang)].filter(Boolean).join(", ") || undefined,
      email: office["email"] ?? undefined,
      phone: office["phone"] ?? undefined,
    },
    description: htmlText(ml(proc["orderDescription"] as Ml, lang)),
    place_of_performance:
      [order.postalCode, ml(order.city, lang), order.cantonId].filter(Boolean).join(" ") ||
      ml(proc["orderAddressDescription"] as Ml, lang),
    cpv: cpv?.code ? { code: cpv.code, label: ml(cpv.label, lang) } : undefined,
    ...(addCpv.length ? { additional_cpv: addCpv.slice(0, 10).map((c) => ({ code: c.code, label: ml(c.label, lang) })) } : {}),
    ...(dates["offerDeadline"] ? { offer_deadline: dates["offerDeadline"] } : {}),
    ...(ml(proc["executionNote"] as Ml, lang) ? { execution: ml(proc["executionNote"] as Ml, lang) } : {}),
    ...(lots.length ? { lots: lots.slice(0, 20).map((l) => ({ number: l["lotNumber"], title: ml(l["title"] as Ml, lang) })) } : {}),
    ...(decision
      ? {
          award: {
            decision_date: decision["awardDecisionDate"],
            number_of_offers: decision["numberOfSubmissions"],
            awarded_to: vendors,
            justification: htmlText(ml(decision["awardDecisionJustification"] as Ml, lang), 1200),
          },
        }
      : {}),
    ...(d["referencingPub"]
      ? {
          previous_notice: {
            publication_id: (d["referencingPub"] as Record<string, unknown>)["publicationId"],
            type: (d["referencingPub"] as Record<string, unknown>)["pubType"],
            date: (d["referencingPub"] as Record<string, unknown>)["publicationDate"],
          },
        }
      : {}),
    remedies_notice: htmlText(ml(((d["terms"] ?? {}) as Record<string, unknown>)["remediesNotice"] as Ml, lang), 400),
  };
}

interface CpvNode {
  code: string;
  label?: Ml;
  codes?: CpvNode[];
}

/** Flatten the CPV search tree into a list (deepest, most specific codes first). */
export function flattenCpv(nodes: CpvNode[], lang: string, depth = 0, out: Array<{ code: string; label?: string; depth: number }> = []) {
  for (const n of nodes) {
    out.push({ code: n.code, label: ml(n.label, lang), depth });
    if (n.codes?.length) flattenCpv(n.codes, lang, depth + 1, out);
  }
  return out;
}

const langParam = z.enum(LANGS).default("de").describe("Language for titles and texts (falls back to the notice's original language)");

export const procurementModule: SwissyphusModule = {
  id: "procurement",
  emoji: "📑",
  title: "Public procurement (simap.ch)",
  description:
    "Swiss public tenders and contract awards from simap.ch, federal, cantonal and municipal: search by text, canton, type and date; notice details incl. deadlines, CPV codes and award decisions (winner, price, number of bids)",
  sources: [simap],
  healthProbes: [{ sourceId: "simap", url: `${BASE}/codes/v1/cpv/search?query=45000000` }],
  tools: [
    tool({
      name: "search_public_tenders",
      title: "Search Swiss public tenders & awards",
      description:
        "Search procurement projects on simap.ch (Confederation, cantons, municipalities, public companies). Filter by text, cantons of performance, project type, " +
        "latest notice type (e.g. 'tender' = open calls, 'award_tender' = awarded contracts) and publication date. Needs `query` (3+ chars) or at least one filter. " +
        "Results are newest first; pass `next_cursor` back as `cursor` for the next page. Example: {query: 'Schulhaus', cantons: ['ZH'], notice_types: ['tender']}.",
      inputSchema: {
        query: z.string().min(3).max(200).optional().describe("Search text (title, description), e.g. 'Reinigung', 'Software', 'Brücke'"),
        cantons: z.array(z.enum(CANTONS)).max(26).optional().describe("Cantons where the contract is performed, e.g. ['ZH','AG']"),
        project_types: z.array(z.enum(PROJECT_SUBTYPES)).max(10).optional().describe("construction | service | supply | *_competition | *_study | request_for_information"),
        notice_types: z.array(z.enum(PUB_TYPE_FILTERS)).max(13).optional().describe("Type of the newest notice: tender (open call), award_tender (award), direct_award, advance_notice, revocation, …"),
        cpv_codes: z.array(z.string().regex(/^\d{8}$/)).max(20).optional().describe("8-digit CPV codes (see search_cpv_codes), e.g. ['45233140']"),
        published_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Newest notice on/after this date (YYYY-MM-DD)"),
        published_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Newest notice on/before this date (YYYY-MM-DD)"),
        lang: langParam,
        cursor: z.string().max(100).optional().describe("Pagination cursor (`next_cursor` from the previous page)"),
      },
      handler: async ({ query, cantons, project_types, notice_types, cpv_codes, published_from, published_until, lang, cursor }) => {
        if (!query && !cantons?.length && !project_types?.length && !notice_types?.length && !cpv_codes?.length) {
          return toolError("Give a search text (3+ characters) or at least one filter.", [
            "Example: {query: 'Schulhaus'} or {cantons: ['BE'], notice_types: ['tender']}.",
          ]);
        }
        const params = new URLSearchParams();
        if (query) params.set("search", query);
        for (const c of cantons ?? []) params.append("orderAddressCantons", c);
        for (const t of project_types ?? []) params.append("projectSubTypes", t);
        for (const t of notice_types ?? []) params.append("newestPubTypes", t);
        for (const c of cpv_codes ?? []) params.append("cpvCodes", c);
        if (published_from) params.set("newestPublicationFrom", published_from);
        if (published_until) params.set("newestPublicationUntil", published_until);
        if (cursor) params.set("lastItem", cursor);
        try {
          const { data, cacheStatus, retrievedAt } = await fetchJson<{
            projects?: SearchProject[];
            pagination?: { lastItem?: string; itemsPerPage?: number };
          }>(`${BASE}/publications/v2/project/project-search?${params.toString()}`, {
            ttlMs: simap.cacheTtlSeconds * 1000,
            timeoutMs: 20_000,
          });
          const projects = data.projects ?? [];
          if (!projects.length) {
            return toolError(cursor ? "No further results." : "No procurement projects match.", [
              "Broaden the text (German terms match best) or remove filters.",
              "notice_types: ['tender'] = open calls; ['award_tender'] = awarded contracts.",
            ]);
          }
          const perPage = data.pagination?.itemsPerPage ?? 20;
          return respond(
            {
              results: projects.map((p) => mapSearchProject(p, lang)),
              ...(projects.length >= perPage && data.pagination?.lastItem ? { next_cursor: data.pagination.lastItem } : {}),
              hint: "get_tender_details {project_id, publication_id} returns the full notice (deadlines, CPV, award winner and price).",
            },
            { source: simap, cacheStatus, retrievedAt, language: lang },
          );
        } catch (err) {
          if (err instanceof SourceError && err.status === 400) {
            return toolError("simap.ch rejected the search parameters.", ["Search text must be 3–1000 characters; dates YYYY-MM-DD."]);
          }
          return errorToResult(err, "simap.ch");
        }
      },
    }),
    tool({
      name: "get_tender_details",
      title: "Public tender / award notice details",
      description:
        "Full simap.ch notice: contracting authority and contact, description, place of performance, CPV codes, procedure, offer deadline, lots and, for award notices, the award decision (winning vendors, awarded price, number of offers, justification). " +
        "Use project_id + publication_id from search_public_tenders.",
      inputSchema: {
        project_id: z.string().uuid().describe("project_id from search_public_tenders"),
        publication_id: z.string().uuid().describe("publication_id from search_public_tenders"),
        lang: langParam,
      },
      handler: async ({ project_id, publication_id, lang }) => {
        try {
          const { data, cacheStatus, retrievedAt } = await fetchJson<Record<string, unknown>>(
            `${BASE}/publications/v1/project/${project_id}/publication-details/${publication_id}`,
            { ttlMs: 3600_000, timeoutMs: 20_000 },
          );
          return respond(summarizePublication(data, lang), { source: simap, cacheStatus, retrievedAt, language: lang });
        } catch (err) {
          if (err instanceof SourceError && (err.status === 404 || err.status === 403)) {
            return toolError("No public notice with these ids.", ["Use project_id and publication_id exactly as returned by search_public_tenders."]);
          }
          return errorToResult(err, "simap.ch");
        }
      },
    }),
    tool({
      name: "search_cpv_codes",
      title: "Find CPV procurement codes",
      description:
        "Look up Common Procurement Vocabulary (CPV) codes by keyword or partial number, e.g. 'Strassenbau', 'software', '4523'. Use the 8-digit codes as `cpv_codes` in search_public_tenders.",
      inputSchema: {
        query: z.string().min(1).max(100),
        lang: langParam,
        limit: z.number().int().min(1).max(100).default(30),
      },
      handler: async ({ query, lang, limit }) => {
        try {
          const url = `${BASE}/codes/v1/cpv/search?${new URLSearchParams({ query, language: lang === "en" ? "en" : lang })}`;
          const { data, cacheStatus, retrievedAt } = await fetchJson<{ codes?: CpvNode[] }>(url, { ttlMs: 7 * 86400_000, timeoutMs: 15_000 });
          const flat = flattenCpv(data.codes ?? [], lang);
          if (!flat.length) return toolError(`No CPV codes match '${query}'.`, ["Try a broader or German term."]);
          return respond(
            { total: flat.length, codes: flat.slice(0, limit) },
            { source: simap, cacheStatus, retrievedAt, language: lang },
          );
        } catch (err) {
          return errorToResult(err, "simap.ch");
        }
      },
    }),
  ],
};
