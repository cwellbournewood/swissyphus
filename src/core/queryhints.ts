/**
 * Query understanding for find_data / find_tools.
 *
 * Swiss catalogue metadata is German-first and topic-based, while people ask
 * "Aargau traffic". Three cheap, deterministic steps make that work:
 *  1. pull canton names out of the query (a place is a filter, not a topic —
 *     AND-matching catalogues return nothing for "Verkehr Aargau");
 *  2. translate common English topic words to the German catalogue term;
 *  3. recognise questions about things Swissyphus does NOT connect, and say so
 *     immediately with the nearest alternatives (an agent that doesn't know a
 *     source is missing will search for minutes).
 */

export interface Canton {
  code: string;
  name: string;
  bfs: number;
}

const CANTONS: Array<Canton & { aliases: string[] }> = [
  { code: "ZH", name: "Zürich", bfs: 1, aliases: ["zürich", "zurich", "zuerich", "zurigo"] },
  { code: "BE", name: "Bern", bfs: 2, aliases: ["bern", "berne", "berna"] },
  { code: "LU", name: "Luzern", bfs: 3, aliases: ["luzern", "lucerne", "lucerna"] },
  { code: "UR", name: "Uri", bfs: 4, aliases: ["uri"] },
  { code: "SZ", name: "Schwyz", bfs: 5, aliases: ["schwyz", "svitto"] },
  { code: "OW", name: "Obwalden", bfs: 6, aliases: ["obwalden", "obwald", "obvaldo"] },
  { code: "NW", name: "Nidwalden", bfs: 7, aliases: ["nidwalden", "nidwald", "nidvaldo"] },
  { code: "GL", name: "Glarus", bfs: 8, aliases: ["glarus", "glaris", "glarona"] },
  { code: "ZG", name: "Zug", bfs: 9, aliases: ["zug", "zoug", "zugo"] },
  { code: "FR", name: "Fribourg", bfs: 10, aliases: ["fribourg", "freiburg", "friburgo"] },
  { code: "SO", name: "Solothurn", bfs: 11, aliases: ["solothurn", "soleure", "soletta"] },
  { code: "BS", name: "Basel-Stadt", bfs: 12, aliases: ["basel-stadt", "basel stadt", "bâle-ville", "basilea città"] },
  { code: "BL", name: "Basel-Landschaft", bfs: 13, aliases: ["basel-landschaft", "baselland", "basel-land", "bâle-campagne"] },
  { code: "SH", name: "Schaffhausen", bfs: 14, aliases: ["schaffhausen", "schaffhouse", "sciaffusa"] },
  { code: "AR", name: "Appenzell Ausserrhoden", bfs: 15, aliases: ["appenzell ausserrhoden", "ausserrhoden"] },
  { code: "AI", name: "Appenzell Innerrhoden", bfs: 16, aliases: ["appenzell innerrhoden", "innerrhoden"] },
  { code: "SG", name: "St. Gallen", bfs: 17, aliases: ["st. gallen", "st gallen", "sankt gallen", "saint-gall", "san gallo"] },
  { code: "GR", name: "Graubünden", bfs: 18, aliases: ["graubünden", "graubuenden", "grisons", "grigioni", "grischun"] },
  { code: "AG", name: "Aargau", bfs: 19, aliases: ["aargau", "argovie", "argovia"] },
  { code: "TG", name: "Thurgau", bfs: 20, aliases: ["thurgau", "thurgovie", "turgovia"] },
  { code: "TI", name: "Ticino", bfs: 21, aliases: ["ticino", "tessin"] },
  { code: "VD", name: "Vaud", bfs: 22, aliases: ["vaud", "waadt"] },
  { code: "VS", name: "Valais", bfs: 23, aliases: ["valais", "wallis", "vallese"] },
  { code: "NE", name: "Neuchâtel", bfs: 24, aliases: ["neuchâtel", "neuchatel", "neuenburg"] },
  { code: "GE", name: "Genève", bfs: 25, aliases: ["genève", "geneve", "geneva", "genf", "ginevra"] },
  { code: "JU", name: "Jura", bfs: 26, aliases: ["jura", "canton jura"] },
];

