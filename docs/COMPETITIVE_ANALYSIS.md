# Gap analysis: Swissyphus vs mcp-swiss

> **Update 2026-11-08 — every gap in §2 "Where they lead" is closed.** Swissyphus now has
> 30 modules / 108 tools (mcp-swiss: 27 / 94), including discovery mode, SBB open data, MeteoSwiss
> OGD with pollen, real-estate indices, dams, traffic, OpenParlData parliament depth, building and
> map-layer search, and every smaller tool listed below. Where we went further: vote results per
> municipality for every canton (theirs: Basel-Stadt districts), SBB rail disruptions, cantonal
> committee meetings, waste calendars beyond Zürich, presets `mobility` / `property` / `science`.
> The remaining gap is **distribution** (§2, last table). The tables below are the original
> snapshot, kept for the record.

Snapshot taken on **2026-11-07** from the mcp-swiss README
([vikramgorla/mcp-swiss](https://github.com/vikramgorla/mcp-swiss)) and Swissyphus `0.5.0`
(`tools.schema.json`). mcp-swiss moves fast, so re-check before quoting any of this publicly.

> ⚠️ The "Coverage vs. mcp-swiss" section in our README was written against an older
> mcp-swiss. It is now **out of date and partly wrong**: mcp-swiss has since added pollen, the
> building register, dams, traffic, parliament speeches and cantonal affairs, and HTTP transport.
> That section has been rewritten from this analysis.

## 1. Headline numbers

| | **mcp-swiss** | **Swissyphus** |
|---|---|---|
| Version | v0.9.0 on npm | 0.5.0, **not yet on npm** |
| Repo | public | **private** (BACKLOG #0) |
| Downloads | ~5.1k/month | 0 |
| Stars | 25 | 0 (private) |
| Modules / tools | 27 / 94 | 25 / 71 → **30 / 108** (2026-11-08) |
| Transports | stdio, local Streamable HTTP | stdio, Streamable HTTP, **REST + OpenAPI 3.1**, hosted API with keys |
| Distribution | npm, `.mcpb`, Docker Hub + GHCR, MCP Registry, Awesome list, Glama, VS Code one-click | `.mcpb` and GHCR are built by CI but **nothing is published yet** |

**The honest read:** mcp-swiss is ahead on distribution, momentum and raw tool count. We are
ahead on *trust and depth*: attribution, licences, health, law/gazette/alerts, REST, privacy.
Today nobody can see that, because we are private and unpublished. **Distribution is our
biggest gap, not features.**

## 2. Feature-by-feature

### Where we lead (keep and shout about)

| Capability | Swissyphus | mcp-swiss |
|---|---|---|
| **Attribution envelope on every response** (source, operator, licence, attribution, `retrieved_at`, `data_as_of`, `cache_status`) | ✅ | ❌ not offered |
| **Licence register** (`list_sources`, `swissyphus://sources`) | ✅ | ❌ (README table only) |
| **Live source health** (`check_source_health`, `swissyphus doctor`) | ✅ | ❌ |
| **Nightly live canary** against real upstreams, auto-opening an issue on failure | ✅ | ❌ not visible |
| **Federal law (Fedlex)**: search, SR lookup, in-force status, all languages | ✅ | ❌ |
| **SOGC / SHAB gazette** (mutations, bankruptcies) | ✅ | ❌ |
| **Emergency alerts (Alertswiss)** | ✅ | ❌ |
| **National** popular-vote results with per-canton breakdown | ✅ | ⚠️ Basel-Stadt only |
| **Weather forecast (8-day) and official warnings** | ✅ | ⚠️ current conditions and history only |
| **Avalanche danger at any coordinate** | ✅ | ⚠️ by region or coordinate (roughly even) |
| **Elevation and elevation profiles** | ✅ | ❌ |
| **Coordinate conversion** LV95 ↔ WGS84 ↔ LV03, offline | ✅ | ❌ |
| **EV chargers nearby** (SFOE) | ✅ | ❌ |
| **LINDAS SPARQL** (federal knowledge graph) | ✅ | ❌ |
| **REST API + OpenAPI 3.1** generated from the same schemas | ✅ | ❌ |
| **Hosted, keyed, rate-limited API** with usage metering | ✅ (built, not deployed) | ❌ "does not deploy a hosted instance" |
| **MCP Prompts** (`company_due_diligence`, `address_full_report`, `mountain_conditions`) | ✅ | ❌ not advertised |
| **Swiss nFADP compliance docs** (privacy notice, ROPA, breach process) | ✅ | ❌ |
| Presets | 8 (incl. `legal`, `compliance`) | 6 |

### Where they lead (gaps to close)

| Gap | mcp-swiss has | Priority | Notes |
|---|---|---|---|
| **Discovery mode** (3 meta-tools, ~330 tokens instead of ~9'300) | ✅ | 🔴 High | Biggest *technical* gap. Context cost is the #1 complaint about large MCP servers, and our presets only partly answer it. |
| **SBB open data**: station punctuality, passengers, step-free access | ✅ | 🔴 High | Easy, official (data.sbb.ch), very demo-able ("Was Zürich HB punctual yesterday?"). |
| **opendata.swiss catalogue**: resources and download links | ✅ | 🟠 Med | We have `search_datasets` / `get_dataset`; add a resources/download-links tool. |
| **Building search by address / nearby** | ✅ | 🟠 Med | We only have `get_building` by EGID. Add `search_buildings` and `buildings_near`. |
| **Map layer search and attribute find** | ✅ | 🟠 Med | We have `identify_map_layers`; add layer search and find. |
| **Real estate**: property price index, rent index (BFS) | ✅ | 🟠 Med | Strong for business and real-estate audiences. |
| **MeteoSwiss OGD (STAC)** station data | ✅ | 🟠 Med | Already on our list (outreach #5, migrate `get_weather` to OGD). Doing it also removes our reliance on the app back-end. |
| **Parliament**: speeches, member interests, cantonal affairs, documents, committees (via OpenParlData.ch, CC BY 4.0) | ✅ | 🟠 Med | We listed these as "no keyless source". OpenParlData.ch is one. Re-evaluate. |
| **Dams registry** (SFOE) | ✅ | 🟢 Low | Via geo.admin. We listed it as unavailable; it isn't. |
| **ASTRA traffic counts** | ✅ | 🟢 Low | Same: available via geo.admin. |
| **Pollen daily and station list** | ✅ | 🟢 Low | We have `get_pollen`; add history and stations. |
| **Postcodes by canton**, `search_postcode` | ✅ | 🟢 Low | Small. |
| **Companies by locality** | ✅ | 🟢 Low | We listed "companies-by-address" as impossible; by-locality is doable. |
| **News keyword search** | ✅ | 🟢 Low | Only after SRF replies on hosted use. |
| **Waste calendar view** | ✅ | 🟢 Low | Small. |

### Distribution gaps (the real problem)

| Gap | Fix | Effort |
|---|---|---|
| Repo private | BACKLOG #0: make it public | minutes, owner |
| Not on npm | Tag `v0.5.0` → release workflow publishes (BACKLOG #7a) | small |
| No GitHub Release / `.mcpb` download | Same tag | automatic |
| Not in the **official MCP Registry** | Add `mcpName` to `package.json` + a `server.json`, publish with `mcp-publisher` (GitHub OIDC in CI) | small |
| Not on **Awesome MCP Servers** | PR to `punkpeye/awesome-mcp-servers` | small |
| Not on **Glama**, Smithery, PulseMCP, mcp.so | Submit the repo; Glama scores it and gives a badge | small |
| No **VS Code one-click** install | Add the `vscode:mcp/install` badge links (now in README) | done |
| No Docker Hub image | Optional. GHCR is enough. | — |
| No demo GIF / video | Record one multi-source prompt showing the attribution envelope | small |

## 3. How we make Swissyphus *much* better, not just equal

Matching their tool count is a treadmill. Win on things that are hard to copy:

1. **Be the one you can trust.** Push the envelope further, because it's our moat:
   - Show the source and licence **in the answer**: add a short `citation` string to every
     envelope that the model can paste verbatim (e.g. "Source: MeteoSwiss, 14:50, CC BY").
   - Publish a public **source status page** from the nightly canary (green/red per source, plus
     a live-canary badge in the README). "25 sources, checked every night" is something
     mcp-swiss can't show.
   - Every tool gets an "official / third-party" flag in `list_sources`.
2. **Answer questions, not endpoints.** mcp-swiss is 94 thin wrappers. Ship **composite tools**
   and prompts that do the multi-source work in one call: `address_report`,
   `company_due_diligence`, `mountain_conditions`, `commute_check` (connection + punctuality +
   weather at the destination). Fewer, smarter tools also cut context cost.
3. **Win the context-window fight.** Ship discovery mode (search → call), and go one step
   further: **intent presets** that load composite tools only. Publish the token cost per
   preset in the README the way they do, but lower.
4. **Own the depth domains they don't have:** law (Fedlex), the SOGC gazette, Alertswiss,
   national votes, forecasts and warnings, coordinates, LINDAS. Then add the big Swiss B2B
   sources on our roadmap: **SIMAP** public procurement, **FINMA** registers, **ESTV** tax
   burden, cantonal GIS. Those make Swissyphus the default for legal, compliance, fiduciary and
   real-estate work.
5. **Be the only one with a hosted endpoint.** A free remote MCP URL means no Node and no install:
   paste a URL into Claude, ChatGPT or any remote-MCP client. mcp-swiss explicitly doesn't host.
   This is the biggest single usability lead we can take.
6. **Four languages.** Respond in the user's language (de/fr/it/en) wherever upstreams allow,
   and make that a headline feature. It's very Swiss and rare among MCP servers.
7. **Data-provider relationships.** Finish the outreach (`docs/outreach/`). "Built with the
   blessing of SLF and the Federal Office of Justice" is a moat nobody can fork.

## 4. Proposed order

1. **Launch blockers (this week):** make the repo public → tag `v0.5.0` → npm, GHCR, `.mcpb`
   release → MCP Registry → Awesome list, Glama, Smithery → demo GIF.
2. **Close the cheap high-value gaps (0.6):** discovery mode, SBB open data (punctuality,
   passengers, accessibility), building search/nearby, opendata resources, map-layer search,
   dams, traffic.
3. **Pull ahead (0.7):** `citation` field, public status page, composite tools, MeteoSwiss OGD
   migration, real-estate indices, OpenParlData parliament depth.
4. **Moat (0.8+):** hosted remote MCP live, SIMAP, FINMA, ESTV, cantonal GIS, full
   multilingual output.

A fair README comparison table is a good idea, but keep it factual and dated. Competing on
"we credit every source" lands better than attacking another open-source maintainer.
