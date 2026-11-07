/**
 * BFS STAT-TAB module — generic access to every table in the Federal
 * Statistical Office's PXWeb database (www.pxweb.bfs.admin.ch).
 *
 * PXWeb API v1 (documented by Statistics Sweden / PX-Web):
 *   GET  /api/v1/{lang}/                    → list of databases [{dbid, text}]
 *   GET  /api/v1/{lang}/{path}              → node children [{id, type 'l'|'t', text, updated}]
 *   GET  /api/v1/{lang}/{db}?query=…        → search inside one database
 *   GET  /api/v1/{lang}/{…}/{table}.px      → table metadata {title, variables[]}
 *   POST /api/v1/{lang}/{…}/{table}.px      → data (json / json-stat2)
 *
 * At BFS every table is published as its *own* database whose id equals the
 * table id (e.g. px-x-0102010000_101), so a table's API path is
 * `{id}/{id}.px` (the pattern already used by get_population). That also means
 * the per-database PXWeb search cannot search across tables; search_bfs_tables
 * therefore ranks the (cached) root database listing locally, falling back to
 * the curated seed index below when the listing is unavailable.
 */

import { z } from "zod";
import { allowHosts, fetchCached, SourceError, TooLargeError } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { CacheStatus, SourceManifest } from "../core/types.js";
import { registerSearcher, type DataHit } from "../core/discovery.js";

const HOST = "www.pxweb.bfs.admin.ch";
allowHosts(HOST);

const API = `https://${HOST}/api/v1`;

export const BFS_LANGS = ["de", "fr", "it", "en"] as const;
export type BfsLang = (typeof BFS_LANGS)[number];

/** Refuse data queries whose selection yields more cells than this. */
export const MAX_CELLS = 5000;

const source: SourceManifest = {
  id: "bfs-stat-tab",
  name: "BFS STAT-TAB (PXWeb) — all Federal Statistical Office tables",
  operator: "Federal Statistical Office (BFS/OFS/UST)",
  url: "https://www.pxweb.bfs.admin.ch",
  licence: "Swiss OGD terms (opendata.swiss 'terms_by') — free use with source attribution",
  attribution: "© Federal Statistical Office (BFS), STAT-TAB",
  updateFrequency: "per table: monthly to yearly (see 'updated' on each table)",
  cacheTtlSeconds: 12 * 3600,
  notes:
    "PXWeb API v1. Every BFS table is its own PXWeb database (path {id}/{id}.px). Table search ranks the root " +
    "database listing locally (the PXWeb ?query= search is per-database); if the listing is unreachable a curated " +
    "seed index is used, whose ids are best-effort and partly unverified. Variable codes are German across all " +
    "languages; value codes are language-independent. Data queries are capped at " +
    `${MAX_CELLS} cells; PXWeb also rate-limits (roughly 30 requests / 10 s per IP). ` +
    "json responses are decoded with labels from the table metadata; json-stat2 is also understood.",
};

const TTL_MS = source.cacheTtlSeconds * 1000;

// ── Types ─────────────────────────────────────────────────────────────────

export interface PxVariable {
  code: string;
  text?: string;
  values?: string[];
  valueTexts?: string[];
  time?: boolean;
  elimination?: boolean;
}

export interface PxMetadata {
  title?: string;
  variables?: PxVariable[];
}

export interface PxQueryItem {
  code: string;
  selection: { filter: "item"; values: string[] };
}

export interface PxQueryBody {
  query: PxQueryItem[];
  response: { format: "json" | "json-stat2" };
}

// ── Text helpers ──────────────────────────────────────────────────────────

/** Lower-case, strip diacritics and punctuation, collapse whitespace. */
export function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function tokens(s: string): string[] {
  return normalizeText(s)
    .split(" ")
    .filter((t) => t.length >= 2);
}

/**
 * Turn a table id, API path or STAT-TAB URL into the API path of the .px file.
 * Returns undefined for anything that is not a safe PXWeb path.
 */
export function resolveTablePath(input: string): string | undefined {
  const raw = input.trim();
  if (!raw) return undefined;
  if (raw.includes("://")) {
    const m = raw.match(/px-x-\d{6,12}_\d{1,4}/i);
    return m ? `${m[0]}/${m[0]}.px` : undefined;
  }
  const s = raw.replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9_.\-/]+$/.test(s) || s.split("/").some((seg) => seg === "." || seg === "..")) return undefined;
  const segs = s.split("/").filter(Boolean);
  if (!segs.length) return undefined;
  if (segs.length === 1) {
    const id = segs[0].replace(/\.px$/i, "");
    return `${id}/${id}.px`;
  }
  const last = segs[segs.length - 1];
  if (!/\.px$/i.test(last)) segs[segs.length - 1] = `${last}.px`;
  return segs.join("/");
}

/** Validate a browse path (levels inside the PXWeb tree). */
export function sanitizeBrowsePath(input: string | undefined): string | undefined | null {
  if (input === undefined) return undefined;
  const s = input.trim().replace(/^\/+|\/+$/g, "");
  if (!s) return undefined;
  if (!/^[A-Za-z0-9_.\-/]+$/.test(s) || s.split("/").some((seg) => seg === "." || seg === "..")) return null;
  return s;
}

function tableIdFromPath(path: string): string {
  const segs = path.split("/");
  return segs[segs.length - 1].replace(/\.px$/i, "");
}

function apiUrl(lang: BfsLang, path = ""): string {
  const encoded = path
    .split("/")
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `${API}/${lang}/${encoded}`;
}

export function toBfsLang(lang: string | undefined): BfsLang {
  const l = (lang ?? "").toLowerCase().slice(0, 2);
  return (BFS_LANGS as readonly string[]).includes(l) ? (l as BfsLang) : "en";
}

// ── Variable & value matching ─────────────────────────────────────────────

const TIME_NAME = /^(jahr|jahre|year|years|annee|annees|anno|anni|zeitraum|zeit|periode|period|quartal|quarter|trimestre|monat|month|mois|mese|semester|semestre|woche|week|semaine|settimana|stichtag|datum|date|data)\b/;
const TIME_VALUE = /^(1[89]|20)\d{2}([-/ ]?[MQHWS]?\d{1,2})?$/i;

/** Is this the table's time dimension? (PXWeb `time` flag, name, or year-like values.) */
export function isTimeVariable(v: PxVariable): boolean {
  if (v.time === true) return true;
  if (TIME_NAME.test(normalizeText(v.code)) || TIME_NAME.test(normalizeText(v.text ?? ""))) return true;
  const vals = v.values ?? [];
  return vals.length > 1 && vals.every((x) => TIME_VALUE.test(x.trim()));
}

