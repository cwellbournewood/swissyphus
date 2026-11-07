/**
 * Voting module — official federal popular-vote results (BFS real-time
 * vote-day open data, national coverage), discovered via opendata.swiss.
 */

import { z } from "zod";
import { fetchJson, withParams } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { CacheStatus, SourceManifest } from "../core/types.js";
import { resolveCanton } from "./_cantons.js";

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
  staende?: StaendeRaw;
  kantone?: Array<{
    geoLevelnummer?: string;
    geoLevelname?: string;
    resultat?: VoteResult;
    vorlageAngenommen?: boolean;
    bezirke?: GeoUnit[];
    gemeinden?: GeoUnit[];
  }>;
}

interface GeoUnit {
  geoLevelnummer?: string;
  geoLevelname?: string;
  geoLevelParentnummer?: string;
  resultat?: VoteResult;
}

interface VoteDay {
  abstimmtag?: string;
  timestamp?: string;
  schweiz?: { vorlagen?: Vorlage[] };
}

/**
 * Raw cantonal-majority block of the BFS vote-day JSON. Full cantons count 1,
 * the six half-cantons (OW, NW, BS, BL, AR, AI) count ½ each — 23 votes in
 * total. The half-canton fields may be absent on older files or on votes
 * where no cantonal majority is required.
 */
