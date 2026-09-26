/**
 * Offline tests for the opendata.swiss / Stadt Zürich CKAN connector:
 * pure helpers (multilingual picking, resource ranking, licences, search URL,
 * aggregation, row fitting) and full handler paths with a stubbed fetch and
 * recorded-style CKAN fixtures.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  pickLang,
  classifyResource,
  rankResources,
  findResource,
  describeLicence,
  buildSearchUrl,
  formatVariants,
  aggregateRows,
  toNumber,
  fitRows,
  PORTALS,
} from "../dist/modules/ckanPortals.js";
import { statisticsModule } from "../dist/modules/statistics.js";
import { getSearchers } from "../dist/core/discovery.js";
import { parseResource } from "../dist/core/tabular.js";
import { setPublicTransportForTests, fetchBackedTransport } from "../dist/core/http.js";

const toolByName = (n) => statisticsModule.tools.find((t) => t.name === n);
const envelope = (res) => JSON.parse(res.content[0].text);

/** Install a fetch stub routing by URL substring; returns restore(). */
function stubFetch(routes, log = []) {
  const orig = globalThis.fetch;
  setPublicTransportForTests(fetchBackedTransport);
  globalThis.fetch = async (input) => {
    const url = String(input instanceof URL ? input.href : input?.url ?? input);
    log.push(url);
    for (const [needle, reply] of routes) {
      if (url.includes(needle)) {
        const r = typeof reply === "function" ? reply(url) : reply;
        if (r instanceof Response) return r;
        const body = typeof r === "string" ? r : JSON.stringify(r);
        return new Response(body, { status: 200, headers: { "content-type": typeof r === "string" ? "text/csv" : "application/json" } });
      }
    }
    return new Response(JSON.stringify({ success: false, error: { __type: "Not Found Error", message: "Not found" } }), { status: 404 });
  };
  return () => {
    globalThis.fetch = orig;
    setPublicTransportForTests(undefined);
  };
}

// ── Fixtures (shape of CKAN 2.x / opendata.swiss responses) ──────────────

const POP_CSV =
  "Jahr;Kanton;Gemeinde;Einwohner\n2023;ZH;Zürich;427721\n2023;ZH;Winterthur;120376\n2023;BE;Bern;134591\n2023;BE;Biel/Bienne;55159\n2022;ZH;Zürich;423193\n2022;BE;Bern;134794\n";

function datasetFixture(name, csvUrl) {
  return {
    help: "https://ckan.opendata.swiss/api/3/action/help_show?name=package_show",
    success: true,
    result: {
      id: "5f1c-uuid",
      name,
      title: { de: "Bevölkerung der Gemeinden", fr: "Population des communes", it: "", en: "Population of municipalities" },
      notes: { de: "Ständige Wohnbevölkerung", fr: "Population résidante permanente", it: "", en: "Permanent resident population" },
      metadata_modified: "2025-06-02T08:15:00.123456",
      organization: {
        name: "bundesamt-fur-statistik-bfs",
        title: '{"de": "Bundesamt für Statistik", "fr": "Office fédéral de la statistique", "it": "Ufficio federale di statistica", "en": "Federal Statistical Office"}',
      },
      resources: [
        { id: "r0", title: { de: "Webseite", en: "Website" }, format: "HTML", url: "https://www.bfs.admin.ch/bfs/de/home.html", download_url: "" },
        { id: "r1", title: { de: "Tabelle", en: "Table" }, format: "XLSX", download_url: "https://dam-api.bfs.admin.ch/hub/api/dam/assets/123/master" },
        {
          id: "r2",
          title: { de: "Daten CSV", en: "Data CSV" },
          format: "CSV",
          media_type: "text/csv",
          download_url: csvUrl,
          url: csvUrl,
          rights: "NonCommercialAllowed-CommercialAllowed-ReferenceRequired",
          license: "https://opendata.swiss/terms-of-use#terms_by",
        },
      ],
    },
  };
}

// ── Pure helpers ──────────────────────────────────────────────────────────

test("pickLang: objects, JSON-encoded strings, fallbacks, plain strings", () => {
  assert.equal(pickLang({ de: "Haus", en: "House" }, "en"), "House");
  assert.equal(pickLang({ de: "Haus", en: "" }, "en"), "Haus");
  assert.equal(pickLang({ de: "Haus", fr: "Maison" }, "fr"), "Maison");
  assert.equal(pickLang('{"de": "Bundesamt für Statistik", "fr": "OFS"}', "fr"), "OFS");
  assert.equal(pickLang("Stadt Zürich", "en"), "Stadt Zürich");
  assert.equal(pickLang(undefined), undefined);
  assert.equal(pickLang("{not json", "en"), "{not json");
});

