# Changelog

All notable changes to Swissyphus are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) from 1.0.0. What counts as the public
interface is listed under "Versioning and stability" in the README.

The release workflow (`.github/workflows/release.yml`) copies the section whose heading matches
the pushed tag into the GitHub Release notes. See [`docs/RELEASING.md`](docs/RELEASING.md).

## [Unreleased]

## [1.0.0] - 2026-11-08

The first public release. Version 0.5.0 was prepared but never published, so its work ships here
as 1.0.0. From this release on, the public interface (tool names and parameters, the response
envelope, CLI flags, presets and the REST paths) follows semantic versioning: see "Versioning and
stability" in the README.

It combines five lines of work that were developed in parallel and merged for this release:

1. **Catalogue expansion** (45 modules / 151 tools, up from 25 / 71): 20 new modules, deeper
   politics, law, statistics and SNB coverage, and a discovery layer (`find_data`, `find_tools`,
   `describe_tool`, `call_tool`) that reaches every tool from a 7-tool context.
2. **Go-live hardening** (prepared on 2026-09-26): see the
   sections further down, which work through [`docs/READINESS_REVIEW.md`](docs/READINESS_REVIEW.md).
3. **Live-canary fixes** for upstream drift reported by the nightly canary (issue #9).
4. **Provenance on every answer**: request-level `provenance.upstream`, an honest
   `data_as_of`, and the response envelope documented in OpenAPI.
5. **Resilience and release polish** from the 2026-11 review ([`docs/REVIEW_2026-11.md`](docs/REVIEW_2026-11.md)):
   rate-limit-aware circuit breakers, per-source staleness windows, an on-disk last-known-good
   store, ZEFIX failover, a leaner `tools/list`, a `hosted` preset and MCP Registry metadata.

458 offline tests, up from 21 at 0.4.0.

### Added — new modules
- `portals`: Opendatasoft open-data portals (SBB, Basel-Stadt, Basel-Landschaft, St. Gallen,
  Stadt St. Gallen, Thurgau): `list_data_portals`, `search_portal_datasets`,
  `get_portal_dataset`, `query_portal_records` (ODSQL `where`, `near` geo filter).
- `mobility`: shared mobility (sharedmobility.ch REST API) and public-transport disruptions and
  real-time delays (opentransportdata.swiss): `get_shared_vehicles_nearby`,
  `list_shared_mobility_providers`, `get_transport_disruptions`, `get_realtime_delays`. The last
  two need the optional free `OPENTRANSPORTDATA_API_KEY`; without it they explain how to get one.
  The sharedmobility.ch GBFS feeds are not used: the 2.3 feed now requires an
  `Authorization: <email>` header. The Swiss Post portal planned for `portals` was dropped: Swiss
  Post discontinued it.
- `uid`: the federal UID register (SOAP): `lookup_uid`, `search_uid_register`,
  `validate_vat_number`.
- `courts`: Swiss court decisions (entscheidsuche.ch): `search_court_decisions`,
  `get_court_decision`.
- `wikidata`: enrichment from Wikidata: `search_wikidata`, `get_wikidata_entity`,
  `query_wikidata` (read-only SPARQL, LIMIT injected), `get_swiss_municipality_facts`.
- `bfs`: BFS STAT-TAB (PXWeb) tables: `search_bfs_tables`, `browse_bfs_tables`,
  `get_bfs_table_metadata`, `query_bfs_table`.
- `cubes`: LINDAS statistical cubes without writing SPARQL: `search_data_cubes`,
  `describe_data_cube`, `query_data_cube`.
- `geodata`: geo.admin.ch map layers and the STAC catalogue (incl. MeteoSwiss OGD):
  `search_map_layers`, `get_layer_info`, `query_layer_at_point`, `find_layer_features`,
  `get_layer_feature`, `get_location_report`, `search_geodata_collections`,
  `get_geodata_collection_items`, `read_geodata_asset`.

- `sanctions`: the Swiss consolidated sanctions list (SECO, ~9'000 entries, all embargo programmes),
  downloaded at most every 6 h and indexed in memory: `search_sanctions_list` (diacritic-insensitive,
  aliases and transliterations, de-listed entries on request), `get_sanctions_entry`,
  `list_sanctions_programs`.
- `procurement`: public tenders and awards from simap.ch: `search_public_tenders` (text, cantons,
  project/notice type, CPV, dates, cursor paging), `get_tender_details` (incl. award winner, price,
  number of offers), `search_cpv_codes`.
- `health`: FOPH infectious-disease dashboard (23 topics: influenza, COVID-19, RSV, wastewater,
  genomic surveillance, TBE, Lyme, food-borne, hepatitis, HIV/STIs): `list_disease_surveillance_topics`,
  `get_disease_surveillance` (region, period window, breakdowns).
- `localpolitics`: cantonal and municipal parliaments via OpenParlData.ch (CC BY 4.0):
  `search_local_parliaments`, `search_local_parliament_business`, `get_local_parliament_business`,
  `search_local_politicians`.
- `i14y`: the federal interoperability platform: `search_federal_metadata` (datasets, services,
  concepts), `lookup_code_list` (e.g. NOGA).
- `libraries`: swisscovery union catalogue (SRU/MARC21): `search_library_catalogue`.
- `glaciers`: GLAMOS glacier monitoring: `list_glaciers`, `get_glacier_changes` (length, mass
  balance, volume). Licence: scientific/non-commercial use.
- `cadastre`: ÖREB public-law restrictions per parcel by point or EGRID: `get_land_restrictions`
  (service URL from geo.admin.ch, cantonal extract fetched through the DNS-pinned public client).

### Added — existing modules
- `meta`: discovery layer. `find_data` searches every catalogue in parallel and answers within
  `SWISSYPHUS_FIND_DATA_MS` (default 8 s); `find_tools`, `describe_tool` and `call_tool` reach
  tools in modules that are not loaded (with `SWISSYPHUS_PROXY_ALL` or `--preset discovery`).
  New `discovery` preset (meta only).
- `statistics`: actual data access, not only metadata. `query_dataset`,
  `describe_dataset_columns` and `aggregate_dataset` fetch, parse (CSV / JSON / GeoJSON), filter,
  profile and aggregate the best resource of a dataset; `list_data_publishers`; the City of
  Zürich CKAN portal (`portal: "stadt-zuerich"`).
- `parliament`: `search_parliament_speeches`, `get_member_interests`,
  `list_parliament_committees`, `get_committee_members`, `list_parliamentary_groups`.
- `law`: `search_international_treaties`, `list_recent_legislation_changes`,
  `search_federal_gazette`.
- `energy`: `get_energy_dashboard` — SFOE energiedashboard.ch series (electricity production by
  source, consumption, estimate and forecast, cross-border electricity/gas flows, day-ahead spot
  price, gas net imports, EU gas storage) with week/month/year aggregation.
- `law`: `search_consultations` — federal consultation procedures (Vernehmlassungen) with status,
  period and lead office.
- `statistics`: EnviDat (WSL/ETH environmental research data) as a third CKAN portal
  (`portal: "envidat"`); `portals`: Open Data Graubünden.
- Presets: `business`, `citizen`, `legal`, `compliance` and `outdoor` include the new modules; new
  presets `politics`, `property`, `health` and `research`.
- `fx`: generic SNB data-portal access: `list_snb_datasets`, `get_snb_cube_dimensions`,
  `get_snb_data`.
- Core: per-call time budgets (`SWISSYPHUS_TOOL_BUDGET_MS`, default 30 s). Every upstream fetch
  gets min(its own timeout, time left), and retries only happen when there is time.
- Core: `fetchPublicResource()` for catalogue-derived URLs on arbitrary public hosts. The
  address is validated inside the socket's DNS lookup (no DNS-rebinding gap), only globally
  routable addresses pass, and every redirect hop is re-checked. Caller-supplied
  `resource_url` is off in `--http` mode unless `SWISSYPHUS_ALLOW_RESOURCE_URL=1`.
- Core: connector modules register their own hosts with `allowHosts()`; `*.opendatasoft.com`
  is allowlisted as a suffix.
- Core: upstream error bodies (ODSQL, SPARQL, OData, SOAP faults) are surfaced as a short,
  tag-stripped excerpt in the error message. Latin-1 / Windows-1252 bodies are decoded instead
  of mangled. `fetchCached(..., { retries: 0 })` disables the retry for fan-out searches.
- Start-up warm-up of the catalogue indexes (skip with `SWISSYPHUS_NO_WARM=1`);
  `SWISSYPHUS_DEBUG=1` traces every tool call and upstream request with timings.
- REST: `find_data` costs 5 rate-limit units per call (it fans out to ~15 upstreams).

### Changed
- Dependencies: **zod 4** (`^4.6.7`, fixes GHSA-mrhx-c7xc-m3w5) and
  `@modelcontextprotocol/sdk` `^1.32.2`; `zod-to-json-schema` is replaced by zod's built-in
  JSON Schema export. `npm audit --omit=dev` is clean. Tool input schemas in
  `tools.schema.json`, the OpenAPI spec and `describe_tool` are still draft-07; repeated
  definitions are now inlined instead of `$ref`-ed.
- Response cache default budget is 128 MiB (was 64 MiB) because catalogue adapters cache
  multi-MB files; `SWISSYPHUS_CACHE_MB` is accepted as an alias for
  `SWISSYPHUS_CACHE_MAX_BYTES`. A single body larger than half the budget is served but not
  cached.
- Timeout and network errors read "did not answer in time (timed out after N s)" and
  "Could not reach '<host>': source is unreachable (…)".

### Fixed — live canary (issue #9)
- **earthquakes:** all three tools failed with `ECONNREFUSED`. 0.5.0 moved the SED FDSN endpoint
  from `http://arclink.ethz.ch` to `https://arclink.ethz.ch`, but that host does not serve HTTPS.
  Queries now go to SED's EIDA node over HTTPS (`https://eida.ethz.ch/fdsnws/event/1/`) and fall
  back to the legacy `http://arclink.ethz.ch` endpoint on transport errors or 5xx responses. The
  endpoint that last answered is tried first. "No data" (204/404) answers are not retried.
- **energy:** `get_ev_chargers_nearby` failed for every query with
  `r.ChargingStationNames?.find is not a function`. Some SFOE OICP records carry
  `ChargingStationNames`, `Plugs` or `ChargingFacilities` as a single object or string instead of
  an array. Since 0.5.0 indexes the whole national dataset up front, one such record broke every
  lookup. Every list field is now normalised, values may be strings or numbers, a malformed record
  is skipped instead of failing the index, and an index with no stations at all is reported as an
  unavailable source (or the previous index is served stale), not as "no chargers nearby".
- **companies:** with the live ZEFIX legal-form list, labels lost the abbreviations people search
  for (`GmbH`, `AG`, …). Labels now keep every live `shortName` (e.g.
  `Limited liability company (GmbH/Sàrl/Sagl)`), fall back to the well-known abbreviation matched
  by name, then to the German name, in the same style as the built-in table.
- **hydrology / snow:** an empty station list from the upstream (seen from existenz.ch on
  2026-10-29) was cached for 24 h and reported as "no stations matching …". These reference lists
  are now validated before caching. An implausible answer is a transient `unavailable` error, and
  the last good copy is served stale when there is one.

- **statistics / voting:** opendata.swiss (CKAN) often takes 10–20 s to answer. The fixed 15 s
  timeout made `search_datasets`, `get_dataset`, `list_vote_dates` and `get_voting_results` fail
  whenever CKAN was slow. CKAN calls now get 25 s, and a vote-day package without resources is not
  cached.

### Added — fetch layer
- `fetchJson(url, { validate })`: a plausibility check on the parsed body. A failing body is not
  cached and triggers the stale-if-error fallback.

### Changed — live canary
- Live canary: a manual run on a non-default branch no longer comments on or closes the
  `live-canary` issue. It only reports through the run status and logs, so a fix can be verified
  against the live upstreams before it is merged.

### Infrastructure, rail and housing (2026-11-08)

#### Added — new modules
- `dams`: the SFOE register of dams under federal supervision (~225): `search_dams` (by dam,
  reservoir or facility name, purpose or type; ranked by height, volume, crest length or year
  built) and `get_dams_nearby` (exact distances).
- `traffic`: FEDRO road traffic counting stations on national and main roads (~340):
  `get_traffic_counts` (by station, road or canton; busiest or heaviest-goods ranking; daily,
  weekday, peak-hour and day/night figures) and `get_traffic_counts_nearby`.
- `sbb`: SBB station data from data.sbb.ch: `get_station_ridership` (daily passengers by year,
  with year-on-year change), `get_station_punctuality` (previous operating day: on-time shares,
  cancellations and the lines with the most delays) and `get_station_platforms` (platform
  lengths and access without crossing tracks). Close matches are suggested when a name is not
  exact.
- `realestate`: `get_property_price_index`, the FSO residential property price index (IMPI) for
  houses and apartments, with year-on-year and period change.
- One-click install buttons for VS Code in the README, and `llms-install.md` for AI-driven
  installers.

### Provenance and launch polish (2026-11-08)

#### Added
- **Request-level provenance on every answer.** Each response lists the exact upstream requests
  behind it under `provenance.upstream` (URL, method if not GET, cache status, fetch time),
  recorded per call by the fetch layer, so concurrent calls never mix and no module can opt out.
  In-memory indexes (sanctions, EV chargers, FOPH exports) record the download they were built
  from. Credentials never appear: URL user-info is dropped and secret-looking query values are
  redacted; header credentials are never recorded.
- OpenAPI: an `Envelope` schema for every tool's 200 response.
- `docs/TOOLS.md`, generated with `tools.schema.json` by `npm run catalogue` (CI checks both).
- Documentation split out of the README: `docs/INSTALL.md`, `docs/HOSTING.md`,
  `docs/ARCHITECTURE.md`; community files `CONTRIBUTING.md`,
  `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue and PR templates, Dependabot configuration,
  `glama.json`.
- Brand kit for the Carte Nationale identity (`docs/brand/`: the boulder-on-the-slope mark,
  Lake Deep / Contour / Glacier / Snowfield / Trail Marker palette, Archivo and IBM Plex Mono,
  voice, tokens, website copy) and assets (`assets/`: marks, app icon, README banners, social
  preview). The `.mcpb` bundle and the MCP Registry entry now carry the icon.
- A test that every source declares operator, URL, licence and attribution.

#### Changed
- **`data_as_of` is the publisher's own timestamp, or `null` when the source publishes none.** It
  previously fell back to the retrieval time, which made, for example, a forecast issued hours
  ago look new. `retrieved_at` still says when the data was fetched.
- Positioning: "the Swiss public-data rollup for AI agents" replaces "the AI gateway to
  Switzerland" in the package, bundle, server instructions, landing page and CLI banner, which
  now use the brand palette and mark. The Swiss cross and flag are not used as product marks.
- README rewritten: shorter, with a real response envelope.

#### Fixed
- The meta tools cited `https://github.com/swissyphus`, which does not exist, as their source URL.

### Resilience and release polish (2026-11-08)

#### Added
- **On-disk last-known-good store** (`SWISSYPHUS_LKG_DIR`, enabled in the Docker image under
  `/app/data/lkg`): successful responses survive restarts and deploys, so a source that is down
  right after a deploy is answered with clearly marked stale data instead of an error. Never
  stores credentialed requests; bounded by size and each source's max-stale window (#14).
- **Per-source max-stale windows** (`SourceManifest.maxStaleSeconds`), chosen from how fast the
  data goes stale (10 min for live departures, 30 min for alerts, ~400 days for annual population),
  replacing the global 24 × TTL factor (#14).
- **`hosted` preset**: every module whose data terms allow public redistribution. Leaves out
  `glaciers` (GLAMOS, non-commercial only), `libraries` (swisscovery), `procurement` (simap.ch)
  and `news` (SRF RSS) until the providers confirm. `deploy/docker-compose.yml` uses it.
- **Official MCP Registry** metadata: `server.json` (npm and OCI packages), `mcpName` in
  `package.json` and the ownership label on the image. The release workflow checks its versions
  against the tag and publishes it once the npm version exists.
- Modules can declare a background `warmUp()`, run once after the HTTP server starts (never in
  stdio mode).

#### Changed
- **Circuit breaker honours rate limits**: a 429 or any `Retry-After` opens the host's circuit at
  once for `max(Retry-After, cooldown)` instead of sending four more requests from the shared
  egress IP; repeated trips back off exponentially (30 s → 10 min). `circuit_open` errors carry
  `retryAfterMs` (#13).
- **Remote MCP `tools/list`** is served from a one-time snapshot: 11.7 → 3.95 ms per request,
  90 → 248 req/s under load (#15). stdio sessions now use the same snapshot.
- **Leaner `tools/list`**: the per-tool `$schema` URL (kept where draft-07 and 2020-12 differ) and
  the default `execution` block are dropped. The full list shrinks from 150 KB to 137 KB, about
  3k fewer tokens of context per session.
- `companies`: an outage of the official ZefixPublicREST (5xx, 429, timeout, garbled body) now
  fails over to the keyless ZefixREST back-end, not only a 401/403 (#16).
- Docker image, release and live canary run on **Node 24 LTS**; CI tests Node 20, 22 and 24.
  GitHub Actions (incl. the Docker actions) moved to their Node 24 majors.

#### Fixed
- `sanctions`: the first call after a start no longer waits for, and then times out on, SECO's
  43 MB list (3 s to first byte, 10–26 s download, no compression). In HTTP mode the index is
  loaded in the background at start-up, and the parsed index is snapshotted to the
  last-known-good store, so a restart answers in milliseconds. A list older than 3 days is never
  used for screening. This was the live canary's last failure (issue #11).

### Go-live hardening (prepared 2026-09-26)

This work goes through the gameplan in
[`docs/READINESS_REVIEW.md`](docs/READINESS_REVIEW.md). 135 offline tests, up from 21.

#### Breaking changes (0.x)
- Tool results are **compact JSON** (no indentation), to cut LLM token use. The fields are
  unchanged.
- `earthquakes`: `event_id` is the full SED `smi:` public ID, and the old short form is now
  `event_id_short`. Lookup accepts either form.
- `avalanche`: results are grouped as `bulletins` (each with its `regions[]` and a numeric
  1–5 danger level plus an elevation/time breakdown) instead of `regions`.
- REST: tool errors for input the tool rejects return `422`, not `404`. `404` is kept for real
  "no results" and `503` for upstream failures.

#### Security
- Client IP is taken from the TCP peer address by default. `X-Forwarded-For` (right-most hop)
  and `X-Forwarded-Proto` are honoured only when `SWISSYPHUS_TRUST_PROXY=1`. This closes the
  spoofing hole that let callers bypass the anonymous, signup and admin rate limits (S1).
- Request bodies are capped at `SWISSYPHUS_MAX_BODY_BYTES` (default 1 MiB): larger bodies get
  `413`, and slow bodies time out (S2).
- `keys.json` is written atomically (tmp file + fsync + rename). A corrupt store is moved to
  `keys.json.corrupt-<timestamp>` and the server refuses to start, instead of silently starting
  empty and overwriting every key. It keeps refusing on later restarts until the operator
  restores `keys.json` or deletes the `.corrupt` file (S3).
- Upstream redirects are re-checked against the host allowlist on every hop, and upstream
  response bodies are capped at `SWISSYPHUS_MAX_UPSTREAM_BYTES` (default 25 MiB) (S6).
- `ADMIN_TOKEN` must be at least 32 characters, otherwise `/v1/admin/*` stays disabled (S10).
- `SWISSYPHUS_REQUIRE_TLS=1` now requires `SWISSYPHUS_TRUST_PROXY=1`, and the server refuses to
  start otherwise, because HTTPS detection relies on the proxy's `X-Forwarded-Proto`.
- Dependencies: `@modelcontextprotocol/sdk` bumped to 1.30.x and `npm audit fix` applied. This
  clears 5 transitive advisories (2 high) in `ip-address`, `fast-uri`, `hono`,
  `@hono/node-server` and `qs` (S11).

#### Added
- `SWISSYPHUS_TRUST_PROXY`, `SWISSYPHUS_MAX_BODY_BYTES`, `SWISSYPHUS_HEALTH_TTL_SECONDS`,
  `SWISSYPHUS_MAX_UPSTREAM_BYTES`, `SWISSYPHUS_CACHE_MAX_BYTES`, `SWISSYPHUS_CACHE_MAX_ENTRIES`
  and `SWISSYPHUS_UPSTREAM_CONCURRENCY` environment variables. The full
  table is in the README.
- Upstream resilience:
  - **stale-if-error**: an old cached body, up to 24× TTL, is served with `cache_status: "stale"`
    and `stale_age_seconds` instead of an error;
  - a per-host **circuit breaker** (5 failures → 30 s fail-fast) and a per-host concurrency cap
    of 8;
  - true LRU caching, and parsed JSON reused across cache hits;
  - one retry with `Retry-After` support, and no retry of timed-out POST SPARQL queries.
- `fetchCached(..., { noStore })` for very large payloads that the caller indexes itself. The EV
  dataset uses it, so it no longer evicts the shared cache, and it keeps a per-station index
  with its own TTL and a stale fallback.
- `toolError(..., { kind })` (`invalid_input` / `not_found` / `unavailable`), which the REST
  layer uses to pick the HTTP status.
- `parliament`: `search_council_members` gains a working `party` filter.
- `law`: `get_law_by_sr` returns `other_acts` (for example repealed predecessors that share the
  SR number).
- Optional `ZEFIX_USER` / `ZEFIX_PASS` to use the official **ZefixPublicREST** API with
  credentials issued by the Federal Office of Justice. The keyless path remains the fallback.
- Offline `node:test` suites for the HTTP server (rate limits, XFF, body cap, CORS, auth,
  SIGTERM, key-store corruption), core HTTP/cache and modules. `npm test` runs every
  `test/*.test.mjs`.
- CI: production-dependency `npm audit` gate, `tools.schema.json` freshness check, and a Docker
  image build + boot check on every PR.
- Tag-driven **release workflow**. It checks the tag against the version, builds and tests,
  creates a GitHub Release with CHANGELOG notes and the `swissyphus.mcpb` bundle attached, and
  publishes the multi-arch GHCR image and (optionally) npm with provenance.
- Nightly **live canary** workflow. It runs `doctor`, the MCP smoke test and the REST test
  against the real upstreams, and opens or updates a `live-canary` issue on failure.
- Deployment: nightly `keys.json` backup, restore procedure, external uptime check and upgrade
  steps in `deploy/README.md`. Security headers (HSTS, CSP, nosniff…) in the Caddyfile.
- Licensing outreach drafts and tracker in `docs/outreach/` (ZEFIX, SLF, SRF, existenz.ch,
  MeteoSwiss).
- `docs/READINESS_REVIEW.md` (go-live review), `docs/RELEASING.md` (release runbook) and this
  changelog.

#### Changed
- Graceful shutdown: SIGTERM/SIGINT stop accepting connections, drain in-flight requests (≤ 10 s),
  flush usage and exit 0. Previously the process ignored SIGTERM until Docker's SIGKILL (S4).
- `/v1/health/sources` and `check_source_health` serve a cached snapshot
  (`SWISSYPHUS_HEALTH_TTL_SECONDS`, default 60 s) instead of probing ~25 upstreams on every call
  (S5).
- Concurrent identical cache misses are coalesced into one upstream request (single-flight), and
  the response cache is bounded by bytes (`SWISSYPHUS_CACHE_MAX_BYTES`, default 64 MiB) as well
  as by entries.
- CORS allows `Authorization`, `X-API-Key` and `DELETE`, and exposes the `RateLimit-*`,
  `X-Monthly-*` and `Mcp-Session-Id` headers, so browsers no longer need `?api_key=` (S7).
- Upstream "unrecognised format" errors (alerts, avalanche, holidays, snow, statistics) and
  unexpected parse failures now map to REST `503`, not `422`, and raw internal error messages are
  no longer exposed over REST. Background usage flushes log and retry on disk errors
  (ENOSPC/EACCES) instead of crashing the process.
- Metering counts only valid work: unknown tools, invalid parameters and MCP housekeeping
  messages are no longer billed against the monthly quota. On `/mcp`, only well-formed
  `tools/call` requests naming a real tool are billed (not ones the SDK rejects). Upstream timeouts map to `503`
  instead of `404` (S9).
- `news` returns headlines, links and publication times only. It no longer returns summaries.
- The User-Agent and version strings are derived from `package.json`, replacing the stale
  `swissyphus/0.1.0`.
- `deploy/docker-compose.yml` uses the GHCR image and sets `SWISSYPHUS_REQUIRE_TLS=1` and
  `SWISSYPHUS_TRUST_PROXY=1`. It adds log rotation (10 MB × 5), a health-gated `depends_on` and
  a 20 s stop grace period. **Upgrade note:** the data volume now has the fixed name
  `swissyphus-data`. Deployments created before 0.5.0 used `deploy_swissyphus-data`, so copy it
  across once (see `deploy/README.md` §6).
- The Docker image is published only by the release workflow (`workflow_call`). The
  `release: published` trigger is removed, because releases created by `GITHUB_TOKEN` never
  fired it.
- `backlog.md` was renamed to `docs/SCALING.md` to fix a case collision with `BACKLOG.md` on
  macOS/Windows.

#### Fixed
- **weather:** MeteoSwiss station GeoJSON is LV95, so coordinates are now converted, and
  `wgs84` and nearest-station sorting are correct.
- **geo:** solar `irradiation_kwh_m2_year` is per m² again. It previously used the whole-roof
  total.
- **companies:** legal-form labels match ZEFIX `legalFormId`s (previously every AG was
  mislabelled). Name lookups no longer silently take the first fuzzy hit.
- **law:** `get_law_by_sr` picks the current consolidation instead of merging every text that
  shares an SR number, so `in_force` is correct. Search is ordered and anchored.
- **holidays / waste:** "today" uses the Europe/Zurich date. Nationwide `is_today_holiday` no
  longer reports cantonal holidays.
- **voting:** `cantonal_majority` counts half-cantons.
- **weather history:** downsampling aggregates precipitation and sunshine totals instead of
  dropping points.
- **parliament:** searches are case-insensitive.
- **alerts:** fails loudly when the upstream shape changes, instead of reporting "no active
  alerts".
- **earthquakes:** instance IDs are no longer hard-coded; a missing magnitude or depth is `null`
  (was M0.0); `date_to` includes the whole day; `event_type` appears only when SED sends it; https.
- **avalanche:** handles SLF per-bulletin CAAML features; `region_count` counts regions; polygon
  holes are respected.
- **airquality:** the PM10 daily limit may be exceeded 3× per year (LRV). The response states
  that no live values are included.
- **lindas:** only a top-level `LIMIT` counts (a subquery `LIMIT` no longer bypasses the cap);
  max 200 rows; `SERVICE` federation and SPARQL Update are blocked outside literals; max 10,000
  characters.
- **energy:** EV chargers are grouped per station (not per connector) and parsed once per
  refresh; an unknown municipality is a tool error; the tariff comparison reports per-item
  errors.
- **hydrology:** wrong example station IDs are removed from the tool descriptions.
- **geo:** building lookups are sorted by real distance; municipality prefers the current
  boundary year.
- **companies:** accepts a UID with or without `CHE` (check digit validated); an upstream 404 is
  "not found", not "unavailable"; SOGC results are sorted newest first.
- **statistics:** fails loudly when PXWeb dimensions are missing; `organization.title` values
  that are JSON-encoded strings are decoded.
- **transport:** station searches are limited to stations (`type=station`); an empty arrivals
  board is an error, as for departures.
- **fx:** `null` rates are dropped; the history range is validated. **postcode:** handles
  `8001 - Zürich` labels. **buildings:** an unknown EGID is not-found, and all entrances are
  listed. **coords:** out-of-range input is rejected and swapped axes are detected.
  **snow:** keeps the latest reading per station.
  **alerts:** the region filter ignores accents and accepts names in DE/FR/IT/EN.
- Licence register: OpenHolidays is ODbL (share-alike). existenz.ch is credited as the delivery
  path for hydrology and weather history.

#### Documentation
- README: environment variable reference, GHCR image name, a new "Deploying to production"
  section, `SWISSYPHUS_TRUST_PROXY` guidance and corrected test commands.
- PRIVACY.md / ROPA.md: security-event IPs **are** kept on disk in rotated container logs (the
  earlier "never written to disk" claim was wrong). Backup retention is stated. Infomaniak is
  listed as the hosting processor.
- BACKLOG.md: OAuth deferred past 1.0 and billing off at launch, both recorded with triggers.
  The npm name is claimed with 0.5.0.

## [0.4.0] - 2026-07-11

First public baseline. It was never tagged, and it is the starting point for the 0.5.0 release
process.

### Added
- MCP server (stdio) with **25 modules / 71 tools** over Swiss public data: companies (ZEFIX,
  SOGC), transport, weather, hydrology, geo, coords, postcode, buildings, law, statistics,
  parliament, voting, alerts, avalanche, snow, trails, earthquakes, air quality, energy, fx,
  holidays, waste, news, LINDAS and meta.
- Attribution envelope on every response (`source`, `retrieved_at`, `data_as_of`,
  `cache_status`). Licence register via `list_sources` / `swissyphus://sources`.
- Module presets and filtering (`--preset`, `--modules`), and `swissyphus doctor`.
- REST API (`--http`) generated from the same schemas, with OpenAPI 3.1, remote MCP
  (`POST /mcp`), RFC 9457 errors and `RateLimit-*` headers.
- Tiered API keys (anonymous / free / pro / enterprise), stored as SHA-256 hashes, with metering
  on and billing off. Self-service erasure (`DELETE /v1/keys`) and admin endpoints.
- nFADP compliance docs: `PRIVACY.md`, `ROPA.md`, `BREACH_RESPONSE.md`.
- Docker image (multi-stage Alpine, non-root, healthcheck) and a single-VPS Caddy deployment in
  `deploy/`.
- One-click **`.mcpb` bundle** (`npm run bundle`) with a generated `manifest.json` (#3).
- GHCR publish workflow for the Docker image (#6).
- Offline unit test suite (`node:test`) and GitHub Actions CI on Node 20/22 (#1).
- `BACKLOG.md` go-live tracker (#4, #7) and scaling backlog (#5).

### Fixed
- Earthquake event-type fabrication, geo solar class 0, fx month-skip on days 29–31, EV-charger
  NaN guard, air-quality distance-sort gate, and parliament OData date timezone (#1).
- HTTP cache bounded at 5,000 entries, and the rate-limiter bucket clearing fixed (#1).

[Unreleased]: https://github.com/cwellbournewood/swissyphus/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/cwellbournewood/swissyphus/compare/ed57c5b...v1.0.0
[0.4.0]: https://github.com/cwellbournewood/swissyphus/tree/ed57c5b
