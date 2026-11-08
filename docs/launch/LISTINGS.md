# Directory listings

Where Swissyphus should be listed, and exactly how. **Every listing needs the repository to be
public first** (GO_LIVE §1): directories link to the repo, read its README and, for Glama, score
it from the code. Submit them on release day, after GO_LIVE §3 is green.

| Directory | How | Who |
|---|---|---|
| Official MCP Registry | Automatic: the release workflow's `mcp-registry` job | done by the release |
| awesome-mcp-servers | Pull request (below) | PR from a fork |
| Glama | Indexes public repos and syncs with awesome-mcp-servers; `glama.json` in the repo names the maintainer so you can claim it | 👤 sign in with GitHub, claim |
| PulseMCP | Ingests the official MCP Registry; check the listing appears a few days after release | automatic |
| mcp.so | "Submit" form on the site, with the repo URL | 👤 |
| Smithery | Listing via its site (sign in with GitHub, add the repo) | 👤 |

## awesome-mcp-servers

Repository: `punkpeye/awesome-mcp-servers`, file `README.md`, section
**📊 Data Platforms** (where mcp-swiss is). The list is loosely alphabetical by owner: insert the
line after `Castaldo-Solutions/mcp-vtenext` and before `dan1d/mercadolibre-mcp`.

```markdown
- [cwellbournewood/swissyphus](https://github.com/cwellbournewood/swissyphus) [![swissyphus MCP server](https://glama.ai/mcp/servers/cwellbournewood/swissyphus/badges/score.svg)](https://glama.ai/mcp/servers/cwellbournewood/swissyphus) 📇 ☁️ 🏠 - The Swiss public-data rollup for AI agents: 143 tools over 60 public sources (transport, MeteoSwiss, ZEFIX and SOGC, Fedlex, parliament, geo.admin.ch, BFS, SECO sanctions, simap.ch tenders). Zero API keys; every answer carries its publisher, licence, timestamp and the exact upstream requests.
```

Legend: 📇 TypeScript · ☁️ uses cloud services (the public APIs) · 🏠 runs locally.

**PR title:** `Add cwellbournewood/swissyphus (Swiss public data)`

**PR body:**

> Adds Swissyphus to Data Platforms: an MCP server that rolls up 60 Swiss public data sources
> into 143 tools, with zero API keys. Every response carries its publisher, licence, the
> publisher's timestamp and the exact upstream requests (provenance). MIT, TypeScript, published
> on npm as `swissyphus` and in the official MCP Registry as
> `io.github.cwellbournewood/swissyphus`.

Process (from the list's CONTRIBUTING.md): fork → branch → edit `README.md` → PR. The list
fast-tracks PRs opened by automated agents if the title ends with `🤖🤖🤖`; leave that off if you
open it yourself.

## Glama

1. After the repo is public, open `https://glama.ai/mcp/servers/cwellbournewood/swissyphus`. If it
   is not indexed yet, it will be once the awesome-mcp-servers PR merges (the directory syncs with
   the list), or add it from Glama's "Add server" page.
2. Sign in with the `cwellbournewood` GitHub account and claim the server. `glama.json` in the
   repo root lists you as maintainer, which is what Glama checks.
3. Glama scores servers on documentation, licence, tool-definition quality and whether it can
   start the server. Swissyphus starts with no configuration (`npx -y swissyphus`), so no
   environment variables need to be entered.
4. Once scored, add the badge to the README badge row:
   `[![Glama](https://glama.ai/mcp/servers/cwellbournewood/swissyphus/badges/score.svg)](https://glama.ai/mcp/servers/cwellbournewood/swissyphus)`

## Short descriptions

| Length | Text |
|---|---|
| ≤ 100 chars (MCP Registry) | Swiss public-data rollup for AI agents: 143 tools, 60 sources, zero keys, every answer cited. |
| ≤ 160 chars (directories) | The Swiss public-data rollup for AI agents: 60 public sources in one MCP server. 143 tools, zero API keys, every answer cited. |
| ≤ 350 chars (GitHub "About") | The Swiss public-data rollup for AI agents: 60 public sources in one MCP server and REST API. 143 tools, zero API keys, every answer cited down to the exact upstream request. |

**Topics / tags:** `mcp`, `mcp-server`, `model-context-protocol`, `switzerland`, `swiss`,
`open-data`, `opendata-swiss`, `provenance`, `ai-agents`, `claude`, `geodata`, `sanctions`.
