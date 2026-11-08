# 🇨🇭 Swissyphus

**The AI gateway to Switzerland.** Like Sisyphus, but the boulder is Swiss open data and we enjoy rolling it uphill — every day, from 50+ fragmented official sources and the federal data catalogues behind them, so your agent doesn't have to. One MCP server, 41 modules, 143 tools, **15'000+ queryable datasets, layers and tables**, zero API keys, source attribution and freshness metadata on **every** response.

```bash
npx swissyphus
```

That's the whole install. Under 60 seconds to first result, no signup, no keys.

> **Pre-release:** Swissyphus is not on npm yet, and there is no GitHub Release or public Docker image. Until 0.5.0 is published (see [`docs/RELEASING.md`](docs/RELEASING.md)), `npx swissyphus` fails. Use [Run from source](#run-from-source) instead.

---

## What can it answer?

> *"Next train Bern→Lugano, and is there snow in Zermatt?"* · *"Who is Nestlé in the commercial register, and what did they publish in the SOGC?"* · *"Avalanche danger at 46.8, 9.8?"* · *"Is SR 235.1 still in force?"* · *"Solar potential of this roof?"* · *"Electricity tariff in Baden vs Zürich?"* · *"How did Switzerland vote on June 14?"* · *"Any emergency alerts for Ticino right now?"* · *"EV chargers near Zürich HB?"* · *"When's the next cardboard collection in 8001?"* · *"Is this supplier on the Swiss sanctions list?"* · *"Which school-building tenders were awarded in Zürich this month, and to whom?"* · *"How is the flu developing in canton Bern?"* · *"What zoning applies to this parcel?"* · *"How much has the Rhone Glacier retreated?"* · *"What is the Basel city parliament debating about bikes?"*

## Coverage: catalogues, not just endpoints

Hand-written tools only scale so far. Swissyphus also plugs into the **catalogues and protocols** Swiss public data actually lives behind, and makes their *contents* queryable, not just their metadata:

| Catalogue | What becomes queryable | Tools |
|---|---|---|
| **opendata.swiss** + City of Zürich + **EnviDat** (CKAN) | 12'000+ federal, cantonal and municipal datasets plus WSL/ETH environmental research data: CSV/JSON/GeoJSON resources fetched, parsed, filtered, profiled and aggregated on the fly | `search_datasets` → `query_dataset` / `describe_dataset_columns` / `aggregate_dataset` |
| **geo.admin.ch** (~900 federal layers) + **STAC** | Every federal map layer (noise, radon, hazards, zoning, antennas, protected sites, …) by point/radius/bbox/attribute; STAC collections incl. **MeteoSwiss open data** station files | `search_map_layers`, `query_layer_at_point`, `find_layer_features`, `get_location_report`, `read_geodata_asset` |
| **BFS STAT-TAB** (PXWeb) | Every Federal Statistical Office table, for Switzerland, cantons and communes, as labelled rows | `search_bfs_tables` → `get_bfs_table_metadata` → `query_bfs_table` |
| **LINDAS cubes** (visualize.admin.ch) | Hundreds of statistical cubes from BFS, BAFU, BFE, ElCom, FOAG, ASTRA — no SPARQL needed | `search_data_cubes` → `describe_data_cube` → `query_data_cube` |
| **Opendatasoft portals** | SBB, Basel-Stadt, Basel-Landschaft, St. Gallen (canton & city), Graubünden, Thurgau — ODSQL filters, aggregations, radius search | `search_portal_datasets` → `query_portal_records` |
| **SNB data portal** | Any SNB cube: FX, interest rates, SARON, bond yields, balance sheet, monetary aggregates | `list_snb_datasets`, `get_snb_data` |
| **I14Y** (federal interoperability platform) | The national catalogue of government datasets/services and official code lists (NOGA, legal forms, eCH, health codes) | `search_federal_metadata`, `lookup_code_list` |
| **Wikidata** | The universal join key: Q-ids for every municipality, canton, mountain, company, institution; municipality facts by BFS number | `search_wikidata`, `get_swiss_municipality_facts`, `query_wikidata` |

### `find_data`: one question, every catalogue

```text
find_data {"query": "Strassenlärm"}
  → hits from geo.admin.ch, opendata.swiss, BFS, LINDAS, portals, SNB …
    each with `next: {tool, args}` — the exact call that fetches the data
```

With 100+ tools, context windows matter. The `discovery` preset loads only the meta module (7 tools) and still reaches everything: `find_data` searches all catalogues in parallel, `find_tools` searches every tool (loaded or not), `describe_tool` returns its schema, and `call_tool` invokes any tool by name with full validation.

```bash
npx swissyphus --preset discovery   # 7 tools in context, 143 reachable
```

`find_data` also understands the question: place names become a filter (`Aargau traffic` → topic *Verkehr*, place *AG*), common English topics map to the German catalogue terms, and asking for something Swissyphus doesn't connect (e.g. live road traffic) returns a `coverage_notes` answer with the nearest alternatives immediately — instead of an agent searching for minutes.

## Modules (41)

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
| ⚖️ | `law` | Classified Compilation search, SR lookup, in-force status, all languages · **consultations** (Vernehmlassungen) | Fedlex SPARQL |
| 📊 | `statistics` | 12'000+ OGD datasets + official population (CH + cantons) | opendata.swiss, BFS STAT-TAB |
| 🏛️ | `parliament` | Business search, members, **sessions**, **votes with real yes/no tallies** | Curia Vista |
| 🗳️ | `voting` | **National** popular-vote results, per-canton breakdown, all recent vote days | BFS vote-day OGD |
| 🚨 | `alerts` | Live official population warnings, all hazards | Alertswiss (FOCP) |
| 🏔️ | `avalanche` | Official bulletin, danger level at any coordinate | SLF |
| ❄️ | `snow` | Live snow depth, temperature, wind from 300+ alpine stations | SLF IMIS |
| 🥾 | `trails` | Official hiking-trail closures & detours near any point | ASTRA/SwitzerlandMobility |
| 🌍 | `earthquakes` | Recent + historical events, radius search, event details | SED/ETH Zürich |
| 💨 | `airquality` | NABEL station network + Swiss legal limits (LRV) + live-data links | FOEN/Empa |
| ⚡ | `energy` | Electricity tariffs per municipality (component breakdown), tariff comparison, EV chargers · **daily energy supply** (production by source, consumption, cross-border flows, spot price, gas storage) | ElCom/LINDAS, SFOE, energiedashboard.ch |
| 💱 | `fx` | Official CHF exchange rates + history | Swiss National Bank |
| 🎉 | `holidays` | Public & school holidays, all 26 cantons | OpenHolidays |
| ♻️ | `waste` | Collection calendar by ZIP (Zürich region) | OpenERZ/ERZ |
| 📰 | `news` | Latest Swiss headlines + links (licence-aware: metadata only) | SRF RSS |
| 🕸️ | `lindas` | Read-only SPARQL on the federal knowledge graph — enrichment power tool | LINDAS |
| 📊 | `statistics` ➕ | **Query dataset contents**: filter, profile, aggregate any CSV/JSON/GeoJSON resource; publishers; Stadt Zürich portal | opendata.swiss, data.stadt-zuerich.ch |
| 🧭 | `geodata` | All ~900 federal layers (search, metadata, point/radius/bbox identify, attribute search), **location report**, STAC catalogue + MeteoSwiss OGD files | geo.admin.ch, data.geo.admin.ch |
| 📈 | `bfs` | Every STAT-TAB table: search, browse, dimensions, labelled queries | BFS PXWeb |
| 🧊 | `cubes` | Search/describe/query LINDAS statistical cubes without SPARQL | LINDAS (cube.link) |
| 🗂️ | `portals` | SBB, Basel, St. Gallen, Graubünden, Thurgau open-data portals: search, schema, ODSQL records, radius search | Opendatasoft |
| 🛴 | `mobility` | Shared bikes/e-scooters/cars nearby with live availability; providers; **disruptions & realtime delays** (optional free key) | sharedmobility.ch (SFOE), opentransportdata.swiss |
| 🆔 | `uid` | UID register (all entities with a UID, not just the commercial register), VAT validation, offline check digit | BFS UID-WSE |
| 📜 | `courts` | Federal + cantonal court decisions: full-text search, decision text | entscheidsuche.ch |
| 🔗 | `wikidata` | Entity search/lookup, municipality facts by BFS number, read-only SPARQL | Wikidata (CC0) |
| 🏛️ | `parliament` ➕ | Also: **speeches**, **declared interests**, committees, parliamentary groups | Curia Vista |
| ⚖️ | `law` ➕ | Also: treaties, recent amendments / entries into force / repeals, Federal Gazette | Fedlex SPARQL |
| 💱 | `fx` ➕ | Also: any SNB data-portal cube | SNB |
| 🚫 | `sanctions` | Name screening against the Swiss consolidated sanctions list: individuals, entities, vessels; aliases, birth data, documents, listing history | SECO |
| 📑 | `procurement` | Public tenders and contract awards (federal, cantonal, municipal): search, deadlines, CPV codes, **award winner and price** | simap.ch |
| 🦠 | `health` | Infectious-disease surveillance: influenza, COVID-19, RSV, **wastewater virus loads**, TBE/Lyme, food-borne, hepatitis, HIV/STIs by canton | FOPH (IDD) |
| 🏘️ | `localpolitics` | Cantonal and municipal parliaments: business (motions, postulates, bills) and their status, politicians and parties | OpenParlData.ch |
| 🗂️ | `i14y` | Federal data catalogue (datasets, services, public services) and **official code lists** (NOGA, …) | I14Y (BFS) |
| 📚 | `libraries` | Union catalogue of ~490 Swiss academic libraries: books, theses, journals, maps, e-resources | swisscovery (SLSP) |
| 🧊 | `glaciers` | ~170 monitored glaciers: length change since the 1880s, mass balance, volume change | GLAMOS |
| 📜 | `cadastre` | Public-law restrictions on any parcel (zoning, building lines, noise levels, groundwater, contaminated sites) with legal provisions | ÖREB cadastres via geo.admin.ch |
| 🇨🇭 | `meta` | **find_data**, **find_tools**, describe_tool, **call_tool**; licence register, live source health, capability overview | — |

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

then open `swissyphus.mcpb` in Claude Desktop. Pick the module preset (`full` by default, or `outdoor` / `business` / …) right in the install dialog. The bundle's [`manifest.json`](manifest.json) — all 143 tools and their descriptions — is generated from the same module registry that serves MCP (single source of truth), so it never drifts from the tools you actually get.

## REST API

The same 143 tools, over HTTP — generated from the same schemas (single source of truth):

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
| `SWISSYPHUS_CACHE_MAX_BYTES` | 128 MiB | both | Total byte budget of the in-memory response cache. |
| `SWISSYPHUS_CACHE_MAX_ENTRIES` | `5000` | both | Max number of cached responses. |
| `SWISSYPHUS_UPSTREAM_CONCURRENCY` | `8` | both | Max in-flight requests per upstream host. |
| `SWISSYPHUS_LKG_DIR` | *(unset → off; Docker: `/app/data/lkg`)* | both | On-disk last-known-good copies of upstream responses. When a source fails and memory has nothing (e.g. right after a restart), the copy is served as `stale`, within the source's `maxStaleSeconds`. Never stores credentialed requests; files are named by hash, not URL. |
| `SWISSYPHUS_LKG_MAX_BYTES` | 64 MiB | both | Total size cap for the last-known-good store (oldest evicted first). |
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

Presets: `discovery` (meta only — reach everything via `find_data` / `call_tool`) · `minimal` · `commuter` · `outdoor` · `business` · `citizen` · `legal` · `compliance` · `politics` · `property` · `health` · `research` · `full`

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
npx swissyphus doctor    # pings all upstream sources, prints status + latency
```

Same check available to agents as `check_source_health` — when a source is down, the agent *sees* it instead of guessing.

## Coverage vs. mcp-swiss (prior art)

Swissyphus covers every mcp-swiss data domain and adds nine it doesn't have: **federal law (Fedlex), SOGC gazette, emergency alerts (Alertswiss), building register (GWR), national vote results, EV charging, live pollen, LINDAS SPARQL, coordinate conversion** — plus the attribution envelope, licence register, health checks, and per-leg transport details on every response. Since then Swissyphus also ships parliament speeches and declared interests, court decisions, the UID register and the catalogue connectors above. Known deltas the other way (documented, keyless sources don't exist): dam registry, live ASTRA traffic counts, companies-by-address, cantonal parliamentary affairs. Where mcp-swiss links out for air quality, so do we — NABEL publishes live values only on the BAFU site.

## Try asking

- **Outdoor** — "Ski tour near Davos: avalanche danger, snow depth, trail closures, weather warnings, and the train there."
- **Business** — "Due diligence on 'On AG': register entry, SOGC history, bankruptcy rubric check."
- **Citizen** — "Full report for Marktgasse 1, Bern: municipality, elevation, building record, solar potential, electricity tariff, next waste collection."
- **Legal/civic** — "Find the data protection act, confirm it's in force; how did the last federal vote go in Ticino?"
- **Energy** — "Compare electricity tariffs in Zürich, Baden and Bern, and find chargers near the station."

Three ship as MCP **Prompts**: `company_due_diligence`, `address_full_report`, `mountain_conditions`.

## Architecture

```
Swiss public sources (official-first, allowlisted hosts only — SSRF-safe;
   catalogue resources on other hosts via a DNS-checked, redirect-rechecked fetch)
        ↓
Connector modules (src/modules/*, one file per domain):
   manifest (licence, attribution, TTL) + typed tools + health probe
        ↓
Core (src/core/*): cached HTTP (stale-while-revalidate), response envelope,
   LV95/WGS84 conversion, Connector SDK types
        ↓
MCP server (stdio): tools + resources + prompts, module filtering
```

Adding a connector = one file exporting a `SwissyphusModule` that calls `allowHosts(...)` for its hosts (and `registerSearcher(...)` if it is a catalogue, so `find_data` sees it). The machine-readable catalogue (`tools.schema.json`) is generated from the same Zod schemas that serve MCP — single source of truth.

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

### Optional keys

Swissyphus stays zero-key. A few upstreams need a free key for extra depth; without it those tools return a clear "how to get a key" message:

| Env var | Unlocks | Get it |
|---|---|---|
| `OPENTRANSPORTDATA_API_KEY` | `get_transport_disruptions`, `get_realtime_delays` | free at opentransportdata.swiss |

Operator switches:

| Env var | Default | Effect |
|---|---|---|
| `SWISSYPHUS_TOOL_BUDGET_MS` | 30000 | Wall-clock ceiling per tool call: every upstream fetch inside gets min(own timeout, time left); retries only when there is time |
| `SWISSYPHUS_FIND_DATA_MS` | 8000 | `find_data` answers by then with what has arrived; slow catalogues finish in the background and are cached for the next query |
| `SWISSYPHUS_NO_WARM` | off | Skip the start-up warm-up of catalogue indexes (BFS table list, STAC collections, LINDAS cube index) |
| `SWISSYPHUS_DEBUG` | off | Log every tool call and upstream request with timings to stderr |
| `SWISSYPHUS_PROXY_ALL` | off (on with `--preset discovery`) | Let `call_tool` / `find_tools` reach modules that are not loaded. Off by default so a module selection is also a security boundary |
| `SWISSYPHUS_ALLOW_RESOURCE_URL` | on for stdio, **off for `--http`** | Allow caller-supplied `resource_url` on `query_dataset` & co. Catalogue resources (by dataset `id`) always work. Arbitrary URLs are fetched only via a DNS-pinned, public-address-only, redirect-rechecked client |
The live suites aren't run on PRs, because upstreams are flaky by nature. They run **nightly** in
[`.github/workflows/live-canary.yml`](.github/workflows/live-canary.yml), which opens or updates a
`live-canary` issue when something drifts.

**Project docs:** [`CHANGELOG.md`](CHANGELOG.md) (release notes) ·
[`docs/RELEASING.md`](docs/RELEASING.md) (release process) ·
[`BACKLOG.md`](BACKLOG.md) (go-live checklist) ·
[`docs/READINESS_REVIEW.md`](docs/READINESS_REVIEW.md) (go-live readiness review) ·
[`docs/REVIEW_2026-11.md`](docs/REVIEW_2026-11.md) (redundancy, licensing & modernisation review) ·
[`docs/SCALING.md`](docs/SCALING.md) (scaling & engineering backlog) ·
[`docs/outreach/`](docs/outreach/README.md) (licensing & data-access requests to upstream providers)

## Roadmap

**Next:** npm publish (claiming the name with 0.5.0, see [`BACKLOG.md`](BACKLOG.md) #7) · live verification of the catalogue connectors ([`docs/SCALING.md`](docs/SCALING.md) COV-1) · official ZefixPublicREST and MeteoSwiss OGD endpoints ([outreach](docs/outreach/README.md)) · metrics endpoint & per-source circuit breakers · SIMAP procurement · ASTRA live traffic (keyed) · FINMA registers · SECO sanctions list · ESTV tax burden · ÖREB cadastre extracts · more Opendatasoft/CKAN portals · offline snapshots (street directory, sanctions, UID) · cantonal GIS federation · multi-municipality waste calendars.

**Deferred on purpose:** OAuth on the remote MCP endpoint (post-1.0; API keys plus rate limits are the interim control, see [`BACKLOG.md`](BACKLOG.md) #5) · billing (off at launch, see #6) · Redis/Postgres multi-replica ([`docs/SCALING.md`](docs/SCALING.md)) · SDKs (the OpenAPI spec makes them generatable at any time).

**Shipped:** one-click `.mcpb` bundle (attached to every GitHub Release) · multi-arch GHCR image · tag-driven release automation · nightly live canary · hosted-API hardening (trusted-proxy IPs, body/upstream caps, atomic key store, graceful shutdown). See the [CHANGELOG](CHANGELOG.md).

## Licence

MIT for this software. **The data keeps its own licences** — every response tells you which one and what attribution it requires. Respect upstream fair-use limits; they are public infrastructure.
