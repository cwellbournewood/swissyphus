/**
 * Canton codes and names (DE/FR/IT/EN, plus common short forms), with a
 * diacritic-insensitive normaliser for free-text region filters.
 */

export const CANTON_CODES = [
  "AG", "AI", "AR", "BE", "BL", "BS", "FR", "GE", "GL", "GR", "JU", "LU", "NE",
  "NW", "OW", "SG", "SH", "SO", "SZ", "TG", "TI", "UR", "VD", "VS", "ZG", "ZH",
] as const;

export type CantonCode = (typeof CANTON_CODES)[number];

/** Names per canton in German, French, Italian, English (+ frequent short forms). */
export const CANTON_NAMES: Record<CantonCode, string[]> = {
  AG: ["Aargau", "Argovie", "Argovia"],
  AI: ["Appenzell Innerrhoden", "Appenzell Rhodes-Intérieures", "Appenzello Interno", "Appenzell Inner Rhodes"],
  AR: ["Appenzell Ausserrhoden", "Appenzell Rhodes-Extérieures", "Appenzello Esterno", "Appenzell Outer Rhodes"],
  BE: ["Bern", "Berne", "Berna"],
  BL: ["Basel-Landschaft", "Bâle-Campagne", "Basilea Campagna", "Basel-Country", "Baselland"],
  BS: ["Basel-Stadt", "Bâle-Ville", "Basilea Città", "Basel-City"],
  FR: ["Freiburg", "Fribourg", "Friburgo"],
  GE: ["Genf", "Genève", "Ginevra", "Geneva"],
  GL: ["Glarus", "Glaris", "Glarona"],
  GR: ["Graubünden", "Grisons", "Grigioni", "Grischun"],
  JU: ["Jura", "Giura"],
  LU: ["Luzern", "Lucerne", "Lucerna"],
  NE: ["Neuenburg", "Neuchâtel"],
  NW: ["Nidwalden", "Nidwald", "Nidvaldo"],
  OW: ["Obwalden", "Obwald", "Obvaldo"],
  SG: ["St. Gallen", "Sankt Gallen", "Saint-Gall", "San Gallo", "St Gallen"],
  SH: ["Schaffhausen", "Schaffhouse", "Sciaffusa"],
  SO: ["Solothurn", "Soleure", "Soletta"],
  SZ: ["Schwyz", "Schwytz", "Svitto"],
  TG: ["Thurgau", "Thurgovie", "Turgovia"],
  TI: ["Tessin", "Ticino"],
  UR: ["Uri"],
  VD: ["Waadt", "Vaud"],
  VS: ["Wallis", "Valais", "Vallese"],
  ZG: ["Zug", "Zoug", "Zugo"],
  ZH: ["Zürich", "Zurich", "Zurigo"],
};

/** Lower-case, strip diacritics (NFD), fold ß and collapse whitespace. */
export function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Resolve a canton code or a name in any language to its two-letter code. */
export function resolveCanton(input: string): CantonCode | undefined {
  const raw = input.trim().toUpperCase().replace(/^CH-/, "");
  if ((CANTON_CODES as readonly string[]).includes(raw)) return raw as CantonCode;
  const q = normalizeText(input);
  for (const code of CANTON_CODES) {
    if (CANTON_NAMES[code].some((n) => normalizeText(n) === q)) return code;
  }
  return undefined;
}

/**
 * Build the list of normalised search terms for a region filter: the query
 * itself plus, if it names a canton in any language, all that canton's names.
 */
export function regionTerms(query: string): string[] {
  const terms = new Set<string>([normalizeText(query)]);
  const code = resolveCanton(query);
  if (code) for (const n of CANTON_NAMES[code]) terms.add(normalizeText(n));
  return [...terms].filter((t) => t.length > 0);
}

/**
 * True if any of the texts contains any of the (normalised) terms starting at
 * a word boundary ("uri" matches "Uri" but not "security"; "zurich" matches
 * "Zurichsee").
 */
export function matchesRegion(texts: Array<string | undefined | null>, terms: string[]): boolean {
  const hay = texts.filter((t): t is string => typeof t === "string").map(normalizeText);
  const res = terms.map(
    (t) => new RegExp(`(^|[^\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u"),
  );
  return hay.some((h) => res.some((re) => re.test(h)));
}
