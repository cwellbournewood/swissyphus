/**
 * Offline tests for the catalogue-adapter core: tabular parsing/querying,
 * dynamic-host SSRF guard, host registration, discovery interleaving.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCsv, parseResource, queryRows, sniffDelimiter, extractRecords, profileColumns, coerce } from "../dist/core/tabular.js";
import { isPrivateAddress, isAllowedHost, allowHosts, fetchPublicResource, fetchCached, TooLargeError } from "../dist/core/http.js";
import { interleave } from "../dist/core/discovery.js";

test("tabular: sniffs ; , and tab delimiters, ignoring quoted ones", () => {
  assert.equal(sniffDelimiter("a;b;c"), ";");
  assert.equal(sniffDelimiter("a,b,c"), ",");
  assert.equal(sniffDelimiter("a\tb\tc"), "\t");
  assert.equal(sniffDelimiter('"x;y;z",b,c'), ",");
});

test("tabular: parseCsv handles BOM, quotes, escaped quotes, embedded newlines, CRLF", () => {
  const csv = '﻿Name;Ort;Note\r\n"Müller, ""Hans""";Zürich;"line1\nline2"\r\nMeier;Bern;5.5\r\n';
  const t = parseCsv(csv);
  assert.deepEqual(t.columns, ["Name", "Ort", "Note"]);
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[0].Name, 'Müller, "Hans"');
  assert.equal(t.rows[0].Note, "line1\nline2");
  assert.equal(t.rows[1].Note, 5.5);
});

test("tabular: coerce keeps leading-zero identifiers as strings", () => {
  assert.equal(coerce("0261"), "0261");
  assert.equal(coerce("8001"), 8001);
  assert.equal(coerce("-3.5"), -3.5);
  assert.equal(coerce(""), null);
  assert.equal(coerce("12345678901234567890"), "12345678901234567890");
});

test("tabular: parseCsv de-duplicates header names and truncates at maxRows", () => {
  const t = parseCsv("a,a,b\n1,2,3\n4,5,6\n7,8,9\n", { maxRows: 2 });
  assert.deepEqual(t.columns, ["a", "a_2", "b"]);
  assert.equal(t.rows.length, 2);
  assert.ok(t.notes.some((n) => n.includes("truncated")));
});

test("tabular: extractRecords finds nested arrays, GeoJSON and array-of-arrays", () => {
  assert.equal(extractRecords({ meta: {}, data: { items: [{ a: 1 }, { a: 2 }] } }).length, 2);
  const geo = extractRecords({
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: { name: "X" }, geometry: { type: "Point", coordinates: [8.5, 47.3] } }],
  });
  assert.equal(geo[0].name, "X");
  assert.deepEqual(geo[0]._geometry.coordinates, [8.5, 47.3]);
  assert.deepEqual(extractRecords([["k", "v"], ["a", 1]]), [{ k: "a", v: 1 }]);
});

test("tabular: parseResource rejects HTML landing pages with a clear message", () => {
  assert.throws(() => parseResource("<!doctype html><html>", {}), /landing page/);
});

test("tabular: queryRows filters (exact, ~substring, >/<), sorts, projects, pages", () => {
  const t = parseResource("Gemeinde,Kanton,Einwohner\nZürich,ZH,420000\nWinterthur,ZH,115000\nBern,BE,134000\nBiel/Bienne,BE,55000\n");
  let r = queryRows(t, { where: { kanton: "zh" } });
  assert.equal(r.total, 2);
  r = queryRows(t, { where: { Einwohner: ">100000" }, sort: "-einwohner", columns: ["gemeinde"] });
  assert.deepEqual(r.rows, [{ Gemeinde: "Zürich" }, { Gemeinde: "Bern" }, { Gemeinde: "Winterthur" }]);
  r = queryRows(t, { where: { Gemeinde: "~bie" } });
  assert.equal(r.total, 1);
  r = queryRows(t, { search: "bern", limit: 1 });
  assert.equal(r.rows[0].Gemeinde, "Bern");
  r = queryRows(t, { where: { nope: "x" } });
  assert.deepEqual(r.unknown_columns, ["nope"]);
  const prof = profileColumns(t);
  assert.equal(prof.find((p) => p.column === "Einwohner").type, "number");
});

test("http: isPrivateAddress covers private, loopback, link-local, CGNAT, v6 ULA and mapped", () => {
  for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.20.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "not-an-ip"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "162.23.1.1", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("http: allowHosts registers hosts; opendatasoft suffix is allowed; others refused", async () => {
  assert.equal(isAllowedHost("example-unlisted.ch"), false);
  allowHosts("Example-Registered.ch");
  assert.equal(isAllowedHost("example-registered.ch"), true);
  assert.equal(isAllowedHost("data.bs.opendatasoft.com"), true);
  await assert.rejects(fetchCached("https://evil.example.com/x"), /allowlist/);
});

test("http: fetchPublicResource refuses private/internal targets before fetching", async () => {
  await assert.rejects(fetchPublicResource("http://127.0.0.1/secret"), /non-public/);
  await assert.rejects(fetchPublicResource("http://169.254.169.254/latest/meta-data"), /non-public/);
  await assert.rejects(fetchPublicResource("http://localhost/x"), /internal hostname/);
  await assert.rejects(fetchPublicResource("file:///etc/passwd"), /non-HTTP/);
  await assert.rejects(fetchPublicResource("https://8.8.8.8:8443/x"), /non-standard port/);
});

test("http: fetchPublicResource re-checks every redirect hop", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: "http://10.0.0.5/admin" } });
  try {
    await assert.rejects(fetchPublicResource("https://8.8.8.8/redirect-me"), /non-public/);
  } finally {
    globalThis.fetch = orig;
  }
});

test("http: size cap aborts oversized bodies with TooLargeError (not retried)", async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("x".repeat(5000), { status: 200 });
  };
  try {
    allowHosts("size-test.example.ch");
    await assert.rejects(fetchCached("https://size-test.example.ch/big", { maxBytes: 1000 }), TooLargeError);
    assert.equal(calls, 1, "a too-large body must not be retried");
  } finally {
    globalThis.fetch = orig;
  }
});

test("http: Latin-1 bodies are decoded instead of mangled", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([0x5a, 0xfc, 0x72, 0x69, 0x63, 0x68]), { status: 200 });
  try {
    allowHosts("latin1-test.example.ch");
    const r = await fetchCached("https://latin1-test.example.ch/f.csv");
    assert.equal(r.data, "Zürich");
  } finally {
    globalThis.fetch = orig;
  }
});

test("discovery: interleave round-robins across catalogues up to limit", () => {
  assert.deepEqual(interleave([[1, 2, 3], ["a"], [true, false]], 5), [1, "a", true, 2, false]);
  assert.deepEqual(interleave([[], []], 3), []);
});
