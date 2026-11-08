# Announcement kit: Swissyphus 1.0.0

Ready-to-post copy for every launch channel. The order and timing are in
[`GO_LIVE.md`](GO_LIVE.md) §4. Post only after GO_LIVE §3 is green.

**Facts every piece of copy relies on** (re-check them if anything changes before launch):
41 modules · 143 tools · 50+ official sources · 15'000+ queryable datasets, layers and tables ·
zero API keys required · source, licence and freshness on every response · MIT ·
`npx -y swissyphus` · `--preset discovery` keeps 7 tools in context and reaches all 143 ·
independent project, not affiliated with the Swiss Confederation.

**Never claim:** "official", "government-backed", a hosted API, an SLA, or paid plans.

---

## 1. Launch post (blog, GitHub Discussions, newsletter)

**Title:** Swissyphus 1.0: Swiss public data for AI agents, with sources

Switzerland publishes an extraordinary amount of open data. Train departures, avalanche
bulletins, the commercial register, every federal law, parliament votes, river levels,
electricity tariffs for each municipality, sanctions lists, building records, 12'000 datasets
on opendata.swiss. Getting an AI agent to use it is another matter. It sits behind 50+
services with different APIs, formats, languages and licences, and most of the useful parts are
in German.

Swissyphus is an open-source MCP server that does that work. One command connects Claude,
Cursor or any MCP client to 143 tools across 41 modules:

```bash
claude mcp add --scope user swissyphus -- npx -y swissyphus
```

No signup, no API keys. Then ask the kind of question that used to take five tabs:

- *"Next train Bern to Lugano, and is there snow in Zermatt?"*
- *"Who is Nestlé in the commercial register, and what did they publish in the SOGC?"*
- *"What zoning applies to this parcel?"*
- *"Is this supplier on the Swiss sanctions list?"*
- *"How did Switzerland vote on June 14, canton by canton?"*

**Every answer says where it came from.** Each response carries the source, its operator, the
licence, the attribution it requires, when it was retrieved and how fresh the data is. If a
source is down, Swissyphus says so, or serves the last good answer clearly marked as stale. It
never makes up a result.

**Catalogues, not just endpoints.** Beyond the hand-built tools, Swissyphus reads the catalogues
Swiss data actually lives in: opendata.swiss, ~900 federal map layers on geo.admin.ch, every BFS
statistics table, the LINDAS statistical cubes, the cantonal and SBB open-data portals, the SNB
data portal and Wikidata. One tool, `find_data`, searches them all at once and returns the exact
call that fetches the data. With `--preset discovery`, an agent keeps only 7 tools in context
and still reaches all 143.

It is built to be a good citizen of public infrastructure: per-source caching, circuit breakers
that back off as soon as a source rate-limits, and a nightly canary that tests every source and
opens an issue when one drifts.

Swissyphus is MIT-licensed, runs locally over stdio, installs in one click in Claude Desktop
(`.mcpb`), and ships as a Docker image with a REST API and remote MCP endpoint for
self-hosting. It is an independent project: the data belongs to the federal, cantonal and
municipal services that publish it, and each response tells you their terms.

→ github.com/cwellbournewood/swissyphus

Like Sisyphus, but the boulder is Swiss open data, and we enjoy rolling it uphill.

---

## 2. Show HN

**Title** (80 chars max):

> Show HN: Swissyphus – 143 MCP tools for Swiss public data, no API keys

**URL:** `https://github.com/cwellbournewood/swissyphus`

**First comment** (post immediately):

> Hi HN. I built Swissyphus because Swiss open data is excellent but scattered: 50+ federal,
> cantonal and municipal services, each with its own API, format and licence, mostly documented
> in German. I wanted an agent to answer "next train to Lugano and is there snow in Zermatt" or
> "is this supplier sanctioned" without me wiring up each source.
>
> It's an MCP server (TypeScript, MIT). `npx -y swissyphus` and you get 143 tools: transport,
> MeteoSwiss, the commercial register and gazette, Fedlex law, parliament and votes, avalanche
> and snow, hydrology, the SECO sanctions list, simap.ch tenders, ÖREB parcel restrictions,
> disease surveillance and more. No keys.
>
> Things I cared about:
>
> - Provenance. Every response is an envelope with the source, licence, required attribution,
>   retrieval time and data freshness. Agents cite it; humans can check it.
> - Catalogues over endpoints. `find_data` searches opendata.swiss, ~900 geo.admin.ch layers,
>   BFS STAT-TAB, LINDAS cubes and several portals in parallel and returns the exact tool call
>   that fetches the data, so the agent queries the data itself, not just metadata.
> - Context cost. 143 tool definitions are ~34k tokens. `--preset discovery` exposes 7 tools
>   (`find_data`, `find_tools`, `describe_tool`, `call_tool`, …) and still reaches everything.
> - Being polite to public infrastructure: caching, single-flight requests, per-host circuit
>   breakers that open immediately on a 429, a last-known-good store, and a nightly canary
>   against every live source.
>
> It's independent and not affiliated with the Swiss government. Feedback on sources I've missed
> or got wrong is very welcome.

