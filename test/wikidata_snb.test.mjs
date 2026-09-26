/**
 * Offline tests for the Wikidata module and the generic SNB data-portal tools
 * in fx.ts. globalThis.fetch is stubbed with recorded-style fixtures.
 *   node --test test/wikidata_snb.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  wikidataModule,
  normaliseQid,
  sanitizeSparqlLiteral,
  sanitizeSearchText,
  formatWdTime,
  simplifySnak,
  bestClaims,
  latestClaim,
  wikipediaLinks,
  orderProperties,
  guardSparql,
  sparqlRows,
  pickLang,
  commonsFileUrl,
} from "../dist/modules/wikidata.js";
import {
  fxModule,
  SNB_DATASETS,
  searchSnbDatasets,
  parseSnbDimensions,
  buildDimSel,
  labelSnbSeries,
} from "../dist/modules/fx.js";
import { getSearchers } from "../dist/core/discovery.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolOf(mod, name) {
  const t = mod.tools.find((x) => x.name === name);
  assert.ok(t, `tool ${name} exists`);
  return t;
}

function parse(result) {
  return JSON.parse(result.content[0].text);
}

/** Stub fetch with a router (url → {status, body}); returns the list of requested URLs. */
async function withFetch(router, fn) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    const r = router(u, init);
    if (!r) return new Response("not found", { status: 404 });
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = orig;
  }
  return calls;
}

// ---------------------------------------------------------------------------
// Fixtures (shapes follow the documented Wikibase / WDQS / SNB JSON)
// ---------------------------------------------------------------------------

const Q72_ENTITY = {
  entities: {
    Q72: {
      type: "item",
      id: "Q72",
      labels: {
        de: { language: "de", value: "Zürich" },
        fr: { language: "fr", value: "Zurich" },
        it: { language: "it", value: "Zurigo" },
        en: { language: "en", value: "Zürich" },
      },
      descriptions: { en: { language: "en", value: "largest city in Switzerland" } },
      aliases: { en: [{ language: "en", value: "Zurich" }] },
      claims: {
        P31: [
          {
            mainsnak: { snaktype: "value", property: "P31", datatype: "wikibase-item", datavalue: { type: "wikibase-entityid", value: { "entity-type": "item", "numeric-id": 70208, id: "Q70208" } } },
            rank: "normal",
          },
        ],
        P17: [
          {
            mainsnak: { snaktype: "value", property: "P17", datatype: "wikibase-item", datavalue: { type: "wikibase-entityid", value: { id: "Q39" } } },
            rank: "normal",
          },
        ],
        P1082: [
          {
            mainsnak: { snaktype: "value", property: "P1082", datatype: "quantity", datavalue: { type: "quantity", value: { amount: "+421878", unit: "1" } } },
            rank: "normal",
            qualifiers: { P585: [{ snaktype: "value", property: "P585", datavalue: { type: "time", value: { time: "+2020-12-31T00:00:00Z", precision: 11 } } }] },
          },
          {
            mainsnak: { snaktype: "value", property: "P1082", datatype: "quantity", datavalue: { type: "quantity", value: { amount: "+443037", unit: "1" } } },
            rank: "normal",
            qualifiers: { P585: [{ snaktype: "value", property: "P585", datavalue: { type: "time", value: { time: "+2023-12-31T00:00:00Z", precision: 11 } } }] },
          },
          {
            mainsnak: { snaktype: "value", property: "P1082", datatype: "quantity", datavalue: { type: "quantity", value: { amount: "+1", unit: "1" } } },
            rank: "deprecated",
            qualifiers: { P585: [{ snaktype: "value", property: "P585", datavalue: { type: "time", value: { time: "+2030-01-01T00:00:00Z", precision: 11 } } }] },
          },
        ],
        P2046: [
          {
            mainsnak: { snaktype: "value", property: "P2046", datatype: "quantity", datavalue: { type: "quantity", value: { amount: "+87.88", unit: "http://www.wikidata.org/entity/Q712226" } } },
            rank: "normal",
          },
        ],
        P2044: [
          {
            mainsnak: { snaktype: "value", property: "P2044", datatype: "quantity", datavalue: { type: "quantity", value: { amount: "+408", unit: "http://www.wikidata.org/entity/Q11573" } } },
            rank: "normal",
          },
        ],
        P625: [
          {
            mainsnak: { snaktype: "value", property: "P625", datatype: "globe-coordinate", datavalue: { type: "globecoordinate", value: { latitude: 47.374444, longitude: 8.541111, precision: 0.0001, globe: "http://www.wikidata.org/entity/Q2" } } },
            rank: "normal",
          },
        ],
        P856: [
          {
            mainsnak: { snaktype: "value", property: "P856", datatype: "url", datavalue: { type: "string", value: "https://www.stadt-zuerich.ch/" } },
            rank: "normal",
          },
        ],
        P94: [
          {
            mainsnak: { snaktype: "value", property: "P94", datatype: "commonsMedia", datavalue: { type: "string", value: "Wappen Zürich matt.svg" } },
            rank: "normal",
          },
        ],
        P281: [
          { mainsnak: { snaktype: "value", property: "P281", datatype: "string", datavalue: { type: "string", value: "8001" } }, rank: "normal" },
          { mainsnak: { snaktype: "value", property: "P281", datatype: "string", datavalue: { type: "string", value: "8002" } }, rank: "normal" },
        ],
        P771: [
          { mainsnak: { snaktype: "value", property: "P771", datatype: "external-id", datavalue: { type: "string", value: "261" } }, rank: "normal" },
        ],
        P902: [
          { mainsnak: { snaktype: "value", property: "P902", datatype: "external-id", datavalue: { type: "string", value: "000171" } }, rank: "normal" },
        ],
        P571: [
          {
            mainsnak: { snaktype: "value", property: "P571", datatype: "time", datavalue: { type: "time", value: { time: "-0015-00-00T00:00:00Z", precision: 9 } } },
            rank: "normal",
          },
        ],
      },
      sitelinks: {
        dewiki: { site: "dewiki", title: "Zürich", badges: [] },
        enwiki: { site: "enwiki", title: "Zürich", badges: [] },
        frwiki: { site: "frwiki", title: "Zurich", badges: [] },
        itwiki: { site: "itwiki", title: "Zurigo", badges: [] },
        eswiki: { site: "eswiki", title: "Zúrich", badges: [] },
      },
    },
  },
  success: 1,
};

