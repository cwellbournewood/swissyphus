/**
 * REST API + remote MCP smoke test.
 * Starts the HTTP server on a test port and exercises the endpoints live.
 *   node test/rest.mjs
 */

import { spawn } from "node:child_process";

const PORT = 8787;
const BASE = `http://127.0.0.1:${PORT}`;

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ADMIN_TOKEN = "test-admin-token";
const server = spawn(process.execPath, ["dist/index.js", "--http", "--port", String(PORT)], {
  stdio: ["ignore", "ignore", "pipe"],
  env: {
    ...process.env,
    ADMIN_TOKEN,
    SWISSYPHUS_DATA_DIR: mkdtempSync(join(tmpdir(), "swissyphus-test-")),
  },
});
let stderrBuf = "";
server.stderr.on("data", (d) => (stderrBuf += d));

// Wait for the server to accept connections.
async function waitUp() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/v1/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not come up.\n${stderrBuf}`);
}

let pass = 0;
let fail = 0;
const failures = [];

async function check(label, fn) {
  try {
    await fn();
    pass++;
    console.log(`  PASS  ${label}`);
  } catch (err) {
    fail++;
    failures.push({ label, err: String(err).slice(0, 400) });
    console.log(`  FAIL  ${label}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

try {
  await waitUp();

  await check("GET /v1/health", async () => {
    const r = await fetch(`${BASE}/v1/health`);
    const b = await r.json();
    assert(r.status === 200 && b.status === "ok" && b.tools > 60, `status=${r.status} body=${JSON.stringify(b)}`);
  });

  await check("GET / landing page", async () => {
    const r = await fetch(BASE);
    const t = await r.text();
    assert(r.status === 200 && t.includes("Swissyphus"), `status=${r.status}`);
  });

  await check("GET /v1/tools catalogue", async () => {
    const r = await fetch(`${BASE}/v1/tools`);
    const b = await r.json();
    assert(b.modules?.length >= 24, `modules=${b.modules?.length}`);
  });

  await check("GET /openapi.json", async () => {
    const r = await fetch(`${BASE}/openapi.json`);
    const b = await r.json();
    assert(b.openapi === "3.1.0" && Object.keys(b.paths).length > 70, `paths=${Object.keys(b.paths ?? {}).length}`);
  });

  await check("GET /v1/sources", async () => {
    const r = await fetch(`${BASE}/v1/sources`);
    const b = await r.json();
    assert(Array.isArray(b) && b.length >= 20 && b[0].licence, `len=${b.length}`);
  });

  await check("GET /v1/tools/geocode?query=… (live)", async () => {
    const r = await fetch(`${BASE}/v1/tools/geocode?query=Bundesplatz+3+Bern&limit=2`);
    const b = await r.json();
    assert(r.status === 200 && b.data?.results?.length > 0 && b.source?.attribution, JSON.stringify(b).slice(0, 200));
  });

  await check("GET /v1/tools/get_weather?plz=8001 (live, coerced params)", async () => {
    const r = await fetch(`${BASE}/v1/tools/get_weather?plz=8001`);
    const b = await r.json();
    assert(b.data?.forecast?.length > 0 && b.cache_status, JSON.stringify(b).slice(0, 200));
  });

  await check("GET /v1/tools/get_connections (live, number coercion)", async () => {
    const r = await fetch(`${BASE}/v1/tools/get_connections?from=Bern&to=Lugano&limit=1`);
    const b = await r.json();
    assert(b.data?.connections?.length === 1, JSON.stringify(b).slice(0, 200));
  });

  await check("POST /v1/tools/compare_electricity_tariffs (JSON body)", async () => {
    const r = await fetch(`${BASE}/v1/tools/compare_electricity_tariffs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ municipalities: ["Zürich", "Baden"], category: "H4" }),
    });
    const b = await r.json();
    assert(r.status === 200 && b.data?.cheapest_first?.length >= 1, JSON.stringify(b).slice(0, 300));
  });

  await check("unknown tool → 404 problem+json", async () => {
    const r = await fetch(`${BASE}/v1/tools/nope`);
    assert(r.status === 404 && r.headers.get("content-type")?.includes("problem+json"), `status=${r.status}`);
  });

  await check("invalid params → 400 problem+json", async () => {
    const r = await fetch(`${BASE}/v1/tools/get_weather?plz=notaplz`);
    const b = await r.json();
    assert(r.status === 400 && b.errors?.length > 0, `status=${r.status}`);
  });

  await check("no-result tool error → 404 with detail", async () => {
    const r = await fetch(`${BASE}/v1/tools/lookup_postcode?plz=0000`);
    assert(r.status === 404, `status=${r.status}`);
  });

  await check("anonymous rate-limit headers present (60/min)", async () => {
    const r = await fetch(`${BASE}/v1/health`);
    assert(r.headers.get("ratelimit-limit") === "60" && r.headers.get("ratelimit-remaining"), "missing headers");
  });

  await check("CORS headers present", async () => {
    const r = await fetch(`${BASE}/v1/health`);
    assert(r.headers.get("access-control-allow-origin") === "*", "missing CORS");
  });

  await check("POST /mcp initialize (remote MCP)", async () => {
    const r = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "rest-smoke", version: "0" },
        },
      }),
    });
    const b = await r.json();
    assert(r.status === 200 && b.result?.serverInfo?.name === "swissyphus", JSON.stringify(b).slice(0, 300));
  });

  await check("POST /mcp tools/list (stateless)", async () => {
    const r = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    const b = await r.json();
    assert(r.status === 200 && b.result?.tools?.length > 60, JSON.stringify(b).slice(0, 300));
  });

  // --- API keys, tiers, metering ---
  let apiKey = null;

  await check("POST /v1/keys signup → free key", async () => {
    const r = await fetch(`${BASE}/v1/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "dev@example.com" }),
    });
    const b = await r.json();
    apiKey = b.api_key;
    assert(r.status === 201 && apiKey?.startsWith("sy_live_") && b.tier === "free", JSON.stringify(b).slice(0, 200));
  });

  await check("signup with bad email → 400", async () => {
    const r = await fetch(`${BASE}/v1/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    assert(r.status === 400, `status=${r.status}`);
  });

  await check("keyed request gets free-tier limits + metering headers", async () => {
    const r = await fetch(`${BASE}/v1/tools/list_cantons`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    assert(
      r.status === 200 && r.headers.get("ratelimit-limit") === "240" && r.headers.get("x-monthly-used") === "1",
      `status=${r.status} limit=${r.headers.get("ratelimit-limit")} used=${r.headers.get("x-monthly-used")}`,
    );
  });

  await check("GET /v1/usage reports metered usage", async () => {
    const r = await fetch(`${BASE}/v1/usage`, { headers: { "X-API-Key": apiKey } });
    const b = await r.json();
    assert(r.status === 200 && b.tier === "free" && b.used >= 1 && b.quota === 50000, JSON.stringify(b));
  });

  await check("invalid key → 401", async () => {
    const r = await fetch(`${BASE}/v1/tools/list_cantons`, {
      headers: { Authorization: "Bearer sy_live_deadbeef" },
    });
    assert(r.status === 401, `status=${r.status}`);
  });

  await check("admin without token → 401", async () => {
    const r = await fetch(`${BASE}/v1/admin/keys`);
    assert(r.status === 401, `status=${r.status}`);
  });

  await check("admin promote key to pro", async () => {
    const r = await fetch(`${BASE}/v1/admin/tier`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ api_key: apiKey, tier: "pro" }),
    });
    const b = await r.json();
    assert(r.status === 200 && b.tier === "pro", JSON.stringify(b));
    const r2 = await fetch(`${BASE}/v1/tools/list_cantons`, { headers: { "X-API-Key": apiKey } });
    assert(r2.headers.get("ratelimit-limit") === "1000", `pro limit=${r2.headers.get("ratelimit-limit")}`);
  });

  await check("admin list keys (masked)", async () => {
    const r = await fetch(`${BASE}/v1/admin/keys`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
    const b = await r.json();
    assert(r.status === 200 && b.keys?.length >= 1 && !JSON.stringify(b).includes(apiKey), "unmasked key leaked");
  });

  await check("admin revoke → key rejected", async () => {
    const r = await fetch(`${BASE}/v1/admin/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ api_key: apiKey }),
    });
    assert(r.status === 200, `revoke status=${r.status}`);
    const r2 = await fetch(`${BASE}/v1/tools/list_cantons`, { headers: { "X-API-Key": apiKey } });
    assert(r2.status === 401, `revoked key status=${r2.status}`);
  });

  await check("DELETE /v1/keys self-erasure is permanent", async () => {
    const signup = await fetch(`${BASE}/v1/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "erase-me@example.com" }),
    });
    const { api_key } = await signup.json();
    const del = await fetch(`${BASE}/v1/keys`, { method: "DELETE", headers: { Authorization: `Bearer ${api_key}` } });
    assert(del.status === 200, `delete status=${del.status}`);
    const reuse = await fetch(`${BASE}/v1/tools/list_cantons`, { headers: { "X-API-Key": api_key } });
    assert(reuse.status === 401, `erased key still usable, status=${reuse.status}`);
    const listing = await fetch(`${BASE}/v1/admin/keys`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
    const body = await listing.json();
    assert(
      !body.keys.some((k) => k.email === "erase-me@example.com"),
      "erased key record still present in admin listing",
    );
  });

  await check("DELETE /v1/keys without a key → 401", async () => {
    const r = await fetch(`${BASE}/v1/keys`, { method: "DELETE" });
    assert(r.status === 401, `status=${r.status}`);
  });

  await check("admin brute-force throttling locks out after 10/min", async () => {
    let lastStatus = 0;
    for (let i = 0; i < 12; i++) {
      const r = await fetch(`${BASE}/v1/admin/keys`, { headers: { Authorization: "Bearer wrong-token" } });
      lastStatus = r.status;
    }
    assert(lastStatus === 429, `expected lockout (429) on the 12th attempt, got ${lastStatus}`);
  });

  await check("POST /mcp tools/call get_exchange_rate (live end-to-end)", async () => {
    const r = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "get_exchange_rate", arguments: { currency: "EUR" } },
      }),
    });
    const b = await r.json();
    const text = b.result?.content?.[0]?.text ?? "";
    assert(r.status === 200 && text.includes("rate_chf"), JSON.stringify(b).slice(0, 300));
  });
} finally {
  server.kill();
}

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
for (const f of failures) console.log(`\n[${f.label}]\n${f.err}`);
process.exit(fail ? 1 : 0);