test("classifyResource: format, media type, extension; zip wins over declared CSV", () => {
  assert.equal(classifyResource({ format: "CSV", download_url: "https://x.ch/a.csv" }), "csv");
  assert.equal(classifyResource({ format: "CSV", download_url: "https://x.ch/a.zip" }), "zip");
  assert.equal(classifyResource({ format: "", media_type: "application/geo+json", url: "https://x.ch/a" }), "geojson");
  assert.equal(classifyResource({ format: "GeoJSON", url: "https://x.ch/a" }), "geojson");
  assert.equal(classifyResource({ format: "JSON", url: "https://x.ch/api" }), "json");
  assert.equal(classifyResource({ format: "XLSX", url: "https://x.ch/a" }), "xlsx");
  assert.equal(classifyResource({ format: "HTML", url: "https://x.ch/" }), "html");
  assert.equal(classifyResource({ format: "WMS", url: "https://wms.geo.admin.ch/" }), "service");
  assert.equal(classifyResource({ format: "PDF", url: "https://x.ch/a.pdf" }), "pdf");
  assert.equal(classifyResource({ url: "https://x.ch/export.tsv" }), "csv");
  assert.equal(classifyResource({ url: "https://x.ch/export" }), "unknown");
  assert.equal(classifyResource({ format: "Parquet", url: "https://x.ch/a.parquet" }), "parquet");
});

test("rankResources: CSV > JSON > GeoJSON, skips HTML/XLSX/ZIP with reasons, honours prefer", () => {
  const res = [
    { format: "HTML", url: "https://x.ch/landing" },
    { format: "GeoJSON", download_url: "https://x.ch/a.geojson" },
    { format: "JSON", download_url: "https://x.ch/a.json" },
    { format: "CSV", download_url: "https://x.ch/a.csv" },
    { format: "ZIP", download_url: "https://x.ch/a.zip" },
    { format: "XLSX", download_url: "https://x.ch/a.xlsx" },
    { format: "CSV" },
  ];
  const { candidates, skipped } = rankResources(res);
  assert.deepEqual(candidates.map((c) => c.kind), ["csv", "json", "geojson"]);
  assert.deepEqual(skipped.map((s) => s.kind), ["html", "zip", "xlsx", "csv"]);
  assert.match(skipped[0].reason, /landing page/);
  assert.equal(skipped[3].reason, "no download URL");
  assert.equal(skipped[1].url, "https://x.ch/a.zip");
  assert.equal(rankResources(res, { prefer: "geojson" }).candidates[0].kind, "geojson");
});

test("findResource: by index, id and title substring (multilingual)", () => {
  const res = [
    { id: "aaa", title: { de: "Übersicht", en: "Overview" }, format: "HTML", url: "https://x.ch/" },
    { id: "bbb", title: { de: "Rohdaten", en: "Raw data" }, format: "CSV", url: "https://x.ch/a.csv" },
  ];
  assert.equal(findResource(res, "1").index, 1);
  assert.equal(findResource(res, "aaa").index, 0);
  assert.equal(findResource(res, "rohdaten").kind, "csv");
  assert.equal(findResource(res, "7"), undefined);
});

test("describeLicence: terms URL, legacy rights code, cc-zero, passthrough", () => {
  assert.match(describeLicence("https://opendata.swiss/terms-of-use#terms_by"), /Must provide the source.*terms_by/);
  assert.match(describeLicence("NonCommercialAllowed-CommercialWithPermission-ReferenceRequired"), /terms_by_ask/);
  assert.match(describeLicence("cc-zero"), /CC0/);
  assert.match(describeLicence("Creative Commons CCZero"), /CC0/);
  assert.equal(describeLicence("Other licence"), "Other licence");
  assert.equal(describeLicence(""), undefined);
});

