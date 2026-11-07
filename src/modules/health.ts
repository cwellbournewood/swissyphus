/**
 * Health module — infectious-disease surveillance from the Federal Office of
 * Public Health (FOPH/BAG) "IDD" dashboard (idd.bag.admin.ch).
 *
 * The FOPH publishes one CSV per topic (mandatory reporting "_oblig",
 * Sentinella GP network "_sentinella", wastewater monitoring, genomic
 * surveillance) at /api/v1/export/latest/{TOPIC}/csv. All share a common
 * shape: valueCategory, temporal (2026-W05 / 2026-M01 / 2026 / date),
 * temporal_type, georegion(+_type) — or georegion1/georegion2 for wastewater
 * plants — and dimension columns (agegroup, sex, type, pathogen, subtype, …)
 * that contain "all" for the total. We download a topic at most every few
 * hours, keep the text in a small LRU and filter rows per request.
 */

import { z } from "zod";
import { allowHosts, fetchCached } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { CacheStatus, SourceManifest } from "../core/types.js";

allowHosts("www.idd.bag.admin.ch", "idd.bag.admin.ch");

const foph: SourceManifest = {
  id: "foph-idd",
  name: "FOPH — infectious disease dashboard (IDD) open data",
  operator: "Federal Office of Public Health (FOPH/BAG), Communicable Diseases Division",
  url: "https://www.idd.bag.admin.ch",
  licence: "opendata.swiss terms: open use, must provide the source (terms_by)",
  attribution: "Source: Federal Office of Public Health FOPH, idd.bag.admin.ch",
  updateFrequency: "weekly (mostly Wednesdays); wastewater several times a week",
  cacheTtlSeconds: 6 * 3600,
  notes:
    "CSV exports per topic from /api/v1/export/latest/{TOPIC}/csv (as listed on opendata.swiss). Recent periods are " +
    "provisional (dataComplete=false) and are revised. 'incValue' is per 100'000 inhabitants. Mandatory-reporting data " +
    "covers Switzerland and Liechtenstein (CHFL); Sentinella data is an extrapolation from a GP sample.",
};

const BASE = "https://www.idd.bag.admin.ch/api/v1/export/latest";

export interface DiseaseTopic {
  id: string;
  export: string;
  label: string;
  system: "mandatory reporting" | "Sentinella GP network" | "wastewater monitoring" | "genomic surveillance";
  resolution: string;
}

export const TOPICS: DiseaseTopic[] = [
  { id: "influenza", export: "INFLUENZA_oblig", label: "Influenza — laboratory-confirmed cases", system: "mandatory reporting", resolution: "week" },
  { id: "influenza_sentinella", export: "INFLUENZA_sentinella", label: "Influenza-like illness — GP consultations", system: "Sentinella GP network", resolution: "week" },
  { id: "respiratory_viruses_sentinella", export: "RESPVIRUSES_sentinella", label: "Respiratory viruses (influenza, RSV, SARS-CoV-2) — detections in Sentinella samples", system: "Sentinella GP network", resolution: "week" },
  { id: "respiratory_viruses_wastewater", export: "RESPVIRUSES_wastewater", label: "Respiratory viruses in wastewater (influenza A/B, RSV, SARS-CoV-2) per treatment plant", system: "wastewater monitoring", resolution: "day" },
  { id: "covid19", export: "COVID19_oblig", label: "COVID-19 — laboratory-confirmed cases", system: "mandatory reporting", resolution: "week" },
  { id: "covid19_sentinella", export: "COVID19_sentinella", label: "COVID-19 suspected cases — GP consultations", system: "Sentinella GP network", resolution: "week" },
  { id: "covid19_variants", export: "COVID19_genomic_surveillance", label: "SARS-CoV-2 variants (genomic surveillance)", system: "genomic surveillance", resolution: "month" },
  { id: "covid19_wastewater_variants", export: "COVID19_wastewater_sequencing", label: "SARS-CoV-2 variants in wastewater", system: "wastewater monitoring", resolution: "day" },
  { id: "lyme", export: "LYME_sentinella", label: "Lyme borreliosis — GP consultations for tick bites/erythema migrans", system: "Sentinella GP network", resolution: "month" },
  { id: "tbe", export: "TBE_oblig", label: "Tick-borne encephalitis (TBE/FSME)", system: "mandatory reporting", resolution: "month" },
  { id: "tularemia", export: "TULAREMIA_oblig", label: "Tularaemia", system: "mandatory reporting", resolution: "month" },
  { id: "campylobacteriosis", export: "CAMPYLOBACTERIOSIS_oblig", label: "Campylobacteriosis", system: "mandatory reporting", resolution: "month" },
  { id: "salmonellosis", export: "SALMONELLOSIS_oblig", label: "Salmonellosis", system: "mandatory reporting", resolution: "month" },
  { id: "shigellosis", export: "SHIGELLOSIS_oblig", label: "Shigellosis", system: "mandatory reporting", resolution: "month" },
  { id: "hepatitis_a", export: "HEPATITIS_A_oblig", label: "Hepatitis A", system: "mandatory reporting", resolution: "month" },
  { id: "hepatitis_b", export: "HEPATITIS_B_oblig", label: "Hepatitis B", system: "mandatory reporting", resolution: "month" },
  { id: "hepatitis_c", export: "HEPATITIS_C_oblig", label: "Hepatitis C", system: "mandatory reporting", resolution: "month" },
  { id: "hepatitis_e", export: "HEPATITIS_E_oblig", label: "Hepatitis E", system: "mandatory reporting", resolution: "month" },
  { id: "hiv", export: "HIV_oblig", label: "HIV", system: "mandatory reporting", resolution: "month" },
  { id: "aids", export: "AIDS_oblig", label: "AIDS", system: "mandatory reporting", resolution: "year" },
  { id: "chlamydia", export: "CHLAMYDIOSIS_oblig", label: "Chlamydia", system: "mandatory reporting", resolution: "month" },
  { id: "gonorrhoea", export: "GONORRHEA_oblig", label: "Gonorrhoea", system: "mandatory reporting", resolution: "month" },
  { id: "syphilis", export: "SYPHILIS_oblig", label: "Syphilis", system: "mandatory reporting", resolution: "month" },
];

