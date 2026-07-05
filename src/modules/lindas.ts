/**
 * LINDAS module — the Swiss federal Linked Data Service. A power tool for
 * agents: run read-only SPARQL against the cross-government knowledge graph
 * (companies, energy, statistics, registers, cultural heritage, …).
 */

import { z } from "zod";
import { fetchJson } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

const source: SourceManifest = {
  id: "lindas",
  name: "LINDAS — Swiss federal Linked Data Service",
  operator: "Federal Archives / Federal Chancellery",
  url: "https://lindas.admin.ch",
  licence: "Swiss OGD — datasets carry their own licences; attribution required",
  attribution: "© Swiss Confederation, LINDAS",
  updateFrequency: "continuous (per dataset)",
  cacheTtlSeconds: 3600,
};

interface SparqlResponse {
  head?: { vars?: string[] };
  results?: { bindings?: Array<Record<string, { type?: string; value?: string }>> };
}

const FORBIDDEN = /\b(INSERT|DELETE|DROP|CLEAR|CREATE|LOAD|MOVE|COPY|ADD|WITH)\b/i;

export const lindasModule: SwissyphusModule = {
  id: "lindas",
  emoji: "🕸️",
  title: "Linked data (LINDAS)",
  description: "Run read-only SPARQL on the Swiss federal knowledge graph — enrichment power tool",
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
      description:
        "Run a read-only SPARQL SELECT query against lindas.admin.ch, the Swiss federal linked-data service. Useful graphs include <https://lindas.admin.ch/elcom/electricityprice> (energy prices), ELI legislation, the municipality register (ld.admin.ch/municipality/{BFS}), and cube.link statistical cubes. A LIMIT of 100 is enforced if none is given.",
      inputSchema: {
        query: z.string().min(10).describe("SPARQL SELECT query (read-only)"),
      },
      handler: async ({ query }) => {
        try {
          if (!/SELECT/i.test(query) || FORBIDDEN.test(query)) {
            return toolError("Only read-only SPARQL SELECT queries are allowed.", [
              "Start the query with optional PREFIX declarations followed by SELECT.",
            ]);
          }
          const q = /\bLIMIT\s+\d+/i.test(query) ? query : `${query}\nLIMIT 100`;
          const { data, cacheStatus, retrievedAt } = await fetchJson<SparqlResponse>(
            "https://lindas.admin.ch/query",
            {
              ttlMs: source.cacheTtlSeconds * 1000,
              timeoutMs: 45_000,
              init: {
                method: "POST",
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded",
                  Accept: "application/sparql-results+json",
                },
                body: `query=${encodeURIComponent(q)}`,
              },
            },
          );
          const vars = data.head?.vars ?? [];
          const rows = (data.results?.bindings ?? []).map((b) =>
            Object.fromEntries(vars.map((v) => [v, b[v]?.value])),
          );
          return respond(
            { variables: vars, row_count: rows.length, rows },
            { source, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "LINDAS SPARQL endpoint");
        }
      },
    }),
  ],
};
