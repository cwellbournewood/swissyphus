/**
 * Parliament module — Curia Vista (the database of parliamentary proceedings)
 * via the official parlament.ch OData web service.
 *
 * Covers business, votes, sessions, council members, plus speeches
 * (Amtliches Bulletin transcripts), declared interests (lobbying
 * transparency), committees and parliamentary groups.
 */

import { z } from "zod";
import { allowHosts, fetchJson } from "../core/http.js";
import { isoWithOffset, zurichIso } from "./weather.js";
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
  notes:
    "OData service at ws.parlament.ch/odata.svc. Speech search uses the Transcript set (substringof on Text is case-sensitive and a full scan — keep a date range or speaker). Interests come from PersonInterest; the paid/unpaid flag is surfaced only if the service exposes such a field. Committees and group counts are derived client-side from Committee / MemberCommittee / MemberCouncil; field names for these sets and the Amtliches Bulletin SubjectId link are best-knowledge and not verified live.",
};

allowHosts("ws.parlament.ch");

const BASE = "https://ws.parlament.ch/odata.svc";

const LANG = (l: string) => (["DE", "FR", "IT", "RM", "EN"].includes(l.toUpperCase()) ? l.toUpperCase() : "EN");

export function odataUrl(entity: string, opts: { filter?: string; select?: string; top?: number; orderby?: string }): string {
  const params = new URLSearchParams();
  if (opts.filter) params.set("$filter", opts.filter);
  if (opts.select) params.set("$select", opts.select);
  if (opts.top) params.set("$top", String(opts.top));
  if (opts.orderby) params.set("$orderby", opts.orderby);
  params.set("$format", "json");
  return `${BASE}/${entity}?${params.toString()}`;
}