test("buildSearchUrl: q, rows/start, sanitized publisher + format fq, sort mapping", () => {
  const u = new URL(
    buildSearchUrl(PORTALS["opendata.swiss"], {
      query: "Bevölkerung",
      publisher: 'bfs" OR *:*',
      format: "geojson",
      sort: "modified",
      rows: 5,
      start: 10,
    }),
  );
  assert.equal(u.origin + u.pathname, "https://ckan.opendata.swiss/api/3/action/package_search");
  assert.equal(u.searchParams.get("q"), "Bevölkerung");
  assert.equal(u.searchParams.get("rows"), "5");
  assert.equal(u.searchParams.get("start"), "10");
  const fq = u.searchParams.get("fq");
  assert.match(fq, /^organization:"bfsor" AND res_format:\(/);
  assert.match(fq, /"GeoJSON"/);
  assert.match(fq, /"GEOJSON"/);
  assert.equal(u.searchParams.get("sort"), "metadata_modified desc");
  const z = new URL(buildSearchUrl(PORTALS["stadt-zuerich"], { rows: 3 }));
  assert.equal(z.hostname, "data.stadt-zuerich.ch");
  assert.equal(z.searchParams.get("q"), "*:*");
  assert.deepEqual(formatVariants('CSV"; drop'), ["CSV drop", "CSV DROP", "csv drop"]);
  assert.deepEqual(formatVariants("geojson"), ["geojson", "GEOJSON", "GeoJSON"]);
});

test("toNumber: Swiss thousands separators and decimal commas", () => {
  assert.equal(toNumber(12), 12);
  assert.equal(toNumber("1'234.5"), 1234.5);
  assert.equal(toNumber("1’234"), 1234);
  assert.equal(toNumber("12,5"), 12.5);
  assert.ok(Number.isNaN(toNumber("n/a")));
  assert.ok(Number.isNaN(toNumber(null)));
});

test("aggregateRows: group by 1 and 2 columns with count/sum/avg/min/max and filters", () => {
  const t = parseResource(POP_CSV);
  let a = aggregateRows(t, { groupBy: ["kanton"], op: "sum", valueColumn: "einwohner", where: { Jahr: "2023" } });
  assert.deepEqual(a.group_by, ["Kanton"]);
  assert.equal(a.rows_matched, 4);
  assert.deepEqual(a.groups, [
    { Kanton: "ZH", count: 2, sum: 548097 },
    { Kanton: "BE", count: 2, sum: 189750 },
  ]);
  a = aggregateRows(t, { groupBy: ["Jahr", "Kanton"], op: "avg", valueColumn: "Einwohner", order: "group" });
  assert.equal(a.total_groups, 4);
  assert.deepEqual(a.groups[0], { Jahr: 2022, Kanton: "BE", count: 1, avg: 134794 });
  a = aggregateRows(t, { groupBy: ["Kanton"], op: "max", valueColumn: "Einwohner", order: "asc" });
  assert.deepEqual(a.groups.map((g) => [g.Kanton, g.max]), [["BE", 134794], ["ZH", 427721]]);
  a = aggregateRows(t, { op: "min", valueColumn: "Einwohner" });
  assert.deepEqual(a.groups, [{ count: 6, min: 55159 }]);
  a = aggregateRows(t, { groupBy: ["Kanton"], op: "count", search: "bern" });
  assert.deepEqual(a.groups, [{ Kanton: "BE", count: 2 }]);
  a = aggregateRows(t, { groupBy: ["Nope"], op: "sum", valueColumn: "Einwohner" });
  assert.deepEqual(a.unknown_columns, ["Nope"]);
  a = aggregateRows(t, { groupBy: ["Kanton"], op: "sum" });
  assert.equal(a.unknown_columns.length, 1);
});

test("aggregateRows: non-numeric cells are skipped and counted; Swiss formats summed", () => {
  const t = parseResource("Typ;Betrag\nA;1'000\nA;n/a\nB;2,5\nB;3\n");
  const a = aggregateRows(t, { groupBy: ["Typ"], op: "sum", valueColumn: "Betrag", order: "group" });
  assert.equal(a.rows_skipped_non_numeric, 1);
  assert.deepEqual(a.groups, [
    { Typ: "A", count: 2, sum: 1000 },
    { Typ: "B", count: 2, sum: 5.5 },
  ]);
});

test("fitRows: trims long cells and drops rows beyond the budget", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ i, text: "x".repeat(1000) }));
  const f = fitRows(rows, 10_000, 100);
  assert.equal(f.trimmedCells, 100);
  assert.ok(f.rows.length < 100 && f.rows.length > 50);
  assert.equal(f.dropped, 100 - f.rows.length);
  assert.ok(JSON.stringify(f.rows).length <= 10_000);
});

// ── Handler paths (stubbed fetch) ─────────────────────────────────────────

