/**
 * LINDAS statistical cubes — discovery and querying without writing SPARQL.
 *
 * LINDAS (lindas.admin.ch) hosts hundreds of RDF Data Cubes (cube.link model)
 * published by BFS, BAFU/FOEN, BFE/SFOE, ElCom, FOAG, ASTRA and others — the
 * data behind visualize.admin.ch. This module:
 *   - search_data_cubes   keyword search over cube names/descriptions/publishers
 *   - describe_data_cube  dimensions (key vs measure, unit, datatype) + example values
 *   - query_data_cube     observations with label-aware filters, as flat rows
 *
 * All SPARQL is generated here. Every user-supplied string is either validated
 * as a strict IRI (then wrapped in <>) or escaped as a string literal, so the
 * agent never has to write — and cannot inject — SPARQL.
 */

import { z } from "zod";
import { allowHosts, fetchJson, outsideBudget } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import { registerSearcher, type DataHit } from "../core/discovery.js";
import type { CacheStatus, SourceManifest } from "../core/types.js";

allowHosts("lindas.admin.ch");

const ENDPOINT = "https://lindas.admin.ch/query";
const META_TTL_MS = 6 * 3600 * 1000;
const OBS_TTL_MS = 3600 * 1000;
const TIMEOUT_MS = 45_000;

const source: SourceManifest = {
  id: "lindas-cubes",
  name: "LINDAS statistical cubes (cube.link) — data behind visualize.admin.ch",
  operator: "Federal Archives (LINDAS platform); data by the publishing federal offices (BFS, BAFU, BFE, ElCom, FOAG, ASTRA, …)",
  url: "https://lindas.admin.ch",
  licence: "Swiss OGD — each cube carries its own licence (see describe_data_cube 'licence'); attribution to the publisher required",
  attribution: "© Swiss Confederation — respective publishing office, via LINDAS (lindas.admin.ch)",
  updateFrequency: "per cube (yearly to daily); cube metadata changes rarely",
  cacheTtlSeconds: 6 * 3600,
  notes:
    "SPARQL is generated from the cube.link model (cube:Cube, cube:observationConstraint SHACL shape, cube:observationSet). " +
    "Predicates vary between cube generations, so all metadata is read with OPTIONAL/COALESCE; cubes with schema:expires " +
    "(deprecated versions) are excluded from search. Assumes the LINDAS default graph is the union of all named graphs " +
    "(as visualize.admin.ch relies on). Example values are sampled from sh:in lists and the first ~2000 observations, so " +
    "they are indicative, not exhaustive. Observation queries on very large cubes may time out — add filters.",
};

// ---------------------------------------------------------------------------
// Escaping / validation (exported for tests)
// ---------------------------------------------------------------------------

