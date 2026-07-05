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

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/<[^>]*>/g, "")
    .trim();
}

interface NewsItem {
  title: string;
  link: string;
  published: string;
  summary: string;
}

function parseRss(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1] ?? "";
    const pick = (t: string) => {
      const mm = block.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`));
      return mm?.[1] ? decodeEntities(mm[1]) : "";
    };
    items.push({
      title: pick("title"),
      link: pick("link"),
      published: pick("pubDate"),
      summary: pick("description").slice(0, 300),
    });
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
        "Latest Swiss news headlines from SRF with links and publication times. Optionally filter by keyword. Returns metadata + links only (the full article stays at the source, per licence).",
      inputSchema: {
        keyword: z.string().optional().describe("Filter headlines by keyword (title or summary)"),
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
            items = items.filter(
              (i) => i.title.toLowerCase().includes(q) || i.summary.toLowerCase().includes(q),
            );
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
