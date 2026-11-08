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
 *   POST /v1/keys               self-service free API key ({"email": …})
 *   DELETE /v1/keys             self-service erasure of the presented key (hard delete)
 *   GET  /v1/usage              metered usage for the presented key
 *   GET  /privacy               privacy notice (PRIVACY.md)
 *   /v1/admin/*                 key administration (Bearer ADMIN_TOKEN env)
 *
 * Auth: 'Authorization: Bearer sy_…' or 'X-API-Key'. Tiers: anonymous
 * (IP-limited) → free → pro → enterprise, quotas in core/keys.ts. Metering is
 * on, billing is off (onboarding phase). Only valid work is metered: a REST
 * tool call once the tool exists and its parameters validate, and on /mcp each
 * JSON-RPC `tools/call` message (initialize, tools/list, notifications are
 * free). Errors follow RFC 9457 (application/problem+json). CORS is enabled
 * for every public endpoint; /v1/admin/* deliberately gets no CORS headers.
 *
 * API keys are stored as SHA-256 hashes only (never plaintext).
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
 *   ADMIN_TOKEN                    enables /v1/admin/* only when ≥ 32 chars;
 *                                  shorter tokens leave admin disabled (403)
 *                                  and log a startup warning.
 *   SWISSYPHUS_DATA_DIR            key store directory (core/keys.ts).
 *
 * Shutdown: SIGTERM/SIGINT stop accepting connections, close idle keep-alive
 * connections, give in-flight requests up to 10 s, flush metered usage and
 * exit 0.
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
import { KeyStore, TIER_LIMITS, ANONYMOUS_PER_MINUTE, timingSafeEqualStr, type Tier, type ApiKeyRecord } from "./core/keys.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadPrivacyNotice(): string {
  try {
    return readFileSync(join(__dirname, "..", "PRIVACY.md"), "utf-8");
  } catch {
    return "Privacy notice unavailable in this build — see PRIVACY.md in the source repository.";
  }
}

// --- Configuration -----------------------------------------------------------

export const DEFAULT_MAX_BODY_BYTES = 1_048_576;
export const MIN_ADMIN_TOKEN_LENGTH = 32;
/** How long a graceful shutdown waits for in-flight requests before cutting them off. */
export const SHUTDOWN_DRAIN_MS = 10_000;
const ADMIN_ATTEMPTS_PER_MINUTE = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const SIGNUPS_PER_IP_PER_DAY = 5;

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
  /** undefined = admin disabled (unset or too short). */
  adminToken: string | undefined;
  /** Why admin is disabled, for the 403 detail. */
  adminDisabledReason: string | undefined;
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
  const token = env["ADMIN_TOKEN"];
  let adminToken: string | undefined;
  let adminDisabledReason: string | undefined;
  if (!token) {
    adminDisabledReason = `Set the ADMIN_TOKEN environment variable (at least ${MIN_ADMIN_TOKEN_LENGTH} characters) to enable admin endpoints.`;
  } else if (token.length < MIN_ADMIN_TOKEN_LENGTH) {
    adminDisabledReason =
      `ADMIN_TOKEN is shorter than ${MIN_ADMIN_TOKEN_LENGTH} characters, so admin endpoints are disabled. ` +
      "Generate a strong token, e.g. `openssl rand -hex 32`.";
    warnings.push(
      `ADMIN_TOKEN has ${token.length} characters (minimum ${MIN_ADMIN_TOKEN_LENGTH}); /v1/admin/* is DISABLED. ` +
        "Generate one with `openssl rand -hex 32`.",
    );
  } else {
    adminToken = token;
  }
  return { trustProxy, requireTls, maxBodyBytes, adminToken, adminDisabledReason, warnings };
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

