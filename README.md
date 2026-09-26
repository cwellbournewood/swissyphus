# 🇨🇭 Swissyphus

**The AI gateway to Switzerland.** Like Sisyphus, but the boulder is Swiss open data and we enjoy rolling it uphill — every day, from ~25 fragmented official sources, so your agent doesn't have to. One MCP server, 25 modules, 71 tools, zero API keys, source attribution and freshness metadata on **every** response.

```bash
npx swissyphus
```

That's the whole install. Under 60 seconds to first result, no signup, no keys.

---

## What can it answer?

> *"Next train Bern→Lugano, and is there snow in Zermatt?"* · *"Who is Nestlé in the commercial register, and what did they publish in the SOGC?"* · *"Avalanche danger at 46.8, 9.8?"* · *"Is SR 235.1 still in force?"* · *"Solar potential of this roof?"* · *"Electricity tariff in Baden vs Zürich?"* · *"How did Switzerland vote on June 14?"* · *"Any emergency alerts for Ticino right now?"* · *"EV chargers near Zürich HB?"* · *"When's the next cardboard collection in 8001?"*

## Modules (25)

| | Module | Covers | Source |
|---|---|---|---|
| 🏢 | `companies` | Register search (+canton filter), details by UID, cantons, SOGC gazette (mutations, bankruptcies) | ZEFIX, SHAB/FOSC |
| 🚆 | `transport` | Connections, departure/arrival boards, station search — live | SBB / opentransportdata |
| 🌦️ | `weather` | Conditions, 8-day forecast, warnings, live 10-min stations, **history**, **live pollen** | MeteoSwiss |
| 🌊 | `hydrology` | River/lake levels, discharge, temperature + **history** (~600 stations) | FOEN/BAFU |
| 🗺️ | `geo` | Geocoding, reverse geocoding, elevation, profiles, municipalities, solar potential, any federal map layer | swisstopo |
| 📐 | `coords` | LV95 ↔ WGS84 ↔ LV03, instant & offline | swisstopo formulas |
| 📮 | `postcode` | PLZ ↔ locality ↔ coordinates, parcel tracking links | Official directory, Swiss Post |
| 🏠 | `buildings` | Official building register by EGID: year, category, floors, dwellings | GWR/RegBL (BFS Madd) |
| ⚖️ | `law` | Classified Compilation search, SR lookup, in-force status, all languages | Fedlex SPARQL |
| 📊 | `statistics` | 12'000+ OGD datasets + official population (CH + cantons) | opendata.swiss, BFS STAT-TAB |
| 🏛️ | `parliament` | Business search, members, **sessions**, **votes with real yes/no tallies** | Curia Vista |
| 🗳️ | `voting` | **National** popular-vote results, per-canton breakdown, all recent vote days | BFS vote-day OGD |
| 🚨 | `alerts` | Live official population warnings, all hazards | Alertswiss (FOCP) |
| 🏔️ | `avalanche` | Official bulletin, danger level at any coordinate | SLF |
| ❄️ | `snow` | Live snow depth, temperature, wind from 300+ alpine stations | SLF IMIS |
| 🥾 | `trails` | Official hiking-trail closures & detours near any point | ASTRA/SwitzerlandMobility |
| 🌍 | `earthquakes` | Recent + historical events, radius search, event details | SED/ETH Zürich |
| 💨 | `airquality` | NABEL station network + Swiss legal limits (LRV) + live-data links | FOEN/Empa |
| ⚡ | `energy` | Electricity tariffs per municipality (component breakdown), tariff comparison, EV chargers | ElCom/LINDAS, SFOE |
| 💱 | `fx` | Official CHF exchange rates + history | Swiss National Bank |
| 🎉 | `holidays` | Public & school holidays, all 26 cantons | OpenHolidays |
| ♻️ | `waste` | Collection calendar by ZIP (Zürich region) | OpenERZ/ERZ |
| 📰 | `news` | Latest Swiss headlines + links (licence-aware: metadata only) | SRF RSS |
| 🕸️ | `lindas` | Read-only SPARQL on the federal knowledge graph — enrichment power tool | LINDAS |
| 🇨🇭 | `meta` | Licence register, live source health, capability overview | — |