export function escapeOData(s: string): string {
  return s.replace(/'/g, "''");
}

/** Case-insensitive OData v2 substring filter (substringof is case-sensitive on its own). */
export function containsCI(field: string, value: string): string {
  return `substringof(tolower('${escapeOData(value)}'), tolower(${field}))`;
}

/** Case-insensitive OData v2 equality filter. */
export function equalsCI(field: string, value: string): string {
  return `tolower(${field}) eq tolower('${escapeOData(value)}')`;
}

export type ODataRow = Record<string, unknown>;

export function rowsOf(data: unknown): ODataRow[] {
  const d = (data as { d?: unknown }).d;
  if (Array.isArray(d)) return d as ODataRow[];
  const results = (d as { results?: unknown })?.results;
  return Array.isArray(results) ? (results as ODataRow[]) : [];
}

/** Fields whose time of day matters; all other /Date()/ fields are reported as a date. */
const TIMESTAMP_FIELDS = new Set(["VoteEnd", "VoteStart", "Modified"]);

/**
 * Parse an OData v2 JSON date: "/Date(1234567890000)/" or
 * "/Date(1234567890000+0100)/" (epoch ms may be negative for pre-1970
 * dates, e.g. members' birth dates). The epoch ms is UTC; a trailing ±hhmm is
 * the local offset. Without an offset the value is rendered in Swiss local
 * time (Europe/Zurich), so a value at local midnight keeps its local date.
 * Returns ISO date ("2023-03-14") or, with keepTime, ISO date-time with
 * offset ("2023-03-14T10:12:33+01:00"). Undefined if not an OData date.
 */
export function parseODataDate(v: string, keepTime = false): string | undefined {
  const m = v.match(/^\/Date\((-?\d+)([+-])?(\d{2})?(\d{2})?\)\/$/);
  if (!m) return undefined;
  const ms = Number(m[1]);
  if (!Number.isFinite(ms)) return undefined;
  if (m[2] && m[3] !== undefined && m[4] !== undefined) {
    const offset = (m[2] === "-" ? -1 : 1) * (Number(m[3]) * 60 + Number(m[4]));
    return isoWithOffset(ms, offset, keepTime);
  }
  return zurichIso(ms, keepTime);
}

export function clean(row: ODataRow): ODataRow {
  const out: ODataRow = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "__metadata" || v === null || v === undefined) continue;
    if (typeof v === "object" && v !== null && "__deferred" in (v as object)) continue;
    if (typeof v === "string") {
      out[k] = parseODataDate(v, TIMESTAMP_FIELDS.has(k)) ?? v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ── Shared helpers for the extended tools ────────────────────────────────

const HTTP_OPTS = { ttlMs: source.cacheTtlSeconds * 1000, timeoutMs: 30_000 };

async function odata(entity: string, opts: Parameters<typeof odataUrl>[1], timeoutMs = 30_000) {
  const { data, cacheStatus, retrievedAt } = await fetchJson<unknown>(odataUrl(entity, opts), { ...HTTP_OPTS, timeoutMs });
  return { rows: rowsOf(data).map(clean), cacheStatus, retrievedAt };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Strip HTML/XML markup from a Curia Vista text field and collapse whitespace. */
export function htmlToText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Plain-text excerpt of at most `max` chars. When `keyword` occurs (case-
 * insensitive) the window is centred on its first occurrence.
 */
export function excerptAround(text: string, keyword: string | undefined, max: number): string {
  if (text.length <= max) return text;
  let start = 0;
  if (keyword) {
    const i = text.toLowerCase().indexOf(keyword.toLowerCase());
    if (i > 0) start = Math.max(0, Math.min(i - Math.floor(max / 3), text.length - max));
  }
  const slice = text.slice(start, start + max).trim();
  return `${start > 0 ? "… " : ""}${slice}${start + max < text.length ? " …" : ""}`;
}

/** First non-empty value among candidate field names (field names vary across sets). */
export function pick(row: ODataRow, keys: string[]): unknown {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")) as Partial<T>;
}

/**
 * OData numeric literal for a key value read back from the service. OData v2
 * JSON serialises Edm.Int64 as a string, which must be sent back with an `L`
 * suffix; Int32 values arrive as numbers. Returns undefined for anything else.
 */
export function odataNumberLiteral(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isInteger(v)) return String(v);
  if (typeof v === "string" && /^\d{1,19}$/.test(v)) return `${v}L`;
  return undefined;
}

/** OData v2 DateTime literal from a YYYY-MM-DD date. */
export function odataDateTime(date: string, endOfDay = false): string {
  return `datetime'${date}T${endOfDay ? "23:59:59" : "00:00:00"}'`;
}

const BULLETIN = "https://www.parlament.ch/de/ratsbetrieb/amtliches-bulletin/amtliches-bulletin-die-verhandlungen";

/** Normalise one Transcript row into a compact speech record. */
export function normaliseSpeech(row: ODataRow, keyword: string | undefined, maxChars: number): Record<string, unknown> {
  const text = typeof row["Text"] === "string" ? htmlToText(row["Text"] as string) : "";
  const subject = row["IdSubject"];
  const speaker =
    pick(row, ["SpeakerFullName"]) ??
    ([row["SpeakerFirstName"], row["SpeakerLastName"]].filter(Boolean).join(" ") || undefined);
  return compact({
    id: row["ID"],
    speaker,
    person_number: row["PersonNumber"],
    speaker_function: pick(row, ["SpeakerFunction", "Function"]),
    parl_group: pick(row, ["ParlGroupAbbreviation", "ParlGroupName"]),
    canton: pick(row, ["CantonAbbreviation", "CantonName"]),
    council: pick(row, ["CouncilName", "MeetingCouncilAbbreviation"]),
    date: normaliseMeetingDate(pick(row, ["MeetingDate", "Start"])),
    session_id: row["IdSession"],
    subject_id: subject,
    vote_business: row["VoteBusinessShortNumber"]
      ? compact({ short_number: row["VoteBusinessShortNumber"], title: row["VoteBusinessTitle"] })
      : undefined,
    text_length: text.length,
    excerpt: text ? excerptAround(text, keyword, maxChars) : undefined,
    bulletin_url:
      subject !== undefined && /^\d+$/.test(String(subject)) ? `${BULLETIN}?SubjectId=${subject}` : undefined,
  });
}

/** MeetingDate may be 'YYYYMMDD' (string) or an already-cleaned ISO date. */
export function normaliseMeetingDate(v: unknown): unknown {
  if (typeof v === "string" && /^\d{8}$/.test(v)) return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  return v;
}

/** Normalise one PersonInterest row (declared interest / mandate). */
export function normaliseInterest(row: ODataRow): Record<string, unknown> {
  // The paid/unpaid disclosure (mandatory since the 2022 rules) is exposed
  // under a field name we could not verify; surface any plausible candidate.
  let paid: unknown;
  for (const [k, v] of Object.entries(row)) {
    if (/paid|bezahl|remuner|entgelt|verg[uü]t/i.test(k) && v !== undefined && v !== null && v !== "") {
      paid = typeof v === "number" && (v === 0 || v === 1) ? v === 1 : v;
      break;
    }
  }
  return compact({
    organisation: pick(row, ["InterestName", "OrganizationName"]),
    function: pick(row, ["FunctionInAgencyText", "FunctionInAgencyShortText"]),
    interest_type: pick(row, ["InterestTypeText", "InterestTypeShortText"]),
    organisation_type: pick(row, ["OrganizationTypeText", "OrganizationTypeShortText"]),
    paid,
  });
}

/** Normalise one PersonOccupation row. */
export function normaliseOccupation(row: ODataRow): Record<string, unknown> {
  return compact({
    occupation: pick(row, ["OccupationName", "Occupation"]),
    employer: pick(row, ["Employer"]),
    job_title: pick(row, ["JobTitle"]),
    start: pick(row, ["StartDate"]),
    end: pick(row, ["EndDate"]),
  });
}

function isPast(v: unknown): boolean {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v)) return false;
  return v.slice(0, 10) < new Date().toISOString().slice(0, 10);
}

