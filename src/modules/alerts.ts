/**
 * Emergency alerts module — Alertswiss, the official population warning
 * channel of the Federal Office for Civil Protection (FOCP/BABS).
 */

import { z } from "zod";
import { fetchJson } from "../core/http.js";
import { respond, errorToResult } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

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
        "All currently active Alertswiss population warnings for Switzerland: event type, severity, affected regions, official instructions. Optionally filter by a region/canton keyword.",
      inputSchema: {
        region: z.string().optional().describe("Filter by region keyword, e.g. 'Zürich', 'Ticino'"),
        include_tests: z.boolean().default(false).describe("Include technical test alerts"),
        limit: z.number().int().min(1).max(50).default(20),
      },
      handler: async ({ region, include_tests, limit }) => {
        try {
          const { data, cacheStatus, retrievedAt } = await fetchJson<{ alerts?: AlertswissAlert[] }>(
            URL_ACTUAL,
            { ttlMs: source.cacheTtlSeconds * 1000 },
          );
          let alerts = (data.alerts ?? []).map((a) => ({
            id: a.identifier,
            sent: a.sent,
            event: a.event,
            severity: a.severity,
            title: a.title?.title,
            description: a.description?.description?.slice(0, 800),
            instructions: a.instruction?.instructions,
            regions: (a.areas ?? [])
              .flatMap((ar) => (ar.regions ?? []).map((r) => r.region))
              .filter(Boolean),
            area_description: a.areas?.[0]?.description,
            publisher: a.publisherName,
            is_test: a.technicalTestAlert ?? false,
          }));
          if (!include_tests) alerts = alerts.filter((a) => !a.is_test);
          if (region) {
            const q = region.toLowerCase();
            alerts = alerts.filter(
              (a) =>
                a.regions.some((r) => String(r).toLowerCase().includes(q)) ||
                String(a.area_description ?? "").toLowerCase().includes(q) ||
                String(a.title ?? "").toLowerCase().includes(q),
            );
          }
          return respond(
            {
              active_alert_count: alerts.length,
              status: alerts.length ? `${alerts.length} active alert(s)` : "no active alerts",
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
