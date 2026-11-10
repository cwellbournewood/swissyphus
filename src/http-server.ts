/**
 * Swissyphus HTTP mode: REST API + remote MCP on one port.
 *
 *   GET  /                      landing page
 *   GET  /v1/tools              tool catalogue (machine-readable)
 *   GET  /v1/tools/{name}       invoke a tool with query params
 *   POST /v1/tools/{name}       invoke a tool with a JSON body
 *   GET  /v1/sources            licence & source register
 *   GET  /v1/health             liveness + version
 *   GET  /v1/health/sources     upstream source health (cached snapshot)
 *   GET  /openapi.json          OpenAPI 3.1 spec (generated from tool schemas)
 *   POST /mcp                   remote MCP (Streamable HTTP, stateless JSON)
 *   GET  /privacy               privacy notice (PRIVACY.md)
 *
 * Swissyphus is free and open source: there are no accounts, API keys, tiers
 * or quotas. The only limit is a per-IP request rate that protects the public
 * upstream sources (SWISSYPHUS_RATE_LIMIT_PER_MINUTE). Errors follow RFC 9457
 * (application/problem+json). CORS is enabled for every endpoint. Nothing about
 * callers is written to disk.
 *
 * Environment (read once at startup):
 *   PORT / --port                  listen port (default 8000)
 *   SWISSYPHUS_TRUST_PROXY=1|true  the server sits behind a reverse proxy that
 *                                  appends/overwrites X-Forwarded-For and sets
 *                                  X-Forwarded-Proto (e.g. the shipped Caddy
 *                                  config). Only then is the client IP taken
 *                                  from the RIGHT-MOST X-Forwarded-For entry
 *                                  (the hop added by the directly-connected
 *                                  proxy) and X-Forwarded-Proto honoured.
 *                                  Default off: client IP = TCP peer address,
 *                                  forwarding headers are ignored (they are
 *                                  client-controlled and would let anyone
 *                                  dodge IP rate limits).
 *   SWISSYPHUS_REQUIRE_TLS=1|true  reject non-HTTPS requests (except
 *                                  GET /v1/health for load-balancer probes).
 *                                  HTTPS is detected from X-Forwarded-Proto,
 *                                  so this REQUIRES SWISSYPHUS_TRUST_PROXY=1.
 *                                  Setting REQUIRE_TLS without TRUST_PROXY is
 *                                  a configuration error and the server
 *                                  refuses to start (chosen over "warn and
 *                                  reject everything": a loud startup failure
 *                                  is clearer than a server that 400s every
 *                                  request, and trusting a client-supplied
 *                                  header would make the TLS check spoofable).
 *   SWISSYPHUS_MAX_BODY_BYTES      max request body size (default 1048576);
 *                                  larger bodies → 413, the read is aborted.
 *   SWISSYPHUS_HEALTH_TTL_SECONDS  source-health snapshot cache TTL (default
 *                                  60; see registry.ts).
 *   SWISSYPHUS_RATE_LIMIT_PER_MINUTE  requests per minute per client IP
 *                                  (default 60; 0 disables the limit).
 *
 * Shutdown: SIGTERM/SIGINT stop accepting connections, close idle keep-alive
 * connections, give in-flight requests up to 10 s and exit 0.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { inputJsonSchema, type SwissyphusModule, type ToolDef } from "./core/module.js";
import { setAllowArbitraryUrls } from "./core/policy.js";
import { invokeTool } from "./core/invoke.js";
import { buildServer, snapshotToolList, useToolListSnapshot, VERSION } from "./server.js";
import type { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { getHealthSnapshot, type HealthSnapshot } from "./registry.js";
import { lkgFlush } from "./core/lkg.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadPrivacyNotice(): string {
  try {
    return readFileSync(join(__dirname, "..", "PRIVACY.md"), "utf-8");
  } catch {
    return "Privacy notice unavailable in this build; see PRIVACY.md in the source repository.";
  }
}

// --- Configuration -----------------------------------------------------------

export const DEFAULT_MAX_BODY_BYTES = 1_048_576;
/** Default requests per minute per client IP (SWISSYPHUS_RATE_LIMIT_PER_MINUTE). */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;
/** How long a graceful shutdown waits for in-flight requests before cutting them off. */
export const SHUTDOWN_DRAIN_MS = 10_000;

