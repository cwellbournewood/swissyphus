# Swissyphus plugin for Claude

Swissyphus gives Claude Swiss public data. It bundles 66 public sources into one MCP server: SBB
and the Swiss timetable, MeteoSwiss, swisstopo, Fedlex, the commercial register (ZEFIX) and
gazette (SHAB), SLF avalanche and snow data, the SECO sanctions list, opendata.swiss and more.
Claude gets 151 tools. All of them only read data, none needs an API key, and every answer
carries its source, licence, attribution and the exact upstream request behind it.

Website: <https://swissyphus.ch> · Source and full documentation:
<https://github.com/cwellbournewood/swissyphus>

## Install

In Claude Code:

```text
/plugin install swissyphus --marketplace cwellbournewood/swissyphus
```

## What this plugin runs

The plugin starts one local MCP server over stdio:

```text
npx -y swissyphus@1.0.3
```

That downloads the `swissyphus` package from npm (version pinned) and runs it on your computer
with Node.js 20 or newer. It has no other components: no hooks, commands, skills or agents.

## What it sends, and where

- **Your questions go to public data sources, not to Swissyphus.** When Claude calls a tool, the
  server requests the data from the public source that publishes it, for example
  `transport.opendata.ch`, `api.geo.admin.ch`, `data.snb.ch` or `www.fedlex.admin.ch`. Only hosts
  on a fixed allowlist in the server are contacted. Each answer lists the exact requests made.
- **Nothing is sent to the Swissyphus project.** The server has no telemetry, analytics or crash
  reporting, and needs no account.
- **Optional key.** If you enter an opentransportdata.swiss key, it is sent only to
  opentransportdata.swiss, for the disruption and real-time delay tools.

## Privacy Policy

Run locally through this plugin, Swissyphus collects, stores and shares no personal data with
its authors or any third party. Tool requests go directly from your computer to the public
sources above, under their own terms. Responses are cached in memory only, for the session.
There is nothing to retain or delete. Full privacy policy, including the separate hosted API:
<https://github.com/cwellbournewood/swissyphus/blob/main/PRIVACY.md>. Contact:
<https://github.com/cwellbournewood/swissyphus/issues> or cwellbournew@gmail.com.

## Try it

- "Next train from Bern to Lugano after 6 pm?"
- "Avalanche danger and snow depth around Davos right now?"
- "Is SR 235.1 still in force, and what changed recently?"
- "Due diligence on Nestlé: register entry and recent gazette notices."

## Licence

MIT. The data keeps its own licences; every response states which one applies. Swissyphus is
independent and not endorsed by the Swiss Confederation, any canton or any data provider.
