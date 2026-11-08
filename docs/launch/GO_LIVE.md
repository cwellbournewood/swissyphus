# Go-live runbook: Swissyphus 1.0

The single checklist for taking Swissyphus public, from "code is ready" to "announced and
watched". The release mechanics live in [`docs/RELEASING.md`](../RELEASING.md); this page puts
them in order with everything around them. Announcement copy is in
[`ANNOUNCEMENT.md`](ANNOUNCEMENT.md), directory listings in [`LISTINGS.md`](LISTINGS.md), and the
brand kit in [`docs/brand/`](../brand/BRAND.md).

👤 = owner-only (repo admin, npm account, or sending as the controller). Everything else is
already done, or automated.

## Where things stand (2026-11-08)

| Area | State |
|---|---|
| Code | 45 modules, 151 tools, 66 sources. Every answer carries source, licence, publisher timestamp and request-level provenance. All offline tests pass; `npm audit --omit=dev` clean |
| Live upstreams | Canary on this branch, from GitHub: **smoke 86/86, REST 29/29, doctor 53/54** (the miss was a transient Basel-Stadt probe timeout; `main` was 54/54 the same morning). The sanctions cold-start failure that kept issue #11 open is fixed |
| npm | `swissyphus` is **still unclaimed** (`npm view swissyphus` → 404). Anyone can take it. This is the most urgent item |
| Release automation | Tag-driven: GitHub Release with `.mcpb`, multi-arch GHCR image, npm with provenance, **MCP Registry** listing |
| Repo | **Private.** Blocks npm provenance, public GHCR pulls and every README link |
| Hosted API | Not launched. Separate, later gate (§6). This launch is the open-source package |

## 1. Before release day 👤

- [x] **Release PRs merged** to `main` (v1.0.0, then provenance and launch polish).
- [ ] **Make the repo public**: Settings → General → Danger Zone → Change visibility.
  - History was scanned for tokens and keys on 2026-11-08: nothing found.
  - Before going public: settle the personal-email clean-up (choose the controller contact for
    `PRIVACY.md` / `BREACH_RESPONSE.md`, rewrite history, ask GitHub Support to purge old pull
    request refs). This must happen **before the first npm publish**, because `PRIVACY.md`
    ships in the package and npm versions cannot be changed.
- [ ] **Branch protection** on `main` (Settings → Branches): require `build-and-test (20.x)`,
      `build-and-test (22.x)`, `build-and-test (24.x)` and `docker-build`.
- [ ] **Tag protection** (optional): Settings → Rules → Rulesets → target tags `v*`, restrict
      creation to you. A tag push publishes to npm and GHCR.
- [ ] **`NPM_TOKEN`** repo secret: npm granular access token with publish rights, scope "all
      packages" for the first publish (the package does not exist yet). Without it, the release
      skips npm and you publish by hand (§2).
- [ ] **Turn on** Settings → Code security: **Private vulnerability reporting** (SECURITY.md
      relies on it), **Secret scanning** with push protection, **Dependabot alerts** (the repo
      already has `.github/dependabot.yml` for update PRs).
- [ ] **Repo "About" box** (⚙️ next to About on the repo page): description
      `The Swiss public-data rollup for AI agents: 66 public sources in one MCP server and REST API. 151 tools, zero API keys, every answer cited down to the exact upstream request.`
      Website: `https://www.npmjs.com/package/swissyphus` until there is a site. Topics:
      `mcp`, `mcp-server`, `model-context-protocol`, `switzerland`, `swiss`, `open-data`,
      `opendata-swiss`, `provenance`, `ai-agents`, `claude`, `geodata`, `sanctions`.
- [ ] **Social preview**: Settings → General → Social preview → upload
      `assets/social-preview.png` (1280×640). This is the card shown when the repo link is shared.
- [ ] **Features**: Settings → General → Features: turn on **Discussions** (questions that are
      not bugs); leave Wiki off (docs live in `docs/`).

## 2. Release day: ship 👤

Pick a **Tuesday to Thursday**. Tag in the morning (CET) so the announcements in §4 go out
while Europe and the US East Coast are both awake.

```bash
git switch main && git pull
git tag -a v1.0.0 -m "Swissyphus v1.0.0"
git push origin v1.0.0
```

The [Release workflow](../../.github/workflows/release.yml) then runs four jobs, in about 10
minutes:

| Job | Result | If it fails |
|---|---|---|
| `release` | GitHub Release with notes from `CHANGELOG.md` and `swissyphus.mcpb` attached | Version mismatch or a stale manifest: see the job error; delete the tag, fix, re-tag (RELEASING §"If something goes wrong") |
| `docker` | `ghcr.io/cwellbournewood/swissyphus:v1.0.0` and `:latest`, amd64 + arm64 | Re-run the job |
| `npm-publish` | `swissyphus@1.0.0` on npm with provenance | Needs a public repo and `NPM_TOKEN`. Or publish by hand: `git switch --detach v1.0.0 && npm ci && npm run build && npm login && npm publish --access public` |
| `mcp-registry` | `io.github.cwellbournewood/swissyphus` in the official MCP Registry | Skips if npm lacks the version; fails if the GHCR package is private. Fix, then re-run this job |

Right after the `docker` job: set the **GHCR package to public** at
`https://github.com/users/cwellbournewood/packages/container/swissyphus/settings`
(package visibility is separate from repo visibility). Then re-run `mcp-registry` if it failed.

