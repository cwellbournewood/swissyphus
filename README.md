<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.png">
    <img alt="Swissyphus: the Swiss public-data rollup for AI agents" src="assets/banner-light.png" width="760">
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/swissyphus"><img alt="npm" src="https://img.shields.io/npm/v/swissyphus?style=flat-square&color=D97B4F"></a>
  <a href="https://github.com/cwellbournewood/swissyphus/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/cwellbournewood/swissyphus/ci.yml?branch=main&style=flat-square&label=CI"></a>
  <a href="https://registry.modelcontextprotocol.io/v0/servers?search=io.github.cwellbournewood/swissyphus"><img alt="MCP Registry" src="https://img.shields.io/badge/MCP_Registry-swissyphus-123C4D?style=flat-square"></a>
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%E2%89%A520-123C4D?style=flat-square">
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/licence-MIT-123C4D?style=flat-square"></a>
</p>

<p align="center">
  <b>66 Swiss public sources, rolled into one MCP server and kept running.</b><br>
  151 tools · zero API keys · every answer cited, down to the exact upstream request.
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#ask-anything-swiss">Examples</a> ·
  <a href="#every-answer-is-cited">Provenance</a> ·
  <a href="#whats-inside">Coverage</a> ·
  <a href="docs/TOOLS.md">All 151 tools</a> ·
  <a href="docs/HOSTING.md">REST API</a>
</p>

---

## Install

<a href="https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522swissyphus%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522swissyphus%2522%255D%257D"><img alt="Install in VS Code" src="https://img.shields.io/badge/VS_Code-Install_Swissyphus-123C4D?style=flat-square&logo=visualstudiocode&logoColor=white"></a>
<a href="https://insiders.vscode.dev/redirect?url=vscode-insiders%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522swissyphus%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522swissyphus%2522%255D%257D"><img alt="Install in VS Code Insiders" src="https://img.shields.io/badge/VS_Code_Insiders-Install_Swissyphus-1F7A8C?style=flat-square&logo=visualstudiocode&logoColor=white"></a>
<a href="https://github.com/cwellbournewood/swissyphus/releases/latest"><img alt="Download for Claude Desktop" src="https://img.shields.io/badge/Claude_Desktop-Download_.mcpb-D97B4F?style=flat-square"></a>

**Claude Code**

```bash
claude mcp add --scope user swissyphus -- npx -y swissyphus
```

**Claude Desktop, Cursor, VS Code, Windsurf and any MCP client**

```json
{
  "mcpServers": {
    "swissyphus": { "command": "npx", "args": ["-y", "swissyphus"] }
  }
}
```

