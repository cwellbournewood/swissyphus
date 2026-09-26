/**
 * Offline tests for the LINDAS cubes connector: SPARQL builders (correctness +
 * injection safety), result parsers, and full handler paths with a stubbed
 * fetch returning recorded-style SPARQL JSON results.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cubesModule,
  isSafeIri,
  iriRef,
  escapeSparqlString,
  sanitizeSearchTerm,
  searchTerms,
  langOrder,
  buildSearchQuery,
  buildCubeMetaQuery,
  buildDimensionsQuery,
  buildExamplesQuery,
  buildObservationQuery,
  filterPattern,
  parseSearch,
  parseMeta,
  parseDimensions,
  parseExamples,
  pivotObservations,
  columnKeys,
  resolveDimension,
  normaliseCubeRef,
  visualizeUrl,
} from "../dist/modules/cubes.js";
import { getSearchers } from "../dist/core/discovery.js";

const tool = (name) => cubesModule.tools.find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);

/**
 * Split a SPARQL string into the parts outside string literals (honouring
 * backslash escapes) — anything injected must never appear there.
 */
function outsideLiterals(q) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else {
      out += c;
    }
  }
  assert.equal(inStr, false, "unterminated string literal");
  return out;
}

/** Drop <IRI> refs (which may legitimately contain '#') from query text. */
const withoutIris = (s) => s.replace(/<[^<>\s"]*>/g, "<>");

// ---------------------------------------------------------------------------
// Escaping / validation
// ---------------------------------------------------------------------------

test("cubes: strict IRI validation", () => {
  assert.ok(isSafeIri("https://energy.ld.admin.ch/elcom/electricityprice"));
  assert.ok(isSafeIri("https://ld.admin.ch/cube/dimension/x#frag"));
  for (const bad of [
    "https://x.ch/a> } DROP ALL {",
    "https://x.ch/a b",
    'https://x.ch/a"',
    "https://x.ch/a\\b",
    "https://x.ch/a\nb",
    "ftp://x.ch/a",
    "javascript:alert(1)",
    "https://x.ch/{a}",
    "https://x.ch/a`",
    "https://x.ch/a^b",
    "https://x.ch/a|b",
    "",
  ]) {
    assert.equal(isSafeIri(bad), false, bad);
  }
  assert.throws(() => iriRef("https://x.ch/a> ?s ?p ?o"), /Not a valid IRI/);
  assert.equal(iriRef("https://x.ch/a"), "<https://x.ch/a>");
});

test("cubes: escapeSparqlString escapes quotes/backslashes/newlines and drops control chars", () => {
  assert.equal(escapeSparqlString('a"b'), 'a\\"b');
  assert.equal(escapeSparqlString("a\\b"), "a\\\\b");
  assert.equal(escapeSparqlString("a'b"), "a\\'b");
  assert.equal(escapeSparqlString("a\nb\r\tc"), "a\\nb\\r\\tc");
  assert.equal(escapeSparqlString("a\u0000\u0007b"), "ab");
  assert.equal(escapeSparqlString("x".repeat(500)).length, 300);
  assert.equal(escapeSparqlString("Zürich (ZH) / Biel-Bienne"), "Zürich (ZH) / Biel-Bienne");
});

test("cubes: search terms are sanitized, lower-cased and bounded", () => {
  assert.equal(sanitizeSearchTerm('Strom"} DROP <x> ; #'), "Strom DROP x");
  assert.deepEqual(searchTerms("  Électricité  PREIS a "), ["électricité", "preis"]);
  assert.equal(searchTerms("a b c d e f g h i j k l m n o p").length, 0);
  assert.equal(searchTerms("aa bb cc dd ee ff gg hh").length, 6);
  assert.deepEqual(langOrder("fr"), ["fr", "de", "it", "en"]);
  assert.deepEqual(langOrder("en"), ["en", "de", "fr", "it"]);
});

// ---------------------------------------------------------------------------
// Query builders
// ---------------------------------------------------------------------------

test("cubes: search query filters published, non-expired cubes and matches every term", () => {
  const q = buildSearchQuery({ query: "Strompreis Kanton", lang: "de", limit: 500, offset: -3, publishedOnly: true });
  assert.match(q, /\?cube a cube:Cube/);
  assert.match(q, /FILTER NOT EXISTS \{ \?cube schema:expires \?expires \}/);
  assert.match(q, /CreativeWorkStatus\/Draft/);
  assert.match(q, /"strompreis"/);
  assert.match(q, /"kanton"/);
  assert.match(q, /LIMIT 50\b/);
  assert.match(q, /OFFSET 0\b/);
  assert.match(q, /GROUP BY \?cube/);
  assert.match(q, /FILTER\(LANG\(\?n_0\) = "de"\)/);
  const unpublished = buildSearchQuery({ query: "", lang: "en", limit: 5, offset: 0, publishedOnly: false });
  assert.doesNotMatch(unpublished, /CreativeWorkStatus\/Draft> \}\n  FILTER NOT EXISTS \{\n    \?parent/);
  assert.doesNotMatch(unpublished, /CONTAINS/);
});

test("cubes: search query is injection-safe", () => {
  const q = buildSearchQuery({
    query: 'x") } } ; DELETE WHERE { ?s ?p ?o } # <http://evil>',
    lang: "en",
    limit: 10,
    offset: 0,
    publishedOnly: true,
  });
  const outside = outsideLiterals(q);
  assert.doesNotMatch(outside, /DELETE/);
  assert.doesNotMatch(q, /evil>/);
  assert.doesNotMatch(withoutIris(outside), /#/);
});

test("cubes: metadata/dimension/example builders reject unsafe cube IRIs", () => {
  const bad = "https://x.ch/c> . ?s ?p ?o . <x";
  assert.throws(() => buildCubeMetaQuery(bad, "en"));
  assert.throws(() => buildDimensionsQuery(bad, "en"));
  assert.throws(() => buildExamplesQuery("https://x.ch/c", [bad], 5, "en"));
});

test("cubes: dimensions query reads the SHACL shape defensively", () => {
  const q = buildDimensionsQuery("https://x.ch/cube/1", "it");
  assert.match(q, /<https:\/\/x\.ch\/cube\/1> cube:observationConstraint \?shape/);
  assert.match(q, /\?shape sh:property \?prop/);
  assert.match(q, /\?prop sh:path \?dim/);
  assert.match(q, /\?dim NOT IN \(rdf:type, cube:observedBy\)/);
  assert.match(q, /cube:KeyDimension, cube:MeasureDimension/);
  assert.match(q, /qudt:unit/);
  assert.match(q, /sh:or\/rdf:rest\*\/rdf:first\/sh:datatype/);
  assert.match(q, /FILTER\(LANG\(\?l_0\) = "it"\)/);
});

test("cubes: examples query is bounded per dimension and by an observation sample", () => {
  const q = buildExamplesQuery("https://x.ch/cube/1", ["https://x.ch/dim/a", "https://x.ch/dim/b"], 7, "en");
  assert.equal((q.match(/SELECT DISTINCT \?value/g) ?? []).length, 2);
  assert.equal((q.match(/\} LIMIT 7 \}/g) ?? []).length, 2);
  assert.match(q, /LIMIT 2000/);
  assert.match(q, /sh:in\/rdf:rest\*\/rdf:first \?value/);
  assert.match(q, /BIND\(<https:\/\/x\.ch\/dim\/b> AS \?dim\)/);
});

test("cubes: observation query applies IRI and label filters and clamps limit", () => {
  const q = buildObservationQuery({
    cube: "https://x.ch/cube/1",
    dimensions: ["https://x.ch/dim/canton", "https://x.ch/dim/value"],
    filters: [{ dimension: "https://x.ch/dim/canton", values: ["https://x.ch/canton/ZH", "Bern"] }],
    limit: 5000,
    offset: 0,
    lang: "en",
  });
  assert.match(q, /\?obs <https:\/\/x\.ch\/dim\/canton> \?f0 \./);
  assert.match(q, /\?f0 IN \(<https:\/\/x\.ch\/canton\/ZH>\)/);
  assert.match(q, /LCASE\(STR\(\?f0\)\) IN \("bern"\)/);
  assert.match(q, /LIMIT 1000 \}/);
  assert.doesNotMatch(q, /ORDER BY/);
  assert.match(q, /VALUES \?dim \{ <https:\/\/x\.ch\/dim\/canton> <https:\/\/x\.ch\/dim\/value> \}/);
  const paged = buildObservationQuery({ cube: "https://x.ch/cube/1", dimensions: ["https://x.ch/d"], filters: [], limit: 10, offset: 20, lang: "en" });
  assert.match(paged, /ORDER BY \?obs LIMIT 10 OFFSET 20/);
});

