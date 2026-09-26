/**
 * Swissyphus HTTP mode: REST API + remote MCP on one port.
 *
 *   GET  /                      landing page
 *   GET  /v1/tools              tool catalogue (machine-readable)
 *   GET  /v1/tools/{name}       invoke a tool with query params
 *   POST /v1/tools/{name}       invoke a tool with a JSON body
 *   GET  /v1/sources            licence & source register
 *   GET  /v1/health             liveness + version
 *   GET  /v1/health/sources     live upstream source health
 *   GET  /openapi.json          OpenAPI 3.1 spec (generated from tool schemas)
 *   POST /mcp                   remote MCP (Streamable HTTP, stateless JSON)
 *   POST /v1/keys               self-service free API key ({"email": …})
 *   DELETE /v1/keys             self-service erasure of the presented key (hard delete)
 *   GET  /v1/usage              metered usage for the presented key
 *   GET  /privacy               privacy notice (PRIVACY.md)
 *   /v1/admin/*                 key administration (Bearer ADMIN_TOKEN env)
 *
 * Auth: 'Authorization: Bearer sy_…' or 'X-API-Key'. Tiers: anonymous
 * (IP-limited) → free → pro → enterprise, quotas in core/keys.ts. Metering is
 * on, billing is off (onboarding phase). Errors follow RFC 9457
 * (application/problem+json). CORS enabled for public read endpoints.
 *
 * API keys are stored as SHA-256 hashes only (never plaintext). Set
 * SWISSYPHUS_REQUIRE_TLS=1 in production to reject non-HTTPS traffic at the
 * edge (requires a reverse proxy sending X-Forwarded-Proto).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { SwissyphusModule, ToolDef } from "./core/module.js";
import { setAllowArbitraryUrls } from "./core/policy.js";
import { invokeTool } from "./core/invoke.js";
import { buildServer, VERSION } from "./server.js";
import { runHealthChecks } from "./registry.js";
import { KeyStore, TIER_LIMITS, ANONYMOUS_PER_MINUTE, timingSafeEqualStr, type Tier, type ApiKeyRecord } from "./core/keys.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadPrivacyNotice(): string {
  try {
    return readFileSync(join(__dirname, "..", "PRIVACY.md"), "utf-8");
  } catch {
    return "Privacy notice unavailable in this build — see PRIVACY.md in the source repository.";
  }
}

/** Requests requiring HTTPS at the edge, enforced when SWISSYPHUS_REQUIRE_TLS is set. */
const REQUIRE_TLS = /^(1|true)$/i.test(process.env["SWISSYPHUS_REQUIRE_TLS"] ?? "");
const ADMIN_ATTEMPTS_PER_MINUTE = 10;

const buckets = new Map<string, { count: number; resetAt: number }>();

/** One-minute window limiter, shared by IPs and API keys. limit 0 = unlimited. */
/**
 * Rate-limit weight per tool. Fan-out tools hit many upstream sources per
 * call, so they spend more of the caller's budget (protects the public
 * sources from amplification).
 */
const TOOL_COST: Record<string, number> = { find_data: 5 };