**One click for Claude Desktop:** download [`swissyphus.mcpb`](https://github.com/cwellbournewood/swissyphus/releases/latest) and open it.

**Docker**

```bash
docker run -i --rm ghcr.io/cwellbournewood/swissyphus --stdio
```

Node.js 20+. No signup, no keys. Presets, optional keys and troubleshooting: [`docs/INSTALL.md`](docs/INSTALL.md).

## Ask anything Swiss

> *Next train from Bern to Lugano, and is there snow in Zermatt?*
>
> *Who is Nestlé in the commercial register, and what did it publish in the SOGC this year?*
>
> *Screen "Rotenberg" against the Swiss sanctions list.*
>
> *What zoning and building restrictions apply to the parcel at this address?*
>
> *Is SR 235.1 still in force, and what changed recently?*
>
> *How did canton Ticino vote on June 14?*
>
> *Which school-building tenders were awarded in Zürich this month, and to whom?*
>
> *How is the flu developing in canton Bern, and what do the wastewater loads say?*
>
> *Find data on road noise in Aargau.*

Three ready-made MCP prompts: `company_due_diligence`, `address_full_report`, `mountain_conditions`.

## Every answer is cited

Every one of the 151 tools returns the same envelope. A real response:

```json
{
  "data": { "currency": "EUR", "rate_chf": 0.92841, "month": "2026-10" },
  "source": {
    "name": "SNB Data Portal — CHF exchange rates (monthly)",
    "operator": "Swiss National Bank",
    "url": "https://data.snb.ch",
    "licence": "SNB data portal terms — free use with attribution",
    "attribution": "© Swiss National Bank, data.snb.ch"
  },
  "retrieved_at": "2026-11-08T18:17:50.788Z",
  "data_as_of": "2026-10",
  "cache_status": "miss",
  "provenance": {
    "upstream": [
      { "url": "https://data.snb.ch/api/cube/devkum/data/json/en?fromDate=2026-08&toDate=2026-11",
        "cache_status": "miss", "retrieved_at": "2026-11-08T18:17:50.788Z" }
    ]
  }
}
```

- **`source`**: who publishes the data, under which licence, and the attribution to show.
- **`data_as_of`**: the publisher's own timestamp. `null` when it publishes none, never the
  fetch time in disguise. **`retrieved_at`** is when we fetched it.
- **`cache_status`**: fresh, cached, or `stale` with its age when a source is down.
- **`provenance.upstream`**: the exact requests behind this answer, so anyone can check it.
  Credentials are always redacted.

The licence register for all 66 sources is one call away: `list_sources`. How it works:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#provenance-every-answer-can-be-traced).

## Why Swissyphus

- **Answers you can cite and defend.** Provenance on every answer, a licence register, and a
  `hosted` preset that leaves out data whose terms forbid redistribution.
- **Catalogues, not just endpoints.** `find_data` searches opendata.swiss, ~900 federal map
  layers, every BFS table, the LINDAS cubes, cantonal and SBB portals, the SNB, I14Y and Wikidata
  at once, and returns the exact call that fetches the data. Agents can then filter and aggregate
  inside the datasets: 15'000+ of them.
- **Due diligence built in.** Sanctions screening (SECO), UID register and VAT validation, the
  commercial register and SOGC, court decisions, public tenders and federal law, in one server.
- **Small context when you want it.** `--preset discovery` keeps 7 tools in context and still
  reaches all 151.
- **Always running.** Caching, circuit breakers that back off on the first rate limit, the last
  good answer when a source is down (clearly marked), and a nightly canary against every live
  source.

## What's inside

| Area | Modules | Sources include |
|---|---|---|
| **Mobility** | transport · mobility · trails · postcode | Swiss timetable, opentransportdata.swiss, sharedmobility.ch, ASTRA, Swiss Post |
| **Weather & environment** | weather · hydrology · avalanche · snow · earthquakes · airquality · glaciers · alerts | MeteoSwiss, FOEN, SLF, SED/ETH, NABEL, GLAMOS, Alertswiss |
| **Places & property** | geo · geodata · coords · buildings · cadastre · energy · waste | swisstopo, geo.admin.ch (~900 layers + STAC), GWR, ÖREB cadastres, ElCom, SFOE, ERZ |
| **Business & compliance** | companies · uid · sanctions · procurement · courts · fx | ZEFIX, SOGC, UID register, SECO, simap.ch, entscheidsuche.ch, SNB |
| **Law & politics** | law · parliament · voting · localpolitics | Fedlex, Curia Vista, BFS vote results, OpenParlData.ch |
| **Statistics & catalogues** | statistics · bfs · cubes · portals · i14y · lindas · wikidata | opendata.swiss, EnviDat, BFS STAT-TAB, LINDAS, Opendatasoft portals, I14Y, Wikidata |
| **Society** | health · holidays · news · libraries | FOPH, OpenHolidays, SRF, swisscovery |
| **Discovery** | meta | `find_data`, `find_tools`, `describe_tool`, `call_tool`, `list_sources`, `check_source_health` |

Every tool, with its sources and licences: [`docs/TOOLS.md`](docs/TOOLS.md). Topic presets
(`outdoor`, `business`, `legal`, `compliance`, `property`, …): [`docs/INSTALL.md`](docs/INSTALL.md#presets-load-only-what-you-need).

## Self-host the REST API

```bash
docker run -p 8000:8000 ghcr.io/cwellbournewood/swissyphus
curl "localhost:8000/v1/tools/get_connections?from=Bern&to=Lugano"
```

The same tools over REST, an OpenAPI 3.1 spec and a remote MCP endpoint (`POST /mcp`), with API
keys, rate limits and metering. Production setup with automatic TLS in [`deploy/`](deploy/README.md).
Reference: [`docs/HOSTING.md`](docs/HOSTING.md).

## Documentation

- **[Install and configure](docs/INSTALL.md)**: every client, presets, optional keys, troubleshooting
- **[Tool catalogue](docs/TOOLS.md)**: all 151 tools by module, with their sources and licences
- **[How it works](docs/ARCHITECTURE.md)**: provenance, reliability, adding a source
- **[Self-hosting](docs/HOSTING.md)**: REST API, keys, Docker, configuration
- [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Privacy](PRIVACY.md)

## Versioning and stability

Swissyphus follows [semantic versioning](https://semver.org). The public interface (tool names
and parameters, the response envelope, CLI flags, presets, environment variables and REST paths)
changes incompatibly only in a new major version. Fields and optional parameters may be added in
minor versions. Upstream data and availability are outside the promise: if a source shuts down
for good, its tools keep their names and return an `unavailable` error that says why until the
next major version.

## Licence and data

Swissyphus is MIT-licensed. **The data keeps its own licences:** every response states which one
applies and how to credit it. Most sources are Swiss open government data (free use with
attribution); some are non-commercial or need permission for commercial use, and say so.

Swissyphus is an independent open-source project. It is not operated or endorsed by the Swiss
Confederation, any canton or any data provider. Please respect the publishers' fair-use limits:
they are public infrastructure.
