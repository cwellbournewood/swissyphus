# Announcement kit: Swissyphus 1.0

Ready-to-post copy for every launch channel. The order and timing are in
[`GO_LIVE.md`](GO_LIVE.md) §4; directory listings are in [`LISTINGS.md`](LISTINGS.md). Brand
rules: [`docs/brand/BRAND.md`](../brand/BRAND.md). Post only after GO_LIVE §3 is green.

**Facts every piece of copy relies on** (re-derive per BRAND.md if anything changes):
60 public sources · 143 tools · 41 modules · 15'000+ datasets, layers and tables · zero API
keys · every answer carries publisher, licence, the publisher's timestamp and the exact upstream
requests · `npx -y swissyphus` · `--preset discovery` keeps 7 tools in context · MIT ·
independent, not affiliated with the Swiss Confederation.

**Lead with:** cited answers. **Never claim:** "official", "government-backed", a hosted API, an
SLA or paid plans.

**Attach:** `assets/social-preview.png` to every post that takes an image.

---

## 1. Launch post (blog, GitHub Discussions, newsletter)

**Title:** Swissyphus 1.0: Swiss public data your AI agent can cite

Switzerland publishes remarkable public data: timetables, avalanche bulletins, the commercial
register, every federal law, parliament votes, river levels, electricity tariffs for each
municipality, the sanctions list, parcel restrictions, 12'000 datasets on opendata.swiss. For an
AI agent it is out of reach. It sits behind 60 services with different APIs, formats, languages
and licences.

**Swissyphus rolls all of it up into one MCP server, and keeps it running.** One command
connects Claude, Cursor or any MCP client to 143 tools:

```bash
claude mcp add --scope user swissyphus -- npx -y swissyphus
```

No signup, no API keys. Then ask:

- *"Next train from Bern to Lugano, and is there snow in Zermatt?"*
- *"Who is Nestlé in the commercial register, and what did it publish in the SOGC?"*
- *"Screen 'Rotenberg' against the Swiss sanctions list."*
- *"What restrictions apply to the parcel at this address?"*
- *"How did Ticino vote on June 14?"*

### Every answer is cited

An answer is only useful if you can trust it, so every one of the 143 tools returns the same
envelope: the data; who publishes it, under which licence, and the attribution to show; the
publisher's own timestamp (not when we fetched it); whether it came fresh, from cache or as a
clearly marked fallback; and **the exact upstream requests** that produced it. Anyone can re-run
them and check.

### Catalogues, not just endpoints

`find_data` searches opendata.swiss, ~900 federal map layers, every BFS table, the LINDAS
statistical cubes, cantonal and SBB portals, the SNB, I14Y and Wikidata in parallel, and returns
the exact call that fetches the data. Agents then filter and aggregate inside the datasets. With
`--preset discovery` they keep only 7 tools in context and still reach all 143.

### Always running

Public infrastructure goes down and rate-limits. Swissyphus caches, coalesces requests, backs
off the moment a source asks, serves the last good answer (marked with its age) when one is
down, and tests every live source every night.

Swissyphus is MIT-licensed, installs in one click in Claude Desktop, and ships as a Docker image
with a REST API and remote MCP endpoint for self-hosting. It is an independent project: the data
belongs to the federal, cantonal and municipal services that publish it, and every answer says so.

→ github.com/cwellbournewood/swissyphus

---

## 2. Show HN

**Title** (≤ 80 chars):

> Show HN: Swissyphus – Swiss public data for AI agents, with every answer cited

**URL:** `https://github.com/cwellbournewood/swissyphus`

**First comment** (post immediately):

