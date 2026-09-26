/**
 * Meta module — the platform's self-description: licence register,
 * live source-health checks, and an orientation tool for agents.
 */

import { z } from "zod";
import { respond, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";
import { getActiveModules, getHealthSnapshot } from "../registry.js";

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
        // Shared cached snapshot (TTL SWISSYPHUS_HEALTH_TTL_SECONDS, default 60 s):
        // repeated calls must not fan out to every upstream source each time.
        const snap = await getHealthSnapshot({ module });
        const results = snap.results;
        if (!results.length) {
          return toolError(module ? `No health probes for module '${module}'.` : "No health probes registered.");
        }
        const healthy = results.filter((r) => r.ok).length;
        return respond(
          {
            summary: `${healthy}/${results.length} sources healthy`,
            checked_at: snap.checked_at,
            age_seconds: snap.age_seconds,
            sources: results,
          },
          {
            source: self,
            cacheStatus: snap.cached ? "hit" : "computed",
            retrievedAt: snap.checked_at,
            dataAsOf: snap.checked_at,
          },
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