/** Which chamber a row belongs to: NR (National Council), SR (Council of States), BV (United Assembly). */
export function councilOf(row: ODataRow): "NR" | "SR" | "BV" | undefined {
  const abbr = String(pick(row, ["CouncilAbbreviation"]) ?? "").toUpperCase();
  if (["NR", "CN"].includes(abbr)) return "NR";
  if (["SR", "CE", "CS"].includes(abbr)) return "SR";
  if (["VB", "BV", "AF", "VBV"].includes(abbr)) return "BV";
  const id = pick(row, ["Council", "CouncilId", "IdCouncil"]);
  if (id === 1 || id === "1") return "NR";
  if (id === 2 || id === "2") return "SR";
  if (id === 3 || id === "3") return "BV";
  const name = String(pick(row, ["CouncilName"]) ?? "").toLowerCase();
  if (/national/.test(name)) return "NR";
  if (/stände|etats|états|stati/.test(name)) return "SR";
  const cabbr = String(pick(row, ["Abbreviation1", "Abbreviation"]) ?? "").toUpperCase();
  if (/-N$/.test(cabbr)) return "NR";
  if (/-S$/.test(cabbr)) return "SR";
  return undefined;
}

/** Normalise one Committee row. */
export function normaliseCommittee(row: ODataRow): Record<string, unknown> {
  return compact({
    committee_number: pick(row, ["CommitteeNumber", "ID"]),
    name: pick(row, ["CommitteeName", "Name"]),
    abbreviation: pick(row, ["Abbreviation1", "Abbreviation", "Abbreviation2"]),
    council: councilOf(row),
    type: pick(row, ["CommitteeTypeName", "CommitteeTypeAbbreviation", "CommitteeType"]),
    main_committee_number: row["MainCommitteeNumber"],
    start: pick(row, ["StartDate", "DateStart"]),
    end: pick(row, ["EndDate", "DateEnd"]),
  });
}

/** True when a committee/membership row is still current (no end date in the past). */
export function isCurrent(row: ODataRow): boolean {
  if (row["Active"] === false || row["IsActive"] === false) return false;
  return !isPast(pick(row, ["EndDate", "DateEnd", "DateLeaving"]));
}

/** Resolve a committee reference (number, abbreviation like 'WAK-N', or name fragment) against Committee rows. */
export function matchCommittees(rows: ODataRow[], ref: string): ODataRow[] {
  const r = ref.trim().toLowerCase();
  if (/^\d+$/.test(r)) return rows.filter((c) => String(pick(c, ["CommitteeNumber", "ID"])) === r);
  const abbrs = (c: ODataRow) =>
    ["Abbreviation1", "Abbreviation2", "Abbreviation"].map((k) => String(c[k] ?? "").toLowerCase()).filter(Boolean);
  const exact = rows.filter((c) => abbrs(c).includes(r));
  if (exact.length) return exact;
  return rows.filter(
    (c) =>
      abbrs(c).some((a) => a.startsWith(r)) ||
      String(pick(c, ["CommitteeName", "Name"]) ?? "").toLowerCase().includes(r),
  );
}

/** Normalise one MemberCommittee row. */
export function normaliseCommitteeMember(row: ODataRow): Record<string, unknown> {
  return compact({
    person_number: pick(row, ["PersonNumber", "PersonIdCode"]),
    name: [row["FirstName"], row["LastName"]].filter(Boolean).join(" ") || undefined,
    function: pick(row, ["CommitteeFunctionName", "CommitteeFunction", "Function"]),
    party: pick(row, ["PartyAbbreviation", "PartyName"]),
    parl_group: pick(row, ["ParlGroupAbbreviation", "ParlGroupName"]),
    canton: pick(row, ["CantonAbbreviation", "CantonName"]),
    council: councilOf(row),
  });
}

export interface GroupCount {
  abbreviation: string;
  name?: string;
  number?: unknown;
  total: number;
  by_council: Record<string, number>;
  breakdown?: Record<string, number>;
}

/**
 * Aggregate active MemberCouncil rows into parliamentary groups (factions) or
 * parties with seat counts per chamber, sorted by size.
 */