test("cubes: observation query is injection-safe for hostile filter values", () => {
  const payloads = [
    '2020" ) } } ; DROP ALL ; SELECT * { ?s ?p ?o } #',
    "x\\\" } DELETE { ?s ?p ?o } WHERE { ?s ?p ?o } #",
    "a'b\"c\nd } INSERT DATA { <a> <b> <c> }",
    "https://x.ch/a> } DROP ALL { <x",
  ];
  const q = buildObservationQuery({
    cube: "https://x.ch/cube/1",
    dimensions: ["https://x.ch/dim/a"],
    filters: [{ dimension: "https://x.ch/dim/a", values: payloads }],
    limit: 10,
    offset: 0,
    lang: "en",
  });
  const outside = outsideLiterals(q);
  assert.doesNotMatch(outside, /DROP|DELETE|INSERT/);
  assert.doesNotMatch(withoutIris(outside), /#/);
  // The not-quite-IRI payload is treated as a literal, never inside <…>.
  assert.doesNotMatch(q, /<https:\/\/x\.ch\/a>/);
  assert.throws(() =>
    filterPattern({ dimension: "https://x.ch/d> } DROP ALL {", values: ["x"] }, 0),
  );
  assert.throws(() => filterPattern({ dimension: "https://x.ch/d", values: ["   "] }, 0), /no usable values/);
});

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

const CUBE = "https://energy.ld.admin.ch/elcom/electricityprice";
const DIM = (n) => `https://energy.ld.admin.ch/elcom/electricityprice/dimension/${n}`;
const lit = (value, datatype) => ({ type: "literal", value, ...(datatype ? { datatype } : {}) });
const uri = (value) => ({ type: "uri", value });
const XSD = "http://www.w3.org/2001/XMLSchema#";

const DIMS_FIXTURE = {
  head: { vars: ["dim", "label", "description", "kind", "unit", "unitLabel", "datatype", "nodeKind", "min", "max", "order", "scaleType"] },
  results: {
    bindings: [
      { dim: uri(DIM("total")), label: lit("Total"), kind: uri("https://cube.link/MeasureDimension"), unit: uri("https://ld.admin.ch/unit/RP-PER-KiloW-HR"), unitLabel: lit("Rp./kWh"), datatype: uri(XSD + "decimal") },
      { dim: uri(DIM("period")), label: lit("Period"), kind: uri("https://cube.link/KeyDimension"), datatype: uri(XSD + "gYear"), min: lit("2011", XSD + "gYear"), max: lit("2026", XSD + "gYear"), order: lit("2", XSD + "integer") },
      { dim: uri(DIM("municipality")), label: lit("Municipality"), kind: uri("https://cube.link/KeyDimension"), nodeKind: uri("http://www.w3.org/ns/shacl#IRI"), order: lit("1", XSD + "integer") },
      { dim: uri(DIM("municipality")), label: lit("Municipality"), kind: uri("https://cube.link/KeyDimension"), nodeKind: uri("http://www.w3.org/ns/shacl#IRI") },
      { dim: uri(DIM("category")), label: lit("Category"), nodeKind: uri("http://www.w3.org/ns/shacl#IRI") },
      { dim: uri(DIM("fixcosts")), label: lit("Fixed costs"), datatype: uri(XSD + "decimal") },
    ],
  },
};

test("cubes: parseDimensions merges rows, infers roles and orders keys first", () => {
  const dims = parseDimensions(DIMS_FIXTURE);
  assert.deepEqual(dims.map((d) => d.label), ["Municipality", "Period", "Category", "Fixed costs", "Total"]);
  const total = dims.find((d) => d.label === "Total");
  assert.equal(total.role, "measure");
  assert.equal(total.unit_label, "Rp./kWh");
  assert.equal(total.datatype, "xsd:decimal");
  assert.equal(total.role_inferred, undefined);
  const cat = dims.find((d) => d.label === "Category");
  assert.equal(cat.role, "key");
  assert.equal(cat.role_inferred, true);
  assert.equal(cat.node_kind, "IRI");
  const fix = dims.find((d) => d.label === "Fixed costs");
  assert.equal(fix.role, "measure");
  assert.equal(fix.role_inferred, true);
  const period = dims.find((d) => d.label === "Period");
  assert.equal(period.min, "2011");
  assert.equal(period.max, "2026");
});

test("cubes: resolveDimension matches IRI, label, local name and unique partial label", () => {
  const dims = parseDimensions(DIMS_FIXTURE);
  assert.equal(resolveDimension(DIM("period"), dims).label, "Period");
  assert.equal(resolveDimension("PERIOD", dims).label, "Period");
  assert.equal(resolveDimension("fixcosts", dims).label, "Fixed costs");
  assert.equal(resolveDimension("munic", dims).label, "Municipality");
  assert.equal(resolveDimension("o", dims), undefined); // ambiguous partial
  assert.equal(resolveDimension("nope", dims), undefined);
});

test("cubes: parseExamples dedupes and caps per dimension", () => {
  const ex = parseExamples(
    {
      results: {
        bindings: [
          { dim: uri(DIM("category")), value: uri("https://x/H1"), label: lit("H1") },
          { dim: uri(DIM("category")), value: uri("https://x/H1"), label: lit("H1 (fr)") },
          { dim: uri(DIM("category")), value: uri("https://x/H2"), label: lit("H2") },
          { dim: uri(DIM("category")), value: uri("https://x/H3"), label: lit("H3") },
          { dim: uri(DIM("period")), value: lit("2024", XSD + "gYear") },
        ],
      },
    },
    2,
  );
  assert.deepEqual(ex.get(DIM("category")), [
    { value: "https://x/H1", label: "H1" },
    { value: "https://x/H2", label: "H2" },
  ]);
  assert.deepEqual(ex.get(DIM("period")), [{ value: "2024" }]);
});

test("cubes: pivotObservations produces flat labelled rows with numbers", () => {
  const dims = parseDimensions(DIMS_FIXTURE);
  const obs = (n) => uri(`https://energy.ld.admin.ch/elcom/electricityprice/observation/${n}`);
  const data = {
    results: {
      bindings: [
        { obs: obs(1), dim: uri(DIM("municipality")), value: uri("https://ld.admin.ch/municipality/261"), label: lit("Zürich") },
        { obs: obs(1), dim: uri(DIM("municipality")), value: uri("https://ld.admin.ch/municipality/261"), label: lit("Zurich") },
        { obs: obs(1), dim: uri(DIM("period")), value: lit("2025", XSD + "gYear") },
        { obs: obs(1), dim: uri(DIM("total")), value: lit("27.35", XSD + "decimal") },
        { obs: obs(1), dim: uri(DIM("category")), value: uri("https://energy.ld.admin.ch/elcom/electricityprice/category/H4") },
        { obs: obs(2), dim: uri(DIM("total")), value: lit("n/a") },
        { obs: obs(2), dim: uri("https://unknown/dim"), value: lit("ignored") },
      ],
    },
  };
  const rows = pivotObservations(data, dims, true);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    Municipality: "Zürich",
    "Municipality IRI": "https://ld.admin.ch/municipality/261",
    Period: "2025",
    Category: "https://energy.ld.admin.ch/elcom/electricityprice/category/H4",
    "Category IRI": "https://energy.ld.admin.ch/elcom/electricityprice/category/H4",
    "Fixed costs": null,
    Total: 27.35,
  });
  assert.equal(rows[1].Total, "n/a");
  assert.equal(rows[1].Municipality, null);
});

