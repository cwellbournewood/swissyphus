/**
 * Module registry and presets (RFP §5.1 module filtering & token efficiency).
 */

import type { HealthProbe } from "./core/types.js";
import type { SwissyphusModule } from "./core/module.js";
// Circular (server.ts imports this file) but safe: VERSION is only read inside
// runHealthChecks(), never at module-evaluation time, so the ESM live binding
// is always initialised by the time it is used.
import { VERSION } from "./server.js";
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
import { geodataModule } from "./modules/geodata.js";
import { cubesModule } from "./modules/cubes.js";
import { bfsModule } from "./modules/bfs.js";
import { wikidataModule } from "./modules/wikidata.js";
import { courtsModule } from "./modules/courts.js";
import { uidModule } from "./modules/uid.js";
import { mobilityModule } from "./modules/mobility.js";
import { sanctionsModule } from "./modules/sanctions.js";
import { procurementModule } from "./modules/procurement.js";
import { healthModule } from "./modules/health.js";
import { localPoliticsModule } from "./modules/localpolitics.js";
import { i14yModule } from "./modules/i14y.js";
import { librariesModule } from "./modules/libraries.js";
import { glaciersModule } from "./modules/glaciers.js";
import { cadastreModule } from "./modules/cadastre.js";
import { damsModule } from "./modules/dams.js";
import { trafficModule } from "./modules/traffic.js";
import { sbbModule } from "./modules/sbb.js";
import { realestateModule } from "./modules/realestate.js";

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
  wikidataModule,
  bfsModule,
  cubesModule,
  geodataModule,
  sanctionsModule,
  procurementModule,
  healthModule,
  localPoliticsModule,
  i14yModule,
  librariesModule,
  glaciersModule,
  cadastreModule,
  damsModule,
  trafficModule,
  sbbModule,
  realestateModule,
  metaModule,
];

export const PRESETS: Record<string, string[]> = {
  minimal: ["geo", "transport", "weather", "meta"],
  commuter: ["transport", "weather", "geo", "postcode", "holidays", "alerts", "portals", "mobility", "sbb", "traffic", "meta"],
  outdoor: [
    "weather", "avalanche", "snow", "trails", "hydrology", "earthquakes", "alerts", "geo", "coords", "transport", "geodata", "glaciers", "dams", "meta",
  ],
  business: [
    "companies", "fx", "law", "statistics", "energy", "holidays", "postcode", "news", "portals", "uid", "wikidata", "bfs", "cubes", "geodata",
    "procurement", "sanctions", "i14y", "realestate", "traffic", "meta",
  ],
  citizen: [
    "weather", "transport", "holidays", "postcode", "geo", "statistics", "alerts", "waste", "energy", "voting", "news", "portals", "mobility", "fx",
    "wikidata", "bfs", "cubes", "geodata", "health", "localpolitics", "sbb", "realestate", "meta",
  ],
  legal: ["law", "companies", "parliament", "voting", "statistics", "uid", "courts", "sanctions", "cadastre", "localpolitics", "meta"],
  compliance: [
    "companies", "law", "parliament", "fx", "statistics", "lindas", "uid", "courts", "wikidata", "cubes", "geodata", "sanctions", "procurement", "i14y", "meta",
  ],
  // Political process at every level: federal, cantonal, municipal.
  politics: ["parliament", "voting", "localpolitics", "law", "statistics", "bfs", "meta"],
  // Parcels, buildings and their regulatory/energy context.
  property: ["geo", "coords", "postcode", "buildings", "cadastre", "energy", "geodata", "statistics", "bfs", "realestate", "dams", "meta"],
  // Public health and surveillance.
  health: ["health", "statistics", "bfs", "cubes", "airquality", "meta"],
  // Research data, libraries, environment and reference code lists.
  research: ["libraries", "statistics", "glaciers", "geodata", "cubes", "bfs", "wikidata", "i14y", "lindas", "dams", "traffic", "meta"],
  // Smallest possible context: only the meta tools. find_data / find_tools
  // discover everything, call_tool invokes any tool in any module.
  discovery: ["meta"],
  full: [], // resolved dynamically below
  hosted: [], // resolved dynamically below
};
PRESETS["full"] = ALL_MODULES.map((m) => m.id);