export function aggregateGroups(members: ODataRow[], by: "parl_group" | "party"): GroupCount[] {
  const keyF = by === "parl_group" ? ["ParlGroupAbbreviation", "ParlGroupName"] : ["PartyAbbreviation", "PartyName"];
  const nameF = by === "parl_group" ? "ParlGroupName" : "PartyName";
  const numF = by === "parl_group" ? "ParlGroupNumber" : "PartyNumber";
  const subF = by === "parl_group" ? ["PartyAbbreviation"] : ["ParlGroupAbbreviation"];
  const groups = new Map<string, GroupCount>();
  for (const m of members) {
    const key = String(pick(m, keyF) ?? "(none)");
    let g = groups.get(key);
    if (!g) {
      g = { abbreviation: key, total: 0, by_council: {} };
      const name = m[nameF];
      if (typeof name === "string" && name) g.name = name;
      if (m[numF] !== undefined) g.number = m[numF];
      groups.set(key, g);
    }
    g.total++;
    const c = councilOf(m) ?? "other";
    g.by_council[c] = (g.by_council[c] ?? 0) + 1;
    const sub = pick(m, subF);
    if (sub !== undefined) {
      g.breakdown ??= {};
      const s = String(sub);
      g.breakdown[s] = (g.breakdown[s] ?? 0) + 1;
    }
  }
  return [...groups.values()].sort((a, b) => b.total - a.total || a.abbreviation.localeCompare(b.abbreviation));
}

