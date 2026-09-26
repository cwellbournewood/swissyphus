/**
 * Module registry and presets (RFP §5.1 module filtering & token efficiency).
 */

import type { SwissyphusModule } from "./core/module.js";
import { geoModule } from "./modules/geo.js";
import { coordsModule } from "./modules/coordsModule.js";
import { postcodeModule } from "./modules/postcode.js";
import { transportModule } from "./modules/transport.js";
import { companiesModule } from "./modules/companies.js";
import { weatherModule } from "./modules/weather.js";
import { hydrologyModule } from "./modules/hydrology.js";
import { avalancheModule } from "./modules/avalanche.js";
import { snowModule } from "./modules/snow.js";
import { earthquakesModule } from "./modules/earthquakes.js";
import { fxModule } from "./modules/fx.js";
import { holidaysModule } from "./modules/holidays.js";
import { lawModule } from "./modules/law.js";
import { statisticsModule } from "./modules/statistics.js";
import { parliamentModule } from "./modules/parliament.js";
import { metaModule } from "./modules/meta.js";
import { energyModule } from "./modules/energy.js";
import { alertsModule } from "./modules/alerts.js";
import { votingModule } from "./modules/voting.js";
import { buildingsModule } from "./modules/buildings.js";
import { newsModule } from "./modules/news.js";
import { airQualityModule } from "./modules/airquality.js";
import { lindasModule } from "./modules/lindas.js";
import { trailsModule } from "./modules/trails.js";
import { wasteModule } from "./modules/waste.js";
import { portalsModule } from "./modules/portals.js";
import { courtsModule } from "./modules/courts.js";
import { uidModule } from "./modules/uid.js";
import { mobilityModule } from "./modules/mobility.js";

export const ALL_MODULES: SwissyphusModule[] = [
  companiesModule,
  transportModule,
  weatherModule,
  hydrologyModule,
  geoModule,
  coordsModule,
  postcodeModule,
  buildingsModule,
  lawModule,
  statisticsModule,
  parliamentModule,
  votingModule,
  alertsModule,
  avalancheModule,
  snowModule,
  trailsModule,
  earthquakesModule,
  airQualityModule,
  energyModule,
  fxModule,
  holidaysModule,
  wasteModule,
  newsModule,
  lindasModule,
  portalsModule,
  mobilityModule,
  uidModule,
  courtsModule,
  metaModule,
];

export const PRESETS: Record<string, string[]> = {
  minimal: ["geo", "transport", "weather", "meta"],
  commuter: ["transport", "weather", "geo", "postcode", "holidays", "alerts", "portals", "mobility", "meta"],
  outdoor: [
    "weather", "avalanche", "snow", "trails", "hydrology", "earthquakes", "alerts", "geo", "coords", "transport", "meta",
  ],
  business: ["companies", "fx", "law", "statistics", "energy", "holidays", "postcode", "news", "portals", "uid", "meta"],
  citizen: [
    "weather", "transport", "holidays", "postcode", "geo", "statistics", "alerts", "waste", "energy", "voting", "news", "portals", "mobility", "meta",
  ],
  legal: ["law", "companies", "parliament", "voting", "statistics", "uid", "courts", "meta"],
  compliance: ["companies", "law", "parliament", "fx", "statistics", "lindas", "uid", "courts", "meta"],
  // Smallest possible context: only the meta tools. find_data / find_tools
  // discover everything, call_tool invokes any tool in any module.
  discovery: ["meta"],
  full: [], // resolved dynamically below
};
PRESETS["full"] = ALL_MODULES.map((m) => m.id);

let activeModules: SwissyphusModule[] = ALL_MODULES;

export function resolveModules(opts: { modules?: string[]; preset?: string }): SwissyphusModule[] {
  const ids = new Set<string>();
  if (opts.preset) {
    const preset = PRESETS[opts.preset.toLowerCase()];
    if (!preset) {
      throw new Error(
        `Unknown preset '${opts.preset}'. Available: ${Object.keys(PRESETS).join(", ")}`,
      );
    }
    preset.forEach((id) => ids.add(id));
  }
  if (opts.modules?.length) {
    for (const id of opts.modules) {
      const norm = id.trim().toLowerCase();
      if (!ALL_MODULES.some((m) => m.id === norm)) {
        throw new Error(
          `Unknown module '${id}'. Available: ${ALL_MODULES.map((m) => m.id).join(", ")}`,
        );
      }
      ids.add(norm);
    }
  }
  if (!ids.size) return ALL_MODULES;
  // meta is always useful and tiny — include it whenever filtering is active.
  ids.add("meta");
  return ALL_MODULES.filter((m) => ids.has(m.id));
}

export function setActiveModules(mods: SwissyphusModule[]): void {
  activeModules = mods;
}

export function getActiveModules(): SwissyphusModule[] {
  return activeModules;
}

export interface HealthResult {
  source_id: string;
  module: string;
  status: "healthy" | "unreachable";
  ok: boolean;
  http_status?: number;
  latency_ms?: number;
  error?: string;
}

export async function runHealthChecks(moduleFilter?: string): Promise<HealthResult[]> {
  const mods = getActiveModules().filter((m) => !moduleFilter || m.id === moduleFilter.toLowerCase());
  const probes = mods.flatMap((m) => (m.healthProbes ?? []).map((p) => ({ module: m.id, probe: p })));
  return Promise.all(
    probes.map(async ({ module, probe }): Promise<HealthResult> => {
      const started = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        try {
          const res = await fetch(probe.url, {
            method: probe.method ?? "GET",
            body: probe.body,
            headers: {
              "User-Agent": "swissyphus/0.1.0 (health check)",
              ...(probe.headers ?? {}),
            },
            signal: controller.signal,
          });
          return {
            source_id: probe.sourceId,
            module,
            status: res.ok ? "healthy" : "unreachable",
            ok: res.ok,
            http_status: res.status,
            latency_ms: Date.now() - started,
          };
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        return {
          source_id: probe.sourceId,
          module,
          status: "unreachable",
          ok: false,
          latency_ms: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}