/** Count JSON-RPC tools/call messages (single message or batch) — the only metered MCP traffic. */
export function countToolCalls(payload: unknown, knownTools?: ReadonlySet<string>): number {
  const msgs = Array.isArray(payload) ? payload : [payload];
  // Only well-formed JSON-RPC requests naming a real tool are billable; the SDK
  // rejects everything else before any work is done.
  return msgs.filter((m) => {
    if (m === null || typeof m !== "object") return false;
    const msg = m as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: { name?: unknown } };
    if (msg.jsonrpc !== "2.0" || msg.method !== "tools/call") return false;
    if (typeof msg.id !== "string" && typeof msg.id !== "number") return false;
    const name = msg.params?.name;
    if (typeof name !== "string") return false;
    return knownTools ? knownTools.has(name) : true;
  }).length;
}

/** The Streamable HTTP transport answers 406 unless the client accepts both JSON and SSE. */
function acceptsMcpResponse(req: IncomingMessage): boolean {
  const accept = String(req.headers["accept"] ?? "");
  return accept.includes("application/json") && accept.includes("text/event-stream");
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
  // from upstream shape drift) — don't leak it over REST.
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
          "429": { description: "Rate limit or monthly quota exceeded (problem+json)" },
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
        "Anonymous use is rate-limited; free API keys (POST /v1/keys) raise the limits. All tiers are free of charge during the onboarding phase.",
      license: { name: "MIT" },
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        apiKey: { type: "http", scheme: "bearer", description: "API key from POST /v1/keys (sy_live_…)" },
      },
      schemas: { Envelope: ENVELOPE_SCHEMA },
    },
    security: [{}, { apiKey: [] }],
    tags: modules.map((m) => ({ name: m.id, description: m.description })),
    paths,
  };
}

// --- Server ------------------------------------------------------------------

export interface HttpServerOptions {
  /** Environment to read configuration from (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Key store directory (default SWISSYPHUS_DATA_DIR or ./data). */
  dataDir?: string;
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
  keys: KeyStore;
  config: HttpConfig;
  /** Resolves with the bound address once listening; rejects on listen errors (e.g. EADDRINUSE). */
  ready: Promise<AddressInfo>;
  /** Graceful shutdown: stop accepting, drain in-flight (≤ drainMs), flush usage. Idempotent. */
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
  const toolNames: ReadonlySet<string> = new Set(toolIndex.keys());
  // Throws (refusing to start) if keys.json is corrupt — see core/keys.ts.
  const keys = new KeyStore(options.dataDir ?? env["SWISSYPHUS_DATA_DIR"]);
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

