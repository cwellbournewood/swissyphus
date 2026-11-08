/**
 * Sanctions module — the Swiss consolidated sanctions list (SECO).
 *
 * SECO publishes every person, entity and object subject to Swiss sanctions
 * (embargo ordinances under the Embargo Act) as one XML file, ~40 MB, updated
 * whenever an annex changes. We download it at most every few hours, parse it
 * once into a compact in-memory index and answer name searches locally, so a
 * screening query never re-downloads the file.
 *
 * The XML (format in force since 2023-12-06) is:
 *   <swiss-sanctions-list date=…>
 *     <sanctions-program ssid=…> program-key/-name per language, <sanctions-set ssid=…>
 *     <target ssid=…> <sanctions-set-id/> <individual|entity|object> <identity>…
 *        <modification modification-type="listed|amended|de-listed" …/>  (newest first)
 *     <place ssid=…> <location/> <area/> <country iso-code=…/>
 * Each target also embeds earlier versions of itself inside <modification>
 * (<added>/<removed>); those are history and are skipped by the parser.
 */

import { z } from "zod";
import { allowHosts, debugLog, fetchCached, outsideBudget, SourceError } from "../core/http.js";
import { lkgGet, lkgPut } from "../core/lkg.js";
import { recordUpstream } from "../core/provenance.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { CacheStatus, SourceManifest } from "../core/types.js";
import { withDeadline } from "../core/limit.js";

allowHosts("www.sesam.search.admin.ch");

const seco: SourceManifest = {
  id: "seco-sanctions",
  name: "SECO — Swiss consolidated sanctions list",
  operator: "State Secretariat for Economic Affairs (SECO)",
  url: "https://www.seco.admin.ch/en/searching-for-subjects-sanctions",
  licence: "Official federal publication (embargo ordinances, SR 946.231.x) — free to use; cite SECO as the source",
  attribution: "Source: SECO, Swiss sanctions list (SESAM)",
  updateFrequency: "whenever an annex of an embargo ordinance changes (often several times a month)",
  cacheTtlSeconds: 6 * 3600,
  // A sanctions screen against an old list is misleading: never serve one older than 3 days.
  maxStaleSeconds: 3 * 86_400,
  notes:
    "Full XML list from sesam.search.admin.ch (~40 MB), re-downloaded at most every 6 h and indexed in memory. " +
    "Name matching is diacritic- and case-insensitive over primary names, aliases and Latin spelling variants. " +
    "A match is NOT a legal determination: verify identity (birth date, nationality, documents) against the official entry.",
};

const LIST_URL =
  "https://www.sesam.search.admin.ch/sesam-search-web/pages/downloadXmlGesamtliste.xhtml?lang=en&action=downloadXmlGesamtlisteAction";
const MAX_LIST_BYTES = 120 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Minimal XML tokenizer (the list is machine-generated, well-formed, no CDATA)
// ---------------------------------------------------------------------------

export interface XNode {
  tag: string;
  attrs: Record<string, string>;
  children: XNode[];
  text: string;
}

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeXml(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITY[e.toLowerCase()] ?? m;
  });
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  const re = /([a-zA-Z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) out[m[1]!] = decodeXml(m[2]!);
  return out;
}

/**
 * Stream the children of the document root, calling `onTop` with each
 * complete top-level element. Elements whose tag is in `skipInside` keep their
 * attributes but drop their content (used for <modification> history).
 */
