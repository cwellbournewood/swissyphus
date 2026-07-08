/**
 * Standard Swissyphus response envelope (RFP §8).
 *
 * Every tool result carries: data, source (name/operator/url/licence/attribution),
 * retrieved_at, data_as_of, cache_status, language, links.
 * Responses are hard-capped at ~50 KB (RFP §5.1 response size discipline).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { EnvelopeMeta } from "./types.js";
import { SourceError } from "./http.js";

const SIZE_CAP = 50_000;

export function respond(data: unknown, meta: EnvelopeMeta): CallToolResult {
  const envelope = {
    data,
    source: {
      name: meta.source.name,
      operator: meta.source.operator,
      url: meta.source.url,
      licence: meta.source.licence,
      attribution: meta.source.attribution,
    },
    retrieved_at: meta.retrievedAt,
    data_as_of: meta.dataAsOf ?? meta.retrievedAt,
    cache_status: meta.cacheStatus,
    language: meta.language ?? "en",
    ...(meta.links ? { links: meta.links } : {}),
    ...(meta.notes ? { notes: meta.notes } : {}),
  };

  let text = JSON.stringify(envelope, null, 2);
  if (text.length > SIZE_CAP) {
    text = JSON.stringify(envelope);
  }
  if (text.length > SIZE_CAP) {
    // Slicing the JSON string mid-structure would emit invalid JSON to the
    // caller. Instead return a valid envelope that keeps the attribution and
    // freshness metadata but replaces the oversized payload with a clear notice.
    text = JSON.stringify(
      {
        data: {
          error: "Response exceeded the 50 KB cap and was withheld to stay parseable.",
          hint: "Narrow the query or lower the 'limit' parameter, then retry.",
        },
        source: envelope.source,
        retrieved_at: envelope.retrieved_at,
        data_as_of: envelope.data_as_of,
        cache_status: envelope.cache_status,
        language: envelope.language,
      },
      null,
      2,
    );
  }
  return { content: [{ type: "text", text }] };
}

/** Structured, actionable tool error (RFP §5.1 error message requirements). */
export function toolError(message: string, suggestions: string[] = []): CallToolResult {
  const body = {
    error: message,
    ...(suggestions.length ? { suggestions } : {}),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    isError: true,
  };
}

/** Convert a thrown error into a graceful "source unavailable" tool result. */
export function errorToResult(err: unknown, sourceName: string): CallToolResult {
  if (err instanceof SourceError) {
    return toolError(`${sourceName} is currently unavailable: ${err.message}`, [
      "The upstream source may be down or rate-limiting; try again in a minute.",
      "Run check_source_health to see the live status of all Swissyphus sources.",
    ]);
  }
  const message = err instanceof Error ? err.message : String(err);
  return toolError(`Unexpected error while querying ${sourceName}: ${message}`, [
    "If the problem persists, the source may have changed its response format.",
  ]);
}