---

## 3. LinkedIn

**English**

> Switzerland publishes some of the best open data in the world, spread across 50+ services. 🇨🇭
>
> Today I'm releasing **Swissyphus 1.0**, an open-source MCP server that gives AI agents (Claude,
> Cursor, and any MCP client) one door to all of it: 143 tools over transport, weather,
> companies, law, parliament, votes, geodata, statistics, avalanche, sanctions, procurement and
> more.
>
> ✅ One command, no API keys: `npx -y swissyphus`
> ✅ Every answer cites its source, licence and freshness
> ✅ Searches opendata.swiss, geo.admin.ch, BFS, LINDAS and cantonal portals at once
>
> Thank you to the federal, cantonal and municipal teams who publish this data openly. It
> remains theirs; Swissyphus just makes it easier to use responsibly.
>
> Open source (MIT), independent project: github.com/cwellbournewood/swissyphus
>
> #OpenData #OGD #AI #MCP #Switzerland

**Deutsch**

> Die Schweiz veröffentlicht hervorragende offene Daten, verteilt auf über 50 Dienste. 🇨🇭
>
> Heute erscheint **Swissyphus 1.0**: ein Open-Source-MCP-Server, der KI-Agenten (Claude, Cursor und
> jedem MCP-Client) einen einzigen Zugang dazu gibt. 143 Tools für ÖV, Wetter, Handelsregister,
> Bundesrecht, Parlament, Abstimmungen, Geodaten, Statistik, Lawinen, Sanktionen,
> Beschaffungen und mehr.
>
> ✅ Ein Befehl, keine API-Schlüssel: `npx -y swissyphus`
> ✅ Jede Antwort nennt Quelle, Lizenz und Aktualität
> ✅ Durchsucht opendata.swiss, geo.admin.ch, BFS, LINDAS und kantonale Portale gleichzeitig
>
> Danke an alle Bundes-, Kantons- und Gemeindestellen, die diese Daten offen publizieren. Sie
> bleiben ihre Daten; Swissyphus macht sie nur einfacher und korrekt zitiert nutzbar.
>
> Open Source (MIT), unabhängiges Projekt: github.com/cwellbournewood/swissyphus
>
> #OpenData #OGD #KI #MCP #Schweiz

**Français** (short)

> **Swissyphus 1.0** est publié : un serveur MCP open source qui donne aux agents IA un accès unique
> aux données publiques suisses. 143 outils (transports, météo, registre du commerce, droit
> fédéral, Parlement, votations, géodonnées, statistique, avalanches, sanctions…), sans clé
> d'API, avec la source et la licence citées dans chaque réponse. `npx -y swissyphus`.
> Projet indépendant, licence MIT : github.com/cwellbournewood/swissyphus

---

## 4. X / Bluesky thread

1. Swiss open data is superb and scattered across 50+ services. Swissyphus puts all of it behind
   one MCP server: 143 tools, no API keys, sources cited on every answer.
   `npx -y swissyphus` 🇨🇭 github.com/cwellbournewood/swissyphus
2. Ask your agent: "Next train Bern→Lugano, and is there snow in Zermatt?" It checks the
   Swiss timetable, SLF snow stations and MeteoSwiss, and tells you which source said what.
3. Not just endpoints: `find_data` searches opendata.swiss, ~900 federal map layers, every BFS
   table, LINDAS cubes and cantonal portals in parallel, then returns the exact call that fetches
   the data.
4. 143 tools is a lot of context. `--preset discovery` loads 7 and still reaches all of them.
5. Polite to public infrastructure: caching, circuit breakers that back off on the first 429, a
   nightly canary against every source. MIT, independent, contributions welcome.

**Mastodon** (single post, 500 chars):

> Released: Swissyphus 1.0, an open-source MCP server for Swiss public data. 143 tools (SBB,
> MeteoSwiss, commercial register, Fedlex, parliament, votes, geo.admin.ch, BFS, avalanche,
> SECO sanctions, simap.ch…), zero API keys, and every answer carries its source, licence and
> freshness. One command: `npx -y swissyphus`. MIT, independent.
> github.com/cwellbournewood/swissyphus #OpenData #MCP #Switzerland

---

## 5. Reddit (r/mcp, r/ClaudeAI)

**Title:** I built an MCP server for Swiss public data: 143 tools, no API keys, sources on
every answer