/** Dedupe member rows by person, preferring the active membership; active persons first. */
export function dedupeMembers(rows: ODataRow[]): ODataRow[] {
  const byPerson = new Map<string, ODataRow>();
  for (const r of rows) {
    const id = String(pick(r, ["PersonNumber", "ID"]) ?? "");
    if (!id) continue;
    const prev = byPerson.get(id);
    if (!prev || (r["Active"] === true && prev["Active"] !== true)) byPerson.set(id, r);
  }
  return [...byPerson.values()].sort((a, b) => Number(b["Active"] === true) - Number(a["Active"] === true));
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/** Longest date span a keyword (full-text substringof) speech search may cover. */
export const KEYWORD_MAX_SPAN_DAYS = 730;

/**
 * Keyword search runs substringof() over transcript text, i.e. a scan of every
 * speech in the window: clamp the window to ≤ 2 years ending at date_to
 * (default today), moving date_from forward if needed.
 */
export function clampKeywordWindow(
  dateFrom: string | undefined,
  dateTo: string | undefined,
  today = new Date().toISOString().slice(0, 10),
): { from: string; note?: string } {
  const end = dateTo ?? today;
  const endMs = Date.parse(`${end}T00:00:00Z`);
  const earliest = new Date(endMs - KEYWORD_MAX_SPAN_DAYS * 86_400_000).toISOString().slice(0, 10);
  if (!dateFrom) {
    return {
      from: earliest,
      note: `Keyword search limited to meetings from ${earliest} to ${end} (max 2 years); pass date_from/date_to to search another window.`,
    };
  }
  if (dateFrom < earliest) {
    return {
      from: earliest,
      note: `date_from moved from ${dateFrom} to ${earliest}: keyword searches cover at most 2 years (up to ${end}). To search earlier, set date_to as well (e.g. date_from '${dateFrom}', date_to within 2 years of it).`,
    };
  }
  return { from: dateFrom };
}

export const parliamentModule: SwissyphusModule = {
  id: "parliament",
  emoji: "🏛️",
  title: "Parliament (Curia Vista)",
  description:
    "Federal parliamentary business, votes, speeches, council members, declared interests, committees and parliamentary groups — official parlament.ch data",
  sources: [source],
  healthProbes: [
    { sourceId: "parlament-ws", url: odataUrl("Business", { top: 1, filter: "Language eq 'EN'" }) },
  ],
  tools: [
    tool({
      name: "search_parliament_business",
      title: "Search parliamentary business",
      description:
        "Search Curia Vista for federal parliamentary business (motions, postulates, interpellations, bills) by title keyword (case-insensitive). Returns business number, type, status and submission date.",
      inputSchema: {
        query: z.string().min(2).describe("Keyword to search in business titles, e.g. 'Klimaschutz', 'AI'"),
        language: z.enum(["DE", "FR", "IT", "EN"]).default("DE").describe("Language of titles searched (DE has best coverage)"),
        limit: z.number().int().min(1).max(50).default(10),
      },
      handler: async ({ query, language, limit }) => {
        try {
          const l = LANG(language);
          const url = odataUrl("Business", {
            filter: `Language eq '${l}' and ${containsCI("Title", query)}`,
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
        "Search members of the National Council and Council of States (current by default) by last name (case-insensitive fragment), canton or party abbreviation.",
      inputSchema: {
        name: z.string().optional().describe("Last-name fragment (case-insensitive)"),
        canton: z.string().optional().describe("Canton abbreviation, e.g. 'ZH'"),
        party: z
          .string()
          .optional()
          .describe("Party abbreviation as used in German, case-insensitive, e.g. 'SVP', 'SP', 'FDP-Liberale', 'M-E', 'GRÜNE', 'glp'"),
        active_only: z.boolean().default(true),
        limit: z.number().int().min(1).max(60).default(15),
      },
      handler: async ({ name, canton, party, active_only, limit }) => {
        try {
          const filters = ["Language eq 'DE'"];
          if (active_only) filters.push("Active eq true");
          if (name) filters.push(containsCI("LastName", name));
          if (canton) filters.push(`CantonAbbreviation eq '${escapeOData(canton.toUpperCase())}'`);
          if (party) filters.push(equalsCI("PartyAbbreviation", party));
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
    tool({
      name: "search_parliament_speeches",
      title: "Search parliamentary speeches (Amtliches Bulletin)",
      description:
        "Search the verbatim record of speeches in the National Council and Council of States (Amtliches Bulletin transcripts) by speaker and/or keyword, optionally within a date range or session. Returns speaker, function, parliamentary group, canton, council, date, the business debated (short number + title when resolvable), a plain-text excerpt centred on the keyword, and a link to the official Bulletin debate. Keyword matching is case-sensitive and matches the speech's original language (e.g. 'Klimaschutz', 'Neutralität', 'intelligence artificielle'). Examples: {speaker:'Noser', keyword:'Datenschutz'}; {keyword:'Kita', date_from:'2024-01-01'}; {person_number:4057}. Speaker names come from search_council_members.",
      inputSchema: {
        speaker: z.string().min(2).optional().describe("Fragment of the speaker's full name, e.g. 'Noser', 'Funiciello'"),
        person_number: z.number().int().positive().optional().describe("Exact PersonNumber of a council member (from search_council_members ID)"),
        keyword: z
          .string()
          .min(3)
          .optional()
          .describe("Case-sensitive word/phrase in the speech text, in the language it was spoken, e.g. 'Klimaschutz'"),
        date_from: DATE.optional().describe("Earliest meeting date, YYYY-MM-DD"),
        date_to: DATE.optional().describe("Latest meeting date, YYYY-MM-DD"),
        session_id: z.number().int().positive().optional().describe("Session ID from get_session_schedule (field ID)"),
        language: z.enum(["DE", "FR", "IT"]).default("DE").describe("Language of labels such as council name (speech text stays in its original language)"),
        excerpt_chars: z.number().int().min(100).max(2000).default(500).describe("Max characters of speech text per result"),
        limit: z.number().int().min(1).max(30).default(10),
      },
      handler: async ({ speaker, person_number, keyword, date_from, date_to, session_id, language, excerpt_chars, limit }) => {
        if (!speaker && !person_number && !keyword) {
          return toolError("Give at least one of 'speaker', 'person_number' or 'keyword'.", [
            "Example: {speaker:'Noser', keyword:'Datenschutz'}",
            "Find a member's person number with search_council_members (field ID).",
          ]);
        }
        const l = LANG(language);
        const filters = [`Language eq '${l}'`];
        if (speaker) filters.push(`substringof('${escapeOData(speaker)}', SpeakerFullName)`);
        if (person_number) filters.push(`PersonNumber eq ${person_number}`);
        if (keyword) filters.push(`substringof('${escapeOData(keyword)}', Text)`);
        if (session_id) filters.push(`IdSession eq ${session_id}`);
        let from = date_from;
        let note: string | undefined;
        if (date_from && date_to && date_from > date_to) {
          return toolError("date_from is after date_to.", ["Swap the dates."]);
        }
        // A full-text scan over decades of transcripts risks an upstream
        // timeout, so keyword searches are clamped to a ≤ 2-year window —
        // whatever date_from says. A session (≈3 weeks) already bounds the scan.
        if (keyword && !(session_id && !date_from && !date_to)) {
          const w = clampKeywordWindow(date_from, date_to);
          from = w.from;
          note = w.note;
        }
        if (from) filters.push(`Start ge ${odataDateTime(from)}`);
        if (date_to) filters.push(`Start le ${odataDateTime(date_to, true)}`);
        try {
          const { rows, cacheStatus, retrievedAt } = await odata(
            "Transcript",
            { filter: filters.join(" and "), orderby: "Start desc", top: limit },
            45_000,
          );
          const seen = new Set<string>();
          const unique = rows.filter((r) => {
            if (r["ID"] === undefined) return true;
            const k = String(r["ID"]);
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
          if (!unique.length) {
            return toolError("No speeches matched.", [
              "Keyword matching is case-sensitive and in the original language: try 'Klimaschutz' rather than 'klimaschutz'.",
              "Widen or drop the date range; speaker matches a fragment of the full name (e.g. 'Noser').",
            ]);
          }
          const speeches = unique.map((r) => normaliseSpeech(r, keyword, excerpt_chars));

          // Best-effort: resolve which business each agenda item (subject) was about.
          const subjectLits = [...new Set(unique.map((r) => odataNumberLiteral(r["IdSubject"])).filter((x): x is string => !!x))];
          if (subjectLits.length) {
            try {
              const { rows: sb } = await odata("SubjectBusiness", {
                filter: `Language eq '${l}' and (${subjectLits.map((s) => `IdSubject eq ${s}`).join(" or ")})`,
                top: 200,
              });
              const bySubject = new Map<string, Array<Record<string, unknown>>>();
              for (const b of sb) {
                const key = String(b["IdSubject"]);
                const list = bySubject.get(key) ?? [];
                list.push(compact({ short_number: b["BusinessShortNumber"], title: pick(b, ["Title", "BusinessTitle"]), business_id: b["BusinessNumber"] }));
                bySubject.set(key, list);
              }
              for (const s of speeches) {
                const list = bySubject.get(String(s["subject_id"]));
                if (list?.length) s["business"] = list.slice(0, 3);
              }
            } catch {
              // Enrichment is optional; speeches are still useful without it.
            }
          }
          return respond(
            { count: speeches.length, speeches },
            { source, cacheStatus, retrievedAt, language: l.toLowerCase(), ...(note ? { notes: note } : {}) },
          );
        } catch (err) {
          return errorToResult(err, "parlament.ch web services");
        }
      },
    }),

    tool({
      name: "get_member_interests",
      title: "Declared interests of a council member",
      description:
        "Lobbying transparency: the declared interests and mandates of a member of the Federal Assembly (board seats, advisory roles, associations, foundations) with the organisation, the member's function, the type of interest and organisation, and paid/unpaid where published — plus declared occupations. Look up by last name (e.g. 'Noser', optionally first_name) or exact person_number (ID from search_council_members). Examples: {name:'Bregy'}; {name:'Müller', first_name:'Damian'}; {person_number:4057}.",
      inputSchema: {
        name: z.string().min(2).optional().describe("Last name (or fragment), e.g. 'Noser'"),
        first_name: z.string().min(2).optional().describe("First name to disambiguate common surnames"),
        person_number: z.number().int().positive().optional().describe("Exact PersonNumber (ID from search_council_members)"),
        include_occupations: z.boolean().default(true).describe("Also return declared occupations/employers"),
        language: z.enum(["DE", "FR", "IT"]).default("DE"),
        limit: z.number().int().min(1).max(100).default(60),
      },
      handler: async ({ name, first_name, person_number, include_occupations, language, limit }) => {
        if (!name && !person_number) {
          return toolError("Give 'name' (last name) or 'person_number'.", ["Example: {name:'Noser'}"]);
        }
        const l = LANG(language);
        try {
          let member: ODataRow | undefined;
          let pn: string | undefined = person_number ? String(person_number) : undefined;
          if (!pn && name) {
            const base = [`Language eq '${l}'`];
            if (first_name) base.push(`substringof('${escapeOData(first_name)}', FirstName)`);
            let { rows } = await odata("MemberCouncil", {
              filter: [...base, `substringof('${escapeOData(name)}', LastName)`].join(" and "),
              top: 40,
            });
            const trimmed = name.trim();
            if (!rows.length && /\s/.test(trimmed)) {
              // "Ruedi Noser" → search the last token, then match the full name client-side.
              const last = trimmed.split(/\s+/).pop() as string;
              ({ rows } = await odata("MemberCouncil", {
                filter: [...base, `substringof('${escapeOData(last)}', LastName)`].join(" and "),
                top: 40,
              }));
              const want = trimmed.toLowerCase();
              rows = rows.filter((r) => `${r["FirstName"] ?? ""} ${r["LastName"] ?? ""}`.toLowerCase().includes(want));
            }
            let candidates = dedupeMembers(rows);
            if (!candidates.length) {
              return toolError(`No council member found matching '${name}'.`, [
                "Use the last name only, e.g. 'Noser', or search with search_council_members (active_only=false).",
              ]);
            }
            if (candidates.length > 1) {
              const exact = candidates.filter((c) => String(c["LastName"] ?? "").toLowerCase() === trimmed.toLowerCase());
              if (exact.length === 1) candidates = exact;
              else if (exact.length > 1 && exact.filter((c) => c["Active"] === true).length === 1) {
                candidates = exact.filter((c) => c["Active"] === true);
              }
            }
            if (candidates.length > 1) {
              return toolError(`'${name}' matches ${candidates.length} people — pass first_name or person_number.`, [
                ...candidates.slice(0, 10).map(
                  (c) =>
                    `person_number=${pick(c, ["PersonNumber", "ID"])}: ${c["FirstName"] ?? ""} ${c["LastName"] ?? ""} (${[c["PartyAbbreviation"], c["CantonAbbreviation"], c["CouncilAbbreviation"], c["Active"] === true ? "active" : "former"].filter(Boolean).join(", ")})`,
                ),
              ]);
            }
            member = candidates[0];
            pn = String(pick(member, ["PersonNumber", "ID"]));
          }
          const pnLit = odataNumberLiteral(Number(pn));
          if (!pnLit) return toolError(`Invalid person number '${pn}'.`);

          const { rows: interests, cacheStatus, retrievedAt } = await odata("PersonInterest", {
            filter: `Language eq '${l}' and PersonNumber eq ${pnLit}`,
            top: limit,
          });
          let occupations: Record<string, unknown>[] | undefined;
          if (include_occupations) {
            try {
              const { rows } = await odata("PersonOccupation", {
                filter: `Language eq '${l}' and PersonNumber eq ${pnLit}`,
                top: 20,
              });
              occupations = rows.map(normaliseOccupation).filter((o) => Object.keys(o).length);
            } catch {
              occupations = undefined;
            }
          }
          const seen = new Set<string>();
          const list = interests
            .sort((a, b) => Number(a["SortOrder"] ?? 0) - Number(b["SortOrder"] ?? 0))
            .map(normaliseInterest)
            .filter((i) => {
              const k = JSON.stringify(i);
              if (seen.has(k)) return false;
              seen.add(k);
              return true;
            });
          return respond(
            {
              person_number: Number(pn),
              ...(member
                ? {
                    member: compact({
                      name: `${member["FirstName"] ?? ""} ${member["LastName"] ?? ""}`.trim(),
                      party: member["PartyAbbreviation"],
                      canton: member["CantonAbbreviation"],
                      council: member["CouncilAbbreviation"],
                      active: member["Active"],
                    }),
                  }
                : {}),
              interest_count: list.length,
              interests: list,
              ...(occupations ? { occupations } : {}),
              biography_url: `https://www.parlament.ch/de/biografie?CouncillorId=${Number(pn)}`,
            },
            {
              source,
              cacheStatus,
              retrievedAt,
              language: l.toLowerCase(),
              ...(list.length ? {} : { notes: "No declared interests returned for this person (former members may have none on record)." }),
            },
          );
        } catch (err) {
          return errorToResult(err, "parlament.ch web services");
        }
      },
    }),

    tool({
      name: "list_parliament_committees",
      title: "List parliamentary committees",
      description:
        "List committees of the Federal Assembly (legislative committees such as WAK-N/WAK-S economy, SiK security, UREK environment, SGK health, plus supervisory committees GPK/FinK and joint bodies). Returns committee number, name, abbreviation, council (NR/SR/BV) and type. Filter by council and a name/abbreviation fragment. Examples: {council:'NR'}; {query:'Wirtschaft'}; {query:'SGK'}. Use get_committee_members for the members.",
      inputSchema: {
        council: z.enum(["NR", "SR", "all"]).default("all").describe("NR = National Council, SR = Council of States"),
        query: z.string().min(2).optional().describe("Name or abbreviation fragment, e.g. 'WAK', 'Gesundheit'"),
        include_inactive: z.boolean().default(false).describe("Include dissolved/historical committees"),
        include_subcommittees: z.boolean().default(false),
        language: z.enum(["DE", "FR", "IT"]).default("DE"),
        limit: z.number().int().min(1).max(200).default(60),
      },
      handler: async ({ council, query, include_inactive, include_subcommittees, language, limit }) => {
        const l = LANG(language);
        try {
          const { rows, cacheStatus, retrievedAt } = await odata("Committee", { filter: `Language eq '${l}'`, top: 1000 });
          let list = rows;
          if (!include_inactive) list = list.filter(isCurrent);
          if (!include_subcommittees) {
            list = list.filter((c) => {
              const sub = c["SubCommitteeNumber"];
              const type = String(pick(c, ["CommitteeTypeName", "CommitteeTypeAbbreviation"]) ?? "");
              return !(sub !== undefined && sub !== 0 && sub !== "0") && !/sub|sous|sotto/i.test(type);
            });
          }
          if (council !== "all") list = list.filter((c) => councilOf(c) === council);
          if (query) list = matchCommittees(list, query);
          const seen = new Set<string>();
          const committees = list
            .map(normaliseCommittee)
            .filter((c) => {
              const k = String(c["committee_number"] ?? JSON.stringify(c));
              if (seen.has(k)) return false;
              seen.add(k);
              return true;
            })
            .sort(
              (a, b) =>
                String(a["council"] ?? "Z").localeCompare(String(b["council"] ?? "Z")) ||
                String(a["abbreviation"] ?? a["name"] ?? "").localeCompare(String(b["abbreviation"] ?? b["name"] ?? "")),
            );
          if (!committees.length) {
            return toolError("No committees matched.", [
              "Drop 'query' or set include_inactive=true; abbreviations are language-specific (WAK in DE, CER in FR).",
            ]);
          }
          return respond(
            { count: committees.length, committees: committees.slice(0, limit) },
            { source, cacheStatus, retrievedAt, language: l.toLowerCase() },
          );
        } catch (err) {
          return errorToResult(err, "parlament.ch web services");
        }
      },
    }),

    tool({
      name: "get_committee_members",
      title: "Members of a parliamentary committee",
      description:
        "Current members of one Federal Assembly committee with their function (president, vice-president, member), party, parliamentary group, canton and council. Identify the committee by abbreviation ('WAK-N', 'SGK-S', 'GPK-N'), committee number, or a name fragment ('Wirtschaft und Abgaben'). Use list_parliament_committees to find committees.",
      inputSchema: {
        committee: z.string().min(2).describe("Abbreviation (e.g. 'WAK-N'), committee number (e.g. '5') or name fragment"),
        language: z.enum(["DE", "FR", "IT"]).default("DE"),
        limit: z.number().int().min(1).max(100).default(60),
      },
      handler: async ({ committee, language, limit }) => {
        const l = LANG(language);
        try {
          let number: unknown;
          let info: Record<string, unknown> | undefined;
          try {
            const { rows } = await odata("Committee", { filter: `Language eq '${l}'`, top: 1000 });
            let matches = matchCommittees(rows, committee);
            const current = matches.filter(isCurrent);
            if (current.length) matches = current;
            const numbers = [...new Set(matches.map((m) => String(pick(m, ["CommitteeNumber", "ID"]))))];
            if (numbers.length > 1) {
              return toolError(`'${committee}' matches ${numbers.length} committees — be more specific.`, [
                ...matches
                  .map(normaliseCommittee)
                  .slice(0, 10)
                  .map((c) => `${c["abbreviation"] ?? "?"} (${c["committee_number"]}): ${c["name"] ?? ""}`),
                "Add the council suffix, e.g. 'WAK-N' (National Council) vs 'WAK-S' (Council of States).",
              ]);
            }
            if (matches[0]) {
              info = normaliseCommittee(matches[0]);
              number = pick(matches[0], ["CommitteeNumber", "ID"]);
            }
          } catch (err) {
            if (!/^\d+$/.test(committee.trim())) throw err;
          }
          if (number === undefined && /^\d+$/.test(committee.trim())) number = Number(committee.trim());
          const lit = odataNumberLiteral(number);
          if (!lit) {
            return toolError(`No committee found for '${committee}'.`, [
              "Run list_parliament_committees to see abbreviations and numbers.",
            ]);
          }
          const { rows, cacheStatus, retrievedAt } = await odata("MemberCommittee", {
            filter: `Language eq '${l}' and CommitteeNumber eq ${lit}`,
            top: 200,
          });
          const seen = new Set<string>();
          const members = rows
            .filter(isCurrent)
            .map(normaliseCommitteeMember)
            .filter((m) => {
              const k = String(m["person_number"] ?? m["name"]);
              if (seen.has(k)) return false;
              seen.add(k);
              return true;
            })
            .sort((a, b) => {
              const rank = (f: unknown) => (/vize|vice/i.test(String(f)) ? 1 : /präsid|presid/i.test(String(f)) ? 0 : 2);
              return rank(a["function"]) - rank(b["function"]) || String(a["name"]).localeCompare(String(b["name"]));
            });
          if (!members.length) {
            return toolError(`No current members found for committee '${committee}'.`, [
              "The committee may be dissolved; check list_parliament_committees with include_inactive=true.",
            ]);
          }
          return respond(
            { committee: info ?? { committee_number: number }, member_count: members.length, members: members.slice(0, limit) },
            { source, cacheStatus, retrievedAt, language: l.toLowerCase() },
          );
        } catch (err) {
          return errorToResult(err, "parlament.ch web services");
        }
      },
    }),

    tool({
      name: "list_parliamentary_groups",
      title: "Parliamentary groups and parties with seat counts",
      description:
        "Current parliamentary groups (Fraktionen: e.g. SVP-Fraktion, SP, Mitte, FDP, Grüne, GLP) or parties with their seat counts in the National Council (NR) and Council of States (SR), computed from the active membership. For groups, a party breakdown is included; for parties, the group they sit with. Examples: {} (factions, both chambers); {by:'party', council:'SR'}.",
      inputSchema: {
        by: z.enum(["parl_group", "party"]).default("parl_group").describe("Aggregate by parliamentary group (faction) or by party"),
        council: z.enum(["NR", "SR", "all"]).default("all"),
        language: z.enum(["DE", "FR", "IT"]).default("DE"),
      },
      handler: async ({ by, council, language }) => {
        const l = LANG(language);
        try {
          const { rows, cacheStatus, retrievedAt } = await odata("MemberCouncil", {
            filter: `Language eq '${l}' and Active eq true`,
            top: 400,
          });
          let members = dedupeMembers(rows);
          if (council !== "all") members = members.filter((m) => councilOf(m) === council);
          if (!members.length) return toolError("No active council members returned.");
          const groups = aggregateGroups(members, by);
          const totals: Record<string, number> = {};
          for (const m of members) {
            const c = councilOf(m) ?? "other";
            totals[c] = (totals[c] ?? 0) + 1;
          }
          return respond(
            { by, council, total_members: members.length, seats_by_council: totals, groups },
            { source, cacheStatus, retrievedAt, language: l.toLowerCase() },
          );
        } catch (err) {
          return errorToResult(err, "parlament.ch web services");
        }
      },
    }),
  ],
};