function labelsFixture(ids) {
  const names = {
    P31: "instance of", P17: "country", P1082: "population", P2046: "area", P2044: "elevation above sea level",
    P625: "coordinate location", P856: "official website", P94: "coat of arms image", P281: "postal code", P571: "inception",
    Q70208: "municipality of Switzerland", Q39: "Switzerland",
  };
  const entities = {};
  for (const id of ids) entities[id] = { id, labels: names[id] ? { en: { language: "en", value: names[id] } } : {} };
  return { entities, success: 1 };
}

// ---------------------------------------------------------------------------
// Wikidata — pure helpers
// ---------------------------------------------------------------------------

test("wikidata: normaliseQid accepts ids and URIs", () => {
  assert.equal(normaliseQid("q72"), "Q72");
  assert.equal(normaliseQid(" Q72 "), "Q72");
  assert.equal(normaliseQid("http://www.wikidata.org/entity/Q1374"), "Q1374");
  assert.equal(normaliseQid("P771"), "P771");
  assert.equal(normaliseQid("Zürich"), undefined);
  assert.equal(normaliseQid("Q72; DROP"), undefined);
});

test("wikidata: sanitizers strip literal/search breakout characters", () => {
  assert.equal(sanitizeSparqlLiteral('Zürich" } ; DROP'), "Zürich DROP");
  assert.equal(sanitizeSparqlLiteral("Val-de-Travers"), "Val-de-Travers");
  assert.equal(sanitizeSearchText("Aare haswbstatement:P17=Q1|x"), "Aare haswbstatement P17 Q1 x");
});