test("query_dataset: picks the CSV over HTML/XLSX, filters, sorts, reports licence and skipped resources", async () => {
  const csvUrl = "https://8.8.8.8/files/pop-q.csv";
  const log = [];
  const restore = stubFetch(
    [
      ["package_show?id=pop-q", datasetFixture("pop-q", csvUrl)],
      ["/files/pop-q.csv", POP_CSV],
    ],
    log,
  );
  try {
    const res = await toolByName("query_dataset").handler({
      id: "pop-q",
      where: { Kanton: "ZH", Jahr: 2023 },
      sort: "-Einwohner",
      columns: ["Gemeinde", "Einwohner"],
    });
    assert.equal(res.isError, undefined, res.content[0].text);
    const env = envelope(res);
    const d = env.data;
    assert.deepEqual(d.columns, ["Jahr", "Kanton", "Gemeinde", "Einwohner"]);
    assert.equal(d.total_rows, 6);
    assert.equal(d.total_matched, 2);
    assert.deepEqual(d.rows, [
      { Gemeinde: "Zürich", Einwohner: 427721 },
      { Gemeinde: "Winterthur", Einwohner: 120376 },
    ]);
    assert.equal(d.resource.index, 2);
    assert.equal(d.resource.url, csvUrl);
    assert.match(d.licence, /terms_by/);
    assert.equal(d.dataset.publisher, "Federal Statistical Office");
    assert.equal(d.dataset.url, "https://opendata.swiss/en/dataset/pop-q");
    assert.deepEqual(d.not_parseable_resources.map((s) => s.kind), ["html", "xlsx"]);
    assert.equal(d.not_parseable_resources[1].url, "https://dam-api.bfs.admin.ch/hub/api/dam/assets/123/master");
    assert.match(env.source.licence, /terms_by/);
    assert.match(env.source.attribution, /Federal Statistical Office/);
    assert.ok(!log.some((u) => u.includes("dam-api")), "non-parseable resources must not be fetched");
  } finally {
    restore();
  }
});

test("query_dataset: direct resource_url, limit/offset paging and truncation flag", async () => {
  const restore = stubFetch([["/direct/pop.csv", POP_CSV]]);
  try {
    const res = await toolByName("query_dataset").handler({ resource_url: "https://8.8.8.8/direct/pop.csv", limit: 2, offset: 1 });
    const d = envelope(res).data;
    assert.equal(d.total_matched, 6);
    assert.equal(d.returned, 2);
    assert.equal(d.rows[0].Gemeinde, "Winterthur");
    assert.equal(d.truncated, true);
    assert.equal(d.resource.format, "csv");
  } finally {
    restore();
  }
});

test("query_dataset: dataset without parseable resources lists download URLs; unknown id is a clear error", async () => {
  const fx = datasetFixture("only-xlsx", "https://8.8.8.8/x.csv");
  fx.result.resources = fx.result.resources.slice(0, 2);
  const restore = stubFetch([["package_show?id=only-xlsx", fx]]);
  try {
    let res = await toolByName("query_dataset").handler({ id: "only-xlsx" });
    assert.equal(res.isError, true);
    const body = JSON.parse(res.content[0].text);
    assert.match(body.error, /no machine-readable resource/);
    assert.ok(body.suggestions.some((s) => s.includes("dam-api.bfs.admin.ch")));
    res = await toolByName("query_dataset").handler({ id: "does-not-exist" });
    assert.equal(res.isError, true);
    assert.match(JSON.parse(res.content[0].text).error, /not found/);
    res = await toolByName("query_dataset").handler({});
    assert.equal(res.isError, true);
  } finally {
    restore();
  }
});

test("query_dataset: HTML served under a CSV label falls through to the next candidate", async () => {
  const fx = datasetFixture("fallthrough", "https://8.8.8.8/files/fake.csv");
  fx.result.resources.push({ format: "JSON", download_url: "https://8.8.8.8/files/real.json" });
  const restore = stubFetch([
    ["package_show?id=fallthrough", fx],
    ["/files/fake.csv", new Response("<!doctype html><html>moved</html>", { status: 200, headers: { "content-type": "text/html" } })],
    ["/files/real.json", { data: [{ a: 1 }, { a: 2 }] }],
  ]);
  try {
    const d = envelope(await toolByName("query_dataset").handler({ id: "fallthrough" })).data;
    assert.equal(d.resource.index, 3);
    assert.equal(d.total_rows, 2);
    assert.ok(d.notes.some((n) => n.includes("fake.csv")));
  } finally {
    restore();
  }
});

