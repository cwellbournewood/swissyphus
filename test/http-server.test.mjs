/**
 * Offline tests for the hosted HTTP API hardening (readiness review §2:
 * S1 client IP, S2 body cap, S4 graceful shutdown, S5 health caching,
 * S7 CORS, S9 error mapping, S10 rate limit and the absence of any key system).
 *
 * No upstream network: only locally computed tools (coords), fake modules and
 * injected health probes are exercised. Run after `npm run build`:
 *   node --test test/http-server.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { spawn } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  startHttpServer,
  resolveHttpConfig,
  mapToolError,
  clientIp,
} from "../dist/http-server.js";
import { createHealthCache } from "../dist/registry.js";
import { coordsModule } from "../dist/modules/coordsModule.js";
import { toolError, errorToResult } from "../dist/core/envelope.js";
import { SourceError } from "../dist/core/http.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Fake, network-free module to exercise error paths end to end. */
const fakeModule = {
  id: "fake",
  emoji: "*",
  title: "Fake",
  description: "Test-only tools",
  sources: [],
  tools: [
    {
      name: "boom",
      title: "Throws",
      description: "Throws an internal error",
      inputSchema: {},
      handler: async () => {
        throw new Error("secret-internal-detail /etc/passwd");
      },
    },
    {
      name: "nothing_found",
      title: "Not found",
      description: "Tool-reported no results",
      inputSchema: {},
      handler: async () => toolError("No companies found matching 'x'.", ["Try another spelling."]),
    },
    {
      name: "upstream_down",
      title: "Upstream down",
      description: "Upstream unavailable",
      inputSchema: {},
      handler: async () => errorToResult(new SourceError("Source 'x' responded with HTTP 502.", "x", 502), "Fake source"),
    },
    {
      name: "bad_input",
      title: "Bad input",
      description: "Rejected input",
      inputSchema: {},
      handler: async () => toolError("Coordinates are outside Switzerland."),
    },
  ],
};

async function start(env = {}, opts = {}) {
  const running = startHttpServer(opts.modules ?? [coordsModule, fakeModule], 0, {
    env,
    host: "127.0.0.1",
    handleSignals: false,
    drainMs: 2_000,
    ...opts.serverOptions,
  });
  const addr = await running.ready;
  return { ...running, port: addr.port, base: `http://127.0.0.1:${addr.port}` };
}

/** Raw HTTP request (full header control, optional chunked streaming body). */
function raw(port, { method = "GET", path = "/", headers = {}, body, chunks } = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (data += d));
      res.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = undefined;
        }
        resolvePromise({ status: res.statusCode, headers: res.headers, text: data, body: parsed });
      });
    });
    req.on("error", reject);
    if (chunks) {
      for (const c of chunks) req.write(c);
      req.end();
    } else {
      req.end(body);
    }
  });
}

// ── S1: client IP ───────────────────────────────────────────────────────────

test("S1: X-Forwarded-For is ignored by default (cannot dodge the IP limit)", async () => {
  const s = await start({});
  try {
    const a = await raw(s.port, { path: "/v1/health", headers: { "X-Forwarded-For": "10.0.0.1" } });
    const b = await raw(s.port, { path: "/v1/health", headers: { "X-Forwarded-For": "10.0.0.2" } });
    assert.equal(a.headers["ratelimit-remaining"], "59");
    assert.equal(b.headers["ratelimit-remaining"], "58", "rotating XFF must not reset the bucket");
    // Exhaust the anonymous limit, then a fresh XFF must still be limited.
    for (let i = 0; i < 58; i++) await raw(s.port, { path: "/v1/health" });
    const c = await raw(s.port, { path: "/v1/health", headers: { "X-Forwarded-For": "10.9.9.9" } });
    assert.equal(c.status, 429);
  } finally {
    await s.close();
  }
});