/**
 * Rate-limit weight per tool. Fan-out tools hit many upstream sources per
 * call, so they spend more of the caller's budget (protects the public
 * sources from amplification).
 */
const TOOL_COST: Record<string, number> = { find_data: 5 };

export interface HttpConfig {
  trustProxy: boolean;
  requireTls: boolean;
  maxBodyBytes: number;
  /** Requests per minute per client IP; 0 = unlimited. */
  ratePerMinute: number;
  warnings: string[];
}

const truthy = (v: string | undefined): boolean => /^(1|true)$/i.test((v ?? "").trim());

/** Resolve (and validate) HTTP-mode configuration from the environment. Throws on fatal misconfiguration. */
export function resolveHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const warnings: string[] = [];
  const trustProxy = truthy(env["SWISSYPHUS_TRUST_PROXY"]);
  const requireTls = truthy(env["SWISSYPHUS_REQUIRE_TLS"]);
  if (requireTls && !trustProxy) {
    throw new Error(
      "SWISSYPHUS_REQUIRE_TLS=1 needs SWISSYPHUS_TRUST_PROXY=1: HTTPS is detected from the reverse proxy's " +
        "X-Forwarded-Proto header, which is only trusted behind a proxy. Set SWISSYPHUS_TRUST_PROXY=1 when running " +
        "behind a TLS-terminating proxy (e.g. deploy/Caddyfile), or unset SWISSYPHUS_REQUIRE_TLS.",
    );
  }
  const rawMax = env["SWISSYPHUS_MAX_BODY_BYTES"];
  let maxBodyBytes = DEFAULT_MAX_BODY_BYTES;
  if (rawMax !== undefined && rawMax !== "") {
    const n = Number(rawMax);
    if (Number.isInteger(n) && n > 0) maxBodyBytes = n;
    else warnings.push(`SWISSYPHUS_MAX_BODY_BYTES='${rawMax}' is not a positive integer; using ${DEFAULT_MAX_BODY_BYTES}.`);
  }
  const rawRate = env["SWISSYPHUS_RATE_LIMIT_PER_MINUTE"];
  let ratePerMinute = DEFAULT_RATE_LIMIT_PER_MINUTE;
  if (rawRate !== undefined && rawRate !== "") {
    const n = Number(rawRate);
    if (Number.isInteger(n) && n >= 0) ratePerMinute = n;
    else
      warnings.push(
        `SWISSYPHUS_RATE_LIMIT_PER_MINUTE='${rawRate}' is not a non-negative integer; using ${DEFAULT_RATE_LIMIT_PER_MINUTE}.`,
      );
  }
  return { trustProxy, requireTls, maxBodyBytes, ratePerMinute, warnings };
}

// --- Request helpers ---------------------------------------------------------

/**
 * Client IP for rate limiting. Without a trusted proxy this is the TCP peer.
 * Behind a trusted proxy it is the right-most X-Forwarded-For entry: the one
 * appended by the proxy we are directly connected to. Entries to its left are
 * client-supplied and must never be trusted.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  const peer = req.socket.remoteAddress ?? "?";
  if (!trustProxy) return peer;
  const xff = req.headers["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff.join(",") : xff;
  if (!raw) return peer;
  const hops = raw
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return hops[hops.length - 1] ?? peer;
}

/** HTTPS as reported by the trusted proxy (right-most X-Forwarded-Proto value). */
function isHttps(req: IncomingMessage, trustProxy: boolean): boolean {
  if (!trustProxy) return false;
  const xfp = req.headers["x-forwarded-proto"];
  const raw = Array.isArray(xfp) ? xfp.join(",") : (xfp ?? "");
  const protos = raw
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  return protos[protos.length - 1] === "https";
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
    let base: z.ZodTypeAny = schema as unknown as z.ZodTypeAny;
    while (base instanceof z.ZodOptional || base instanceof z.ZodDefault) {
      base = base.unwrap() as unknown as z.ZodTypeAny;
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

class BodyTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`Request body exceeds ${limit} bytes`);
  }
}