test("describe_dataset_columns and aggregate_dataset on a Stadt Zürich dataset", async () => {
  const fx = {
    success: true,
    result: {
      name: "sd_zv_velozaehlung",
      title: "Velozählungen",
      notes: "Zählstellen Velo",
      license_id: "cc-zero",
      license_title: "Creative Commons CCZero",
      metadata_modified: "2026-09-01T00:00:00",
      organization: { name: "tiefbauamt", title: "Tiefbauamt" },
      resources: [{ id: "z1", name: "2026_verkehrszaehlungen.csv", format: "CSV", url: "https://8.8.8.8/zh/velo.csv" }],
    },
  };
  const csv = "Standort,Monat,Anzahl\nMythenquai,1,1'200\nMythenquai,2,1'500\nLimmatquai,1,900\nLimmatquai,2,\n";
  const log = [];
  const restore = stubFetch(
    [
      ["data.stadt-zuerich.ch/api/3/action/package_show?id=sd_zv_velozaehlung", fx],
      ["/zh/velo.csv", csv],
    ],
    log,
  );
  try {
    const desc = envelope(await toolByName("describe_dataset_columns").handler({ id: "sd_zv_velozaehlung", portal: "stadt-zuerich" }));
    assert.equal(desc.data.row_count, 4);
    assert.equal(desc.data.columns.find((c) => c.column === "Monat").type, "number");
    assert.deepEqual(desc.data.numeric_columns, ["Monat"]);
    assert.match(desc.data.licence, /CC0/);
    assert.equal(desc.data.dataset.url, "https://data.stadt-zuerich.ch/dataset/sd_zv_velozaehlung");
    assert.equal(desc.source.name, "Open Data Stadt Zürich (CKAN catalogue)");

    const agg = envelope(
      await toolByName("aggregate_dataset").handler({
        id: "sd_zv_velozaehlung",
        portal: "stadt-zuerich",
        group_by: ["standort"],
        op: "sum",
        value_column: "anzahl",
      }),
    );
    assert.deepEqual(agg.data.groups, [
      { Standort: "Mythenquai", count: 2, sum: 2700 },
      { Standort: "Limmatquai", count: 2, sum: 900 },
    ]);
    assert.equal(agg.data.rows_skipped_non_numeric, 1);
    assert.equal(agg.cache_status, "computed");
    assert.ok(log.some((u) => u.startsWith("https://data.stadt-zuerich.ch/api/3/action/package_show")));

    const bad = await toolByName("aggregate_dataset").handler({ id: "sd_zv_velozaehlung", portal: "stadt-zuerich", op: "avg" });
    assert.equal(bad.isError, true);
    const bad2 = await toolByName("aggregate_dataset").handler({
      id: "sd_zv_velozaehlung",
      portal: "stadt-zuerich",
      group_by: ["Quartier"],
      op: "count",
    });
    assert.equal(bad2.isError, true);
    assert.match(JSON.parse(bad2.content[0].text).suggestions[0], /Standort/);
  } finally {
    restore();
  }
});

test("search_datasets: format/sort/lang params reach CKAN; hits carry formats + queryable (backward-compatible shape)", async () => {
  const log = [];
  const hit = datasetFixture("pop-s", "https://8.8.8.8/files/pop-s.csv").result;
  const restore = stubFetch([["package_search", { success: true, result: { count: 1, results: [hit] } }]], log);
  try {
    const env = envelope(
      await toolByName("search_datasets").handler({ query: "Bevölkerung", format: "csv", sort: "modified", lang: "fr", limit: 5 }),
    );
    const r = env.data.results[0];
    assert.equal(env.data.total_matches, 1);
    assert.equal(r.id, "pop-s");
    assert.equal(r.title, "Population des communes");
    assert.equal(r.publisher, "Office fédéral de la statistique");
    assert.equal(r.publisher_id, "bundesamt-fur-statistik-bfs");
    assert.deepEqual(r.formats, ["HTML", "XLSX", "CSV"]);
    assert.equal(r.queryable, true);
    assert.equal(r.url, "https://opendata.swiss/fr/dataset/pop-s");
    const u = new URL(log[0]);
    assert.match(u.searchParams.get("fq"), /res_format:\("csv" OR "CSV"\)/);
    assert.equal(u.searchParams.get("sort"), "metadata_modified desc");
    // Old call shape still works.
    const old = envelope(await toolByName("search_datasets").handler({ query: "Bevölkerung", limit: 3 }));
    assert.equal(old.data.results[0].id, "pop-s");
  } finally {
    restore();
  }
});

