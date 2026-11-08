# Changelog

All notable changes to Swissyphus are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Swissyphus follows
[semantic versioning](https://semver.org/spec/v2.0.0.html): see "Versioning and stability" in the
README for what counts as the public interface.

## [Unreleased]

## [1.0.1] - 2026-11-09

A housekeeping release. No tools, arguments or responses changed.

### Changed
- The repository, npm package, MCP Bundle and container image now ship only public-facing
  material. Internal planning and launch documents are no longer in the repository, and code
  comments no longer refer to them.
- API key messages and the source register's description are reworded. Rate limits are unchanged.
- `CHANGELOG.md` is condensed to user-facing changes.
- `PRIVACY.md`: the internal launch checklist is replaced by a "Running your own deployment"
  checklist for self-hosters. Nothing changed in what the hosted service processes or where.

### Fixed
- The release workflow's npm notice links to the Releases section of `CONTRIBUTING.md`; the page it
  used to link to no longer exists.

## [1.0.0] - 2026-11-08

The first public release: **the Swiss public-data rollup for AI agents.** 66 public sources in one
MCP server and REST API, 151 tools in 45 modules, zero API keys, and every answer cited down to
the exact upstream request.

### Every answer is cited
- One response envelope for every tool: the data, its `source` (publisher, URL, licence,
  attribution), `retrieved_at`, `data_as_of` (the publisher's own timestamp, or `null` when it
  publishes none), `cache_status`, and `provenance.upstream`, the exact upstream requests behind
  the answer, with credentials redacted.
- A licence register for all 66 sources (`list_sources`, `GET /v1/sources`). Sources that are
  non-commercial or need permission say so, and the `hosted` preset leaves out data whose terms do
  not allow public redistribution.

### Coverage
- **Mobility:** live timetable and departures, shared mobility, disruptions and real-time delays
  (optional key), SBB station ridership, punctuality and platforms, FEDRO road traffic counts,
  trail closures, postcodes.
- **Weather and environment:** MeteoSwiss forecasts, warnings, stations, history and pollen;
  FOEN rivers and lakes; SLF avalanche bulletin and snow stations; earthquakes; air quality;
  glaciers; dams; Alertswiss alerts.
- **Places and property:** geocoding, elevation, solar potential, ~900 federal map layers and
  location reports, building register, ÖREB parcel restrictions, electricity tariffs and EV
  chargers, the residential property price index, LV95 conversion, waste collection.
- **Business and compliance:** commercial register and SOGC gazette, UID register and VAT
  validation, SECO sanctions screening, simap.ch tenders and awards, court decisions, SNB exchange
  rates and data portal.
- **Law and politics:** federal law, consultations and Federal Gazette; parliament business,
  votes, speeches and interests; national vote results by canton; cantonal and municipal
  parliaments.
- **Statistics and catalogues:** opendata.swiss and EnviDat with queryable dataset contents, every
  BFS STAT-TAB table, LINDAS cubes and SPARQL, cantonal and SBB open-data portals, I14Y code
  lists, Wikidata.
- **Society:** FOPH disease surveillance, public and school holidays, SRF headlines, the
  swisscovery library catalogue.

### Discovery
- `find_data` searches every catalogue in parallel and returns the exact call that fetches the
  data; `find_tools`, `describe_tool` and `call_tool` reach all 151 tools.
- Topic presets, and a `discovery` preset that keeps 7 tools in context.

### Reliability
- Per-source caching with single-flight requests and per-host concurrency caps.
- Circuit breakers that back off on the first rate limit and honour `Retry-After`.
- Stale-if-error within per-source limits, and an optional on-disk last-known-good store that
  survives restarts.
- Per-call time budgets and response size caps.
- `swissyphus doctor`, `check_source_health` and a nightly live check of every source.

### Interfaces and distribution
- MCP over stdio (`npx -y swissyphus`), a one-click `.mcpb` bundle for Claude Desktop, and an
  entry in the official MCP Registry.
- REST API with an OpenAPI 3.1 spec (including the `Envelope` schema) and remote MCP over
  Streamable HTTP, with API keys, rate limits and metering.
- Multi-arch Docker image on GHCR and a production deployment with automatic TLS in `deploy/`.

### Security and privacy
- Allowlisted upstream hosts; catalogue resources fetched only through a DNS-pinned,
  public-address-only client; request and response size caps.
- API keys stored only as hashes; trusted-proxy handling of client IPs; graceful shutdown.
- Privacy notice, records of processing and breach-response procedure under the Swiss nFADP.

[Unreleased]: https://github.com/cwellbournewood/swissyphus/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/cwellbournewood/swissyphus/releases/tag/v1.0.0