test("S1: with SWISSYPHUS_TRUST_PROXY the right-most X-Forwarded-For hop is the client", async () => {
  const s = await start({ SWISSYPHUS_TRUST_PROXY: "1" });
  try {
    const a = await raw(s.port, { path: "/v1/health", headers: { "X-Forwarded-For": "6.6.6.6, 203.0.113.7" } });
    // Spoofed left-most entry changes, right-most (proxy-appended) stays → same bucket.
    const b = await raw(s.port, { path: "/v1/health", headers: { "X-Forwarded-For": "7.7.7.7, 203.0.113.7" } });
    // Different real client → its own bucket.
    const c = await raw(s.port, { path: "/v1/health", headers: { "X-Forwarded-For": "6.6.6.6, 203.0.113.8" } });
    assert.equal(a.headers["ratelimit-remaining"], "59");
    assert.equal(b.headers["ratelimit-remaining"], "58");
    assert.equal(c.headers["ratelimit-remaining"], "59");
  } finally {
    await s.close();
  }
});

test("S1: clientIp helper falls back to the socket address", () => {
  const req = { socket: { remoteAddress: "192.0.2.1" }, headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" } };
  assert.equal(clientIp(req, false), "192.0.2.1");
  assert.equal(clientIp(req, true), "2.2.2.2");
  assert.equal(clientIp({ socket: { remoteAddress: "192.0.2.1" }, headers: {} }, true), "192.0.2.1");
});

test("S1: REQUIRE_TLS without TRUST_PROXY refuses to start; with it, X-Forwarded-Proto is enforced", async () => {
  assert.throws(() => resolveHttpConfig({ SWISSYPHUS_REQUIRE_TLS: "1" }), /SWISSYPHUS_TRUST_PROXY/);
  const s = await start({ SWISSYPHUS_REQUIRE_TLS: "true", SWISSYPHUS_TRUST_PROXY: "true" });
  try {
    assert.equal((await raw(s.port, { path: "/v1/tools" })).status, 400);
    assert.equal((await raw(s.port, { path: "/v1/tools", headers: { "X-Forwarded-Proto": "https" } })).status, 200);
    assert.equal((await raw(s.port, { path: "/v1/health" })).status, 200, "health stays reachable over HTTP");
  } finally {
    await s.close();
  }
});

// ── S2: body cap ────────────────────────────────────────────────────────────

test("S2: oversized Content-Length is rejected early with 413 problem+json", async () => {
  const s = await start({ SWISSYPHUS_MAX_BODY_BYTES: "1024" });
  try {
    const r = await raw(s.port, {
      method: "POST",
      path: "/v1/tools/convert_wgs84_to_lv95",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat: 46.95, lon: 7.44, pad: "x".repeat(5000) }),
    });
    assert.equal(r.status, 413);
    assert.match(r.headers["content-type"], /problem\+json/);
  } finally {
    await s.close();
  }
});

test("S2: chunked body exceeding the cap is aborted with 413; small bodies still work", async () => {
  const s = await start({ SWISSYPHUS_MAX_BODY_BYTES: "1024" });
  try {
    const r = await raw(s.port, {
      method: "POST",
      path: "/mcp",
      headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
      chunks: ["x".repeat(600), "x".repeat(600), "x".repeat(600)],
    });
    assert.equal(r.status, 413);
    const ok = await raw(s.port, {
      method: "POST",
      path: "/v1/tools/convert_wgs84_to_lv95",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat: 46.951083, lon: 7.438639 }),
    });
    assert.equal(ok.status, 200);
    assert.ok(Math.abs(ok.body.data.lv95.easting - 2600000) < 1);
  } finally {
    await s.close();
  }
});

test("S2: server timeouts are set", async () => {
  const s = await start({});
  try {
    assert.equal(s.server.headersTimeout, 15_000);
    assert.equal(s.server.requestTimeout, 30_000);
  } finally {
    await s.close();
  }
});

// ── S4: graceful shutdown ───────────────────────────────────────────────────