const AGG_CODES = new Set(["_t", "t", "total", "tot", "ch"]);
const AGG_WORDS_STRONG = [
  "total",
  "totale",
  "totaux",
  "gesamt",
  "gesamthaft",
  "insgesamt",
  "summe",
  "ensemble",
  "alle",
  "tous",
  "toutes",
  "tutti",
  "tutte",
  "all",
];
const AGG_WORDS_GEO = ["schweiz", "suisse", "svizzera", "switzerland", "svizra"];

function startsWithWord(text: string, words: string[]): boolean {
  return words.some((w) => text === w || text.startsWith(`${w} `));
}

/**
 * Index of the aggregate ("Total", "Schweiz", code -99999…) value of a variable,
 * or -1 if none is recognisable.
 */
export function findAggregateIndex(v: PxVariable): number {
  const values = v.values ?? [];
  const texts = v.valueTexts ?? [];
  const byCode = values.findIndex((c) => c === "-99999");
  if (byCode >= 0) return byCode;
  const strong = texts.findIndex((t) => {
    const n = normalizeText(t);
    return startsWithWord(n, AGG_WORDS_STRONG) || / total$| gesamt$| insgesamt$| totale$/.test(n);
  });
  if (strong >= 0) return strong;
  const geo = texts.findIndex((t) => startsWithWord(normalizeText(t), AGG_WORDS_GEO));
  if (geo >= 0) return geo;
  return values.findIndex((c) => AGG_CODES.has(c.toLowerCase()));
}

export interface VariableMatch {
  variable?: PxVariable;
  ambiguous?: string[];
}

/** Match a user-supplied variable name against codes/texts (case- and diacritic-insensitive). */
export function matchVariable(variables: PxVariable[], name: string): VariableMatch {
  const exact = variables.find((v) => v.code === name);
  if (exact) return { variable: exact };
  const n = normalizeText(name);
  if (!n) return {};
  const eq = variables.filter((v) => normalizeText(v.code) === n || normalizeText(v.text ?? "") === n);
  if (eq.length === 1) return { variable: eq[0] };
  if (eq.length > 1) return { ambiguous: eq.map((v) => v.code) };
  const partial = variables.filter((v) => {
    const c = normalizeText(v.code);
    const t = normalizeText(v.text ?? "");
    return c.startsWith(n) || t.startsWith(n) || c.includes(n) || t.includes(n);
  });
  if (partial.length === 1) return { variable: partial[0] };
  if (partial.length > 1) return { ambiguous: partial.map((v) => v.code) };
  return {};
}

export interface ValueMatch {
  codes: string[];
  errors: string[];
}

/**
 * Resolve requested values (codes or texts) of one variable to value codes, in
 * metadata order. Special forms: "*" / "all" = every value; "latest" / "last"
 * = last value (PXWeb lists time ascending); "latest:N" / "last N" = last N
 * values; for time variables "2015-2020" = inclusive range.
 */
export function matchValues(v: PxVariable, requested: string[]): ValueMatch {
  const values = v.values ?? [];
  const texts = v.valueTexts ?? [];
  const picked = new Set<number>();
  const errors: string[] = [];
  const time = isTimeVariable(v);

  for (const reqRaw of requested) {
    const req = String(reqRaw).trim();
    if (!req) continue;
    const lower = req.toLowerCase();
    if (lower === "*" || lower === "all") {
      values.forEach((_, i) => picked.add(i));
      continue;
    }
    const lastN = lower.match(/^(?:latest|last|newest|neueste?s?)(?:\s*[:= ]\s*(\d{1,4}))?$/);
    if (lastN) {
      const n = Math.max(1, Math.min(values.length, Number(lastN[1] ?? 1)));
      for (let i = values.length - n; i < values.length; i++) if (i >= 0) picked.add(i);
      continue;
    }
    if (lower === "first" || lower === "earliest") {
      if (values.length) picked.add(0);
      continue;
    }
    const exactCode = values.indexOf(req);
    if (exactCode >= 0) {
      picked.add(exactCode);
      continue;
    }
    if (time) {
      const range = req.match(/^(\d{4})\s*(?:-|–|\.\.|to|bis|à|a)\s*(\d{4})$/i);
      if (range) {
        const [lo, hi] = [range[1], range[2]].sort();
        let any = false;
        values.forEach((c, i) => {
          const y = c.slice(0, 4);
          if (y >= lo && y <= hi) {
            picked.add(i);
            any = true;
          }
        });
        if (!any) errors.push(`'${v.code}': no values in range ${req} (available ${values[0]}…${values[values.length - 1]}).`);
        continue;
      }
    }
    const ciCode = values.findIndex((c) => c.toLowerCase() === lower);
    if (ciCode >= 0) {
      picked.add(ciCode);
      continue;
    }
    const n = normalizeText(req);
    const eqText = texts.reduce<number[]>((acc, t, i) => (normalizeText(t) === n ? [...acc, i] : acc), []);
    if (eqText.length >= 1) {
      picked.add(eqText[0]);
      continue;
    }
    // Tolerate texts that carry a numbering prefix ("......0261 Zürich", "- Bern").
    const stripped = texts.reduce<number[]>(
      (acc, t, i) => (normalizeText(t).replace(/^[\d\s]+/, "") === n ? [...acc, i] : acc),
      [],
    );
    if (stripped.length === 1) {
      picked.add(stripped[0]);
      continue;
    }
    const partial = n
      ? texts.reduce<number[]>((acc, t, i) => (normalizeText(t).includes(n) ? [...acc, i] : acc), [])
      : [];
    if (partial.length === 1) {
      picked.add(partial[0]);
      continue;
    }
    if (partial.length > 1) {
      // Prefer a text that starts with the request (e.g. "Bern" vs "Bernex").
      const starts = partial.filter((i) => normalizeText(texts[i]).startsWith(n));
      if (starts.length === 1) {
        picked.add(starts[0]);
        continue;
      }
      const sample = partial.slice(0, 6).map((i) => `${values[i]}=${texts[i]}`);
      errors.push(
        `'${v.code}': '${req}' is ambiguous (${partial.length} matches, e.g. ${sample.join("; ")}). Use a value code.`,
      );
      continue;
    }
    const examples = values.slice(0, 6).map((c, i) => `${c}=${texts[i] ?? c}`);
    errors.push(
      `'${v.code}': no value matches '${req}'. Examples: ${examples.join("; ")}${values.length > 6 ? "; …" : ""} ` +
        `(${values.length} values; list them with get_bfs_table_metadata variable='${v.code}').`,
    );
  }
  return { codes: [...picked].sort((a, b) => a - b).map((i) => values[i]), errors };
}

// ── Selection building ────────────────────────────────────────────────────

export type SelectionMode = "requested" | "default-latest" | "default-total" | "default-first" | "eliminated";

