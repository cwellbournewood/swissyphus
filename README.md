# 🇨🇭 Swissyphus

[![npm](https://img.shields.io/npm/v/swissyphus.svg?style=flat-square&color=D52B1E)](https://www.npmjs.com/package/swissyphus)
[![CI](https://img.shields.io/github/actions/workflow/status/cwellbournewood/swissyphus/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/cwellbournewood/swissyphus/actions/workflows/ci.yml)
[![Live sources](https://img.shields.io/github/actions/workflow/status/cwellbournewood/swissyphus/live-canary.yml?branch=main&style=flat-square&label=live%20sources)](https://github.com/cwellbournewood/swissyphus/actions/workflows/live-canary.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-D52B1E?style=flat-square)](https://modelcontextprotocol.io)
[![Tools](https://img.shields.io/badge/tools-71-D52B1E?style=flat-square)](#modules-25)
[![API keys](https://img.shields.io/badge/API_keys-none-2ea44f?style=flat-square)](#setup)
[![Every response attributed](https://img.shields.io/badge/every_response-attributed-2ea44f?style=flat-square)](#every-response-is-attributable)
[![nFADP](https://img.shields.io/badge/privacy-Swiss_nFADP-555?style=flat-square)](PRIVACY.md)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Downloads](https://img.shields.io/npm/dm/swissyphus.svg?style=flat-square)](https://www.npmjs.com/package/swissyphus)
[![Stars](https://img.shields.io/github/stars/cwellbournewood/swissyphus?style=flat-square)](https://github.com/cwellbournewood/swissyphus)

[![Install in Claude Desktop](https://img.shields.io/badge/Claude_Desktop-One--click_install-D52B1E?style=flat-square&logo=anthropic&logoColor=white)](https://github.com/cwellbournewood/swissyphus/releases/latest/download/swissyphus.mcpb)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522swissyphus%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522swissyphus%2522%255D%257D)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/cwellbournewood/swissyphus/pkgs/container/swissyphus)
<!--
  Uncomment each badge only once the listing exists (see docs/COMPETITIVE_ANALYSIS.md §2):
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-io.github.cwellbournewood%2Fswissyphus-D52B1E?style=flat-square)](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.cwellbournewood/swissyphus)
[![Awesome MCP Servers](https://img.shields.io/badge/Awesome-MCP_Servers-fc60a8?style=flat-square&logo=awesomelists&logoColor=white)](https://github.com/punkpeye/awesome-mcp-servers)
[![Glama](https://glama.ai/mcp/servers/cwellbournewood/swissyphus/badges/score.svg)](https://glama.ai/mcp/servers/cwellbournewood/swissyphus)
-->

**The AI gateway to Switzerland.** Like Sisyphus, but the boulder is Swiss open data and we enjoy rolling it uphill — every day, from ~25 fragmented official sources, so your agent doesn't have to. One MCP server, 25 modules, 71 tools, zero API keys, source attribution and freshness metadata on **every** response.

```bash
npx swissyphus
```

That's the whole install. Under 60 seconds to first result, no signup, no keys.

> **Pre-release:** Swissyphus is not on npm yet, and there is no GitHub Release or public Docker image. Until 0.5.0 is published (see [`docs/RELEASING.md`](docs/RELEASING.md)), `npx swissyphus` fails. Use [Run from source](#run-from-source) instead.

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

### Run from source

This works today, before the npm release. You need Node.js 20 or newer.

```bash
git clone https://github.com/cwellbournewood/swissyphus.git
cd swissyphus
npm install
npm run build
node dist/index.js --version        # sanity check: prints the version
```

Register the build with Claude Code. Use the **absolute** path to `dist/index.js`.

```bash
# macOS / Linux / Git Bash
claude mcp add --scope user swissyphus -- node "$(pwd)/dist/index.js"

# Windows Command Prompt (cmd.exe does not expand $PWD or $(pwd))
claude mcp add --scope user swissyphus -- node "%CD%\dist\index.js"

# Windows PowerShell
claude mcp add --scope user swissyphus -- node "$PWD\dist\index.js"
```

Add `--preset outdoor` (or any [preset](#module-filtering--presets)) after the path to load fewer tools. Restart Claude Code and run `/mcp`. It should list `swissyphus` as connected. For Claude Desktop or other clients, use the JSON below with `"command": "node"` and `"args": ["/absolute/path/to/swissyphus/dist/index.js"]`.

**`CONNECTION_CLOSED` / "failed to reconnect"** means the server process exited before the MCP handshake. Check these:

- **An `npx` entry.** It fails until the npm release. Run `claude mcp get swissyphus` to see the saved command, then `claude mcp remove swissyphus` (add `--scope user` or `--scope local` if needed) and re-add it as above.
- **A literal `$PWD` in the saved path.** This happens when you run the bash form in `cmd.exe`.
- **Not built yet.** Run `npm run build`. Then `node <path>\dist\index.js` should print the Swissyphus banner and wait for input. Any error it prints is the real cause.
- **Node older than 20.** Check with `node --version`.

### After the npm release

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

**One-click install (`.mcpb`):** Swissyphus also ships as an [MCP Bundle](https://github.com/anthropics/mcpb) — a single `.mcpb` file that hosts like Claude Desktop install (and keep updated) with one click, no JSON editing. Download `swissyphus.mcpb` from the [latest GitHub Release](https://github.com/cwellbournewood/swissyphus/releases/latest) once one is published (there is none yet), or build it locally with:

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

Swissyphus is **free and open source**. The local server needs no key, ever. The hosted API is tiered for rate limits and quotas only — **every tier is free**:

| Tier | Rate limit | Monthly quota | How to get it |
|---|---|---|---|
| Anonymous | 60 req/min per IP | — | just call it |
| **Free** | 240 req/min | 50'000 | `POST /v1/keys` with `{"email": "you@example.com"}` |
| **Pro** | 1'000 req/min | 1'000'000 | granted via admin |
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

> No image has been published to GHCR yet. Until the first `v*` release tag, build it locally: `docker build -t ghcr.io/cwellbournewood/swissyphus .`

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

## How Swissyphus compares

[mcp-swiss](https://github.com/vikramgorla/mcp-swiss) is good prior art and covers many of the same
sources. Swissyphus focuses on **trust and depth**:

- **Attribution envelope on every response**: source, operator, licence, attribution and freshness,
  plus a machine-readable licence register (`list_sources`).
- **Live source health** (`check_source_health`, `swissyphus doctor`) and a nightly live canary.
- **Domains you won't find elsewhere:** federal law (Fedlex, in-force status), the SOGC gazette,
  Alertswiss emergency alerts, *national* vote results by canton, 8-day forecasts and official
  warnings, elevation profiles, LV95/WGS84 conversion, EV chargers and LINDAS SPARQL.
- **REST + OpenAPI 3.1 and a hosted, keyed API**, generated from the same schemas as MCP.
- **Swiss nFADP compliance** documentation from day one.

A dated, feature-by-feature gap analysis (including where mcp-swiss is ahead) lives in
[`docs/COMPETITIVE_ANALYSIS.md`](docs/COMPETITIVE_ANALYSIS.md).

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

**Deferred on purpose:** OAuth on the remote MCP endpoint (post-1.0; API keys plus rate limits are the interim control, see [`BACKLOG.md`](BACKLOG.md) #5) · Redis/Postgres multi-replica ([`docs/SCALING.md`](docs/SCALING.md)) · SDKs (the OpenAPI spec makes them generatable at any time).

**Shipped:** one-click `.mcpb` bundle (attached to every GitHub Release) · multi-arch GHCR image · tag-driven release automation · nightly live canary · hosted-API hardening (trusted-proxy IPs, body/upstream caps, atomic key store, graceful shutdown). See the [CHANGELOG](CHANGELOG.md).

## Licence

MIT for this software. **The data keeps its own licences** — every response tells you which one and what attribution it requires. Respect upstream fair-use limits; they are public infrastructure.