test("S4: SIGTERM drains and exits 0 promptly (child process)", async () => {
  const child = spawn(
    process.execPath,
    [join(repoRoot, "dist/index.js"), "--http", "--port", "0", "--modules", "coords"],
    { env: process.env, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  const port = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`server did not start:\n${stderr}`)), 10_000);
    child.stderr.on("data", (d) => {
      stderr += d;
      const m = stderr.match(/HTTP mode on http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(t);
        res(Number(m[1]));
      }
    });
  });
  const call = await raw(port, { path: "/v1/tools/convert_wgs84_to_lv95?lat=46.95&lon=7.44" });
  assert.equal(call.status, 200);

  const started = Date.now();
  child.kill("SIGTERM");
  const code = await new Promise((res) => child.on("exit", (c) => res(c)));
  const elapsed = Date.now() - started;
  assert.equal(code, 0, stderr);
  assert.ok(elapsed < 5_000, `took ${elapsed} ms to exit`);
});

test("S4: close() stops accepting connections and is idempotent", async () => {
  const s = await start({});
  assert.equal((await raw(s.port, { path: "/v1/health" })).status, 200);
  await Promise.all([s.close(), s.close()]);
  await assert.rejects(raw(s.port, { path: "/v1/health" }));
});

// ── S7: CORS + security headers ─────────────────────────────────────────────

test("S7: CORS preflight allows MCP headers and exposes rate headers", async () => {
  const s = await start({});
  try {
    const r = await raw(s.port, {
      method: "OPTIONS",
      path: "/mcp",
      headers: { Origin: "https://example.org", "Access-Control-Request-Method": "POST" },
    });
    assert.equal(r.status, 204);
    assert.equal(r.headers["access-control-allow-origin"], "*");
    assert.match(r.headers["access-control-allow-methods"], /\bPOST\b/);
    for (const h of ["Last-Event-ID", "Mcp-Session-Id"]) {
      assert.match(r.headers["access-control-allow-headers"], new RegExp(`\\b${h}\\b`));
    }
    for (const h of ["RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset", "Retry-After", "Mcp-Session-Id"]) {
      assert.match(r.headers["access-control-expose-headers"], new RegExp(`\\b${h}\\b`));
    }
    assert.equal(r.headers["access-control-max-age"], "600");

    const landing = await raw(s.port, { path: "/" });
    assert.match(landing.text, /<html lang="en">/);
    assert.equal(landing.headers["x-content-type-options"], "nosniff");
    assert.equal(landing.headers["referrer-policy"], "no-referrer");
  } finally {
    await s.close();
  }
});

// ── S9: error mapping ───────────────────────────────────────────────────────

test("S9: tool errors map to 404 / 503 / 422; internal errors are 500 without leaking details", async () => {
  const s = await start({});
  const origError = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.map(String).join(" "));
  try {
    const nf = await raw(s.port, { path: "/v1/tools/nothing_found" });
    assert.equal(nf.status, 404);
    assert.deepEqual(nf.body.suggestions, ["Try another spelling."]);
    assert.equal((await raw(s.port, { path: "/v1/tools/upstream_down" })).status, 503);
    assert.equal((await raw(s.port, { path: "/v1/tools/bad_input" })).status, 422);
    const boom = await raw(s.port, { path: "/v1/tools/boom" });
    assert.equal(boom.status, 500);
    assert.ok(!boom.text.includes("secret-internal-detail"), "internal message must not leak");
    assert.ok(logged.some((l) => l.includes("secret-internal-detail")), "error is logged server-side");
  } finally {
    console.error = origError;
    await s.close();
  }
});