test("wikidata: formatWdTime honours precision", () => {
  assert.equal(formatWdTime("+2023-12-31T00:00:00Z", 11), "2023-12-31");
  assert.equal(formatWdTime("+2023-12-00T00:00:00Z", 10), "2023-12");
  assert.equal(formatWdTime("+1291-08-01T00:00:00Z", 9), "1291");
  assert.equal(formatWdTime("-0015-00-00T00:00:00Z", 9), "-15");
  assert.equal(formatWdTime(undefined), undefined);
});

test("wikidata: simplifySnak covers the main datatypes", () => {
  const c = Q72_ENTITY.entities.Q72.claims;
  assert.deepEqual(simplifySnak(c.P31[0].mainsnak), { type: "item", id: "Q70208" });
  assert.deepEqual(simplifySnak(c.P2046[0].mainsnak), { type: "quantity", amount: 87.88, unit_id: "Q712226", unit: "km²" });
  assert.deepEqual(simplifySnak(c.P1082[0].mainsnak), { type: "quantity", amount: 421878 });
  assert.deepEqual(simplifySnak(c.P625[0].mainsnak), { type: "coordinates", lat: 47.374444, lon: 8.541111 });
  const coa = simplifySnak(c.P94[0].mainsnak);
  assert.equal(coa.type, "string");
  assert.equal(coa.url, "https://commons.wikimedia.org/wiki/Special:FilePath/Wappen_Z%C3%BCrich_matt.svg");
  assert.deepEqual(simplifySnak({ snaktype: "novalue", property: "P1" }), { type: "novalue" });
  assert.deepEqual(
    simplifySnak({ snaktype: "value", datavalue: { type: "monolingualtext", value: { text: "Zürich", language: "de" } } }),
    { type: "text", value: "Zürich", language: "de" },
  );
  assert.equal(simplifySnak(undefined), undefined);
  assert.equal(commonsFileUrl("A b.svg"), "https://commons.wikimedia.org/wiki/Special:FilePath/A_b.svg");
});

test("wikidata: bestClaims / latestClaim skip deprecated and pick newest P585", () => {
  const pop = Q72_ENTITY.entities.Q72.claims.P1082;
  assert.equal(bestClaims(pop).length, 2);
  const l = latestClaim(pop);
  assert.equal(l.value.amount, 443037);
  assert.equal(l.as_of, "2023-12-31");
  const withPreferred = [{ ...pop[0], rank: "preferred" }, pop[1]];
  assert.equal(latestClaim(withPreferred).value.amount, 421878);
  assert.deepEqual(latestClaim(undefined), {});
});

test("wikidata: wikipediaLinks / orderProperties / pickLang", () => {
  const links = wikipediaLinks(Q72_ENTITY.entities.Q72.sitelinks);
  assert.equal(links.de, "https://de.wikipedia.org/wiki/Z%C3%BCrich");
  assert.equal(links.fr, "https://fr.wikipedia.org/wiki/Zurich");
  assert.equal(links.es, undefined);
  assert.deepEqual(orderProperties(["P9999", "P1082", "P31"]), ["P31", "P1082", "P9999"]);
  assert.equal(pickLang({ de: { value: "Genf" }, fr: { value: "Genève" } }, "fr"), "Genève");
  assert.equal(pickLang({ rm: { value: "Cuira" } }, "it"), "Cuira");
  assert.equal(pickLang(undefined, "en"), undefined);
});

test("wikidata: guardSparql enforces read-only SELECT and a LIMIT ceiling", () => {
  assert.equal(guardSparql("INSERT DATA { <a> <b> <c> }").ok, false);
  assert.equal(guardSparql("DESCRIBE wd:Q72").ok, false);
  assert.equal(guardSparql("SELECT ?s WHERE { ?s ?p ?o } # then DELETE").ok, false);
  const injected = guardSparql("SELECT ?s WHERE { ?s wdt:P771 ?b }");
  assert.ok(injected.ok && /LIMIT 100$/.test(injected.query));
  const clamped = guardSparql("SELECT ?s WHERE { ?s ?p ?o } LIMIT 50000");
  assert.ok(clamped.ok && /LIMIT 1000$/.test(clamped.query));
  const kept = guardSparql("PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>\n# comment\nSELECT ?x WHERE { ?x rdfs:label ?l } LIMIT 5");
  assert.ok(kept.ok && /LIMIT 5$/.test(kept.query));
  const sub = guardSparql("SELECT ?x WHERE { { SELECT ?x WHERE { ?x ?p ?o } LIMIT 10 } }");
  assert.ok(sub.ok && sub.query.includes("LIMIT 10") && /LIMIT 100$/.test(sub.query) === false);
  const ask = guardSparql("ASK { wd:Q72 wdt:P17 wd:Q39 }");
  assert.ok(ask.ok && !ask.query.includes("LIMIT"));
});

