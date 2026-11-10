/**
 * LINDAS module: the Swiss federal Linked Data Service. A power tool for
 * agents: run read-only SPARQL against the cross-government knowledge graph
 * (companies, energy, statistics, registers, cultural heritage, …).
 */

import { z } from "zod";
import { fetchJson, sourceCache } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

const source: SourceManifest = {
  id: "lindas",
  name: "LINDAS: Swiss federal Linked Data Service",
  operator: "Federal Archives / Federal Chancellery",
  url: "https://lindas.admin.ch",
  licence: "Swiss OGD: datasets carry their own licences; attribution required",
  attribution: "© Swiss Confederation, LINDAS",
  updateFrequency: "continuous (per dataset)",
  cacheTtlSeconds: 3600,
};

interface SparqlResponse {
  head?: { vars?: string[] };
  results?: { bindings?: Array<Record<string, { type?: string; value?: string }>> };
}

export const MAX_QUERY_LENGTH = 10_000;
/** Row ceiling: keeps typical responses under the 50 KB envelope cap. */
export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 100;
/** Individual values longer than this are truncated in the response. */
const MAX_VALUE_CHARS = 1_000;

/** SPARQL 1.1 Update operations (and WITH, which only exists in Update). */
const UPDATE_KEYWORDS = new Set(["INSERT", "DELETE", "LOAD", "CLEAR", "CREATE", "DROP", "COPY", "MOVE", "ADD", "WITH"]);

/**
 * Replace the contents of string literals, IRIs and comments with spaces
 * (keeping delimiters and total length), so keyword/brace scanning only sees
 * SPARQL syntax. Offsets in the masked string equal offsets in the original.
 */