test("S9: mapToolError unit behaviour", () => {
  const text = (r) => r.content[0].text;
  assert.equal(mapToolError(text(errorToResult(new SourceError("x", "h", 500), "Zefix"))).status, 503);
  const abort = new Error("This operation was aborted");
  abort.name = "AbortError";
  assert.equal(mapToolError(text(errorToResult(abort, "Zefix"))).status, 503, "timeouts are 503, not 404");
  assert.equal(mapToolError(text(toolError("Postal code 0000 not found."))).status, 404);
  assert.equal(mapToolError(text(toolError("MeteoSwiss has no data for PLZ 1234."))).status, 404);
  assert.equal(mapToolError(text(toolError("Only read-only SPARQL SELECT queries are allowed."))).status, 422);
  assert.equal(mapToolError(JSON.stringify({ error: "whatever", status: 503 })).status, 503, "structured hint wins");
  assert.equal(mapToolError(JSON.stringify({ error: "No x", code: "invalid_input" })).status, 422);
  const leaked = mapToolError(text(toolError("Unexpected error while querying X: Cannot read properties of undefined (reading 'foo')", [], { kind: "unavailable" })));
  assert.equal(leaked.status, 503);
  assert.doesNotMatch(leaked.detail, /Cannot read/, "internal messages are not leaked over REST");
});

// ── S10: rate limit, no key system ──────────────────────────────────────────

test("S10: SWISSYPHUS_RATE_LIMIT_PER_MINUTE sets the per-IP limit; 0 disables it", async () => {
  assert.equal(resolveHttpConfig({}).ratePerMinute, 60);
  assert.equal(resolveHttpConfig({ SWISSYPHUS_RATE_LIMIT_PER_MINUTE: "0" }).ratePerMinute, 0);
  const bad = resolveHttpConfig({ SWISSYPHUS_RATE_LIMIT_PER_MINUTE: "lots" });
  assert.equal(bad.ratePerMinute, 60);
  assert.ok(bad.warnings.some((w) => /SWISSYPHUS_RATE_LIMIT_PER_MINUTE/.test(w)));

  const s = await start({ SWISSYPHUS_RATE_LIMIT_PER_MINUTE: "2" });
  try {
    assert.equal((await raw(s.port, { path: "/v1/health" })).headers["ratelimit-limit"], "2");
    await raw(s.port, { path: "/v1/health" });
    const limited = await raw(s.port, { path: "/v1/health" });
    assert.equal(limited.status, 429);
    assert.match(limited.body.detail, /per IP/);
  } finally {
    await s.close();
  }
  const open = await start({ SWISSYPHUS_RATE_LIMIT_PER_MINUTE: "0" });
  try {
    for (let i = 0; i < 70; i++) await raw(open.port, { path: "/v1/health" });
    const r = await raw(open.port, { path: "/v1/health" });
    assert.equal(r.status, 200);
    assert.equal(r.headers["ratelimit-limit"], "unlimited");
  } finally {
    await open.close();
  }
});

