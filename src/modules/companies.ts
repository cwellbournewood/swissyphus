/**
 * Companies module — ZEFIX (Central Business Name Index) and SOGC/SHAB
 * commercial-register publications via the official gazette portal API.
 *
 * ZEFIX back-ends:
 * - ZefixPublicREST (`/ZefixPublicREST/api/v1`) — the supported machine API,
 *   HTTP Basic auth with FOJ-issued credentials. Used when the environment
 *   variables ZEFIX_USER and ZEFIX_PASS are both set.
 * - ZefixREST (`/ZefixREST/api/v1`) — the zefix.admin.ch web app's keyless
 *   back-end. Used otherwise, and as a fallback if the public API rejects the
 *   credentials (401/403).
 * Both are normalised to the same response shape.
 */

import { z } from "zod";
import { fetchJson, withParams, SourceError } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { CacheStatus, SourceManifest } from "../core/types.js";

const zefix: SourceManifest = {
  id: "zefix",
  name: "ZEFIX — Central Business Name Index",
  operator: "Federal Office of Justice (FOJ) / Federal Commercial Registry Office",
  url: "https://www.zefix.admin.ch",
  licence: "Public register data, free consultation; attribution required",
  attribution: "© ZEFIX, Federal Office of Justice",
  updateFrequency: "daily (register mutations)",
  cacheTtlSeconds: 3600,
  notes:
    "Uses ZefixPublicREST (Basic auth) when ZEFIX_USER/ZEFIX_PASS are configured; otherwise the keyless ZefixREST web-app back-end.",
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
const ZEFIX_PUBLIC_BASE = "https://www.zefix.admin.ch/ZefixPublicREST/api/v1";

/** Basic-auth header for ZefixPublicREST, or undefined when not configured. Never log this. */
function publicAuthHeader(): string | undefined {
  const user = process.env["ZEFIX_USER"];
  const pass = process.env["ZEFIX_PASS"];
  if (!user || !pass) return undefined;
  return `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
}

// ── Normalisation (pure, exported for tests) ───────────────────────────────

/** Normalised firm record (ZefixREST field names; PublicREST mapped onto them). */
export interface ZefixFirm {
  name?: string;
  ehraid?: number;
  uid?: string;
  uidFormatted?: string;
  chid?: string;
  chidFormatted?: string;
  legalSeat?: string;
  legalFormId?: number;
  /** Name carried inline by PublicREST (`legalForm.name`), if any. */
  legalFormName?: string;
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

type Raw = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : typeof v === "number" ? String(v) : undefined;
}

function pickName(v: unknown): string | undefined {
  if (typeof v === "string") return v || undefined;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return str(o["en"]) ?? str(o["de"]) ?? str(o["fr"]) ?? str(o["it"]);
  }
  return undefined;
}

/** Map a ZefixREST firm or a ZefixPublicREST company to one shape. */
export function normalizeFirm(raw: Raw): ZefixFirm {
  const lf = raw["legalForm"] as Raw | undefined;
  const uidRaw = str(raw["uid"]);
  const uid = uidRaw ? parseUid(uidRaw) ?? uidRaw : undefined;
  const chid = str(raw["chid"]);
  const ehraid = Number(raw["ehraid"]);
  const legalFormId = Number(raw["legalFormId"] ?? lf?.["id"]);
  const translation = raw["translation"];
  return {
    name: str(raw["name"]),
    ehraid: Number.isFinite(ehraid) && ehraid > 0 ? ehraid : undefined,
    uid,
    uidFormatted: str(raw["uidFormatted"]) ?? (uid && /^CHE\d{9}$/.test(uid) ? formatUid(uid) : undefined),
    chid,
    chidFormatted: str(raw["chidFormatted"]) ?? (chid && /^CH\d{11}$/.test(chid) ? formatChid(chid) : chid),
    legalSeat: str(raw["legalSeat"]),
    legalFormId: Number.isFinite(legalFormId) && legalFormId > 0 ? legalFormId : undefined,
    legalFormName: lf ? pickName(lf["name"]) : undefined,
    status: str(raw["status"]),
    shabDate: str(raw["shabDate"]) ?? str(raw["sogcDate"]),
    deleteDate: str(raw["deleteDate"]) ?? str(raw["deletionDate"]) ?? null,
    cantonalExcerptWeb: str(raw["cantonalExcerptWeb"]),
    purpose: str(raw["purpose"]),
    translation: Array.isArray(translation) ? (translation.filter((t) => typeof t === "string") as string[]) : undefined,
    address: raw["address"] && typeof raw["address"] === "object" ? (raw["address"] as Record<string, unknown>) : undefined,
    capitalNominal: str(raw["capitalNominal"]),
    capitalCurrency: str(raw["capitalCurrency"]),
  };
}

/** Normalise "CHE-123.456.789", "che123456789", "CHE-123.456.789 MWST" → "CHE123456789" (or undefined). */
export function parseUid(s: string): string | undefined {
  const m = s
    .trim()
    .toUpperCase()
    .match(/^CHE[\s\-.]*(\d{3})[\s.]*(\d{3})[\s.]*(\d{3})(?:\s*(?:MWST|TVA|IVA|VAT|HR|RC|RI))?$/);
  return m ? `CHE${m[1]}${m[2]}${m[3]}` : undefined;
}

/** eCH-0097 UID check digit (mod 11, weights 5 4 3 2 7 6 5 4). */
export function uidChecksumValid(nineDigits: string): boolean {
  if (!/^\d{9}$/.test(nineDigits)) return false;
  const w = [5, 4, 3, 2, 7, 6, 5, 4];
  const sum = w.reduce((s, wi, i) => s + wi * Number(nineDigits[i]), 0);
  let check = 11 - (sum % 11);
  if (check === 11) check = 0;
  if (check === 10) return false;
  return check === Number(nineDigits[8]);
}

export function formatUid(uid: string): string {
  const d = uid.replace(/\D/g, "");
  return `CHE-${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}`;
}

function formatChid(chid: string): string {
  const d = chid.slice(2);
  return `CH-${d.slice(0, 3)}.${d.slice(3, 4)}.${d.slice(4, 7)}.${d.slice(7, 10)}-${d.slice(10)}`;
}

/**
 * Classify a get_company identifier.
 * - UID with CHE prefix → uid
 * - 9 digits → UID without prefix (checksum-validated); invalid → error
 * - 1–8 digits → EHRAID (internal ZEFIX id)
 * - anything else → exact company name
 */
export function classifyIdentifier(
  input: string,
): { kind: "uid"; uid: string } | { kind: "ehraid"; ehraid: number } | { kind: "name"; name: string } | { kind: "invalid"; reason: string } {
  const s = input.trim();
  const uid = parseUid(s);
  if (uid) {
    return uidChecksumValid(uid.slice(3))
      ? { kind: "uid", uid }
      : { kind: "invalid", reason: `'${s}' is not a valid UID (check digit mismatch).` };
  }
  const digits = s.replace(/[\s.\-]/g, "");
  if (/^\d+$/.test(digits)) {
    if (digits.length === 9) {
      return uidChecksumValid(digits)
        ? { kind: "uid", uid: `CHE${digits}` }
        : { kind: "invalid", reason: `'${s}' has 9 digits but is not a valid UID (check digit mismatch); EHRAIDs are shorter.` };
    }
    if (digits.length <= 8 && /^\d+$/.test(s)) return { kind: "ehraid", ehraid: Number(digits) };
    return { kind: "invalid", reason: `'${s}' is neither a UID (CHE + 9 digits) nor an EHRAID.` };
  }
  return { kind: "name", name: s };
}

/** Case/whitespace-insensitive name key. */
export function nameKey(s: string | undefined): string {
  return (s ?? "").normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Resolve a name to a single firm: exact (case/whitespace-insensitive) match
 * only. Several exact matches → prefer the single active one. Otherwise return
 * candidates for the caller to disambiguate.
 */
export function resolveByName(
  name: string,
  list: ZefixFirm[],
): { match: ZefixFirm } | { candidates: ZefixFirm[] } {
  const key = nameKey(name);
  const exact = list.filter((f) => nameKey(f.name) === key);
  if (exact.length === 1) return { match: exact[0]! };
  if (exact.length > 1) {
    const active = exact.filter((f) => statusLabel(f.status) === "active");
    if (active.length === 1) return { match: active[0]! };
    return { candidates: exact };
  }
  return { candidates: list };
}

// ── Legal forms ────────────────────────────────────────────────────────────

/**
 * Fallback table keyed by ZEFIX `legalFormId`. Ids 1–14 follow the ZEFIX
 * `/legalForm` list; 15–18 are lower-confidence. At runtime the live
 * `/legalForm` list (cached 24 h) takes precedence when reachable.
 */
export const LEGAL_FORMS: Record<number, string> = {
  1: "Sole proprietorship (Einzelunternehmen)",
  2: "General partnership (Kollektivgesellschaft)",
  3: "Company limited by shares (AG/SA)",
  4: "Limited liability company (GmbH/Sàrl)",
  5: "Cooperative (Genossenschaft)",
  6: "Association (Verein)",
  7: "Foundation (Stiftung)",
  8: "Institute of public law (Institut des öffentlichen Rechts)",
  9: "Branch (Zweigniederlassung)",
  10: "Limited partnership (Kommanditgesellschaft)",
  11: "Branch of a foreign company (Zweigniederlassung ausländische Gesellschaft)",
  12: "Partnership limited by shares (Kommanditaktiengesellschaft)",
  13: "Special legal form (Besondere Rechtsform)",
  14: "Community of heirs/undivided property (Gemeinderschaft)",
  15: "Limited partnership for collective investment (KmGK)",
  16: "Investment company with variable capital (SICAV)",
  17: "Investment company with fixed capital (SICAF)",
  18: "Institute of public law, cantonal",
};

/** Parse a ZEFIX `/legalForm` response (array or {list}) into id → display name. */
export function parseLegalForms(json: unknown): Map<number, string> {
  const arr = Array.isArray(json)
    ? json
    : Array.isArray((json as { list?: unknown })?.list)
      ? ((json as { list: unknown[] }).list)
      : [];
  const out = new Map<number, string>();
  for (const item of arr as Raw[]) {
    const id = Number(item?.["id"]);
    const name = pickName(item?.["name"]);
    if (!Number.isFinite(id) || !name) continue;
    const short = pickName(item["shortName"]);
    out.set(id, short && short !== name ? `${name} (${short})` : name);
  }
  return out;
}

let legalFormFailureAt = 0;

/** Live legal-form list (24 h cache), falling back to the built-in table. */
async function legalForms(): Promise<{ map: Map<number, string>; origin: "zefix" | "builtin" }> {
  const builtin = new Map(Object.entries(LEGAL_FORMS).map(([k, v]) => [Number(k), v] as [number, string]));
  if (Date.now() - legalFormFailureAt < 3600_000) return { map: builtin, origin: "builtin" };
  const auth = publicAuthHeader();
  const url = auth ? `${ZEFIX_PUBLIC_BASE}/legalForm` : `${ZEFIX_BASE}/legalForm.json`;
  try {
    const { data } = await fetchJson<unknown>(url, {
      ttlMs: 24 * 3600_000,
      timeoutMs: 5000,
      init: auth ? { headers: { Authorization: auth } } : {},
    });
    const live = parseLegalForms(data);
    if (live.size < 5) throw new Error("legalForm list too short");
    return { map: live, origin: "zefix" };
  } catch {
    legalFormFailureAt = Date.now();
    return { map: builtin, origin: "builtin" };
  }
}

export function statusLabel(status?: string): string {
  switch ((status ?? "").toUpperCase()) {
    case "EXISTIEREND":
    case "ACTIVE":
      return "active";
    case "GELOESCHT":
    case "CANCELLED":
    case "DELETED":
      return "deleted";
    case "IN_AUFLOESUNG":
    case "AUFGELOEST":
    case "BEING_CANCELLED":
    case "IN_LIQUIDATION":
      return "in liquidation";
    default:
      return status ?? "unknown";
  }
}

export function compactFirm(f: ZefixFirm, forms: Map<number, string> = new Map()) {
  return {
    name: f.name,
    uid: f.uidFormatted ?? f.uid,
    chid: f.chidFormatted,
    ehraid: f.ehraid,
    status: statusLabel(f.status),
    legal_form_id: f.legalFormId,
    legal_form: f.legalFormId
      ? (forms.get(f.legalFormId) ?? LEGAL_FORMS[f.legalFormId] ?? f.legalFormName ?? `form ${f.legalFormId}`)
      : f.legalFormName,
    legal_seat: f.legalSeat,
    last_sogc_date: f.shabDate,
    delete_date: f.deleteDate ?? undefined,
    cantonal_excerpt_url: f.cantonalExcerptWeb,
  };
}

function fullFirm(f: ZefixFirm, forms: Map<number, string>) {
  return {
    ...compactFirm(f, forms),
    purpose: f.purpose,
    name_translations: f.translation,
    address: f.address,
    capital: f.capitalNominal ? `${f.capitalNominal} ${f.capitalCurrency ?? "CHF"}` : undefined,
  };
}

// ── Back-end access ────────────────────────────────────────────────────────

interface Fetched<T> {
  data: T;
  cacheStatus: CacheStatus;
  retrievedAt: string;
  backend: "ZefixPublicREST" | "ZefixREST";
}

/** Run against PublicREST when configured; fall back to ZefixREST on 401/403. */
async function withBackend<T>(
  publicFn: (auth: string) => Promise<Fetched<T>>,
  internalFn: () => Promise<Fetched<T>>,
): Promise<Fetched<T>> {
  const auth = publicAuthHeader();
  if (!auth) return internalFn();
  try {
    return await publicFn(auth);
  } catch (err) {
    if (err instanceof SourceError && (err.status === 401 || err.status === 403)) return internalFn();
    throw err;
  }
}

async function searchFirms(
  name: string,
  opts: { limit: number; offset?: number; canton?: string },
): Promise<Fetched<{ list: ZefixFirm[]; hasMore: boolean; total?: number }>> {
  const offset = opts.offset ?? 0;
  const canton = opts.canton?.toUpperCase();
  return withBackend(
    async (auth) => {
      const r = await fetchJson<unknown>(`${ZEFIX_PUBLIC_BASE}/company/search`, {
        ttlMs: zefix.cacheTtlSeconds * 1000,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify({ name, activeOnly: false, ...(canton ? { canton } : {}) }),
        },
      });
      const all = (Array.isArray(r.data) ? (r.data as Raw[]) : []).map(normalizeFirm);
      return {
        data: { list: all.slice(offset, offset + opts.limit), hasMore: all.length > offset + opts.limit, total: all.length },
        cacheStatus: r.cacheStatus,
        retrievedAt: r.retrievedAt,
        backend: "ZefixPublicREST",
      };
    },
    async () => {
      const r = await fetchJson<{ list?: Raw[]; hasMoreResults?: boolean; maxOffset?: number }>(
        `${ZEFIX_BASE}/firm/search.json`,
        {
          ttlMs: zefix.cacheTtlSeconds * 1000,
          init: {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, maxEntries: opts.limit, offset, ...(canton ? { canton } : {}) }),
          },
        },
      );
      return {
        data: {
          list: (r.data.list ?? []).map(normalizeFirm),
          hasMore: r.data.hasMoreResults ?? false,
          total: r.data.maxOffset,
        },
        cacheStatus: r.cacheStatus,
        retrievedAt: r.retrievedAt,
        backend: "ZefixREST",
      };
    },
  );
}

async function getByEhraid(ehraid: number): Promise<Fetched<ZefixFirm>> {
  return withBackend(
    async (auth) => {
      const r = await fetchJson<unknown>(`${ZEFIX_PUBLIC_BASE}/company/ehraid/${ehraid}`, {
        ttlMs: zefix.cacheTtlSeconds * 1000,
        init: { headers: { Authorization: auth } },
      });
      const raw = (Array.isArray(r.data) ? r.data[0] : r.data) as Raw | undefined;
      if (!raw) throw new SourceError("ZEFIX returned no company.", "www.zefix.admin.ch", 404);
      return { data: normalizeFirm(raw), cacheStatus: r.cacheStatus, retrievedAt: r.retrievedAt, backend: "ZefixPublicREST" };
    },
    async () => {
      const r = await fetchJson<Raw>(`${ZEFIX_BASE}/firm/${ehraid}.json`, { ttlMs: zefix.cacheTtlSeconds * 1000 });
      return { data: normalizeFirm(r.data), cacheStatus: r.cacheStatus, retrievedAt: r.retrievedAt, backend: "ZefixREST" };
    },
  );
}

/** Look up by UID ("CHE123456789"). Throws SourceError 404 when absent. */
async function getByUid(uid: string): Promise<Fetched<ZefixFirm>> {
  return withBackend(
    async (auth) => {
      const r = await fetchJson<unknown>(`${ZEFIX_PUBLIC_BASE}/company/uid/${uid}`, {
        ttlMs: zefix.cacheTtlSeconds * 1000,
        init: { headers: { Authorization: auth } },
      });
      const arr = (Array.isArray(r.data) ? r.data : [r.data]).filter(Boolean) as Raw[];
      const firms = arr.map(normalizeFirm);
      const pick = firms.find((f) => statusLabel(f.status) === "active") ?? firms[0];
      if (!pick) throw new SourceError("ZEFIX returned no company.", "www.zefix.admin.ch", 404);
      return { data: pick, cacheStatus: r.cacheStatus, retrievedAt: r.retrievedAt, backend: "ZefixPublicREST" };
    },
    async () => {
      // The keyless back-end has no UID route: search by the formatted UID,
      // keep only exact UID matches, then fetch the full record by EHRAID.
      const s = await searchFirms(formatUid(uid), { limit: 10 });
      const hits = s.data.list.filter((f) => f.uid === uid);
      const pick = hits.find((f) => statusLabel(f.status) === "active") ?? hits[0];
      if (!pick?.ehraid) throw new SourceError("No company with that UID.", "www.zefix.admin.ch", 404);
      return getByEhraid(pick.ehraid);
    },
  );
}

function backendNote(backend: Fetched<unknown>["backend"]): string {
  return backend === "ZefixPublicREST"
    ? "Delivered via ZefixPublicREST (authenticated FOJ API)."
    : "Delivered via ZefixREST (keyless zefix.admin.ch web-app back-end).";
}

function candidateLines(list: ZefixFirm[], forms: Map<number, string>): string[] {
  return list.slice(0, 8).map((f) => {
    const c = compactFirm(f, forms);
    return `${c.name} — UID ${c.uid ?? "?"}, ${c.legal_seat ?? "?"}, ${c.status}`;
  });
}

const CANTONS: Record<string, string> = {
  AG: "Aargau", AI: "Appenzell Innerrhoden", AR: "Appenzell Ausserrhoden", BE: "Bern", BL: "Basel-Landschaft",
  BS: "Basel-Stadt", FR: "Fribourg", GE: "Genève", GL: "Glarus", GR: "Graubünden", JU: "Jura", LU: "Luzern",
  NE: "Neuchâtel", NW: "Nidwalden", OW: "Obwalden", SG: "St. Gallen", SH: "Schaffhausen", SO: "Solothurn",
  SZ: "Schwyz", TG: "Thurgau", TI: "Ticino", UR: "Uri", VD: "Vaud", VS: "Valais", ZG: "Zug", ZH: "Zürich",
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface SogcPublication {
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
}

/** Map SOGC publications, newest first (the portal's default order is not guaranteed). */
export function mapSogcPublications(content: SogcPublication[] | undefined) {
  return (content ?? [])
    .map((p) => ({
      id: p.meta?.id,
      number: p.meta?.publicationNumber,
      date: p.meta?.publicationDate?.slice(0, 10),
      rubric: p.meta?.rubric,
      sub_rubric: p.meta?.subRubric,
      language: p.meta?.language,
      title: p.meta?.title,
      office: p.meta?.registrationOffice?.displayName,
      url: p.meta?.id ? `https://amtsblattportal.ch/#!/search/publications/detail/${p.meta.id}` : undefined,
    }))
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
}

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
        "Search the Swiss commercial register (ZEFIX, 700k+ entities) by company name. Returns UID, legal form, seat, status and a link to the cantonal register excerpt. A UID like 'CHE-123.456.789' as query is looked up directly.",
      inputSchema: {
        query: z.string().min(2).describe("Company name (or UID) to search for"),
        canton: z.string().length(2).optional().describe("Optional canton filter, e.g. 'ZH'"),
        limit: z.number().int().min(1).max(50).default(10),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
      },
      handler: async ({ query, canton, limit, offset }) => {
        try {
          const uid = parseUid(query);
          if (uid) {
            try {
              const [r, forms] = await Promise.all([getByUid(uid), legalForms()]);
              return respond(
                { results: [compactFirm(r.data, forms.map)], has_more: false, offset: 0, total_matches: 1 },
                { source: zefix, cacheStatus: r.cacheStatus, retrievedAt: r.retrievedAt, notes: backendNote(r.backend) },
              );
            } catch (err) {
              if (err instanceof SourceError && err.status === 404) {
                return toolError(`No company registered under UID ${formatUid(uid)}.`, [
                  "Check the UID digits, or search by company name instead.",
                ]);
              }
              throw err;
            }
          }
          const [r, forms] = await Promise.all([searchFirms(query, { limit, offset, canton }), legalForms()]);
          const list = r.data.list.map((f) => compactFirm(f, forms.map));
          if (!list.length) {
            return toolError(`No companies found matching '${query}'.`, [
              "ZEFIX matches on registered names; try a shorter fragment or the legal name.",
            ]);
          }
          return respond(
            { results: list, has_more: r.data.hasMore, offset, total_matches: r.data.total },
            { source: zefix, cacheStatus: r.cacheStatus, retrievedAt: r.retrievedAt, notes: backendNote(r.backend) },
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
        "Full ZEFIX record for one company: purpose, translations, seat, status, legal form, SOGC date and register links. Identify the company by UID ('CHE-107.028.276' or its 9 digits), exact registered name (case-insensitive; otherwise candidates are returned), or numeric EHRAID.",
      inputSchema: {
        identifier: z.string().min(1).describe("Company UID (CHE-…), exact registered name, or numeric EHRAID"),
      },
      handler: async ({ identifier }) => {
        const id = classifyIdentifier(identifier);
        if (id.kind === "invalid") {
          return toolError(id.reason, ["Use search_companies to find the company's UID."]);
        }
        try {
          const formsP = legalForms();
          let r: Fetched<ZefixFirm>;
          if (id.kind === "uid") {
            r = await getByUid(id.uid);
          } else if (id.kind === "ehraid") {
            r = await getByEhraid(id.ehraid);
          } else {
            const s = await searchFirms(id.name, { limit: 20 });
            const resolved = resolveByName(id.name, s.data.list);
            if (!("match" in resolved) || !resolved.match.ehraid) {
              const forms = (await formsP).map;
              const cands = "candidates" in resolved ? resolved.candidates : [];
              if (!cands.length) {
                return toolError(`No company found for '${identifier}'.`, [
                  "Use search_companies with a shorter name fragment to find the registered name or UID.",
                ]);
              }
              return toolError(
                `No unique exact name match for '${identifier}'. Call get_company again with one of these UIDs:`,
                candidateLines(cands, forms),
                { kind: "invalid_input" },
              );
            }
            r = await getByEhraid(resolved.match.ehraid);
          }
          const forms = (await formsP).map;
          const data = r.data;
          return respond(fullFirm(data, forms), {
            source: zefix,
            cacheStatus: r.cacheStatus,
            retrievedAt: r.retrievedAt,
            notes: backendNote(r.backend),
            links: {
              zefix: `https://www.zefix.admin.ch/en/search/entity/list?name=${encodeURIComponent(data.name ?? "")}`,
              ...(data.cantonalExcerptWeb ? { cantonal_excerpt: data.cantonalExcerptWeb } : {}),
            },
          });
        } catch (err) {
          if (err instanceof SourceError && err.status === 404) {
            const what =
              id.kind === "uid" ? `UID ${formatUid(id.uid)}` : id.kind === "ehraid" ? `EHRAID ${id.ehraid}` : `'${identifier}'`;
            return toolError(`No company found in ZEFIX for ${what}.`, [
              "Use search_companies to find the company's UID.",
            ]);
          }
          return errorToResult(err, "ZEFIX");
        }
      },
    }),

    tool({
      name: "list_legal_forms",
      title: "List Swiss legal forms",
      description:
        "List the legal-form codes (ZEFIX legalFormId) used in the Swiss commercial register (AG, GmbH, foundation, …).",
      inputSchema: {},
      handler: async () => {
        const { map, origin } = await legalForms();
        return respond(
          { legal_forms: [...map.entries()].sort((a, b) => a[0] - b[0]).map(([id, name]) => ({ id, name })) },
          {
            source: zefix,
            cacheStatus: "computed",
            retrievedAt: new Date().toISOString(),
            notes:
              origin === "zefix"
                ? "Live list from the ZEFIX legalForm endpoint."
                : "Built-in fallback table (live ZEFIX legalForm list unavailable).",
          },
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
        "Search official Swiss Official Gazette of Commerce (SOGC/SHAB) publications: commercial-register mutations (HR), bankruptcies (KK), debt enforcement, and more. Filter by keyword, rubric and date range. Results are listed newest first.",
      inputSchema: {
        keyword: z.string().optional().describe("Free-text keyword, e.g. a company name"),
        rubric: z
          .enum(["HR", "KK", "LS", "NA", "SB", "AW", "ES", "IP", "AB", "UP"])
          .default("HR")
          .describe("Rubric: HR=commercial register, KK=bankruptcy, LS=debt call, ES=inheritance, …"),
        date_from: z.string().regex(ISO_DATE).optional().describe("Earliest publication date YYYY-MM-DD"),
        date_to: z.string().regex(ISO_DATE).optional().describe("Latest publication date YYYY-MM-DD"),
        limit: z.number().int().min(1).max(50).default(10),
      },
      handler: async ({ keyword, rubric, date_from, date_to, limit }) => {
        if (date_from && date_to && date_from > date_to) {
          return toolError("date_from must not be after date_to.");
        }
        try {
          const url = withParams("https://amtsblattportal.ch/api/v1/publications", {
            publicationStates: "PUBLISHED",
            rubrics: rubric,
            keyword,
            "publicationDate.start": date_from,
            "publicationDate.end": date_to,
            "pageRequest.size": limit,
          });
          const { data, cacheStatus, retrievedAt } = await fetchJson<{
            content?: SogcPublication[];
            total?: number;
          }>(url, { ttlMs: sogc.cacheTtlSeconds * 1000, init: { headers: { Accept: "application/json" } } });
          const publications = mapSogcPublications(data.content);
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