/**
 * Read the request body with a hard byte cap. Rejects up front on an
 * oversized Content-Length; otherwise stops buffering as soon as the running
 * total passes the cap (the rest of the upload is discarded, never stored).
 */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) return Promise.reject(new BodyTooLargeError(maxBytes));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        cleanup();
        chunks.length = 0;
        req.resume(); // drain & discard whatever is still in flight
        reject(new BodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf-8"));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

const INVALID_JSON = Symbol("invalid-json");

/** Read + parse a JSON body. Returns INVALID_JSON on a parse error; BodyTooLargeError propagates. */
async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const text = await readBody(req, maxBytes);
  try {
    return text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    return INVALID_JSON;
  }
}

// --- Tool-error → HTTP status mapping ----------------------------------------

export interface ToolErrorMapping {
  status: 404 | 422 | 503;
  title: string;
  detail: string;
  suggestions?: unknown;
}

/**
 * Map a tool's isError result to an HTTP status.
 *
 * Tool errors are CallToolResults whose text is `{"error": …, "suggestions": …}`
 * (core/envelope.ts toolError / errorToResult). A structured hint wins when
 * present (`status` 4xx/5xx, or a `code`/`kind` string such as
 * "upstream_unavailable", "not_found", "invalid_input"), so envelope.ts can
 * make this exact later without touching this file. Otherwise we fall back to
 * the stable message shapes produced today:
 *   - errorToResult(SourceError) → "<source> is currently unavailable: …",
 *     and aborts/timeouts                                    → 503
 *   - "No …", "… not found", "… has no/returned no/publishes no …" → 404
 *   - anything else (input the tool rejected)               → 422
 */
export function mapToolError(text: string): ToolErrorMapping {
  let detail = text;
  let suggestions: unknown;
  let hint: { status?: unknown; code?: unknown; kind?: unknown } = {};
  try {
    const parsed = JSON.parse(text) as { error?: unknown; suggestions?: unknown; status?: unknown; code?: unknown; kind?: unknown };
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.error === "string") detail = parsed.error;
      suggestions = parsed.suggestions;
      hint = parsed;
    }
  } catch {
    /* raw text */
  }
  // errorToResult's fallback carries a raw internal message (usually a TypeError
  // from upstream shape drift): don't leak it over REST.
  if (/^Unexpected error while querying /.test(detail)) {
    detail = "The upstream response could not be processed (it may have changed format). Try again later.";
    suggestions = undefined;
  }
  const out = (status: 404 | 422 | 503): ToolErrorMapping => ({
    status,
    title: status === 503 ? "Upstream source unavailable" : status === 404 ? "No results" : "Request could not be processed",
    detail,
    ...(suggestions ? { suggestions } : {}),
  });

  // 1. Structured hints.
  if (typeof hint.status === "number") {
    if (hint.status >= 500) return out(503);
    if (hint.status === 404) return out(404);
    if (hint.status >= 400) return out(422);
  }
  const code = typeof hint.code === "string" ? hint.code : typeof hint.kind === "string" ? hint.kind : "";
  if (code) {
    if (/unavailable|upstream|timeout|source/i.test(code)) return out(503);
    if (/not.?found|no.?results?|empty/i.test(code)) return out(404);
    if (/invalid|validation|bad.?(input|request)|unsupported/i.test(code)) return out(422);
  }

  // 2. Known message shapes.
  if (/\bis currently unavailable\b|\bresponded with HTTP \d{3}\b|\babort(ed)?\b|\btimed? ?out\b|\btimeout\b/i.test(detail)) {
    return out(503);
  }
  if (
    /^(no|none)\b/i.test(detail) ||
    /\bnot found\b|\b(has|have|returned|publishes|published) no\b/i.test(detail) ||
    /\bno (data|results?|matches|matching|current|live|recent|records?|values?|items?|stations?)\b/i.test(detail)
  ) {
    return out(404);
  }
  return out(422);
}

// --- OpenAPI -----------------------------------------------------------------

interface ToolEntry {
  tool: ToolDef;
  module: SwissyphusModule;
  /** z.object(tool.inputSchema), compiled once at startup. */
  schema: z.ZodObject<z.ZodRawShape>;
}

