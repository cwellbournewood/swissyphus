/**
 * News module — SRF news headlines via the public RSS feed.
 * Licence-aware: returns headline metadata and links only, never full text
 * (RFP §4.4: respect terms of use; no full-text redistribution).
 */

import { z } from "zod";
import { fetchTextCached } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

const source: SourceManifest = {
  id: "srf-rss",
  name: "SRF News (RSS headlines)",
  operator: "Swiss Radio and Television SRF (SRG SSR)",
  url: "https://www.srf.ch/news",
  licence: "Editorial content © SRF — headlines/links only, no full-text redistribution",
  attribution: "News headlines © SRF",
  updateFrequency: "continuous",
  cacheTtlSeconds: 300,
};

const FEED = "https://www.srf.ch/news/bnf/rss/1646";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

/**
 * Decode XML/HTML character references in ONE pass (so "&amp;lt;" becomes
 * the literal text "&lt;", never "<"). Handles decimal and hex numeric
 * references; unknown entities are left untouched.
 */
export function decodeEntities(s: string): string {
  return s.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, ent: string) => {
    if (ent[0] === "#") {
      const cp = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(cp);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[ent] ?? whole;
  });
}

/**
 * Turn an RSS element body into plain text: unwrap CDATA, strip markup, then
 * decode entities once. Stripping BEFORE decoding means escaped text such as
 * "&lt;b&gt;" survives as literal "<b>" instead of being eaten as a tag.
 */
export function rssText(raw: string): string {
  const unwrapped = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const stripped = unwrapped.replace(/<[^>]*>/g, "");
  return decodeEntities(stripped).replace(/\s+/g, " ").trim();
}

/**
 * Headline metadata only: title, link, publication date. The RSS
 * <description> summary is deliberately NOT parsed or returned — SRF content
 * terms allow headlines/links, not republication of teaser text.
 */
export interface NewsItem {
  title: string;
  link: string;
  published: string;
}

export function parseRss(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRe = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1] ?? "";
    const pick = (t: string) => {
      const mm = block.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`));
      return mm?.[1] ? rssText(mm[1]) : "";
    };
    const title = pick("title");
    if (!title) continue;
    items.push({ title, link: pick("link"), published: pick("pubDate") });
  }
  return items;
}

export const newsModule: SwissyphusModule = {
  id: "news",
  emoji: "📰",
  title: "Swiss news (SRF)",
  description: "Latest Swiss headlines with links (metadata only, licence-aware)",
  sources: [source],
  healthProbes: [{ sourceId: "srf-rss", url: FEED }],
  tools: [
    tool({
      name: "get_swiss_news",
      title: "Latest Swiss news headlines",
      description:
        "Latest Swiss news headlines from SRF with links and publication times. Optionally filter by keyword. Returns titles, links and dates only — no summaries or article text (these stay at the source, per licence).",
      inputSchema: {
        keyword: z.string().optional().describe("Filter headlines by keyword (matched against the headline)"),
        limit: z.number().int().min(1).max(30).default(10),
      },
      handler: async ({ keyword, limit }) => {
        try {
          const { data, cacheStatus, retrievedAt } = await fetchTextCached(FEED, {
            ttlMs: source.cacheTtlSeconds * 1000,
          });
          let items = parseRss(data);
          if (keyword) {
            const q = keyword.toLowerCase();
            items = items.filter((i) => i.title.toLowerCase().includes(q));
          }
          if (!items.length) {
            return toolError(
              keyword ? `No current headlines match '${keyword}'.` : "The news feed returned no items.",
              ["Headlines rotate quickly; try a broader keyword."],
            );
          }
          return respond(
            { headlines: items.slice(0, limit) },
            { source, cacheStatus, retrievedAt, language: "de" },
          );
        } catch (err) {
          return errorToResult(err, "SRF news feed");
        }
      },
    }),
  ],
};
