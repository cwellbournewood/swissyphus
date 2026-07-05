/**
 * Parliament module — Curia Vista (the database of parliamentary proceedings)
 * via the official parlament.ch OData web service.
 */

import { z } from "zod";
import { fetchJson } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

const source: SourceManifest = {
  id: "parlament-ws",
  name: "Curia Vista — parliamentary proceedings database",
  operator: "Parliamentary Services of the Federal Assembly",
  url: "https://www.parlament.ch",
  licence: "Public parliamentary data — free use with attribution",
  attribution: "© Parliamentary Services, parlament.ch",
  updateFrequency: "daily during sessions",
  cacheTtlSeconds: 3600,
};

const BASE = "https://ws.parlament.ch/odata.svc";

const LANG = (l: string) => (["DE", "FR", "IT", "RM", "EN"].includes(l.toUpperCase()) ? l.toUpperCase() : "EN");

function odataUrl(entity: string, opts: { filter?: string; select?: string; top?: number; orderby?: string }): string {
  const params = new URLSearchParams();
  if (opts.filter) params.set("$filter", opts.filter);
  if (opts.select) params.set("$select", opts.select);
  if (opts.top) params.set("$top", String(opts.top));
  if (opts.orderby) params.set("$orderby", opts.orderby);
  params.set("$format", "json");
  return `${BASE}/${entity}?${params.toString()}`;
}