/** The response envelope every tool returns (core/envelope.ts). Part of the 1.0 stability contract. */
const ENVELOPE_SCHEMA = {
  type: "object",
  required: ["data", "source", "retrieved_at", "data_as_of", "cache_status"],
  properties: {
    data: { description: "The answer. Shape depends on the tool." },
    source: {
      type: "object",
      description: "Who publishes the data and on what terms. Cite `attribution` when you show the data.",
      required: ["name", "operator", "url", "licence", "attribution"],
      properties: {
        name: { type: "string" },
        operator: { type: "string", description: "The organisation that publishes the data" },
        url: { type: "string", format: "uri" },
        licence: { type: "string" },
        attribution: { type: "string" },
      },
    },
    retrieved_at: { type: "string", format: "date-time", description: "When Swissyphus fetched the data from the source" },
    data_as_of: {
      type: ["string", "null"],
      description: "The publisher's own timestamp for the data (observation, issue or modification time); null when the source publishes none",
    },
    cache_status: { type: "string", enum: ["miss", "hit", "stale", "computed"] },
    stale_age_seconds: { type: "integer", description: "Present when cache_status is stale: age of the data served" },
    language: { type: "string" },
    links: { type: "object", additionalProperties: { type: "string" } },
    notes: { type: "string" },
    provenance: {
      type: "object",
      description: "The exact upstream requests behind this answer (credentials redacted)",
      properties: {
        upstream: {
          type: "array",
          items: {
            type: "object",
            required: ["url", "cache_status", "retrieved_at"],
            properties: {
              url: { type: "string" },
              method: { type: "string" },
              cache_status: { type: "string", enum: ["miss", "hit", "stale", "computed"] },
              retrieved_at: { type: "string", format: "date-time" },
            },
          },
        },
      },
    },
  },
} as const;

