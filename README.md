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

**One-click install (`.mcpb`):** Swissyphus also ships as an [MCP Bundle](https://github.com/anthropics/mcpb) — a single `.mcpb` file that hosts like Claude Desktop install (and keep updated) with one click, no JSON editing. Build it locally with:

```bash
npm run bundle        # → swissyphus.mcpb (build + manifest + mcpb pack)
```

then open `swissyphus.mcpb` in Claude Desktop. Pick the module preset (`full` by default, or `outdoor` / `business` / …) right in the install dialog. The bundle's [`manifest.json`](manifest.json) — all 71 tools and their descriptions — is generated from the same module registry that serves MCP (single source of truth), so it never drifts from the tools you actually get.

## REST API

The same 71 tools, over HTTP — generated from the same schemas (single source of truth):

```bash
swissyphus --http --port 8000     # or: docker run -p 8000:8000 swissyphus/server
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

Operators: set `ADMIN_TOKEN` to enable `/v1/admin/*` (create/promote/revoke/erase keys, list usage) — admin auth uses a constant-time comparison, is rate-limited to 10 attempts/min/IP, never gets CORS headers, and logs lockouts/invalid attempts to stderr. Keys persist in `SWISSYPHUS_DATA_DIR` (Docker: mount `/app/data`). For production, set `SWISSYPHUS_REQUIRE_TLS=1` and put a TLS-terminating reverse proxy in front — the server itself speaks plain HTTP and rejects non-HTTPS traffic at the edge when this flag is set (health checks stay reachable for load-balancer probes).

**Compliance (Swiss nFADP):** [`PRIVACY.md`](PRIVACY.md) (duty to inform, data collected, retention, your rights), [`ROPA.md`](ROPA.md) (records of processing activities, Art. 12), [`BREACH_RESPONSE.md`](BREACH_RESPONSE.md) (breach detection & FDPIC notification process, Art. 24).

## Docker

```bash
docker build -t swissyphus/server .

docker run -p 8000:8000 swissyphus/server                      # HTTP: REST + remote MCP
docker run -i swissyphus/server --stdio                        # MCP stdio mode
docker run -p 8000:8000 swissyphus/server --http --preset business   # module filtering works too
```

Multi-stage Alpine image (~180 MB), non-root user, built-in `HEALTHCHECK` against `/v1/health`.

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
npm test              # offline unit tests (no network) — also runs in CI
node test/smoke.mjs   # live MCP test: 69 tool calls against real sources
node test/rest.mjs    # live REST + remote-MCP test: 17 endpoint checks
npm run catalogue     # regenerate tools.schema.json
npm run manifest      # regenerate the .mcpb manifest.json
npm run bundle        # build the installable swissyphus.mcpb
npm run inspect       # MCP Inspector
```

## Roadmap

SIMAP procurement · ASTRA live traffic (keyed) · FINMA registers · ESTV tax burden · cantonal GIS federation · multi-municipality waste calendars · OAuth on the remote MCP endpoint · npm + Docker Hub publish. (SDKs deliberately deferred until the REST API sees heavy use — the OpenAPI spec makes them generatable at any time.) **Shipped:** one-click `.mcpb` bundle.

## Licence

MIT for this software. **The data keeps its own licences** — every response tells you which one and what attribution it requires. Respect upstream fair-use limits; they are public infrastructure.
