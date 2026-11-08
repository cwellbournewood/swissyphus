# Website: structure and copy

Copy for the Swissyphus website, ready to build. Brand rules: [`BRAND.md`](BRAND.md); tokens:
[`tokens.json`](tokens.json); assets: [`assets/`](../../assets). Numbers are those of 1.0.0
(re-derive them per BRAND.md before publishing).

Until a domain exists, the GitHub README is the homepage. When you pick one, set it as the
repository's website (GitHub "About") and in `server.json` (`websiteUrl`).

## Sitemap

| Page | Purpose | Source |
|---|---|---|
| `/` | Home: the pitch, install, proof | this file |
| `/docs` | Install and configuration | [`docs/INSTALL.md`](../INSTALL.md) |
| `/tools` | All 151 tools, searchable | [`docs/TOOLS.md`](../TOOLS.md), or `tools.schema.json` for a live table |
| `/provenance` | How citing works (the differentiator) | [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) §Provenance |
| `/sources` | Licence register: 66 sources with operator, licence, attribution | `GET /v1/sources` or `tools.schema.json` |
| `/api` | REST API and self-hosting | [`docs/HOSTING.md`](../HOSTING.md) + rendered `/openapi.json` |
| `/status` | Source health (later) | `GET /v1/health/sources` on the hosted deployment |
| `/privacy` | Privacy notice (only once a hosted API exists) | [`PRIVACY.md`](../../PRIVACY.md) |

## Meta

```html
<title>Swissyphus: the Swiss public-data rollup for AI agents</title>
<meta name="description" content="66 Swiss public data sources in one MCP server. 151 tools, zero API keys, every answer cited down to the exact upstream request. Open source.">
<meta property="og:title" content="Swissyphus: the Swiss public-data rollup for AI agents">
<meta property="og:description" content="66 public sources · 151 tools · zero API keys · every answer cited.">
<meta property="og:image" content="/social-preview.png">  <!-- assets/social-preview.png, 1280×640 -->
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#123C4D">
<link rel="icon" href="/icon.svg" type="image/svg+xml">      <!-- assets/icon.svg -->
```

## Home page

### 1. Hero

- **Eyebrow** (mono, Trail ink): THE SWISS PUBLIC-DATA ROLLUP FOR AI AGENTS
- **Headline** (Archivo Expanded 800, uppercase): EVERY SWISS SOURCE. **ALWAYS RUNNING.** (second
  sentence in Trail Marker)
- **Subhead:** 66 public sources rolled into one server and kept running. Every answer cited,
  down to the exact upstream request.
- **Primary action:** a copyable command: `claude mcp add --scope user swissyphus -- npx -y swissyphus`
- **Secondary actions:** [Download for Claude Desktop] (`.mcpb` from the latest release) ·
  [View on GitHub]
- **Proof strip:** 151 tools · 66 sources · 15'000+ datasets · 0 API keys
- **Visual:** a chat answer ("Next train Bern → Lugano, and is there snow in Zermatt?") whose
  sources expand into the envelope: publisher, licence, data_as_of, provenance. Reuse the right
  half of `assets/social-preview.png` as the static fallback.

### 2. Ask anything Swiss

Headline: **Ask the questions that used to take ten tabs.**

Cards (question → sources it uses):

| Question | Sources |
|---|---|
| Next train from Bern to Lugano, and is there snow in Zermatt? | Swiss timetable, SLF snow stations, MeteoSwiss |
| Who is Nestlé in the commercial register, and what did it publish in the SOGC? | ZEFIX, SOGC |
| Screen "Rotenberg" against the Swiss sanctions list. | SECO |
| What restrictions apply to the parcel at this address? | swisstopo, ÖREB cadastres |
| Is SR 235.1 still in force? | Fedlex |
| How did Ticino vote on June 14? | BFS vote results |
| Which school-building tenders were awarded in Zürich this month? | simap.ch |
| How is the flu developing in canton Bern? | FOPH |

### 3. Cited (lead differentiator)