export function maskSparql(q: string): string {
  let out = "";
  let i = 0;
  const n = q.length;
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  while (i < n) {
    const c = q[i]!;
    if (c === '"' || c === "'") {
      const triple = q.startsWith(c.repeat(3), i);
      const delim = triple ? c.repeat(3) : c;
      let j = i + delim.length;
      while (j < n) {
        if (q[j] === "\\") {
          j += 2;
          continue;
        }
        if (q.startsWith(delim, j)) break;
        if (!triple && (q[j] === "\n" || q[j] === "\r")) break; // unterminated single-line literal
        j++;
      }
      const end = Math.min(n, j + delim.length);
      out += delim + blank(q.slice(i + delim.length, Math.min(j, n))) + (j < n ? delim : "");
      i = end;
      continue;
    }
    if (c === "<") {
      // IRIREF: no whitespace or <>"{}|^`\ inside. Otherwise it's the less-than operator.
      const m = /^<[^<>"{}|^`\\\x00-\x20]*>/.exec(q.slice(i, i + 4096));
      if (m) {
        out += "<" + blank(m[0].slice(1, -1)) + ">";
        i += m[0].length;
        continue;
      }
    }
    if (c === "#") {
      let j = i;
      while (j < n && q[j] !== "\n") j++;
      out += blank(q.slice(i, j));
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Bare keywords in masked SPARQL: drops variables (?x/$x) and prefixed names (ex:add, add:x). */
function bareWords(masked: string): Array<{ word: string; index: number; depth: number }> {
  const words: Array<{ word: string; index: number; depth: number }> = [];
  let depth = 0;
  const re = /[{}]|[?$][\p{L}\p{N}_]+|[\p{L}\p{N}_][\p{L}\p{N}_.\-]*:[\p{L}\p{N}_.\-%\\]*|:[\p{L}\p{N}_.\-%\\]+|[\p{L}_][\p{L}\p{N}_]*/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const t = m[0];
    if (t === "{") depth++;
    else if (t === "}") depth = Math.max(0, depth - 1);
    else if (t[0] === "?" || t[0] === "$" || t.includes(":")) continue;
    else words.push({ word: t.toUpperCase(), index: m.index, depth });
  }
  return words;
}

export type GuardResult = { ok: true; query: string; limit: number } | { ok: false; error: string; hint?: string };

/**
 * Validate a user SPARQL query and enforce the result ceiling.
 *
 * - Must be a SELECT query (optional PREFIX/BASE prologue first).
 * - Rejects SPARQL Update operations and SERVICE (federation would make
 *   Swissyphus an open relay to arbitrary endpoints). Detection ignores
 *   string literals, IRIs, comments, variables and prefixed names, so a
 *   literal like "add" or a variable ?with doesn't trigger a false positive.
 * - LIMIT: only a top-level LIMIT (brace depth 0) counts; a subquery LIMIT
 *   does not bound the outer result. Missing → inject DEFAULT_LIMIT (before a
 *   trailing top-level VALUES block, if any); too large → clamp to MAX_LIMIT.
 */
export function guardSparql(query: string): GuardResult {
  if (query.length > MAX_QUERY_LENGTH) {
    return { ok: false, error: `Query is ${query.length} characters; the maximum is ${MAX_QUERY_LENGTH}.` };
  }
  const masked = maskSparql(query);
  const words = bareWords(masked);
  const selectHint = "Start the query with optional PREFIX declarations followed by SELECT.";

  // Query form: the first bare keyword after the PREFIX/BASE prologue must be SELECT.
  const firstForm = words.find((w) => w.word !== "PREFIX" && w.word !== "BASE");
  if (!firstForm || firstForm.word !== "SELECT") {
    return { ok: false, error: "Only read-only SPARQL SELECT queries are allowed.", hint: selectHint };
  }
  for (const w of words) {
    if (UPDATE_KEYWORDS.has(w.word)) {
      return {
        ok: false,
        error: `Only read-only SPARQL SELECT queries are allowed ('${w.word}' is a SPARQL Update keyword).`,
        hint: selectHint,
      };
    }
    if (w.word === "SERVICE") {
      return {
        ok: false,
        error: "SERVICE (federated queries to other endpoints) is not allowed.",
        hint: "Query LINDAS data only; run separate queries against other sources.",
      };
    }
  }
  const topLimits: Array<{ index: number; value: number; numStart: number; numEnd: number }> = [];
  for (const w of words) {
    if (w.word !== "LIMIT" || w.depth !== 0) continue;
    const m = /^LIMIT\s+(\d+)/i.exec(masked.slice(w.index));
    if (!m || m[1] === undefined) {
      return { ok: false, error: "LIMIT must be followed by a non-negative integer." };
    }
    const numStart = w.index + m[0].length - m[1].length;
    topLimits.push({ index: w.index, value: Number(m[1]), numStart, numEnd: w.index + m[0].length });
  }

  if (!topLimits.length) {
    // A VALUES keyword at brace depth 0 can only be the trailing inline-data
    // block, which must come after the solution modifiers, insert before it.
    const trailingValues = words.find((w) => w.word === "VALUES" && w.depth === 0);
    const at = trailingValues ? trailingValues.index : query.length;
    const q = `${query.slice(0, at).replace(/\s*$/, "")}\nLIMIT ${DEFAULT_LIMIT}\n${query.slice(at)}`.replace(/\n$/, "");
    return { ok: true, query: q, limit: DEFAULT_LIMIT };
  }
  let q = query;
  const effective = Math.min(MAX_LIMIT, ...topLimits.map((l) => l.value));
  // Replace from the end so earlier offsets stay valid.
  for (const l of [...topLimits].sort((a, b) => b.index - a.index)) {
    if (l.value > MAX_LIMIT) {
      q = q.slice(0, l.numStart) + String(MAX_LIMIT) + q.slice(l.numEnd);
    }
  }
  return { ok: true, query: q, limit: effective };
}

function truncate(v: string | undefined): string | undefined {
  if (v === undefined || v.length <= MAX_VALUE_CHARS) return v;
  return `${v.slice(0, MAX_VALUE_CHARS)}… [truncated ${v.length - MAX_VALUE_CHARS} chars]`;
}

export const lindasModule: SwissyphusModule = {
  id: "lindas",
  emoji: "🕸️",
  title: "Linked data (LINDAS)",
  description: "Run read-only SPARQL on the Swiss federal knowledge graph, enrichment power tool",
  sources: [source],
  healthProbes: [
    {
      sourceId: "lindas",
      url: `https://lindas.admin.ch/query?query=${encodeURIComponent("SELECT ?s WHERE {?s ?p ?o} LIMIT 1")}`,
      headers: { Accept: "application/sparql-results+json" },
    },
  ],
  tools: [
    tool({
      name: "query_lindas",
      title: "SPARQL query on LINDAS",
      description: `Run a read-only SPARQL SELECT query against lindas.admin.ch, the Swiss federal linked-data service. Useful graphs include <https://lindas.admin.ch/elcom/electricityprice> (energy prices), ELI legislation, the municipality register (ld.admin.ch/municipality/{BFS}), and cube.link statistical cubes. A top-level LIMIT of ${DEFAULT_LIMIT} is added if none is given and larger limits are clamped to ${MAX_LIMIT}; SERVICE (federation) and update operations are rejected; max ${MAX_QUERY_LENGTH} characters.`,
      inputSchema: {
        query: z.string().min(10).max(MAX_QUERY_LENGTH).describe("SPARQL SELECT query (read-only)"),
      },
      handler: async ({ query }) => {
        const guard = guardSparql(query);
        if (!guard.ok) return toolError(guard.error, guard.hint ? [guard.hint] : []);
        try {
          const { data, cacheStatus, retrievedAt } = await fetchJson<SparqlResponse>(
            "https://lindas.admin.ch/query",
            {
              ...sourceCache(source),
              timeoutMs: 45_000,
              init: {
                method: "POST",
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded",
                  Accept: "application/sparql-results+json",
                },
                body: `query=${encodeURIComponent(guard.query)}`,
              },
            },
          );
          const vars = data.head?.vars ?? [];
          const rows = (data.results?.bindings ?? [])
            .slice(0, guard.limit)
            .map((b) => Object.fromEntries(vars.map((v) => [v, truncate(b[v]?.value)])));
          return respond(
            { variables: vars, row_count: rows.length, row_limit: guard.limit, rows },
            { source, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "LINDAS SPARQL endpoint");
        }
      },
    }),
  ],
};
