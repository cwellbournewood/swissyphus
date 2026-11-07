/**
 * Discovery mode: instead of listing every tool schema up front (~100 tools,
 * tens of thousands of tokens), the server lists three meta-tools. The model
 * searches for what it needs, reads only those schemas, then calls them
 * through swissyphus_call_tool. Enabled with --discovery, --mode discovery or
 * SWISSYPHUS_MODE=discovery.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { tool, type SwissyphusModule, type ToolDef } from "./core/module.js";
import { respond, toolError } from "./core/envelope.js";
import type { SourceManifest } from "./core/types.js";
import { normalizeText } from "./modules/_cantons.js";

const self: SourceManifest = {
  id: "swissyphus",
  name: "Swissyphus tool catalogue",
  operator: "Swissyphus",
  url: "https://github.com/cwellbournewood/swissyphus",
  licence: "MIT (catalogue); each tool's data carries its own licence",
  attribution: "Swissyphus",
  updateFrequency: "per release",
  cacheTtlSeconds: 0,
};

function meta() {
  return { source: self, cacheStatus: "computed" as const, retrievedAt: new Date().toISOString() };
}

export function discoveryEnabled(flag?: boolean): boolean {
  if (flag !== undefined) return flag;
  return (process.env["SWISSYPHUS_MODE"] ?? "").toLowerCase() === "discovery";
}

interface Indexed {
  module: SwissyphusModule;
  tool: ToolDef;
  haystack: string;
}

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "of", "in", "on", "at", "for", "to", "and", "or", "my", "me", "what", "which", "how", "get", "find", "show", "list", "still",
  "der", "die", "das", "und", "ist", "im", "in", "von", "le", "la", "les", "de", "du", "des", "et", "il", "lo", "di",
]);

/** A few synonyms so everyday words reach the official terminology. */
const SYNONYMS: Record<string, string[]> = {
  price: ["tariff"],
  prices: ["tariff"],
  cost: ["tariff", "price"],
  costs: ["tariff", "price"],
  train: ["transport", "rail"],
  trains: ["transport", "rail"],
  bus: ["transport"],
  law: ["legislation", "federal law"],
  firm: ["company"],
  business: ["company"],
  referendum: ["vote"],
  initiative: ["vote"],
  temperature: ["weather"],
};

