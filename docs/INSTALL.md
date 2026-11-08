# Install and configure

Swissyphus runs locally as an MCP server over stdio. You need **Node.js 20 or newer**
(`node --version`). No account and no API keys.

## Claude Code

```bash
claude mcp add --scope user swissyphus -- npx -y swissyphus
```

Restart Claude Code and run `/mcp`: `swissyphus` should be listed as connected.

## Claude Desktop

**One click:** download `swissyphus.mcpb` from the
[latest release](https://github.com/cwellbournewood/swissyphus/releases/latest) and open it. Pick a
preset in the install dialog (`full` by default). Claude Desktop keeps it updated.

**Or by config:** add this to `claude_desktop_config.json` and restart.

```json
{
  "mcpServers": {
    "swissyphus": { "command": "npx", "args": ["-y", "swissyphus"] }
  }
}
```

## Cursor, VS Code, Windsurf, Cline and other MCP clients

Use the same `command` / `args` as above in the client's MCP configuration (`.cursor/mcp.json`,
`.vscode/mcp.json`, …). Any client that speaks MCP over stdio works.

## Docker

```bash
docker run -i --rm ghcr.io/cwellbournewood/swissyphus --stdio
```

For the REST API and remote MCP endpoint, see [`HOSTING.md`](HOSTING.md).

## Presets: load only what you need

151 tool definitions cost about 36k tokens of context. Presets load a subset:

```bash
npx -y swissyphus --preset discovery   # 7 meta tools; find_data / call_tool still reach all 151
npx -y swissyphus --preset outdoor     # weather, avalanche, snow, trails, hydrology, transport …
npx -y swissyphus --modules transport,weather
npx -y swissyphus --preset legal --modules fx   # combinable
npx -y swissyphus --list-modules       # everything, with tool counts
```

| Preset | For |
|---|---|
| `discovery` | Smallest context. `find_data`, `find_tools`, `describe_tool` and `call_tool` reach every module |
| `minimal` | Geocoding, transport, weather |
| `commuter` | Transport, weather, alerts, holidays, shared mobility |
| `outdoor` | Weather, avalanche, snow, trails, hydrology, earthquakes, glaciers, transport |
| `business` | Companies, UID/VAT, sanctions, procurement, law, FX, statistics, energy |
| `citizen` | Everyday questions: transport, weather, waste, votes, energy, health, local politics |
| `legal` | Law, courts, companies, parliament, votes, sanctions, ÖREB cadastre |
| `compliance` | Companies, UID, sanctions, courts, procurement, law, Wikidata |
| `politics` | Federal, cantonal and municipal politics, votes, law |
| `property` | Parcels, buildings, ÖREB restrictions, solar, energy, geodata |
| `health` | FOPH surveillance, air quality, health statistics |
| `research` | Libraries, research data, glaciers, statistics, cubes, Wikidata |
| `full` | Everything (default) |
| `hosted` | Everything whose licence allows public redistribution (used by public deployments) |

The exact module list of each preset is at the end of [`TOOLS.md`](TOOLS.md#presets).

With the `discovery` preset, `call_tool` may reach modules that are not loaded. Otherwise a module
selection is also a security boundary (`SWISSYPHUS_PROXY_ALL=1` lifts it).

## Optional keys

Swissyphus needs no keys. One free key adds extra depth; without it, those tools explain how to
get one.

| Environment variable | Unlocks | Get it |
|---|---|---|
| `OPENTRANSPORTDATA_API_KEY` | `get_transport_disruptions`, `get_realtime_delays` | free at opentransportdata.swiss |
| `ZEFIX_USER` / `ZEFIX_PASS` | the official ZefixPublicREST API for `companies` (a keyless back-end is used otherwise) | issued by the Federal Office of Justice |

Pass them through your client's `env` block, for example:

```json
{ "command": "npx", "args": ["-y", "swissyphus"], "env": { "OPENTRANSPORTDATA_API_KEY": "…" } }
```

## Check that sources are reachable

```bash
npx -y swissyphus doctor
```

`doctor` probes every upstream source and prints its status and latency. Agents get the same view
from the `check_source_health` tool.

## Troubleshooting

**`CONNECTION_CLOSED` / "failed to reconnect"** means the server process exited before the MCP
handshake.

- **Node older than 20.** The client may use a different Node than your shell: check the `node`
  on the client's `PATH`.
- **Corporate proxy or TLS inspection.** Set `NODE_EXTRA_CA_CERTS` to your CA bundle in the
  server's `env`.
- **Running from source.** Use the **absolute** path to `dist/index.js`, and run `npm run build`
  first. `node <path>/dist/index.js` should print the Swissyphus banner and wait for input; any
  error it prints is the real cause. In `cmd.exe`, `$(pwd)` and `$PWD` are not expanded: use
  `%CD%`.

**A tool says the source is unavailable.** Run `npx -y swissyphus doctor`. Public services go
down or rate-limit from time to time; Swissyphus serves the last good answer (marked
`cache_status: "stale"`) when it has one.

**The first sanctions search says the list is still loading.** The SECO list is a 43 MB download
from a slow server. Ask again in a minute; it is then cached for 6 hours. Hosted deployments
load it at start-up.

## Run from source

```bash
git clone https://github.com/cwellbournewood/swissyphus.git
cd swissyphus
npm install && npm run build
claude mcp add --scope user swissyphus -- node "$(pwd)/dist/index.js"
```

Development commands are in [`CONTRIBUTING.md`](../CONTRIBUTING.md).