## 3. Release day: verify from a clean machine

Run these on a machine that has never seen the repo (or a fresh container):

```bash
npm view swissyphus version
```

```bash
npx -y swissyphus@1.0.0 --version
```

```bash
docker run --rm -p 8000:8000 ghcr.io/cwellbournewood/swissyphus:v1.0.0
```

```bash
curl -s localhost:8000/v1/health && curl -s "localhost:8000/v1/tools/get_exchange_rate?currency=EUR" | head -c 300
```

```bash
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.cwellbournewood/swissyphus" | head -c 400
```

Then the user journeys the announcement promises. Each should take under a minute:

- [ ] **Claude Code**: `claude mcp add --scope user swissyphus -- npx -y swissyphus`, restart,
      `/mcp` shows it connected. Ask: *"Next train Bern to Lugano, and is there snow in Zermatt?"*
- [ ] **Claude Desktop**: download `swissyphus.mcpb` from the Release, open it, pick `full`.
      Ask: *"Is this supplier on the Swiss sanctions list: Rotenberg?"* (the first call may say
      the 40 MB list is still loading; the second answers in milliseconds).
- [ ] **Discovery preset**: `npx -y swissyphus --preset discovery`. Ask: *"How is the flu
      developing in canton Bern?"* and check that `find_data` → `call_tool` reaches the
      `health` module.
- [ ] npmjs.com/package/swissyphus renders the README, the licence and the repo link.

Only announce once all of §3 is green.

## 4. Announce

Copy for every channel is in [`ANNOUNCEMENT.md`](ANNOUNCEMENT.md). Suggested order on release
day (CET):

| When | Where | Note |
|---|---|---|
| T+0 (after §3) | GitHub: pin the Release; enable Discussions | Gives people somewhere to ask that is not an issue |
| T+0 | LinkedIn (EN, then DE) with film 02 | Your network; the Swiss open-data and public-sector audience. Films and captions: [`motion/`](motion/README.md) |
| T+0 | MCP directories: awesome-mcp-servers PR, Glama claim, mcp.so, Smithery | Exact entries and steps in [`LISTINGS.md`](LISTINGS.md). The MCP Registry listing is done by the release |
| 15:00 | **Show HN** | 9:00 US Eastern. Post the first comment yourself straight away. Stay for 2–3 hours to answer |
| 15:30 | X / Bluesky / Mastodon thread | Link the HN post only if it is doing well |
| T+1 day | Reddit: r/mcp, r/ClaudeAI; r/Switzerland only if its self-promotion rules allow it (check the sidebar first) | One subreddit per hour, not all at once |
| T+2 days | Swiss open-data community: opendata.ch (association), opendata.swiss showcase of applications, Swiss AI meetups | Strongest local signal; these are the people who publish the data |
| T+1 week | Short courtesy note to opendata.swiss / BFS / swisstopo open-data teams | Template in ANNOUNCEMENT.md. Not a permission request |

Do not announce a hosted API, an SLA or paid tiers. Neither exists yet (§6).

## 5. The first 72 hours

- **Issues**: answer every new issue within a day. Label `bug` / `data-source` / `question`.
  A broken upstream is usually upstream drift: check the nightly live canary (issue labelled
  `live-canary`) and `npx swissyphus doctor` first.
- **Hotfix path**: fix on a branch → PR → merge → bump to `1.0.1` everywhere (package.json,
  server.json, manifest; RELEASING step 2) → CHANGELOG → tag `v1.0.1`. npm versions are
  immutable: never unpublish, deprecate instead (`npm deprecate swissyphus@1.0.0 "…"`).
- **Upstream complaints**: if a provider asks you to reduce or stop traffic, comply at once by
  disabling the module (presets / `HOSTED_EXCLUDED` for hosted), reply, and record it in
  `docs/outreach/README.md`.
- **Watch**: GitHub stars and traffic (Insights → Traffic), npm weekly downloads, HN/Reddit
  threads, the canary issue.

## 6. Later: hosted API soft launch (separate gate)

The public REST API and remote MCP endpoint are a second launch. Do not start until these
hold:

- [ ] Outreach emails sent ([`docs/outreach/`](../outreach/README.md), BACKLOG #9). They are
      the long pole: providers take weeks to reply.
- [ ] A domain, and a VPS deployed per [`deploy/README.md`](../../deploy/README.md). It uses the
      `hosted` preset, which already leaves out modules whose terms are unconfirmed.
- [ ] Off-site backups automated and one restore tested; an external uptime check
      (deploy/README §6–7).
- [ ] Privacy notice and ROPA reviewed with the real operator address.
- [ ] Then: add a `remotes` entry (`streamable-http`, `https://<domain>/mcp`) to `server.json`
      and release a patch so the MCP Registry lists the hosted endpoint.

Paid tiers stay off until the triggers in BACKLOG #6 fire.

## 7. Success measures for the first month

| Signal | Healthy |
|---|---|
| Install works | No open "npx fails" or ".mcpb won't open" issue older than 2 days |
| Upstreams | Live canary green at least 25 of 30 nights |
| Adoption | npm weekly downloads and GitHub stars trending up after week 1 (no target; baseline first) |
| Community | At least one outside contributor PR or data-source request |
| Relationships | Replies recorded for at least 3 of the 5 outreach emails |
