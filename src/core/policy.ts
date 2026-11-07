/**
 * Deployment policy switches that differ between a local stdio server (the
 * user's own machine — trusted caller) and a public HTTP deployment (every
 * argument is attacker-controlled).
 */

let arbitraryUrls = true;

/**
 * Whether tools may fetch caller-supplied URLs (e.g. `resource_url` on
 * query_dataset). On by default for local use; the HTTP server turns it off
 * unless SWISSYPHUS_ALLOW_RESOURCE_URL=1, so a public deployment cannot be used
 * as an open fetch proxy. Catalogue-derived URLs (by dataset id) always work.
 */
export function allowArbitraryUrls(): boolean {
  return arbitraryUrls;
}

export function setAllowArbitraryUrls(v: boolean): void {
  arbitraryUrls = v;
}
