/**
 * Core shared types for Swissyphus.
 *
 * Every connector ships a machine-readable SourceManifest (RFP §4.4) and every
 * tool response is wrapped in the standard envelope (RFP §8) carrying source
 * attribution, licence, freshness and cache metadata.
 */

export interface SourceManifest {
  /** Stable identifier, e.g. "zefix" */
  id: string;
  /** Human name of the source, e.g. "ZEFIX — Central Business Name Index" */
  name: string;
  /** Operating body, e.g. "Federal Office of Justice (FOJ)" */
  operator: string;
  /** Canonical URL of the source */
  url: string;
  /** Licence / terms, e.g. "Swiss OGD terms — free use with attribution" */
  licence: string;
  /** Attribution string to surface alongside the data */
  attribution: string;
  /** Human description of how often the source updates */
  updateFrequency: string;
  /** Cache TTL applied by Swissyphus, in seconds */
  cacheTtlSeconds: number;
  /**
   * Longest Swissyphus will serve cached data from this source when the source
   * is failing (stale-if-error), in seconds. Default: 24 × cacheTtlSeconds.
   * Set it from how fast the data goes out of date, not from the TTL: minutes
   * for live departures, months for annual statistics.
   */
  maxStaleSeconds?: number;
  /** Known caveats, fallback notes, fair-use constraints */
  notes?: string;
}

export type CacheStatus = "hit" | "miss" | "stale" | "computed";

export interface FetchResult<T> {
  data: T;
  cacheStatus: CacheStatus;
  retrievedAt: string;
  /** Seconds since the cached body was retrieved; set only when cacheStatus is "stale". */
  staleAgeSeconds?: number;
}

export interface EnvelopeMeta {
  source: SourceManifest;
  cacheStatus: CacheStatus;
  retrievedAt: string;
  /** Source-side freshness (when the data itself is from), if known */
  dataAsOf?: string;
  language?: string;
  links?: Record<string, string>;
  notes?: string;
  /**
   * Age of stale data in seconds (from FetchResult.staleAgeSeconds). Optional:
   * when omitted and cacheStatus is "stale", respond() derives it from retrievedAt.
   */
  staleAgeSeconds?: number;
}

export interface HealthProbe {
  sourceId: string;
  url: string;
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
}
