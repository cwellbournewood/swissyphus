/**
 * Companies module — ZEFIX (Central Business Name Index) and SOGC/SHAB
 * commercial-register publications via the official gazette portal API.
 */

import { z } from "zod";
import { fetchJson, withParams } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

const zefix: SourceManifest = {
  id: "zefix",
  name: "ZEFIX — Central Business Name Index",
  operator: "Federal Office of Justice (FOJ) / Federal Commercial Registry Office",
  url: "https://www.zefix.admin.ch",
  licence: "Public register data, free consultation; attribution required",
  attribution: "© ZEFIX, Federal Office of Justice",
  updateFrequency: "daily (register mutations)",
  cacheTtlSeconds: 3600,
};

const sogc: SourceManifest = {
  id: "sogc",
  name: "SOGC/SHAB — Swiss Official Gazette of Commerce",
  operator: "SECO (Swiss Official Gazette of Commerce)",
  url: "https://amtsblattportal.ch",
  licence: "Official publications, public; attribution required",
  attribution: "© SHAB/FOSC, SECO",
  updateFrequency: "daily publication",
  cacheTtlSeconds: 1800,
};

const ZEFIX_BASE = "https://www.zefix.admin.ch/ZefixREST/api/v1";

interface ZefixFirm {
  name?: string;
  ehraid?: number;
  uid?: string;
  uidFormatted?: string;
  chid?: string;
  chidFormatted?: string;
  legalSeat?: string;
  legalFormId?: number;
  status?: string;
  shabDate?: string;
  deleteDate?: string | null;
  cantonalExcerptWeb?: string;
  purpose?: string;
  translation?: string[];
  address?: Record<string, unknown>;
  capitalNominal?: string;
  capitalCurrency?: string;
}

const LEGAL_FORMS: Record<number, string> = {
  1: "Sole proprietorship",
  2: "General partnership",
  3: "Limited partnership",
  4: "Partnership limited by shares",
  5: "Company limited by shares (AG/SA)",
  6: "Limited liability company (GmbH/Sàrl)",
  7: "Foundation",
  8: "Cooperative",
  9: "Association",
  10: "Institute of public law",
  11: "Branch",
  12: "Branch of foreign company",
  13: "Special legal form",
  15: "Public sector institution",
  16: "Corporation under cantonal law",
  17: "Non-commercial power of attorney",
  18: "Public institute",
};

function statusLabel(status?: string): string {
  if (status === "EXISTIEREND") return "active";
  if (status === "GELOESCHT") return "deleted";
  if (status === "IN_AUFLOESUNG") return "in liquidation";
  return status ?? "unknown";
}

function compactFirm(f: ZefixFirm) {
  return {
    name: f.name,
    uid: f.uidFormatted ?? f.uid,
    chid: f.chidFormatted,
    ehraid: f.ehraid,
    status: statusLabel(f.status),
    legal_form: f.legalFormId ? (LEGAL_FORMS[f.legalFormId] ?? `form ${f.legalFormId}`) : undefined,
    legal_seat: f.legalSeat,
    last_sogc_date: f.shabDate,
    delete_date: f.deleteDate ?? undefined,
    cantonal_excerpt_url: f.cantonalExcerptWeb,
  };
}

async function searchFirms(name: string, maxEntries: number, offset = 0, canton?: string) {
  return fetchJson<{ list?: ZefixFirm[]; hasMoreResults?: boolean; maxOffset?: number }>(
    `${ZEFIX_BASE}/firm/search.json`,
    {
      ttlMs: zefix.cacheTtlSeconds * 1000,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, maxEntries, offset, ...(canton ? { canton: canton.toUpperCase() } : {}) }),
      },
    },
  );
}