test("get_dataset: resources with index, queryable flag and licence", async () => {
  const restore = stubFetch([["package_show?id=pop-g", datasetFixture("pop-g", "https://8.8.8.8/files/pop-g.csv")]]);
  try {
    const d = envelope(await toolByName("get_dataset").handler({ id: "pop-g" })).data;
    assert.equal(d.id, "pop-g");
    assert.equal(d.title, "Population of municipalities");
    assert.equal(d.resource_count, 3);
    assert.deepEqual(d.resources.map((r) => r.queryable), [false, false, true]);
    assert.equal(d.resources[2].download_url, "https://8.8.8.8/files/pop-g.csv");
    assert.match(d.resources[2].licence, /terms_by/);
  } finally {
    restore();
  }
});

test("list_data_publishers: pages through capped organization_list, parses JSON titles, filters", async () => {
  const org = (i) => ({
    name: `org-${String(i).padStart(3, "0")}`,
    title: JSON.stringify({ de: `Amt ${i}`, fr: `Office ${i}`, en: i === 7 ? "Federal Statistical Office" : `Office ${i}` }),
    package_count: i,
  });
  const all = Array.from({ length: 60 }, (_, i) => org(i));
  const log = [];
  const restore = stubFetch(
    [
      [
        "organization_list",
        (url) => {
          const u = new URL(url);
          const limit = Math.min(Number(u.searchParams.get("limit")), 25); // CKAN all_fields cap
          const offset = Number(u.searchParams.get("offset"));
          return { success: true, result: all.slice(offset, offset + limit) };
        },
      ],
    ],
    log,
  );
  try {
    let env = envelope(await toolByName("list_data_publishers").handler({ limit: 3 }));
    assert.equal(env.data.total, 60);
    assert.deepEqual(env.data.publishers.map((p) => p.slug), ["org-059", "org-058", "org-057"]);
    assert.equal(env.data.publishers[0].datasets, 59);
    env = envelope(await toolByName("list_data_publishers").handler({ query: "statistical" }));
    assert.deepEqual(env.data.publishers, [{ slug: "org-007", title: "Federal Statistical Office", datasets: 7 }]);
    env = envelope(await toolByName("list_data_publishers").handler({ query: "amt 12", lang: "de" }));
    assert.equal(env.data.publishers[0].title, "Amt 12");
    assert.ok(log.every((u) => u.includes("all_fields=true")));
  } finally {
    restore();
  }
});

test("discovery: opendata.swiss and Stadt Zürich searchers return hits pointing at query_dataset", async () => {
  const queryable = datasetFixture("pop-d", "https://8.8.8.8/files/pop-d.csv").result;
  const notQueryable = { ...datasetFixture("xlsx-only", "x").result, resources: [{ format: "XLSX", download_url: "https://x.ch/a.xlsx" }] };
  const restore = stubFetch([["package_search", { success: true, result: { count: 2, results: [queryable, notQueryable] } }]]);
  try {
    const s = getSearchers().find((x) => x.catalogue === "opendata.swiss");
    assert.ok(s);
    assert.equal(s.module, "statistics");
    const hits = await s.search("Bevölkerung", 5, "de");
    assert.equal(hits[0].title, "Bevölkerung der Gemeinden");
    assert.equal(hits[0].publisher, "Bundesamt für Statistik");
    assert.deepEqual(hits[0].next, { tool: "query_dataset", args: { id: "pop-d" } });
    assert.deepEqual(hits[1].next, { tool: "get_dataset", args: { id: "xlsx-only" } });
    const zh = getSearchers().find((x) => x.catalogue === "data.stadt-zuerich.ch");
    const zhHits = await zh.search("Velo", 5, "en");
    assert.deepEqual(zhHits[0].next.args, { id: "pop-d", portal: "stadt-zuerich" });
  } finally {
    restore();
  }
});

test("module: tool names unique, all have descriptions, health probes cover every source", () => {
  const names = statisticsModule.tools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const n of ["get_population", "search_datasets", "get_dataset", "query_dataset", "describe_dataset_columns", "aggregate_dataset", "list_data_publishers"]) {
    assert.ok(names.includes(n), n);
  }
  const probeIds = new Set(statisticsModule.healthProbes.map((p) => p.sourceId));
  for (const s of statisticsModule.sources) assert.ok(probeIds.has(s.id), s.id);
});