export interface StaendeRaw {
  jaStaendeGanz?: number | null;
  neinStaendeGanz?: number | null;
  jaStaendeHalb?: number | null;
  neinStaendeHalb?: number | null;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * Cantonal majority including half-cantons. Returns undefined when the block
 * carries no counts at all. `half_cantons_reported` is false when the source
 * gives only whole-canton counts, so a caller never mistakes a partial tally
 * for the complete one.
 */
export function cantonalMajority(st: StaendeRaw | undefined) {
  if (!st) return undefined;
  const yesWhole = num(st.jaStaendeGanz);
  const noWhole = num(st.neinStaendeGanz);
  const yesHalf = num(st.jaStaendeHalb);
  const noHalf = num(st.neinStaendeHalb);
  if (yesWhole === undefined && noWhole === undefined && yesHalf === undefined && noHalf === undefined) {
    return undefined;
  }
  const halfReported = yesHalf !== undefined || noHalf !== undefined;
  const yes = (yesWhole ?? 0) + (yesHalf ?? 0) * 0.5;
  const no = (noWhole ?? 0) + (noHalf ?? 0) * 0.5;
  return {
    yes_cantons: yes,
    no_cantons: no,
    yes_whole_cantons: yesWhole,
    no_whole_cantons: noWhole,
    yes_half_cantons: yesHalf,
    no_half_cantons: noHalf,
    half_cantons_reported: halfReported,
    // 23 cantonal votes; a majority needs more than 11.5.
    // Without half-canton counts the result is only certain when one side
    // already holds 12+ whole cantons (the halves add at most 3).
    majority_of_cantons: halfReported
      ? yes > no
      : (yesWhole ?? 0) >= 12
        ? true
        : (noWhole ?? 0) >= 12
          ? false
          : undefined,
    note: "Half-cantons (OW, NW, BS, BL, AR, AI) count ½; 23 cantonal votes in total. Only relevant for votes requiring a double majority.",
  };
}

/** opendata.swiss (CKAN) regularly needs 10–20 s for package_show; 15 s cut it off. */
const CKAN_TIMEOUT_MS = 25_000;

async function listVoteDayUrls(): Promise<{
  days: Array<{ date: string; url: string }>;
  cacheStatus: CacheStatus;
  retrievedAt: string;
}> {
  const { data, cacheStatus, retrievedAt } = await fetchJson<{
    result?: { resources?: Array<{ download_url?: string; url?: string }> };
  }>(PACKAGE_URL, {
    ttlMs: 12 * 3600 * 1000,
    timeoutMs: CKAN_TIMEOUT_MS,
    // Decades of vote days: a package without resources is an upstream hiccup, not the truth.
    validate: (d) => {
      const res = (d as { result?: { resources?: unknown } })?.result?.resources;
      return Array.isArray(res) && res.length > 0;
    },
  });
  const out: Array<{ date: string; url: string }> = [];
  for (const r of data.result?.resources ?? []) {
    const u = (r.download_url ?? r.url ?? "").trim();
    const m = u.match(/sd-t-17-02-(\d{8})-eidgAbstimmung\.json$/);
    if (m && m[1]) {
      out.push({ date: `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`, url: u });
    }
  }
  out.sort((a, b) => b.date.localeCompare(a.date));
  return { days: out, cacheStatus, retrievedAt };
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

/** BFS canton numbers (geoLevelnummer in the vote-day files). */
const CANTON_NUMBER: Record<string, number> = {
  ZH: 1, BE: 2, LU: 3, UR: 4, SZ: 5, OW: 6, NW: 7, GL: 8, ZG: 9, FR: 10, SO: 11, BS: 12, BL: 13,
  SH: 14, AR: 15, AI: 16, SG: 17, GR: 18, AG: 19, TG: 20, TI: 21, VD: 22, VS: 23, NE: 24, GE: 25, JU: 26,
};

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
          const { days, cacheStatus, retrievedAt } = await listVoteDayUrls();
          if (!days.length) return toolError("No vote-day datasets found.");
          return respond({ vote_days: days.slice(0, limit).map((d) => d.date) }, { source, cacheStatus, retrievedAt });
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
          const { days } = await listVoteDayUrls();
          const day = date ? days.find((d) => d.date === date) : days[0];
          if (!day) {
            if (!days.length) {
              return toolError("No federal vote-day datasets are currently listed on opendata.swiss.", [
                "The dataset index may be temporarily unavailable; try again later.",
              ]);
            }
            return toolError(`No vote data for ${date ?? "the requested day"}.`, [
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
            cantonal_majority: cantonalMajority(v.staende),
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
    tool({
      name: "search_votes",
      title: "Search federal votes",
      description:
        "Search the titles of federal popular-vote proposals across all vote days published in the BFS open dataset (recent and upcoming vote days) by keyword in German, French, Italian or English. Returns vote day, proposal id, title and outcome where counted.",
      inputSchema: {
        query: z.string().min(2).describe("Keyword, e.g. 'AHV', 'Klima', 'E-ID', 'Autobahn'"),
        language: z.enum(["de", "fr", "it", "rm", "en"]).default("en"),
      },
      handler: async ({ query, language }) => {
        try {
          const { days } = await listVoteDayUrls();
          const loaded = await Promise.all(
            days.map((d) => fetchJson<VoteDay>(d.url, { ttlMs: source.cacheTtlSeconds * 1000 }).then((r) => ({ d, r })).catch(() => undefined)),
          );
          const q = query.toLowerCase();
          const hits: Array<Record<string, unknown>> = [];
          let meta: { cacheStatus: "hit" | "miss" | "stale" | "computed"; retrievedAt: string } | undefined;
          for (const x of loaded) {
            if (!x) continue;
            meta ??= { cacheStatus: x.r.cacheStatus, retrievedAt: x.r.retrievedAt };
            for (const v of x.r.data.schweiz?.vorlagen ?? []) {
              if (!(v.vorlagenTitel ?? []).some((t) => (t.text ?? "").toLowerCase().includes(q))) continue;
              const counted = v.resultat?.jaStimmenInProzent !== undefined && v.resultat?.jaStimmenInProzent !== null;
              hits.push({
                vote_day: x.d.date,
                id: v.vorlagenId,
                title: titleOf(v, language),
                status: counted ? (v.vorlageAngenommen ? "accepted" : "rejected") : "not yet counted",
                yes_percent: counted ? Math.round((v.resultat!.jaStimmenInProzent as number) * 100) / 100 : undefined,
              });
            }
          }
          if (!meta) throw new Error("no vote-day file could be loaded");
          if (!hits.length) return toolError(`No federal vote proposal matches '${query}' in the published vote days.`, [`Vote days available: ${days.map((d) => d.date).join(", ")}`], { kind: "not_found" });
          return respond({ query, vote_days_searched: days.length, matches: hits }, { source, ...meta, language });
        } catch (err) {
          return errorToResult(err, "BFS vote-day data");
        }
      },
    }),
    tool({
      name: "get_vote_details",
      title: "Vote results by district and municipality",
      description:
        "Detailed results of one federal proposal inside a canton: the cantonal result plus every district and municipality (yes-share, yes/no votes, turnout), sorted by yes-share. Optionally filter to one municipality. Proposal by id (from get_voting_results / search_votes) or title fragment.",
      inputSchema: {
        canton: z.string().min(2).describe("Canton code or name"),
        proposal: z.union([z.number().int(), z.string().min(2)]).describe("Proposal id or a title fragment"),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Vote day (default: most recent)"),
        municipality: z.string().optional(),
        language: z.enum(["de", "fr", "it", "rm", "en"]).default("en"),
        limit: z.number().int().min(1).max(400).default(60),
      },
      handler: async ({ canton, proposal, date, municipality, language, limit }) => {
        const code = resolveCanton(canton);
        if (!code) return toolError(`Unknown canton '${canton}'.`, [], { kind: "invalid_input" });
        try {
          const { days } = await listVoteDayUrls();
          const day = date ? days.find((d) => d.date === date) : days[0];
          if (!day) return toolError(`No vote data for ${date ?? "the latest day"}.`, [`Available: ${days.map((d) => d.date).join(", ")}`], { kind: "not_found" });
          const { data, cacheStatus, retrievedAt } = await fetchJson<VoteDay>(day.url, { ttlMs: source.cacheTtlSeconds * 1000 });
          const vorlagen = data.schweiz?.vorlagen ?? [];
          const v =
            typeof proposal === "number" || /^\d+$/.test(String(proposal))
              ? vorlagen.find((x) => String(x.vorlagenId) === String(proposal))
              : vorlagen.find((x) => (x.vorlagenTitel ?? []).some((t) => (t.text ?? "").toLowerCase().includes(String(proposal).toLowerCase())));
          if (!v) return toolError(`No proposal '${proposal}' on ${day.date}.`, [`Proposals: ${vorlagen.map((x) => `${x.vorlagenId} ${titleOf(x, language)}`).join(" | ")}`], { kind: "not_found" });
          const k = (v.kantone ?? []).find((x) => CANTON_NUMBER[code] === Number(x.geoLevelnummer));
          if (!k) return toolError(`No results for canton ${code}.`, [], { kind: "not_found" });
          const unit = (g: GeoUnit) => ({ name: g.geoLevelname, bfs_number: g.geoLevelnummer ? Number(g.geoLevelnummer) : undefined, ...mapResult(g.resultat) });
          const byYes = (a: { yes_percent?: number }, b: { yes_percent?: number }) => (b.yes_percent ?? -1) - (a.yes_percent ?? -1);
          let communes = (k.gemeinden ?? []).map(unit);
          if (municipality) communes = communes.filter((c) => (c.name ?? "").toLowerCase().includes(municipality.toLowerCase()));
          communes.sort(byYes);
          const counted = (k.gemeinden ?? []).filter((g) => g.resultat?.gebietAusgezaehlt).length;
          return respond(
            {
              vote_day: day.date,
              proposal: { id: v.vorlagenId, title: titleOf(v, language) },
              canton: { code, name: k.geoLevelname, accepted: k.vorlageAngenommen, ...mapResult(k.resultat) },
              municipalities_counted: `${counted} of ${(k.gemeinden ?? []).length}`,
              districts: municipality ? undefined : (k.bezirke ?? []).map(unit).sort(byYes),
              municipalities: communes.slice(0, limit),
            },
            { source, cacheStatus, retrievedAt, dataAsOf: data.timestamp, language },
          );
        } catch (err) {
          return errorToResult(err, "BFS vote-day data");
        }
      },
    }),
  ],
};
