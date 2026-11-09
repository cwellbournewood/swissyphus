/**
 * Offline tests for responsiveness: per-call time budgets, find_data's
 * deadline + background completion, query analysis (place / glossary /
 * coverage gaps), the local LINDAS cube index and catalogue warm-up.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SWISSYPHUS_FIND_DATA_MS = "300";

const { withTimeBudget, fetchCached, allowHosts, remainingBudgetMs } = await import("../dist/core/http.js");
const { analyzeQuery } = await import("../dist/core/queryhints.js");
const { registerSearcher, warmCatalogues } = await import("../dist/core/discovery.js");
const { ALL_MODULES } = await import("../dist/registry.js");
const { searchCubeIndex, buildCubeIndexQuery } = await import("../dist/modules/cubes.js");

const meta = ALL_MODULES.find((m) => m.id === "meta");
const tool = (n) => meta.tools.find((t) => t.name === n);
const body = (r) => JSON.parse(r.content[0].text);

test("budget: fetch timeout is capped by the remaining budget and retries are skipped", async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (_u, init) =>
    new Promise((_res, rej) => {
      calls++;
      init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  allowHosts("slow.example.ch");
  const t0 = Date.now();
  try {
    await assert.rejects(
      withTimeBudget(400, () => fetchCached("https://slow.example.ch/x", { timeoutMs: 45_000 })),
      /did not answer in time/,
    );
    const took = Date.now() - t0;
    assert.ok(took < 1_500, `took ${took} ms, budget must cap the 45 s timeout`);
    assert.equal(calls, 1, "no retry when the budget can't afford one");
  } finally {
    globalThis.fetch = orig;
  }
});

test("budget: once spent, further fetches fail fast without touching the network", async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("{}");
  };
  try {
    await withTimeBudget(50, async () => {
      await new Promise((r) => setTimeout(r, 80));
      assert.ok(remainingBudgetMs() < 0);
      await assert.rejects(fetchCached("https://slow.example.ch/y"), /time budget is used up/);
    });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = orig;
  }
});

test("query analysis: 'Aargau traffic' → topic Verkehr, canton AG, live-traffic gap", () => {
  const q = analyzeQuery("Aargau traffic");
  assert.equal(q.topic, "Verkehr");
  assert.equal(q.canton.code, "AG");
  assert.equal(q.canton.bfs, 19);
  assert.equal(q.gaps[0].topic, "live road traffic");
});

test("query analysis: multi-word glossary, French canton names, no false place", () => {
  assert.equal(analyzeQuery("overnight stays in the canton of Graubünden").topic, "Logiernächte");
  assert.equal(analyzeQuery("population Genève").canton.code, "GE");
  assert.equal(analyzeQuery("Mietpreise").canton, undefined);
  assert.equal(analyzeQuery("Mietpreise").topic, "mietpreise");
  assert.equal(analyzeQuery("rent index").gaps.length, 0);
});

test("find_data: answers by the deadline with partial results; slow catalogue flagged, not an error", async () => {
  registerSearcher({
    catalogue: "perf-fast",
    module: "meta",
    search: async (q) => [
      { catalogue: "perf-fast", id: "f1", title: `national ${q}`, next: { tool: "about_swissyphus", args: {} } },
      { catalogue: "perf-fast", id: "f2", title: `${q} Kanton Aargau`, next: { tool: "about_swissyphus", args: {} } },
    ],
  });
  let slowFinished = false;
  registerSearcher({
    catalogue: "perf-slow",
    module: "meta",
    search: () => new Promise((r) => setTimeout(() => ((slowFinished = true), r([])), 700)),
  });
  const t0 = Date.now();
  const res = await tool("find_data").handler({ query: "Aargau traffic", limit: 10, catalogues: ["perf-"], lang: "de" });
  const took = Date.now() - t0;
  const d = body(res).data;
  assert.ok(took < 650, `took ${took} ms`);
  assert.equal(d.searched_for, "Verkehr");
  assert.equal(d.place.code, "AG");
  assert.match(d.coverage_notes[0], /NOT connected/);
  assert.equal(d.results[0].id, "f2", "hits naming the canton rank first");
  assert.equal(d.catalogues_searched.find((c) => c.catalogue === "perf-slow").timed_out, true);
  assert.match(d.hint, /still loading in the background/);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(slowFinished, true, "the slow search keeps running to warm the cache");
});

test("find_data: coverage notes are returned even when nothing matches", async () => {
  registerSearcher({ catalogue: "perf-empty", module: "meta", search: async () => [] });
  const res = await tool("find_data").handler({ query: "traffic jam A1", limit: 5, catalogues: ["perf-empty"], lang: "de" });
  assert.notEqual(res.isError, true);
  assert.match(body(res).data.coverage_notes[0], /ASTRA/);
});

test("cubes: local index search matches all terms, diacritic-insensitive, keeps order", () => {
  const idx = [
    { cube: "https://x/1", name: "Strassenverkehrszählung ASTRA", description: "Verkehr", on_visualize: true, visualize_url: "" },
    { cube: "https://x/2", name: "Strompreise", description: "ElCom", on_visualize: true, visualize_url: "" },
    { cube: "https://x/3", name: "Lärmbelastung Verkehr", description: "BAFU", on_visualize: false, visualize_url: "" },
  ];
  assert.deepEqual(searchCubeIndex(idx, "verkehr", 10).map((c) => c.cube), ["https://x/1", "https://x/3"]);
  assert.deepEqual(searchCubeIndex(idx, "Larm verkehr", 10).map((c) => c.cube), ["https://x/3"]);
  assert.equal(searchCubeIndex(idx, "verkehr", 1).length, 1);
  assert.match(buildCubeIndexQuery("de"), /LIMIT 3000/);
});

test("warm-up: runs every searcher's warm hook and never throws", async () => {
  let warmed = 0;
  registerSearcher({ catalogue: "perf-warm-ok", module: "meta", search: async () => [], warm: async () => void warmed++ });
  registerSearcher({ catalogue: "perf-warm-bad", module: "meta", search: async () => [], warm: async () => { throw new Error("down"); } });
  const logs = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("offline"); };
  try {
    await warmCatalogues((m) => logs.push(m));
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(warmed, 1);
  assert.ok(logs.some((l) => l.includes("perf-warm-bad") && l.includes("failed")));
});