const TOPIC_IDS = TOPICS.map((t) => t.id) as [string, ...string[]];

/** Columns that hold a breakdown dimension; rows with "all" are the total. */
const DIMENSIONS = ["agegroup", "sex", "type", "testResult_type", "pathogen", "subtype", "testResult"];

/** Numeric columns worth returning, in display order (only those present). */
const VALUE_COLUMNS = [
  "value",
  "incValue",
  "prct",
  "prctConsultations",
  "prctPathogen",
  "conc",
  "valueMean7d",
  "valuePercentileMean7d",
  "valueYearCumSum",
  "valueMean5y",
  "valueMean3y",
  "lowerCi",
  "upperCi",
  "trend",
  "pop",
];

/** Split one CSV line (IDD exports are unquoted; fall back to a quote-aware split). */
export function splitCsvLine(line: string): string[] {
  if (!line.includes('"')) return line.split(",");
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const num = (v: string | undefined): number | string | undefined => {
  if (v === undefined || v === "" || v === "NA") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
};

export interface FilterOptions {
  region: string;
  valueCategory?: string;
  breakdown?: string;
  filters?: Record<string, string>;
  lastPeriods: number;
  from?: string;
}

export interface FilterResult {
  columns: string[];
  value_categories: string[];
  regions: string[];
  breakdown_values?: string[];
  value_category?: string;
  rows: Array<Record<string, unknown>>;
  periods: number;
}

/**
 * Filter an IDD CSV to one region and value category. Dimension columns are
 * pinned to "all" (if that value exists) except the requested breakdown and any
 * explicit filters. Returns the last `lastPeriods` periods (or those ≥ from).
 */
export function filterIdd(csv: string, o: FilterOptions): FilterResult {
  const text = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv;
  const lines = text.split(/\r?\n/);
  const header = splitCsvLine(lines[0] ?? "");
  const col = (name: string) => header.indexOf(name);
  const iCat = col("valueCategory");
  const iT = col("temporal");
  const regionCols = ["georegion", "georegion1", "georegion2"].map(col).filter((i) => i >= 0);
  const dimCols = DIMENSIONS.map((d) => [d, col(d)] as const).filter(([, i]) => i >= 0);
  const valCols = VALUE_COLUMNS.map((v) => [v, col(v)] as const).filter(([, i]) => i >= 0);
  const iComplete = col("dataComplete");

  const want = o.region.trim().toLowerCase();
  const cats = new Set<string>();
  const regions = new Set<string>();
  const dimAll = new Map<string, boolean>();
  const matched: string[][] = [];
  for (let li = 1; li < lines.length; li++) {
    const line = lines[li];
    if (!line) continue;
    const f = splitCsvLine(line);
    if (iCat >= 0) cats.add(f[iCat]!);
    for (const i of regionCols) if (f[i] && f[i] !== "NA") regions.add(f[i]!);
    if (!regionCols.some((i) => (f[i] ?? "").toLowerCase() === want)) continue;
    for (const [d, i] of dimCols) if (f[i] === "all") dimAll.set(d, true);
    matched.push(f);
  }
  const catList = [...cats].sort();
  const preferred = ["cases", "consultations", "detections"].find((c) => cats.has(c));
  const category = o.valueCategory ?? preferred ?? catList[0];
  let rows = matched.filter((f) => iCat < 0 || f[iCat] === category);
  for (const [d, i] of dimCols) {
    const explicit = o.filters?.[d];
    if (explicit !== undefined) rows = rows.filter((f) => (f[i] ?? "").toLowerCase() === explicit.toLowerCase());
    else if (d !== o.breakdown && dimAll.get(d)) rows = rows.filter((f) => f[i] === "all");
  }
  // Drop rows that carry no measurement at all (e.g. wastewater days not yet analysed).
  const measureIdx = ["value", "conc", "valueMean7d", "prct"].map(col).filter((i) => i >= 0);
  if (measureIdx.length) rows = rows.filter((f) => measureIdx.some((i) => num(f[i]) !== undefined));
  const breakdownIdx = o.breakdown ? col(o.breakdown) : -1;
  const periods = [...new Set(rows.map((f) => f[iT]!))].sort();
  const keep = new Set(o.from ? periods.filter((p) => p >= o.from!) : periods.slice(-o.lastPeriods));
  const out = rows
    .filter((f) => keep.has(f[iT]!))
    .map((f) => {
      const r: Record<string, unknown> = { period: f[iT] };
      if (regionCols.length > 1) {
        r["region"] = f[regionCols[0]!];
        r["site"] = f[regionCols[1]!];
      }
      if (breakdownIdx >= 0) r[o.breakdown!] = f[breakdownIdx];
      for (const [d, i] of dimCols) {
        if (d !== o.breakdown && f[i] !== "all" && f[i] !== undefined && !(o.filters && d in o.filters)) r[d] = f[i];
      }
      for (const [v, i] of valCols) {
        const x = num(f[i]);
        if (x !== undefined) r[v] = x;
      }
      if (iComplete >= 0 && f[iComplete] === "FALSE") r["provisional"] = true;
      return r;
    })
    .sort((a, b) => String(a["period"]).localeCompare(String(b["period"])));
  return {
    columns: header,
    value_categories: catList,
    regions: [...regions].sort(),
    ...(breakdownIdx >= 0 ? { breakdown_values: [...new Set(rows.map((f) => f[breakdownIdx]!))].sort() } : {}),
    value_category: category,
    rows: out,
    periods: keep.size,
  };
}

// Small LRU of downloaded topic texts (the largest export is ~30 MB).
const MAX_CACHED_TOPICS = 4;
const topicCache = new Map<string, { text: string; at: number; retrievedAt: string; cacheStatus: CacheStatus }>();

async function loadTopic(t: DiseaseTopic) {
  const hit = topicCache.get(t.export);
  if (hit && Date.now() - hit.at < foph.cacheTtlSeconds * 1000) {
    topicCache.delete(t.export);
    topicCache.set(t.export, hit);
    return { ...hit, cacheStatus: "hit" as CacheStatus };
  }
  const res = await fetchCached(`${BASE}/${t.export}/csv`, {
    ttlMs: foph.cacheTtlSeconds * 1000,
    timeoutMs: 60_000,
    maxBytes: 64 * 1024 * 1024,
    noStore: true,
    init: { headers: { Accept: "text/csv,application/csv" } },
  });
  const entry = { text: res.data, at: Date.now(), retrievedAt: res.retrievedAt, cacheStatus: res.cacheStatus };
  topicCache.set(t.export, entry);
  while (topicCache.size > MAX_CACHED_TOPICS) topicCache.delete(topicCache.keys().next().value!);
  return entry;
}

export const healthModule: SwissyphusModule = {
  id: "health",
  emoji: "🦠",
  title: "Infectious diseases (FOPH)",
  description:
    "Official infectious-disease surveillance from the Federal Office of Public Health: influenza, COVID-19, RSV, wastewater virus loads, tick-borne diseases, food-borne infections, hepatitis, HIV and STIs — weekly/monthly cases and incidence by canton",
  sources: [foph],
  healthProbes: [{ sourceId: "foph-idd", url: `${BASE}/AIDS_oblig/csv` }],
  tools: [
    tool({
      name: "list_disease_surveillance_topics",
      title: "FOPH disease surveillance topics",
      description:
        "Topics available from the FOPH infectious-disease dashboard (id, disease, surveillance system, time resolution). Use the id with get_disease_surveillance.",
      inputSchema: {},
      handler: async () =>
        respond(
          { topics: TOPICS.map(({ id, label, system, resolution }) => ({ id, label, system, resolution })) },
          { source: foph, cacheStatus: "computed", retrievedAt: new Date().toISOString() },
        ),
    }),
    tool({
      name: "get_disease_surveillance",
      title: "Infectious disease cases & incidence",
      description:
        "Latest surveillance data for one FOPH topic and region: reported cases (or GP consultations / detections / wastewater load) per week, month or year, with incidence per 100'000 and trend where published. " +
        "region: 'CHFL' (Switzerland + Liechtenstein, default for mandatory reporting), 'CH', a canton code ('ZH'), or a wastewater plant (e.g. 'basel'). " +
        "breakdown: 'agegroup', 'sex', 'pathogen' or 'subtype' (variants) to split the totals. Recent periods are provisional. Example: {topic: 'influenza', region: 'ZH', last_periods: 8}.",
      inputSchema: {
        topic: z.enum(TOPIC_IDS).describe("Topic id from list_disease_surveillance_topics, e.g. 'influenza', 'covid19', 'tbe', 'respiratory_viruses_wastewater'"),
        region: z.string().min(2).max(40).default("CHFL").describe("CHFL, CH, FL, a canton code (ZH, BE, …) or a wastewater plant name"),
        last_periods: z.number().int().min(1).max(260).default(12).describe("Number of most recent periods (weeks/months/years) to return"),
        from: z.string().max(12).optional().describe("Return all periods from this one on instead, e.g. '2025-W40', '2024-M01', '2025-10-01'"),
        value_category: z.string().max(60).optional().describe("Measure, e.g. 'cases', 'consultations', 'detections', or a virus for wastewater ('influenza_a', 'sars-cov-2'); defaults to the main one"),
        breakdown: z.enum(["agegroup", "sex", "pathogen", "subtype", "type"]).optional().describe("Split totals by this dimension"),
        filters: z.record(z.string(), z.string().max(60)).optional().describe("Pin other dimensions, e.g. {pathogen: 'influenza'}"),
      },
      handler: async ({ topic, region, last_periods, from, value_category, breakdown, filters }) => {
        const t = TOPICS.find((x) => x.id === topic)!;
        try {
          const loaded = await loadTopic(t);
          const opts = { valueCategory: value_category, breakdown, filters, lastPeriods: last_periods, from };
          let r = filterIdd(loaded.text, { region, ...opts });
          // Sentinella/wastewater topics report 'CH', mandatory reporting 'CHFL': accept either for the national total.
          if (!r.rows.length && /^(chfl|ch)$/i.test(region)) {
            const alt = region.toUpperCase() === "CHFL" ? "CH" : "CHFL";
            const r2 = filterIdd(loaded.text, { region: alt, ...opts });
            if (r2.rows.length) {
              r = r2;
              region = alt;
            }
          }
          if (!r.rows.length) {
            return toolError(`No ${t.label} data for region '${region}'${r.value_category ? ` (${r.value_category})` : ""}.`, [
              `Regions in this topic: ${r.regions.slice(0, 40).join(", ")}${r.regions.length > 40 ? ", …" : ""}.`,
              `Value categories: ${r.value_categories.join(", ")}.`,
            ]);
          }
          return respond(
            {
              topic: { id: t.id, label: t.label, system: t.system, resolution: t.resolution },
              region,
              value_category: r.value_category,
              ...(r.value_categories.length > 1 ? { other_value_categories: r.value_categories.filter((c) => c !== r.value_category) } : {}),
              ...(r.breakdown_values ? { breakdown, breakdown_values: r.breakdown_values } : {}),
              periods: r.periods,
              rows: r.rows.slice(-600),
              ...(r.rows.length > 600 ? { truncated: `showing the last 600 of ${r.rows.length} rows; narrow with last_periods` } : {}),
              notes: "incValue = per 100'000 inhabitants. Rows flagged provisional are still being completed by the FOPH.",
            },
            { source: foph, cacheStatus: loaded.cacheStatus, retrievedAt: loaded.retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "FOPH infectious disease dashboard");
        }
      },
    }),
  ],
};