/** Strict absolute-IRI check: no whitespace or characters that could close <…>. */
export const IRI_RE = /^https?:\/\/[^\s<>"{}|\\^`]+$/;

export function isSafeIri(s: string): boolean {
  return s.length <= 2000 && IRI_RE.test(s);
}

/** Wrap a validated IRI in angle brackets; throws on anything unsafe. */
export function iriRef(s: string): string {
  if (!isSafeIri(s)) throw new Error(`Not a valid IRI: ${JSON.stringify(s.slice(0, 120))}`);
  return `<${s}>`;
}

const ECHAR: Record<string, string> = {
  "\\": "\\\\",
  '"': '\\"',
  "'": "\\'",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

/**
 * Escape arbitrary text for use inside a double-quoted SPARQL string literal.
 * Backslash, both quote chars and CR/LF/TAB become ECHAR escapes; all other
 * control characters are dropped. Length is capped.
 */
export function escapeSparqlString(s: string, maxLen = 300): string {
  return s
    .slice(0, maxLen)
    .replace(/[\\"'\n\r\t\u0000-\u001f\u007f]/g, (c) => ECHAR[c] ?? "");
}

/** A double-quoted, escaped SPARQL literal. */
export function literal(s: string): string {
  return `"${escapeSparqlString(s)}"`;
}

/** Reduce a free-text search term to letters/digits/space and light punctuation. */
export function sanitizeSearchTerm(s: string): string {
  return s.replace(/[^\p{L}\p{N}\s.'’-]/gu, " ").replace(/\s+/g, " ").trim();
}

/** Split a search query into up to 6 lower-cased, sanitized terms (min 2 chars). */
export function searchTerms(query: string): string[] {
  return sanitizeSearchTerm(query)
    .toLowerCase()
    .split(" ")
    .filter((t) => t.length >= 2)
    .slice(0, 6);
}

export type Lang = "de" | "fr" | "it" | "en";

/** Preferred language first, then the Swiss official languages, then English. */
export function langOrder(lang: Lang): string[] {
  return [...new Set([lang, "de", "fr", "it", "en"])];
}

/**
 * OPTIONAL patterns selecting a language-preferred label plus the COALESCE
 * expression picking the best one. `out` must be an internal identifier.
 * Returns patterns (to put in WHERE) and the expression (to BIND at the end).
 */
function labelPatterns(subject: string, predicate: string, out: string, lang: Lang): { patterns: string; expr: string } {
  const order = langOrder(lang);
  const vars: string[] = [];
  const lines = order.map((l, i) => {
    const v = `?${out}_${i}`;
    vars.push(v);
    return `  OPTIONAL { ${subject} ${predicate} ${v} . FILTER(LANG(${v}) = "${l}") }`;
  });
  const untagged = `?${out}_u`;
  vars.push(`STR(${untagged})`);
  lines.push(`  OPTIONAL { ${subject} ${predicate} ${untagged} . FILTER(LANG(${untagged}) = "") }`);
  return { patterns: lines.join("\n"), expr: `COALESCE(${vars.join(", ")})` };
}

const PREFIXES = `PREFIX cube: <https://cube.link/>
PREFIX schema: <http://schema.org/>
PREFIX dcterms: <http://purl.org/dc/terms/>
PREFIX sh: <http://www.w3.org/ns/shacl#>
PREFIX qudt: <http://qudt.org/schema/qudt/>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>`;

const VISUALIZE_APP = "https://ld.admin.ch/application/visualize";
const STATUS_DRAFT = "https://ld.admin.ch/vocabulary/CreativeWorkStatus/Draft";
const STATUS_PUBLISHED = "https://ld.admin.ch/vocabulary/CreativeWorkStatus/Published";

// ---------------------------------------------------------------------------
// Query builders (exported for tests)
// ---------------------------------------------------------------------------

export interface SearchOptions {
  query: string;
  lang: Lang;
  limit: number;
  offset: number;
  publishedOnly: boolean;
}

export function buildSearchQuery(o: SearchOptions, maxLimit = 50): string {
  const terms = searchTerms(o.query);
  const termFilters = terms
    .map(
      (t, i) =>
        `  FILTER(CONTAINS(LCASE(STR(?cube)), ${literal(t)}) || EXISTS { ?cube (schema:name|schema:description|dcterms:creator/schema:name|schema:creator/schema:name) ?t${i} . FILTER(CONTAINS(LCASE(STR(?t${i})), ${literal(t)})) })`,
    )
    .join("\n");
  const name = labelPatterns("?cube", "schema:name", "n", o.lang);
  const desc = labelPatterns("?cube", "schema:description", "d", o.lang);
  const pub = labelPatterns("?creator", "schema:name", "p", o.lang);
  const limit = Math.max(1, Math.min(maxLimit, Math.floor(o.limit)));
  const offset = Math.max(0, Math.min(5000, Math.floor(o.offset)));
  return `${PREFIXES}
SELECT ?cube (SAMPLE(?name_) AS ?name) (SAMPLE(?desc_) AS ?description) (SAMPLE(?pub_) AS ?publisher)
       (MAX(?mod_) AS ?modified) (SAMPLE(?status_) AS ?status) (MAX(?vis_) AS ?visualize)
WHERE {
  ?cube a cube:Cube .
  FILTER NOT EXISTS { ?cube schema:expires ?expires }
${o.publishedOnly ? `  FILTER NOT EXISTS { ?cube schema:creativeWorkStatus <${STATUS_DRAFT}> }\n` : ""}  FILTER NOT EXISTS {
    ?parent schema:hasPart ?cube , ?newer .
    ?cube schema:version ?cv .
    ?newer a cube:Cube ; schema:version ?nv .
    FILTER(?nv > ?cv)
    FILTER NOT EXISTS { ?newer schema:expires ?ne }
    FILTER NOT EXISTS { ?newer schema:creativeWorkStatus <${STATUS_DRAFT}> }
  }
${termFilters}
${name.patterns}
${desc.patterns}
  OPTIONAL { ?cube schema:creativeWorkStatus ?status_ }
  OPTIONAL { ?cube schema:dateModified ?m1 }
  OPTIONAL { ?cube schema:datePublished ?m2 }
  OPTIONAL { ?cube dcterms:modified ?m3 }
  OPTIONAL {
    ?cube dcterms:creator|schema:creator ?creator .
${pub.patterns}
  }
  OPTIONAL { ?cube schema:publisher ?publisherRaw }
  BIND(${name.expr} AS ?name_)
  BIND(${desc.expr} AS ?desc_)
  BIND(COALESCE(${pub.expr}, STR(?publisherRaw)) AS ?pub_)
  BIND(STR(COALESCE(?m1, ?m2, ?m3)) AS ?mod_)
  BIND(IF(EXISTS { ?cube schema:workExample <${VISUALIZE_APP}> }, 1, 0) AS ?vis_)
}
GROUP BY ?cube
ORDER BY DESC(?visualize) DESC(?modified) ?cube
LIMIT ${limit}
OFFSET ${offset}`;
}

export function buildCubeMetaQuery(cubeIri: string, lang: Lang): string {
  const c = iriRef(cubeIri);
  const name = labelPatterns(c, "schema:name", "n", lang);
  const desc = labelPatterns(c, "schema:description", "d", lang);
  const pub = labelPatterns("?creator", "schema:name", "p", lang);
  return `${PREFIXES}
SELECT ?name ?description ?publisher ?creator ?status ?modified ?published ?version ?licence ?expires ?visualize ?newer WHERE {
  ${c} a cube:Cube .
${name.patterns}
${desc.patterns}
  OPTIONAL {
    ${c} dcterms:creator|schema:creator ?creator .
${pub.patterns}
  }
  OPTIONAL { ${c} schema:publisher ?publisherRaw }
  OPTIONAL { ${c} schema:creativeWorkStatus ?status }
  OPTIONAL { ${c} schema:dateModified ?modified }
  OPTIONAL { ${c} schema:datePublished ?published }
  OPTIONAL { ${c} schema:version ?version }
  OPTIONAL { ${c} dcterms:license|schema:license ?licence }
  OPTIONAL { ${c} schema:expires ?expires }
  OPTIONAL {
    ?parent schema:hasPart ${c} , ?newer .
    ${c} schema:version ?cv .
    ?newer a cube:Cube ; schema:version ?nv .
    FILTER(?nv > ?cv)
    FILTER NOT EXISTS { ?newer schema:expires ?ne }
  }
  BIND(${name.expr} AS ?name)
  BIND(${desc.expr} AS ?description)
  BIND(COALESCE(${pub.expr}, STR(?publisherRaw)) AS ?publisher)
  BIND(IF(EXISTS { ${c} schema:workExample <${VISUALIZE_APP}> }, 1, 0) AS ?visualize)
}
LIMIT 50`;
}

export function buildDimensionsQuery(cubeIri: string, lang: Lang): string {
  const c = iriRef(cubeIri);
  const label = labelPatterns("?prop", "schema:name|rdfs:label", "l", lang);
  const desc = labelPatterns("?prop", "schema:description", "d", lang);
  const unit = labelPatterns("?unit", "schema:name|rdfs:label", "u", lang);
  return `${PREFIXES}
SELECT ?dim ?label ?description ?kind ?unit ?unitLabel ?datatype ?nodeKind ?min ?max ?order ?scaleType WHERE {
  ${c} cube:observationConstraint ?shape .
  ?shape sh:property ?prop .
  ?prop sh:path ?dim .
  FILTER(isIRI(?dim) && ?dim NOT IN (rdf:type, cube:observedBy))
${label.patterns}
${desc.patterns}
  OPTIONAL { ?prop a ?kind . FILTER(?kind IN (cube:KeyDimension, cube:MeasureDimension)) }
  OPTIONAL {
    ?prop qudt:unit ?unit .
${unit.patterns}
    OPTIONAL { ?unit qudt:symbol ?unitSym }
  }
  OPTIONAL { ?prop sh:datatype ?dt1 }
  OPTIONAL { ?prop sh:or/rdf:rest*/rdf:first/sh:datatype ?dt2 . FILTER(?dt2 != cube:Undefined) }
  OPTIONAL { ?prop sh:nodeKind ?nodeKind }
  OPTIONAL { ?prop sh:minInclusive ?min }
  OPTIONAL { ?prop sh:maxInclusive ?max }
  OPTIONAL { ?prop sh:order ?order }
  OPTIONAL { ?prop qudt:scaleType ?scaleType }
  BIND(${label.expr} AS ?label)
  BIND(${desc.expr} AS ?description)
  BIND(COALESCE(${unit.expr}, STR(?unitSym)) AS ?unitLabel)
  BIND(COALESCE(?dt1, ?dt2) AS ?datatype)
}
LIMIT 3000`;
}

/** Observations sampled per dimension when looking for example values. */
export const EXAMPLE_SAMPLE_OBS = 2000;

/**
 * Example values per dimension: union of the shape's sh:in list and DISTINCT
 * values among a bounded sample of observations, capped per dimension.
 */
export function buildExamplesQuery(cubeIri: string, dimIris: string[], perDim: number, lang: Lang): string {
  const c = iriRef(cubeIri);
  const n = Math.max(1, Math.min(50, Math.floor(perDim)));
  const branches = dimIris.map((d) => {
    const dim = iriRef(d);
    return `  {
    { SELECT DISTINCT ?value WHERE {
      { ${c} cube:observationConstraint/sh:property ?p . ?p sh:path ${dim} ; sh:in/rdf:rest*/rdf:first ?value . }
      UNION
      { { SELECT ?obs WHERE { ${c} cube:observationSet ?set . ?set cube:observation ?obs . } LIMIT ${EXAMPLE_SAMPLE_OBS} }
        ?obs ${dim} ?value . }
    } LIMIT ${n} }
    BIND(${dim} AS ?dim)
  }`;
  });
  const label = labelPatterns("?value", "schema:name|rdfs:label", "v", lang);
  return `${PREFIXES}
SELECT ?dim ?value ?label WHERE {
${branches.join("\n  UNION\n")}
${label.patterns}
  BIND(${label.expr} AS ?label)
}
LIMIT ${dimIris.length * n * 4}`;
}

/** A resolved filter: dimension IRI and accepted values (IRIs or label/literal text). */
export interface ResolvedFilter {
  dimension: string;
  values: string[];
}

export interface ObservationQueryOptions {
  cube: string;
  dimensions: string[];
  filters: ResolvedFilter[];
  limit: number;
  offset: number;
  lang: Lang;
}

/** Filter pattern for one dimension. IRIs match exactly; other text matches the literal value or the value's label, case-insensitively. */
export function filterPattern(f: ResolvedFilter, idx: number): string {
  const dim = iriRef(f.dimension);
  const v = `?f${idx}`;
  const iris = f.values.filter(isSafeIri);
  const texts = f.values.filter((x) => !isSafeIri(x)).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const conds: string[] = [];
  if (iris.length) conds.push(`${v} IN (${iris.map((i) => `<${i}>`).join(", ")})`);
  if (texts.length) {
    const lits = texts.map(literal).join(", ");
    conds.push(`LCASE(STR(${v})) IN (${lits})`);
    conds.push(`(isIRI(${v}) && EXISTS { ${v} schema:name|rdfs:label ${v}l . FILTER(LCASE(STR(${v}l)) IN (${lits})) })`);
  }
  if (!conds.length) throw new Error("Filter has no usable values.");
  return `    ?obs ${dim} ${v} .\n    FILTER(${conds.join(" || ")})`;
}

/** Deepest page reachable via offset: the sorted subquery gets expensive past this. */
export const MAX_OBS_OFFSET = 10_000;

/**
 * Observation SELECT. The inner subquery is always ORDER BY ?obs so that
 * consecutive pages (offset 0, limit, 2·limit, …) slice one stable ordering —
 * without it, page 1 and page 2 come from different, arbitrary orders and
 * rows are skipped or repeated.
 */
export function buildObservationQuery(o: ObservationQueryOptions): string {
  const c = iriRef(o.cube);
  if (!o.dimensions.length) throw new Error("No dimensions to select.");
  const limit = Math.max(1, Math.min(1000, Math.floor(o.limit)));
  const offset = Math.max(0, Math.min(MAX_OBS_OFFSET, Math.floor(o.offset)));
  const filters = o.filters.map(filterPattern).join("\n");
  const label = labelPatterns("?value", "schema:name|rdfs:label", "v", o.lang);
  return `${PREFIXES}
SELECT ?obs ?dim ?value ?label WHERE {
  { SELECT ?obs WHERE {
    ${c} cube:observationSet ?set .
    ?set cube:observation ?obs .
${filters}
  } ORDER BY ?obs LIMIT ${limit}${offset > 0 ? ` OFFSET ${offset}` : ""} }
  VALUES ?dim { ${o.dimensions.map(iriRef).join(" ")} }
  ?obs ?dim ?value .
${label.patterns}
  BIND(${label.expr} AS ?label)
}`;
}

// ---------------------------------------------------------------------------
// Parsing (exported for tests)
// ---------------------------------------------------------------------------

interface Term {
  type?: string;
  value?: string;
  datatype?: string;
  "xml:lang"?: string;
}
type Binding = Record<string, Term | undefined>;
export interface SparqlResponse {
  head?: { vars?: string[] };
  results?: { bindings?: Binding[] };
}

const XSD = "http://www.w3.org/2001/XMLSchema#";
const NUMERIC_TYPES = new Set(
  ["decimal", "double", "float", "integer", "int", "long", "short", "byte", "nonNegativeInteger", "positiveInteger", "negativeInteger", "nonPositiveInteger", "unsignedInt", "unsignedLong", "unsignedShort"].map(
    (t) => XSD + t,
  ),
);

function val(b: Binding, k: string): string | undefined {
  const v = b[k]?.value;
  return v === undefined || v === "" ? undefined : v;
}

function trimText(s: string | undefined, max: number): string | undefined {
  if (!s) return undefined;
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function localName(iri: string): string {
  const m = iri.match(/[^/#]+$/);
  return m ? decodeURIComponentSafe(m[0]) : iri;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function visualizeUrl(cubeIri: string, lang: Lang): string {
  return `https://visualize.admin.ch/${lang}/browse?dataset=${encodeURIComponent(cubeIri)}&dataSource=Prod`;
}

export interface CubeSummary {
  cube: string;
  name?: string;
  description?: string;
  publisher?: string;
  modified?: string;
  status?: string;
  on_visualize: boolean;
  visualize_url: string;
}

function statusName(s: string | undefined): string | undefined {
  return s ? localName(s) : undefined;
}

export function parseSearch(data: SparqlResponse, lang: Lang): CubeSummary[] {
  const seen = new Set<string>();
  const out: CubeSummary[] = [];
  for (const b of data.results?.bindings ?? []) {
    const cube = val(b, "cube");
    if (!cube || seen.has(cube)) continue;
    seen.add(cube);
    out.push({
      cube,
      name: trimText(val(b, "name"), 200),
      description: trimText(val(b, "description"), 280),
      publisher: trimText(val(b, "publisher"), 120),
      modified: val(b, "modified")?.slice(0, 10),
      status: statusName(val(b, "status")),
      on_visualize: val(b, "visualize") === "1" || val(b, "visualize") === "true",
      visualize_url: visualizeUrl(cube, lang),
    });
  }
  return out;
}

export interface CubeMeta {
  cube: string;
  name?: string;
  description?: string;
  publisher?: string;
  publisher_iri?: string;
  status?: string;
  modified?: string;
  published?: string;
  version?: string;
  licence?: string;
  expires?: string;
  newer_version?: string;
  on_visualize: boolean;
  visualize_url: string;
}

export function parseMeta(cube: string, data: SparqlResponse, lang: Lang): CubeMeta | undefined {
  const rows = data.results?.bindings ?? [];
  if (!rows.length) return undefined;
  const first = (k: string) => rows.map((r) => val(r, k)).find((v) => v !== undefined);
  return {
    cube,
    name: trimText(first("name"), 300),
    description: trimText(first("description"), 1500),
    publisher: trimText(first("publisher"), 200),
    publisher_iri: first("creator"),
    status: statusName(first("status")),
    modified: first("modified")?.slice(0, 10),
    published: first("published")?.slice(0, 10),
    version: first("version"),
    licence: first("licence"),
    expires: first("expires")?.slice(0, 10),
    newer_version: first("newer"),
    on_visualize: rows.some((r) => val(r, "visualize") === "1" || val(r, "visualize") === "true"),
    visualize_url: visualizeUrl(cube, lang),
  };
}

export interface CubeDimension {
  iri: string;
  label: string;
  description?: string;
  role: "key" | "measure";
  role_inferred?: true;
  unit?: string;
  unit_label?: string;
  datatype?: string;
  node_kind?: string;
  min?: string;
  max?: string;
  scale_type?: string;
  order?: number;
}

function shortXsd(dt: string | undefined): string | undefined {
  if (!dt) return undefined;
  return dt.startsWith(XSD) ? `xsd:${dt.slice(XSD.length)}` : dt;
}

export function parseDimensions(data: SparqlResponse): CubeDimension[] {
  const byIri = new Map<string, { kinds: Set<string>; row: Record<string, string | undefined> }>();
  const keys = ["label", "description", "unit", "unitLabel", "datatype", "nodeKind", "min", "max", "order", "scaleType"];
  for (const b of data.results?.bindings ?? []) {
    const dim = val(b, "dim");
    if (!dim) continue;
    let e = byIri.get(dim);
    if (!e) {
      e = { kinds: new Set(), row: {} };
      byIri.set(dim, e);
    }
    const kind = val(b, "kind");
    if (kind) e.kinds.add(kind);
    for (const k of keys) if (e.row[k] === undefined) e.row[k] = val(b, k);
  }
  const dims: CubeDimension[] = [];
  for (const [iri, { kinds, row }] of byIri) {
    let role: "key" | "measure";
    let inferred = false;
    if (kinds.has("https://cube.link/MeasureDimension")) role = "measure";
    else if (kinds.has("https://cube.link/KeyDimension")) role = "key";
    else {
      inferred = true;
      const isIriNode = row.nodeKind?.endsWith("#IRI") ?? false;
      role = !isIriNode && row.datatype && NUMERIC_TYPES.has(row.datatype) ? "measure" : "key";
    }
    const order = row.order !== undefined ? Number(row.order) : undefined;
    dims.push({
      iri,
      label: trimText(row.label, 150) ?? localName(iri),
      description: trimText(row.description, 300),
      role,
      ...(inferred ? { role_inferred: true as const } : {}),
      unit: row.unit,
      unit_label: row.unitLabel,
      datatype: shortXsd(row.datatype),
      node_kind: row.nodeKind ? localName(row.nodeKind) : undefined,
      min: row.min,
      max: row.max,
      scale_type: row.scaleType ? localName(row.scaleType) : undefined,
      order: order !== undefined && Number.isFinite(order) ? order : undefined,
    });
  }
  dims.sort((a, b) => {
    if (a.role !== b.role) return a.role === "key" ? -1 : 1;
    return (a.order ?? 1e9) - (b.order ?? 1e9) || a.label.localeCompare(b.label);
  });
  return dims;
}

export interface ExampleValue {
  value: string;
  label?: string;
}

export function parseExamples(data: SparqlResponse, perDim: number): Map<string, ExampleValue[]> {
  const out = new Map<string, ExampleValue[]>();
  const seen = new Set<string>();
  for (const b of data.results?.bindings ?? []) {
    const dim = val(b, "dim");
    const value = b["value"]?.value;
    if (!dim || value === undefined) continue;
    const key = `${dim}\u0000${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = out.get(dim) ?? [];
    if (list.length >= perDim) continue;
    const label = val(b, "label");
    list.push(label && label !== value ? { value, label: trimText(label, 150) } : { value });
    out.set(dim, list);
  }
  return out;
}

/** Map each dimension to a unique column key (its label, disambiguated if needed). */
export function columnKeys(dims: CubeDimension[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const d of dims) counts.set(d.label, (counts.get(d.label) ?? 0) + 1);
  const used = new Set<string>();
  const keys = new Map<string, string>();
  for (const d of dims) {
    let k = (counts.get(d.label) ?? 0) > 1 ? `${d.label} (${localName(d.iri)})` : d.label;
    while (used.has(k)) k = `${k}'`;
    used.add(k);
    keys.set(d.iri, k);
  }
  return keys;
}

function convertTerm(t: Term): string | number {
  const v = t.value ?? "";
  if (t.type !== "uri" && t.datatype && NUMERIC_TYPES.has(t.datatype)) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return v;
}

/** Pivot long (obs, dim, value, label) bindings into one flat row per observation. */
export function pivotObservations(
  data: SparqlResponse,
  dims: CubeDimension[],
  includeIris = false,
): Array<Record<string, string | number | null>> {
  const keys = columnKeys(dims);
  const rows = new Map<string, Record<string, string | number | null>>();
  const filled = new Set<string>();
  for (const b of data.results?.bindings ?? []) {
    const obs = val(b, "obs");
    const dim = val(b, "dim");
    const term = b["value"];
    if (!obs || !dim || !term) continue;
    const key = keys.get(dim);
    if (!key) continue;
    let row = rows.get(obs);
    if (!row) {
      row = {};
      for (const d of dims) row[keys.get(d.iri)!] = null;
      rows.set(obs, row);
    }
    const slot = `${obs}\u0000${dim}`;
    if (filled.has(slot)) continue;
    filled.add(slot);
    if (term.type === "uri") {
      row[key] = val(b, "label") ?? term.value ?? null;
      if (includeIris) row[`${key} IRI`] = term.value ?? null;
    } else {
      row[key] = convertTerm(term);
    }
  }
  return [...rows.values()];
}

/**
 * Resolve a user's dimension reference (IRI, label, or IRI local name,
 * case-insensitive) to a dimension of the cube.
 */
export function resolveDimension(ref: string, dims: CubeDimension[]): CubeDimension | undefined {
  const r = ref.trim();
  const lc = r.toLowerCase();
  return (
    dims.find((d) => d.iri === r) ??
    dims.find((d) => d.label.toLowerCase() === lc) ??
    dims.find((d) => localName(d.iri).toLowerCase() === lc) ??
    (() => {
      const partial = dims.filter((d) => d.label.toLowerCase().includes(lc));
      return partial.length === 1 ? partial[0] : undefined;
    })()
  );
}

/** Accept a cube IRI or a visualize.admin.ch URL carrying ?dataset=<IRI>. */
export function normaliseCubeRef(input: string): string | undefined {
  const s = input.trim();
  if (!IRI_RE.test(s)) return undefined;
  try {
    const u = new URL(s);
    if (u.hostname === "visualize.admin.ch" || u.hostname.endsWith(".visualize.admin.ch")) {
      const ds = u.searchParams.get("dataset");
      if (ds && isSafeIri(ds)) return ds;
      const m = u.pathname.match(/\/browse\/dataset\/(.+)$/);
      if (m) {
        const decoded = decodeURIComponentSafe(m[1]);
        if (isSafeIri(decoded)) return decoded;
      }
    }
  } catch {
    return undefined;
  }
  return isSafeIri(s) ? s : undefined;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function sparql(query: string, ttlMs: number) {
  return fetchJson<SparqlResponse>(ENDPOINT, {
    ttlMs,
    timeoutMs: TIMEOUT_MS,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/sparql-results+json",
      },
      body: `query=${encodeURIComponent(query)}`,
    },
  });
}

function mergeStatus(...s: CacheStatus[]): CacheStatus {
  return s.every((x) => x === "hit") ? "hit" : s.includes("miss") ? "miss" : s.includes("stale") ? "stale" : "hit";
}

export async function searchCubes(o: SearchOptions) {
  const res = await sparql(buildSearchQuery(o), META_TTL_MS);
  return { ...res, cubes: parseSearch(res.data, o.lang) };
}

async function loadDimensions(cube: string, lang: Lang) {
  const res = await sparql(buildDimensionsQuery(cube, lang), META_TTL_MS);
  return { ...res, dims: parseDimensions(res.data) };
}

const langSchema = z.enum(["de", "fr", "it", "en"]).default("en");

const CUBE_REF_ERROR = [
  "Pass the cube IRI exactly as returned by search_data_cubes, e.g. 'https://energy.ld.admin.ch/elcom/electricityprice'.",
  "A visualize.admin.ch link with ?dataset=<IRI> is also accepted.",
];

/** Target size of query_data_cube's payload (respond() withholds anything over 50 KB). */
const OBS_RESPONSE_BUDGET = 45_000;
/** Room kept for the envelope's source/attribution/links/notes fields. */
const ENVELOPE_RESERVE = 2_500;
/** Rows always get at least this much room before the optional SPARQL echo does. */
const MIN_ROWS_BUDGET = 10_000;

/** Keep a row list under the envelope cap; returns the kept rows and whether it trimmed. */
function fitRows<T>(rows: T[], budget = 42_000): { rows: T[]; trimmed: boolean } {
  let size = 2;
  for (let i = 0; i < rows.length; i++) {
    size += JSON.stringify(rows[i]).length + 1;
    if (size > budget) return { rows: rows.slice(0, i), trimmed: true };
  }
  return { rows, trimmed: false };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

// A per-query SPARQL search over every cube is the slowest thing find_data
// does. Instead, list all published cubes once (one query, cached 6 h, warmed
// at start-up) and match keywords locally — milliseconds instead of seconds.

const INDEX_MAX = 3000;
const cubeIndex = new Map<Lang, { at: number; cubes: CubeSummary[] }>();
const cubeIndexInflight = new Map<Lang, Promise<CubeSummary[]>>();

export function buildCubeIndexQuery(lang: Lang): string {
  return buildSearchQuery({ query: "", lang, limit: INDEX_MAX, offset: 0, publishedOnly: true }, INDEX_MAX);
}

function loadCubeIndex(lang: Lang): Promise<CubeSummary[]> {
  const existing = cubeIndexInflight.get(lang);
  if (existing) return existing;
  const p = outsideBudget(() => sparql(buildCubeIndexQuery(lang), META_TTL_MS))
    .then((res) => {
      const cubes = parseSearch(res.data, lang);
      cubeIndex.set(lang, { at: Date.now(), cubes });
      return cubes;
    })
    .finally(() => cubeIndexInflight.delete(lang));
  cubeIndexInflight.set(lang, p);
  return p;
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** Every term must appear in name, description, publisher or IRI (index order kept). */
export function searchCubeIndex(cubes: CubeSummary[], query: string, limit: number): CubeSummary[] {
  const terms = searchTerms(query).map(fold);
  if (!terms.length) return [];
  const out: CubeSummary[] = [];
  for (const c of cubes) {
    const hay = fold(`${c.name ?? ""} ${c.description ?? ""} ${c.publisher ?? ""} ${c.cube}`);
    if (terms.every((t) => hay.includes(t))) {
      out.push(c);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Test hook. */
export function setCubeIndexForTests(lang: Lang, cubes: CubeSummary[] | undefined): void {
  if (cubes) cubeIndex.set(lang, { at: Date.now(), cubes });
  else cubeIndex.delete(lang);
}

registerSearcher({
  catalogue: "LINDAS cubes",
  module: "cubes",
  warm: async () => {
    await loadCubeIndex("de");
  },
  search: async (query: string, limit: number, lang: string): Promise<DataHit[]> => {
    if (!searchTerms(query).length) return [];
    const l: Lang = (["de", "fr", "it", "en"] as const).includes(lang as Lang) ? (lang as Lang) : "en";
    const n = Math.min(Math.max(limit, 1), 20);
    const idx = cubeIndex.get(l);
    let cubes: CubeSummary[];
    if (idx && Date.now() - idx.at < META_TTL_MS) {
      cubes = searchCubeIndex(idx.cubes, query, n);
    } else {
      void loadCubeIndex(l).catch(() => undefined); // build it for next time
      ({ cubes } = await searchCubes({ query, lang: l, limit: n, offset: 0, publishedOnly: true }));
    }
    return cubes.map((c) => ({
      catalogue: "LINDAS cubes",
      id: c.cube,
      title: c.name ?? c.cube,
      description: c.description,
      publisher: c.publisher,
      url: c.visualize_url,
      next: { tool: "describe_data_cube", args: { cube: c.cube } },
    }));
  },
});

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export const cubesModule: SwissyphusModule = {
  id: "cubes",
  emoji: "🧊",
  title: "Statistical cubes (LINDAS / visualize.admin.ch)",
  description:
    "Search, describe and query the hundreds of federal statistical data cubes on LINDAS (BFS, BAFU, BFE, ElCom, FOAG, ASTRA…) without writing SPARQL",
  sources: [source],
  healthProbes: [
    {
      sourceId: "lindas-cubes",
      url: `${ENDPOINT}?query=${encodeURIComponent("SELECT ?c WHERE { ?c a <https://cube.link/Cube> } LIMIT 1")}`,
      headers: { Accept: "application/sparql-results+json" },
    },
  ],
  tools: [
    tool({
      name: "search_data_cubes",
      title: "Search LINDAS statistical data cubes",
      description:
        "Keyword search over the federal statistical data cubes on LINDAS (the data behind visualize.admin.ch): electricity prices (ElCom), energy statistics (BFE), environment/air/water (BAFU), agriculture (FOAG), traffic counts (ASTRA), population and economy (BFS) and more. " +
        "Every word must appear (case-insensitive) in the cube's name, description, publisher or IRI, in any language (German terms often match best, e.g. 'Strompreis', 'Luft', 'Verkehr'). " +
        "Returns cube IRI, name, trimmed description, publisher, last-modified date and a visualize.admin.ch link. Deprecated cube versions are excluded; published cubes shown on visualize.admin.ch rank first. " +
        "Next step: describe_data_cube {cube: <IRI>}. Examples: {query: 'electricity price'}, {query: 'Treibhausgas', lang: 'de'}, {query: 'bfe energie', limit: 10}.",
      inputSchema: {
        query: z.string().max(200).default("").describe("Keywords (all must match). Empty lists the most recently modified cubes."),
        lang: langSchema.describe("Preferred language for names/descriptions (falls back to de/fr/it/en)"),
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).max(5000).default(0),
        published_only: z.boolean().default(true).describe("Exclude cubes whose status is Draft"),
      },
      handler: async ({ query, lang, limit, offset, published_only }) => {
        try {
          const { cubes, cacheStatus, retrievedAt } = await searchCubes({
            query,
            lang,
            limit,
            offset,
            publishedOnly: published_only,
          });
          if (!cubes.length) {
            return toolError(`No LINDAS cubes matched '${query}'.`, [
              "Use fewer or broader keywords — every word must match.",
              "Try German or French terms (e.g. 'Strom', 'Bevölkerung', 'Luftqualität'); many cubes are titled in German first.",
              "Set published_only=false to include draft cubes.",
            ]);
          }
          return respond(
            {
              query,
              count: cubes.length,
              offset,
              cubes,
              next: "describe_data_cube {cube: '<cube IRI>'} lists dimensions and valid filter values.",
            },
            { source, cacheStatus, retrievedAt, language: lang },
          );
        } catch (err) {
          return errorToResult(err, "LINDAS SPARQL endpoint");
        }
      },
    }),
    tool({
      name: "describe_data_cube",
      title: "Describe a LINDAS data cube",
      description:
        "Show the structure of one LINDAS statistical cube so you can query it: title, publisher, licence, status, dates, and every dimension with its IRI, label, role (key dimension vs measure), unit, datatype, min/max, and up to N example values with labels (sampled from the cube's value lists and observations). " +
        "Use the dimension labels and example value labels as filters in query_data_cube. " +
        "Example: {cube: 'https://energy.ld.admin.ch/elcom/electricityprice'}, {cube: '<IRI from search_data_cubes>', examples: 20, lang: 'de'}.",
      inputSchema: {
        cube: z.string().min(8).max(2000).describe("Cube IRI from search_data_cubes (or a visualize.admin.ch ?dataset= link)"),
        lang: langSchema,
        examples: z.number().int().min(0).max(50).default(10).describe("Example values per key dimension (0 = skip)"),
      },
      handler: async ({ cube, lang, examples }) => {
        const iri = normaliseCubeRef(cube);
        if (!iri) return toolError(`'${cube.slice(0, 200)}' is not a valid cube IRI.`, CUBE_REF_ERROR);
        try {
          const [meta, dimsRes] = await Promise.all([
            sparql(buildCubeMetaQuery(iri, lang), META_TTL_MS),
            loadDimensions(iri, lang),
          ]);
          const m = parseMeta(iri, meta.data, lang);
          if (!m) {
            return toolError(`No cube found with IRI ${iri}.`, [
              "Find cube IRIs with search_data_cubes {query: '<keywords>'}.",
              ...CUBE_REF_ERROR,
            ]);
          }
          const dims = dimsRes.dims;
          const notes: string[] = [];
          if (m.expires) notes.push(`This cube version is deprecated (expires ${m.expires}).`);
          if (m.newer_version) notes.push(`A newer version exists: ${m.newer_version}`);
          if (!dims.length) notes.push("No SHACL observation shape found — dimensions unknown; query_data_cube needs them.");

          let exampleMap = new Map<string, ExampleValue[]>();
          const exampleDims = dims.filter((d) => d.role === "key").slice(0, 25);
          if (examples > 0 && exampleDims.length) {
            try {
              const ex = await sparql(
                buildExamplesQuery(iri, exampleDims.map((d) => d.iri), examples, lang),
                META_TTL_MS,
              );
              exampleMap = parseExamples(ex.data, examples);
            } catch {
              notes.push("Example values could not be fetched (query timed out); dimensions are still listed.");
            }
          }

          const dimensions = dims.map((d) => {
            const ex = exampleMap.get(d.iri);
            return { ...d, ...(ex ? { example_values: ex } : {}) };
          });
          const body = {
            ...m,
            dimension_count: dims.length,
            dimensions,
            how_to_query:
              "query_data_cube {cube, filters: {'<dimension label or IRI>': '<value label or IRI>' | [values…]}, limit}",
          };
          let data: unknown = body;
          if (JSON.stringify(body).length > 45_000) {
            // Oversized (many dimensions / long labels): drop examples beyond 5.
            data = {
              ...body,
              dimensions: dimensions.map((d) =>
                "example_values" in d && d.example_values ? { ...d, example_values: d.example_values.slice(0, 5) } : d,
              ),
            };
            notes.push("Example values truncated to 5 per dimension to fit the response size cap.");
          }
          return respond(data, {
            source,
            cacheStatus: mergeStatus(meta.cacheStatus, dimsRes.cacheStatus),
            retrievedAt: meta.retrievedAt,
            dataAsOf: m.modified,
            language: lang,
            links: { visualize: m.visualize_url, cube: iri },
            ...(notes.length ? { notes: notes.join(" ") } : {}),
          });
        } catch (err) {
          return errorToResult(err, "LINDAS SPARQL endpoint");
        }
      },
    }),
    tool({
      name: "query_data_cube",
      title: "Query observations from a LINDAS data cube",
      description:
        "Fetch observations from a LINDAS statistical cube as flat rows keyed by dimension labels (IRI values replaced by their human labels; numbers as numbers). " +
        "Optional filters map a dimension (label, IRI or IRI local name) to one value or a list of values (label, literal such as a year, or IRI) — matching is exact and case-insensitive; get valid values from describe_data_cube. " +
        "Returns columns (with role and unit), rows and row_count. limit default 100, max 1000 (large results are trimmed to fit 50 KB). " +
        "Examples: {cube: 'https://energy.ld.admin.ch/elcom/electricityprice', filters: {'Period': '2025', 'Category': 'H4'}, limit: 50}, " +
        "{cube: '<IRI>', filters: {'Canton': ['Zürich', 'Bern']}}.",
      inputSchema: {
        cube: z.string().min(8).max(2000).describe("Cube IRI from search_data_cubes"),
        filters: z
          .record(z.string(), z.union([z.string().min(1).max(300), z.array(z.string().min(1).max(300)).min(1).max(20)]))
          .optional()
          .describe("{dimension label/IRI: value label/IRI or array of them}. Max 10 filters."),
        limit: z.number().int().min(1).max(1000).default(100),
        offset: z
          .number()
          .int()
          .min(0)
          .max(MAX_OBS_OFFSET)
          .default(0)
          .describe(`Skip observations for paging (stable order; max ${MAX_OBS_OFFSET} — use filters to reach deeper data)`),
        lang: langSchema,
        include_iris: z.boolean().default(false).describe("Also return the raw IRI of each IRI-valued cell as '<column> IRI'"),
        include_sparql: z.boolean().default(false).describe("Return the generated SPARQL (to adapt with query_lindas)"),
      },
      handler: async ({ cube, filters, limit, offset, lang, include_iris, include_sparql }) => {
        const iri = normaliseCubeRef(cube);
        if (!iri) return toolError(`'${cube.slice(0, 200)}' is not a valid cube IRI.`, CUBE_REF_ERROR);
        const filterEntries = Object.entries(filters ?? {});
        if (filterEntries.length > 10) return toolError("At most 10 filters are supported.", ["Drop the least selective filters."]);
        try {
          const dimsRes = await loadDimensions(iri, lang);
          const dims = dimsRes.dims;
          if (!dims.length) {
            return toolError(`Cube ${iri} has no readable dimension shape (or does not exist).`, [
              "Check the IRI with describe_data_cube or search_data_cubes.",
              "As a fallback, write SPARQL yourself with query_lindas.",
            ]);
          }
          const resolved: ResolvedFilter[] = [];
          for (const [ref, v] of filterEntries) {
            const d = resolveDimension(ref, dims);
            if (!d) {
              return toolError(`Unknown dimension '${ref.slice(0, 120)}' for this cube.`, [
                `Available dimensions: ${dims.map((x) => x.label).join(", ").slice(0, 1500)}`,
                "Use a dimension label or IRI exactly as listed by describe_data_cube.",
              ]);
            }
            const values = (Array.isArray(v) ? v : [v]).map((x) => x.trim()).filter(Boolean);
            if (!values.length) continue;
            const existing = resolved.find((r) => r.dimension === d.iri);
            if (existing) existing.values.push(...values);
            else resolved.push({ dimension: d.iri, values });
          }
          const query = buildObservationQuery({
            cube: iri,
            dimensions: dims.map((d) => d.iri),
            filters: resolved,
            limit,
            offset,
            lang,
          });
          const res = await sparql(query, OBS_TTL_MS);
          const all = pivotObservations(res.data, dims, include_iris);
          if (!all.length) {
            return toolError("The cube returned no observations for these filters.", [
              "Check filter values against describe_data_cube example_values (labels must match exactly, case-insensitive).",
              "Pass value IRIs instead of labels when a label is ambiguous or translated.",
              ...(offset > 0 ? ["Lower the offset — it may be past the end of the cube."] : []),
            ]);
          }
          const keys = columnKeys(dims);
          const notes: string[] = [];
          let filtersOut: Array<{ dimension?: string; iri: string; values: string[]; value_count?: number }> = resolved.map((f) => ({
            dimension: keys.get(f.dimension),
            iri: f.dimension,
            values: f.values,
          }));
          // 10 filters × 20 values × 300 chars could alone blow the cap: echo a sample.
          if (JSON.stringify(filtersOut).length > 8_000) {
            filtersOut = filtersOut.map((f) => ({ ...f, values: f.values.slice(0, 3).map((v) => v.slice(0, 120)), value_count: f.values.length }));
          }
          const base = {
            cube: iri,
            filters: filtersOut,
            columns: dims.map((d) => ({
              key: keys.get(d.iri),
              iri: d.iri,
              role: d.role,
              ...(d.unit_label || d.unit ? { unit: d.unit_label ?? localName(d.unit!) } : {}),
            })),
          };
          // Everything but the rows must leave room for rows within the budget;
          // a huge generated query (many filter values) is dropped rather than
          // letting it push the whole response over the 50 KB cap.
          const baseSize = JSON.stringify(base).length + ENVELOPE_RESERVE;
          let sparqlOut: string | undefined;
          if (include_sparql) {
            if (baseSize + JSON.stringify(query).length <= OBS_RESPONSE_BUDGET - MIN_ROWS_BUDGET) sparqlOut = query;
            else notes.push("The generated SPARQL was omitted because it would not fit the 50 KB response cap; request fewer filter values.");
          }
          const rowsBudget = Math.max(
            1_000,
            OBS_RESPONSE_BUDGET - baseSize - (sparqlOut ? JSON.stringify(sparqlOut).length : 0),
          );
          const { rows, trimmed } = fitRows(all, rowsBudget);
          if (trimmed) notes.push(`Rows trimmed from ${all.length} to ${rows.length} to fit the 50 KB response cap; add filters or lower limit.`);
          if (all.length >= limit) notes.push(`Result reached limit=${limit}; more observations may exist (use offset or filters).`);
          return respond(
            {
              ...base,
              row_count: rows.length,
              rows,
              ...(sparqlOut ? { sparql: sparqlOut } : {}),
            },
            {
              source,
              cacheStatus: mergeStatus(dimsRes.cacheStatus, res.cacheStatus),
              retrievedAt: res.retrievedAt,
              language: lang,
              links: { visualize: visualizeUrl(iri, lang), cube: iri },
              ...(notes.length ? { notes: notes.join(" ") } : {}),
            },
          );
        } catch (err) {
          if (err instanceof Error && /^Not a valid IRI|Filter has no usable values/.test(err.message)) {
            return toolError(err.message, CUBE_REF_ERROR);
          }
          return errorToResult(err, "LINDAS SPARQL endpoint");
        }
      },
    }),
  ],
};
