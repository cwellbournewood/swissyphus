/**
 * Voting module — official federal popular-vote results (BFS real-time
 * vote-day open data, national coverage), discovered via opendata.swiss.
 */

import { z } from "zod";
import { fetchJson, withParams } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

const source: SourceManifest = {
  id: "bfs-votes",
  name: "Federal popular vote results (BFS vote-day open data)",
  operator: "Federal Statistical Office (BFS)",
  url: "https://opendata.swiss/en/dataset/echtzeitdaten-am-abstimmungstag-zu-eidgenoessischen-abstimmungsvorlagen",
  licence: "Swiss OGD — free use with attribution",
  attribution: "© BFS, vote-day open data",
  updateFrequency: "real-time on vote days; final results thereafter",
  cacheTtlSeconds: 3600,
};

const PACKAGE_URL =
  "https://ckan.opendata.swiss/api/3/action/package_show?id=echtzeitdaten-am-abstimmungstag-zu-eidgenoessischen-abstimmungsvorlagen";

interface LangText {
  langKey?: string;
  text?: string;
}

interface VoteResult {
  gebietAusgezaehlt?: boolean;
  jaStimmenInProzent?: number;
  jaStimmenAbsolut?: number;
  neinStimmenAbsolut?: number;
  stimmbeteiligungInProzent?: number;
  anzahlSbE?: number;
  eingelegteStimmzettel?: number;
}

interface Vorlage {
  vorlagenId?: number;
  vorlagenTitel?: LangText[];
  vorlageAngenommen?: boolean;
  vorlageBeendet?: boolean;
  resultat?: VoteResult;
  staende?: { jaStaendeGanz?: number; neinStaendeGanz?: number };
  kantone?: Array<{
    geoLevelname?: string;
    resultat?: VoteResult;
    vorlageAngenommen?: boolean;
  }>;
}

interface VoteDay {
  abstimmtag?: string;
  timestamp?: string;
  schweiz?: { vorlagen?: Vorlage[] };
}

async function listVoteDayUrls(): Promise<Array<{ date: string; url: string }>> {
  const { data } = await fetchJson<{
    result?: { resources?: Array<{ download_url?: string; url?: string }> };
  }>(PACKAGE_URL, { ttlMs: 12 * 3600 * 1000 });
  const out: Array<{ date: string; url: string }> = [];
  for (const r of data.result?.resources ?? []) {
    const u = (r.download_url ?? r.url ?? "").trim();
    const m = u.match(/sd-t-17-02-(\d{8})-eidgAbstimmung\.json$/);
    if (m && m[1]) {
      out.push({ date: `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`, url: u });
    }
  }
  out.sort((a, b) => b.date.localeCompare(a.date));
  return out;
}

function titleOf(v: Vorlage, lang: string): string | undefined {
  return (
    v.vorlagenTitel?.find((t) => t.langKey === lang)?.text ??
    v.vorlagenTitel?.find((t) => t.langKey === "de")?.text ??
    v.vorlagenTitel?.[0]?.text
  );
}

function mapResult(r: VoteResult | undefined) {
  if (!r) return undefined;
  return {
    counted_complete: r.gebietAusgezaehlt,
    yes_percent: r.jaStimmenInProzent !== undefined ? Math.round(r.jaStimmenInProzent * 100) / 100 : undefined,
    yes_votes: r.jaStimmenAbsolut,
    no_votes: r.neinStimmenAbsolut,
    turnout_percent:
      r.stimmbeteiligungInProzent !== undefined ? Math.round(r.stimmbeteiligungInProzent * 100) / 100 : undefined,
  };
}

export const votingModule: SwissyphusModule = {
  id: "voting",
  emoji: "🗳️",
  title: "Federal votes (BFS)",
  description: "Official national popular-vote results with per-canton breakdown — all recent vote days",
  sources: [source],
  healthProbes: [{ sourceId: "bfs-votes", url: PACKAGE_URL }],
  tools: [
    tool({
      name: "list_vote_dates",
      title: "List federal vote days",
      description: "List available federal popular-vote days with official result data (newest first).",
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(15),
      },
      handler: async ({ limit }) => {
        try {
          const days = await listVoteDayUrls();
          if (!days.length) return toolError("No vote-day datasets found.");
          return respond(
            { vote_days: days.slice(0, limit).map((d) => d.date) },
            { source, cacheStatus: "miss", retrievedAt: new Date().toISOString() },
          );
        } catch (err) {
          return errorToResult(err, "BFS vote-day data");
        }
      },
    }),

    tool({
      name: "get_voting_results",
      title: "Federal vote results",
      description:
        "Official results of federal popular votes for a vote day (default: most recent): national yes-share, turnout, accepted/rejected, cantonal majority, and optional per-canton breakdown.",
      inputSchema: {
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Vote day YYYY-MM-DD (see list_vote_dates); default: most recent"),
        language: z.enum(["de", "fr", "it", "rm", "en"]).default("en").describe("Language for proposal titles"),
        include_cantons: z.boolean().default(false).describe("Include per-canton results"),
      },
      handler: async ({ date, language, include_cantons }) => {
        try {
          const days = await listVoteDayUrls();
          const day = date ? days.find((d) => d.date === date) : days[0];
          if (!day) {
            return toolError(`No vote data for ${date}.`, [
              `Available days: ${days.slice(0, 8).map((d) => d.date).join(", ")}`,
            ]);
          }
          const { data, cacheStatus, retrievedAt } = await fetchJson<VoteDay>(day.url, {
            ttlMs: source.cacheTtlSeconds * 1000,
          });
          const proposals = (data.schweiz?.vorlagen ?? []).map((v) => ({
            id: v.vorlagenId,
            title: titleOf(v, language),
            accepted: v.vorlageAngenommen,
            final: v.vorlageBeendet,
            national: mapResult(v.resultat),
            cantonal_majority: v.staende
              ? { yes_cantons: v.staende.jaStaendeGanz, no_cantons: v.staende.neinStaendeGanz }
              : undefined,
            ...(include_cantons
              ? {
                  cantons: (v.kantone ?? []).map((k) => ({
                    canton: k.geoLevelname,
                    accepted: k.vorlageAngenommen,
                    ...mapResult(k.resultat),
                  })),
                }
              : {}),
          }));
          return respond(
            { vote_day: day.date, proposals },
            { source, cacheStatus, retrievedAt, dataAsOf: data.timestamp, language },
          );
        } catch (err) {
          return errorToResult(err, "BFS vote-day data");
        }
      },
    }),
  ],
};