export function queryWords(query: string): string[][] {
  return normalizeText(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map((w) => [w, ...(SYNONYMS[w] ?? [])]);
}

/** True when `text` contains a word starting with `w` (or its 5-letter stem). */
function hasWord(text: string, w: string): boolean {
  const stem = w.length > 5 ? w.slice(0, 5) : w;
  return ` ${text}`.includes(` ${w}`) || ` ${text}`.includes(` ${stem}`);
}

/**
 * Score a tool against query words (each word with its synonyms): a hit in
 * the tool name weighs most, then the title, then description/module text;
 * matching every word adds a bonus. Matching is at word starts only, so "the"
 * does not hit "weather".
 */
export function scoreTool(entry: Indexed, words: string[][]): number {
  let score = 0;
  let matched = 0;
  const name = normalizeText(entry.tool.name.replace(/_/g, " "));
  const title = normalizeText(entry.tool.title);
  for (const alts of words) {
    let best = 0;
    for (const [i, w] of alts.entries()) {
      const weight = i === 0 ? 1 : 0.8;
      if (hasWord(name, w)) best = Math.max(best, 10 * weight);
      else if (hasWord(title, w)) best = Math.max(best, 4 * weight);
      else if (hasWord(entry.haystack, w)) best = Math.max(best, 1 * weight);
    }
    if (best > 0) {
      score += best;
      matched++;
    }
  }
  if (!matched) return 0;
  return score + (matched === words.length ? 3 : 0);
}

export function buildIndex(modules: SwissyphusModule[]): Indexed[] {
  return modules.flatMap((m) =>
    m.tools.map((t) => ({
      module: m,
      tool: t,
      haystack: normalizeText(`${t.name.replace(/_/g, " ")} ${t.title} ${t.description} ${m.id} ${m.title} ${m.description}`),
    })),
  );
}

export function inputSchemaOf(t: ToolDef) {
  const js = zodToJsonSchema(z.object(t.inputSchema)) as Record<string, unknown>;
  delete js["$schema"];
  return js;
}

export function discoveryTools(modules: SwissyphusModule[]): ToolDef[] {
  const index = buildIndex(modules);
  const byName = new Map(index.map((e) => [e.tool.name, e]));

  return [
    tool({
      name: "swissyphus_search_tools",
      title: "Find Swissyphus tools",
      description:
        "Step 1 of 2. Search the Swissyphus catalogue of Swiss public-data tools (transport, weather, avalanches, companies, law, parliament, votes, maps, buildings, energy, real estate…) by keywords, or list one module's tools. Returns matching tool names with their input JSON schemas; then run one with swissyphus_call_tool.",
      inputSchema: {
        query: z.string().optional().describe("Keywords, e.g. 'train departures', 'avalanche danger', 'company register', 'rent index'"),
        module: z.string().optional().describe("Restrict to one module id (see swissyphus_list_modules)"),
        limit: z.number().int().min(1).max(20).default(6),
      },
      handler: async ({ query, module, limit }) => {
        const mod = module?.trim().toLowerCase();
        if (mod && !modules.some((m) => m.id === mod)) {
          return toolError(`Unknown module '${module}'.`, [`Modules: ${modules.map((m) => m.id).join(", ")}`], { kind: "invalid_input" });
        }
        const pool = mod ? index.filter((e) => e.module.id === mod) : index;
        const words = queryWords(query ?? "");
        let ranked: Indexed[];
        if (!words.length) ranked = pool;
        else {
          ranked = pool
            .map((e) => ({ e, s: scoreTool(e, words) }))
            .filter((x) => x.s > 0)
            .sort((a, b) => b.s - a.s)
            .map((x) => x.e);
        }
        if (!ranked.length) return toolError(`No tool matches '${query}'.`, ["Try broader words, or call swissyphus_list_modules"], { kind: "not_found" });
        return respond(
          {
            match_count: ranked.length,
            tools: ranked.slice(0, limit).map((e) => ({
              name: e.tool.name,
              module: e.module.id,
              description: e.tool.description,
              input_schema: inputSchemaOf(e.tool),
            })),
            next: "Call swissyphus_call_tool with {name, arguments}.",
          },
          meta(),
        );
      },
    }),
    tool({
      name: "swissyphus_call_tool",
      title: "Run a Swissyphus tool",
      description:
        "Step 2 of 2. Run a Swissyphus tool by name with arguments matching the input schema returned by swissyphus_search_tools. Arguments are validated first; the result is that tool's normal response (data plus source attribution, licence and freshness).",
      inputSchema: {
        name: z.string().describe("Tool name, e.g. 'get_departures'"),
        arguments: z.record(z.unknown()).default({}).describe("Arguments object for that tool"),
      },
      handler: async ({ name, arguments: args }): Promise<CallToolResult> => {
        const entry = byName.get(name);
        if (!entry) {
          const close = index.filter((e) => e.tool.name.includes(name.split("_").pop() ?? name)).slice(0, 5).map((e) => e.tool.name);
          return toolError(`Unknown tool '${name}'.`, close.length ? [`Did you mean: ${close.join(", ")}?`] : ["Use swissyphus_search_tools to find tool names"], { kind: "invalid_input" });
        }
        const parsed = z.object(entry.tool.inputSchema).safeParse(args ?? {});
        if (!parsed.success) {
          return toolError(
            `Invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
            ["Check the input_schema from swissyphus_search_tools"],
            { kind: "invalid_input" },
          );
        }
        return entry.tool.handler(parsed.data as Record<string, unknown>);
      },
    }),
    tool({
      name: "swissyphus_list_modules",
      title: "List Swissyphus modules",
      description: "The catalogue of Swissyphus data modules with a one-line description and their tool names. Use a module id with swissyphus_search_tools to see full schemas.",
      inputSchema: {},
      handler: async () =>
        respond(
          {
            module_count: modules.length,
            tool_count: index.length,
            modules: modules.map((m) => ({ id: m.id, title: m.title, description: m.description, tools: m.tools.map((t) => t.name) })),
          },
          meta(),
        ),
    }),
  ];
}