test("S10: there are no key, usage or admin endpoints, and keys are not required", async () => {
  const s = await start({ ADMIN_TOKEN: "x".repeat(40) });
  try {
    for (const [method, path] of [["POST", "/v1/keys"], ["DELETE", "/v1/keys"], ["GET", "/v1/usage"], ["GET", "/v1/admin/keys"]]) {
      assert.equal((await raw(s.port, { method, path })).status, 404, `${method} ${path}`);
    }
    // A stray Authorization header is ignored, not rejected.
    const r = await raw(s.port, {
      path: "/v1/tools/convert_wgs84_to_lv95?lat=46.95&lon=7.44",
      headers: { Authorization: "Bearer sy_live_deadbeef" },
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers["x-monthly-quota"], undefined);
    const spec = JSON.parse((await raw(s.port, { path: "/openapi.json" })).text);
    assert.equal(spec.paths["/v1/keys"], undefined);
    assert.equal(spec.components.securitySchemes, undefined);
  } finally {
    await s.close();
  }
});

// ── S5: health caching ──────────────────────────────────────────────────────

test("S5: health cache is single-flight and honours the TTL", async () => {
  let clock = 1_000_000;
  let calls = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const cache = createHealthCache({
    ttlMs: 60_000,
    now: () => clock,
    probe: async () => {
      calls++;
      await gate;
      return [
        { source_id: "a", module: "m1", status: "healthy", ok: true },
        { source_id: "b", module: "m2", status: "unreachable", ok: false },
      ];
    },
  });
  const concurrent = Promise.all(Array.from({ length: 10 }, () => cache.get()));
  release();
  const snaps = await concurrent;
  assert.equal(calls, 1, "10 concurrent callers share one probe round");
  assert.ok(snaps.every((s) => s.results.length === 2 && s.checked_at === new Date(1_000_000).toISOString()));

  clock += 30_000;
  const hit = await cache.get({ module: "m2" });
  assert.equal(calls, 1);
  assert.equal(hit.cached, true);
  assert.equal(hit.age_seconds, 30);
  assert.deepEqual(hit.results.map((r) => r.source_id), ["b"], "module filter applies to the shared snapshot");

  clock += 31_000;
  const refreshed = await cache.get();
  assert.equal(calls, 2, "expired snapshot triggers a new round");
  assert.equal(refreshed.cached, false);
});

test("S5: /v1/health/sources serves the snapshot with checked_at", async () => {
  let calls = 0;
  const cache = createHealthCache({
    ttlMs: 60_000,
    probe: async () => {
      calls++;
      return [{ source_id: "a", module: "coords", status: "healthy", ok: true }];
    },
  });
  const s = await start({}, { serverOptions: { healthSnapshot: () => cache.get() } });
  try {
    const [a, b] = await Promise.all([
      raw(s.port, { path: "/v1/health/sources" }),
      raw(s.port, { path: "/v1/health/sources" }),
    ]);
    assert.equal(a.status, 200);
    assert.ok(a.body.checked_at);
    assert.equal(a.body.summary, "1/1 sources healthy");
    assert.equal(b.body.checked_at, a.body.checked_at);
    assert.equal(calls, 1);
  } finally {
    await s.close();
  }
});

test("mcp: tools/list is served from a one-time snapshot equal to the SDK's own answer, compacted", async () => {
  const { buildServer, compactToolList, snapshotToolList, useToolListSnapshot } = await import("../dist/server.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const modules = [coordsModule, fakeModule];

  // What a plain, unmodified server answers.
  async function listVia(server) {
    const [client, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const result = await new Promise((resolveList) => {
      client.onmessage = (msg) => msg.id === 7 && resolveList(msg.result);
      void client.start().then(() => client.send({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }));
    });
    await server.close();
    return JSON.parse(JSON.stringify(result)); // as it goes over the wire
  }
  const sdk = await listVia(buildServer(modules));
  const live = compactToolList(sdk);
  const snapshot = await snapshotToolList(modules);
  assert.deepEqual(snapshot, live);
  // Compaction removes only redundant bytes: every tool keeps its name, description and properties.
  assert.ok(JSON.stringify(snapshot).length < JSON.stringify(sdk).length);
  for (const [i, t] of snapshot.tools.entries()) {
    assert.equal(t.name, sdk.tools[i].name);
    assert.equal(t.description, sdk.tools[i].description);
    assert.deepEqual(t.inputSchema.properties, sdk.tools[i].inputSchema.properties);
    assert.equal(t.inputSchema.$schema, undefined);
    assert.equal(t.execution, undefined);
  }
  assert.equal(snapshot.tools.length, modules.reduce((n, m) => n + m.tools.length, 0));

  // A server patched with the snapshot answers the same, and tool calls still work.
  const patched = buildServer(modules);
  useToolListSnapshot(patched, snapshot);
  assert.deepEqual(await listVia(patched), live);

  // End to end over /mcp.
  const s = await start();
  try {
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    for (let i = 0; i < 3; i++) {
      const r = await raw(s.port, {
        method: "POST",
        path: "/mcp",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "tools/list", params: {} }),
      });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.result, live);
    }
    const call = await raw(s.port, {
      method: "POST",
      path: "/mcp",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "convert_wgs84_to_lv95", arguments: { lat: 46.95, lon: 7.44 } },
      }),
    });
    assert.equal(call.status, 200);
    assert.match(call.body.result.content[0].text, /"data"/);
  } finally {
    await s.close();
  }
});