function buildOpenApi(modules: SwissyphusModule[], toolIndex: Map<string, ToolEntry>): object {
  const paths: Record<string, object> = {
    "/privacy": {
      get: {
        summary: "Privacy notice",
        description: "What a hosted deployment processes about callers (the client IP, in memory, for rate limiting) and why.",
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
      get: {
        summary: "Upstream source health",
        description: "Status of all data sources from a cached probe snapshot (see checked_at / age_seconds).",
        responses: {
          "200": { description: "All sources healthy" },
          "207": { description: "Some sources unreachable" },
        },
      },
    },
  };
  for (const [name, { tool, module, schema: zschema }] of toolIndex) {
    const schema = inputJsonSchema(zschema) as {
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
          "200": {
            description: "Swissyphus envelope: data, source attribution, freshness and request-level provenance",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Envelope" } } },
          },
          "400": { description: "Invalid parameters (problem+json)" },
          "404": { description: "No results (problem+json)" },
          "413": { description: "Request body too large (problem+json)" },
          "422": { description: "Request rejected by the tool (problem+json)" },
          "429": { description: "Rate limit exceeded (problem+json)" },
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
        "Swissyphus, the Swiss public-data rollup for AI agents. Every response is an Envelope: the data plus its source, licence, " +
        "attribution, retrieved_at, the publisher's data_as_of, cache_status and the exact upstream requests (provenance). " +
        "Free and open source: no accounts, API keys or quotas. Hosted deployments apply a per-IP rate limit.",
      license: { name: "MIT" },
    },
    servers: [{ url: "/" }],
    components: {
      schemas: { Envelope: ENVELOPE_SCHEMA },
    },
    tags: modules.map((m) => ({ name: m.id, description: m.description })),
    paths,
  };
}

// --- Server ------------------------------------------------------------------

export interface HttpServerOptions {
  /** Environment to read configuration from (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Interface to bind (default: all interfaces, as before). */
  host?: string;
  /** Install SIGTERM/SIGINT handlers that drain and exit the process (default true; the CLI relies on it). */
  handleSignals?: boolean;
  /** Source-health provider for /v1/health/sources (default: registry's cached snapshot). Injectable for tests. */
  healthSnapshot?: () => Promise<HealthSnapshot>;
  /** Max time close() waits for in-flight requests (default SHUTDOWN_DRAIN_MS). */
  drainMs?: number;
}

export interface RunningHttpServer {
  server: Server;
  config: HttpConfig;
  /** Resolves with the bound address once listening; rejects on listen errors (e.g. EADDRINUSE). */
  ready: Promise<AddressInfo>;
  /** Graceful shutdown: stop accepting, drain in-flight (≤ drainMs). Idempotent. */
  close(): Promise<void>;
}

export function startHttpServer(
  modules: SwissyphusModule[],
  port: number,
  options: HttpServerOptions = {},
): RunningHttpServer {
  const env = options.env ?? process.env;
  const config = resolveHttpConfig(env);
  // Public deployment: every argument is attacker-controlled, so tools may not
  // fetch caller-supplied URLs unless the operator explicitly allows it.
  setAllowArbitraryUrls(env["SWISSYPHUS_ALLOW_RESOURCE_URL"] === "1");
  for (const w of config.warnings) console.error(`[config] warning: ${w}`);

  const toolIndex = new Map<string, ToolEntry>();
  for (const m of modules) {
    for (const t of m.tools) toolIndex.set(t.name, { tool: t, module: m, schema: z.object(t.inputSchema) });
  }
  const healthSnapshot = options.healthSnapshot ?? (() => getHealthSnapshot());
  const drainMs = options.drainMs ?? SHUTDOWN_DRAIN_MS;
  const privacyNotice = loadPrivacyNotice();
  const openapi = JSON.stringify(buildOpenApi(modules, toolIndex), null, 2);

  const buckets = new Map<string, { count: number; resetAt: number }>();

  // tools/list is static for this module selection: compute it once (lazily, on
  // first use) instead of re-serialising every tool schema on each /mcp request.
  let toolListSnapshot: Promise<ListToolsResult | undefined> | undefined;
  function getToolListSnapshot(): Promise<ListToolsResult | undefined> {
    toolListSnapshot ??= snapshotToolList(modules).catch((err) => {
      console.error("[mcp] tools/list snapshot failed; serving it uncached:", err);
      return undefined;
    });
    return toolListSnapshot;
  }

  /** Fixed-window per-IP limiter. limit 0 = unlimited. */
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

  const landing = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Swissyphus</title>
<style>:root{--lake:#123C4D;--contour:#1F7A8C;--glacier:#8FC1C4;--snow:#EEF3F2;--trail:#D97B4F;--trail-ink:#B0532A;--ink2:#3D5A63;--code:#E2ECEA;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--lake:#EEF3F2;--snow:#0B2733;--ink2:#8FC1C4;--trail-ink:#E8956C;--code:#123C4D;--contour:#8FC1C4}}
body{font-family:Archivo,system-ui,-apple-system,'Segoe UI',sans-serif;max-width:780px;margin:3rem auto;padding:0 1rem;color:var(--lake);background:var(--snow);line-height:1.55}
header{display:flex;align-items:center;gap:14px;border-bottom:1px solid var(--lake);padding-bottom:14px}h1{margin:0;font-size:1.7rem;letter-spacing:-.02em;font-weight:700}
small{font-family:'IBM Plex Mono',ui-monospace,monospace;color:var(--contour);font-weight:400;font-size:.8rem}
.lead{font-size:1.1rem;margin:1.2rem 0;color:var(--ink2)}code{font-family:'IBM Plex Mono',ui-monospace,monospace;background:var(--code);padding:1px 6px}a{color:var(--trail-ink)}h3{text-transform:uppercase;letter-spacing:.02em}</style>
<header><svg viewBox="0 0 38 38" width="36" height="36" aria-hidden="true"><path d="M0 38H38V13Z" fill="currentColor"/><circle cx="28" cy="8" r="8" fill="#D97B4F"/></svg>
<h1>swissyphus <small>v${VERSION}</small></h1></header>
<p class="lead">The Swiss public-data rollup for AI agents: ${modules.length} modules, ${toolIndex.size} tools, zero API keys. Every answer carries its source, licence, the publisher's timestamp and the exact upstream requests behind it.</p>
<ul>
<li><a href="/v1/tools">/v1/tools</a>: tool catalogue</li>
<li><a href="/openapi.json">/openapi.json</a>: OpenAPI 3.1</li>
<li><a href="/v1/sources">/v1/sources</a>: licence &amp; source register</li>
<li><a href="/v1/health/sources">/v1/health/sources</a>: source health</li>
<li><code>POST /mcp</code>: remote MCP (Streamable HTTP)</li>
</ul>
<h3>Free and open source</h3>
<p>No signup, no API keys, no quotas. ${config.ratePerMinute > 0 ? `This deployment allows ${config.ratePerMinute} requests per minute per IP, to protect the public sources behind it.` : "This deployment sets no rate limit."} See <a href="/privacy">/privacy</a>.</p>
<p>Try: <a href="/v1/tools/get_weather?plz=8001">/v1/tools/get_weather?plz=8001</a> ·
<a href="/v1/tools/geocode?query=Bundesplatz+3+Bern">/v1/tools/geocode?query=Bundesplatz 3 Bern</a> ·
<a href="/v1/tools/get_connections?from=Bern&to=Lugano">/v1/tools/get_connections?from=Bern&amp;to=Lugano</a></p>
</html>`;

  let shuttingDown = false;

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // Baseline security headers on every response.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    // While draining, don't keep connections alive past the current response.
    if (shuttingDown) res.setHeader("Connection", "close");

    // If we answer before consuming the whole upload (e.g. 413), close the
    // connection gracefully afterwards instead of reading the rest forever.
    res.on("finish", () => {
      if (!req.complete) {
        req.resume();
        req.socket.end();
        setTimeout(() => req.socket.destroy(), 2_000).unref();
      }
    });

    // CORS for browser use: every endpoint is public and read-only.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
    );
    res.setHeader(
      "Access-Control-Expose-Headers",
      "RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After, Mcp-Session-Id",
    );
    res.setHeader("Access-Control-Max-Age", "600");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const ip = clientIp(req, config.trustProxy);

    try {
      // --- Transport security ------------------------------------------------
      // Health checks stay reachable over plain HTTP for load-balancer probes;
      // everything else is rejected unless the trusted edge proxy marks the
      // request as HTTPS (REQUIRE_TLS implies TRUST_PROXY; see resolveHttpConfig).
      if (config.requireTls && path !== "/v1/health" && !isHttps(req, config.trustProxy)) {
        return problem(
          res,
          400,
          "HTTPS required",
          "This deployment requires TLS. Ensure the reverse proxy in front of this server sets 'X-Forwarded-Proto: https'.",
        );
      }

      // --- Per-IP rate limiting ----------------------------------------------
      const perMin = config.ratePerMinute;
      const toolName = path.match(/^\/v1\/tools\/([a-z0-9_]+)$/)?.[1];
      const cost = (toolName && TOOL_COST[toolName]) || 1;
      const rate = rateLimited(`ip:${ip}`, perMin, 60_000, cost);
      res.setHeader("RateLimit-Limit", perMin > 0 ? String(perMin) : "unlimited");
      res.setHeader("RateLimit-Remaining", rate.remaining >= 0 ? String(rate.remaining) : "unlimited");
      res.setHeader("RateLimit-Reset", String(Math.ceil((rate.resetAt - Date.now()) / 1000)));
      if (rate.limited) {
        res.setHeader("Retry-After", String(Math.ceil((rate.resetAt - Date.now()) / 1000)));
        return problem(
          res,
          429,
          "Rate limit exceeded",
          `This deployment allows ${perMin} requests/minute per IP, to protect the public sources behind it. ` +
            "Retry after the reset, or run Swissyphus locally (npx -y swissyphus) for no limit.",
        );
      }

      if (path === "/privacy" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(privacyNotice);
        return;
      }

      if (path === "/" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(landing);
        return;
      }
      if (path === "/openapi.json" && req.method === "GET") return json(res, 200, openapi);
      if (path === "/v1/tools" && req.method === "GET") return json(res, 200, catalogue);
      if (path === "/v1/sources" && req.method === "GET") return json(res, 200, sources);
      if (path === "/v1/health" && req.method === "GET") {
        return json(res, 200, { status: "ok", version: VERSION, modules: modules.length, tools: toolIndex.size });
      }
      if (path === "/v1/health/sources" && req.method === "GET") {
        const snap = await healthSnapshot();
        const results = snap.results;
        const healthy = results.filter((r) => r.ok).length;
        return json(res, healthy === results.length ? 200 : 207, {
          summary: `${healthy}/${results.length} sources healthy`,
          checked_at: snap.checked_at,
          age_seconds: snap.age_seconds,
          cached: snap.cached,
          sources: results,
        });
      }

      // Remote MCP: stateless Streamable HTTP.
      if (path === "/mcp") {
        if (req.method !== "POST") {
          return problem(res, 405, "Method not allowed", "The stateless MCP endpoint accepts POST only.");
        }
        const parsed = await readJson(req, config.maxBodyBytes);
        if (parsed === INVALID_JSON) return problem(res, 400, "Invalid JSON body");
        const mcp = buildServer(modules);
        const snapshot = await getToolListSnapshot();
        if (snapshot) useToolListSnapshot(mcp, snapshot);
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
          const parsed = await readJson(req, config.maxBodyBytes);
          if (parsed === INVALID_JSON) return problem(res, 400, "Invalid JSON body");
          args = (parsed ?? {}) as Record<string, unknown>;
        } else {
          args = coerceParams(entry.tool.inputSchema, url.searchParams);
        }
        const validated = entry.schema.safeParse(args);
        if (!validated.success) {
          return problem(res, 400, "Invalid parameters", undefined, {
            errors: validated.error.issues.map((i) => ({ param: i.path.join("."), message: i.message })),
          });
        }
        const result = await invokeTool(entry.tool, validated.data);
        const text = result.content?.[0]?.type === "text" ? result.content[0].text : "{}";
        if (result.isError) {
          const mapped = mapToolError(text);
          return problem(res, mapped.status, mapped.title, mapped.detail, {
            ...(mapped.suggestions ? { suggestions: mapped.suggestions } : {}),
            tool: name,
          });
        }
        return json(res, 200, text);
      }

      return problem(res, 404, "Not found", "See / for available endpoints.");
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        res.setHeader("Connection", "close");
        return problem(res, 413, "Request body too large", `Request bodies are limited to ${err.limit} bytes.`);
      }
      // Never leak internal error messages to clients; log them instead.
      console.error(`[error] ${req.method ?? "?"} ${path} failed:`, err);
      if (res.headersSent) {
        res.end();
        return;
      }
      return problem(res, 500, "Internal error", "An unexpected error occurred. It has been logged.");
    }
  }

  // Slow-client protection: bound the time to receive headers and the whole request.
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;

  const ready = new Promise<AddressInfo>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen({ port, ...(options.host ? { host: options.host } : {}) }, () => {
      server.off("error", onError);
      const addr = server.address() as AddressInfo;
      console.error(
        `\n  \x1b[31m\x1b[1m✚\x1b[0m \x1b[1mSwissyphus\x1b[0m v${VERSION}: HTTP mode on http://localhost:${addr.port}`,
      );
      console.error(
        `  \x1b[2m${modules.length} modules · ${toolIndex.size} tools · REST /v1/tools · MCP POST /mcp · OpenAPI /openapi.json\x1b[0m\n`,
      );
      resolve(addr);
    });
  });
  // Avoid an unhandled rejection when the caller never awaits `ready`.
  ready.catch(() => undefined);

  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closing) return closing;
    shuttingDown = true;
    closing = new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearInterval(idleSweep);
        clearTimeout(hardStop);
        // Let in-flight last-known-good writes land (bounded: they are small local writes).
        void Promise.race([lkgFlush(), new Promise((r) => setTimeout(r, 2_000).unref())]).then(() => resolve());
      };
      // Stop accepting; the callback fires once every connection has ended.
      server.close(() => finish());
      // Connections that finish their response while draining become idle; close them promptly.
      server.closeIdleConnections();
      const idleSweep = setInterval(() => server.closeIdleConnections(), 100);
      const hardStop = setTimeout(() => {
        server.closeAllConnections();
        finish();
      }, drainMs);
      idleSweep.unref();
      hardStop.unref();
    });
    return closing;
  }

  if (options.handleSignals !== false) {
    const onSignal = (signal: NodeJS.Signals) => {
      if (closing) {
        console.error(`[shutdown] second ${signal}; exiting immediately`);
        process.exit(1);
      }
      console.error(`[shutdown] ${signal} received; draining in-flight requests (up to ${drainMs / 1000} s)…`);
      void close().then(() => process.exit(0));
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  }

  return { server, config, ready, close };
}