function escapeOData(s: string): string {
  return s.replace(/'/g, "''");
}

type ODataRow = Record<string, unknown>;

function rowsOf(data: unknown): ODataRow[] {
  const d = (data as { d?: unknown }).d;
  if (Array.isArray(d)) return d as ODataRow[];
  const results = (d as { results?: unknown })?.results;
  return Array.isArray(results) ? (results as ODataRow[]) : [];
}

function clean(row: ODataRow): ODataRow {
  const out: ODataRow = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "__metadata" || v === null || v === undefined) continue;
    if (typeof v === "object" && v !== null && "__deferred" in (v as object)) continue;
    // OData v2 dates: "/Date(1234567890000+0100)/". The epoch ms is UTC; the
    // trailing offset is the local zone. Apply it before taking the date part,
    // otherwise a value just after local midnight is reported a day early.
    if (typeof v === "string") {
      const m = v.match(/^\/Date\((\d+)([+-]\d{4})?\)\/$/);
      if (m) {
        let ms = Number(m[1]);
        if (m[2]) {
          const sign = m[2][0] === "-" ? -1 : 1;
          ms += sign * (Number(m[2].slice(1, 3)) * 60 + Number(m[2].slice(3, 5))) * 60_000;
        }
        out[k] = new Date(ms).toISOString().slice(0, 10);
      } else {
        out[k] = v;
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

export const parliamentModule: SwissyphusModule = {
  id: "parliament",
  emoji: "🏛️",
  title: "Parliament (Curia Vista)",
  description: "Federal parliamentary business, council members — official parlament.ch data",
  sources: [source],
  healthProbes: [
    { sourceId: "parlament-ws", url: odataUrl("Business", { top: 1, filter: "Language eq 'EN'" }) },
  ],
  tools: [
    tool({
      name: "search_parliament_business",
      title: "Search parliamentary business",
      description:
        "Search Curia Vista for federal parliamentary business (motions, postulates, interpellations, bills) by title keyword. Returns business number, type, status and submission date.",
      inputSchema: {
        query: z.string().min(2).describe("Keyword to search in business titles, e.g. 'Klimaschutz', 'AI'"),
        language: z.enum(["DE", "FR", "IT", "EN"]).default("DE").describe("Language of titles searched (DE has best coverage)"),
        limit: z.number().int().min(1).max(50).default(10),
      },
      handler: async ({ query, language, limit }) => {
        try {
          const l = LANG(language);
          const url = odataUrl("Business", {
            filter: `Language eq '${l}' and substringof('${escapeOData(query)}', Title)`,
            select: "ID,BusinessShortNumber,Title,BusinessTypeName,BusinessStatusText,SubmissionDate,SubmittedBy",
            orderby: "SubmissionDate desc",
            top: limit,
          });
          const { data, cacheStatus, retrievedAt } = await fetchJson<unknown>(url, {
            ttlMs: source.cacheTtlSeconds * 1000,
            timeoutMs: 30_000,
          });
          const rows = rowsOf(data).map(clean);
          if (!rows.length) {
            return toolError(`No parliamentary business found for '${query}' in ${l}.`, [
              "Most titles are German — try language='DE' with a German keyword.",
            ]);
          }
          const results = rows.map((r) => ({
            ...r,
            curia_vista_url: r["ID"]
              ? `https://www.parlament.ch/en/ratsbetrieb/suche-curia-vista/geschaeft?AffairId=${r["ID"]}`
              : undefined,
          }));
          return respond({ results }, { source, cacheStatus, retrievedAt, language: l.toLowerCase() });
        } catch (err) {
          return errorToResult(err, "parlament.ch web services");
        }
      },
    }),

    tool({
      name: "get_parliament_business",
      title: "Get one parliamentary business",
      description: "Details of a specific Curia Vista business by its numeric ID (e.g. 20230456 → ID from search).",
      inputSchema: {
        id: z.number().int().describe("Business ID, e.g. 20230456"),
        language: z.enum(["DE", "FR", "IT", "EN"]).default("EN"),
      },
      handler: async ({ id, language }) => {
        try {
          const l = LANG(language);
          const url = odataUrl("Business", {
            filter: `ID eq ${id} and Language eq '${l}'`,
            select:
              "ID,BusinessShortNumber,Title,BusinessTypeName,BusinessStatusText,SubmissionDate,SubmittedBy,Description,InitialSituation,FederalCouncilResponseText",
            top: 1,
          });
          const { data, cacheStatus, retrievedAt } = await fetchJson<unknown>(url, {
            ttlMs: source.cacheTtlSeconds * 1000,
            timeoutMs: 30_000,
          });
          const row = rowsOf(data).map(clean)[0];
          if (!row) return toolError(`Business ${id} not found in language ${l}.`);
          // Strip HTML from long text fields for token efficiency.
          for (const k of ["Description", "InitialSituation", "FederalCouncilResponseText"]) {
            if (typeof row[k] === "string") {
              row[k] = (row[k] as string).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 3000);
            }
          }
          return respond(
            {
              ...row,
              curia_vista_url: `https://www.parlament.ch/en/ratsbetrieb/suche-curia-vista/geschaeft?AffairId=${id}`,
            },
            { source, cacheStatus, retrievedAt, language: l.toLowerCase() },
          );
        } catch (err) {
          return errorToResult(err, "parlament.ch web services");
        }
      },
    }),

    tool({
      name: "get_session_schedule",
      title: "Parliament session schedule",
      description: "Recent and upcoming sessions of the Federal Assembly with dates and names.",
      inputSchema: {
        limit: z.number().int().min(1).max(20).default(6),
      },
      handler: async ({ limit }) => {
        try {
          const url = odataUrl("Session", {
            filter: "Language eq 'DE'",
            select: "ID,SessionNumber,SessionName,Abbreviation,StartDate,EndDate,TypeName,LegislativePeriodNumber",
            orderby: "StartDate desc",
            top: limit,
          });
          const { data, cacheStatus, retrievedAt } = await fetchJson<unknown>(url, {
            ttlMs: source.cacheTtlSeconds * 1000,
            timeoutMs: 30_000,
          });
          const rows = rowsOf(data).map(clean);
          if (!rows.length) return toolError("No sessions returned.");
          return respond({ sessions: rows }, { source, cacheStatus, retrievedAt });
        } catch (err) {
          return errorToResult(err, "parlament.ch web services");
        }
      },
    }),

    tool({
      name: "get_parliament_votes",
      title: "Council votes on a business",
      description:
        "Formal council votes for a parliamentary business (by short number like '23.4567'), including the subject, what yes/no meant, and the actual yes/no/abstain tallies of the most recent vote.",
      inputSchema: {
        business_short_number: z
          .string()
          .regex(/^\d{2}\.\d{1,4}$/)
          .describe("Business short number, e.g. '23.4567' (from search_parliament_business)"),
        limit: z.number().int().min(1).max(10).default(3).describe("Max votes to list"),
      },
      handler: async ({ business_short_number, limit }) => {
        try {
          const url = odataUrl("Vote", {
            filter: `Language eq 'DE' and BusinessShortNumber eq '${escapeOData(business_short_number)}'`,
            select: "ID,RegistrationNumber,BusinessShortNumber,BusinessTitle,Subject,MeaningYes,MeaningNo,VoteEnd",
            orderby: "VoteEnd desc",
            top: limit,
          });
          const { data, cacheStatus, retrievedAt } = await fetchJson<unknown>(url, {
            ttlMs: source.cacheTtlSeconds * 1000,
            timeoutMs: 30_000,
          });
          const votes = rowsOf(data).map(clean);
          if (!votes.length) {
            return toolError(`No formal votes found for business ${business_short_number}.`, [
              "Not every business reaches a recorded vote; check the business status first.",
            ]);
          }
          // Tally the individual MP votes for the most recent vote.
          const first = votes[0];
          let tally: Record<string, number> | undefined;
          if (first && typeof first["ID"] === "number") {
            const vUrl = odataUrl("Voting", {
              filter: `Language eq 'DE' and IdVote eq ${first["ID"]}`,
              select: "Decision",
              top: 300,
            });
            const { data: vData } = await fetchJson<unknown>(vUrl, {
              ttlMs: source.cacheTtlSeconds * 1000,
              timeoutMs: 30_000,
            });
            const decisions = rowsOf(vData).map((r) => Number(r["Decision"]));
            if (decisions.length) {
              const MEANING: Record<number, string> = { 1: "yes", 2: "no", 3: "abstain", 4: "did_not_vote", 5: "excused", 6: "president_no_vote", 7: "absent" };
              tally = {};
              for (const d of decisions) {
                const key = MEANING[d] ?? `code_${d}`;
                tally[key] = (tally[key] ?? 0) + 1;
              }
            }
          }
          return respond(
            { business: business_short_number, votes, latest_vote_tally: tally },
            { source, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "parlament.ch web services");
        }
      },
    }),

    tool({
      name: "search_council_members",
      title: "Search Federal Assembly members",
      description:
        "Search current members of the National Council and Council of States by name, canton or party.",
      inputSchema: {
        name: z.string().optional().describe("Last-name fragment"),
        canton: z.string().optional().describe("Canton abbreviation, e.g. 'ZH'"),
        active_only: z.boolean().default(true),
        limit: z.number().int().min(1).max(60).default(15),
      },
      handler: async ({ name, canton, active_only, limit }) => {
        try {
          const filters = ["Language eq 'DE'"];
          if (active_only) filters.push("Active eq true");
          if (name) filters.push(`substringof('${escapeOData(name)}', LastName)`);
          if (canton) filters.push(`CantonAbbreviation eq '${escapeOData(canton.toUpperCase())}'`);
          const url = odataUrl("MemberCouncil", {
            filter: filters.join(" and "),
            select:
              "ID,FirstName,LastName,PartyAbbreviation,CantonAbbreviation,CouncilAbbreviation,Active,GenderAsString,DateJoining",
            top: limit,
          });
          const { data, cacheStatus, retrievedAt } = await fetchJson<unknown>(url, {
            ttlMs: source.cacheTtlSeconds * 1000,
            timeoutMs: 30_000,
          });
          const rows = rowsOf(data).map(clean);
          if (!rows.length) return toolError("No council members matched the filters.");
          return respond({ members: rows }, { source, cacheStatus, retrievedAt });
        } catch (err) {
          return errorToResult(err, "parlament.ch web services");
        }
      },
    }),
  ],
};