test("wikidata: sparqlRows flattens bindings", () => {
  const out = sparqlRows({
    head: { vars: ["item", "bfs"] },
    results: { bindings: [{ item: { type: "uri", value: "http://www.wikidata.org/entity/Q72" }, bfs: { type: "literal", value: "261" } }, { item: { type: "uri", value: "x" } }] },
  });
  assert.deepEqual(out.variables, ["item", "bfs"]);
  assert.deepEqual(out.rows[1], { item: "x", bfs: undefined });
});

// ---------------------------------------------------------------------------
// Wikidata — handlers
// ---------------------------------------------------------------------------

test("wikidata: get_wikidata_entity resolves claims, labels, Swiss ids and sitelinks", async () => {
  const t = toolOf(wikidataModule, "get_wikidata_entity");
  const calls = await withFetch(
    (url) => {
      const u = new URL(url);
      assert.equal(u.hostname, "www.wikidata.org");
      assert.equal(u.searchParams.get("action"), "wbgetentities");
      if (u.searchParams.get("props") === "labels") return { body: labelsFixture(u.searchParams.get("ids").split("|")) };
      return { body: Q72_ENTITY };
    },
    async () => {
      const res = await t.handler({ id: "q72", language: "en", max_properties: 30, max_values_per_property: 5 });
      assert.ok(!res.isError, res.content[0].text);
      const body = parse(res);
      assert.equal(body.data.id, "Q72");
      assert.equal(body.data.labels.it, "Zurigo");
      assert.equal(body.data.swiss_identifiers.swiss_municipality_code_bfs, "261");
      assert.equal(body.data.swiss_identifiers.hls_dhs_dss_id, "000171");
      assert.equal(body.data.wikipedia.en, "https://en.wikipedia.org/wiki/Z%C3%BCrich");
      const props = body.data.properties;
      assert.equal(props[0].property, "P31");
      assert.equal(props[0].label, "instance of");
      assert.equal(props[0].values[0].label, "municipality of Switzerland");
      const pop = props.find((p) => p.property === "P1082");
      assert.equal(pop.values.length, 1);
      assert.equal(pop.values[0].amount, 443037);
      assert.equal(pop.as_of, "2023-12-31");
      assert.ok(!props.some((p) => p.property === "P771"), "Swiss ids reported separately");
      assert.equal(body.source.licence.startsWith("CC0"), true);
    },
  );
  assert.equal(calls.length, 2);
  assert.match(calls[0].init.headers["User-Agent"], /swissyphus/);
});

test("wikidata: get_wikidata_entity rejects non-Q ids and reports missing items", async () => {
  const t = toolOf(wikidataModule, "get_wikidata_entity");
  const bad = await t.handler({ id: "Zürich", language: "en", max_properties: 30, max_values_per_property: 5 });
  assert.equal(bad.isError, true);
  await withFetch(
    () => ({ body: { entities: { Q999999999: { id: "Q999999999", missing: "" } } } }),
    async () => {
      const res = await t.handler({ id: "Q999999999", language: "en", max_properties: 30, max_values_per_property: 5 });
      assert.equal(res.isError, true);
      assert.match(parse(res).error, /does not exist/);
    },
  );
});

