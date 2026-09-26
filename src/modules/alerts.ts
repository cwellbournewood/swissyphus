/**
 * Emergency alerts module — Alertswiss, the official population warning
 * channel of the Federal Office for Civil Protection (FOCP/BABS).
 */

import { z } from "zod";
import { fetchJson } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";
import { matchesRegion, regionTerms } from "./_cantons.js";

const source: SourceManifest = {
  id: "alertswiss",
  name: "Alertswiss — official population alerts",
  operator: "Federal Office for Civil Protection (FOCP/BABS)",
  url: "https://www.alert.swiss",
  licence: "Official warnings, public information",
  attribution: "© Alertswiss / FOCP",
  updateFrequency: "real-time",
  cacheTtlSeconds: 120,
};

const URL_ACTUAL =
  "https://www.alert.swiss/content/alertswiss-internet/en/home/_jcr_content/polyalert.alertswiss_alerts.actual.json";

interface AlertswissAlert {
  identifier?: string;
  sent?: string;
  title?: { title?: string };
  description?: { description?: string };
  instruction?: { instructions?: string[] };
  event?: string;
  severity?: string;
  areas?: Array<{ regions?: Array<{ region?: string }>; description?: string }>;
  publisherName?: string;
  technicalTestAlert?: boolean;
}

export interface MappedAlert {
  id?: string;
  sent?: string;
  event?: string;
  severity?: string;
  title?: string;
  description?: string;
  instructions?: string[];
  regions: string[];
  area_description?: string;
  area_descriptions: string[];
  publisher?: string;
  is_test: boolean;
}

/**
 * Parse the Alertswiss "actual" JSON. Returns `undefined` when the payload is
 * not the expected `{ alerts: [...] }` shape — the caller must then report
 * the source as unavailable/changed, NEVER as "no active alerts" (a silent
 * false all-clear is the worst failure mode of a warnings tool).
 */
export function parseAlerts(data: unknown): MappedAlert[] | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const raw = (data as { alerts?: unknown }).alerts;
  if (!Array.isArray(raw)) return undefined;
  return (raw as AlertswissAlert[])
    .filter((a) => a && typeof a === "object")
    .map((a) => ({
      id: a.identifier,
      sent: a.sent,
      event: a.event,
      severity: a.severity,
      title: a.title?.title,
      description: a.description?.description?.slice(0, 800),
      instructions: a.instruction?.instructions,
      regions: (a.areas ?? [])
        .flatMap((ar) => (ar?.regions ?? []).map((r) => r?.region))
        .filter((r): r is string => typeof r === "string" && r.length > 0),
      area_description: a.areas?.[0]?.description,
      area_descriptions: (a.areas ?? [])
        .map((ar) => ar?.description)
        .filter((d): d is string => typeof d === "string" && d.length > 0),
      publisher: a.publisherName,
      is_test: a.technicalTestAlert ?? false,
    }));
}

/**
 * Diacritic-insensitive region filter. A canton given by code or by any of
 * its DE/FR/IT/EN names (e.g. 'GE', 'Genf', 'Genève', 'Geneva') matches
 * alerts naming it in any of those languages.
 */
export function filterAlertsByRegion(alerts: MappedAlert[], region: string): MappedAlert[] {
  const terms = regionTerms(region);
  return alerts.filter((a) => matchesRegion([...a.regions, ...a.area_descriptions, a.title], terms));
}

export const alertsModule: SwissyphusModule = {
  id: "alerts",
  emoji: "🚨",
  title: "Emergency alerts (Alertswiss)",
  description: "Official live population warnings for all hazards (weather, fire, water, nuclear…)",
  sources: [source],
  healthProbes: [{ sourceId: "alertswiss", url: URL_ACTUAL }],
  tools: [
    tool({
      name: "get_emergency_alerts",
      title: "Current official emergency alerts",
      description:
        "All currently active Alertswiss population warnings for Switzerland: event type, severity, affected regions, official instructions. Optionally filter by a region or canton (code or name in any national language or English, accents optional).",
      inputSchema: {
        region: z.string().optional().describe("Filter by region/canton, e.g. 'Zürich', 'Zurich', 'ZH', 'Ticino', 'Genève'"),
        include_tests: z.boolean().default(false).describe("Include technical test alerts"),
        limit: z.number().int().min(1).max(50).default(20),
      },
      handler: async ({ region, include_tests, limit }) => {
        try {
          const { data, cacheStatus, retrievedAt } = await fetchJson<unknown>(URL_ACTUAL, {
            ttlMs: source.cacheTtlSeconds * 1000,
          });
          const parsed = parseAlerts(data);
          if (!parsed) {
            return toolError(
              "Alertswiss is unavailable or returned an unrecognised format — the current alert status could NOT be determined. Do not treat this as 'no active alerts'.",
              [
                "Check https://www.alert.swiss or the Alertswiss app directly for current warnings.",
                "Run check_source_health to see the live status of all Swissyphus sources.",
              ],
            );
          }
          let alerts = parsed;
          if (!include_tests) alerts = alerts.filter((a) => !a.is_test);
          if (region && region.trim()) alerts = filterAlertsByRegion(alerts, region);
          return respond(
            {
              active_alert_count: alerts.length,
              status: alerts.length
                ? `${alerts.length} active alert(s)`
                : region
                  ? `no active alerts matching '${region}'`
                  : "no active alerts",
              alerts: alerts.slice(0, limit),
            },
            { source, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "Alertswiss");
        }
      },
    }),
  ],
};