/**
 * Modules left out of the `hosted` preset: their terms rule out, or have not
 * yet confirmed, redistribution by a public third-party service. Local use
 * (stdio, own deployment) is unaffected. Remove an entry once the provider
 * confirms (see BACKLOG.md #9 and docs/outreach/).
 */
export const HOSTED_EXCLUDED: Record<string, string> = {
  glaciers: "GLAMOS data: scientific and non-commercial use only",
  libraries: "swisscovery (SLSP): redistribution not confirmed",
  procurement: "simap.ch: no open-data licence; permission requested",
  news: "SRF RSS: terms are for personal, non-commercial use",
};
// The public hosted API/MCP: everything whose licence allows public redistribution.
PRESETS["hosted"] = ALL_MODULES.map((m) => m.id).filter((id) => !(id in HOSTED_EXCLUDED));

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

let proxyAll = false;

/**
 * Whether call_tool / find_tools / describe_tool may reach modules that are
 * not loaded. Off by default, so an operator's module selection is also a
 * security boundary; the `discovery` preset (or SWISSYPHUS_PROXY_ALL=1) turns
 * it on deliberately.
 */
export function setProxyAll(v: boolean): void {
  proxyAll = v;
}

/** Modules whose tools call_tool may invoke. */
export function getReachableModules(): SwissyphusModule[] {
  return proxyAll ? ALL_MODULES : activeModules;
}

/** Timeouts of the two attempts per health probe (first, retry). */
export const HEALTH_PROBE_TIMEOUTS_MS = [12_000, 20_000];

export interface HealthResult {
  source_id: string;
  module: string;
  status: "healthy" | "unreachable";
  ok: boolean;
  http_status?: number;
  latency_ms?: number;
  error?: string;
}

/**
 * Live probe round against every upstream source behind the active modules.
 * Uncached — only the `doctor` CLI should call this directly; request paths
 * (REST /v1/health/sources, the check_source_health tool) go through
 * getHealthSnapshot() so they cannot be used to amplify traffic upstream.
 */