test("wikidata: search_wikidata (plain) maps wbsearchentities results", async () => {
  const t = toolOf(wikidataModule, "search_wikidata");
  await withFetch(
    (url) => {
      const u = new URL(url);
      assert.equal(u.searchParams.get("action"), "wbsearchentities");
      assert.equal(u.searchParams.get("search"), "Matterhorn");
      return {
        body: {
          searchinfo: { search: "Matterhorn" },
          search: [
            { id: "Q1374", concepturi: "http://www.wikidata.org/entity/Q1374", label: "Matterhorn", description: "mountain in the Alps", match: { type: "label", language: "en", text: "Matterhorn" } },
            { id: "Q123", label: "Matterhorn Gotthard Bahn", description: "railway company", match: { type: "alias", language: "en", text: "Matterhorn Gotthard" } },
          ],
          success: 1,
        },
      };
    },
    async () => {
      const res = await t.handler({ query: "Matterhorn", language: "en", swiss_only: false, limit: 10 });
      const body = parse(res);
      assert.equal(body.data.count, 2);
      assert.equal(body.data.results[0].id, "Q1374");
      assert.equal(body.data.results[0].matched, undefined);
      assert.equal(body.data.results[1].matched, "Matterhorn Gotthard");
    },
  );
});

test("wikidata: search_wikidata swiss_only uses haswbstatement and resolves labels", async () => {
  const t = toolOf(wikidataModule, "search_wikidata");
  const calls = await withFetch(
    (url) => {
      const u = new URL(url);
      if (u.searchParams.get("list") === "search") {
        assert.match(u.searchParams.get("srsearch"), /^Aare haswbstatement:P17=Q39\|P27=Q39$/);
        return { body: { batchcomplete: "", query: { searchinfo: { totalhits: 2 }, search: [{ ns: 0, title: "Q14362" }, { ns: 0, title: "Q656" }] } } };
      }
      return {
        body: {
          entities: {
            Q14362: { id: "Q14362", labels: { en: { value: "Aare" } }, descriptions: { en: { value: "river in Switzerland" } } },
            Q656: { id: "Q656", labels: { de: { value: "Aarau" } } },
          },
        },
      };
    },
    async () => {
      const res = await t.handler({ query: "Aare", language: "en", swiss_only: true, limit: 5 });
      const body = parse(res);
      assert.equal(body.data.total_hits, 2);
      assert.equal(body.data.results[0].description, "river in Switzerland");
      assert.equal(body.data.results[1].label, "Aarau");
    },
  );
  assert.equal(calls.length, 2);
});

test("wikidata: query_wikidata injects LIMIT, sends GET to WDQS and flattens rows", async () => {
  const t = toolOf(wikidataModule, "query_wikidata");
  const denied = await t.handler({ query: "DELETE WHERE { ?s ?p ?o }" });
  assert.equal(denied.isError, true);
  const calls = await withFetch(
    (url) => {
      const u = new URL(url);
      assert.equal(u.hostname, "query.wikidata.org");
      assert.equal(u.searchParams.get("format"), "json");
      assert.match(u.searchParams.get("query"), /LIMIT 100$/);
      return {
        body: {
          head: { vars: ["m", "mLabel"] },
          results: { bindings: [{ m: { type: "uri", value: "http://www.wikidata.org/entity/Q72" }, mLabel: { type: "literal", value: "Zürich", "xml:lang": "de" } }] },
        },
      };
    },
    async () => {
      const res = await t.handler({ query: "SELECT ?m ?mLabel WHERE { ?m wdt:P771 \"261\" . SERVICE wikibase:label { bd:serviceParam wikibase:language \"de\". } }" });
      const body = parse(res);
      assert.equal(body.data.row_count, 1);
      assert.equal(body.data.rows[0].mLabel, "Zürich");
    },
  );
  assert.equal(calls[0].init.headers.Accept, "application/sparql-results+json");
});

