/**
 * Offline tests for the discovery meta-tools: find_tools ranking, describe_tool,
 * call_tool proxying/validation, and find_data fan-out over registered searchers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { ALL_MODULES, resolveModules, setActiveModules, setProxyAll } from "../dist/registry.js";
import { rankTools, tokenize } from "../dist/modules/meta.js";
import { registerSearcher } from "../dist/core/discovery.js";

const meta = ALL_MODULES.find((m) => m.id === "meta");
const t = (name) => meta.tools.find((x) => x.name === name);
const body = (res) => JSON.parse(res.content[0].text);

test("discovery: tokenize strips diacritics and punctuation", () => {
  assert.deepEqual(tokenize("Lärm-Kataster, Zürich!"), ["larm", "kataster", "zurich"]);
});

test("discovery: rankTools puts the obvious tool first", () => {
  assert.equal(rankTools("avalanche danger", ALL_MODULES)[0].tool.name.includes("avalanche"), true);
  assert.equal(rankTools("exchange rate", ALL_MODULES)[0].tool.name, "get_exchange_rate");
  assert.equal(rankTools("xyzzy plugh", ALL_MODULES).length, 0);
});

test("discovery: 'discovery' preset loads only meta", () => {
  assert.deepEqual(resolveModules({ preset: "discovery" }).map((m) => m.id), ["meta"]);
});

test("discovery: call_tool cannot reach modules the operator did not load (default)", async () => {
  setProxyAll(false);
  setActiveModules(resolveModules({ preset: "minimal" }));
  const res = await t("call_tool").handler({ name: "convert_wgs84_to_lv95", arguments: { lat: 46.95, lon: 7.44 } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Unknown tool/);
  const found = body(await t("find_tools").handler({ query: "convert LV95 coordinates", limit: 5 })).data?.tools ?? [];
  assert.ok(!found.some((x) => x.module === "coords"), "unloaded modules are not advertised either");
  setActiveModules(ALL_MODULES);
});

test("discovery: find_tools reports loaded=false for modules outside the active set", async () => {
  setProxyAll(true);
  setActiveModules(resolveModules({ preset: "discovery" }));
  const res = await t("find_tools").handler({ query: "convert LV95 coordinates", limit: 5 });
  const hit = body(res).data.tools.find((x) => x.module === "coords");
  assert.ok(hit, "coords tool found");
  assert.equal(hit.loaded, false);
  setActiveModules(ALL_MODULES);
});

test("discovery: describe_tool returns a JSON schema; unknown tool errors", async () => {
  const d = body(await t("describe_tool").handler({ name: "convert_wgs84_to_lv95" })).data;
  assert.equal(d.module, "coords");
  assert.equal(d.input_schema.type, "object");
  assert.ok(Object.keys(d.input_schema.properties).length > 0);
  const bad = await t("describe_tool").handler({ name: "nope" });
  assert.equal(bad.isError, true);
});

test("discovery: call_tool proxies with schema validation (offline coords tool)", async () => {
  const ok = await t("call_tool").handler({ name: "convert_wgs84_to_lv95", arguments: { lat: 46.951083, lon: 7.438639 } });
  assert.notEqual(ok.isError, true);
  assert.match(ok.content[0].text, /2600000|2599999/);
  const invalid = await t("call_tool").handler({ name: "convert_wgs84_to_lv95", arguments: { lat: "north" } });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /Invalid arguments/);
  const recursive = await t("call_tool").handler({ name: "call_tool", arguments: {} });
  assert.equal(recursive.isError, true);
});

test("discovery: find_data fans out, tolerates a failing catalogue, interleaves hits", async () => {
  registerSearcher({
    catalogue: "test-cat-a",
    module: "meta",
    search: async (q) => [1, 2, 3].map((i) => ({ catalogue: "test-cat-a", id: `a${i}`, title: `${q} A${i}`, next: { tool: "about_swissyphus", args: {} } })),
  });
  registerSearcher({
    catalogue: "test-cat-b",
    module: "meta",
    search: async () => {
      throw new Error("boom");
    },
  });
  registerSearcher({
    catalogue: "test-cat-c",
    module: "meta",
    search: async () => [{ catalogue: "test-cat-c", id: "c1", title: "C1", next: { tool: "query_nothing", args: { x: 1 } } }],
  });
  const res = await t("find_data").handler({ query: "noise", limit: 3, catalogues: ["test-cat"], lang: "de" });
  const d = body(res).data;
  assert.deepEqual(d.results.map((r) => r.id), ["a1", "c1", "a2"]);
  assert.equal(d.results[0].next.loaded, true);
  assert.equal(d.results[1].next.loaded, false);
  const b = d.catalogues_searched.find((c) => c.catalogue === "test-cat-b");
  assert.equal(b.error, "boom");
});
