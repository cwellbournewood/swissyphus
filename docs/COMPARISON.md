# How Swissyphus compares

There is more than one way to give an AI agent Swiss public data. This page says where Swissyphus
differs, as fairly as we can. It was checked against **mcp-swiss 0.9.0** (npm, published
2026-11-03), the other Swiss open-data MCP server, on **2026-11-08**. Both projects move fast;
if something here is out of date, please [open an issue](https://github.com/cwellbournewood/swissyphus/issues).

## In one line

mcp-swiss gives an agent Swiss data. Swissyphus gives it Swiss data it can cite, check and
defend: every answer carries its publisher, licence, the publisher's own timestamp and the exact
upstream requests behind it.

## What is different

| | Swissyphus 1.0 | mcp-swiss 0.9 |
|---|---|---|
| Tools / modules | 143 / 41 | 94 / 27 |
| API keys needed | None (one optional free key) | None |
| **Provenance on every answer** | Publisher, licence, attribution, `retrieved_at`, publisher timestamp (`data_as_of`), cache status and the exact upstream requests, on all 143 tools | A `source` label in some modules; no licence, timestamps or cache status in responses |
| **Licence register** | `list_sources`: 60 sources with operator, licence and attribution; non-commercial sources flagged; `hosted` preset excludes what may not be redistributed | Not published |
| **Data search across catalogues** | `find_data` searches opendata.swiss, ~900 geo.admin.ch layers, BFS STAT-TAB, LINDAS cubes, cantonal and SBB portals, SNB, I14Y and Wikidata in parallel, and returns the exact call that fetches the data | Tool search (`swiss_search_tools`), plus opendata.swiss and map-layer search tools |
| **Querying dataset contents** | Filter, profile and aggregate CSV / JSON / GeoJSON resources; query any BFS table or LINDAS cube without SPARQL | Dataset metadata and downloads |
| Small-context mode | `--preset discovery`: 7 tools reach all 143 | `--discovery` mode |
| Reliability | Per-host circuit breakers that back off on the first 429, stale-if-error within per-source limits, last-known-good store across restarts, nightly live canary, `doctor`, `check_source_health` | Caching and retries in parts of the code |
| REST API + OpenAPI + remote MCP | Yes, with API keys, rate limits, metering and privacy documentation (nFADP) | HTTP transport |
| Distribution | npm, `.mcpb`, Docker (GHCR), MCP Registry | npm, `.mcpb`, Docker Hub, MCP Registry, awesome-mcp-servers, Glama |

## Coverage

**Only in Swissyphus:** federal law and consultations (Fedlex), the SOGC gazette, Alertswiss
emergency alerts, national vote results by canton, the SECO sanctions list, simap.ch public
tenders and awards, court decisions, the UID register and VAT validation, ÖREB parcel
restrictions, FOPH disease surveillance, BFS STAT-TAB tables, LINDAS cubes and SPARQL, the
Opendatasoft portals (SBB, Basel, St. Gallen, Graubünden, Thurgau), shared mobility and transport
disruptions, Wikidata, I14Y code lists, swisscovery libraries, GLAMOS glaciers, the energy
dashboard, EV chargers, the full SNB data portal, and offline LV95 conversion.

**Only in mcp-swiss (dedicated tools):** the federal dam registry, ASTRA traffic counting
stations, real-estate price and rent indices, and SBB passenger, punctuality and step-free-access
data. Swissyphus reaches some of these generically (the SBB portal through
`query_portal_records`, BFS indices through `query_bfs_table`), but has no dedicated tools for
them.

**Both:** transport, weather and SwissMetNet, hydrology, geocoding and map layers, companies
(ZEFIX), holidays, parliament (federal and cantonal), avalanche and snow, air quality, postcodes,
electricity tariffs, BFS statistics, SNB exchange rates, Zürich waste collection, SRF headlines,
hiking-trail closures, earthquakes, pollen and the building register.

## Choosing

- If you need answers you will **show to someone else** (a report, a compliance check, a
  customer-facing assistant), the provenance envelope and licence register are the reason to
  pick Swissyphus.
- If you need **due diligence or compliance** (sanctions, UID/VAT, SOGC, courts, tenders, law),
  only Swissyphus covers it.
- If you need **dams, traffic counts or SBB operating statistics** as dedicated tools, mcp-swiss
  has them today.

Both are MIT-licensed and can run side by side.