  /** One-minute window limiter, shared by IPs and API keys. limit 0 = unlimited. */
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
<style>:root{--ink:#0B0F19;--snow:#F7F6F3;--red:#E5322D;--slate:#5B6472;--code:#EEF0F3;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--ink:#F7F6F3;--snow:#0B0F19;--slate:#AEB4BE;--code:#1A2130}}
body{font-family:Inter,system-ui,sans-serif;max-width:760px;margin:3rem auto;padding:0 1rem;color:var(--ink);background:var(--snow);line-height:1.55}
header{display:flex;align-items:center;gap:14px}h1{margin:0;font-size:2rem;letter-spacing:-.03em}small{color:var(--slate);font-weight:400;font-size:.9rem}
.lead{font-size:1.15rem;margin:.6rem 0 1.4rem}code{background:var(--code);padding:2px 6px;border-radius:4px}a{color:var(--red)}</style>
<header><svg viewBox="0 0 64 64" width="44" height="44" style="color:var(--red)" aria-hidden="true"><g transform="translate(-8.80 -13.31) scale(1.3152)"><path d="M33.53 34.10 L33.63 34.09 L33.73 34.08 L33.83 34.06 L33.94 34.03 L34.04 34.01 L34.15 33.97 L34.25 33.94 L34.35 33.89 L34.46 33.84 L34.56 33.79 L34.66 33.74 L34.76 33.67 L34.86 33.61 L34.96 33.53 L35.06 33.46 L35.15 33.38 L35.24 33.29 L35.34 33.20 L35.42 33.11 L35.51 33.01 L35.59 32.90 L35.67 32.79 L35.75 32.68 L35.82 32.56 L35.89 32.44 L35.95 32.32 L36.01 32.19 L36.07 32.06 L36.12 31.92 L36.17 31.78 L36.21 31.64 L36.25 31.49 L36.28 31.34 L36.31 31.19 L36.33 31.04 L36.35 30.88 L36.36 30.73 L36.37 30.56 L36.36 30.40 L36.36 30.24 L36.34 30.07 L36.33 29.91 L36.30 29.74 L36.27 29.57 L36.23 29.41 L36.19 29.24 L36.14 29.07 L36.08 28.90 L36.01 28.74 L35.94 28.57 L35.87 28.41 L35.78 28.24 L35.69 28.08 L35.59 27.92 L35.49 27.77 L35.38 27.61 L35.26 27.46 L35.14 27.31 L35.01 27.16 L34.88 27.02 L34.73 26.88 L34.59 26.75 L34.43 26.62 L34.27 26.49 L34.11 26.37 L33.93 26.25 L33.76 26.14 L33.58 26.03 L33.39 25.93 L33.20 25.84 L33.00 25.75 L32.80 25.67 L32.59 25.60 L32.38 25.53 L32.17 25.46 L31.95 25.41 L31.73 25.36 L31.51 25.32 L31.28 25.29 L31.05 25.27 L30.82 25.25 L30.59 25.24 L30.35 25.24 L30.11 25.25 L29.88 25.26 L29.64 25.29 L29.40 25.32 L29.16 25.36 L28.92 25.41 L28.67 25.47 L28.43 25.54 L28.20 25.62 L27.96 25.70 L27.72 25.80 L27.49 25.90 L27.25 26.01 L27.02 26.13 L26.80 26.26 L26.57 26.40 L26.35 26.55 L26.14 26.70 L25.92 26.87 L25.72 27.04 L25.51 27.22 L25.31 27.41 L25.12 27.60 L24.93 27.80 L24.75 28.02 L24.58 28.23 L24.41 28.46 L24.25 28.69 L24.09 28.93 L23.95 29.18 L23.81 29.43 L23.68 29.69 L23.55 29.96 L23.44 30.23 L23.33 30.50 L23.24 30.78 L23.15 31.07 L23.07 31.36 L23.00 31.65 L22.94 31.95 L22.89 32.25 L22.85 32.56 L22.83 32.87 L22.81 33.18 L22.80 33.49 L22.80 33.80 L22.82 34.12 L22.84 34.44 L22.88 34.75 L22.92 35.07 L22.98 35.39 L23.05 35.71 L23.13 36.02 L23.22 36.34 L23.32 36.65 L23.44 36.96 L23.56 37.27 L23.70 37.58 L23.84 37.88 L24.00 38.18 L24.17 38.48 L24.35 38.77 L24.54 39.05 L24.74 39.33 L24.95 39.61 L25.18 39.88 L25.41 40.14 L25.65 40.40 L25.90 40.65 L26.16 40.89 L26.43 41.12 L26.71 41.35 L27.00 41.56 L27.30 41.77 L27.60 41.97 L27.92 42.16 L28.24 42.34 L28.57 42.51 L28.90 42.66 L29.24 42.81 L29.59 42.95 L29.95 43.07 L30.31 43.19 L30.67 43.29 L31.04 43.38 L31.42 43.46 L31.80 43.52 L32.18 43.58 L32.57 43.62 L32.96 43.64 L33.35 43.66 L33.74 43.66 L34.14 43.65 L34.53 43.62 L34.93 43.58 L35.33 43.53 L35.72 43.46 L36.12 43.38 L36.51 43.29 L36.91 43.18 L37.30 43.06 L37.69 42.92 L38.07 42.77 L38.45 42.61 L38.83 42.43 L39.20 42.25 L39.57 42.04 L39.93 41.83 L40.29 41.60 L40.63 41.36 L40.98 41.10 L41.31 40.84 L41.64 40.56 L41.96 40.27 L42.27 39.96 L42.57 39.65 L42.86 39.33 L43.14 38.99 L43.41 38.64 L43.67 38.29 L43.92 37.92 L44.16 37.54 L44.38 37.16 L44.60 36.76 L44.80 36.36 L44.99 35.95 L45.16 35.53 L45.32 35.10 L45.47 34.67 L45.60 34.23 L45.72 33.78 L45.82 33.33 L45.91 32.88 L45.99 32.42 L46.04 31.95 L46.09 31.48 L46.12 31.01 L46.13 30.54 L46.12 30.07 L46.10 29.59 L46.07 29.11 L46.01 28.64 L45.95 28.16 L45.86 27.68 L45.76 27.21 L45.64 26.74 L45.51 26.27 L45.36 25.80 L45.19 25.34 L45.01 24.88 L44.81 24.42 L44.60 23.97 L44.37 23.53 L44.12 23.09 L43.86 22.67 L43.59 22.24 L43.30 21.83 L42.99 21.42 L42.67 21.03 L42.34 20.64 L41.99 20.26 L41.63 19.90 L41.25 19.54 L40.86 19.20 L40.46 18.87 L40.05 18.55 L39.62 18.25 L39.19 17.95 L38.74 17.68 L38.28 17.41 L37.81 17.16 L37.34 16.93 L36.85 16.71 L36.35 16.51 L35.85 16.32 L35.34 16.15 L34.82 16.00 L34.30 15.86 L33.77 15.74 L33.23 15.64 L32.69 15.55 L32.14 15.49 L31.60 15.44 L31.04 15.41 L30.49 15.40 L29.93 15.41 L29.38 15.43 L28.82 15.48 L28.26 15.54 L27.70 15.62 L27.15 15.72 L26.59 15.84 L26.04 15.98 L25.50 16.14 L24.95 16.32 L24.41 16.51 L23.88 16.73 L23.35 16.96 L22.83 17.21 L22.31 17.48 L21.81 17.76 L21.31 18.07 L20.82 18.39 L20.34 18.73 L19.87 19.08 L19.41 19.45 L18.96 19.84 L18.53 20.25 L18.11 20.67 L17.70 21.10 L17.30 21.55 L16.92 22.02 L16.55 22.49 L16.20 22.99 L15.86 23.49 L15.54 24.01 L15.24 24.54 L14.95 25.08 L14.68 25.63 L14.43 26.19 L14.20 26.76 L13.98 27.34 L13.78 27.93 L13.61 28.52 L13.45 29.13 L13.31 29.74 L13.20 30.35 L13.10 30.98 L13.02 31.60 L12.97 32.23 L12.93 32.87 L12.92 33.50 L12.93 34.14 L12.96 34.78 L13.01 35.42 L13.08 36.06 L13.18 36.69 L13.29 37.33 L13.43 37.96 L13.59 38.59 L13.77 39.22 L13.97 39.84 L14.19 40.46 L14.43 41.07 L14.70 41.67 L14.98 42.26 L15.29 42.85 L15.62 43.43 L15.96 44.00 L16.33 44.56 L16.71 45.10 L17.12 45.64 L17.54 46.16 L17.98 46.67 L18.44 47.17 L18.92 47.65 L19.41 48.11 L19.92 48.57 L20.45 49.00 L20.99 49.42 L21.55 49.82 L22.12 50.20 L22.70 50.57 L23.30 50.91 L23.91 51.24 L24.54 51.55 L25.17 51.83 L25.82 52.10 L26.47 52.34 L27.14 52.57 L27.81 52.77 L28.49 52.95 L29.18 53.10 L29.88 53.24 L30.58 53.35 L31.29 53.44 L32.00 53.50 L41.50 53.50" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="42.00" cy="53.50" r="5.2" fill="currentColor"/></g></svg>
<h1>Swissyphus <small>v${VERSION}</small></h1></header>
<p class="lead">The Swiss public-data rollup for AI agents: ${modules.length} modules, ${toolIndex.size} tools, zero API keys. Every answer carries its source, licence, the publisher's timestamp and the exact upstream requests behind it.</p>
<ul>
<li><a href="/v1/tools">/v1/tools</a> — tool catalogue</li>
<li><a href="/openapi.json">/openapi.json</a> — OpenAPI 3.1</li>
<li><a href="/v1/sources">/v1/sources</a> — licence &amp; source register</li>
<li><a href="/v1/health/sources">/v1/health/sources</a> — source health</li>
<li><code>POST /mcp</code> — remote MCP (Streamable HTTP)</li>
</ul>
<h3>Free API key (higher limits)</h3>
<p><code>curl -X POST /v1/keys -d '{"email":"you@example.com"}'</code> → ${TIER_LIMITS.free.perMinute} req/min &amp; ${TIER_LIMITS.free.perMonth.toLocaleString("en-CH")} req/month, usage via <code>/v1/usage</code>. Anonymous: ${ANONYMOUS_PER_MINUTE} req/min. All tiers free during the onboarding phase.</p>
<p>Keys are stored as a hash, never in plaintext — see <a href="/privacy">/privacy</a> for what we collect and <code>DELETE /v1/keys</code> for self-service erasure.</p>
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

    // CORS for browser use of public endpoints (RFP §5.2). Admin endpoints are
    // deliberately excluded — no Access-Control-Allow-Origin means browsers
    // refuse cross-origin reads/writes against /v1/admin/* even with a valid
    // bearer token, shrinking the attack surface for the most sensitive routes.
    const isAdminPath = path.startsWith("/v1/admin/") || path === "/v1/admin";
    if (!isAdminPath) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Accept, Authorization, X-API-Key, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
      );
      res.setHeader(
        "Access-Control-Expose-Headers",
        "RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After, X-Monthly-Quota, X-Monthly-Used, Mcp-Session-Id",
      );
      res.setHeader("Access-Control-Max-Age", "600");
    }
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
      // request as HTTPS (REQUIRE_TLS implies TRUST_PROXY — see resolveHttpConfig).
      if (config.requireTls && path !== "/v1/health" && !isHttps(req, config.trustProxy)) {
        return problem(
          res,
          400,
          "HTTPS required",
          "This deployment requires TLS. Ensure the reverse proxy in front of this server sets 'X-Forwarded-Proto: https'.",
        );
      }

      // --- Authentication & tiered rate limiting -----------------------------
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

      /**
       * Charge `units` of valid, about-to-execute work against the key's monthly
       * quota. Called only after the request is known valid, and always before
       * the tool runs. Returns false (after sending 429) when the quota would be
       * exceeded — the rejected work is not charged. Anonymous calls are not metered.
       */
      const charge = (units: number): boolean => {
        if (!keyRecord || units <= 0) return true;
        const before = keys.usageOf(keyRecord);
        if (before.quota > 0 && before.used + units > before.quota) {
          res.setHeader("X-Monthly-Quota", String(before.quota));
          res.setHeader("X-Monthly-Used", String(before.used));
          problem(
            res,
            429,
            "Monthly quota exhausted",
            `The '${keyRecord.tier}' tier includes ${before.quota} requests/month; used ${before.used}. Quota resets at month start.`,
          );
          return false;
        }
        const q = keys.meter(keyRecord, units);
        res.setHeader("X-Monthly-Quota", q.quota > 0 ? String(q.quota) : "unlimited");
        res.setHeader("X-Monthly-Used", String(q.used));
        return true;
      };

      // --- Key management ---------------------------------------------------
      if (path === "/v1/keys" && req.method === "POST") {
        const signupRate = rateLimited(`signup:${ip}`, SIGNUPS_PER_IP_PER_DAY, 24 * 3600_000);
        if (signupRate.limited) {
          return problem(res, 429, "Too many signups", `Max ${SIGNUPS_PER_IP_PER_DAY} keys per day per IP.`);
        }
        const body = (await readJson(req, config.maxBodyBytes)) as { email?: unknown } | typeof INVALID_JSON | undefined;
        if (body === INVALID_JSON || !body || typeof body !== "object") {
          return problem(res, 400, "Invalid JSON body", 'Send {"email": "you@example.com"}.');
        }
        if (typeof body.email !== "string" || !EMAIL_RE.test(body.email)) {
          return problem(res, 400, "Valid email required", 'Send {"email": "you@example.com"}.');
        }
        const existing = keys.findByEmail(body.email);
        if (existing.length >= 3) {
          return problem(res, 409, "Key limit reached", "This email already has 3 active keys.");
        }
        const { record, rawKey: newKey } = keys.create(body.email, "free");
        return json(res, 201, {
          api_key: newKey,
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
        res.end(privacyNotice);
        return;
      }

      // --- Admin (guarded by ADMIN_TOKEN env, ≥ 32 chars) -----------------------
      if (isAdminPath) {
        const adminToken = config.adminToken;
        if (!adminToken) {
          return problem(res, 403, "Admin disabled", config.adminDisabledReason);
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
        if (req.method === "POST" && ["/v1/admin/keys", "/v1/admin/tier", "/v1/admin/revoke", "/v1/admin/erase"].includes(path)) {
          const parsed = await readJson(req, config.maxBodyBytes);
          if (parsed === INVALID_JSON || !parsed || typeof parsed !== "object") {
            return problem(res, 400, "Invalid JSON body");
          }
          const body = parsed as { email?: string; tier?: Tier; api_key?: string };
          if (path === "/v1/admin/keys") {
            if (!body.email || !EMAIL_RE.test(body.email)) return problem(res, 400, "Valid email required");
            const tier: Tier = body.tier && body.tier in TIER_LIMITS ? body.tier : "free";
            const { record, rawKey: adminRawKey } = keys.create(body.email, tier);
            return json(res, 201, { api_key: adminRawKey, email: record.email, tier: record.tier });
          }
          if (path === "/v1/admin/tier") {
            if (!body.api_key || !body.tier || !(body.tier in TIER_LIMITS)) {
              return problem(res, 400, "api_key and tier (free|pro|enterprise) required");
            }
            const updated = keys.setTier(body.api_key, body.tier);
            if (!updated) return problem(res, 404, "Key not found");
            return json(res, 200, { email: updated.email, tier: updated.tier });
          }
          if (path === "/v1/admin/revoke") {
            if (!body.api_key || !keys.revoke(body.api_key)) return problem(res, 404, "Key not found");
            return json(res, 200, {
              revoked: true,
              note: `Permanently purged after ${process.env["SWISSYPHUS_REVOKED_RETENTION_DAYS"] ?? 30} days.`,
            });
          }
          // /v1/admin/erase
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

      // Remote MCP — stateless Streamable HTTP.
      if (path === "/mcp") {
        if (req.method !== "POST") {
          return problem(res, 405, "Method not allowed", "The stateless MCP endpoint accepts POST only.");
        }
        const parsed = await readJson(req, config.maxBodyBytes);
        if (parsed === INVALID_JSON) return problem(res, 400, "Invalid JSON body");
        // Metering: only tools/call messages cost quota (each one in a batch).
        if (acceptsMcpResponse(req) && !charge(countToolCalls(parsed, toolNames))) return;
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
        // Valid request: charge quota (blocks with 429 before the tool runs).
        if (!charge(1)) return;
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
        `\n  \x1b[31m\x1b[1m✚\x1b[0m \x1b[1mSwissyphus\x1b[0m v${VERSION} — HTTP mode on http://localhost:${addr.port}`,
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
        try {
          keys.close();
        } catch (err) {
          console.error("[keys] failed to flush usage on shutdown:", err);
        }
        // Let in-flight last-known-good writes land (bounded: they are small local writes).
        void Promise.race([lkgFlush(), new Promise((r) => setTimeout(r, 2_000).unref())]).then(() => resolve());
      };
      // Stop accepting; the callback fires once every connection has ended.
      server.close(() => finish());
      // Connections that finish their response while draining become idle — close them promptly.
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

  return { server, keys, config, ready, close };
}
