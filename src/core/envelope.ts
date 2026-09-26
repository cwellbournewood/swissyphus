/**
 * Standard Swissyphus response envelope (RFP §8).
 *
 * Every tool result carries: data, source (name/operator/url/licence/attribution),
 * retrieved_at, data_as_of, cache_status, language, links.
 * Responses are hard-capped at ~50 KB (RFP §5.1 response size discipline).
 *
 * JSON is emitted compact (no indentation): tool results are read by LLMs, and
 * pretty-printing costs roughly 20–30% more tokens for no benefit.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { EnvelopeMeta } from "./types.js";
import { SourceError } from "./http.js";

const SIZE_CAP = 50_000;

function humanDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(seconds / 3600);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(seconds / 86400)} days`;
}

/** Age of stale data in seconds, if the result is stale and the age is known. */
function staleAgeOf(meta: EnvelopeMeta): number | undefined {
  if (meta.cacheStatus !== "stale") return undefined;
  if (typeof meta.staleAgeSeconds === "number" && Number.isFinite(meta.staleAgeSeconds)) {
    return Math.max(0, Math.round(meta.staleAgeSeconds));
  }
  const t = Date.parse(meta.retrievedAt);
  return Number.isNaN(t) ? undefined : Math.max(0, Math.round((Date.now() - t) / 1000));
}

export function respond(data: unknown, meta: EnvelopeMeta): CallToolResult {
  const staleAge = staleAgeOf(meta);
  let notes = meta.notes;
  const ttl = meta.source.cacheTtlSeconds;
  if (staleAge !== undefined && typeof ttl === "number" && staleAge > ttl) {
    const staleNote =
      `Served from cache: this data was retrieved ${humanDuration(staleAge)} ago, older than the source's ` +
      `${humanDuration(ttl)} refresh interval, because the source is being refreshed or is currently unavailable.`;
    notes = notes ? `${notes} ${staleNote}` : staleNote;
  }

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
    ...(staleAge !== undefined ? { stale_age_seconds: staleAge } : {}),
    language: meta.language ?? "en",
    ...(meta.links ? { links: meta.links } : {}),
    ...(notes ? { notes } : {}),
  };

  let text = JSON.stringify(envelope);
  if (text.length > SIZE_CAP) {
    // Slicing the JSON string mid-structure would emit invalid JSON to the
    // caller. Instead return a valid envelope that keeps the attribution and
    // freshness metadata but replaces the oversized payload with a clear notice.
    text = JSON.stringify({
      data: {
        error: "Response exceeded the 50 KB cap and was withheld to stay parseable.",
        hint: "Narrow the query or lower the 'limit' parameter, then retry.",
      },
      source: envelope.source,
      retrieved_at: envelope.retrieved_at,
      data_as_of: envelope.data_as_of,
      cache_status: envelope.cache_status,
      language: envelope.language,
    });
  }
  return { content: [{ type: "text", text }] };
}

/**
 * Machine-readable error class, so the REST layer can map HTTP status codes
 * without regex-matching the message:
 *   - "invalid_input" → the caller's arguments are wrong (REST: 400/422)
 *   - "not_found"     → valid query, nothing matched (REST: 404)
 *   - "unavailable"   → the upstream source failed / timed out (REST: 503)
 * When omitted, the error body has no `kind` field (legacy/unclassified; the
 * REST layer should fall back to its own heuristics).
 */
export type ToolErrorKind = "invalid_input" | "not_found" | "unavailable";

export interface ToolErrorOptions {
  kind?: ToolErrorKind;
}

/** Structured, actionable tool error (RFP §5.1 error message requirements). */
export function toolError(message: string, suggestions: string[] = [], options: ToolErrorOptions = {}): CallToolResult {
  const body = {
    error: message,
    ...(options.kind ? { kind: options.kind } : {}),
    ...(suggestions.length ? { suggestions } : {}),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    isError: true,
  };
}

function isTimeoutLike(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/** Convert a thrown error into a graceful "source unavailable" tool result. */
export function errorToResult(err: unknown, sourceName: string): CallToolResult {
  if (err instanceof SourceError || isTimeoutLike(err)) {
    const message = err instanceof SourceError ? err.message : `the request timed out (${(err as Error).message})`;
    return toolError(
      `${sourceName} is currently unavailable: ${message}`,
      [
        "The upstream source may be down or rate-limiting; try again in a minute.",
        "Run check_source_health to see the live status of all Swissyphus sources.",
      ],
      { kind: "unavailable" },
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  // Most often upstream shape drift (a TypeError on an unexpected payload), so
  // classify as unavailable; the REST layer replaces the raw message.
  return toolError(
    `Unexpected error while querying ${sourceName}: ${message}`,
    ["If the problem persists, the source may have changed its response format."],
    { kind: "unavailable" },
  );
}
