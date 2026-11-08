# Self-hosting: REST API and remote MCP

The same server that runs locally over stdio also serves HTTP: a REST API, an OpenAPI 3.1 spec
and a remote MCP endpoint, all generated from the same tool schemas.

```bash
npx -y swissyphus --http --port 8000
docker run -p 8000:8000 ghcr.io/cwellbournewood/swissyphus
```

## Endpoints

```text
GET  /                                          landing page
GET  /v1/tools                                  tool catalogue
GET  /v1/tools/get_weather?plz=8001             call any tool with query parameters
POST /v1/tools/compare_electricity_tariffs     or with a JSON body
GET  /v1/sources                                licence and source register
GET  /v1/health                                 liveness
GET  /v1/health/sources                         upstream source health (cached snapshot)
GET  /openapi.json                              OpenAPI 3.1, incl. the Envelope schema
POST /mcp                                       remote MCP (Streamable HTTP, stateless)
GET  /privacy                                   privacy notice
```

Every tool response is the same envelope as over MCP (the `Envelope` schema in
`/openapi.json`). Errors are RFC 9457
`application/problem+json`: 400 invalid parameters, 404 no results, 413 body too large,
429 rate limit, 503 source unavailable. CORS is enabled and every response carries standard
`RateLimit-*` headers.

## API keys and rate limits

A local server needs no key. An HTTP deployment enforces per-IP limits for anonymous callers and
per-key limits and monthly quotas for key holders:

| Tier | Rate limit | Monthly quota | How a caller gets it |
|---|---|---|---|
| Anonymous | 60 req/min per IP | none | just call it |
| Free | 240 req/min | 50'000 | `POST /v1/keys` with `{"email": "you@example.com"}` |
| Pro | 1'000 req/min | 1'000'000 | promoted by the operator (`/v1/admin`) |
| Enterprise | unlimited | unlimited | set by the operator |

Usage is metered; there is no billing integration. What a tier costs on your deployment is up to
you.

```bash
curl -X POST https://your-host/v1/keys -d '{"email":"you@example.com"}'          # → sy_live_… (shown once)
curl -H "Authorization: Bearer sy_live_…" "https://your-host/v1/tools/get_weather?plz=8001"
curl -H "Authorization: Bearer sy_live_…" https://your-host/v1/usage
curl -X DELETE -H "Authorization: Bearer sy_live_…" https://your-host/v1/keys    # permanent erasure
```

Keys work on REST and on `POST /mcp` (`Authorization: Bearer`, `X-API-Key` or `?api_key=`).
They are stored only as a SHA-256 hash and cannot be recovered. `DELETE /v1/keys` is a hard
delete of the key, email and usage history; `/v1/admin/revoke` is a soft revoke, purged after
`SWISSYPHUS_REVOKED_RETENTION_DAYS`.

**Admin.** Set `ADMIN_TOKEN` (at least 32 characters, e.g. `openssl rand -hex 32`) to enable
`/v1/admin/*`: create, promote, revoke and erase keys, list usage. Admin auth is constant-time,
limited to 10 attempts per minute per IP, never gets CORS headers, and logs lockouts.

**Data protection (Swiss nFADP).** [`PRIVACY.md`](../PRIVACY.md) (what is collected and why,
retention, rights), [`ROPA.md`](../ROPA.md) (records of processing),
[`BREACH_RESPONSE.md`](../BREACH_RESPONSE.md) (breach handling). If you run a public deployment,
you are the controller: adapt them to your organisation.

## Docker

```bash
docker run -p 8000:8000 ghcr.io/cwellbournewood/swissyphus                           # REST + remote MCP
docker run -p 8000:8000 ghcr.io/cwellbournewood/swissyphus --http --preset hosted    # public-safe modules only
docker run -p 8000:8000 -v swissyphus-data:/app/data -e ADMIN_TOKEN="$(openssl rand -hex 32)" \
  ghcr.io/cwellbournewood/swissyphus                                                 # persist keys, enable admin
docker run -i --rm ghcr.io/cwellbournewood/swissyphus --stdio                        # MCP over stdio
```

Images are multi-arch (`linux/amd64`, `linux/arm64`), tagged `:vX.Y.Z` and `:latest`, built on
Node 24 LTS Alpine. They run as a non-root user, have a `HEALTHCHECK` against `/v1/health`, keep
keys and the last-known-good store under `/app/data`, and shut down gracefully on SIGTERM
(drain, flush, exit 0).

