# Changelog

All notable changes to Swissyphus are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is `0.x`, minor
versions may contain breaking changes. They are called out under **Changed** or **Removed**.

The release workflow (`.github/workflows/release.yml`) copies the section whose heading matches
the pushed tag into the GitHub Release notes. See [`docs/RELEASING.md`](docs/RELEASING.md).

## [Unreleased]

## [0.5.0] - 2026-09-26

The go-live hardening release. It works through the gameplan in
[`docs/READINESS_REVIEW.md`](docs/READINESS_REVIEW.md). 135 offline tests, up from 21.

### Breaking changes (0.x)
- Tool results are **compact JSON** (no indentation), to cut LLM token use. The fields are
  unchanged.
- `earthquakes`: `event_id` is the full SED `smi:` public ID, and the old short form is now
  `event_id_short`. Lookup accepts either form.
- `avalanche`: results are grouped as `bulletins` (each with its `regions[]` and a numeric
  1–5 danger level plus an elevation/time breakdown) instead of `regions`.
- REST: tool errors for input the tool rejects return `422`, not `404`. `404` is kept for real
  "no results" and `503` for upstream failures.

### Security
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

### Added
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

### Changed
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

### Fixed
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

### Documentation
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

[Unreleased]: https://github.com/cwellbournewood/swissyphus/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/cwellbournewood/swissyphus/compare/ed57c5b...v0.5.0
[0.4.0]: https://github.com/cwellbournewood/swissyphus/tree/ed57c5b