const CANTONS: Record<string, string> = {
  AG: "Aargau", AI: "Appenzell Innerrhoden", AR: "Appenzell Ausserrhoden", BE: "Bern", BL: "Basel-Landschaft",
  BS: "Basel-Stadt", FR: "Fribourg", GE: "Genève", GL: "Glarus", GR: "Graubünden", JU: "Jura", LU: "Luzern",
  NE: "Neuchâtel", NW: "Nidwalden", OW: "Obwalden", SG: "St. Gallen", SH: "Schaffhausen", SO: "Solothurn",
  SZ: "Schwyz", TG: "Thurgau", TI: "Ticino", UR: "Uri", VD: "Vaud", VS: "Valais", ZG: "Zug", ZH: "Zürich",
};

export const companiesModule: SwissyphusModule = {
  id: "companies",
  emoji: "🏢",
  title: "Companies (ZEFIX + SOGC)",
  description: "Search the Swiss commercial register, company details by UID, gazette publications",
  sources: [zefix, sogc],
  healthProbes: [
    {
      sourceId: "zefix",
      url: `${ZEFIX_BASE}/firm/search.json`,
      method: "POST",
      body: JSON.stringify({ name: "Migros", maxEntries: 1, offset: 0 }),
      headers: { "Content-Type": "application/json" },
    },
    {
      sourceId: "sogc",
      url: "https://amtsblattportal.ch/api/v1/publications?publicationStates=PUBLISHED&rubrics=HR&pageRequest.size=1",
      headers: { Accept: "application/json" },
    },
  ],
  tools: [
    tool({
      name: "search_companies",
      title: "Search Swiss companies",
      description:
        "Search the Swiss commercial register (ZEFIX, 700k+ entities) by company name. Returns UID, legal form, seat, status and a link to the cantonal register excerpt. Also accepts a UID like 'CHE-123.456.789' as query.",
      inputSchema: {
        query: z.string().min(2).describe("Company name (or UID) to search for"),
        canton: z.string().length(2).optional().describe("Optional canton filter, e.g. 'ZH'"),
        limit: z.number().int().min(1).max(50).default(10),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
      },
      handler: async ({ query, canton, limit, offset }) => {
        try {
          const { data, cacheStatus, retrievedAt } = await searchFirms(query, limit, offset, canton);
          const list = (data.list ?? []).map(compactFirm);
          if (!list.length) {
            return toolError(`No companies found matching '${query}'.`, [
              "ZEFIX matches on registered names; try a shorter fragment or the legal name.",
            ]);
          }
          return respond(
            { results: list, has_more: data.hasMoreResults ?? false, offset, total_matches: data.maxOffset },
            { source: zefix, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "ZEFIX");
        }
      },
    }),

    tool({
      name: "get_company",
      title: "Get company details",
      description:
        "Full ZEFIX record for one company: purpose, translations, seat, status, legal form, SOGC date and register links. Identify the company by UID ('CHE-107.028.276'), exact name, or EHRAID number.",
      inputSchema: {
        identifier: z.string().describe("Company UID (CHE-…), exact name, or numeric EHRAID"),
      },
      handler: async ({ identifier }) => {
        try {
          let ehraid: number | undefined;
          if (/^\d+$/.test(identifier.trim())) {
            ehraid = Number(identifier.trim());
          } else {
            const { data } = await searchFirms(identifier.trim(), 3);
            const first = data.list?.[0];
            if (!first?.ehraid) {
              return toolError(`No company found for '${identifier}'.`, [
                "Use search_companies first to find the exact name or UID.",
              ]);
            }
            ehraid = first.ehraid;
          }
          const { data, cacheStatus, retrievedAt } = await fetchJson<ZefixFirm>(
            `${ZEFIX_BASE}/firm/${ehraid}.json`,
            { ttlMs: zefix.cacheTtlSeconds * 1000 },
          );
          return respond(
            {
              ...compactFirm(data),
              purpose: data.purpose,
              name_translations: data.translation,
              address: data.address,
              capital: data.capitalNominal
                ? `${data.capitalNominal} ${data.capitalCurrency ?? "CHF"}`
                : undefined,
            },
            {
              source: zefix,
              cacheStatus,
              retrievedAt,
              links: {
                zefix: `https://www.zefix.admin.ch/en/search/entity/list?name=${encodeURIComponent(data.name ?? "")}`,
                ...(data.cantonalExcerptWeb ? { cantonal_excerpt: data.cantonalExcerptWeb } : {}),
              },
            },
          );
        } catch (err) {
          return errorToResult(err, "ZEFIX");
        }
      },
    }),

    tool({
      name: "list_legal_forms",
      title: "List Swiss legal forms",
      description: "List the legal-form codes used in the Swiss commercial register (AG, GmbH, foundation, …).",
      inputSchema: {},
      handler: async () => {
        return respond(
          { legal_forms: Object.entries(LEGAL_FORMS).map(([id, name]) => ({ id: Number(id), name })) },
          { source: zefix, cacheStatus: "computed", retrievedAt: new Date().toISOString() },
        );
      },
    }),

    tool({
      name: "list_cantons",
      title: "List Swiss cantons",
      description: "All 26 Swiss cantons with their two-letter abbreviations (used as filters across Swissyphus tools).",
      inputSchema: {},
      handler: async () => {
        return respond(
          { cantons: Object.entries(CANTONS).map(([code, name]) => ({ code, name })) },
          { source: zefix, cacheStatus: "computed", retrievedAt: new Date().toISOString() },
        );
      },
    }),

    tool({
      name: "search_sogc_publications",
      title: "Search SOGC gazette publications",
      description:
        "Search official Swiss Official Gazette of Commerce (SOGC/SHAB) publications: commercial-register mutations (HR), bankruptcies (KK), debt enforcement, and more. Filter by keyword, rubric and date range.",
      inputSchema: {
        keyword: z.string().optional().describe("Free-text keyword, e.g. a company name"),
        rubric: z
          .enum(["HR", "KK", "LS", "NA", "SB", "AW", "ES", "IP", "AB", "UP"])
          .default("HR")
          .describe("Rubric: HR=commercial register, KK=bankruptcy, LS=debt call, ES=inheritance, …"),
        date_from: z.string().optional().describe("Earliest publication date YYYY-MM-DD"),
        date_to: z.string().optional().describe("Latest publication date YYYY-MM-DD"),
        limit: z.number().int().min(1).max(50).default(10),
      },
      handler: async ({ keyword, rubric, date_from, date_to, limit }) => {
        try {
          const url = withParams("https://amtsblattportal.ch/api/v1/publications", {
            publicationStates: "PUBLISHED",
            rubrics: rubric,
            keyword,
            "publicationDate.start": date_from,
            "publicationDate.end": date_to,
            "pageRequest.size": limit,
            "pageRequest.sortOrders": undefined,
          });
          const { data, cacheStatus, retrievedAt } = await fetchJson<{
            content?: Array<{
              meta?: {
                id?: string;
                publicationNumber?: string;
                publicationDate?: string;
                rubric?: string;
                subRubric?: string;
                language?: string;
                title?: Record<string, string>;
                registrationOffice?: { displayName?: string };
              };
            }>;
            total?: number;
          }>(url, { ttlMs: sogc.cacheTtlSeconds * 1000, init: { headers: { Accept: "application/json" } } });
          const publications = (data.content ?? []).map((p) => ({
            id: p.meta?.id,
            number: p.meta?.publicationNumber,
            date: p.meta?.publicationDate?.slice(0, 10),
            rubric: p.meta?.rubric,
            sub_rubric: p.meta?.subRubric,
            language: p.meta?.language,
            title: p.meta?.title,
            office: p.meta?.registrationOffice?.displayName,
            url: p.meta?.id ? `https://amtsblattportal.ch/#!/search/publications/detail/${p.meta.id}` : undefined,
          }));
          if (!publications.length) {
            return toolError("No SOGC publications matched the query.", [
              "Broaden the date range or drop the keyword; rubric HR covers register mutations, KK bankruptcies.",
            ]);
          }
          return respond(
            { total: data.total, publications },
            { source: sogc, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "SOGC gazette portal");
        }
      },
    }),
  ],
};
