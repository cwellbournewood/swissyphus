# Contributing to Swissyphus

Thanks for helping roll up Swiss public data. Bug reports, new sources, fixes for upstream drift
and documentation are all welcome.

## Ground rules

- **Every answer stays cited.** Tools return `respond(data, meta)` with the source manifest, the
  publisher's timestamp as `dataAsOf` when there is one, and data fetched through the shared fetch
  layer (`fetchJson`, `fetchCached`, `fetchPublicResource`), which records provenance. No raw
  `fetch()` in modules.
- **Respect the publishers.** Use documented, public endpoints; set a sensible cache TTL and
  `maxStaleSeconds`; never scrape behind a login. State the licence exactly as the publisher
  does. If redistribution is unclear, say so in the manifest and add the module to
  `HOSTED_EXCLUDED` in `src/registry.ts`.
- **Offline tests for everything.** `npm test` never touches the network; it uses recorded
  fixtures. Live checks go in `test/smoke.mjs`.
- **Keep the public interface stable** (README, "Versioning"): don't rename tools or remove
  parameters; add optional ones instead.

## Setup

```bash
git clone https://github.com/cwellbournewood/swissyphus.git
cd swissyphus
npm install
npm run build
```

| Command | Does |
|---|---|
| `npm test` | Build, then every offline suite (`test/*.test.mjs`). This is what CI runs |
| `node --test test/unit.test.mjs` | One suite (after `npm run build`) |
| `npm run test:live` | Live MCP smoke test against the real upstreams (`test/smoke.mjs`) |
| `npm run test:rest` | Live REST and remote-MCP test (`test/rest.mjs`) |
| `node dist/index.js doctor` | Probe every upstream source |
| `npm run catalogue` | Regenerate `tools.schema.json` and `docs/TOOLS.md` (CI checks both are fresh) |
| `npm run manifest` | Regenerate the `.mcpb` `manifest.json` (CI checks it) |
| `npm run bundle` | Build `swissyphus.mcpb` |
| `npm run inspect` | Open the MCP Inspector |
| `SWISSYPHUS_DEBUG=1` | Log every tool call and upstream request with timings |

Live suites don't run on pull requests, because upstreams are flaky by nature. A nightly
[live canary](.github/workflows/live-canary.yml) runs them and opens an issue when a source
drifts. Maintainers can also run it on a branch from the Actions tab.

## Adding a source

1. Create or extend a module in `src/modules/` (one file per domain). Declare a `SourceManifest`
   per upstream: `id`, `name`, `operator`, `url`, `licence`, `attribution`, `updateFrequency`,
   `cacheTtlSeconds`, `maxStaleSeconds`.
2. Call `allowHosts(...)` for its hosts. Nothing else can be fetched.
3. Write tools with Zod input schemas and clear descriptions (what it returns, when to use it).
   Return `respond(...)` or `toolError(...)` with a `kind` and actionable suggestions.
4. Add a `healthProbes` entry, and `registerSearcher(...)` if it is a catalogue, so `find_data`
   finds it.
5. Register the module in `src/registry.ts` and add it to the presets it belongs in.
6. Add offline tests with fixtures recorded from the real API, and live cases in
   `test/smoke.mjs`.
7. Run `npm run build && npm run catalogue && npm run manifest` and commit the generated files.
8. Add a line under `## [Unreleased]` in `CHANGELOG.md`.

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) explains the fetch layer, the envelope and
provenance.

## Pull requests

- One topic per PR, with a description of what changed and how you tested it.
- CI must pass: build and offline tests on Node 20, 22 and 24, the dependency audit, freshness of
  the generated files, and the Docker build.
- By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE).

## Releases

Releases are tag-driven. A maintainer bumps the version in `package.json` (and the lockfile),
`src/server.ts`, `server.json` and the Claude plugin (`plugin/.claude-plugin/plugin.json`, plus the
pinned `swissyphus@X.Y.Z` in `plugin/.mcp.json` and `plugin/README.md`), runs `npm run manifest && npm run catalogue`, moves the
`[Unreleased]` notes in `CHANGELOG.md` under the new version, and merges that. Pushing a `vX.Y.Z`
tag then runs [`release.yml`](.github/workflows/release.yml): it checks every version against the
tag, runs the tests, publishes the GitHub Release with the `.mcpb` bundle and the CHANGELOG notes,
pushes the multi-arch image to GHCR, publishes to npm with provenance, and updates the MCP
Registry entry. Versions follow [semantic versioning](README.md#versioning-and-stability).

## Reporting

- **Bugs and upstream drift:** [open an issue](https://github.com/cwellbournewood/swissyphus/issues/new/choose).
  Include the tool, its arguments and the response.
- **A source we should add:** use the "Data source request" issue form.
- **Security issues:** never in a public issue. See [`SECURITY.md`](SECURITY.md).

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