export function scanTopLevel(xml: string, onTop: (n: XNode) => void, skipInside: Set<string> = new Set()): Record<string, string> {
  const re = /<(\/?)([a-zA-Z][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*"[^"]*")*)\s*(\/?)>|<\?[^>]*\?>|<!--[\s\S]*?-->|([^<]+)/g;
  const stack: XNode[] = [];
  let rootAttrs: Record<string, string> = {};
  let skipDepth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const [, close, tag, rawAttrs, selfClose, text] = m;
    if (text !== undefined) {
      if (skipDepth === 0 && stack.length > 1) {
        const t = text.trim();
        if (t) stack[stack.length - 1]!.text += decodeXml(t);
      }
      continue;
    }
    if (!tag) continue; // processing instruction / comment
    if (close) {
      if (skipDepth > 0) {
        skipDepth--;
        if (skipDepth > 0) continue;
      }
      const node = stack.pop();
      if (node && stack.length === 1) onTop(node);
      continue;
    }
    if (skipDepth > 0) {
      if (!selfClose) skipDepth++;
      continue;
    }
    const node: XNode = { tag, attrs: parseAttrs(rawAttrs ?? ""), children: [], text: "" };
    if (stack.length === 0) {
      rootAttrs = node.attrs;
      stack.push(node);
      continue;
    }
    stack[stack.length - 1]!.children.push(node);
    if (selfClose) {
      if (stack.length === 1) onTop(node);
      continue;
    }
    stack.push(node);
    if (skipInside.has(tag)) skipDepth = 1;
  }
  return rootAttrs;
}

const kids = (n: XNode | undefined, tag: string) => (n ? n.children.filter((c) => c.tag === tag) : []);
const kid = (n: XNode | undefined, tag: string) => n?.children.find((c) => c.tag === tag);

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

export interface SanctionsPlace {
  location?: string;
  area?: string;
  country?: string;
  country_iso?: string;
}

export interface SanctionsTarget {
  id: string;
  type: "individual" | "entity" | "object";
  object_type?: string;
  program?: string;
  program_set?: string;
  primary_name: string;
  aliases: string[];
  spelling_variants: string[];
  birth_dates: string[];
  places_of_birth: string[];
  nationalities: string[];
  addresses: string[];
  identification_documents: Array<{ type?: string; number?: string; issuer?: string }>;
  justification?: string;
  other_information: string[];
  related_targets: Array<{ id: string; relation?: string }>;
  status: "listed" | "de-listed";
  listed_on?: string;
  last_change?: { type: string; effective_date?: string };
  /** Normalised strings used for matching (not returned). */
  _match: string[];
}

export interface SanctionsProgram {
  key: string;
  name?: string;
  origin?: string;
  sets: Array<{ id: string; label: string }>;
  versionDate?: string;
}

export interface SanctionsIndex {
  listDate?: string;
  targets: SanctionsTarget[];
  byId: Map<string, SanctionsTarget>;
  programs: SanctionsProgram[];
}