test("wikidata: get_swiss_municipality_facts by BFS number", async () => {
  const t = toolOf(wikidataModule, "get_swiss_municipality_facts");
  const missing = await t.handler({ language: "en", include_former: false });
  assert.equal(missing.isError, true);
  await withFetch(
    (url) => {
      const u = new URL(url);
      if (u.hostname === "query.wikidata.org") {
        const q = u.searchParams.get("query");
        assert.match(q, /wdt:P771 "261"/);
        assert.match(q, /wd:Q23058/);
        return {
          body: {
            head: { vars: ["item", "itemLabel", "bfs", "canton", "cantonLabel", "dissolved"] },
            results: {
              bindings: [
                {
                  item: { type: "uri", value: "http://www.wikidata.org/entity/Q72" },
                  itemLabel: { type: "literal", value: "Zürich" },
                  bfs: { type: "literal", value: "261" },
                  canton: { type: "uri", value: "http://www.wikidata.org/entity/Q11943" },
                  cantonLabel: { type: "literal", value: "canton of Zürich" },
                },
              ],
            },
          },
        };
      }
      return { body: Q72_ENTITY };
    },
    async () => {
      const res = await t.handler({ bfs_number: 261, language: "de", include_former: false });
      assert.ok(!res.isError, res.content[0].text);
      const d = parse(res).data;
      assert.equal(d.id, "Q72");
      assert.equal(d.name, "Zürich");
      assert.equal(d.bfs_number, 261);
      assert.equal(d.canton, "canton of Zürich");
      assert.equal(d.population, 443037);
      assert.equal(d.population_as_of, "2023-12-31");
      assert.deepEqual(d.area, { value: 87.88, unit: "km²" });
      assert.deepEqual(d.elevation, { value: 408, unit: "m" });
      assert.deepEqual(d.coordinates, { lat: 47.374444, lon: 8.541111 });
      assert.deepEqual(d.postal_codes, ["8001", "8002"]);
      assert.equal(d.official_website, "https://www.stadt-zuerich.ch/");
      assert.match(d.coat_of_arms.url, /Special:FilePath\/Wappen_Z/);
      assert.equal(d.hls_dhs_id, "000171");
      assert.equal(d.wikipedia, "https://de.wikipedia.org/wiki/Z%C3%BCrich");
    },
  );
});

test("wikidata: get_swiss_municipality_facts by name filters dissolved and ranks exact match", async () => {
  const t = toolOf(wikidataModule, "get_swiss_municipality_facts");
  await withFetch(
    (url) => {
      const u = new URL(url);
      if (u.hostname === "query.wikidata.org") {
        const q = u.searchParams.get("query");
        assert.match(q, /CONTAINS\(LCASE\(STR\(\?l\)\), "bern"\)/);
        const row = (id, label, bfs, dissolved) => ({
          item: { value: `http://www.wikidata.org/entity/${id}` },
          itemLabel: { value: label },
          bfs: { value: bfs },
          ...(dissolved ? { dissolved: { value: dissolved } } : {}),
        });
        return {
          body: {
            head: { vars: ["item", "itemLabel", "bfs", "canton", "cantonLabel", "dissolved"] },
            results: { bindings: [row("Q68974", "Berneck", "3232"), row("Q70", "Bern", "351"), row("Q999", "Bernold", "9999", "1999-01-01T00:00:00Z")] },
          },
        };
      }
      assert.equal(u.searchParams.get("ids"), "Q70");
      return { body: { entities: { Q70: { id: "Q70", labels: { en: { value: "Bern" } }, claims: {}, sitelinks: {} } } } };
    },
    async () => {
      const res = await t.handler({ name: 'Bern"}', language: "en", include_former: false });
      const d = parse(res).data;
      assert.equal(d.id, "Q70");
      assert.equal(d.other_matches.length, 1);
      assert.equal(d.other_matches[0].id, "Q68974");
    },
  );
});

// ---------------------------------------------------------------------------
// SNB — pure helpers
// ---------------------------------------------------------------------------

const DEVKUM_DIMS = {
  cubeId: "devkum",
  dimensions: [
    { id: "D0", name: "Monthly average/End of month", dimensionItems: [{ id: "M0", name: "Monthly average" }, { id: "M1", name: "End of month" }] },
    {
      id: "D1",
      name: "Currency",
      dimensionItems: [
        { id: "EUROPE", name: "Europe", dimensionItems: [{ id: "EUR1", name: "Euro area - EUR 1" }, { id: "GBP1", name: "United Kingdom - GBP 1" }] },
        { id: "USD1", name: "USA - USD 1" },
      ],
    },
  ],
};

