/**
 * Meta module — the platform's self-description: licence register,
 * live source-health checks, and an orientation tool for agents.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { respond, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule, type ToolDef } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";
import { getActiveModules, getReachableModules, runHealthChecks } from "../registry.js";
import { getSearchers, interleave, type DataHit } from "../core/discovery.js";
import { createLimiter, withDeadline } from "../core/limit.js";
import { remainingBudgetMs, withTimeBudget } from "../core/http.js";
import { analyzeQuery, COVERAGE_GAPS } from "../core/queryhints.js";

/** find_data answers within this many ms (SWISSYPHUS_FIND_DATA_MS, default 8 s). */
const FIND_DATA_MS = Number(process.env["SWISSYPHUS_FIND_DATA_MS"]) || 8_000;

/** Bound concurrent find_data fan-outs (each one hits ~15 upstream endpoints). */
const fanOut = createLimiter(4);

/** Lower-case, strip diacritics, split into word tokens. */
export function tokenize(s: string): string[] {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/**
 * Score tools against a free-text need. Name hits weigh most, then title,
 * then module and description. Prefix matches count (e.g. "tariff" ~ "tariffs").
 */
export function rankTools(
  query: string,
  modules: SwissyphusModule[],
): Array<{ module: SwissyphusModule; tool: ToolDef; score: number }> {
  const q = tokenize(query);
  const hits: Array<{ module: SwissyphusModule; tool: ToolDef; score: number }> = [];
  for (const m of modules) {
    for (const t of m.tools) {
      const fields: Array<[string[], number]> = [
        [tokenize(t.name.replace(/_/g, " ")), 5],
        [tokenize(t.title), 3],
        [tokenize(`${m.id} ${m.title} ${m.description}`), 2],
        [tokenize(t.description), 1],
      ];
      let score = 0;
      for (const qt of q) {
        let best = 0;
        for (const [toks, w] of fields) {
          if (toks.includes(qt)) best = Math.max(best, w);
          else if (qt.length >= 4 && toks.some((x) => x.startsWith(qt) || qt.startsWith(x) && x.length >= 4)) best = Math.max(best, w * 0.6);
        }
        score += best;
      }
      if (score > 0) hits.push({ module: m, tool: t, score });
    }
  }
  return hits.sort((a, b) => b.score - a.score);
}

function findToolByName(name: string): { module: SwissyphusModule; tool: ToolDef } | undefined {
  for (const m of getReachableModules()) {
    const t = m.tools.find((x) => x.name === name);
    if (t) return { module: m, tool: t };
  }
  return undefined;
}

/** Tools that must never be reachable through call_tool (avoid recursion). */
const NOT_PROXYABLE = new Set(["call_tool", "find_data"]);

const self: SourceManifest = {
  id: "swissyphus",
  name: "Swissyphus platform metadata",
  operator: "Swissyphus",
  url: "https://github.com/swissyphus",
  licence: "MIT",
  attribution: "Swissyphus — the AI gateway to Switzerland",
  updateFrequency: "per release",
  cacheTtlSeconds: 0,
};

export const metaModule: SwissyphusModule = {
  id: "meta",
  emoji: "🇨🇭",
  title: "Swissyphus meta",
  description: "Licence register, live source health, capability overview",
  sources: [self],
  tools: [
    tool({
      name: "find_data",
      title: "Find Swiss data across every catalogue",
      description:
        "START HERE for any Swiss data question not obviously covered by a specific tool. Searches all connected catalogues at once — opendata.swiss (12'000+ datasets), the federal geodata layers (geo.admin.ch, ~900 layers + STAC), BFS STAT-TAB statistical tables, LINDAS statistical cubes, cantonal/SBB/Swiss Post Opendatasoft portals, SNB data — and returns ranked hits. Every hit includes `next`: the exact tool and arguments that fetch the actual data (invoke it directly, or via call_tool if that tool isn't loaded). Example queries: 'rent prices Zürich', 'Strassenlärm', 'Übernachtungen Hotels', 'parking Basel', 'Radon'. German terms often match best.",
      inputSchema: {
        query: z.string().min(2).describe("What you are looking for, e.g. 'bicycle counts', 'Mietpreise', 'noise map'"),
        limit: z.number().int().min(1).max(60).default(20),
        catalogues: z
          .array(z.string())
          .optional()
          .describe("Optional subset of catalogue names to search (see the `catalogues_searched` field of a previous result)"),
        lang: z.enum(["de", "fr", "it", "en"]).default("de"),
      },
      handler: async ({ query, limit, catalogues, lang }) => {
        const startedAll = Date.now();
        let searchers = getSearchers();
        if (catalogues?.length) {
          const want = catalogues.map((c) => c.toLowerCase());
          searchers = searchers.filter((s) => want.some((w) => s.catalogue.toLowerCase().includes(w)));
        }
        if (!searchers.length) {
          return toolError("No searchable catalogues matched.", [
            `Available catalogues: ${getSearchers().map((s) => s.catalogue).join(", ") || "none registered"}`,
          ]);
        }
        const q = analyzeQuery(query);
        const coverageNotes = q.gaps.map((g) => g.note);
        const perCatalogue = Math.max(3, Math.ceil(limit / Math.min(searchers.length, 4)));
        // Answer within the find_data deadline with whatever has arrived. Each
        // searcher runs detached with its own longer budget, so stragglers
        // keep loading in the background and land in the cache for next time.
        const deadline = Math.min(FIND_DATA_MS, Math.max(1_000, remainingBudgetMs() - 1_000));
        const settled = await fanOut(() =>
          Promise.all(
            searchers.map(async (s) => {
              const started = Date.now();
              const text = q.canton && s.placeAware ? `${q.topic} ${q.canton.name}` : q.topic;
              const work = withTimeBudget(20_000, () => s.search(text, perCatalogue, lang), { retries: false, detached: true });
              work.catch(() => undefined); // a late failure after the deadline must not be unhandled
              try {
                const hits = await withDeadline(work, deadline, s.catalogue);
                return { catalogue: s.catalogue, static: !!s.static, hits, ms: Date.now() - started };
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                  catalogue: s.catalogue,
                  static: !!s.static,
                  hits: [] as DataHit[],
                  ms: Date.now() - started,
                  ...(msg.includes("timed out") ? { timed_out: true } : { error: msg }),
                };
              }
            }),
          ),
        );
        const active = new Set(getActiveModules().flatMap((m) => m.tools.map((t) => t.name)));
        let results = interleave(
          settled.map((r) => r.hits),
          settled.reduce((n, r) => n + r.hits.length, 0),
        ).map((h) => ({
          ...h,
          description: h.description?.slice(0, 240),
          next: { ...h.next, loaded: active.has(h.next.tool) },
        }));
        if (q.canton) {
          // Hits that name the canton first (stable within each group).
          const re = new RegExp(`\\b(${q.canton.name}|kanton ${q.canton.code}|\\(${q.canton.code}\\))`, "i");
          const mentions = (h: DataHit) => re.test(`${h.title} ${h.description ?? ""} ${h.publisher ?? ""}`);
          results = [...results.filter(mentions), ...results.filter((h) => !mentions(h))];
        }
        results = results.slice(0, limit);
        const live = settled.filter((r) => !r.static);
        const timedOut = settled.filter((r) => "timed_out" in r).map((r) => r.catalogue);
        if (!results.length && !coverageNotes.length && live.length && live.every((r) => "error" in r)) {
          return toolError("Every data catalogue is currently unreachable.", [
            ...live.map((r) => `${r.catalogue}: ${"error" in r ? r.error : "timed out"}`),
            "Retry in a minute, or run check_source_health.",
          ]);
        }
        if (!results.length && !coverageNotes.length && !timedOut.length) {
          return toolError(`No datasets found for '${query}' in any catalogue.`, [
            "Try a broader German term (e.g. 'Verkehr', 'Bevölkerung').",
            "Try find_tools to look for a purpose-built tool.",
            ...settled.filter((r) => "error" in r).map((r) => `${r.catalogue} failed: ${"error" in r ? r.error : ""}`),
          ]);
        }
        return respond(
          {
            query,
            ...(q.topic !== query ? { searched_for: q.topic } : {}),
            ...(q.canton ? { place: { canton: q.canton.name, code: q.canton.code, bfs_canton_number: q.canton.bfs, hint: `Filter the data to ${q.canton.name} (${q.canton.code}) when you query it.` } } : {}),
            ...(coverageNotes.length ? { coverage_notes: coverageNotes } : {}),
            results,
            catalogues_searched: settled.map((r) => ({
              catalogue: r.catalogue,
              hits: r.hits.length,
              ms: r.ms,
              ...("error" in r ? { error: r.error } : {}),
              ...("timed_out" in r ? { timed_out: true } : {}),
            })),
            elapsed_ms: Date.now() - startedAll,
            hint:
              (timedOut.length ? `Slow catalogues (${timedOut.join(", ")}) are still loading in the background; the same query in ~20 s will include them. ` : "") +
              "Call hit.next.tool with hit.next.args (via call_tool if next.loaded is false). Pick the best hit instead of searching again; if nothing fits, tell the user.",
          },
          { source: self, cacheStatus: "computed", retrievedAt: new Date().toISOString() },
        );
      },
    }),

    tool({
      name: "find_tools",
      title: "Find the right Swissyphus tool",
      description:
        "Keyword search over all Swissyphus tools this server exposes (with the 'discovery' preset: every module, loaded or not). Returns tool names, what they do, and whether they are loaded. Use describe_tool for the argument schema and call_tool to invoke a tool that is not loaded. Example: 'avalanche danger', 'company VAT', 'train delays', 'court decision'.",
      inputSchema: {
        query: z.string().min(2).describe("What you want to do"),
        limit: z.number().int().min(1).max(30).default(10),
      },
      handler: async ({ query, limit }) => {
        const active = new Set(getActiveModules().map((m) => m.id));
        const ranked = rankTools(query, getReachableModules()).slice(0, limit);
        const gaps = analyzeQuery(query).gaps.map((g) => g.note);
        if (!ranked.length && !gaps.length) {
          return toolError(`No tools match '${query}'.`, ["Try find_data to search the dataset catalogues instead."]);
        }
        return respond(
          {
            query,
            ...(gaps.length ? { coverage_notes: gaps } : {}),
            tools: ranked.map((r) => ({
              name: r.tool.name,
              module: r.module.id,
              title: r.tool.title,
              description: r.tool.description.slice(0, 300),
              loaded: active.has(r.module.id),
            })),
          },
          { source: self, cacheStatus: "computed", retrievedAt: new Date().toISOString() },
        );
      },
    }),

    tool({
      name: "describe_tool",
      title: "Describe a tool's arguments",
      description: "Full description and JSON Schema of the arguments of any Swissyphus tool this server exposes, for use with call_tool.",
      inputSchema: {
        name: z.string().describe("Tool name, e.g. 'query_dataset'"),
      },
      handler: async ({ name }) => {
        const found = findToolByName(name);
        if (!found) return toolError(`Unknown tool '${name}'.`, ["Use find_tools to search by keyword."]);
        return respond(
          {
            name,
            module: found.module.id,
            title: found.tool.title,
            description: found.tool.description,
            input_schema: zodToJsonSchema(z.object(found.tool.inputSchema)),
            sources: found.module.sources.map((s) => ({ name: s.name, licence: s.licence })),
          },
          { source: self, cacheStatus: "computed", retrievedAt: new Date().toISOString() },
        );
      },
    }),

    tool({
      name: "call_tool",
      title: "Invoke any Swissyphus tool by name",
      description:
        "Invoke any Swissyphus tool this server exposes by name — with the 'discovery' preset that includes every module, so the context stays small while the full catalogue is reachable. Arguments are validated against the tool's schema (see describe_tool). Returns exactly what the tool returns.",
      inputSchema: {
        name: z.string().describe("Tool name from find_tools / find_data"),
        arguments: z.record(z.unknown()).default({}).describe("Arguments object for that tool"),
      },
      handler: async ({ name, arguments: args }) => {
        if (NOT_PROXYABLE.has(name)) return toolError(`'${name}' cannot be proxied.`);
        const found = findToolByName(name);
        if (!found) return toolError(`Unknown tool '${name}'.`, ["Use find_tools to search by keyword."]);
        const parsed = z.object(found.tool.inputSchema).safeParse(args ?? {});
        if (!parsed.success) {
          return toolError(`Invalid arguments for '${name}'.`, [
            ...parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
            "Use describe_tool to see the argument schema.",
          ]);
        }
        return found.tool.handler(parsed.data);
      },
    }),

    tool({
      name: "list_sources",
      title: "Licence & source register",
      description:
        "The machine-readable register of every data source behind the active Swissyphus modules: operator, licence, attribution string, update frequency, cache TTL and caveats (RFP-grade source governance).",
      inputSchema: {},
      handler: async () => {
        const register = getActiveModules().flatMap((m) =>
          m.sources.map((s) => ({
            module: m.id,
            source_id: s.id,
            name: s.name,
            operator: s.operator,
            url: s.url,
            licence: s.licence,
            attribution: s.attribution,
            update_frequency: s.updateFrequency,
            cache_ttl_seconds: s.cacheTtlSeconds,
            ...(s.notes ? { notes: s.notes } : {}),
          })),
        );
        return respond(
          { sources: register, count: register.length },
          { source: self, cacheStatus: "computed", retrievedAt: new Date().toISOString() },
        );
      },
    }),

    tool({
      name: "check_source_health",
      title: "Live source health check",
      description:
        "Ping every upstream Swiss data source behind the active modules and report status and latency — Swissyphus's built-in status page. Use when another tool reports a source as unavailable.",
      inputSchema: {
        module: z.string().optional().describe("Optionally check only one module, e.g. 'transport'"),
      },
      handler: async ({ module }) => {
        const results = await runHealthChecks(module);
        if (!results.length) {
          return toolError(module ? `No health probes for module '${module}'.` : "No health probes registered.");
        }
        const healthy = results.filter((r) => r.ok).length;
        return respond(
          {
            summary: `${healthy}/${results.length} sources healthy`,
            checked_at: new Date().toISOString(),
            sources: results,
          },
          { source: self, cacheStatus: "computed", retrievedAt: new Date().toISOString() },
        );
      },
    }),

    tool({
      name: "about_swissyphus",
      title: "What can Swissyphus do?",
      description:
        "Orientation for agents: lists the active modules, what each covers, and example questions each can answer. Call this first if unsure which tool fits a Swiss data question.",
      inputSchema: {},
      handler: async () => {
        const modules = getActiveModules().map((m) => ({
          module: m.id,
          title: m.title,
          covers: m.description,
          tools: m.tools.map((t) => t.name),
        }));
        return respond(
          {
            platform: "Swissyphus — the AI gateway to Switzerland",
            active_modules: modules,
            not_connected: COVERAGE_GAPS.map((g) => ({ topic: g.topic, note: g.note })),
            conventions: {
              coordinates: "Tools accept/return WGS84; LV95 conversions via the coords module",
              envelope:
                "Every response carries source, licence, attribution, retrieved_at, data_as_of and cache_status",
              languages: "Data is DE/FR/IT/RM at source; tool interfaces are English",
            },
          },
          { source: self, cacheStatus: "computed", retrievedAt: new Date().toISOString() },
        );
      },
    }),
  ],
};