## Setup

**Claude Desktop / Claude Code** (`claude_desktop_config.json` / `.mcp.json`):

```json
{
  "mcpServers": {
    "swissyphus": { "command": "npx", "args": ["-y", "swissyphus"] }
  }
}
```

**Claude Code one-liner:** `claude mcp add swissyphus -- npx -y swissyphus`
**Cursor / Windsurf / VS Code / Cline** — same three-line shape.

**One-click install (`.mcpb`):** Swissyphus also ships as an [MCP Bundle](https://github.com/anthropics/mcpb) — a single `.mcpb` file that hosts like Claude Desktop install (and keep updated) with one click, no JSON editing. Download `swissyphus.mcpb` from the [latest GitHub Release](https://github.com/cwellbournewood/swissyphus/releases/latest), or build it locally with:

```bash
npm run bundle        # → swissyphus.mcpb (build + manifest + mcpb pack)
```

then open `swissyphus.mcpb` in Claude Desktop. Pick the module preset (`full` by default, or `outdoor` / `business` / …) right in the install dialog. The bundle's [`manifest.json`](manifest.json) — all 71 tools and their descriptions — is generated from the same module registry that serves MCP (single source of truth), so it never drifts from the tools you actually get.

## REST API

The same 71 tools, over HTTP — generated from the same schemas (single source of truth):

```bash
swissyphus --http --port 8000     # or: docker run -p 8000:8000 ghcr.io/cwellbournewood/swissyphus
```

```text
GET  /v1/tools                                  tool catalogue
GET  /v1/tools/get_weather?plz=8001             invoke any tool with query params
POST /v1/tools/compare_electricity_tariffs     or with a JSON body
GET  /v1/sources                                licence & source register
GET  /v1/health/sources                         live upstream health
GET  /openapi.json                              OpenAPI 3.1, generated from the tool schemas
POST /mcp                                       remote MCP (Streamable HTTP, stateless)
```

Same envelope as MCP on every response. Errors are RFC 9457 `problem+json` (400 invalid params, 404 no results, 503 source down). CORS enabled, standard `RateLimit-*` headers on every response.

## API keys & tiers

The local server needs no key, ever. The hosted API is tiered — **all tiers are currently free of charge** (onboarding phase: metering on, billing off):

| Tier | Rate limit | Monthly quota | How to get it |
|---|---|---|---|
| Anonymous | 60 req/min per IP | — | just call it |
| **Free** | 240 req/min | 50'000 | `POST /v1/keys` with `{"email": "you@example.com"}` |
| **Pro** | 1'000 req/min | 1'000'000 | granted via admin (billing later) |
| **Enterprise** | unlimited | unlimited | talk to us (on-prem, SLA, DPA) |

```bash
curl -X POST https://your-host/v1/keys -d '{"email":"you@example.com"}'   # → sy_live_… (shown once)
curl -H "Authorization: Bearer sy_live_…" https://your-host/v1/tools/get_weather?plz=8001
curl -H "Authorization: Bearer sy_live_…" https://your-host/v1/usage      # your metered usage
curl -X DELETE -H "Authorization: Bearer sy_live_…" https://your-host/v1/keys   # permanent self-service erasure
```

Keys work on REST **and** `POST /mcp` (`Authorization: Bearer` / `X-API-Key` / `?api_key=`). Keys are stored server-side as a **SHA-256 hash only** — the raw key is returned once at creation and cannot be recovered afterwards. `DELETE /v1/keys` is a permanent hard delete of your key, email and usage history; `/v1/admin/revoke` is a soft revoke whose record is purged automatically after `SWISSYPHUS_REVOKED_RETENTION_DAYS` (default 30). See [`PRIVACY.md`](PRIVACY.md) / `GET /privacy` for what's collected and why.

Operators: set `ADMIN_TOKEN` (**≥ 32 characters**, e.g. `openssl rand -hex 32`; shorter values leave admin disabled) to enable `/v1/admin/*`. Admin endpoints create, promote, revoke and erase keys, and list usage. Admin auth uses a constant-time comparison, is rate-limited to 10 attempts/min/IP, never gets CORS headers, and logs lockouts and invalid attempts to stderr. Keys persist in `SWISSYPHUS_DATA_DIR` (Docker: mount `/app/data`) and are written atomically. If `keys.json` is ever unreadable, the server refuses to start rather than overwrite it (see [deploy/README.md](deploy/README.md#corrupt-keysjson)). For production, see [Deploying to production](#deploying-to-production).

**Compliance (Swiss nFADP):** [`PRIVACY.md`](PRIVACY.md) (duty to inform, data collected, retention, your rights), [`ROPA.md`](ROPA.md) (records of processing activities, Art. 12), [`BREACH_RESPONSE.md`](BREACH_RESPONSE.md) (breach detection & FDPIC notification process, Art. 24).

## Docker

```bash
docker pull ghcr.io/cwellbournewood/swissyphus:latest     # or build locally: docker build -t ghcr.io/cwellbournewood/swissyphus .

docker run -p 8000:8000 ghcr.io/cwellbournewood/swissyphus                      # HTTP: REST + remote MCP
docker run -i ghcr.io/cwellbournewood/swissyphus --stdio                        # MCP stdio mode
docker run -p 8000:8000 ghcr.io/cwellbournewood/swissyphus --http --preset business   # module filtering works too
docker run -p 8000:8000 -v swissyphus-data:/app/data -e ADMIN_TOKEN="$(openssl rand -hex 32)" \
  ghcr.io/cwellbournewood/swissyphus                                            # persist keys + enable admin
```

Every `v*` tag builds a multi-arch (`linux/amd64`/`linux/arm64`) image and publishes it to
`ghcr.io/cwellbournewood/swissyphus` as `:vX.Y.Z` and `:latest`. It is built by
`.github/workflows/release.yml`, which calls `docker-publish.yml`. You don't need a separate
registry account. The image is a multi-stage Alpine build (~180 MB) that runs as a non-root
user and has a built-in `HEALTHCHECK` against `/v1/health`. On SIGTERM it shuts down
gracefully: it drains requests, flushes usage and exits 0.

> These `docker run -p 8000:8000` examples expose the server **directly**, so do **not** set
> `SWISSYPHUS_TRUST_PROXY` with them. That would let any client spoof `X-Forwarded-For` and dodge
> the per-IP rate limits. Set it only behind a reverse proxy you control (next section).

## Deploying to production

The supported production setup is [`deploy/`](deploy/README.md). Docker Compose runs Caddy
(automatic Let's Encrypt TLS and security headers) in front of the GHCR image on one Swiss VPS,
for about CHF 5/month. That setup:

- sets `SWISSYPHUS_REQUIRE_TLS=1` together with `SWISSYPHUS_TRUST_PROXY=1`. HTTPS is detected
  from the proxy's `X-Forwarded-Proto`, so the server refuses to start with `REQUIRE_TLS` alone.
- rotates container logs at 10 MB × 5 files, which bounds how long logged IPs are kept (see
  [`PRIVACY.md`](PRIVACY.md)).
- documents a nightly `keys.json` backup, a restore procedure, an external uptime check, and
  upgrades via `docker compose pull`.

## Configuration (environment variables)

All variables are optional. HTTP-mode settings are read once at startup.

| Variable | Default | Applies to | Purpose |
|---|---|---|---|
| `PORT` (or `--port`) | `8000` | HTTP | Listen port. |
| `ADMIN_TOKEN` | *(unset → admin off)* | HTTP | Enables `/v1/admin/*`. Must have **≥ 32 characters**, otherwise admin stays disabled (403) and a warning is logged. Generate with `openssl rand -hex 32`. |
| `SWISSYPHUS_TRUST_PROXY` | off | HTTP | `1`/`true`: the server sits behind a reverse proxy that sets `X-Forwarded-For`/`X-Forwarded-Proto` (e.g. `deploy/Caddyfile`). The client IP is then taken from the **right-most** XFF hop. **Never set it when the port is directly exposed**, because clients could spoof their IP. |
| `SWISSYPHUS_REQUIRE_TLS` | off | HTTP | `1`/`true`: reject non-HTTPS requests (except `GET /v1/health`). **Requires `SWISSYPHUS_TRUST_PROXY=1`**, and the server refuses to start without it. |
| `SWISSYPHUS_DATA_DIR` | `./data` (Docker: `/app/data`) | HTTP | Where `keys.json` (key hashes, emails, usage) is stored. |
| `SWISSYPHUS_REVOKED_RETENTION_DAYS` | `30` | HTTP | Days before soft-revoked key records are purged. |
| `SWISSYPHUS_MAX_BODY_BYTES` | `1048576` (1 MiB) | HTTP | Max request body; larger → `413`. |
| `SWISSYPHUS_HEALTH_TTL_SECONDS` | `60` | both | Cache TTL for the source-health snapshot (`/v1/health/sources`, `check_source_health`). |
| `SWISSYPHUS_MAX_UPSTREAM_BYTES` | 25 MiB | both | Max response size read from any upstream source. |
| `SWISSYPHUS_CACHE_MAX_BYTES` | 64 MiB | both | Total byte budget of the in-memory response cache. |
| `SWISSYPHUS_CACHE_MAX_ENTRIES` | `5000` | both | Max number of cached responses. |
| `SWISSYPHUS_UPSTREAM_CONCURRENCY` | `8` | both | Max in-flight requests per upstream host. |
| `ZEFIX_USER` / `ZEFIX_PASS` | *(unset)* | both | Optional credentials for the official **ZefixPublicREST** API, issued by the Federal Office of Justice. Without them, the companies module uses the keyless fallback. See [`docs/outreach/`](docs/outreach/README.md). |

## Module filtering & presets

Context windows are money. Load only what you need:

```bash
npx swissyphus --preset outdoor              # snow, avalanche, trails, weather, alerts…
npx swissyphus --preset business             # companies, fx, law, energy, statistics…
npx swissyphus --modules transport,weather   # exactly these
npx swissyphus --preset legal --modules fx   # combinable
npx swissyphus --list-modules                # see everything
```

Presets: `minimal` · `commuter` · `outdoor` · `business` · `citizen` · `legal` · `compliance` · `full`

## Every response is attributable

```json
{
  "data": { "…": "…" },
  "source": {
    "name": "MeteoSwiss — Federal Office of Meteorology and Climatology",
    "operator": "MeteoSwiss",
    "url": "https://www.meteoswiss.admin.ch",
    "licence": "Swiss OGD — free use with attribution",
    "attribution": "© MeteoSwiss"
  },
  "retrieved_at": "2026-07-05T12:00:00Z",
  "data_as_of": "2026-07-05T11:50:00Z",
  "cache_status": "hit | miss | stale | computed",
  "language": "en"
}
```

The full licence register is one tool call away (`list_sources`) and exposed as the MCP resource `swissyphus://sources`.

## The doctor is in

```bash
npx swissyphus doctor    # pings all ~25 upstream sources, prints status + latency
```

Same check available to agents as `check_source_health` — when a source is down, the agent *sees* it instead of guessing.

## Coverage vs. mcp-swiss (prior art)

Swissyphus covers every mcp-swiss data domain and adds nine it doesn't have: **federal law (Fedlex), SOGC gazette, emergency alerts (Alertswiss), building register (GWR), national vote results, EV charging, live pollen, LINDAS SPARQL, coordinate conversion** — plus the attribution envelope, licence register, health checks, and per-leg transport details on every response. Known deltas the other way (documented, keyless sources don't exist): dam registry, live ASTRA traffic counts, companies-by-address, parliament speeches/interests/cantonal affairs, per-district Basel voting (we ship national instead, per RFP). Where mcp-swiss links out for air quality, so do we — NABEL publishes live values only on the BAFU site.

## Try asking

- **Outdoor** — "Ski tour near Davos: avalanche danger, snow depth, trail closures, weather warnings, and the train there."
- **Business** — "Due diligence on 'On AG': register entry, SOGC history, bankruptcy rubric check."
- **Citizen** — "Full report for Marktgasse 1, Bern: municipality, elevation, building record, solar potential, electricity tariff, next waste collection."
- **Legal/civic** — "Find the data protection act, confirm it's in force; how did the last federal vote go in Ticino?"
- **Energy** — "Compare electricity tariffs in Zürich, Baden and Bern, and find chargers near the station."

Three ship as MCP **Prompts**: `company_due_diligence`, `address_full_report`, `mountain_conditions`.

## Architecture

```
Swiss public sources (official-first, allowlisted hosts only — SSRF-safe)
        ↓
Connector modules (src/modules/*, one file per domain):
   manifest (licence, attribution, TTL) + typed tools + health probe
        ↓
Core (src/core/*): cached HTTP (stale-while-revalidate), response envelope,
   LV95/WGS84 conversion, Connector SDK types
        ↓
MCP server (stdio): tools + resources + prompts, module filtering
```

Adding a connector = one file exporting a `SwissyphusModule`. The machine-readable catalogue (`tools.schema.json`) is generated from the same Zod schemas that serve MCP — single source of truth.

## Development

```bash
npm install
npm run build         # strict TypeScript
npm test              # build + every offline suite (test/*.test.mjs, no network), as in CI
node --test test/unit.test.mjs   # run a single offline suite (after `npm run build`)
npm run test:live     # live MCP smoke test: ~70 tool calls against real sources (test/smoke.mjs)
npm run test:rest     # live REST + remote-MCP test (test/rest.mjs)
node dist/index.js doctor   # live upstream health
npm run catalogue     # regenerate tools.schema.json
npm run manifest      # regenerate the .mcpb manifest.json
npm run bundle        # build the installable swissyphus.mcpb
npm run inspect       # MCP Inspector
```

The live suites aren't run on PRs, because upstreams are flaky by nature. They run **nightly** in
[`.github/workflows/live-canary.yml`](.github/workflows/live-canary.yml), which opens or updates a
`live-canary` issue when something drifts.

**Project docs:** [`CHANGELOG.md`](CHANGELOG.md) (release notes) ·
[`docs/RELEASING.md`](docs/RELEASING.md) (release process) ·
[`BACKLOG.md`](BACKLOG.md) (go-live checklist) ·
[`docs/READINESS_REVIEW.md`](docs/READINESS_REVIEW.md) (go-live readiness review) ·
[`docs/SCALING.md`](docs/SCALING.md) (scaling & engineering backlog) ·
[`docs/outreach/`](docs/outreach/README.md) (licensing & data-access requests to upstream providers)

## Roadmap

**Next:** npm publish (claiming the name with 0.5.0, see [`BACKLOG.md`](BACKLOG.md) #7) · official ZefixPublicREST and MeteoSwiss OGD endpoints ([outreach](docs/outreach/README.md)) · metrics endpoint & per-source circuit breakers · SIMAP procurement · ASTRA live traffic (keyed) · FINMA registers · ESTV tax burden · cantonal GIS federation · multi-municipality waste calendars.

**Deferred on purpose:** OAuth on the remote MCP endpoint (post-1.0; API keys plus rate limits are the interim control, see [`BACKLOG.md`](BACKLOG.md) #5) · billing (off at launch, see #6) · Redis/Postgres multi-replica ([`docs/SCALING.md`](docs/SCALING.md)) · SDKs (the OpenAPI spec makes them generatable at any time).

**Shipped:** one-click `.mcpb` bundle (attached to every GitHub Release) · multi-arch GHCR image · tag-driven release automation · nightly live canary · hosted-API hardening (trusted-proxy IPs, body/upstream caps, atomic key store, graceful shutdown). See the [CHANGELOG](CHANGELOG.md).

## Licence

MIT for this software. **The data keeps its own licences** — every response tells you which one and what attribution it requires. Respect upstream fair-use limits; they are public infrastructure.
