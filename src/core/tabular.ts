/**
 * Generic tabular helpers for catalogue adapters: parse CSV / JSON / GeoJSON
 * resources into row objects, then filter, project and page them so an agent
 * can query a raw open-data file without downloading it itself.
 *
 * Pure functions, no I/O — unit-tested offline.
 */

export type Row = Record<string, unknown>;

export interface Table {
  columns: string[];
  rows: Row[];
  /** Format the parser detected. */
  format: "csv" | "json" | "geojson";
  /** Parser caveats (e.g. truncated, delimiter guess). */
  notes?: string[];
}

/** Hard parser limits: a hostile file must not pin the event loop or the heap. */
export const MAX_COLUMNS = 1_000;
export const MAX_CELLS = 2_000_000;

/** Guess the CSV delimiter from the header line. */
export function sniffDelimiter(headerLine: string): string {
  const candidates = [";", ",", "\t", "|"];
  let best = ",";
  let bestCount = 0;
  for (const d of candidates) {
    // Count delimiters outside quotes only.
    let count = 0;
    let inQ = false;
    for (const ch of headerLine) {
      if (ch === '"') inQ = !inQ;
      else if (ch === d && !inQ) count++;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/**
 * RFC 4180-ish CSV parser: quoted fields, escaped quotes (""), embedded
 * newlines, CRLF, UTF-8 BOM, delimiter sniffing. Stops after `maxRows`.
 */
export function parseCsv(text: string, opts: { delimiter?: string; maxRows?: number } = {}): Table {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const nl = src.search(/\r?\n/);
  const firstLine = src.slice(0, nl === -1 ? src.length : nl);
  const delim = opts.delimiter ?? sniffDelimiter(firstLine.slice(0, 64 * 1024));
  const requestedMax = opts.maxRows ?? Infinity;

  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let truncated = false;
  let maxRows = requestedMax;
  let i = 0;
  const n = src.length;
  const pushRecord = () => {
    record.push(field);
    field = "";
    if (!(record.length === 1 && record[0] === "")) {
      if (records.length === 0) {
        if (record.length > MAX_COLUMNS) {
          throw new Error(`File has ${record.length} columns; the limit is ${MAX_COLUMNS}.`);
        }
        // Budget total cells so wide files get fewer rows.
        maxRows = Math.min(requestedMax, Math.floor(MAX_CELLS / Math.max(1, record.length)));
      }
      records.push(record);
    }
    record = [];
  };
  while (i < n) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      i++;
    } else if (ch === delim) {
      record.push(field);
      field = "";
      if (record.length > MAX_COLUMNS + 1) {
        throw new Error(`File has more than ${MAX_COLUMNS} columns; the limit is ${MAX_COLUMNS}.`);
      }
      i++;
    } else if (ch === "\n" || ch === "\r") {
      pushRecord();
      if (ch === "\r" && src[i + 1] === "\n") i++;
      i++;
      // records includes the header row: stop once maxRows data rows are in,
      // and flag truncation only if another non-blank record actually follows.
      if (records.length > maxRows) {
        let j = i;
        while (j < n && (src[j] === "\n" || src[j] === "\r" || src[j] === " " || src[j] === "\t")) j++;
        truncated = j < n;
        break;
      }
    } else {
      field += ch;
      i++;
    }
  }
  if (i >= n && (field !== "" || record.length)) pushRecord();
  if (records.length - 1 > maxRows) truncated = true;

  const header = (records.shift() ?? []).map((h, idx) => h.trim() || `column_${idx + 1}`);
  // De-duplicate header names so row objects don't silently drop columns.
  const seen = new Map<string, number>();
  const columns = header.map((h) => {
    const c = seen.get(h) ?? 0;
    seen.set(h, c + 1);
    return c ? `${h}_${c + 1}` : h;
  });
  const rows = records.slice(0, maxRows).map((r) => {
    const o: Row = {};
    columns.forEach((c, idx) => {
      o[c] = coerce(r[idx]);
    });
    return o;
  });
  const notes = [`delimiter '${delim === "\t" ? "\\t" : delim}'`];
  if (truncated) notes.push(`truncated to first ${maxRows} rows`);
  return { columns, rows, format: "csv", notes };
}

/** Turn numeric-looking strings into numbers; keep everything else verbatim. */
export function coerce(v: string | undefined): unknown {
  if (v === undefined) return null;
  const t = v.trim();
  if (t === "") return null;
  // Don't coerce identifiers with leading zeros (PLZ "0800", BFS "0261") or
  // very long digit strings (UIDs, EGIDs beyond float precision).
  if (/^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

/** Find the most plausible array of records inside an arbitrary JSON document. */
export function extractRecords(doc: unknown, depth = 0): Row[] | undefined {
  if (Array.isArray(doc)) {
    if (doc.length && doc.every((x) => x && typeof x === "object" && !Array.isArray(x))) return doc as Row[];
    if (doc.length && doc.every((x) => Array.isArray(x))) {
      // Array-of-arrays with a header row.
      const [head, ...rest] = doc as unknown[][];
      if (head.every((h) => typeof h === "string")) {
        return rest.map((r) => Object.fromEntries((head as string[]).map((h, i) => [h, r[i]])));
      }
    }
    return undefined;
  }
  if (!doc || typeof doc !== "object" || depth > 4) return undefined;
  const obj = doc as Record<string, unknown>;
  // GeoJSON FeatureCollection.
  if (obj.type === "FeatureCollection" && Array.isArray(obj.features)) {
    return (obj.features as Array<{ properties?: Row; geometry?: { type?: string; coordinates?: unknown } }>).map(
      (f) => ({ ...(f.properties ?? {}), ...(f.geometry ? { _geometry: summarizeGeometry(f.geometry) } : {}) }),
    );
  }
  // Prefer well-known container keys, then the largest array anywhere.
  for (const k of ["results", "records", "data", "items", "rows", "features", "values", "entries", "result"]) {
    const r = extractRecords(obj[k], depth + 1);
    if (r?.length) return r;
  }
  let best: Row[] | undefined;
  for (const v of Object.values(obj)) {
    const r = extractRecords(v, depth + 1);
    if (r && (!best || r.length > best.length)) best = r;
  }
  return best;
}

/** Compact geometry: points keep coordinates, others keep type + a centroid-ish sample. */
export function summarizeGeometry(g: { type?: string; coordinates?: unknown }): unknown {
  if (g.type === "Point") return { type: "Point", coordinates: g.coordinates };
  const first = firstCoordinate(g.coordinates);
  return first ? { type: g.type, first_coordinate: first } : { type: g.type };
}

function firstCoordinate(c: unknown): unknown {
  let cur = c;
  while (Array.isArray(cur) && Array.isArray(cur[0])) cur = cur[0];
  return Array.isArray(cur) ? cur : undefined;
}

/** Parse a resource body based on declared format / content type / sniffing. */
export function parseResource(body: string, hint: { format?: string; contentType?: string; maxRows?: number } = {}): Table {
  const fmt = (hint.format ?? "").toLowerCase();
  const ct = (hint.contentType ?? "").toLowerCase();
  const trimmed = body.trimStart();
  const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  let maxRows = hint.maxRows ?? 50_000;
  if (fmt.includes("json") || ct.includes("json") || (looksJson && !fmt.includes("csv"))) {
    let doc: unknown;
    try {
      doc = JSON.parse(body);
    } catch {
      throw new Error("Resource claims to be JSON but does not parse.");
    }
    const recs = extractRecords(doc);
    if (!recs) throw new Error("No tabular records found in the JSON document.");
    const width = Math.max(1, Object.keys(recs[0] ?? {}).length);
    if (width > MAX_COLUMNS) throw new Error(`Records have ${width} fields; the limit is ${MAX_COLUMNS}.`);
    maxRows = Math.min(maxRows, Math.floor(MAX_CELLS / width));
    const rows = recs.slice(0, maxRows).map(flattenRow);
    const isGeo = !!doc && typeof doc === "object" && (doc as { type?: string }).type === "FeatureCollection";
    return {
      columns: columnsOf(rows),
      rows,
      format: isGeo ? "geojson" : "json",
      ...(recs.length > maxRows ? { notes: [`truncated to first ${maxRows} rows`] } : {}),
    };
  }
  if (trimmed.startsWith("<")) {
    throw new Error("Resource is HTML/XML, not a tabular file — it is probably a landing page. Pick a CSV/JSON resource.");
  }
  return parseCsv(body, { maxRows });
}

/** Flatten one level of nested objects into dotted keys (a.b). */
export function flattenRow(r: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) {
    if (v && typeof v === "object" && !Array.isArray(v) && k !== "_geometry") {
      for (const [k2, v2] of Object.entries(v as Row)) out[`${k}.${k2}`] = v2;
    } else out[k] = v;
  }
  return out;
}

export function columnsOf(rows: Row[]): string[] {
  const cols = new Set<string>();
  for (const r of rows.slice(0, 200)) {
    for (const k of Object.keys(r)) {
      cols.add(k);
      if (cols.size >= MAX_COLUMNS) return [...cols];
    }
  }
  return [...cols];
}

export interface RowQuery {
  /** Case-insensitive substring match across all fields. */
  search?: string;
  /** column → value. Exact (case-insensitive) match; prefix with '~' for substring, '>'/'<' for numeric compare. */
  where?: Record<string, string>;
  /** Columns to keep (default all). */
  columns?: string[];
  /** Sort column; prefix '-' for descending. */
  sort?: string;
  offset?: number;
  limit?: number;
}

const normCol = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");
/** Normalised column names, computed once per column array (not per lookup). */
const normCache = new WeakMap<string[], string[]>();

/** Resolve a user-supplied column name to an actual column (case/accents-insensitive). */
export function resolveColumn(columns: string[], name: string): string | undefined {
  if (columns.includes(name)) return name;
  let norms = normCache.get(columns);
  if (!norms) {
    norms = columns.map(normCol);
    normCache.set(columns, norms);
  }
  const n = normCol(name.slice(0, 200));
  if (!n) return undefined;
  const exact = norms.indexOf(n);
  if (exact >= 0) return columns[exact];
  const partial = norms.findIndex((c) => c.includes(n));
  return partial >= 0 ? columns[partial] : undefined;
}

export function queryRows(table: Table, q: RowQuery): { total: number; rows: Row[]; unknown_columns: string[] } {
  const unknown: string[] = [];
  let rows = table.rows;
  if (q.search) {
    const s = q.search.toLowerCase();
    rows = rows.filter((r) => Object.values(r).some((v) => v !== null && String(v).toLowerCase().includes(s)));
  }
  for (const [rawCol, rawVal] of Object.entries(q.where ?? {})) {
    const col = resolveColumn(table.columns, rawCol);
    if (!col) {
      unknown.push(rawCol);
      continue;
    }
    const op = rawVal[0];
    if (op === "~") {
      const v = rawVal.slice(1).toLowerCase();
      rows = rows.filter((r) => String(r[col] ?? "").toLowerCase().includes(v));
    } else if ((op === ">" || op === "<") && !Number.isNaN(Number(rawVal.slice(1)))) {
      const v = Number(rawVal.slice(1));
      rows = rows.filter((r) => {
        const x = Number(r[col]);
        return !Number.isNaN(x) && r[col] !== null && (op === ">" ? x > v : x < v);
      });
    } else {
      const v = rawVal.toLowerCase();
      rows = rows.filter((r) => String(r[col] ?? "").toLowerCase() === v);
    }
  }
  if (q.sort) {
    const desc = q.sort.startsWith("-");
    const col = resolveColumn(table.columns, desc ? q.sort.slice(1) : q.sort);
    if (col) {
      rows = [...rows].sort((a, b) => {
        const x = a[col];
        const y = b[col];
        if (x === y) return 0;
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
        return desc ? -cmp : cmp;
      });
    } else unknown.push(q.sort);
  }
  const total = rows.length;
  const offset = q.offset ?? 0;
  let page = rows.slice(offset, offset + (q.limit ?? 50));
  if (q.columns?.length) {
    const cols = q.columns.map((c) => resolveColumn(table.columns, c) ?? (unknown.push(c), undefined)).filter(Boolean) as string[];
    if (cols.length) page = page.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
  }
  return { total, rows: page, unknown_columns: unknown };
}

/** Quick per-column profile: type, non-null count, sample distinct values. */
export function profileColumns(table: Table, sampleSize = 5): Array<{ column: string; type: string; non_null: number; examples: unknown[] }> {
  return table.columns.map((c) => {
    const vals = table.rows.map((r) => r[c]).filter((v) => v !== null && v !== undefined && v !== "");
    const types = new Set(vals.slice(0, 500).map((v) => typeof v));
    const distinct = [...new Set(vals.slice(0, 2000).map((v) => (typeof v === "object" ? JSON.stringify(v) : v)))];
    return {
      column: c,
      type: types.size === 1 ? [...types][0] : types.size ? "mixed" : "empty",
      non_null: vals.length,
      examples: distinct.slice(0, sampleSize),
    };
  });
}