export async function runHealthChecks(moduleFilter?: string): Promise<HealthResult[]> {
  const mods = getActiveModules().filter((m) => !moduleFilter || m.id === moduleFilter.toLowerCase());
  const probes = mods.flatMap((m) => (m.healthProbes ?? []).map((p) => ({ module: m.id, probe: p })));
  // One probe = up to two attempts: a slow-but-up source (a 12 s+ response on a busy
  // day) is retried once with a longer timeout before it is reported as down, so
  // a single sluggish answer does not raise a false alarm.
  const attempt = async (probe: HealthProbe, timeoutMs: number) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(probe.url, {
        method: probe.method ?? "GET",
        body: probe.body,
        headers: { "User-Agent": `swissyphus/${VERSION} (health check)`, ...(probe.headers ?? {}) },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };
  return Promise.all(
    probes.map(async ({ module, probe }): Promise<HealthResult> => {
      let lastError: unknown;
      for (const timeoutMs of HEALTH_PROBE_TIMEOUTS_MS) {
        const started = Date.now();
        try {
          const res = await attempt(probe, timeoutMs);
          return {
            source_id: probe.sourceId,
            module,
            status: res.ok ? "healthy" : "unreachable",
            ok: res.ok,
            http_status: res.status,
            latency_ms: Date.now() - started,
          };
        } catch (err) {
          lastError = err;
        }
      }
      return {
        source_id: probe.sourceId,
        module,
        status: "unreachable",
        ok: false,
        error: lastError instanceof Error ? (lastError.name === "AbortError" ? "timed out" : lastError.message) : String(lastError),
      };
    }),
  );
}

// --- Cached health snapshot (review S5) -------------------------------------
// A full probe round fires one request at every upstream source (~25 public
// government endpoints). Request paths share one cached snapshot per TTL, and
// concurrent callers during a refresh share the single in-flight round
// (single-flight), so no client can turn /v1/health/sources or
// check_source_health into an upstream request amplifier.

export const DEFAULT_HEALTH_TTL_SECONDS = 60;

export interface HealthSnapshot {
  /** ISO timestamp at which the probe round started. */
  checked_at: string;
  /** Seconds between checked_at and the moment this snapshot was served. */
  age_seconds: number;
  /** true when served from cache (this call fired no probes). */
  cached: boolean;
  results: HealthResult[];
}

export interface HealthCacheOptions {
  /** Probe-round runner; injectable for tests. Defaults to runHealthChecks() over all active modules. */
  probe?: () => Promise<HealthResult[]>;
  /** Cache TTL in ms. Defaults to SWISSYPHUS_HEALTH_TTL_SECONDS (60 s). 0 = no caching (single-flight still applies). */
  ttlMs?: number;
  /** Clock; injectable for tests. */
  now?: () => number;
  /** Cache key; the snapshot is discarded when it changes (e.g. the active module set). */
  key?: () => unknown;
}

export function healthTtlMsFromEnv(): number {
  const raw = process.env["SWISSYPHUS_HEALTH_TTL_SECONDS"];
  const n = raw === undefined || raw === "" ? DEFAULT_HEALTH_TTL_SECONDS : Number(raw);
  return (Number.isFinite(n) && n >= 0 ? n : DEFAULT_HEALTH_TTL_SECONDS) * 1000;
}

export interface HealthCache {
  get(opts?: { module?: string }): Promise<HealthSnapshot>;
  /** Drop the cached snapshot (a round already in flight is still shared). */
  clear(): void;
}

export function createHealthCache(options: HealthCacheOptions = {}): HealthCache {
  const probe = options.probe ?? (() => runHealthChecks());
  const now = options.now ?? Date.now;
  const keyOf = options.key ?? (() => undefined);
  type Round = { at: number; key: unknown; results: HealthResult[] };
  let snapshot: Round | undefined;
  let inflight: { key: unknown; promise: Promise<Round> } | undefined;

  const refresh = (key: unknown): Promise<Round> => {
    if (inflight && inflight.key === key) return inflight.promise;
    const at = now();
    const promise = probe()
      .then((results): Round => {
        snapshot = { at, key, results };
        return snapshot;
      })
      .finally(() => {
        if (inflight?.promise === promise) inflight = undefined;
      });
    inflight = { key, promise };
    return promise;
  };

  return {
    async get(opts = {}) {
      const ttlMs = options.ttlMs ?? healthTtlMsFromEnv();
      const key = keyOf();
      const fresh = snapshot && snapshot.key === key && ttlMs > 0 && now() - snapshot.at < ttlMs;
      const round = fresh && snapshot ? snapshot : await refresh(key);
      const filter = opts.module?.toLowerCase();
      return {
        checked_at: new Date(round.at).toISOString(),
        age_seconds: Math.max(0, Math.round((now() - round.at) / 1000)),
        cached: Boolean(fresh),
        results: filter ? round.results.filter((r) => r.module === filter) : round.results,
      };
    },
    clear() {
      snapshot = undefined;
    },
  };
}

const sharedHealthCache = createHealthCache({ key: () => activeModules });

/**
 * Cached health snapshot for request paths (REST + MCP tool). TTL from
 * SWISSYPHUS_HEALTH_TTL_SECONDS (default 60). One probe round covers all
 * active modules; `module` filters the shared snapshot instead of probing again.
 */
export function getHealthSnapshot(opts: { module?: string } = {}): Promise<HealthSnapshot> {
  return sharedHealthCache.get(opts);
}