test("snb: parseSnbDimensions flattens nested items and flags groups", () => {
  const dims = parseSnbDimensions(DEVKUM_DIMS);
  assert.equal(dims.length, 2);
  assert.equal(dims[1].item_count, 4);
  assert.deepEqual(dims[1].items[0], { id: "EUROPE", name: "Europe", depth: 0, is_group: true });
  assert.deepEqual(dims[1].items[1], { id: "EUR1", name: "Euro area - EUR 1", depth: 1, is_group: false, parent: "EUROPE" });
  assert.equal(parseSnbDimensions(DEVKUM_DIMS, 2)[1].items.length, 2);
  assert.deepEqual(parseSnbDimensions({}), []);
});

test("snb: buildDimSel encodes and sanitises selections", () => {
  assert.equal(buildDimSel({ D0: ["M0"], D1: ["EUR1", "USD1"] }), "D0(M0),D1(EUR1,USD1)");
  assert.equal(buildDimSel({ "D0)": ["M0),X(("] }), "D0(M0X)");
  assert.equal(buildDimSel({ D0: [] }), undefined);
  assert.equal(buildDimSel(undefined), undefined);
});

test("snb: labelSnbSeries labels dims and trims to the most recent values", () => {
  const data = {
    timeseries: [
      {
        metadata: { key: "EPB@SNB.zimoma{SARON}", unit: "Percent", scale: "0", frequency: "monthly" },
        header: [{ dim: "Rate", dimItem: "SARON" }],
        values: [
          { date: "2024-01", value: 1.7 },
          { date: "2024-02", value: 1.69 },
          { date: "2024-03", value: null },
        ],
      },
      { metadata: { key: "other" }, header: [], values: [] },
    ],
  };
  const out = labelSnbSeries(data, 1, 2);
  assert.equal(out.series_count_total, 2);
  assert.equal(out.series.length, 1);
  const s = out.series[0];
  assert.deepEqual(s.dimensions, { Rate: "SARON" });
  assert.equal(s.unit, "Percent");
  assert.equal(s.value_count_total, 3);
  assert.equal(s.first_date, "2024-01");
  assert.deepEqual(s.values, [{ date: "2024-02", value: 1.69 }, { date: "2024-03", value: null }]);
  assert.deepEqual(s.latest, { date: "2024-02", value: 1.69 });
});

test("snb: curated datasets have unique ids, confidence flags and searchable keywords", () => {
  const ids = SNB_DATASETS.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(SNB_DATASETS.every((d) => ["high", "medium", "low"].includes(d.confidence)));
  assert.equal(SNB_DATASETS.find((d) => d.id === "devkum").confidence, "high");
  assert.equal(searchSnbDatasets("saron")[0].id, "zimoma");
  assert.equal(searchSnbDatasets("bond yield")[0].id, "rendoblim");
  assert.deepEqual(searchSnbDatasets("zzzz"), []);
});

test("snb: searcher is registered for find_data and points at get_snb_data", async () => {
  const s = getSearchers().find((x) => x.catalogue === "SNB data portal");
  assert.ok(s);
  assert.equal(s.module, "fx");
  const hits = await s.search("balance sheet", 3, "en");
  assert.equal(hits[0].id, "snbbipo");
  assert.deepEqual(hits[0].next, { tool: "get_snb_data", args: { cube_id: "snbbipo" } });
  assert.ok(fxModule.tools.some((t) => t.name === hits[0].next.tool));
});

// ---------------------------------------------------------------------------
// SNB — handlers
// ---------------------------------------------------------------------------