export interface SelectedVariable {
  code: string;
  text: string;
  values: string[];
  mode: SelectionMode;
}

export interface SelectionResult {
  selected: SelectedVariable[];
  defaults: string[];
  errors: string[];
  cells: number;
}

/** Product of the per-variable counts (eliminated variables count 1). */
export function estimateCells(counts: number[]): number {
  return counts.reduce((p, c) => p * Math.max(1, c), 1);
}

function labelOf(v: PxVariable, code: string): string {
  const i = (v.values ?? []).indexOf(code);
  return i >= 0 ? (v.valueTexts?.[i] ?? code) : code;
}

/** Default value choice for an unspecified variable. */
export function defaultSelection(v: PxVariable): SelectedVariable {
  const text = v.text ?? v.code;
  const values = v.values ?? [];
  if (isTimeVariable(v) && values.length) {
    return { code: v.code, text, values: [values[values.length - 1]], mode: "default-latest" };
  }
  const agg = findAggregateIndex(v);
  if (agg >= 0) return { code: v.code, text, values: [values[agg]], mode: "default-total" };
  if (v.elimination === true) return { code: v.code, text, values: [], mode: "eliminated" };
  return { code: v.code, text, values: values.length ? [values[0]] : [], mode: "default-first" };
}

function describeDefault(v: PxVariable, s: SelectedVariable): string {
  switch (s.mode) {
    case "default-latest":
      return `${s.text} (${s.code}): latest period '${labelOf(v, s.values[0])}'`;
    case "default-total":
      return `${s.text} (${s.code}): aggregate '${labelOf(v, s.values[0])}'`;
    case "eliminated":
      return `${s.text} (${s.code}): not selected — PXWeb sums over all its values (elimination)`;
    default:
      return `${s.text} (${s.code}): no total found, used first value '${labelOf(v, s.values[0] ?? "")}'`;
  }
}

/**
 * Build the per-variable selection from user input. Keys may be variable codes
 * or texts; values codes or texts (see matchValues). Unspecified variables get
 * a documented default.
 */
export function buildSelection(
  meta: PxMetadata,
  selection: Record<string, string | string[]> = {},
): SelectionResult {
  const variables = meta.variables ?? [];
  const errors: string[] = [];
  const chosen = new Map<string, SelectedVariable>();

  for (const [name, rawVals] of Object.entries(selection)) {
    const m = matchVariable(variables, name);
    if (!m.variable) {
      errors.push(
        m.ambiguous
          ? `Variable '${name}' is ambiguous: ${m.ambiguous.join(", ")}.`
          : `Unknown variable '${name}'. Variables: ${variables.map((v) => `${v.code} (${v.text ?? v.code})`).join(", ")}.`,
      );
      continue;
    }
    const v = m.variable;
    const list = Array.isArray(rawVals) ? rawVals : String(rawVals).split(/\s*[,;|]\s*/);
    const { codes, errors: vErr } = matchValues(v, list.map(String));
    errors.push(...vErr);
    if (!vErr.length && !codes.length) errors.push(`'${v.code}': empty selection.`);
    const prev = chosen.get(v.code);
    const merged = prev ? [...new Set([...prev.values, ...codes])] : codes;
    chosen.set(v.code, { code: v.code, text: v.text ?? v.code, values: merged, mode: "requested" });
  }

  const selected: SelectedVariable[] = [];
  const defaults: string[] = [];
  for (const v of variables) {
    const s = chosen.get(v.code);
    if (s) {
      // keep metadata order for determinism
      const order = v.values ?? [];
      s.values.sort((a, b) => order.indexOf(a) - order.indexOf(b));
      selected.push(s);
    } else {
      const d = defaultSelection(v);
      selected.push(d);
      defaults.push(describeDefault(v, d));
    }
  }
  const cells = estimateCells(selected.map((s) => (s.mode === "eliminated" ? 1 : s.values.length)));
  return { selected, defaults, errors, cells };
}

export function buildQueryBody(selected: SelectedVariable[], format: "json" | "json-stat2" = "json"): PxQueryBody {
  return {
    query: selected
      .filter((s) => s.mode !== "eliminated" && s.values.length)
      .map((s) => ({ code: s.code, selection: { filter: "item", values: s.values } })),
    response: { format },
  };
}

// ── Response decoding ─────────────────────────────────────────────────────

export interface DecodedDimension {
  code: string;
  text: string;
  labels: Map<string, string>;
}

export interface DecodedTable {
  dimensions: DecodedDimension[];
  contents: string[];
  records: Array<{ keys: string[]; values: Array<number | null> }>;
  notes: string[];
}