function rateLimited(
  bucketKey: string,
  limit: number,
  windowMs = 60_000,
  cost = 1,
): { limited: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  let b = buckets.get(bucketKey);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(bucketKey, b);
  }
  b.count += cost;
  // Memory guard: when the map grows large, sweep only expired buckets so
  // active clients keep their in-window counters (a blanket clear would reset
  // everyone's limit and briefly let all clients burst).
  if (buckets.size > 20_000) {
    for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
  }
  return {
    limited: limit > 0 && b.count > limit,
    remaining: limit > 0 ? Math.max(0, limit - b.count) : -1,
    resetAt: b.resetAt,
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const SIGNUPS_PER_IP_PER_DAY = 5;

function extractApiKey(req: IncomingMessage, url: URL): string | undefined {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer sy_")) return auth.slice(7).trim();
  const header = req.headers["x-api-key"];
  if (typeof header === "string" && header.startsWith("sy_")) return header.trim();
  const qp = url.searchParams.get("api_key");
  if (qp?.startsWith("sy_")) return qp.trim();
  return undefined;
}

function problem(res: ServerResponse, status: number, title: string, detail?: string, extra?: object): void {
  res.writeHead(status, { "Content-Type": "application/problem+json" });
  res.end(JSON.stringify({ type: "about:blank", title, status, ...(detail ? { detail } : {}), ...extra }));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(typeof body === "string" ? body : JSON.stringify(body, null, 2));
}

/** Coerce query-string values to the types the tool's Zod schema expects. */
function coerceParams(shape: z.ZodRawShape, params: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(shape)) {
    const raw = params.get(key);
    if (raw === null) continue;
    let base: z.ZodTypeAny = schema as z.ZodTypeAny;
    while (base instanceof z.ZodOptional || base instanceof z.ZodDefault) {
      base = base instanceof z.ZodOptional ? base.unwrap() : base.removeDefault();
    }
    if (base instanceof z.ZodNumber) out[key] = Number(raw);
    else if (base instanceof z.ZodBoolean) out[key] = raw === "true" || raw === "1";
    else if (base instanceof z.ZodArray || base instanceof z.ZodObject) {
      try {
        out[key] = JSON.parse(raw);
      } catch {
        // Comma-separated fallback for arrays of strings: a,b,c
        out[key] = base instanceof z.ZodArray ? raw.split(",") : raw;
      }
    } else out[key] = raw;
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

function buildOpenApi(modules: SwissyphusModule[], toolIndex: Map<string, { tool: ToolDef; module: SwissyphusModule }>): object {
  const paths: Record<string, object> = {
    "/v1/keys": {
      post: {
        summary: "Create a free API key",
        description:
          "Self-service signup. Body: {\"email\": \"you@example.com\"}. Returns a bearer key with free-tier limits. " +
          "The key is shown once and stored server-side only as a SHA-256 hash — it cannot be recovered later. See /privacy.",
        responses: { "201": { description: "API key created" }, "400": { description: "Invalid email" } },
      },
      delete: {
        summary: "Erase your API key (self-service, permanent)",
        description:
          "Requires 'Authorization: Bearer <key>'. Immediately and permanently deletes the key record " +
          "(email, tier, usage history) — a hard delete, not a soft revoke.",
        responses: { "200": { description: "Erased" }, "401": { description: "Missing/invalid key" } },
      },
    },
    "/v1/usage": {
      get: {
        summary: "Current key usage",
        description: "Requires 'Authorization: Bearer <key>'. Returns tier, monthly usage and limits.",
        responses: { "200": { description: "Usage stats" }, "401": { description: "Missing/invalid key" } },
      },
    },
    "/privacy": {
      get: {
        summary: "Privacy notice",
        description: "What personal data is collected, why, how long it's kept, and how to exercise your rights.",
        responses: { "200": { description: "Privacy notice (text)" } },
      },
    },
    "/v1/tools": {
      get: { summary: "Tool catalogue", responses: { "200": { description: "Catalogue of all tools by module" } } },
    },
    "/v1/sources": {
      get: { summary: "Licence & source register", responses: { "200": { description: "All data sources with licences" } } },
    },
    "/v1/health": {
      get: { summary: "Liveness", responses: { "200": { description: "Service status and version" } } },
    },
    "/v1/health/sources": {
      get: { summary: "Upstream source health", responses: { "200": { description: "Live status of all data sources" } } },
    },
  };
  for (const [name, { tool, module }] of toolIndex) {
    const schema = zodToJsonSchema(z.object(tool.inputSchema)) as {
      properties?: Record<string, Record<string, unknown>>;
      required?: string[];
    };
    const parameters = Object.entries(schema.properties ?? {}).map(([pname, pschema]) => ({
      name: pname,
      in: "query",
      required: schema.required?.includes(pname) ?? false,
      description: (pschema["description"] as string) ?? "",
      schema:
        pschema["type"] === "array" || pschema["type"] === "object"
          ? { type: "string", description: "JSON-encoded value" }
          : pschema,
    }));
    paths[`/v1/tools/${name}`] = {
      get: {
        summary: tool.title,
        description: tool.description,
        tags: [module.id],
        parameters,
        responses: {
          "200": { description: "Swissyphus envelope: data + source attribution + freshness metadata" },
          "400": { description: "Invalid parameters (problem+json)" },
          "404": { description: "No results (problem+json)" },
          "503": { description: "Upstream source unavailable (problem+json)" },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Swissyphus REST API",
      version: VERSION,
      description:
        "The AI gateway to Switzerland. Every response carries source attribution, licence, retrieved_at, data_as_of and cache_status. " +
        "Anonymous use is rate-limited; free API keys (POST /v1/keys) raise the limits. All tiers are free of charge during the onboarding phase.",
      license: { name: "MIT" },
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        apiKey: { type: "http", scheme: "bearer", description: "API key from POST /v1/keys (sy_live_…)" },
      },
    },
    security: [{}, { apiKey: [] }],
    tags: modules.map((m) => ({ name: m.id, description: m.description })),
    paths,
  };
}

export function startHttpServer(modules: SwissyphusModule[], port: number): void {
  // Public deployment: every argument is attacker-controlled, so tools may not
  // fetch caller-supplied URLs unless the operator explicitly allows it.
  setAllowArbitraryUrls(process.env["SWISSYPHUS_ALLOW_RESOURCE_URL"] === "1");
  const toolIndex = new Map<string, { tool: ToolDef; module: SwissyphusModule }>();
  for (const m of modules) for (const t of m.tools) toolIndex.set(t.name, { tool: t, module: m });
  const keys = new KeyStore();
  const privacyNotice = loadPrivacyNotice();
  const openapi = JSON.stringify(buildOpenApi(modules, toolIndex), null, 2);

  const catalogue = JSON.stringify(
    {
      name: "swissyphus",
      version: VERSION,
      modules: modules.map((m) => ({
        module: m.id,
        title: m.title,
        description: m.description,
        tools: m.tools.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          endpoint: `/v1/tools/${t.name}`,
        })),
      })),
    },
    null,
    2,
  );

  const sources = JSON.stringify(
    modules.flatMap((m) => m.sources.map((s) => ({ module: m.id, ...s }))),
    null,
    2,
  );

  const landing = `<!doctype html><meta charset="utf-8"><title>Swissyphus</title>
<style>body{font-family:system-ui;max-width:720px;margin:3rem auto;padding:0 1rem;color:#1a1a1a}code{background:#f4f4f4;padding:2px 6px;border-radius:4px}a{color:#d52b1e}</style>
<h1>&#x1F1E8;&#x1F1ED; Swissyphus <small style="color:#888;font-weight:normal">v${VERSION}</small></h1>
<p>The AI gateway to Switzerland — ${modules.length} modules, ${toolIndex.size} tools, zero API keys, source attribution on every response.</p>
<ul>
<li><a href="/v1/tools">/v1/tools</a> — tool catalogue</li>
<li><a href="/openapi.json">/openapi.json</a> — OpenAPI 3.1</li>
<li><a href="/v1/sources">/v1/sources</a> — licence &amp; source register</li>
<li><a href="/v1/health/sources">/v1/health/sources</a> — live source health</li>
<li><code>POST /mcp</code> — remote MCP (Streamable HTTP)</li>
</ul>
<h3>Free API key (higher limits)</h3>
<p><code>curl -X POST /v1/keys -d '{"email":"you@example.com"}'</code> → ${TIER_LIMITS.free.perMinute} req/min &amp; ${TIER_LIMITS.free.perMonth.toLocaleString("en-CH")} req/month, usage via <code>/v1/usage</code>. Anonymous: ${ANONYMOUS_PER_MINUTE} req/min. All tiers free during the onboarding phase.</p>
<p>Keys are stored as a hash, never in plaintext — see <a href="/privacy">/privacy</a> for what we collect and <code>DELETE /v1/keys</code> for self-service erasure.</p>
<p>Try: <a href="/v1/tools/get_weather?plz=8001">/v1/tools/get_weather?plz=8001</a> ·
<a href="/v1/tools/geocode?query=Bundesplatz+3+Bern">/v1/tools/geocode?query=Bundesplatz 3 Bern</a> ·
<a href="/v1/tools/get_connections?from=Bern&to=Lugano">/v1/tools/get_connections?from=Bern&amp;to=Lugano</a></p>`;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // CORS for browser use of public endpoints (RFP §5.2). Admin endpoints are
    // deliberately excluded — no Access-Control-Allow-Origin means browsers
    // refuse cross-origin reads/writes against /v1/admin/* even with a valid
    // bearer token, shrinking the attack surface for the most sensitive routes.
    const isAdminPath = path.startsWith("/v1/admin/");
    if (!isAdminPath) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "?";

    // --- Transport security --------------------------------------------------
    // Health checks stay reachable over plain HTTP for load-balancer probes;
    // everything else is rejected unless the edge proxy marks the request as HTTPS.
    if (REQUIRE_TLS && path !== "/v1/health") {
      const proto = ((req.headers["x-forwarded-proto"] as string) ?? "").split(",")[0]?.trim();
      if (proto !== "https") {
        return problem(
          res,
          400,
          "HTTPS required",
          "This deployment requires TLS. Ensure the reverse proxy in front of this server sets 'X-Forwarded-Proto: https'.",
        );
      }
    }

    // --- Authentication & tiered rate limiting -----------------------------
    // Metered surfaces: /v1/tools/{name} and /mcp. Everything else (docs,
    // health, catalogue) is public with a generous anonymous limit.
    const rawKey = extractApiKey(req, url);
    let keyRecord: ApiKeyRecord | undefined;
    if (rawKey) {
      keyRecord = keys.get(rawKey);
      if (!keyRecord) {
        return problem(res, 401, "Invalid API key", "The key is unknown or has been revoked.", {
          hint: "Get a free key: POST /v1/keys with {\"email\": \"you@example.com\"}",
        });
      }
    }
    const isMetered = /^\/v1\/tools\/[a-z0-9_]+$/.test(path) || path === "/mcp";
    const perMin = keyRecord ? TIER_LIMITS[keyRecord.tier].perMinute : ANONYMOUS_PER_MINUTE;
    const toolName = path.match(/^\/v1\/tools\/([a-z0-9_]+)$/)?.[1];
    const cost = (toolName && TOOL_COST[toolName]) || 1;
    const rate = rateLimited(keyRecord ? `key:${keyRecord.hash}` : `ip:${ip}`, perMin, 60_000, cost);
    res.setHeader("RateLimit-Limit", perMin > 0 ? String(perMin) : "unlimited");
    res.setHeader("RateLimit-Remaining", rate.remaining >= 0 ? String(rate.remaining) : "unlimited");
    res.setHeader("RateLimit-Reset", String(Math.ceil((rate.resetAt - Date.now()) / 1000)));
    if (rate.limited) {
      res.setHeader("Retry-After", String(Math.ceil((rate.resetAt - Date.now()) / 1000)));
      return problem(
        res,
        429,
        "Rate limit exceeded",
        keyRecord
          ? `The '${keyRecord.tier}' tier allows ${perMin} requests/minute.`
          : `The anonymous tier allows ${ANONYMOUS_PER_MINUTE} requests/minute. Get a free key via POST /v1/keys for ${TIER_LIMITS.free.perMinute}/min.`,
      );
    }
    if (isMetered && keyRecord) {
      const quota = keys.meter(keyRecord);
      res.setHeader("X-Monthly-Quota", quota.quota > 0 ? String(quota.quota) : "unlimited");
      res.setHeader("X-Monthly-Used", String(quota.used));
      if (!quota.withinQuota) {
        return problem(
          res,
          429,
          "Monthly quota exhausted",
          `The '${keyRecord.tier}' tier includes ${quota.quota} requests/month; used ${quota.used}. Quota resets at month start.`,
        );
      }
    }

    try {
      // --- Key management ---------------------------------------------------
      if (path === "/v1/keys" && req.method === "POST") {
        const signupRate = rateLimited(`signup:${ip}`, SIGNUPS_PER_IP_PER_DAY, 24 * 3600_000);
        if (signupRate.limited) {
          return problem(res, 429, "Too many signups", `Max ${SIGNUPS_PER_IP_PER_DAY} keys per day per IP.`);
        }
        let body: { email?: string };
        try {
          body = JSON.parse(await readBody(req)) as { email?: string };
        } catch {
          return problem(res, 400, "Invalid JSON body", 'Send {"email": "you@example.com"}.');
        }
        if (!body.email || !EMAIL_RE.test(body.email)) {
          return problem(res, 400, "Valid email required", 'Send {"email": "you@example.com"}.');
        }
        const existing = keys.findByEmail(body.email);
        if (existing.length >= 3) {
          return problem(res, 409, "Key limit reached", "This email already has 3 active keys.");
        }
        const { record, rawKey } = keys.create(body.email, "free");
        return json(res, 201, {
          api_key: rawKey,
          tier: record.tier,
          limits: {
            per_minute: TIER_LIMITS.free.perMinute,
            per_month: TIER_LIMITS.free.perMonth,
          },
          usage_endpoint: "/v1/usage",
          how_to_use: "Send the key as 'Authorization: Bearer <key>' or 'X-API-Key: <key>'.",
          note: "Onboarding phase: all tiers are free of charge while we learn from usage. This key is shown once and stored only as a hash — save it now.",
          privacy_notice: "/privacy",
          erasure: "DELETE /v1/keys with this key as 'Authorization: Bearer <key>' permanently deletes this record.",
        });
      }

      if (path === "/v1/keys" && req.method === "DELETE") {
        if (!rawKey || !keyRecord) {
          return problem(res, 401, "API key required", "Send your key as 'Authorization: Bearer <key>' to erase it.");
        }
        keys.erase(rawKey);
        return json(res, 200, { erased: true, note: "This key and its associated record have been permanently deleted." });
      }

      if (path === "/v1/usage" && req.method === "GET") {
        if (!keyRecord) {
          return problem(res, 401, "API key required", "Send your key as 'Authorization: Bearer <key>'.");
        }
        return json(res, 200, { email: keyRecord.email, tier: keyRecord.tier, ...keys.usageOf(keyRecord) });
      }

      if (path === "/privacy" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end(privacyNotice);
      }

      // --- Admin (guarded by ADMIN_TOKEN env) --------------------------------
      if (path.startsWith("/v1/admin/")) {
        const adminToken = process.env["ADMIN_TOKEN"];
        if (!adminToken) {
          return problem(res, 403, "Admin disabled", "Set the ADMIN_TOKEN environment variable to enable admin endpoints.");
        }
        const adminRate = rateLimited(`admin:${ip}`, ADMIN_ATTEMPTS_PER_MINUTE);
        if (adminRate.limited) {
          // Security-event signal for breach detection (Art. 24 nFADP) — IP only,
          // never persisted, console/stderr only. See BREACH_RESPONSE.md.
          console.error(`[security] admin rate limit exceeded from ${ip} at ${new Date().toISOString()}`);
          res.setHeader("Retry-After", String(Math.ceil((adminRate.resetAt - Date.now()) / 1000)));
          return problem(res, 429, "Too many admin attempts", `Max ${ADMIN_ATTEMPTS_PER_MINUTE} admin requests/minute per IP.`);
        }
        const presented = (req.headers["authorization"] ?? "").toString().replace(/^Bearer\s+/i, "");
        if (!presented || !timingSafeEqualStr(presented, adminToken)) {
          console.error(`[security] invalid admin token attempt from ${ip} at ${new Date().toISOString()}`);
          return problem(res, 401, "Invalid admin token");
        }
        if (path === "/v1/admin/keys" && req.method === "GET") {
          return json(res, 200, { keys: keys.list() });
        }
        if (path === "/v1/admin/keys" && req.method === "POST") {
          let body: { email?: string; tier?: Tier };
          try {
            body = JSON.parse(await readBody(req)) as { email?: string; tier?: Tier };
          } catch {
            return problem(res, 400, "Invalid JSON body");
          }
          if (!body.email || !EMAIL_RE.test(body.email)) return problem(res, 400, "Valid email required");
          const tier: Tier = body.tier && body.tier in TIER_LIMITS ? body.tier : "free";
          const { record, rawKey: adminRawKey } = keys.create(body.email, tier);
          return json(res, 201, { api_key: adminRawKey, email: record.email, tier: record.tier });
        }
        if (path === "/v1/admin/tier" && req.method === "POST") {
          let body: { api_key?: string; tier?: Tier };
          try {
            body = JSON.parse(await readBody(req)) as { api_key?: string; tier?: Tier };
          } catch {
            return problem(res, 400, "Invalid JSON body");
          }
          if (!body.api_key || !body.tier || !(body.tier in TIER_LIMITS)) {
            return problem(res, 400, "api_key and tier (free|pro|enterprise) required");
          }
          const updated = keys.setTier(body.api_key, body.tier);
          if (!updated) return problem(res, 404, "Key not found");
          return json(res, 200, { email: updated.email, tier: updated.tier });
        }
        if (path === "/v1/admin/revoke" && req.method === "POST") {
          let body: { api_key?: string };
          try {
            body = JSON.parse(await readBody(req)) as { api_key?: string };
          } catch {
            return problem(res, 400, "Invalid JSON body");
          }
          if (!body.api_key || !keys.revoke(body.api_key)) return problem(res, 404, "Key not found");
          return json(res, 200, { revoked: true, note: `Permanently purged after ${process.env["SWISSYPHUS_REVOKED_RETENTION_DAYS"] ?? 30} days.` });
        }
        if (path === "/v1/admin/erase" && req.method === "POST") {
          let body: { api_key?: string; email?: string };
          try {
            body = JSON.parse(await readBody(req)) as { api_key?: string; email?: string };
          } catch {
            return problem(res, 400, "Invalid JSON body");
          }
          if (body.api_key) {
            if (!keys.erase(body.api_key)) return problem(res, 404, "Key not found");
            return json(res, 200, { erased: 1 });
          }
          if (body.email) {
            const count = keys.eraseByEmail(body.email);
            return json(res, 200, { erased: count });
          }
          return problem(res, 400, "api_key or email required");
        }
        return problem(res, 404, "Unknown admin endpoint");
      }

      if (path === "/" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(landing);
      }
      if (path === "/openapi.json" && req.method === "GET") return json(res, 200, openapi);
      if (path === "/v1/tools" && req.method === "GET") return json(res, 200, catalogue);
      if (path === "/v1/sources" && req.method === "GET") return json(res, 200, sources);
      if (path === "/v1/health" && req.method === "GET") {
        return json(res, 200, { status: "ok", version: VERSION, modules: modules.length, tools: toolIndex.size });
      }
      if (path === "/v1/health/sources" && req.method === "GET") {
        const results = await runHealthChecks();
        const healthy = results.filter((r) => r.ok).length;
        return json(res, healthy === results.length ? 200 : 207, {
          summary: `${healthy}/${results.length} sources healthy`,
          sources: results,
        });
      }

      // Remote MCP — stateless Streamable HTTP.
      if (path === "/mcp") {
        if (req.method !== "POST") {
          return problem(res, 405, "Method not allowed", "The stateless MCP endpoint accepts POST only.");
        }
        const body = await readBody(req);
        let parsed: unknown;
        try {
          parsed = body ? JSON.parse(body) : undefined;
        } catch {
          return problem(res, 400, "Invalid JSON body");
        }
        const mcp = buildServer(modules);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on("close", () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, parsed);
        return;
      }

      // REST tool invocation.
      const toolMatch = path.match(/^\/v1\/tools\/([a-z0-9_]+)$/);
      if (toolMatch && (req.method === "GET" || req.method === "POST")) {
        const name = toolMatch[1] ?? "";
        const entry = toolIndex.get(name);
        if (!entry) {
          return problem(res, 404, "Unknown tool", `No tool named '${name}'. See /v1/tools for the catalogue.`);
        }
        let args: Record<string, unknown>;
        if (req.method === "POST") {
          const body = await readBody(req);
          try {
            args = body ? (JSON.parse(body) as Record<string, unknown>) : {};
          } catch {
            return problem(res, 400, "Invalid JSON body");
          }
        } else {
          args = coerceParams(entry.tool.inputSchema, url.searchParams);
        }
        const validated = z.object(entry.tool.inputSchema).safeParse(args);
        if (!validated.success) {
          return problem(res, 400, "Invalid parameters", undefined, {
            errors: validated.error.issues.map((i) => ({ param: i.path.join("."), message: i.message })),
          });
        }
        const result = await invokeTool(entry.tool, validated.data);
        const text = result.content?.[0]?.type === "text" ? result.content[0].text : "{}";
        if (result.isError) {
          let detail = text;
          let suggestions: unknown;
          try {
            const parsedErr = JSON.parse(text) as { error?: string; suggestions?: unknown };
            detail = parsedErr.error ?? text;
            suggestions = parsedErr.suggestions;
          } catch {
            /* raw text */
          }
          const status = /unavailable|responded with http|timed?\s?out/i.test(detail) ? 503 : 404;
          return problem(res, status, status === 503 ? "Upstream source unavailable" : "No results", detail, {
            ...(suggestions ? { suggestions } : {}),
            tool: name,
          });
        }
        return json(res, 200, text);
      }

      return problem(res, 404, "Not found", "See / for available endpoints.");
    } catch (err) {
      return problem(res, 500, "Internal error", err instanceof Error ? err.message : String(err));
    }
  });

  server.listen(port, () => {
    const toolCount = toolIndex.size;
    console.error(
      `\n  \x1b[31m\x1b[1m✚\x1b[0m \x1b[1mSwissyphus\x1b[0m v${VERSION} — HTTP mode on http://localhost:${port}`,
    );
    console.error(
      `  \x1b[2m${modules.length} modules · ${toolCount} tools · REST /v1/tools · MCP POST /mcp · OpenAPI /openapi.json\x1b[0m\n`,
    );
  });
}