/** English (and a few French/Italian) topic words → German catalogue term. */
const GLOSSARY: Record<string, string> = {
  traffic: "Verkehr",
  trafic: "Verkehr",
  traffico: "Verkehr",
  "traffic counts": "Verkehrszählung",
  "traffic count": "Verkehrszählung",
  accidents: "Unfälle",
  accident: "Unfall",
  population: "Bevölkerung",
  inhabitants: "Einwohner",
  residents: "Einwohner",
  rent: "Miete",
  rents: "Mieten",
  housing: "Wohnungen",
  vacancy: "Leerwohnungen",
  vacancies: "Leerwohnungen",
  noise: "Lärm",
  parking: "Parkhaus",
  electricity: "Strom",
  energy: "Energie",
  tax: "Steuer",
  taxes: "Steuern",
  school: "Schule",
  schools: "Schulen",
  students: "Schüler",
  hospital: "Spital",
  hospitals: "Spitäler",
  health: "Gesundheit",
  unemployment: "Arbeitslosigkeit",
  jobs: "Beschäftigte",
  employment: "Beschäftigung",
  wages: "Löhne",
  salaries: "Löhne",
  prices: "Preise",
  inflation: "Landesindex der Konsumentenpreise",
  "air quality": "Luftqualität",
  pollution: "Luftbelastung",
  water: "Wasser",
  groundwater: "Grundwasser",
  forest: "Wald",
  agriculture: "Landwirtschaft",
  farms: "Landwirtschaftsbetriebe",
  elections: "Wahlen",
  election: "Wahlen",
  votes: "Abstimmungen",
  vote: "Abstimmung",
  crime: "Kriminalität",
  tourism: "Tourismus",
  hotels: "Hotellerie",
  "overnight stays": "Logiernächte",
  births: "Geburten",
  deaths: "Todesfälle",
  marriages: "Heiraten",
  migration: "Migration",
  foreigners: "Ausländer",
  bicycle: "Velo",
  bicycles: "Velo",
  bike: "Velo",
  cars: "Personenwagen",
  vehicles: "Fahrzeuge",
  buildings: "Gebäude",
  construction: "Bau",
  "building permits": "Baubewilligungen",
  waste: "Abfall",
  recycling: "Recycling",
  trees: "Bäume",
  radon: "Radon",
  "solar": "Solar",
  budget: "Budget",
  finances: "Finanzen",
  companies: "Unternehmen",
  businesses: "Unternehmen",
  commuters: "Pendler",
  commuting: "Pendler",
  "public transport": "öffentlicher Verkehr",
};

export interface CoverageGap {
  topic: string;
  keywords: RegExp;
  note: string;
}

/** Things people ask for that Swissyphus does not (yet) connect — say so fast. */
export const COVERAGE_GAPS: CoverageGap[] = [
  {
    topic: "live road traffic",
    keywords: /\b(traffic|verkehr\w*|trafic|traffico|stau|jam|congestion|road closure|strassensperrung|baustelle)\b/i,
    note:
      "Live road traffic (current jams, incidents, road closures — ASTRA/VMZ-CH) is NOT connected: it requires an ASTRA data key. " +
      "Available instead: traffic COUNT statistics (search 'Verkehrszählung' — LINDAS cubes, opendata.swiss, cantonal portals), " +
      "road-noise exposure per location (get_location_report), public-transport disruptions (get_transport_disruptions, free key) and timetables (get_connections).",
  },
  {
    topic: "sanctions lists",
    keywords: /\b(sanction\w*|sesam|embargo)\b/i,
    note: "The SECO sanctions list is not connected yet (planned). Company checks available: search_companies, lookup_uid, search_sogc_publications, search_court_decisions.",
  },
  {
    topic: "FINMA registers",
    keywords: /\b(finma|bank licen[cs]e|warning list|warnliste)\b/i,
    note: "FINMA's authorised-institution and warning lists are not connected yet (planned).",
  },
  {
    topic: "public procurement",
    keywords: /\b(simap|procurement|tender\w*|ausschreibung\w*|beschaffung\w*)\b/i,
    note: "SIMAP public procurement is not connected yet (planned). Try find_data for procurement statistics.",
  },
  {
    topic: "fuel prices",
    keywords: /\b(fuel|petrol|gasoline|diesel|benzin\w*)\s*price/i,
    note: "Live fuel-station prices are not published as Swiss open data. The consumer price index (LIK) covers fuel price trends (find_data 'Landesindex Treibstoff').",
  },
];

export interface QueryAnalysis {
  original: string;
  /** Topic words only (place names removed), translated to German where known. */
  topic: string;
  canton?: Canton;
  gaps: CoverageGap[];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function analyzeQuery(query: string): QueryAnalysis {
  let rest = ` ${query.toLowerCase()} `;
  let canton: Canton | undefined;
  for (const c of CANTONS) {
    const aliases = [...c.aliases, `kanton ${c.aliases[0]}`, `canton ${c.aliases[0]}`, `canton of ${c.aliases[0]}`];
    for (const a of aliases.sort((x, y) => y.length - x.length)) {
      const re = new RegExp(`(^|[\\s,;])(${escapeRe(a)})(?=$|[\\s,;?!.])`, "i");
      if (re.test(rest)) {
        canton = { code: c.code, name: c.name, bfs: c.bfs };
        rest = rest.replace(re, "$1 ");
        break;
      }
    }
    if (canton) break;
  }
  rest = rest.replace(/\b(kanton|canton|cantone|in|im|of|the|for|data|daten)\b/g, " ");
  // Translate multi-word glossary entries first, then single words.
  const entries = Object.entries(GLOSSARY).sort((a, b) => b[0].length - a[0].length);
  for (const [en, de] of entries) {
    const re = new RegExp(`(^|\\s)${escapeRe(en)}(?=\\s|$)`, "gi");
    rest = rest.replace(re, `$1${de}`);
  }
  const topic = rest.replace(/[?!.,;]/g, " ").replace(/\s+/g, " ").trim();
  const gaps = COVERAGE_GAPS.filter((g) => g.keywords.test(query));
  return { original: query, topic: topic || query.trim(), ...(canton ? { canton } : {}), gaps };
}