> Hi HN. Swiss public data is excellent but scattered across 60 services, each with its own
> API, format and licence, mostly documented in German. I wanted an agent to answer "next train
> to Lugano and is there snow in Zermatt" or "is this supplier sanctioned", and to be able to
> show where every number came from.
>
> Swissyphus is an MCP server (TypeScript, MIT). `npx -y swissyphus` gives you 143 tools:
> transport, MeteoSwiss, the commercial register and gazette, Fedlex, parliament and votes,
> avalanche and snow, the SECO sanctions list, simap.ch tenders, ÖREB parcel restrictions,
> disease surveillance and more. No keys.
>
> What I cared about:
>
> - Provenance. Every response is an envelope: publisher, licence, attribution, the publisher's
>   own timestamp (null if they don't publish one, rather than faking it with the fetch time),
>   cache status, and the exact upstream requests behind the answer, recorded per call.
> - Catalogues over endpoints. `find_data` fans out to opendata.swiss, ~900 geo.admin.ch layers,
>   BFS STAT-TAB, LINDAS cubes and several portals, and returns the exact tool call that fetches
>   the data, so the agent queries contents, not just metadata.
> - Context cost. 143 tool definitions are ~34k tokens. `--preset discovery` exposes 7 tools and
>   still reaches everything.
> - Being polite to public infrastructure: caching, single-flight requests, per-host circuit
>   breakers that open on the first 429, a last-known-good store that survives restarts, and a
>   nightly canary against every live source.
>
> It's independent and not affiliated with the Swiss government. I'd love to hear about sources
> I've missed or got wrong.

---

## 3. LinkedIn

**English**

> Swiss public data, rolled up for AI agents. 🇨🇭
>
> Today I'm releasing **Swissyphus 1.0**: an open-source MCP server that connects Claude,
> Cursor and any MCP client to 60 Swiss public data sources through 143 tools. Transport,
> weather, companies, law, parliament, votes, geodata, statistics, avalanche, sanctions, public
> tenders and more.
>
> ✅ Every answer is cited: publisher, licence, the publisher's timestamp and the exact request
> behind it
> ✅ One command, no API keys: `npx -y swissyphus`
> ✅ Searches opendata.swiss, geo.admin.ch, BFS, LINDAS and cantonal portals at once
>
> Thank you to the federal, cantonal and municipal teams who publish this data openly. It stays
> theirs; Swissyphus makes it easier to use, and to credit.
>
> Open source (MIT), independent project: github.com/cwellbournewood/swissyphus
>
> #OpenData #OGD #AI #MCP #Switzerland

**Deutsch**

> Öffentliche Schweizer Daten, gebündelt für KI-Agenten. 🇨🇭
>
> Heute erscheint **Swissyphus 1.0**: ein Open-Source-MCP-Server, der Claude, Cursor und jeden
> MCP-Client mit 60 öffentlichen Schweizer Datenquellen verbindet. 143 Tools für ÖV, Wetter,
> Handelsregister, Bundesrecht, Parlament, Abstimmungen, Geodaten, Statistik, Lawinen,
> Sanktionen, Beschaffungen und mehr.
>
> ✅ Jede Antwort mit Quelle: Herausgeber, Lizenz, Stand der Daten und die genaue Abfrage dahinter
> ✅ Ein Befehl, keine API-Schlüssel: `npx -y swissyphus`
> ✅ Durchsucht opendata.swiss, geo.admin.ch, BFS, LINDAS und kantonale Portale gleichzeitig
>
> Danke an alle Stellen bei Bund, Kantonen und Gemeinden, die diese Daten offen publizieren. Es
> bleiben ihre Daten; Swissyphus macht sie einfacher nutzbar und korrekt zitierbar.
>
> Open Source (MIT), unabhängiges Projekt: github.com/cwellbournewood/swissyphus
>
> #OpenData #OGD #KI #MCP #Schweiz

**Français** (court)

> **Swissyphus 1.0** est publié : un serveur MCP open source qui réunit 60 sources de données
> publiques suisses pour les agents IA. 143 outils (transports, météo, registre du commerce, droit
> fédéral, Parlement, votations, géodonnées, statistique, avalanches, sanctions…), sans clé
> d'API, et chaque réponse cite son éditeur, sa licence, la date des données et la requête exacte.
> `npx -y swissyphus`. Projet indépendant, licence MIT : github.com/cwellbournewood/swissyphus

---

## 4. X / Bluesky thread

1. Swiss public data, rolled up for AI agents. Swissyphus 1.0: one MCP server, 60 public
   sources, 143 tools, zero API keys. Every answer cited.
   `npx -y swissyphus` · github.com/cwellbournewood/swissyphus
2. Ask: "Next train Bern→Lugano, and is there snow in Zermatt?" It checks the Swiss timetable,
   SLF snow stations and MeteoSwiss, and every answer says which source said what, and when.
3. Cited means cited: publisher, licence, the publisher's own timestamp, and the exact upstream
   requests behind the answer. Anyone can re-run them.
4. `find_data` searches opendata.swiss, ~900 federal map layers, every BFS table, LINDAS cubes
   and cantonal portals at once, then returns the exact call that fetches the data.
5. Always running: caching, back-off on the first 429, the last good answer when a source is
   down (marked with its age), and a nightly canary. MIT, independent, contributions welcome.

**Mastodon** (single post, 500 chars):

> Released: Swissyphus 1.0, the Swiss public-data rollup for AI agents. One MCP server, 60
> public sources, 143 tools (timetable, MeteoSwiss, commercial register, Fedlex, parliament,
> geo.admin.ch, BFS, SECO sanctions, simap.ch…), zero API keys. Every answer carries its
> publisher, licence, timestamp and the exact upstream requests. `npx -y swissyphus` · MIT ·
> github.com/cwellbournewood/swissyphus #OpenData #MCP #Switzerland

---

## 5. Reddit (r/mcp, r/ClaudeAI)

**Title:** Swissyphus: an MCP server for Swiss public data where every answer is cited (143
tools, no API keys)

> Swissyphus rolls up 60 Swiss public data sources into one MCP server: public transport,
> MeteoSwiss, the commercial register, federal law, parliament votes, avalanche bulletins, the
> sanctions list, public tenders, parcel restrictions, BFS statistics and the opendata.swiss
> catalogue.
>
> Install: `claude mcp add --scope user swissyphus -- npx -y swissyphus`, or the one-click `.mcpb`
> for Claude Desktop from the Releases page.
>
> Two ideas that may be useful beyond Switzerland:
> - **Provenance on every response:** source, licence, attribution, the publisher's timestamp
>   (`data_as_of`, null if unknown), `cache_status`, and `provenance.upstream`, the exact
>   requests behind the answer, recorded per call with credentials redacted.
> - **A `discovery` preset:** 7 meta tools (`find_data`, `find_tools`, `describe_tool`,
>   `call_tool`) instead of 143, to keep context small.
>
> MIT: github.com/cwellbournewood/swissyphus. Which sources are missing?

For **r/Switzerland**, read the self-promotion rules first, lead with the Swiss angle ("ask about
avalanche danger, train times and the commercial register in one place"), and keep it short.

---

## 6. Courtesy note to data publishers (T+1 week)

To the open-data teams of opendata.swiss, BFS and swisstopo (via their public contact channels).
A thank-you and a heads-up, not a permission request; licence questions go through
[`docs/outreach/`](../outreach/README.md).

> **Subject:** An open-source tool that makes your open data usable, and citable, by AI agents
>
> Hello,
>
> I maintain Swissyphus, an open-source (MIT) MCP server that lets AI assistants such as Claude
> query Swiss public data. [Your service] is one of its 60 sources.
>
> Every response names your organisation as the publisher, states the licence and attribution
> you require, gives your own timestamp for the data, and lists the exact request made to your
> service. Requests are cached and rate-limit aware, and we back off immediately when a service
> signals overload.
>
> If you would like the attribution worded differently, prefer another endpoint, or have any
> concern about how we access the service, please tell me and I will change it.
>
> Thank you for publishing this data openly.
>
> Kind regards,
> [name] · github.com/cwellbournewood/swissyphus

---

## 7. 60-second demo script

Screen recording in Claude Desktop or Claude Code (`full` preset). Rehearse once so caches are
warm.

1. *"Next train from Bern to Lugano, and is there snow in Zermatt right now?"* Shows: timetable
   + SLF snow, each part cited.
2. *"Who is Nestlé S.A. in the commercial register, and what have they published in the SOGC
   recently?"* Shows: ZEFIX + gazette.
3. *"Screen 'Rotenberg' against the Swiss sanctions list."* Shows: SECO matches with list date.
4. *"Find data on road noise in canton Aargau."* Shows: `find_data` across catalogues, then the
   follow-up call.
5. Expand one tool result: point at `source`, `data_as_of` and `provenance.upstream`.

---

## 8. Replies to likely questions

| Question | Answer |
|---|---|
| Is this official? | No. It's an independent open-source project. The data comes from public services, and every answer names them and their licence. |
| Is it legal to use the data? | Each source has its own terms, and every answer states them. Most are Swiss open government data (free use with attribution); some are non-commercial or need permission for commercial use, and those are flagged. |
| Do I need API keys? | No. One optional free key (opentransportdata.swiss) adds transport disruptions and real-time delays. |
| Is there a hosted version? | Not yet. You can self-host the Docker image: REST API, OpenAPI and a remote MCP endpoint. |
| 143 tools will eat my context. | Use `--preset discovery` (7 tools, reaches everything) or a topic preset such as `outdoor` or `business`. |
| How do you avoid hammering public services? | Caching, coalesced requests, per-host concurrency caps, circuit breakers that open on the first 429 and honour `Retry-After`, and a nightly canary. |
| How is this different from mcp-swiss? | mcp-swiss is good work and covers a few things we don't (dams, traffic counts, SBB operating statistics). Swissyphus adds provenance on every answer, a licence register, search and querying across the federal catalogues, and compliance sources such as sanctions, UID/VAT, courts and tenders. Fair comparison: docs/COMPARISON.md. |
| Can I add a source? | Yes. Open a "Data source request" issue, or a PR: each module is one file with its source manifest, tools and tests (CONTRIBUTING.md). |