/** Lower-case, strip diacritics and punctuation, collapse whitespace. */
export function normName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const isLatin = (s: string) => /^[\p{Script=Latin}\p{N}\p{P}\p{Zs}'’.-]+$/u.test(s);

function nameOf(nameNode: XNode): { full: string; variants: string[] } {
  const parts = kids(nameNode, "name-part").sort((a, b) => Number(a.attrs["order"] ?? 0) - Number(b.attrs["order"] ?? 0));
  const full = parts
    .map((p) => kid(p, "value")?.text ?? "")
    .filter(Boolean)
    .join(" ");
  const variants: string[] = [];
  // Whole-name variants: for each script+language seen, rebuild the name part
  // by part, using that variant where the part has one and the primary value
  // otherwise — but only if the result stays in a single script.
  const keys = new Set<string>();
  for (const p of parts) for (const v of kids(p, "spelling-variant")) keys.add(`${v.attrs["script"] ?? ""}|${v.attrs["lang"] ?? ""}`);
  for (const key of keys) {
    const script = key.split("|")[0];
    const rebuilt = parts.map((p) => {
      const v = kids(p, "spelling-variant").find((x) => `${x.attrs["script"] ?? ""}|${x.attrs["lang"] ?? ""}` === key);
      return v?.text || (script === "LATN" ? (kid(p, "value")?.text ?? "") : "");
    });
    if (rebuilt.some((x) => !x)) {
      // A non-Latin variant missing for some part: keep only the parts that have it.
      const partial = rebuilt.filter(Boolean).join(" ");
      if (partial && partial !== full && !variants.includes(partial)) variants.push(partial);
      continue;
    }
    const joined = rebuilt.join(" ");
    if (joined !== full && !variants.includes(joined)) variants.push(joined);
  }
  return { full, variants };
}

function dayMonthYear(n: XNode): string | undefined {
  const { year, month, day } = n.attrs;
  if (!year) return undefined;
  const pad = (v?: string) => (v ? v.padStart(2, "0") : undefined);
  return [year, pad(month), pad(day)].filter(Boolean).join("-");
}

function placeText(p: SanctionsPlace | undefined): string | undefined {
  if (!p) return undefined;
  return [p.location, p.area, p.country].filter(Boolean).join(", ") || undefined;
}

function addressText(a: XNode, places: Map<string, SanctionsPlace>): string | undefined {
  const parts = [
    kid(a, "c-o")?.text ? `c/o ${kid(a, "c-o")!.text}` : undefined,
    kid(a, "address-details")?.text,
    kid(a, "p-o-box")?.text ? `P.O. Box ${kid(a, "p-o-box")!.text}` : undefined,
    kid(a, "zip-code")?.text,
    placeText(places.get(a.attrs["place-id"] ?? "")),
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
}

/** Parse the full SECO XML into a searchable index. Pure (no I/O). */
export function parseSanctionsXml(xml: string): SanctionsIndex {
  const programs: SanctionsProgram[] = [];
  const setToProgram = new Map<string, { program: SanctionsProgram; label: string }>();
  const places = new Map<string, SanctionsPlace>();
  const rawTargets: XNode[] = [];

  const root = scanTopLevel(
    xml,
    (n) => {
      if (n.tag === "target") rawTargets.push(n);
      else if (n.tag === "place") {
        const c = kid(n, "country");
        places.set(n.attrs["ssid"] ?? "", {
          location: kid(n, "location")?.text || undefined,
          area: kid(n, "area")?.text || undefined,
          country: c?.text || undefined,
          country_iso: c?.attrs["iso-code"],
        });
      } else if (n.tag === "sanctions-program") {
        const key = kids(n, "program-key").find((k) => k.attrs["lang"] === "eng")?.text ?? kid(n, "program-key")?.text ?? "";
        let program = programs.find((p) => p.key === key);
        if (!program) {
          program = {
            key,
            name: kids(n, "program-name").find((k) => k.attrs["lang"] === "eng")?.text,
            origin: kid(n, "origin")?.text,
            sets: [],
            versionDate: n.attrs["version-date"],
          };
          programs.push(program);
        }
        for (const s of kids(n, "sanctions-set").filter((x) => x.attrs["lang"] === "eng")) {
          const id = s.attrs["ssid"] ?? "";
          if (!program.sets.some((x) => x.id === id)) program.sets.push({ id, label: s.text });
          setToProgram.set(id, { program, label: s.text });
        }
      }
    },
    new Set(["modification"]),
  );

  const targets: SanctionsTarget[] = [];
  for (const t of rawTargets) {
    const body = t.children.find((c) => c.tag === "individual" || c.tag === "entity" || c.tag === "object");
    if (!body) continue;
    const setId = kid(t, "sanctions-set-id")?.text ?? "";
    const prog = setToProgram.get(setId);
    const identities = kids(body, "identity");
    const main = identities.find((i) => i.attrs["main"] === "true") ?? identities[0];
    let primary = "";
    const aliases: string[] = [];
    const variants: string[] = [];
    const births: string[] = [];
    const pobs: string[] = [];
    const nats: string[] = [];
    const addrs: string[] = [];
    const docs: SanctionsTarget["identification_documents"] = [];
    for (const idn of identities) {
      for (const nm of kids(idn, "name")) {
        const { full, variants: v } = nameOf(nm);
        if (!full) continue;
        if (!primary && idn === main && nm.attrs["name-type"] === "primary-name") primary = full;
        else if (full !== primary && !aliases.includes(full)) aliases.push(full);
        for (const x of v) if (!variants.includes(x)) variants.push(x);
      }
      for (const d of kids(idn, "day-month-year")) {
        const s = dayMonthYear(d);
        if (s && !births.includes(s)) births.push(s);
      }
      for (const p of kids(idn, "place-of-birth")) {
        const s = placeText(places.get(p.attrs["place-id"] ?? ""));
        if (s && !pobs.includes(s)) pobs.push(s);
      }
      for (const n of kids(idn, "nationality")) {
        const c = kid(n, "country");
        const s = c?.text ? `${c.text}${c.attrs["iso-code"] ? ` (${c.attrs["iso-code"]})` : ""}` : undefined;
        if (s && !nats.includes(s)) nats.push(s);
      }
      for (const a of kids(idn, "address")) {
        const s = addressText(a, places);
        if (s && !addrs.includes(s)) addrs.push(s);
      }
      for (const d of kids(idn, "identification-document")) {
        docs.push({
          type: d.attrs["document-type"],
          number: kid(d, "number")?.text || undefined,
          issuer: kid(d, "issuer")?.text || undefined,
        });
      }
    }
    if (!primary) primary = aliases.shift() ?? "";
    if (!primary) continue;
    const mods = kids(t, "modification");
    const latest = mods[0];
    const listed = mods.find((m) => m.attrs["modification-type"] === "listed");
    const status: SanctionsTarget["status"] = latest?.attrs["modification-type"] === "de-listed" ? "de-listed" : "listed";
    const all = [primary, ...aliases, ...variants.filter(isLatin)];
    targets.push({
      id: t.attrs["ssid"] ?? "",
      type: body.tag as SanctionsTarget["type"],
      ...(body.attrs["object-type"] ? { object_type: body.attrs["object-type"] } : {}),
      program: prog?.program.key,
      program_set: prog?.label,
      primary_name: primary,
      aliases,
      spelling_variants: variants,
      birth_dates: births,
      places_of_birth: pobs,
      nationalities: nats,
      addresses: addrs,
      identification_documents: docs,
      justification: kid(body, "justification")?.text || undefined,
      other_information: kids(body, "other-information").map((o) => o.text).filter(Boolean),
      related_targets: kids(body, "relation").map((r) => ({ id: r.attrs["target-id"] ?? "", relation: r.attrs["relation-type"] })),
      status,
      listed_on: listed?.attrs["effective-date"] ?? listed?.attrs["publication-date"],
      ...(latest
        ? { last_change: { type: latest.attrs["modification-type"] ?? "", effective_date: latest.attrs["effective-date"] } }
        : {}),
      _match: [...new Set(all.map(normName).filter(Boolean))],
    });
  }
  return {
    listDate: root["date"],
    targets,
    byId: new Map(targets.map((t) => [t.id, t])),
    programs: programs.sort((a, b) => a.key.localeCompare(b.key)),
  };
}

/**
 * Score a target against a normalised query: 100 exact name, 80 all tokens
 * as whole words, 60 all tokens as word prefixes, 0 otherwise.
 */
export function matchScore(t: Pick<SanctionsTarget, "_match">, q: string): number {
  const tokens = q.split(" ").filter(Boolean);
  if (!tokens.length) return 0;
  let best = 0;
  for (const n of t._match) {
    if (n === q) return 100;
    const words = n.split(" ");
    if (tokens.every((tk) => words.includes(tk))) best = Math.max(best, 80);
    else if (tokens.every((tk) => words.some((w) => w.startsWith(tk)))) best = Math.max(best, 60);
  }
  return best;
}

export interface SearchOptions {
  name: string;
  type?: "individual" | "entity" | "object";
  program?: string;
  includeDelisted?: boolean;
  limit: number;
}

export function searchIndex(idx: SanctionsIndex, o: SearchOptions): { total: number; hits: Array<{ score: number; target: SanctionsTarget }> } {
  const q = normName(o.name);
  const prog = o.program ? normName(o.program) : undefined;
  const hits: Array<{ score: number; target: SanctionsTarget }> = [];
  for (const t of idx.targets) {
    if (!o.includeDelisted && t.status === "de-listed") continue;
    if (o.type && t.type !== o.type) continue;
    if (prog && !normName(t.program ?? "").includes(prog)) continue;
    const score = matchScore(t, q);
    if (score) hits.push({ score, target: t });
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      (a.target.status === b.target.status ? 0 : a.target.status === "listed" ? -1 : 1) ||
      a.target.primary_name.localeCompare(b.target.primary_name),
  );
  return { total: hits.length, hits: hits.slice(0, o.limit) };
}

export function publicTarget(t: SanctionsTarget, full = false) {
  const { _match, ...rest } = t;
  void _match;
  if (full) return rest;
  return {
    id: t.id,
    type: t.type,
    ...(t.object_type ? { object_type: t.object_type } : {}),
    name: t.primary_name,
    ...(t.aliases.length ? { aliases: t.aliases.slice(0, 8) } : {}),
    status: t.status,
    program: t.program,
    ...(t.birth_dates.length ? { birth_dates: t.birth_dates } : {}),
    ...(t.nationalities.length ? { nationalities: t.nationalities } : {}),
    ...(t.listed_on ? { listed_on: t.listed_on } : {}),
    ...(t.justification ? { justification: t.justification.slice(0, 300) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Loader: one download + parse at a time, keep the last good index
// ---------------------------------------------------------------------------

const INDEX_TTL_MS = seco.cacheTtlSeconds * 1000;
const INDEX_MAX_STALE_MS = (seco.maxStaleSeconds ?? seco.cacheTtlSeconds) * 1000;
/** On-disk snapshot of the parsed index (LKG store; only when SWISSYPHUS_LKG_DIR is set). */
const SNAPSHOT_KEY = "seco-sanctions:index:v1";
const SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024;
let current: { index: SanctionsIndex; loadedAt: number; cacheStatus: CacheStatus } | undefined;
let loading: Promise<void> | undefined;
let snapshotTried = false;

type SnapshotBody = Pick<SanctionsIndex, "listDate" | "targets" | "programs">;

function saveSnapshot(index: SanctionsIndex, loadedAt: number): void {
  try {
    const body: SnapshotBody = { listDate: index.listDate, targets: index.targets, programs: index.programs };
    lkgPut(
      SNAPSHOT_KEY,
      { body: JSON.stringify(body), storedAt: loadedAt, ttlMs: INDEX_TTL_MS, maxStaleMs: INDEX_MAX_STALE_MS },
      { maxEntryBytes: SNAPSHOT_MAX_BYTES },
    );
  } catch {
    // The snapshot is an optimisation only.
  }
}

/** Restore the last parsed index from disk (once per process), so a restart does not mean a 40 MB cold load. */
async function restoreSnapshot(): Promise<void> {
  if (snapshotTried || current) return;
  snapshotTried = true;
  try {
    const rec = await lkgGet(SNAPSHOT_KEY);
    if (!rec || current) return;
    const body = JSON.parse(rec.body) as SnapshotBody;
    if (!Array.isArray(body.targets) || body.targets.length < 1000 || !Array.isArray(body.programs)) return;
    const index: SanctionsIndex = {
      ...(body.listDate ? { listDate: body.listDate } : {}),
      targets: body.targets,
      programs: body.programs,
      byId: new Map(body.targets.map((t) => [t.id, t])),
    };
    current = { index, loadedAt: rec.storedAt, cacheStatus: "stale" };
    debugLog(`[sanctions] restored ${index.targets.length} targets from the on-disk snapshot`);
  } catch {
    // Unreadable snapshot: fall through to a download.
  }
}

async function loadIndex(): Promise<void> {
  const res = await fetchCached(LIST_URL, {
    ttlMs: INDEX_TTL_MS,
    timeoutMs: 120_000,
    maxBytes: MAX_LIST_BYTES,
    noStore: true,
    init: { headers: { Accept: "application/xml,text/xml" } },
  });
  const index = parseSanctionsXml(res.data);
  if (index.targets.length < 1000) {
    throw new SourceError(
      `SECO sanctions list looks incomplete (${index.targets.length} targets parsed).`,
      "www.sesam.search.admin.ch",
      undefined,
      "invalid_response",
    );
  }
  const loadedAt = Date.now();
  current = { index, loadedAt, cacheStatus: "miss" };
  saveSnapshot(index, loadedAt);
}

function refresh(): Promise<void> {
  if (!loading) {
    loading = outsideBudget(() => loadIndex()).finally(() => {
      loading = undefined;
    });
  }
  return loading;
}

/**
 * Background warm-up (HTTP mode): restore the on-disk snapshot, then download
 * the list if nothing usable is loaded, so no caller waits for the cold load.
 */
export async function warmSanctionsIndex(): Promise<void> {
  try {
    await restoreSnapshot();
    if (!current || Date.now() - current.loadedAt >= INDEX_TTL_MS) await refresh();
  } catch (err) {
    debugLog(`[sanctions] warm-up failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Index for a tool call; waits at most `waitMs` for a cold load (the download keeps going in the background). */
export async function getIndex(waitMs = 25_000): Promise<{ index: SanctionsIndex; retrievedAt: string; cacheStatus: CacheStatus }> {
  const r = await getIndexUncounted(waitMs);
  // Screening runs on the in-memory index; record the list download it comes from.
  recordUpstream({ url: LIST_URL, cacheStatus: r.cacheStatus, retrievedAt: r.retrievedAt });
  return r;
}

async function getIndexUncounted(waitMs: number): Promise<{ index: SanctionsIndex; retrievedAt: string; cacheStatus: CacheStatus }> {
  await restoreSnapshot();
  const age = current ? Date.now() - current.loadedAt : Infinity;
  if (current && age < INDEX_TTL_MS) {
    return { index: current.index, retrievedAt: new Date(current.loadedAt).toISOString(), cacheStatus: "hit" };
  }
  if (current && age < INDEX_MAX_STALE_MS) {
    // Stale but still usable: serve the last good index and refresh in the background.
    void refresh().catch(() => undefined);
    return { index: current.index, retrievedAt: new Date(current.loadedAt).toISOString(), cacheStatus: "stale" };
  }
  await withDeadline(refresh(), waitMs, "Loading the SECO sanctions list");
  const c = current as { index: SanctionsIndex; loadedAt: number } | undefined;
  if (!c || Date.now() - c.loadedAt >= INDEX_MAX_STALE_MS) {
    throw new SourceError("SECO sanctions list could not be loaded.", "www.sesam.search.admin.ch");
  }
  return { index: c.index, retrievedAt: new Date(c.loadedAt).toISOString(), cacheStatus: "miss" };
}

/** Test hook. */
export function setSanctionsIndexForTests(index: SanctionsIndex | undefined, loadedAt = Date.now()): void {
  current = index ? { index, loadedAt, cacheStatus: "miss" } : undefined;
  snapshotTried = index !== undefined;
}

function loadError(err: unknown) {
  if (err instanceof Error && /timed out after/.test(err.message)) {
    return toolError("The SECO sanctions list (~40 MB) is still downloading.", [
      "Retry in about a minute — the download continues in the background and is then cached for 6 hours.",
    ], { kind: "unavailable" });
  }
  return errorToResult(err, "SECO sanctions list");
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export const sanctionsModule: SwissyphusModule = {
  id: "sanctions",
  emoji: "🚫",
  title: "Sanctions (SECO)",
  description:
    "Screen names against the Swiss consolidated sanctions list (SECO): individuals, companies/organisations and vessels/objects under all Swiss embargo ordinances, with aliases, birth data, nationality, documents and listing history",
  sources: [seco],
  healthProbes: [{ sourceId: "seco-sanctions", url: "https://www.seco.admin.ch/en/searching-for-subjects-sanctions" }],
  warmUp: warmSanctionsIndex,
  tools: [
    tool({
      name: "search_sanctions_list",
      title: "Search the Swiss sanctions list",
      description:
        "Screen a person, company or vessel name against the Swiss consolidated sanctions list (SECO, all embargo programmes: Russia/Ukraine, Belarus, Iran, Syria, North Korea, ISIL/Al-Qaida, …). " +
        "Matching is case- and diacritic-insensitive over primary names, aliases and Latin transliterations; all query words must match (as words or word prefixes). " +
        "Returns current listings only unless include_delisted=true. A hit is a lead, not a legal determination: compare birth dates, nationality and documents via get_sanctions_entry. " +
        "Example: {name: 'Rotenberg'}, {name: 'Aeroflot', type: 'entity'}.",
      inputSchema: {
        name: z.string().min(2).max(200).describe("Name or name fragment, e.g. 'Arkady Rotenberg', 'Sovcomflot'"),
        type: z.enum(["individual", "entity", "object"]).optional().describe("Restrict to individuals, entities (companies/organisations) or objects (vessels, aircraft)"),
        program: z.string().max(80).optional().describe("Restrict to a sanctions programme, e.g. 'Ukraine', 'Iran', 'Syria' (see list_sanctions_programs)"),
        include_delisted: z.boolean().default(false).describe("Also return entries that have since been de-listed"),
        limit: z.number().int().min(1).max(50).default(10),
      },
      handler: async ({ name, type, program, include_delisted, limit }) => {
        let loaded;
        try {
          loaded = await getIndex();
        } catch (err) {
          return loadError(err);
        }
        const { total, hits } = searchIndex(loaded.index, { name, type, program, includeDelisted: include_delisted, limit });
        if (!hits.length) {
          return respond(
            {
              query: { name, type, program, include_delisted },
              list_date: loaded.index.listDate,
              total_matches: 0,
              results: [],
              note: "No match on the Swiss sanctions list for this name. Absence of a match is not a clearance for other lists (EU, UN, OFAC).",
            },
            { source: seco, cacheStatus: loaded.cacheStatus, retrievedAt: loaded.retrievedAt, dataAsOf: loaded.index.listDate },
          );
        }
        return respond(
          {
            query: { name, type, program, include_delisted },
            list_date: loaded.index.listDate,
            total_matches: total,
            results: hits.map((h) => ({ match: h.score === 100 ? "exact" : h.score === 80 ? "all words" : "word prefixes", ...publicTarget(h.target) })),
            hint: "get_sanctions_entry {id} returns the full entry (documents, addresses, relations, legal basis).",
          },
          { source: seco, cacheStatus: loaded.cacheStatus, retrievedAt: loaded.retrievedAt, dataAsOf: loaded.index.listDate },
        );
      },
    }),
    tool({
      name: "get_sanctions_entry",
      title: "Sanctions list entry",
      description:
        "Full SECO sanctions-list entry by id (from search_sanctions_list): all names and transliterations, birth dates and places, nationalities, addresses, identity documents, justification, legal basis (programme and annex), related entries and listing status/history.",
      inputSchema: {
        id: z.string().regex(/^\d{1,10}$/, "Numeric entry id").describe("Entry id from search_sanctions_list, e.g. '5142'"),
      },
      handler: async ({ id }) => {
        let loaded;
        try {
          loaded = await getIndex();
        } catch (err) {
          return loadError(err);
        }
        const t = loaded.index.byId.get(id);
        if (!t) return toolError(`No sanctions-list entry with id ${id}.`, ["Find ids with search_sanctions_list."]);
        const related = t.related_targets.map((r) => ({
          ...r,
          name: loaded.index.byId.get(r.id)?.primary_name,
        }));
        return respond(
          { ...publicTarget(t, true), related_targets: related, list_date: loaded.index.listDate },
          { source: seco, cacheStatus: loaded.cacheStatus, retrievedAt: loaded.retrievedAt, dataAsOf: loaded.index.listDate },
        );
      },
    }),
    tool({
      name: "list_sanctions_programs",
      title: "Swiss sanctions programmes",
      description:
        "All Swiss sanctions programmes (embargo ordinances) on the SECO list with their legal basis, origin (UN/EU/CH), annexes/measure sets and the number of currently listed individuals, entities and objects.",
      inputSchema: {},
      handler: async () => {
        let loaded;
        try {
          loaded = await getIndex();
        } catch (err) {
          return loadError(err);
        }
        const counts = new Map<string, { individual: number; entity: number; object: number }>();
        for (const t of loaded.index.targets) {
          if (t.status !== "listed" || !t.program) continue;
          const c = counts.get(t.program) ?? { individual: 0, entity: 0, object: 0 };
          c[t.type]++;
          counts.set(t.program, c);
        }
        return respond(
          {
            list_date: loaded.index.listDate,
            programs: loaded.index.programs.map((p) => ({
              program: p.key,
              legal_basis: p.name,
              origin: p.origin,
              listed: counts.get(p.key) ?? { individual: 0, entity: 0, object: 0 },
              measures: p.sets.map((s) => s.label).slice(0, 10),
            })),
          },
          { source: seco, cacheStatus: loaded.cacheStatus, retrievedAt: loaded.retrievedAt, dataAsOf: loaded.index.listDate },
        );
      },
    }),
  ],
};