> Swissyphus connects Claude (or any MCP client) to 50+ Swiss official data sources: public
> transport, MeteoSwiss, the commercial register, federal law, parliament votes, avalanche
> bulletins, the sanctions list, public tenders, parcel restrictions, BFS statistics and the
> opendata.swiss catalogue.
>
> Install: `claude mcp add --scope user swissyphus -- npx -y swissyphus` (or the one-click
> `.mcpb` for Claude Desktop from the Releases page).
>
> Two things that may be useful beyond Switzerland:
> - a `discovery` preset that exposes 7 meta tools (`find_data`, `find_tools`, `describe_tool`,
>   `call_tool`) instead of 143, to keep context small;
> - a response envelope with source, licence, attribution, `retrieved_at`, `data_as_of` and
>   `cache_status`, so the model can cite and you can verify.
>
> MIT: github.com/cwellbournewood/swissyphus. Happy to hear which sources are missing.

For **r/Switzerland**, check the self-promotion rules first, lead with the Swiss angle (e.g.
"ask about avalanche danger, train times and the commercial register in one place"), and keep
it short.

---

## 6. Directory listings

**awesome-mcp-servers** (one line, in the alphabetical position of the relevant category, e.g.
"Data Platforms" or "Other"):

```markdown
- [cwellbournewood/swissyphus](https://github.com/cwellbournewood/swissyphus) 📇 ☁️ 🏠 - Swiss public data: 143 tools over 50+ official sources (SBB, MeteoSwiss, ZEFIX, Fedlex, geo.admin.ch, BFS, SECO sanctions). Zero API keys, sources cited on every response.
```

(Check the list's current legend before submitting: the emoji usually mean TypeScript, cloud
and local.)

**mcp.so / Smithery / PulseMCP / Glama** short description (≤ 160 chars):

> Swiss public data for AI agents: 143 tools over 50+ official sources. Zero API keys, source
> and licence on every response.

The **official MCP Registry** entry is published automatically by the release workflow as
`io.github.cwellbournewood/swissyphus`.

---

## 7. Courtesy note to data publishers (T+1 week)

To the open-data teams of opendata.swiss, BFS and swisstopo (via their public contact
channels). This is a thank-you and a heads-up, not a permission request; licence questions go
through [`docs/outreach/`](../outreach/README.md).

> **Subject:** An open-source tool that makes your open data usable by AI agents
>
> Hello,
>
> I maintain Swissyphus, an open-source (MIT) MCP server that lets AI assistants such as Claude
> query Swiss public data. It uses [your service] among 50+ official sources.
>
> Every response names your organisation as the source, states the licence and attribution you
> require, and shows when the data was retrieved. Requests are cached and rate-limit aware, and
> we back off immediately when a service signals overload.
>
> If you would like the attribution worded differently, prefer we use another endpoint, or have
> any concern about how we access the service, please tell me and I will change it.
>
> Thank you for publishing this data openly.
>
> Kind regards,
> [name] · github.com/cwellbournewood/swissyphus

---

## 8. 60-second demo script

For a screen recording (Claude Desktop or Claude Code, `full` preset). Rehearse once so caches
are warm.

1. *"Next train from Bern to Lugano, and is there snow in Zermatt right now?"* Shows: timetable
   + SLF snow + attribution.
2. *"Who is Nestlé S.A. in the commercial register, and what have they published in the SOGC
   recently?"* Shows: ZEFIX + gazette.
3. *"What's the avalanche danger at 46.8, 9.8?"* Shows: coordinate lookup into the SLF
   bulletin.
4. *"Find data on road noise in canton Aargau."* Shows: `find_data` across catalogues, then the
   follow-up call.
5. Point at a response envelope: source, licence, `retrieved_at`, `data_as_of`.

---

## 9. Replies to likely questions

| Question | Answer |
|---|---|
| Is this official? | No. It's an independent open-source project. The data comes from official public services, and each response names them and their licence. |
| Is it legal to use the data? | Each source has its own terms, and every response states them. Most are Swiss OGD (free use with attribution); some are non-commercial or need permission for commercial use, and those are flagged. Using Swissyphus locally is like calling the services yourself. |
| Do I need API keys? | No. One optional free key (opentransportdata.swiss) adds transport disruptions and real-time delays. |
| Is there a hosted version? | Not yet. You can self-host the Docker image, which serves a REST API and a remote MCP endpoint. |
| 143 tools will eat my context. | Use `--preset discovery` (7 tools, reaches everything) or a topical preset such as `outdoor` or `business`. |
| How do you avoid hammering public services? | Per-source caching, coalesced requests, per-host concurrency caps, circuit breakers that open on the first 429 and honour `Retry-After`, and a nightly canary. |
| Why not mcp-swiss? | It's good prior art. Swissyphus covers its domains and adds law, gazette, alerts, building register, votes, sanctions, procurement, catalogue querying and the attribution envelope. The README has the comparison. |
| Can I add a source? | Yes. Open an issue with the source, or a PR: each module is one file with its source manifest, tools and tests. |
