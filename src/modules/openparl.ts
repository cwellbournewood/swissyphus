/**
 * OpenParlData.ch tools for the parliament module: speeches, declared
 * interests, cantonal and municipal affairs, documents and meetings across
 * the federal parliament, all 26 cantonal parliaments and many municipal
 * councils (harmonised by the OpenParlData.ch association, CC BY 4.0).
 */

import { z } from "zod";
import { fetchJson, withParams } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type ToolDef } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";
import { CANTON_CODES, normalizeText, resolveCanton } from "./_cantons.js";
import { mapLimit } from "./_geoadmin.js";

export const openParlSource: SourceManifest = {
  id: "openparldata",
  name: "OpenParlData.ch — Swiss parliaments (federal, cantonal, municipal)",
  operator: "OpenParlData.ch association, from the parliaments' own data",
  url: "https://openparldata.ch",
  licence: "CC BY 4.0",
  attribution: "© OpenParlData.ch (CC BY 4.0), data from the respective parliaments",
  updateFrequency: "daily",
  cacheTtlSeconds: 3600,
};

const API = "https://api.openparldata.ch/v1";

type Lang = Record<string, string | undefined> | string | null | undefined;

/** Pick en → de → fr → it from a multilingual object. */
export function tr(t: Lang, lang = "en"): string | undefined {
  if (!t) return undefined;
  if (typeof t === "string") return t || undefined;
  return t[lang] || t["en"] || t["de"] || t["fr"] || t["it"] || t["rm"] || undefined;
}

interface Page<T> {
  data?: T[];
  meta?: { total_records?: number };
}

function get<T>(path: string, params: Record<string, string | number | undefined>, ttlMs = 3_600_000) {
  return fetchJson<Page<T>>(withParams(`${API}/${path}`, params), { ttlMs, timeoutMs: 30_000 });
}

// ── body resolution ─────────────────────────────────────────────────────────

interface Body {
  id: number;
  body_key: string;
  name?: Lang;
  type?: string;
}

/**
 * "federal" / "CH" → CHE; canton code or name → its code (the canton's
 * parliament); anything else → a municipal council found by name.
 */
export async function resolveBody(input: string | undefined): Promise<{ key: string; label: string } | undefined> {
  const raw = (input ?? "federal").trim();
  if (/^(federal|national|bund|confederation|ch|che|schweiz|suisse|svizzera|switzerland)$/i.test(raw)) return { key: "CHE", label: "Federal Assembly" };
  const canton = resolveCanton(raw);
  if (canton) return { key: canton, label: `Cantonal parliament ${canton}` };
  const { data } = await get<Body>("bodies/", { search: raw, limit: 20 }, 86_400_000);
  const q = normalizeText(raw);
  const bodies = data.data ?? [];
  const hit = bodies.find((b) => normalizeText(tr(b.name) ?? "") === q) ?? bodies.find((b) => normalizeText(tr(b.name) ?? "").startsWith(q));
  return hit ? { key: hit.body_key, label: `${tr(hit.name)} (${hit.type ?? "body"})` } : undefined;
}

const bodyArg = z
  .string()
  .optional()
  .describe("Parliament: 'federal' (default), a canton code or name (e.g. 'ZH', 'Vaud'), or a municipality (e.g. 'Winterthur')");

async function bodyOrError(input: string | undefined) {
  const body = await resolveBody(input);
  return body ?? toolError(`Unknown parliament '${input}'.`, ["Use 'federal', a canton (e.g. 'BE') or a municipality name"], { kind: "invalid_input" });
}

// ── persons ─────────────────────────────────────────────────────────────────

interface Person {
  id: number;
  fullname?: string;
  firstname?: string;
  lastname?: string;
  party?: Lang;
  party_harmonized?: Lang;
  parliament_sector?: string;
  body_key?: string;
  active?: boolean | null;
}

const personCache = new Map<number, Promise<Person | undefined>>();
function personById(id: number): Promise<Person | undefined> {
  let p = personCache.get(id);
  if (!p) {
    p = fetchJson<Person | { data?: Person }>(`${API}/persons/${id}`, { ttlMs: 86_400_000, timeoutMs: 20_000 })
      .then((r) => ((r.data as { data?: Person }).data ?? (r.data as Person)))
      .catch(() => undefined);
    if (personCache.size > 2000) personCache.clear();
    personCache.set(id, p);
  }
  return p;
}

function personLabel(p: Person | undefined) {
  if (!p) return undefined;
  return { name: p.fullname ?? [p.firstname, p.lastname].filter(Boolean).join(" "), party: tr(p.party) ?? tr(p.party_harmonized), council: p.parliament_sector || undefined };
}