Headline: **Every answer says where it came from.**

Body: Each of the 151 tools returns the data with its publisher, the licence and attribution to
show, the publisher's own timestamp, and the exact requests behind it. When a source is down,
you get the last good answer, clearly marked with its age, or an honest error. Never a guess.

Four labelled callouts over a real envelope (use the SNB example from the README):

- **Source:** who publishes it, and how to credit them.
- **Data as of:** how current the data is, from the publisher. Not when we fetched it.
- **Cache status:** fresh, cached, or stale with its age.
- **Provenance:** the exact upstream requests. Anyone can re-run them.

Link: How provenance works → `/provenance`

### 4. Catalogues, not just endpoints

Headline: **One question, every catalogue.**

Body: `find_data` searches opendata.swiss, ~900 federal map layers, every BFS table, the LINDAS
statistical cubes, cantonal and SBB portals, the SNB, I14Y and Wikidata in parallel, and returns
the exact call that fetches the data. Then agents filter, profile and aggregate inside the
datasets.

Visual: a query ("road noise in Aargau") fanning out to catalogue logos-as-text, converging on
one `next: { tool, args }`.

### 5. Coverage

Headline: **66 sources. One interface.**

Eight tiles (from the README "What's inside" table): Mobility · Weather & environment · Places &
property · Business & compliance · Law & politics · Statistics & catalogues · Society ·
Discovery. Each tile lists its modules and leading sources. Link: All 151 tools → `/tools`

### 6. Due diligence

Headline: **Compliance checks in one place.**

Body: Sanctions screening against the SECO list, UID and VAT validation, the commercial register
and SOGC gazette, court decisions, public tenders and federal law. Every result cited, ready for
the file.

Note under it (small): A match is not a legal determination. Verify identities against the
official entry.

### 7. Always running

Headline: **Built for public infrastructure that goes down.**

Four points: caching and single-flight requests · circuit breakers that back off on the first
rate limit · the last good answer across restarts, clearly marked · a nightly canary that tests
every live source.

### 8. Install

Tabs: Claude Code · Claude Desktop · Cursor / VS Code · Docker · REST API. Copy from
[`docs/INSTALL.md`](../INSTALL.md) and [`docs/HOSTING.md`](../HOSTING.md).

### 9. FAQ

| Question | Answer |
|---|---|
| Is Swissyphus official? | No. It's an independent open-source project. The data comes from public services, and every answer names them and their licence. |
| Do I need API keys? | No. One optional free key adds transport disruptions and real-time delays. |
| Can I use the data commercially? | It depends on each source, and every answer states its licence. Most are Swiss open government data (free use with attribution); some are non-commercial or need permission, and say so. |
| Will 151 tools fill my context window? | Use `--preset discovery`: 7 tools that reach all 151, or a topic preset such as `outdoor` or `business`. |
| Is there a hosted API? | You can self-host the Docker image today: REST API, OpenAPI and remote MCP. |
| How does it treat the public services it uses? | Caching, request coalescing, per-host limits, and immediate back-off when a service asks. |
| Which clients work? | Any MCP client: Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, Cline, and more. |

### 10. Footer

Swissyphus is an independent open-source project, not operated or endorsed by the Swiss
Confederation, any canton or any data provider. The data keeps its publishers' licences.
MIT licence · GitHub · Changelog · Security · Privacy

## Building it with Claude Design

The brand system already lives in the Claude Design project "Swissyphus brand identity options"
(pages *Brand Final* and *Landing Page*, shared styles in `site.css`). Update that landing page
with the copy above rather than starting over: the current figures are 151 tools, 45 modules and
66 sources, and the "uphill" lines in *Brand Final* give way to the rollup line ("Every Swiss
source. Always running."). Keep to the Carte Nationale rules in [`BRAND.md`](BRAND.md): 1 px
Lake Deep rules, no shadows, Archivo Expanded / Archivo / IBM Plex Mono, one Trail Marker accent
per view, and never the Swiss cross.