/** Parse a PXWeb cell: numbers stay numbers; "...", "-", "()", "" etc. become null. */
export function parseCell(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/['’ ]/g, "");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
  return Number(s);
}

interface PxJsonResponse {
  columns?: Array<{ code?: string; text?: string; type?: string }>;
  data?: Array<{ key?: string[]; values?: unknown[] }>;
  metadata?: Array<{ updated?: string; label?: string; source?: string }>;
  comments?: unknown[];
}

interface JsonStat2 {
  class?: string;
  id?: string[];
  size?: number[];
  dimension?: Record<
    string,
    { label?: string; category?: { index?: Record<string, number> | string[]; label?: Record<string, string> } }
  >;
  value?: Array<number | null> | Record<string, number | null>;
  updated?: string;
}

/** Decode PXWeb `json` ({columns, data:[{key, values}]}), labelling codes via metadata. */
export function decodePxJson(resp: PxJsonResponse, meta: PxMetadata, selected: SelectedVariable[]): DecodedTable {
  const variables = meta.variables ?? [];
  const notes: string[] = [];
  const cols = resp.columns ?? [];
  let dimCodes: Array<{ code: string; text?: string }>;
  let contents: string[];
  if (cols.length) {
    dimCodes = cols.filter((c) => c.type !== "c").map((c) => ({ code: c.code ?? "", text: c.text }));
    contents = cols.filter((c) => c.type === "c").map((c) => c.text ?? c.code ?? "value");
  } else {
    dimCodes = selected.filter((s) => s.mode !== "eliminated").map((s) => ({ code: s.code, text: s.text }));
    contents = [];
  }
  if (!contents.length) contents = ["value"];

  const dimensions: DecodedDimension[] = dimCodes.map((d) => {
    const v = variables.find((x) => x.code === d.code);
    const labels = new Map<string, string>();
    (v?.values ?? []).forEach((c, i) => labels.set(c, v?.valueTexts?.[i] ?? c));
    return { code: d.code, text: v?.text ?? d.text ?? d.code, labels };
  });

  const records = (resp.data ?? []).map((row) => {
    const keys = (row.key ?? []).map(String);
    const values = (row.values ?? []).map(parseCell);
    return { keys, values };
  });
  if (records.some((r) => r.keys.length !== dimensions.length)) {
    notes.push("Row keys did not align with columns; labels may be incomplete.");
  }
  return { dimensions, contents, records, notes };
}

/** Decode a JSON-stat 2.0 dataset (row-major, last dimension fastest). */
export function decodeJsonStat2(ds: JsonStat2): DecodedTable {
  const ids = ds.id ?? [];
  const sizes = ds.size ?? ids.map(() => 1);
  const dimensions: DecodedDimension[] = ids.map((id) => {
    const d = ds.dimension?.[id];
    const idx = d?.category?.index;
    let ordered: string[];
    if (Array.isArray(idx)) ordered = idx;
    else if (idx) ordered = Object.entries(idx).sort((a, b) => a[1] - b[1]).map(([k]) => k);
    else ordered = Object.keys(d?.category?.label ?? {});
    const labels = new Map<string, string>();
    for (const code of ordered) labels.set(code, d?.category?.label?.[code] ?? code);
    return { code: id, text: d?.label ?? id, labels };
  });
  const orderedCodes = dimensions.map((d) => [...d.labels.keys()]);
  const total = sizes.reduce((p, s) => p * s, 1);
  const valueAt = (i: number): number | null => {
    const v = ds.value;
    if (Array.isArray(v)) return parseCell(v[i]);
    if (v && typeof v === "object") return parseCell((v as Record<string, unknown>)[String(i)]);
    return null;
  };
  const records: DecodedTable["records"] = [];
  for (let flat = 0; flat < total; flat++) {
    const keys: string[] = new Array(ids.length);
    let rem = flat;
    for (let d = ids.length - 1; d >= 0; d--) {
      const size = sizes[d] || 1;
      keys[d] = orderedCodes[d]?.[rem % size] ?? String(rem % size);
      rem = Math.floor(rem / size);
    }
    records.push({ keys, values: [valueAt(flat)] });
  }
  return { dimensions, contents: ["value"], records, notes: [] };
}

/** Pick the decoder by response shape. */
export function decodeResponse(resp: unknown, meta: PxMetadata, selected: SelectedVariable[]): DecodedTable {
  const r = resp as Record<string, unknown>;
  if (r && typeof r === "object" && ("dimension" in r || r.class === "dataset") && "value" in r) {
    return decodeJsonStat2(r as JsonStat2);
  }
  return decodePxJson(r as PxJsonResponse, meta, selected);
}

/**
 * Flatten a decoded table into labelled rows. Dimensions holding a single value
 * across all rows are moved to `fixed` to keep rows compact.
 */
export function toLabelledRows(
  t: DecodedTable,
  opts: { includeCodes?: boolean } = {},
): { fixed: Record<string, string>; rows: Array<Record<string, string | number | null>> } {
  const fixed: Record<string, string> = {};
  const varying: number[] = [];
  t.dimensions.forEach((d, i) => {
    const distinct = new Set(t.records.map((r) => r.keys[i]));
    if (distinct.size <= 1 && t.records.length > 0) {
      const code = t.records[0].keys[i];
      fixed[d.text] = d.labels.get(code) ?? code ?? "";
    } else {
      varying.push(i);
    }
  });
  const rows = t.records.map((r) => {
    const row: Record<string, string | number | null> = {};
    for (const i of varying) {
      const d = t.dimensions[i];
      const code = r.keys[i];
      row[d.text] = d.labels.get(code) ?? code ?? null;
      if (opts.includeCodes) row[`${d.text} [code]`] = code ?? null;
    }
    if (t.contents.length === 1) row.value = r.values[0] ?? null;
    else t.contents.forEach((c, j) => (row[c] = r.values[j] ?? null));
    return row;
  });
  return { fixed, rows };
}

// ── Listing / search ──────────────────────────────────────────────────────

export interface BrowseItem {
  id: string;
  path: string;
  type: "database" | "level" | "table" | "unknown";
  text: string;
  updated?: string;
}

/** Normalise a PXWeb root ([{dbid,text}]) or node ([{id,type,text,updated}]) listing. */
export function normalizeListing(raw: unknown, parentPath?: string): BrowseItem[] {
  if (!Array.isArray(raw)) return [];
  const out: BrowseItem[] = [];
  for (const it of raw as Array<Record<string, unknown>>) {
    if (!it || typeof it !== "object") continue;
    const dbid = typeof it.dbid === "string" ? it.dbid : undefined;
    const id = dbid ?? (typeof it.id === "string" ? it.id : undefined);
    if (!id) continue;
    const t = typeof it.type === "string" ? it.type : undefined;
    const type: BrowseItem["type"] = dbid ? "database" : t === "t" ? "table" : t === "l" ? "level" : "unknown";
    out.push({
      id,
      path: parentPath ? `${parentPath}/${id}` : id,
      type,
      text: String(it.text ?? it.title ?? id),
      ...(typeof it.updated === "string" ? { updated: it.updated } : {}),
    });
  }
  return out;
}

export interface SeedTable {
  id: string;
  title: string;
  keywords: string;
  /** How sure we are this id exists on STAT-TAB (not verifiable offline). */
  confidence: "high" | "medium" | "low";
}

/**
 * Curated fallback index of high-value BFS tables. Used to (a) boost ranking of
 * live listing entries for English/French keywords and (b) answer searches when
 * the live listing is unreachable. Ids were compiled without network access:
 * "high" = in use elsewhere in Swissyphus or widely cited; "medium" = recalled
 * from BFS publications; "low" = best guess, verify before relying on it.
 * During live search, seed entries absent from the live listing are dropped.
 */
export const BFS_SEED_TABLES: SeedTable[] = [
  {
    id: "px-x-0102010000_101",
    title: "Permanent and non-permanent resident population by institutional units (Switzerland, canton, district, commune), citizenship category, sex and age",
    keywords: "population bevölkerung einwohner residents statpop gemeinde commune municipality canton kanton district bezirk age alter sex geschlecht nationality staatsangehörigkeit",
    confidence: "high",
  },
  {
    id: "px-x-0102010000_102",
    title: "Permanent and non-permanent resident population by canton, population type, sex and age class",
    keywords: "population bevölkerung einwohner canton kanton statpop residence permit",
    confidence: "high",
  },
  {
    id: "px-x-0102020000_101",
    title: "Demographic balance of the permanent resident population (births, deaths, immigration, emigration, naturalisations) by institutional units",
    keywords: "demographic balance bilanz bevölkerungsbewegung births geburten deaths todesfälle migration immigration einwanderung emigration auswanderung wanderung naturalisation einbürgerung population change",
    confidence: "medium",
  },
  {
    id: "px-x-0102020204_101",
    title: "Live births (BEVNAT) by canton, sex and citizenship",
    keywords: "births geburten lebendgeburten naissances nascite bevnat fertility",
    confidence: "low",
  },
  {
    id: "px-x-0102020206_101",
    title: "Deaths (BEVNAT) by canton, sex, age and citizenship",
    keywords: "deaths todesfälle décès mortality sterblichkeit bevnat",
    confidence: "low",
  },
  {
    id: "px-x-0102020202_101",
    title: "Marriages and divorces (BEVNAT) by canton and citizenship",
    keywords: "marriages heiraten eheschliessungen mariages divorces scheidungen bevnat",
    confidence: "low",
  },
  {
    id: "px-x-0602010000_101",
    title: "Workplaces and employment (STATENT) by canton, economic division and size class",
    keywords: "enterprises unternehmen arbeitsstätten workplaces employment beschäftigte jobs statent economy wirtschaft noga",
    confidence: "medium",
  },
  {
    id: "px-x-0702000000_101",
    title: "Farms, agricultural employees and agricultural area by canton (farm structure survey)",
    keywords: "agriculture landwirtschaft farms betriebe bauernhöfe agricultural area nutzfläche livestock",
    confidence: "low",
  },
  {
    id: "px-x-0902010000_101",
    title: "Buildings by canton, building category, number of floors and construction period (GWS)",
    keywords: "buildings gebäude bâtiments construction bauperiode housing wohnen gws",
    confidence: "medium",
  },
  {
    id: "px-x-0902020100_101",
    title: "Dwellings by canton, number of rooms and construction period (GWS)",
    keywords: "dwellings wohnungen logements apartments rooms zimmer housing gws",
    confidence: "low",
  },
  {
    id: "px-x-1003020000_101",
    title: "Hotel accommodation: arrivals and overnight stays by year, month, canton and country of residence (HESTA)",
    keywords: "tourism tourismus hotels hotellerie overnight stays logiernächte nuitées arrivals ankünfte hesta guests gäste",
    confidence: "medium",
  },
  {
    id: "px-x-1003020000_102",
    title: "Hotel accommodation: arrivals and overnight stays by commune (HESTA)",
    keywords: "tourism tourismus hotels logiernächte overnight stays commune gemeinde hesta",
    confidence: "low",
  },
  {
    id: "px-x-1003020000_201",
    title: "Hotel accommodation supply: establishments, rooms and beds by canton (HESTA)",
    keywords: "tourism hotels betriebe zimmer betten beds rooms capacity hesta",
    confidence: "low",
  },
  {
    id: "px-x-1103020100_101",
    title: "Road motor vehicle stock by vehicle group, canton and fuel",
    keywords: "vehicles fahrzeuge cars autos personenwagen motor vehicle stock bestand fuel treibstoff electric elektro",
    confidence: "low",
  },
  {
    id: "px-x-1103020200_101",
    title: "New registrations of road motor vehicles by vehicle group, canton and fuel",
    keywords: "new registrations inverkehrsetzungen neue fahrzeuge cars autos electric elektroautos",
    confidence: "low",
  },
  {
    id: "px-x-1502040100_131",
    title: "Students at universities (UH) by university, field of study, sex and nationality",
    keywords: "students studierende étudiants university universität hochschule higher education bildung education",
    confidence: "high",
  },
  {
    id: "px-x-1702020000_101",
    title: "National Council elections: party strengths by canton",
    keywords: "elections wahlen élections national council nationalrat parties parteien party strength parteistärke",
    confidence: "low",
  },
  {
    id: "px-x-1903020100_101",
    title: "Criminal offences recorded by the police (PKS) by canton, law and article",
    keywords: "crime kriminalität criminalité offences straftaten police polizei pks theft diebstahl violence gewalt",
    confidence: "medium",
  },
];

const SEED_BY_ID = new Map(BFS_SEED_TABLES.map((s) => [s.id, s]));

/** Fraction of query tokens found (as substrings) in the haystack. */
export function scoreText(queryTokens: string[], haystack: string): number {
  if (!queryTokens.length) return 0;
  const h = normalizeText(haystack);
  let hit = 0;
  for (const t of queryTokens) if (h.includes(t)) hit++;
  return hit / queryTokens.length;
}

export interface SearchHit {
  id: string;
  title: string;
  score: number;
  updated?: string;
  confidence?: SeedTable["confidence"];
}

/** Rank a live listing (plus seed keyword boosts) against a query. */
export function rankListing(items: BrowseItem[], query: string, limit: number): SearchHit[] {
  const q = tokens(query);
  const idMatch = query.match(/px-x-\d{6,12}_\d{1,4}/i)?.[0]?.toLowerCase();
  const scored: SearchHit[] = [];
  for (const it of items) {
    const tableId = it.type === "table" ? tableIdFromPath(it.id) : it.id;
    if (idMatch && tableId.toLowerCase() === idMatch) {
      scored.push({ id: tableId, title: it.text, score: 2, updated: it.updated });
      continue;
    }
    const seed = SEED_BY_ID.get(tableId);
    const s = Math.max(
      scoreText(q, `${it.text} ${tableId}`),
      seed ? 0.9 * scoreText(q, `${seed.keywords} ${seed.title}`) : 0,
    );
    if (s > 0) scored.push({ id: tableId, title: it.text, score: Math.round(s * 100) / 100, updated: it.updated });
  }
  scored.sort((a, b) => b.score - a.score || a.title.length - b.title.length);
  return scored.slice(0, limit);
}

/** Search the curated seed index only (offline fallback). */
export function searchSeed(query: string, limit: number): SearchHit[] {
  const q = tokens(query);
  const idMatch = query.match(/px-x-\d{6,12}_\d{1,4}/i)?.[0]?.toLowerCase();
  return BFS_SEED_TABLES.map((s) => ({
    id: s.id,
    title: s.title,
    confidence: s.confidence,
    score: idMatch === s.id ? 2 : Math.round(scoreText(q, `${s.title} ${s.keywords}`) * 100) / 100,
  }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ── HTTP ──────────────────────────────────────────────────────────────────

interface Fetched<T> {
  data: T;
  cacheStatus: CacheStatus;
  retrievedAt: string;
}

function parseJsonBody<T>(text: string, url: string): T {
  try {
    return JSON.parse(text.replace(/^﻿/, "")) as T;
  } catch {
    throw new SourceError(`STAT-TAB returned a non-JSON response for ${new URL(url).pathname}.`, HOST);
  }
}

async function getJson<T>(url: string, timeoutMs = 20_000): Promise<Fetched<T>> {
  const r = await fetchCached(url, { ttlMs: TTL_MS, timeoutMs, init: { headers: { Accept: "application/json" } } });
  return { data: parseJsonBody<T>(r.data, url), cacheStatus: r.cacheStatus, retrievedAt: r.retrievedAt };
}

async function postJson<T>(url: string, body: unknown): Promise<Fetched<T>> {
  const r = await fetchCached(url, {
    ttlMs: TTL_MS,
    timeoutMs: 45_000,
    maxBytes: 16 * 1024 * 1024,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    },
  });
  return { data: parseJsonBody<T>(r.data, url), cacheStatus: r.cacheStatus, retrievedAt: r.retrievedAt };
}

async function fetchMetadata(path: string, lang: BfsLang): Promise<Fetched<PxMetadata>> {
  return getJson<PxMetadata>(apiUrl(lang, path));
}

interface PxSearchHit {
  id?: string;
  path?: string;
  title?: string;
  score?: number;
  published?: string;
}

/**
 * Live search: rank the root listing. If the root does not look like BFS's
 * one-database-per-table layout, use the documented per-database PXWeb search.
 */
async function searchLive(
  query: string,
  lang: BfsLang,
  limit: number,
): Promise<{ hits: SearchHit[]; cacheStatus: CacheStatus; retrievedAt: string }> {
  const root = await getJson<unknown>(apiUrl(lang), 30_000);
  const items = normalizeListing(root.data);
  const tableLike = items.filter((i) => /^px-x-/i.test(i.id)).length;
  if (items.length && tableLike >= Math.min(20, items.length)) {
    return { hits: rankListing(items, query, limit), cacheStatus: root.cacheStatus, retrievedAt: root.retrievedAt };
  }
  // Hierarchical layout: PXWeb search per database (first 3 databases).
  const terms = tokens(query).join(" ");
  const hits: SearchHit[] = [];
  for (const db of items.slice(0, 3)) {
    try {
      const url = `${apiUrl(lang, db.id)}?query=${encodeURIComponent(terms)}&filter=*`;
      const { data } = await getJson<PxSearchHit[]>(url);
      for (const h of Array.isArray(data) ? data : []) {
        if (!h?.id) continue;
        const p = `${db.id}${(h.path ?? "/").replace(/\/+$/, "")}/${h.id}`.replace(/\/{2,}/g, "/");
        hits.push({ id: p, title: h.title ?? h.id, score: Number(h.score ?? 0), updated: h.published });
      }
    } catch {
      /* try next database */
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return { hits: hits.slice(0, limit), cacheStatus: root.cacheStatus, retrievedAt: root.retrievedAt };
}

export async function searchTables(
  query: string,
  lang: BfsLang,
  limit: number,
): Promise<{ hits: SearchHit[]; mode: "live" | "seed"; cacheStatus: CacheStatus; retrievedAt: string; error?: string }> {
  try {
    const live = await searchLive(query, lang, limit);
    return { ...live, mode: "live" };
  } catch (err) {
    return {
      hits: searchSeed(query, limit),
      mode: "seed",
      cacheStatus: "computed",
      retrievedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function landingUrl(lang: BfsLang, tableId: string): string {
  return `https://${HOST}/pxweb/${lang}/${encodeURIComponent(tableId)}/`;
}

// ── Discovery ─────────────────────────────────────────────────────────────

registerSearcher({
  catalogue: "BFS STAT-TAB",
  // The table listing drives search; load it before the first question.
  warm: async () => {
    await getJson<unknown>(apiUrl("de"), 30_000);
  },
  module: "bfs",
  search: async (query: string, limit: number, lang: string): Promise<DataHit[]> => {
    const l = toBfsLang(lang);
    const { hits } = await searchTables(query, l, limit);
    return hits.map((h) => ({
      catalogue: "BFS STAT-TAB",
      id: h.id,
      title: h.title,
      publisher: "Federal Statistical Office (BFS)",
      url: landingUrl(l, h.id),
      ...(h.updated ? { description: `Updated ${h.updated}` } : {}),
      next: { tool: "get_bfs_table_metadata", args: { table_id: h.id, lang: l } },
    }));
  },
});

// ── Tool handlers ─────────────────────────────────────────────────────────

const langSchema = z.enum(BFS_LANGS).default("en").describe("Language of titles/labels: de, fr, it or en (default en)");

function notFound(tableId: string, lang: BfsLang) {
  return toolError(`STAT-TAB table '${tableId}' was not found (lang=${lang}).`, [
    "Find valid ids with search_bfs_tables (e.g. query 'population canton') or browse_bfs_tables.",
    "Table ids look like 'px-x-0102010000_101'.",
    lang !== "de" ? "Some tables exist only in German/French: retry with lang='de'." : "Try lang='fr'.",
  ]);
}

function summarizeVariable(v: PxVariable, maxValues: number) {
  const values = v.values ?? [];
  const d = defaultSelection(v);
  return {
    code: v.code,
    text: v.text ?? v.code,
    value_count: values.length,
    ...(isTimeVariable(v) ? { time: true, range: values.length ? `${values[0]} … ${values[values.length - 1]}` : undefined } : {}),
    ...(v.elimination !== undefined ? { elimination: v.elimination } : {}),
    values: values.slice(0, maxValues).map((c, i) => ({ code: c, text: v.valueTexts?.[i] ?? c })),
    ...(values.length > maxValues ? { more_values: values.length - maxValues } : {}),
    default_if_unspecified:
      d.mode === "eliminated"
        ? "eliminated (summed over all values)"
        : `${d.values[0] ?? ""} = ${labelOf(v, d.values[0] ?? "")} (${d.mode.replace("default-", "")})`,
  };
}

export const bfsModule: SwissyphusModule = {
  id: "bfs",
  emoji: "📈",
  title: "BFS STAT-TAB statistics",
  description:
    "Every Federal Statistical Office table on STAT-TAB (PXWeb): search/browse tables, inspect dimensions, and query labelled data for Switzerland, cantons and communes",
  sources: [source],
  healthProbes: [
    { sourceId: "bfs-stat-tab", url: `${API}/en/px-x-0102010000_101/px-x-0102010000_101.px` },
  ],
  tools: [
    tool({
      name: "search_bfs_tables",
      title: "Search BFS STAT-TAB statistical tables",
      description:
        "Find Federal Statistical Office (BFS) tables on STAT-TAB by keywords: population, births, deaths, migration, " +
        "tourism overnight stays, crime, students, vehicles, buildings, enterprises and hundreds more. Returns table ids " +
        "(e.g. 'px-x-0102010000_101') with titles, to pass to get_bfs_table_metadata then query_bfs_table. " +
        "Titles are in the chosen language, so use matching search terms (e.g. lang='de', query 'Logiernächte Kanton'). " +
        "Examples: {query:'population commune age'}, {query:'hotel overnight stays', lang:'en'}.",
      inputSchema: {
        query: z.string().min(2).describe("Keywords, e.g. 'population canton', 'Straftaten', 'overnight stays'"),
        lang: langSchema,
        limit: z.number().int().min(1).max(50).default(15),
      },
      handler: async ({ query, lang, limit }) => {
        const l = toBfsLang(lang);
        const res = await searchTables(query, l, limit);
        if (!res.hits.length) {
          return toolError(`No STAT-TAB tables match '${query}'.`, [
            l === "en" ? "Try German terms with lang='de' (e.g. 'Bevölkerung', 'Logiernächte')." : "Try fewer or broader keywords.",
            "Browse the full list with browse_bfs_tables.",
          ]);
        }
        const results = res.hits.map((h) => ({
          table_id: h.id,
          title: h.title,
          score: h.score,
          ...(h.updated ? { updated: h.updated } : {}),
          ...(h.confidence ? { id_confidence: h.confidence } : {}),
        }));
        return respond(
          { mode: res.mode, count: results.length, results, next: "get_bfs_table_metadata {table_id}" },
          {
            source,
            cacheStatus: res.cacheStatus,
            retrievedAt: res.retrievedAt,
            language: l,
            ...(res.mode === "seed"
              ? {
                  notes:
                    `Live STAT-TAB listing unavailable (${res.error ?? "unknown error"}); results come from Swissyphus's ` +
                    "curated seed index — ids marked low confidence are unverified.",
                }
              : {}),
          },
        );
      },
    }),

    tool({
      name: "browse_bfs_tables",
      title: "Browse the BFS STAT-TAB table tree",
      description:
        "List entries of the BFS PXWeb database tree. Without 'path' lists all STAT-TAB databases (at BFS each is one " +
        "table, id like 'px-x-1003020000_101', with its title); with 'path' lists that node's children " +
        "(type level/table, text, updated). Use 'filter' to substring-match titles. " +
        "Examples: {filter:'Wohnbevölkerung', lang:'de'}, {path:'px-x-0102010000_101'}.",
      inputSchema: {
        path: z.string().optional().describe("Node path, e.g. 'px-x-0102010000_101'. Omit for the root listing."),
        filter: z.string().optional().describe("Case/diacritic-insensitive substring filter on titles or ids"),
        lang: langSchema,
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      },
      handler: async ({ path, filter, lang, limit, offset }) => {
        const l = toBfsLang(lang);
        const p = sanitizeBrowsePath(path);
        if (p === null) {
          return toolError(`Invalid path '${path}'.`, ["Paths contain only letters, digits, '_', '-', '.' and '/'."]);
        }
        try {
          const { data, cacheStatus, retrievedAt } = await getJson<unknown>(apiUrl(l, p), 30_000);
          if (!Array.isArray(data)) {
            if (data && typeof data === "object" && "variables" in (data as object)) {
              return toolError(`'${p}' is a table, not a folder.`, [
                `Call get_bfs_table_metadata with table_id='${p}'.`,
              ]);
            }
            return toolError(`Unexpected listing format at '${p ?? "/"}'.`);
          }
          let items = normalizeListing(data, p);
          if (filter) {
            const f = normalizeText(filter);
            items = items.filter((i) => normalizeText(`${i.text} ${i.id}`).includes(f));
          }
          const page = items.slice(offset, offset + limit).map((i) => {
            const isTable = i.type === "table" || (i.type === "database" && /^px-x-/i.test(i.id));
            return {
              id: i.id,
              type: i.type,
              text: i.text,
              ...(i.updated ? { updated: i.updated } : {}),
              next: isTable
                ? { tool: "get_bfs_table_metadata", args: { table_id: i.type === "table" ? i.path : i.id } }
                : { tool: "browse_bfs_tables", args: { path: i.path } },
            };
          });
          return respond(
            {
              path: p ?? "/",
              total: items.length,
              offset,
              returned: page.length,
              ...(offset + page.length < items.length ? { next_offset: offset + page.length } : {}),
              items: page,
            },
            { source, cacheStatus, retrievedAt, language: l },
          );
        } catch (err) {
          if (err instanceof SourceError && (err.status === 404 || err.status === 400)) {
            return toolError(`STAT-TAB path '${p}' was not found.`, [
              "Omit 'path' to list all databases, or use search_bfs_tables.",
            ]);
          }
          if (err instanceof TooLargeError) return toolError("The STAT-TAB listing is too large to load.", ["Use search_bfs_tables instead."]);
          return errorToResult(err, "BFS STAT-TAB (PXWeb)");
        }
      },
    }),

    tool({
      name: "get_bfs_table_metadata",
      title: "Describe a BFS STAT-TAB table",
      description:
        "Dimensions of one STAT-TAB table: each variable's code, label, number of values, first values (code + label), " +
        "which one is time (with range), the default used when unspecified, and the cell count. Pass 'variable' to list " +
        "(and 'value_filter' to search) all values of one dimension, e.g. to find a commune code. " +
        "Examples: {table_id:'px-x-0102010000_101'}, {table_id:'px-x-0102010000_101', variable:'Kanton', value_filter:'Bern'}.",
      inputSchema: {
        table_id: z.string().min(3).describe("Table id like 'px-x-0102010000_101' (or its API path / STAT-TAB URL)"),
        lang: langSchema,
        max_values: z.number().int().min(0).max(100).default(12).describe("Values shown per variable"),
        variable: z.string().optional().describe("List values of this variable only (code or label)"),
        value_filter: z.string().optional().describe("With 'variable': substring filter on value codes/labels"),
        limit: z.number().int().min(1).max(1000).default(200).describe("With 'variable': max values listed"),
      },
      handler: async ({ table_id, lang, max_values, variable, value_filter, limit }) => {
        const l = toBfsLang(lang);
        const path = resolveTablePath(table_id);
        if (!path) {
          return toolError(`'${table_id}' is not a valid STAT-TAB table id.`, [
            "Use an id like 'px-x-0102010000_101' from search_bfs_tables.",
          ]);
        }
        try {
          const { data: meta, cacheStatus, retrievedAt } = await fetchMetadata(path, l);
          const vars = meta.variables ?? [];
          if (!vars.length) {
            return toolError(`'${table_id}' did not return table metadata (is it a folder?).`, [
              `Try browse_bfs_tables with path='${path.split("/").slice(0, -1).join("/") || table_id}'.`,
            ]);
          }
          const tableId = tableIdFromPath(path);
          const links = { api: apiUrl(l, path), stat_tab: landingUrl(l, tableId) };
          if (variable) {
            const m = matchVariable(vars, variable);
            if (!m.variable) {
              return toolError(`Unknown variable '${variable}' in ${tableId}.`, [
                `Variables: ${vars.map((v) => `${v.code} (${v.text ?? v.code})`).join(", ")}`,
              ]);
            }
            const v = m.variable;
            const f = value_filter ? normalizeText(value_filter) : undefined;
            const all = (v.values ?? []).map((c, i) => ({ code: c, text: v.valueTexts?.[i] ?? c }));
            const matched = f ? all.filter((x) => normalizeText(`${x.code} ${x.text}`).includes(f)) : all;
            return respond(
              {
                table_id: tableId,
                title: meta.title,
                variable: { code: v.code, text: v.text ?? v.code, time: isTimeVariable(v), value_count: all.length },
                matched: matched.length,
                values: matched.slice(0, limit),
                ...(matched.length > limit ? { truncated: true } : {}),
              },
              { source, cacheStatus, retrievedAt, language: l, links },
            );
          }
          const counts = vars.map((v) => (v.values ?? []).length);
          const defaults = buildSelection(meta, {});
          const timeVar = vars.find(isTimeVariable);
          return respond(
            {
              table_id: tableId,
              title: meta.title,
              variables: vars.map((v) => summarizeVariable(v, max_values)),
              time_variable: timeVar?.code ?? null,
              cells_if_all_values: estimateCells(counts),
              cells_with_defaults: defaults.cells,
              max_cells_per_query: MAX_CELLS,
              example_query: {
                table_id: tableId,
                selection: {
                  ...(timeVar ? { [timeVar.code]: ["latest"] } : {}),
                  ...(() => {
                    const other = vars.find((v) => v !== timeVar && (v.values ?? []).length > 1);
                    return other ? { [other.code]: (other.values ?? []).slice(0, 3) } : {};
                  })(),
                },
              },
            },
            { source, cacheStatus, retrievedAt, language: l, links },
          );
        } catch (err) {
          if (err instanceof SourceError && (err.status === 404 || err.status === 400)) return notFound(table_id, l);
          return errorToResult(err, "BFS STAT-TAB (PXWeb)");
        }
      },
    }),

    tool({
      name: "query_bfs_table",
      title: "Query data from a BFS STAT-TAB table",
      description:
        "Fetch labelled figures from any STAT-TAB table. 'selection' maps variables (code or label, case/accents " +
        "ignored) to values (codes or labels); '*' = all values, 'latest' / 'latest:5' = last period(s), '2015-2020' = " +
        "year range. Unspecified variables default to their total (e.g. 'Schweiz', 'Total') or the latest period, and " +
        `the response lists every default applied. Max ${MAX_CELLS} cells per query. Returns rows like ` +
        "{Kanton:'Zürich', value:1605508} plus 'fixed' for single-valued dimensions. " +
        "Example: {table_id:'px-x-0102010000_101', selection:{Jahr:['latest'], Kanton:['Zürich','Bern'], Geschlecht:['*']}}.",
      inputSchema: {
        table_id: z.string().min(3).describe("Table id like 'px-x-0102010000_101'"),
        selection: z
          .record(z.string(), z.union([z.string(), z.array(z.string())]))
          .optional()
          .describe("Map variable → values, e.g. {\"Jahr\": [\"latest\"], \"Kanton\": [\"*\"]}"),
        lang: langSchema,
        limit: z.number().int().min(1).max(2000).default(300).describe("Max rows returned"),
        include_codes: z.boolean().default(false).describe("Also return value codes next to labels"),
      },
      handler: async ({ table_id, selection, lang, limit, include_codes }) => {
        const l = toBfsLang(lang);
        const path = resolveTablePath(table_id);
        if (!path) {
          return toolError(`'${table_id}' is not a valid STAT-TAB table id.`, [
            "Use an id like 'px-x-0102010000_101' from search_bfs_tables.",
          ]);
        }
        const sel: Record<string, string | string[]> = selection ?? {};
        try {
          const { data: meta } = await fetchMetadata(path, l);
          if (!(meta.variables ?? []).length) return notFound(table_id, l);
          const tableId = tableIdFromPath(path);
          const built = buildSelection(meta, sel);
          if (built.errors.length) {
            return toolError(`Could not apply the selection to ${tableId}.`, [
              ...built.errors,
              `Inspect values with get_bfs_table_metadata {table_id:'${tableId}', variable:'<code>'}.`,
            ]);
          }
          if (built.cells > MAX_CELLS) {
            return toolError(
              `Selection would return ${built.cells.toLocaleString("en")} cells (limit ${MAX_CELLS}).`,
              [
                `Per variable: ${built.selected
                  .map((s) => `${s.code}=${s.mode === "eliminated" ? 1 : s.values.length}`)
                  .join(" × ")}.`,
                "Narrow the largest dimension (specific cantons/communes instead of '*', 'latest' instead of all years).",
                "Split the request into several smaller queries.",
              ],
            );
          }
          const body = buildQueryBody(built.selected, "json");
          const { data, cacheStatus, retrievedAt } = await postJson<unknown>(apiUrl(l, path), body);
          const decoded = decodeResponse(data, meta, built.selected);
          const { fixed, rows } = toLabelledRows(decoded, { includeCodes: include_codes });
          let kept = rows.slice(0, limit);
          while (kept.length > 20 && JSON.stringify(kept).length > 40_000) kept = kept.slice(0, Math.floor(kept.length / 2));
          const updated = (data as PxJsonResponse)?.metadata?.[0]?.updated ?? (data as JsonStat2)?.updated;
          const notes: string[] = [...decoded.notes];
          if (kept.length < rows.length) notes.push(`Returned ${kept.length} of ${rows.length} rows; narrow the selection or page by value.`);
          if (rows.some((r) => Object.values(r).some((v) => v === null))) {
            notes.push("null = not available / confidential (PXWeb symbols such as '...' or '-').");
          }
          return respond(
            {
              table_id: tableId,
              title: meta.title,
              ...(updated ? { updated } : {}),
              cells: built.cells,
              defaults_applied: built.defaults,
              fixed,
              row_count: rows.length,
              rows: kept,
            },
            {
              source,
              cacheStatus,
              retrievedAt,
              language: l,
              ...(updated ? { dataAsOf: updated } : {}),
              links: { api: apiUrl(l, path), stat_tab: landingUrl(l, tableId) },
              ...(notes.length ? { notes: notes.join(" ") } : {}),
            },
          );
        } catch (err) {
          if (err instanceof SourceError && err.status === 404) return notFound(table_id, l);
          if (err instanceof SourceError && (err.status === 400 || err.status === 403)) {
            return toolError(`STAT-TAB rejected the query (HTTP ${err.status}).`, [
              "PXWeb refuses selections that are too large or contain invalid value codes; narrow the selection.",
              "Check variable/value codes with get_bfs_table_metadata.",
            ]);
          }
          if (err instanceof TooLargeError) {
            return toolError("The STAT-TAB response was too large.", ["Narrow the selection."]);
          }
          return errorToResult(err, "BFS STAT-TAB (PXWeb)");
        }
      },
    }),
  ],
};