test("snb: get_snb_data builds fromDate/toDate/dimSel and returns labelled series", async () => {
  const t = toolOf(fxModule, "get_snb_data");
  await withFetch(
    (url) => {
      const u = new URL(url);
      assert.equal(u.pathname, "/api/cube/devkum/data/json/en");
      assert.equal(u.searchParams.get("fromDate"), "2024-01");
      assert.equal(u.searchParams.get("toDate"), "2024-03");
      assert.equal(u.searchParams.get("dimSel"), "D0(M0),D1(EUR1)");
      return {
        body: {
          timeseries: [
            {
              metadata: { key: "EPB@SNB.devkum{M0,EUR1}", unit: "CHF", scale: "0" },
              header: [{ dim: "Monthly average/End of month", dimItem: "Monthly average" }, { dim: "Currency", dimItem: "Euro area - EUR 1" }],
              values: [{ date: "2024-01", value: 0.9357 }, { date: "2024-02", value: 0.9474 }, { date: "2024-03", value: 0.9709 }],
            },
          ],
        },
      };
    },
    async () => {
      const res = await t.handler({
        cube_id: "devkum",
        from_date: "2024-01",
        to_date: "2024-03",
        dimension_selection: { D0: ["M0"], D1: ["EUR1"] },
        language: "en",
        limit: 20,
        values_per_series: 60,
      });
      assert.ok(!res.isError, res.content[0].text);
      const body = parse(res);
      assert.equal(body.data.series_returned, 1);
      assert.equal(body.data.series[0].dimensions.Currency, "Euro area - EUR 1");
      assert.deepEqual(body.data.series[0].latest, { date: "2024-03", value: 0.9709 });
      assert.equal(body.data_as_of, "2024-03");
      assert.equal(body.source.operator, "Swiss National Bank");
    },
  );
});

test("snb: get_snb_cube_dimensions returns flattened dims; unknown cube → actionable error", async () => {
  const t = toolOf(fxModule, "get_snb_cube_dimensions");
  await withFetch(
    (url) => (url.endsWith("/api/cube/devkum/dimensions/de") ? { body: DEVKUM_DIMS } : { status: 404, body: "Not Found" }),
    async () => {
      const ok = parse(await t.handler({ cube_id: "devkum", language: "de", max_items_per_dimension: 200 }));
      assert.equal(ok.data.cube_id, "devkum");
      assert.equal(ok.data.dimensions[0].items[0].id, "M0");
      const bad = await t.handler({ cube_id: "nosuchcube", language: "de", max_items_per_dimension: 200 });
      assert.equal(bad.isError, true);
      assert.match(parse(bad).error, /not found/);
    },
  );
});

test("snb: list_snb_datasets filters and flags confidence", async () => {
  const t = toolOf(fxModule, "list_snb_datasets");
  const all = parse(await t.handler({}));
  assert.equal(all.data.count, SNB_DATASETS.length);
  const f = parse(await t.handler({ query: "money supply" }));
  assert.equal(f.data.datasets[0].cube_id, "snbmonagg");
  assert.ok(f.data.datasets[0].id_confidence);
  const none = await t.handler({ query: "zzzz" });
  assert.equal(none.isError, true);
});

test("snb: existing get_exchange_rate still works", async () => {
  const t = toolOf(fxModule, "get_exchange_rate");
  await withFetch(
    (url) => {
      assert.match(url, /\/api\/cube\/devkum\/data\/json\/en\?fromDate=/);
      return {
        body: {
          timeseries: [
            {
              metadata: { key: "EPB@SNB.devkum{M0,EUR1}", unit: "CHF" },
              header: [{ dim: "Currency", dimItem: "Euro area - EUR 1" }],
              values: [{ date: "2026-07", value: 0.93 }, { date: "2026-08", value: 0.94 }],
            },
          ],
        },
      };
    },
    async () => {
      const body = parse(await t.handler({ currency: "eur" }));
      assert.equal(body.data.rate_chf, 0.94);
      assert.equal(body.data.per_units, 1);
    },
  );
});

test("modules: tool names are unique and hosts allowlisted", async () => {
  const { isAllowedHost } = await import("../dist/core/http.js");
  assert.ok(isAllowedHost("query.wikidata.org"));
  assert.ok(isAllowedHost("www.wikidata.org"));
  const names = [...wikidataModule.tools, ...fxModule.tools].map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const n of ["search_wikidata", "get_wikidata_entity", "query_wikidata", "get_swiss_municipality_facts", "list_snb_datasets", "get_snb_cube_dimensions", "get_snb_data"]) {
    assert.ok(names.includes(n), n);
  }
});
