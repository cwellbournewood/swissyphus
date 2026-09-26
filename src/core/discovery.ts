/**
 * Cross-catalogue discovery contract.
 *
 * Every catalogue adapter (opendata.swiss, geo.admin.ch layers, BFS STAT-TAB,
 * LINDAS cubes, Opendatasoft portals, …) registers a DataSearcher. The meta
 * tool `find_data` fans a query out to all of them in parallel and returns one
 * ranked list of hits, each telling the agent exactly which tool + arguments
 * fetch the actual data. This is what keeps thousands of datasets reachable
 * through a handful of tools (context windows are money).
 */

export interface DataHit {
  /** Catalogue this hit comes from, e.g. "opendata.swiss", "geo.admin.ch". */
  catalogue: string;
  /** Stable identifier within that catalogue (dataset slug, layer id, table id, cube IRI…). */
  id: string;
  title: string;
  description?: string;
  publisher?: string;
  /** Human-facing landing page. */
  url?: string;
  /** The tool that retrieves the data, plus ready-to-use arguments. */
  next: { tool: string; args: Record<string, unknown> };
}

export interface DataSearcher {
  catalogue: string;
  /** Module id providing the searcher (only active modules are searched). */
  module: string;
  search: (query: string, limit: number, lang: string) => Promise<DataHit[]>;
}

const searchers: DataSearcher[] = [];

/** Called by catalogue modules at load time. */
export function registerSearcher(s: DataSearcher): void {
  if (!searchers.some((x) => x.catalogue === s.catalogue)) searchers.push(s);
}

export function getSearchers(): DataSearcher[] {
  return [...searchers];
}

/** Interleave per-catalogue result lists so no single catalogue floods the top. */
export function interleave<T>(lists: T[][], limit: number): T[] {
  const out: T[] = [];
  for (let i = 0; out.length < limit; i++) {
    let any = false;
    for (const l of lists) {
      if (i < l.length) {
        out.push(l[i]);
        any = true;
        if (out.length >= limit) break;
      }
    }
    if (!any) break;
  }
  return out;
}