> These examples expose the container port directly, so do **not** set `SWISSYPHUS_TRUST_PROXY`
> with them: clients could spoof `X-Forwarded-For` and dodge per-IP limits. Set it only behind a
> reverse proxy you control.

## Production deployment

[`deploy/`](../deploy/README.md) is the supported setup: Docker Compose with Caddy (automatic
TLS and security headers) in front of the image, on a single small VPS. It uses the `hosted`
preset, requires TLS, trusts only Caddy's forwarded headers, rotates logs, and documents
backups, restore, uptime checks and upgrades.

**Licences on a public deployment.** Running Swissyphus for others redistributes upstream data.
The `hosted` preset leaves out modules whose terms do not (yet) allow that; the reasons are in
`HOSTED_EXCLUDED` in [`src/registry.ts`](../src/registry.ts). Each response still states its
source's licence. Check the terms of the sources you serve, especially for commercial use.

## Configuration

All variables are optional. HTTP settings are read once at start-up.

| Variable | Default | Mode | Purpose |
|---|---|---|---|
| `PORT` (or `--port`) | `8000` | HTTP | Listen port |
| `ADMIN_TOKEN` | unset (admin off) | HTTP | Enables `/v1/admin/*`. At least 32 characters, otherwise admin stays off |
| `SWISSYPHUS_TRUST_PROXY` | off | HTTP | Behind a reverse proxy that sets `X-Forwarded-For`/`-Proto`. The client IP is the right-most hop. **Never set it when the port is exposed directly** |
| `SWISSYPHUS_REQUIRE_TLS` | off | HTTP | Reject non-HTTPS requests (health checks excepted). Requires `SWISSYPHUS_TRUST_PROXY` |
| `SWISSYPHUS_DATA_DIR` | `./data` (Docker: `/app/data`) | HTTP | Where `keys.json` lives |
| `SWISSYPHUS_REVOKED_RETENTION_DAYS` | `30` | HTTP | Days before soft-revoked keys are purged |
| `SWISSYPHUS_MAX_BODY_BYTES` | 1 MiB | HTTP | Request body cap (larger → 413) |
| `SWISSYPHUS_ALLOW_RESOURCE_URL` | on for stdio, off for HTTP | both | Allow caller-supplied `resource_url` in `query_dataset` & co. (fetched only through a DNS-pinned, public-address-only client) |
| `SWISSYPHUS_HEALTH_TTL_SECONDS` | `60` | both | Cache TTL of the source-health snapshot |
| `SWISSYPHUS_TOOL_BUDGET_MS` | `30000` | both | Wall-clock ceiling per tool call |
| `SWISSYPHUS_FIND_DATA_MS` | `8000` | both | `find_data` answers by then with what has arrived |
| `SWISSYPHUS_MAX_UPSTREAM_BYTES` | 25 MiB | both | Largest upstream response read |
| `SWISSYPHUS_CACHE_MAX_BYTES` (or `SWISSYPHUS_CACHE_MB`) | 128 MiB | both | In-memory response cache budget |
| `SWISSYPHUS_CACHE_MAX_ENTRIES` | `5000` | both | Max cached responses |
| `SWISSYPHUS_UPSTREAM_CONCURRENCY` | `8` | both | Max in-flight requests per upstream host |
| `SWISSYPHUS_LKG_DIR` | unset (Docker: `/app/data/lkg`) | both | On-disk last-known-good copies, served as `stale` when a source is down after a restart. Never stores credentialed requests |
| `SWISSYPHUS_LKG_MAX_BYTES` | 64 MiB | both | Size cap of the last-known-good store |
| `SWISSYPHUS_NO_WARM` | off | both | Skip start-up warm-up (catalogue indexes; the sanctions list in HTTP mode) |
| `SWISSYPHUS_PROXY_ALL` | off (on with `--preset discovery`) | both | Let `call_tool` reach modules that are not loaded |
| `SWISSYPHUS_DEBUG` | off | both | Log tool calls and upstream requests with timings to stderr |
| `OPENTRANSPORTDATA_API_KEY` | unset | both | Enables transport disruptions and real-time delays |
| `ZEFIX_USER` / `ZEFIX_PASS` | unset | both | Official ZefixPublicREST credentials (keyless fallback otherwise) |