test("cubes: columnKeys disambiguates duplicate labels", () => {
  const keys = columnKeys([
    { iri: "https://x/dim/a", label: "Value", role: "measure" },
    { iri: "https://x/dim/b", label: "Value", role: "measure" },
    { iri: "https://x/dim/c", label: "Year", role: "key" },
  ]);
  assert.equal(keys.get("https://x/dim/a"), "Value (a)");
  assert.equal(keys.get("https://x/dim/b"), "Value (b)");
  assert.equal(keys.get("https://x/dim/c"), "Year");
});

test("cubes: normaliseCubeRef accepts IRIs and visualize.admin.ch links", () => {
  assert.equal(normaliseCubeRef(` ${CUBE} `), CUBE);
  assert.equal(normaliseCubeRef(visualizeUrl(CUBE, "de")), CUBE);
  assert.equal(
    normaliseCubeRef(`https://visualize.admin.ch/en/browse/dataset/${encodeURIComponent(CUBE)}`),
    CUBE,
  );
  assert.equal(normaliseCubeRef("not an iri"), undefined);
  assert.equal(normaliseCubeRef("https://x.ch/a>b"), undefined);
});

test("cubes: parseSearch / parseMeta tolerate missing fields", () => {
  const hits = parseSearch(
    {
      results: {
        bindings: [
          { cube: uri(CUBE), name: lit("Electricity tariffs"), description: lit("  Tariffs   per\nmunicipality ".repeat(40)), publisher: lit("ElCom"), modified: lit("2025-09-01T10:00:00Z"), status: uri("https://ld.admin.ch/vocabulary/CreativeWorkStatus/Published"), visualize: lit("1", XSD + "integer") },
          { cube: uri(CUBE) },
          { cube: uri("https://x/cube/2") },
        ],
      },
    },
    "en",
  );
  assert.equal(hits.length, 2);
  assert.equal(hits[0].modified, "2025-09-01");
  assert.equal(hits[0].status, "Published");
  assert.equal(hits[0].on_visualize, true);
  assert.ok(hits[0].description.length <= 280);
  assert.ok(hits[0].description.endsWith("…"));
  assert.equal(hits[1].name, undefined);
  assert.equal(hits[1].on_visualize, false);
  assert.equal(parseMeta(CUBE, { results: { bindings: [] } }, "en"), undefined);
  assert.equal(parseMeta(CUBE, {}, "en"), undefined);
});

