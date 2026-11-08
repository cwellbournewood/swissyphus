# Installing Swissyphus (instructions for AI agents)

Swissyphus is an MCP server for Swiss public data: 151 tools over 66 public sources. It needs
**no API keys and no configuration**, only Node.js 20 or newer.

## Steps

1. Check Node.js: `node --version` must print v20 or higher. If not, ask the user to install
   Node.js 20+ from nodejs.org first.
2. Add this server to the MCP settings file of the client (for Cline:
   `cline_mcp_settings.json`; for Claude Desktop: `claude_desktop_config.json`):

   ```json
   {
     "mcpServers": {
       "swissyphus": {
         "command": "npx",
         "args": ["-y", "swissyphus"]
       }
     }
   }
   ```

   For Claude Code, run instead: `claude mcp add --scope user swissyphus -- npx -y swissyphus`

3. Optional, to save context: add `"--preset", "discovery"` to `args`. Only 7 tools are then
   listed, and `find_data` / `call_tool` still reach all 151.
4. Restart the client and confirm the server is connected.
5. Verify: call `about_swissyphus` (lists modules), or ask "What is the CHF to EUR exchange
   rate?" and check that the answer cites the Swiss National Bank.

## Optional keys

None are needed. `OPENTRANSPORTDATA_API_KEY` (free at opentransportdata.swiss) adds public
transport disruptions and real-time delays; set it in the server's `env` block only if the user
provides one.

## If it fails to start

- `npx` not found or wrong Node version: install Node.js 20+, then restart the client.
- Behind a corporate proxy with TLS inspection: set `NODE_EXTRA_CA_CERTS` in `env` to the
  user's CA bundle.
- Run `npx -y swissyphus doctor` to check that the public data sources are reachable.

Every tool answer includes its source, licence, attribution, the publisher's timestamp and the
exact upstream requests. Cite the attribution when presenting results.
