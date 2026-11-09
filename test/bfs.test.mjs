/**
 * Offline tests for the BFS STAT-TAB (PXWeb) module. Fixtures mirror the PXWeb
 * API v1 shapes: metadata {title, variables:[{code,text,values,valueTexts,time?,elimination?}]},
 * data (format json) {columns, data:[{key, values}], metadata}, root listing [{dbid,text}],
 * node listing [{id,type,text,updated}].
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bfsModule,
  normalizeText,
  resolveTablePath,
  sanitizeBrowsePath,
  isTimeVariable,
  findAggregateIndex,
  matchVariable,
  matchValues,
  defaultSelection,
  buildSelection,
  buildQueryBody,
  estimateCells,
  parseCell,
  decodePxJson,
  decodeJsonStat2,
  decodeResponse,
  toLabelledRows,
  normalizeListing,
  rankListing,
  searchSeed,
  toBfsLang,
  BFS_SEED_TABLES,
  MAX_CELLS,
} from "../dist/modules/bfs.js";
import { getSearchers } from "../dist/core/discovery.js";

// ── Fixtures ─────────────────────────────────────────────────────────────

const years = Array.from({ length: 14 }, (_, i) => String(2010 + i)); // 2010..2023
const META = {
  title: "Ständige und nichtständige Wohnbevölkerung nach institutionellen Gliederungen, Staatsangehörigkeit (Kategorie), Geschlecht und Alter",
  variables: [
    { code: "Jahr", text: "Jahr", values: years, valueTexts: years, time: true },
    {
      code: "Kanton (-) / Bezirk (>>) / Gemeinde (......)",
      text: "Kanton (-) / Bezirk (>>) / Gemeinde (......)",
      values: ["8100", "ZH", "0261", "BE", "0351", "0371", "GE"],
      valueTexts: ["Schweiz", "- Zürich", "......0261 Zürich", "- Bern / Berne", "......0351 Bern", "......0371 Biel/Bienne", "- Genève"],
    },
    {
      code: "Bevölkerungstyp",
      text: "Bevölkerungstyp",
      values: ["1", "2"],
      valueTexts: ["Ständige Wohnbevölkerung", "Nichtständige Wohnbevölkerung"],
    },
    {
      code: "Staatsangehörigkeit (Kategorie)",
      text: "Staatsangehörigkeit (Kategorie)",
      values: ["-99999", "1", "2"],
      valueTexts: ["Staatsangehörigkeit (Kategorie) - Total", "Schweiz", "Ausland"],
      elimination: true,
    },
    {
      code: "Geschlecht",
      text: "Geschlecht",
      values: ["-99999", "1", "2"],
      valueTexts: ["Geschlecht - Total", "Mann", "Frau"],
      elimination: true,
    },
    {
      code: "Alter",
      text: "Alter",
      values: ["-99999", ...Array.from({ length: 101 }, (_, i) => String(i))],
      valueTexts: ["Alter - Total", ...Array.from({ length: 101 }, (_, i) => `${i} Jahre`)],
      elimination: true,
    },
  ],
};

const V = Object.fromEntries(META.variables.map((v) => [v.code, v]));
const KANTON = META.variables[1];

function stubFetch(handler) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? "GET", body: init.body };
    calls.push(call);
    const r = await handler(call);
    if (r instanceof Response) return r;
    return new Response(typeof r === "string" ? r : JSON.stringify(r), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, restore: () => (globalThis.fetch = orig) };
}

function parse(result) {
  return JSON.parse(result.content[0].text);
}

const toolByName = (n) => bfsModule.tools.find((t) => t.name === n);

// ── Pure helpers ─────────────────────────────────────────────────────────

test("bfs: module shape, tool names and health probe", () => {
  assert.equal(bfsModule.id, "bfs");
  assert.deepEqual(
    bfsModule.tools.map((t) => t.name).sort(),
    ["browse_bfs_tables", "get_bfs_table_metadata", "query_bfs_table", "search_bfs_tables"],
  );
  assert.ok(bfsModule.healthProbes.every((p) => p.url.startsWith("https://www.pxweb.bfs.admin.ch/api/v1/")));
  assert.ok(bfsModule.sources[0].notes.length > 50);
});

test("bfs: normalizeText strips accents, case and punctuation", () => {
  assert.equal(normalizeText("  Staatsangehörigkeit (Kategorie) "), "staatsangehorigkeit kategorie");
  assert.equal(normalizeText("Genève"), "geneve");
  assert.equal(normalizeText("......0261 Zürich"), "0261 zurich");
});

test("bfs: resolveTablePath accepts ids, paths and URLs; rejects traversal", () => {
  assert.equal(resolveTablePath("px-x-0102010000_101"), "px-x-0102010000_101/px-x-0102010000_101.px");
  assert.equal(resolveTablePath("px-x-0102010000_101.px"), "px-x-0102010000_101/px-x-0102010000_101.px");
  assert.equal(resolveTablePath("/px-x-0102010000_101/px-x-0102010000_101.px/"), "px-x-0102010000_101/px-x-0102010000_101.px");
  assert.equal(resolveTablePath("db/level/tab"), "db/level/tab.px");
  assert.equal(
    resolveTablePath("https://www.pxweb.bfs.admin.ch/pxweb/de/px-x-1003020000_101/-/px-x-1003020000_101.px/"),
    "px-x-1003020000_101/px-x-1003020000_101.px",
  );
  assert.equal(resolveTablePath("../etc/passwd"), undefined);
  assert.equal(resolveTablePath("a/../b"), undefined);
  assert.equal(resolveTablePath("x?query=1"), undefined);
  assert.equal(resolveTablePath("https://evil.example/whatever"), undefined);
  assert.equal(sanitizeBrowsePath(undefined), undefined);
  assert.equal(sanitizeBrowsePath("/"), undefined);
  assert.equal(sanitizeBrowsePath("a/b"), "a/b");
  assert.equal(sanitizeBrowsePath("a/../b"), null);
});

test("bfs: toBfsLang maps to supported languages", () => {
  assert.equal(toBfsLang("fr"), "fr");
  assert.equal(toBfsLang("de-CH"), "de");
  assert.equal(toBfsLang("rm"), "en");
  assert.equal(toBfsLang(undefined), "en");
});

test("bfs: isTimeVariable uses the time flag, names and year-like values", () => {
  assert.equal(isTimeVariable(V.Jahr), true);
  assert.equal(isTimeVariable({ code: "Année", values: ["a", "b"] }), true);
  assert.equal(isTimeVariable({ code: "Monat", values: ["2024M01", "2024M02"] }), true);
  assert.equal(isTimeVariable({ code: "X", values: ["2020", "2021", "2022"] }), true);
  assert.equal(isTimeVariable({ code: "X", values: ["2021Q1", "2021Q2"] }), true);
  assert.equal(isTimeVariable(V.Geschlecht), false);
  assert.equal(isTimeVariable(V.Alter), false);
  assert.equal(isTimeVariable(KANTON), false);
});

test("bfs: findAggregateIndex prefers -99999, then Total texts, then Schweiz", () => {
  assert.equal(findAggregateIndex(V.Geschlecht), 0);
  assert.equal(findAggregateIndex(KANTON), 0); // "Schweiz"
  assert.equal(findAggregateIndex(V.Bevölkerungstyp), -1);
  assert.equal(findAggregateIndex({ code: "Sex", values: ["1", "2", "T"], valueTexts: ["Male", "Female", "Total"] }), 2);
  assert.equal(
    findAggregateIndex({ code: "Nat", values: ["1", "2", "9"], valueTexts: ["Schweiz", "Ausland", "Nationalität - Total"] }),
    2,
    "a strong 'Total' beats a geographic 'Schweiz'",
  );
  assert.equal(findAggregateIndex({ code: "Art", values: ["a"], valueTexts: ["Allemagne"] }), -1, "'Alle' must be a whole word");
});

test("bfs: matchVariable by code, text, accents and partial; reports ambiguity", () => {
  const vars = META.variables;
  assert.equal(matchVariable(vars, "Geschlecht").variable.code, "Geschlecht");
  assert.equal(matchVariable(vars, "geschlecht").variable.code, "Geschlecht");
  assert.equal(matchVariable(vars, "staatsangehorigkeit").variable.code, "Staatsangehörigkeit (Kategorie)");
  assert.equal(matchVariable(vars, "Bevolkerungstyp").variable.code, "Bevölkerungstyp");
  assert.equal(matchVariable(vars, "kanton").variable, KANTON);
  assert.equal(matchVariable(vars, "gemeinde").variable, KANTON);
  assert.equal(matchVariable(vars, "nope").variable, undefined);
  const amb = matchVariable([{ code: "Kanton A" }, { code: "Kanton B" }], "kanton");
  assert.deepEqual(amb.ambiguous, ["Kanton A", "Kanton B"]);
});

test("bfs: matchValues handles codes, texts, *, latest, latest:N, ranges", () => {
  assert.deepEqual(matchValues(V.Geschlecht, ["Frau", "mann"]).codes, ["1", "2"]);
  assert.deepEqual(matchValues(V.Geschlecht, ["-99999"]).codes, ["-99999"]);
  assert.deepEqual(matchValues(V.Jahr, ["latest"]).codes, ["2023"]);
  assert.deepEqual(matchValues(V.Jahr, ["latest:3"]).codes, ["2021", "2022", "2023"]);
  assert.deepEqual(matchValues(V.Jahr, ["last 2"]).codes, ["2022", "2023"]);
  assert.deepEqual(matchValues(V.Jahr, ["2012-2014"]).codes, ["2012", "2013", "2014"]);
  assert.deepEqual(matchValues(V.Jahr, ["2019", "2011"]).codes, ["2011", "2019"], "metadata order");
  assert.equal(matchValues(V.Alter, ["*"]).codes.length, 102);
  // canton "- Zürich" wins over the commune "......0261 Zürich" on exact text
  assert.deepEqual(matchValues(KANTON, ["Zürich"]).codes, ["ZH"]);
  assert.deepEqual(matchValues(KANTON, ["zurich"]).codes, ["ZH"]);
  assert.deepEqual(matchValues(KANTON, ["0261"]).codes, ["0261"]);
  assert.deepEqual(matchValues(KANTON, ["Geneve"]).codes, ["GE"]);
  assert.deepEqual(matchValues(KANTON, ["Biel"]).codes, ["0371"]);
  assert.deepEqual(matchValues(KANTON, ["zh"]).codes, ["ZH"], "case-insensitive code");
});

test("bfs: matchValues reports ambiguous and unknown values with hints", () => {
  assert.deepEqual(matchValues(KANTON, ["Ber"]).codes, ["BE"], "prefix match beats substring");
  const amb = matchValues(KANTON, ["rich"]);
  assert.equal(amb.codes.length, 0);
  assert.match(amb.errors[0], /ambiguous/);
  const unk = matchValues(V.Geschlecht, ["divers"]);
  assert.match(unk.errors[0], /no value matches 'divers'.*-99999=Geschlecht - Total/);
  assert.match(matchValues(V.Jahr, ["1990-1995"]).errors[0], /no values in range/);
});

test("bfs: defaultSelection: latest time, total, elimination, first", () => {
  assert.deepEqual(defaultSelection(V.Jahr), { code: "Jahr", text: "Jahr", values: ["2023"], mode: "default-latest" });
  assert.equal(defaultSelection(V.Geschlecht).mode, "default-total");
  assert.deepEqual(defaultSelection(KANTON).values, ["8100"]);
  assert.equal(defaultSelection({ code: "A", values: ["x", "y"], valueTexts: ["X", "Y"], elimination: true }).mode, "eliminated");
  assert.deepEqual(defaultSelection(V.Bevölkerungstyp), {
    code: "Bevölkerungstyp",
    text: "Bevölkerungstyp",
    values: ["1"],
    mode: "default-first",
  });
});

test("bfs: estimateCells multiplies counts", () => {
  assert.equal(estimateCells([14, 7, 2, 3, 3, 101]), 14 * 7 * 2 * 3 * 3 * 101);
  assert.equal(estimateCells([]), 1);
  assert.equal(estimateCells([0, 5]), 5);
});

test("bfs: buildSelection resolves user input, fills defaults and counts cells", () => {
  const r = buildSelection(META, { jahr: "latest:2", Kanton: ["Zürich", "Bern / Berne"], geschlecht: ["*"] });
  assert.deepEqual(r.errors, []);
  const byCode = Object.fromEntries(r.selected.map((s) => [s.code, s]));
  assert.deepEqual(byCode.Jahr.values, ["2022", "2023"]);
  assert.deepEqual(byCode[KANTON.code].values, ["ZH", "BE"]);
  assert.deepEqual(byCode.Geschlecht.values, ["-99999", "1", "2"]);
  assert.equal(byCode.Alter.mode, "default-total");
  assert.equal(byCode.Bevölkerungstyp.mode, "default-first");
  assert.equal(r.cells, 2 * 2 * 3);
  assert.equal(r.defaults.length, 3);
  assert.ok(r.defaults.some((d) => d.includes("Bevölkerungstyp") && d.includes("first value 'Ständige Wohnbevölkerung'")));
  assert.ok(r.defaults.some((d) => d.includes("aggregate 'Alter - Total'")));

  const bad = buildSelection(META, { Farbe: ["rot"], Geschlecht: ["divers"] });
  assert.equal(bad.errors.length, 2);
  assert.match(bad.errors[0], /Unknown variable 'Farbe'/);

  const big = buildSelection(META, { Jahr: "*", Kanton: "*", Alter: "*" });
  assert.equal(big.cells, 14 * 7 * 102);
  assert.ok(big.cells > MAX_CELLS);

  // comma-separated string form
  assert.deepEqual(buildSelection(META, { Geschlecht: "Mann, Frau" }).selected.find((s) => s.code === "Geschlecht").values, ["1", "2"]);
});

test("bfs: buildQueryBody emits PXWeb item filters and skips eliminated variables", () => {
  const body = buildQueryBody(
    [
      { code: "Jahr", text: "Jahr", values: ["2023"], mode: "default-latest" },
      { code: "A", text: "A", values: [], mode: "eliminated" },
    ],
    "json",
  );
  assert.deepEqual(body, {
    query: [{ code: "Jahr", selection: { filter: "item", values: ["2023"] } }],
    response: { format: "json" },
  });
});

test("bfs: parseCell handles numbers and PXWeb symbols", () => {
  assert.equal(parseCell("1234"), 1234);
  assert.equal(parseCell("12.5"), 12.5);
  assert.equal(parseCell("-3"), -3);
  assert.equal(parseCell(7), 7);
  assert.equal(parseCell("..."), null);
  assert.equal(parseCell("-"), null);
  assert.equal(parseCell(""), null);
  assert.equal(parseCell(null), null);
});

const PX_JSON = {
  columns: [
    { code: "Jahr", text: "Jahr", type: "t" },
    { code: KANTON.code, text: KANTON.text, type: "d" },
    { code: "Geschlecht", text: "Geschlecht", type: "d" },
    { code: "px-x-0102010000_101", text: "Ständige und nichtständige Wohnbevölkerung", type: "c" },
  ],
  comments: [],
  data: [
    { key: ["2023", "ZH", "1"], values: ["795000"] },
    { key: ["2023", "ZH", "2"], values: ["810508"] },
    { key: ["2023", "BE", "1"], values: ["521000"] },
    { key: ["2023", "BE", "2"], values: ["..."] },
  ],
  metadata: [{ infofile: "", updated: "2024-08-29T06:30:00Z", label: "x", source: "BFS" }],
};

test("bfs: decodePxJson labels keys via metadata and toLabelledRows moves constants to fixed", () => {
  const sel = buildSelection(META, { Jahr: "latest", Kanton: ["ZH", "BE"], Geschlecht: ["1", "2"] }).selected;
  const d = decodePxJson(PX_JSON, META, sel);
  assert.equal(d.dimensions.length, 3);
  assert.deepEqual(d.contents, ["Ständige und nichtständige Wohnbevölkerung"]);
  const { fixed, rows } = toLabelledRows(d);
  assert.deepEqual(fixed, { Jahr: "2023" });
  assert.deepEqual(rows[0], { [KANTON.text]: "- Zürich", Geschlecht: "Mann", value: 795000 });
  assert.equal(rows[3].value, null);
  const withCodes = toLabelledRows(d, { includeCodes: true }).rows[0];
  assert.equal(withCodes["Geschlecht [code]"], "1");
  assert.equal(decodeResponse(PX_JSON, META, sel).records.length, 4);
});

test("bfs: decodePxJson handles multiple content columns and missing columns", () => {
  const multi = decodePxJson(
    {
      columns: [
        { code: "Jahr", text: "Jahr", type: "t" },
        { code: "a", text: "Ankünfte", type: "c" },
        { code: "b", text: "Logiernächte", type: "c" },
      ],
      data: [
        { key: ["2022"], values: ["10", "25"] },
        { key: ["2023"], values: ["12", "30"] },
      ],
    },
    { variables: [V.Jahr] },
    [],
  );
  const { rows } = toLabelledRows(multi);
  assert.deepEqual(rows[1], { Jahr: "2023", Ankünfte: 12, Logiernächte: 30 });

  const noCols = decodePxJson({ data: [{ key: ["2023", "1"], values: ["5"] }, { key: ["2023", "2"], values: ["6"] }] }, META, [
    { code: "Jahr", text: "Jahr", values: ["2023"], mode: "requested" },
    { code: "Geschlecht", text: "Geschlecht", values: ["1", "2"], mode: "requested" },
    { code: "Alter", text: "Alter", values: [], mode: "eliminated" },
  ]);
  assert.deepEqual(toLabelledRows(noCols).rows, [
    { Geschlecht: "Mann", value: 5 },
    { Geschlecht: "Frau", value: 6 },
  ]);
});

test("bfs: decodeJsonStat2 walks row-major order with labels", () => {
  const ds = {
    version: "2.0",
    class: "dataset",
    id: ["Jahr", "Geschlecht"],
    size: [2, 2],
    dimension: {
      Jahr: { label: "Jahr", category: { index: { "2022": 0, "2023": 1 }, label: { "2022": "2022", "2023": "2023" } } },
      Geschlecht: { label: "Geschlecht", category: { index: ["1", "2"], label: { "1": "Mann", "2": "Frau" } } },
    },
    value: [1, 2, 3, null],
  };
  const d = decodeJsonStat2(ds);
  assert.deepEqual(d.records.map((r) => r.keys), [["2022", "1"], ["2022", "2"], ["2023", "1"], ["2023", "2"]]);
  const { rows } = toLabelledRows(d);
  assert.deepEqual(rows[1], { Jahr: "2022", Geschlecht: "Frau", value: 2 });
  assert.equal(rows[3].value, null);
  assert.equal(decodeResponse(ds, META, []).records.length, 4, "auto-detects json-stat2");
  // sparse object values
  const sparse = decodeJsonStat2({ ...ds, value: { 0: 9, 3: 4 } });
  assert.deepEqual(sparse.records.map((r) => r.values[0]), [9, null, null, 4]);
});

const ROOT = [
  { dbid: "px-x-0102010000_101", text: "Ständige und nichtständige Wohnbevölkerung nach institutionellen Gliederungen, Staatsangehörigkeit (Kategorie), Geschlecht und Alter" },
  { dbid: "px-x-1003020000_101", text: "Hotellerie: Ankünfte und Logiernächte der geöffneten Betriebe nach Jahr, Monat, Kanton und Herkunftsland" },
  { dbid: "px-x-1903020100_101", text: "Straftaten gemäss Strafgesetzbuch (StGB) nach Kanton" },
  ...Array.from({ length: 25 }, (_, i) => ({ dbid: `px-x-99000000${String(i).padStart(2, "0")}_101`, text: `Filler Tabelle ${i}` })),
];

test("bfs: normalizeListing handles root databases and node children", () => {
  const root = normalizeListing(ROOT);
  assert.equal(root[0].type, "database");
  assert.equal(root[0].path, "px-x-0102010000_101");
  const node = normalizeListing(
    [
      { id: "px-x-0102010000_101.px", type: "t", text: "Wohnbevölkerung", updated: "2024-08-29T06:30:00" },
      { id: "sub", type: "l", text: "Sub level" },
      { bogus: true },
    ],
    "px-x-0102010000_101",
  );
  assert.equal(node.length, 2);
  assert.deepEqual(node[0], {
    id: "px-x-0102010000_101.px",
    path: "px-x-0102010000_101/px-x-0102010000_101.px",
    type: "table",
    text: "Wohnbevölkerung",
    updated: "2024-08-29T06:30:00",
  });
  assert.equal(node[1].type, "level");
  assert.deepEqual(normalizeListing({ not: "array" }), []);
});

test("bfs: rankListing matches German titles and English keywords via the seed index", () => {
  const items = normalizeListing(ROOT);
  assert.equal(rankListing(items, "Logiernächte Kanton", 5)[0].id, "px-x-1003020000_101");
  assert.equal(rankListing(items, "hotel overnight stays", 5)[0].id, "px-x-1003020000_101", "seed keyword boost");
  assert.equal(rankListing(items, "crime", 5)[0].id, "px-x-1903020100_101");
  assert.equal(rankListing(items, "Wohnbevolkerung alter", 5)[0].id, "px-x-0102010000_101");
  assert.equal(rankListing(items, "see px-x-1903020100_101", 5)[0].score, 2);
  assert.deepEqual(rankListing(items, "zzzz", 5), []);
});

test("bfs: seed index is well-formed and searchable offline", () => {
  const ids = new Set();
  for (const s of BFS_SEED_TABLES) {
    assert.match(s.id, /^px-x-\d{10}_\d{3}$/);
    assert.ok(!ids.has(s.id), `duplicate ${s.id}`);
    ids.add(s.id);
    assert.ok(["high", "medium", "low"].includes(s.confidence));
  }
  assert.equal(searchSeed("population", 3)[0].id.startsWith("px-x-01020100"), true);
  assert.equal(searchSeed("students university", 3)[0].id, "px-x-1502040100_131");
});

test("bfs: registers a discovery searcher for find_data", () => {
  const s = getSearchers().find((x) => x.catalogue === "BFS STAT-TAB");
  assert.ok(s);
  assert.equal(s.module, "bfs");
});

// ── Handler paths (fetch stubbed) ────────────────────────────────────────

test("bfs: query_bfs_table builds the POST, decodes labelled rows and reports defaults", async () => {
  const id = "px-x-0102010000_101";
  const { calls, restore } = stubFetch(({ method }) => (method === "GET" ? META : PX_JSON));
  try {
    const res = await toolByName("query_bfs_table").handler({
      table_id: id,
      selection: { Jahr: ["latest"], kanton: ["Zürich", "Bern / Berne"], Geschlecht: ["Mann", "Frau"] },
      lang: "de",
      limit: 300,
      include_codes: false,
    });
    assert.ok(!res.isError, res.content[0].text);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, `https://www.pxweb.bfs.admin.ch/api/v1/de/${id}/${id}.px`);
    assert.equal(calls[1].method, "POST");
    const body = JSON.parse(calls[1].body);
    assert.deepEqual(body.response, { format: "json" });
    const q = Object.fromEntries(body.query.map((x) => [x.code, x.selection.values]));
    assert.deepEqual(q.Jahr, ["2023"]);
    assert.deepEqual(q[KANTON.code], ["ZH", "BE"]);
    assert.deepEqual(q.Geschlecht, ["1", "2"]);
    assert.deepEqual(q.Alter, ["-99999"]);
    assert.deepEqual(q["Staatsangehörigkeit (Kategorie)"], ["-99999"]);
    assert.deepEqual(q.Bevölkerungstyp, ["1"]);

    const env = parse(res);
    assert.equal(env.data.row_count, 4);
    assert.equal(env.data.rows[0].Geschlecht, "Mann");
    assert.equal(env.data.rows[0].value, 795000);
    assert.deepEqual(env.data.fixed, { Jahr: "2023" });
    assert.equal(env.data.defaults_applied.length, 3);
    assert.equal(env.data.updated, "2024-08-29T06:30:00Z");
    assert.equal(env.source.operator, "Federal Statistical Office (BFS/OFS/UST)");
    assert.match(env.notes, /null = not available/);
  } finally {
    restore();
  }
});

test("bfs: query_bfs_table refuses oversize selections before POSTing", async () => {
  const id = "px-x-0102010000_199";
  const { calls, restore } = stubFetch(() => META);
  try {
    const res = await toolByName("query_bfs_table").handler({
      table_id: id,
      selection: { Jahr: "*", Kanton: "*", Alter: "*" },
      lang: "en",
      limit: 300,
      include_codes: false,
    });
    assert.equal(res.isError, true);
    const err = parse(res);
    assert.match(err.error, /9,996 cells \(limit 5000\)/);
    assert.ok(err.suggestions[0].includes("Alter=102"));
    assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  } finally {
    restore();
  }
});

test("bfs: query_bfs_table returns actionable errors for bad variables and 404 tables", async () => {
  const { restore } = stubFetch(({ url }) =>
    url.includes("_404") ? new Response("not found", { status: 404 }) : META,
  );
  try {
    const bad = await toolByName("query_bfs_table").handler({
      table_id: "px-x-0102010000_198",
      selection: { Farbe: ["rot"] },
      lang: "en",
      limit: 10,
      include_codes: false,
    });
    assert.equal(bad.isError, true);
    assert.match(parse(bad).suggestions[0], /Unknown variable 'Farbe'/);
    const nf = await toolByName("query_bfs_table").handler({
      table_id: "px-x-0102010000_404",
      selection: {},
      lang: "en",
      limit: 10,
      include_codes: false,
    });
    assert.equal(nf.isError, true);
    assert.match(parse(nf).error, /not found/);
    const inv = await toolByName("query_bfs_table").handler({ table_id: "../x", lang: "en", limit: 1, include_codes: false });
    assert.match(parse(inv).error, /not a valid/);
  } finally {
    restore();
  }
});

test("bfs: get_bfs_table_metadata summarises variables and lists filtered values", async () => {
  const id = "px-x-0102010000_197";
  const { restore } = stubFetch(() => META);
  try {
    const res = await toolByName("get_bfs_table_metadata").handler({ table_id: id, lang: "de", max_values: 3, limit: 200 });
    const env = parse(res);
    assert.equal(env.data.table_id, id);
    assert.equal(env.data.time_variable, "Jahr");
    assert.equal(env.data.cells_if_all_values, 14 * 7 * 2 * 3 * 3 * 102);
    assert.equal(env.data.cells_with_defaults, 1);
    const jahr = env.data.variables.find((v) => v.code === "Jahr");
    assert.equal(jahr.range, "2010 … 2023");
    assert.equal(jahr.more_values, 11);
    assert.match(jahr.default_if_unspecified, /2023.*latest/);
    assert.deepEqual(env.data.example_query.selection.Jahr, ["latest"]);

    const vals = parse(
      await toolByName("get_bfs_table_metadata").handler({
        table_id: id,
        lang: "de",
        max_values: 3,
        variable: "gemeinde",
        value_filter: "bern",
        limit: 200,
      }),
    );
    assert.deepEqual(vals.data.values.map((v) => v.code), ["BE", "0351"]);
  } finally {
    restore();
  }
});

test("bfs: search_bfs_tables ranks the live root listing", async () => {
  const { calls, restore } = stubFetch(() => ROOT);
  try {
    const res = await toolByName("search_bfs_tables").handler({ query: "overnight stays", lang: "de", limit: 5 });
    const env = parse(res);
    assert.equal(env.data.mode, "live");
    assert.equal(env.data.results[0].table_id, "px-x-1003020000_101");
    assert.equal(calls[0].url, "https://www.pxweb.bfs.admin.ch/api/v1/de/");
  } finally {
    restore();
  }
});

test("bfs: search_bfs_tables falls back to the seed index when STAT-TAB is down", async () => {
  const { restore } = stubFetch(() => new Response("forbidden", { status: 403 }));
  try {
    const env = parse(await toolByName("search_bfs_tables").handler({ query: "population", lang: "it", limit: 5 }));
    assert.equal(env.data.mode, "seed");
    assert.ok(env.data.results[0].id_confidence);
    assert.match(env.notes, /seed index/);
  } finally {
    restore();
  }
});

test("bfs: browse_bfs_tables pages and filters the root listing", async () => {
  const { restore } = stubFetch(() => ROOT);
  try {
    const env = parse(
      await toolByName("browse_bfs_tables").handler({ lang: "fr", filter: "hotellerie", limit: 50, offset: 0 }),
    );
    assert.equal(env.data.total, 1);
    assert.deepEqual(env.data.items[0].next, {
      tool: "get_bfs_table_metadata",
      args: { table_id: "px-x-1003020000_101" },
    });
    const page = parse(await toolByName("browse_bfs_tables").handler({ lang: "fr", limit: 10, offset: 0 }));
    assert.equal(page.data.returned, 10);
    assert.equal(page.data.next_offset, 10);
    const bad = await toolByName("browse_bfs_tables").handler({ path: "a/../b", lang: "fr", limit: 10, offset: 0 });
    assert.equal(bad.isError, true);
  } finally {
    restore();
  }
});