// ---------------------------------------------------------------------------
// Handlers with stubbed fetch
// ---------------------------------------------------------------------------

/** Stub fetch: route by the SPARQL text in the POST body. Records queries. */
function stubLindas(routes) {
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(new URL(String(url)).hostname, "lindas.admin.ch");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Accept, "application/sparql-results+json");
    const q = new URLSearchParams(init.body).get("query");
    seen.push(q);
    for (const [pattern, body] of routes) {
      if (pattern.test(q)) {
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/sparql-results+json" } });
      }
    }
    return new Response(JSON.stringify({ head: { vars: [] }, results: { bindings: [] } }), { status: 200 });
  };
  return { seen, restore: () => (globalThis.fetch = orig) };
}

const isMeta = /SELECT \?name \?description \?publisher \?creator/;
const isDims = /SELECT \?dim \?label \?description \?kind/;
const isExamples = /SELECT \?dim \?value \?label WHERE/;
const isObs = /SELECT \?obs \?dim \?value \?label/;
const isSearch = /SELECT \?cube \(SAMPLE/;

test("cubes: search_data_cubes handler returns trimmed hits with visualize links", async () => {
  const { seen, restore } = stubLindas([
    [
      isSearch,
      {
        head: { vars: ["cube", "name", "description", "publisher", "modified", "status", "visualize"] },
        results: {
          bindings: [
            { cube: uri(CUBE), name: lit("Electricity tariffs in Switzerland", undefined), description: lit("Tariffs of all Swiss grid operators."), publisher: lit("Federal Electricity Commission ElCom"), modified: lit("2025-09-01", XSD + "date"), status: uri("https://ld.admin.ch/vocabulary/CreativeWorkStatus/Published"), visualize: lit("1", XSD + "integer") },
          ],
        },
      },
    ],
  ]);
  try {
    const res = await tool("search_data_cubes").handler({ query: "electricity tariff unique1", lang: "en", limit: 5, offset: 0, published_only: true });
    assert.ok(!res.isError, res.content[0].text);
    const body = parse(res);
    assert.equal(body.data.count, 1);
    assert.equal(body.data.cubes[0].cube, CUBE);
    assert.equal(body.data.cubes[0].publisher, "Federal Electricity Commission ElCom");
    assert.equal(body.data.cubes[0].visualize_url, `https://visualize.admin.ch/en/browse?dataset=${encodeURIComponent(CUBE)}&dataSource=Prod`);
    assert.match(seen[0], /"unique1"/);
    assert.match(seen[0], /LIMIT 5\b/);
    assert.equal(body.source.operator.includes("LINDAS"), true);
  } finally {
    restore();
  }
});

test("cubes: search_data_cubes returns an actionable error on no hits", async () => {
  const { restore } = stubLindas([]);
  try {
    const res = await tool("search_data_cubes").handler({ query: "zzqq nothing", lang: "en", limit: 5, offset: 0, published_only: true });
    assert.equal(res.isError, true);
    assert.ok(parse(res).suggestions.length >= 2);
  } finally {
    restore();
  }
});

const META_FIXTURE = {
  head: { vars: ["name", "description", "publisher", "creator", "status", "modified", "published", "version", "licence", "expires", "visualize", "newer"] },
  results: {
    bindings: [
      {
        name: lit("Electricity tariffs"),
        description: lit("Tariffs per municipality, grid operator and consumption category."),
        publisher: lit("ElCom"),
        creator: uri("https://register.ld.admin.ch/opendataswiss/org/elcom"),
        status: uri("https://ld.admin.ch/vocabulary/CreativeWorkStatus/Published"),
        modified: lit("2025-09-01T00:00:00Z", XSD + "dateTime"),
        version: lit("6", XSD + "integer"),
        licence: uri("https://ld.admin.ch/vocabulary/License/Terms_by"),
        visualize: lit("1", XSD + "integer"),
      },
    ],
  },
};

const EXAMPLES_FIXTURE = {
  head: { vars: ["dim", "value", "label"] },
  results: {
    bindings: [
      { dim: uri(DIM("municipality")), value: uri("https://ld.admin.ch/municipality/261"), label: lit("Zürich") },
      { dim: uri(DIM("municipality")), value: uri("https://ld.admin.ch/municipality/351"), label: lit("Bern") },
      { dim: uri(DIM("period")), value: lit("2025", XSD + "gYear") },
      { dim: uri(DIM("category")), value: uri("https://energy.ld.admin.ch/elcom/electricityprice/category/H4"), label: lit("H4") },
    ],
  },
};

test("cubes: describe_data_cube handler returns metadata, dimensions and example values", async () => {
  const cube = `${CUBE}/describe-test`;
  const { seen, restore } = stubLindas([
    [isMeta, META_FIXTURE],
    [isDims, DIMS_FIXTURE],
    [isExamples, EXAMPLES_FIXTURE],
  ]);
  try {
    const res = await tool("describe_data_cube").handler({ cube, lang: "en", examples: 5 });
    assert.ok(!res.isError, res.content[0].text);
    const body = parse(res);
    assert.equal(body.data.name, "Electricity tariffs");
    assert.equal(body.data.status, "Published");
    assert.equal(body.data.version, "6");
    assert.equal(body.data.modified, "2025-09-01");
    assert.equal(body.data.dimension_count, 5);
    const muni = body.data.dimensions.find((d) => d.label === "Municipality");
    assert.deepEqual(muni.example_values, [
      { value: "https://ld.admin.ch/municipality/261", label: "Zürich" },
      { value: "https://ld.admin.ch/municipality/351", label: "Bern" },
    ]);
    const total = body.data.dimensions.find((d) => d.label === "Total");
    assert.equal(total.role, "measure");
    assert.equal(total.example_values, undefined);
    assert.equal(body.data_as_of, "2025-09-01");
    assert.ok(body.links.visualize.startsWith("https://visualize.admin.ch/en/browse?dataset="));
    // Examples are only requested for key dimensions.
    const exQ = seen.find((q) => isExamples.test(q));
    assert.ok(exQ.includes(`<${DIM("municipality")}>`));
    assert.ok(!exQ.includes(`<${DIM("total")}>`));
  } finally {
    restore();
  }
});

test("cubes: describe_data_cube rejects bad IRIs without contacting LINDAS and reports unknown cubes", async () => {
  const { seen, restore } = stubLindas([]);
  try {
    const bad = await tool("describe_data_cube").handler({ cube: "https://x.ch/a> } DROP ALL {", lang: "en", examples: 5 });
    assert.equal(bad.isError, true);
    assert.equal(seen.length, 0);
    const missing = await tool("describe_data_cube").handler({ cube: "https://x.ch/no/such/cube", lang: "en", examples: 5 });
    assert.equal(missing.isError, true);
    assert.match(parse(missing).error, /No cube found/);
  } finally {
    restore();
  }
});

test("cubes: query_data_cube handler resolves filters by label and returns flat rows", async () => {
  const cube = `${CUBE}/query-test`;
  const obs = (n) => uri(`${cube}/observation/${n}`);
  const OBS_FIXTURE = {
    head: { vars: ["obs", "dim", "value", "label"] },
    results: {
      bindings: [
        { obs: obs(1), dim: uri(DIM("municipality")), value: uri("https://ld.admin.ch/municipality/261"), label: lit("Zürich") },
        { obs: obs(1), dim: uri(DIM("period")), value: lit("2025", XSD + "gYear") },
        { obs: obs(1), dim: uri(DIM("category")), value: uri("https://energy.ld.admin.ch/elcom/electricityprice/category/H4"), label: lit("H4") },
        { obs: obs(1), dim: uri(DIM("total")), value: lit("27.35", XSD + "decimal") },
        { obs: obs(1), dim: uri(DIM("fixcosts")), value: lit("60", XSD + "decimal") },
      ],
    },
  };
  const { seen, restore } = stubLindas([
    [isDims, DIMS_FIXTURE],
    [isObs, OBS_FIXTURE],
  ]);
  try {
    const res = await tool("query_data_cube").handler({
      cube,
      filters: { period: "2025", Category: "https://energy.ld.admin.ch/elcom/electricityprice/category/H4", Municipality: ["Zürich", 'x" } DROP ALL #'] },
      limit: 1,
      offset: 0,
      lang: "en",
      include_iris: false,
      include_sparql: true,
    });
    assert.ok(!res.isError, res.content[0].text);
    const body = parse(res);
    assert.equal(body.data.row_count, 1);
    assert.deepEqual(body.data.rows[0], { Municipality: "Zürich", Period: "2025", Category: "H4", "Fixed costs": 60, Total: 27.35 });
    const totalCol = body.data.columns.find((c) => c.key === "Total");
    assert.deepEqual(totalCol, { key: "Total", iri: DIM("total"), role: "measure", unit: "Rp./kWh" });
    assert.equal(body.data.filters.length, 3);
    assert.match(body.notes, /limit=1/);
    const q = seen.find((s) => isObs.test(s));
    assert.equal(q, body.data.sparql);
    assert.match(q, /LCASE\(STR\(\?f0\)\) IN \("2025"\)/);
    assert.ok(q.includes(`?f1 IN (<https://energy.ld.admin.ch/elcom/electricityprice/category/H4>)`));
    assert.match(q, /"zürich"/);
    assert.doesNotMatch(outsideLiterals(q), /DROP/);
    assert.match(q, /LIMIT 1 \}/);
  } finally {
    restore();
  }
});