// ── mappers ─────────────────────────────────────────────────────────────────

export function stripTags(s: string | undefined): string {
  return (s ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

/** A window of text around the first match of the query (or the start). */
export function excerpt(text: string, query: string | undefined, width = 500): string {
  if (!text) return "";
  const i = query ? normalizeText(text).indexOf(normalizeText(query.split(/\s+/)[0] ?? "")) : -1;
  const start = i > 0 ? Math.max(0, i - Math.floor(width / 3)) : 0;
  const s = text.slice(start, start + width);
  return `${start > 0 ? "…" : ""}${s}${start + width < text.length ? "…" : ""}`;
}

interface Affair {
  id: number;
  body_key?: string;
  number?: string;
  title?: Lang;
  type_name?: Lang;
  type_harmonized?: Lang;
  state_name?: Lang;
  begin_date?: string | null;
  end_date?: string | null;
  url_external?: Lang;
}

export function mapAffair(a: Affair) {
  return {
    id: a.id,
    parliament: a.body_key,
    number: a.number,
    title: tr(a.title),
    type: tr(a.type_harmonized) ?? tr(a.type_name),
    state: tr(a.state_name),
    submitted: a.begin_date?.slice(0, 10),
    closed: a.end_date?.slice(0, 10),
    url: tr(a.url_external),
  };
}

// ── tools ───────────────────────────────────────────────────────────────────

export const openParlTools: ToolDef[] = [
  tool({
    name: "search_parliament_speeches",
    title: "Search parliamentary speeches",
    description:
      "Full-text search of speeches (Amtliches Bulletin / debate transcripts) in the federal parliament or a cantonal/municipal parliament. Returns speaker, party, date, an excerpt around the search term, and links to the transcript and video. Filter by speaker name or affair id.",
    inputSchema: {
      query: z.string().min(2).optional().describe("Words to find in the speech text (any language used in the debate)"),
      speaker: z.string().min(2).optional().describe("Speaker's name"),
      affair_id: z.number().int().optional().describe("OpenParlData affair id (from search_cantonal_affairs or get_parliamentary_documents)"),
      body: bodyArg,
      limit: z.number().int().min(1).max(20).default(5),
    },
    handler: async ({ query, speaker, affair_id, body, limit }) => {
      if (!query && !speaker && affair_id === undefined) return toolError("Pass a query, a speaker or an affair_id.", [], { kind: "invalid_input" });
      try {
        const b = await bodyOrError(body);
        if ("content" in b) return b;
        let personId: number | undefined;
        if (speaker) {
          const ps = await get<Person>("persons/", { body_key: b.key, search: speaker, limit: 5 }, 86_400_000);
          personId = ps.data.data?.[0]?.id;
          if (!personId) return toolError(`No member named '${speaker}' in ${b.label}.`, [], { kind: "not_found" });
        }
        const { data, cacheStatus, retrievedAt } = await get<{
          id: number;
          person_id?: number;
          affair_id?: number;
          date_start?: string;
          url?: string;
          video_url?: string;
          text_content?: Lang;
        }>("speeches/", { body_key: affair_id === undefined ? b.key : undefined, search: query, person_id: personId, affair_id, sort_by: "-date_start", exclude_null: "date_start", limit });
        const rows = data.data ?? [];
        if (!rows.length) return toolError("No matching speeches.", ["Try German or French search terms", "Broaden the query"], { kind: "not_found" });
        const people = await mapLimit(rows, 5, (r) => (r.person_id ? personById(r.person_id) : Promise.resolve(undefined)));
        return respond(
          {
            parliament: b.label,
            total_matches: data.meta?.total_records,
            speeches: rows.map((r, i) => ({
              id: r.id,
              date: r.date_start?.slice(0, 16),
              speaker: personLabel(people[i]),
              affair_id: r.affair_id,
              excerpt: excerpt(stripTags(tr(r.text_content)), query),
              transcript: r.url,
              video: r.video_url ?? undefined,
            })),
          },
          { source: openParlSource, cacheStatus, retrievedAt },
        );
      } catch (err) {
        return errorToResult(err, "OpenParlData.ch");
      }
    },
  }),
  tool({
    name: "get_politician_interests",
    title: "Politician's declared interests",
    description:
      "Declared interests and mandates of a member of parliament (board seats, associations, advisory roles), with role, organisation type and whether the mandate is paid. Federal parliament by default; cantonal parliaments where published.",
    inputSchema: { name: z.string().min(2).describe("Member's name, e.g. 'Cédric Wermuth'"), body: bodyArg },
    handler: async ({ name, body }) => {
      try {
        const b = await bodyOrError(body);
        if ("content" in b) return b;
        const ps = await get<Person>("persons/", { body_key: b.key, search: name, limit: 10 }, 86_400_000);
        const people = ps.data.data ?? [];
        if (!people.length) return toolError(`No member named '${name}' in ${b.label}.`, ["Check the spelling or pass the canton as 'body'"], { kind: "not_found" });
        const nq = normalizeText(name);
        const person = people.find((p) => normalizeText(p.fullname ?? "") === nq) ?? people.find((p) => p.active) ?? people[0]!;
        const { data, cacheStatus, retrievedAt } = await get<{
          name?: Lang;
          type?: Lang;
          role_name?: Lang;
          group?: Lang;
          type_payment?: Lang;
          type_payment_harmonized?: string;
          begin_date?: string | null;
          end_date?: string | null;
        }>(`persons/${person.id}/interests`, { limit: 200 }, 86_400_000);
        const interests = (data.data ?? []).map((i) => ({
          organisation: tr(i.name),
          organisation_type: tr(i.type),
          role: tr(i.role_name),
          body: tr(i.group),
          paid: i.type_payment_harmonized ?? tr(i.type_payment),
          from: i.begin_date?.slice(0, 10),
          to: i.end_date?.slice(0, 10),
        }));
        const paid = interests.filter((i) => typeof i.paid === "string" && /paid|bezahlt|rémun/i.test(i.paid) && !/honorary|nicht|unpaid|non/i.test(i.paid)).length;
        return respond(
          {
            member: { ...personLabel(person), id: person.id, parliament: b.label },
            other_matches: people.length > 1 ? people.filter((p) => p.id !== person.id).slice(0, 5).map((p) => p.fullname) : undefined,
            interest_count: interests.length,
            paid_count: paid,
            interests,
          },
          { source: openParlSource, cacheStatus, retrievedAt },
        );
      } catch (err) {
        return errorToResult(err, "OpenParlData.ch");
      }
    },
  }),
  tool({
    name: "search_cantonal_affairs",
    title: "Search cantonal & municipal parliamentary affairs",
    description:
      "Search motions, postulates, interpellations, questions and bills in the 26 cantonal parliaments (and municipal councils), newest first. Pass a canton to search one parliament, or omit it to search all cantons. For federal business use search_parliament_business.",
    inputSchema: {
      query: z.string().min(2).describe("Search terms (in the canton's language works best)"),
      canton: z.string().optional().describe("Canton code/name, or a municipality name; omit for all cantons"),
      limit: z.number().int().min(1).max(30).default(10),
    },
    handler: async ({ query, canton, limit }) => {
      try {
        let key: string | undefined;
        let label = "All cantonal parliaments";
        if (canton) {
          const b = await bodyOrError(canton);
          if ("content" in b) return b;
          key = b.key;
          label = b.label;
        }
        const { data, cacheStatus, retrievedAt } = await get<Affair>("affairs/", { body_key: key, search: query, sort_by: "-begin_date", exclude_null: "begin_date", limit: key ? limit : Math.min(100, limit * 4) });
        let rows = data.data ?? [];
        if (!key) rows = rows.filter((a) => (CANTON_CODES as readonly string[]).includes(a.body_key ?? "")).slice(0, limit);
        if (!rows.length) return toolError(`No cantonal affairs match '${query}'.`, ["Try terms in German/French/Italian", "Pass a canton"], { kind: "not_found" });
        return respond({ scope: label, total_matches: key ? data.meta?.total_records : undefined, affairs: rows.map(mapAffair) }, { source: openParlSource, cacheStatus, retrievedAt });
      } catch (err) {
        return errorToResult(err, "OpenParlData.ch");
      }
    },
  }),
  tool({
    name: "get_parliamentary_documents",
    title: "Parliamentary documents",
    description:
      "Official documents (texts, reports, answers, votes material) for a parliamentary affair by its OpenParlData id, or a full-text document search within a parliament. Returns titles, dates, languages and download links.",
    inputSchema: {
      affair_id: z.number().int().optional().describe("Affair id from search_cantonal_affairs"),
      query: z.string().min(2).optional().describe("Full-text search over documents"),
      body: bodyArg,
      limit: z.number().int().min(1).max(30).default(10),
    },
    handler: async ({ affair_id, query, body, limit }) => {
      if (affair_id === undefined && !query) return toolError("Pass an affair_id or a query.", [], { kind: "invalid_input" });
      try {
        let key: string | undefined;
        if (affair_id === undefined) {
          const b = await bodyOrError(body);
          if ("content" in b) return b;
          key = b.key;
        }
        const path = affair_id !== undefined ? `affairs/${affair_id}/docs` : "docs/";
        const { data, cacheStatus, retrievedAt } = await get<{
          id: number;
          name?: string;
          url?: string;
          url_oparl?: string;
          date?: string;
          format?: string | null;
          language?: string | null;
          category_harmonized?: Lang;
          parent_type?: string;
        }>(path, { body_key: key, search: affair_id === undefined ? query : undefined, sort_by: "-date", limit });
        const docs = (data.data ?? []).map((d) => ({
          id: d.id,
          title: d.name,
          date: d.date?.slice(0, 10),
          category: tr(d.category_harmonized),
          language: d.language ?? undefined,
          format: d.format ?? undefined,
          url: d.url ?? d.url_oparl,
          attached_to: d.parent_type,
        }));
        if (!docs.length) return toolError(affair_id !== undefined ? `No documents recorded for affair ${affair_id}.` : `No documents match '${query}'.`, ["Federal affairs: use get_parliament_business for the Curia Vista record and links"], { kind: "not_found" });
        return respond({ total: data.meta?.total_records, documents: docs }, { source: openParlSource, cacheStatus, retrievedAt });
      } catch (err) {
        return errorToResult(err, "OpenParlData.ch");
      }
    },
  }),
  tool({
    name: "get_committee_meetings",
    title: "Committee & council meetings",
    description:
      "Meetings of a parliament's committees or plenary, newest first: date, name, location and links to agenda and documents. Pass a committee name (e.g. 'Finanzkommission', 'Bildung') to list that committee's meetings; omit it for the parliament's latest meetings. Federal committee meetings are not published (confidential) — cantonal and municipal ones often are.",
    inputSchema: {
      committee: z.string().min(2).optional(),
      body: bodyArg,
      upcoming: z.boolean().default(false).describe("Only meetings from today on"),
      limit: z.number().int().min(1).max(30).default(10),
    },
    handler: async ({ committee, body, upcoming, limit }) => {
      try {
        const b = await bodyOrError(body);
        if ("content" in b) return b;
        let groupLabel: string | undefined;
        let path = "meetings/";
        const params: Record<string, string | number | undefined> = { body_key: b.key, sort_by: upcoming ? "begin_date" : "-begin_date", exclude_null: "begin_date", limit: upcoming ? 100 : limit };
        if (committee) {
          // Prefer committees (harmonised type 2) and ad-hoc committees (12) over departments/parties.
          let groups: Array<{ id: number; name?: Lang }> = [];
          for (const type of [2, 12, undefined]) {
            const gs = await get<{ id: number; name?: Lang }>("groups/", { body_key: b.key, search: committee, type_harmonized_id: type, limit: 10 }, 86_400_000);
            const nq = normalizeText(committee);
            groups = (gs.data.data ?? []).filter((g) => Object.values(typeof g.name === "object" && g.name ? g.name : {}).some((n) => typeof n === "string" && normalizeText(n).includes(nq)));
            if (groups.length) break;
          }
          if (!groups.length) return toolError(`No committee matching '${committee}' in ${b.label}.`, [], { kind: "not_found" });
          const g = groups[0]!;
          groupLabel = tr(g.name);
          path = `groups/${g.id}/meetings`;
          delete params["body_key"];
        }
        const { data, cacheStatus, retrievedAt } = await get<{
          id: number;
          name?: Lang;
          begin_date?: string | null;
          end_date?: string | null;
          location?: string | null;
          state?: string | null;
          type?: string;
          parent_type?: string;
          url_external?: Lang;
        }>(path, params, 900_000);
        const today = new Date().toISOString().slice(0, 10);
        let rows = data.data ?? [];
        if (upcoming) rows = rows.filter((m) => (m.begin_date ?? "") >= today).slice(0, limit);
        const meetings = rows.map((m) => ({
          id: m.id,
          name: tr(m.name),
          begin: m.begin_date?.slice(0, 16),
          end: m.end_date?.slice(0, 16),
          location: m.location ?? undefined,
          state: m.state ?? undefined,
          kind: m.parent_type ? `${m.type} of ${m.parent_type}` : m.type,
          url: tr(m.url_external),
          agenda: `${API}/meetings/${m.id}/agendas`,
          documents: `${API}/meetings/${m.id}/docs`,
        }));
        return respond(
          {
            parliament: b.label,
            committee: groupLabel,
            meeting_count: meetings.length,
            status: meetings.length ? undefined : committee ? b.key === "CHE" ? "No meetings published: federal committee meetings are confidential." : "No meetings published for this committee." : "No meetings found.",
            meetings,
          },
          { source: openParlSource, cacheStatus, retrievedAt },
        );
      } catch (err) {
        return errorToResult(err, "OpenParlData.ch");
      }
    },
  }),
];
