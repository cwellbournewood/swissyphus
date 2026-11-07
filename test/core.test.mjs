/**
 * Offline tests for the catalogue-adapter core: tabular parsing/querying,
 * dynamic-host SSRF guard, host registration, discovery interleaving.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCsv, parseResource, queryRows, sniffDelimiter, extractRecords, profileColumns, coerce } from "../dist/core/tabular.js";
import { isPrivateAddress, isAllowedHost, allowHosts, fetchPublicResource, fetchCached, TooLargeError, setPublicTransportForTests, fetchBackedTransport, errorExcerpt } from "../dist/core/http.js";
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

test("tabular: exactly maxRows rows + trailing newline is NOT reported as truncated", () => {
  const t = parseCsv("a,b\n1,2\n3,4\n\n", { maxRows: 2 });
  assert.equal(t.rows.length, 2);
  assert.ok(!t.notes.some((n) => n.includes("truncated")));
});

test("tabular: refuses absurdly wide files and budgets total cells", async () => {
  const { MAX_COLUMNS, MAX_CELLS } = await import("../dist/core/tabular.js");
  assert.throws(() => parseCsv(Array.from({ length: MAX_COLUMNS + 5 }, (_, i) => `c${i}`).join(",") + "\n"), /columns/);
  const width = 500;
  const header = Array.from({ length: width }, (_, i) => `c${i}`).join(",");
  const row = Array.from({ length: width }, () => "1").join(",");
  const rowsWanted = Math.floor(MAX_CELLS / width) + 50;
  const t = parseCsv(header + "\n" + Array(rowsWanted).fill(row).join("\n") + "\n");
  assert.equal(t.rows.length, Math.floor(MAX_CELLS / width));
  assert.ok(t.notes.some((n) => n.includes("truncated")));
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
  // Every IPv4-embedding IPv6 form (as WHATWG URL rewrites them) is refused:
  // mapped (hex), compatible, NAT64, 6to4, Teredo, site-local, documentation.
  for (const ip of ["::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:a00:1", "::7f00:1", "64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::1", "2001:0:4136:e378::1", "fec0::1", "2001:db8::1", "::ffff:8.8.8.8", "::"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "162.23.1.1", "2001:4860:4860::8888", "2a00:1450:400a:803::200e"]) {
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

test("http: fetchPublicResource refuses bracketed IPv6 forms of internal IPv4 (URL-normalised)", async () => {
  for (const u of ["http://[::ffff:127.0.0.1]/", "http://[::ffff:169.254.169.254]/latest/meta-data/", "http://[64:ff9b::a9fe:a9fe]/"]) {
    await assert.rejects(fetchPublicResource(u), /non-public/, u);
  }
});

test("http: fetchPublicResource re-checks every redirect hop", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: "http://10.0.0.5/admin" } });
  setPublicTransportForTests(fetchBackedTransport);
  try {
    await assert.rejects(fetchPublicResource("https://8.8.8.8/redirect-me"), /non-public/);
  } finally {
    globalThis.fetch = orig;
    setPublicTransportForTests(undefined);
  }
});

test("http: connect-time lookup refuses hostnames resolving to private addresses (DNS rebinding)", async () => {
  const { publicOnlyLookup } = await import("../dist/core/http.js");
  const err = await new Promise((resolve) => publicOnlyLookup("localhost.", {}, (e) => resolve(e)));
  assert.ok(err, "localhost must be refused at lookup time");
  assert.match(String(err.message ?? err.code), /non-public|ENOTFOUND|EAI_AGAIN/);
});

test("http: allowlisted fetches re-check redirect targets against the allowlist", async () => {
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (u) => {
    seen.push(String(u));
    return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
  };
  try {
    allowHosts("redirector.example.ch");
    await assert.rejects(fetchCached("https://redirector.example.ch/x", { retries: 0 }), /allowlist/);
    assert.deepEqual(seen, ["https://redirector.example.ch/x"], "the internal target was never fetched");
  } finally {
    globalThis.fetch = orig;
  }
});

test("http: errorExcerpt is linear on hostile '<<<<' input and strips tags", () => {
  const t0 = Date.now();
  errorExcerpt("<".repeat(200_000));
  assert.ok(Date.now() - t0 < 200, "no quadratic backtracking");
  assert.equal(errorExcerpt("<p>Unknown <b>field</b></p>"), "Unknown field");
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

test("http: 4xx bodies are surfaced in the SourceError; retries:0 disables the retry", async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1
      ? new Response('{"error_code":"ODSQLError","message":"Unknown field: foo"}', { status: 400 })
      : new Response("oops", { status: 503 });
  };
  try {
    allowHosts("err-test.example.ch");
    await assert.rejects(fetchCached("https://err-test.example.ch/a"), /HTTP 400\. Upstream said: .*Unknown field: foo/);
    await assert.rejects(fetchCached("https://err-test.example.ch/b", { retries: 0 }), /HTTP 503/);
    assert.equal(calls, 2, "no retry with retries:0");
  } finally {
    globalThis.fetch = orig;
  }
});

test("http: cache tracks its byte footprint and replaces entries without double counting", async () => {
  const { cacheStats } = await import("../dist/core/http.js");
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response("y".repeat(1000), { status: 200 });
  try {
    allowHosts("cache-bytes.example.ch");
    const before = cacheStats().bytes;
    await fetchCached("https://cache-bytes.example.ch/a", { ttlMs: 1 });
    const mid = cacheStats().bytes;
    assert.ok(mid - before >= 1000, "counted at least 1 byte per byte of body");
    await new Promise((r) => setTimeout(r, 5));
    await fetchCached("https://cache-bytes.example.ch/a", { ttlMs: 1 }); // stale → background revalidate, same key
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(Math.abs(cacheStats().bytes - mid) < 10, "replacement must not double count");
  } finally {
    globalThis.fetch = orig;
  }
});

test("http: network failures become SourceError (reported as 'unavailable', not 'format changed')", async () => {
  const { SourceError } = await import("../dist/core/http.js");
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  try {
    allowHosts("down.example.ch");
    await assert.rejects(fetchCached("https://down.example.ch/x", { retries: 0 }), (e) => e instanceof SourceError && /Could not reach 'down.example.ch'/.test(e.message));
  } finally {
    globalThis.fetch = orig;
  }
});