test("cubes: query_data_cube lists available dimensions for an unknown filter", async () => {
  const cube = `${CUBE}/query-unknown-dim`;
  const { restore } = stubLindas([[isDims, DIMS_FIXTURE]]);
  try {
    const res = await tool("query_data_cube").handler({ cube, filters: { Kanton: "ZH" }, limit: 10, offset: 0, lang: "en", include_iris: false, include_sparql: false });
    assert.equal(res.isError, true);
    const body = parse(res);
    assert.match(body.error, /Unknown dimension 'Kanton'/);
    assert.match(body.suggestions[0], /Municipality, Period/);
  } finally {
    restore();
  }
});

test("cubes: upstream failure becomes a graceful source-unavailable error", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response("bad request", { status: 400 });
  try {
    const res = await tool("query_data_cube").handler({ cube: `${CUBE}/fails`, limit: 10, offset: 0, lang: "en", include_iris: false, include_sparql: false });
    assert.equal(res.isError, true);
    assert.match(parse(res).error, /LINDAS SPARQL endpoint is currently unavailable/);
  } finally {
    globalThis.fetch = orig;
  }
});

test("cubes: registers a 'LINDAS cubes' searcher whose hits point at describe_data_cube", async () => {
  const s = getSearchers().find((x) => x.catalogue === "LINDAS cubes");
  assert.ok(s);
  assert.equal(s.module, "cubes");
  assert.deepEqual(await s.search("   ", 5, "en"), []);
  const { restore } = stubLindas([
    [isSearch, { results: { bindings: [{ cube: uri(CUBE), name: lit("Strompreise"), publisher: lit("ElCom") }] } }],
  ]);
  try {
    const hits = await s.search("strompreis searcher", 5, "xx");
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0].next, { tool: "describe_data_cube", args: { cube: CUBE } });
    assert.equal(hits[0].catalogue, "LINDAS cubes");
    assert.equal(hits[0].title, "Strompreise");
    assert.ok(hits[0].url.startsWith("https://visualize.admin.ch/en/"));
  } finally {
    restore();
  }
});

test("cubes: module shape (ids, tool names, health probe)", () => {
  assert.equal(cubesModule.id, "cubes");
  assert.deepEqual(cubesModule.tools.map((t) => t.name), ["search_data_cubes", "describe_data_cube", "query_data_cube"]);
  assert.ok(cubesModule.healthProbes[0].url.startsWith("https://lindas.admin.ch/query?query="));
  for (const t of cubesModule.tools) assert.ok(t.description.length > 150);
});
