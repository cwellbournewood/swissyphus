# Swissyphus — Path to 1.0 Backlog

Shared planning doc, tracked in the repo (not gitignored) so any agent or contributor working
off `main` has a single source of truth for outstanding go-live work. Generated from a gap
analysis between the state at the time (v0.4.0, no tags/releases) and "deployed, go-live 1.0
ready."

**If you pick up one of these items:** update its status and check off its validation criteria
in the same PR that does the work, so the doc stays truthful. Add new items here rather than
starting a separate tracker.

**Related docs**
- [`docs/READINESS_REVIEW.md`](docs/READINESS_REVIEW.md) is the go-live readiness review from
  2026-09-26. It has the security findings (S1–S12), the data-correctness defects, the licensing
  risks and the phased gameplan. This checklist tracks the *release/ops* items. The review
  tracks the code work.
- [`docs/SCALING.md`](docs/SCALING.md) is the scaling and engineering epic (formerly
  `backlog.md`). It was renamed because `backlog.md` and `BACKLOG.md` collide on
  case-insensitive file systems. It is **not** a go-live prerequisite for a single-VPS launch.
- [`docs/RELEASING.md`](docs/RELEASING.md) is the release runbook.
  [`CHANGELOG.md`](CHANGELOG.md) holds the release notes.
- [`docs/outreach/`](docs/outreach/README.md) has the licensing and data-access emails to
  upstream providers, with a tracker.

**👤 Owner-only** marks steps that need a human with admin rights on the GitHub repo or the
npm account, or that involve sending email as the controller. No agent or CI job can do them.

### Release readiness snapshot (2026-11-08)

**Go-live is now one ordered checklist: [`docs/launch/GO_LIVE.md`](docs/launch/GO_LIVE.md)**, with
announcement copy for every channel in [`docs/launch/ANNOUNCEMENT.md`](docs/launch/ANNOUNCEMENT.md).

Since the 2026-11-07 snapshot below: #13–#16 merged (429-aware breaker, per-source max-stale,
on-disk last-known-good store, ZEFIX failover, `tools/list` snapshot); the sanctions cold-start
that kept the live canary red is fixed; the `hosted` preset (review R-18) exists and the VPS
compose file uses it; `server.json` and the release workflow publish to the official MCP
Registry; image, release and canary run on Node 24. **441/441 offline tests.** Canary run from
the release branch on GitHub: smoke 86/86, REST 29/29, doctor 53/54 (one transient portal
timeout). `swissyphus` is still unclaimed on npm.

### Release readiness snapshot (2026-11-07)

All engineering work is merged and **`v0.5.0` is ready to tag**. The 27-commit catalogue
expansion (`claude/youthful-curie-nr532d`, 33 modules / 123 tools; 41 / 143 after the second expansion) was merged with the 0.5.0
hardening and the live-canary fixes into one release. CI's checks pass locally: 403/403 offline
tests, `npm audit --omit=dev` clean (after a zod 4 and MCP SDK 1.32 upgrade), `manifest.json` and
`tools.schema.json` fresh, `mcpb validate` OK.

The release artefacts were built and smoke-tested from a clean checkout:
- **npm:** `npm pack` → 309 kB, 63 files (only `dist` and the docs listed in `files`). A clean
  install of the tarball starts the stdio server and serves all 123 tools. `swissyphus` is still
  **unclaimed** on npm (`npm view swissyphus` → 404).
- **Docker:** the production image (274 MB, `node:22-alpine`) starts in HTTP mode, runs as `node`,
  answers `/v1/health`, REST, `/openapi.json` and remote MCP, and drains cleanly on SIGTERM.
- **`.mcpb`:** `npm run bundle` → 3.3 MB.

Not verified from the build sandbox: calls to the real upstreams (its network policy blocks
them). The nightly live canary covers them on GitHub.

What is left is owner-only: #0 (repo public), #2 (branch protection), `NPM_TOKEN` secret, pushing
the `v0.5.0` tag (#3), and sending the outreach emails (#9), now including the sources added by
the catalogue expansion.

### Execution order (revised 2026-09-26)

Items keep their numbers, but they run in this order:

1. **#0** Make the repo public 👤, **#2** turn on branch protection 👤, and resolve the
   `backlog.md` filename collision (done: now `docs/SCALING.md`).
2. **Hardening sprint.** Fix S1–S12 from the readiness review. This is the go-live gate for the
   hosted API.
3. **#3** Tag `v0.5.0`. `.github/workflows/release.yml` then creates the GitHub Release, attaches
   the `.mcpb` bundle, runs **#4** (the GHCR image) and runs **#7a** (npm, if `NPM_TOKEN` is
   set).
4. **#7a Claim the npm name with `0.5.0`.** This was moved up from "last" (see #7 for why).
5. **#5 / #6** Decisions are recorded below: OAuth is deferred and billing is off at launch.
6. Data-correctness sprint and licensing replies, then soft launch on the VPS.
7. **#7b / #8** Publish `1.0.0` to npm and cut the `v1.0.0` release.

---

## 0. Make the GitHub repository public 👤 Owner-only

**Status:** ❌ not started. This is a newly discovered blocker and outranks everything below it.
It also blocks npm `--provenance`, which only works for public repositories.

### Specification
`cwellbournewood/swissyphus` is currently a **private** repository
(`visibility: "private"` per the GitHub API). This wasn't accounted for in the original gap
analysis and undermines the "public infrastructure" premise of the whole project:

- The GHCR image published by item 4's workflow inherits the repo's visibility — a private repo
  produces a **private** package by default. `docker pull ghcr.io/cwellbournewood/swissyphus`
  from an anonymous machine will fail with an auth error until this is fixed (validated:
  `workflow_dispatch` run on 2026-07-10 succeeded, but pull access is unverified/likely blocked).
- README links (issues, homepage, `git clone` in `deploy/README.md`) 404 for anyone without
  collaborator access.
- MIT license + "public Swiss OGD infrastructure" framing implies public availability that
  doesn't exist yet.
- npm publish (item 7) doesn't strictly require a public repo, but shipping a public npm
  package whose linked source is inaccessible undermines trust and the `repository`/`bugs`
  fields in `package.json`.

No tool in this session's GitHub MCP toolset exposes repository visibility changes (no
`update_repository`-style admin call) — this requires a human with admin rights.

### How to fix
GitHub → repo → Settings → General → Danger Zone → **Change visibility** → Make public. Then
verify (or explicitly set) the GHCR package's own visibility at
`https://github.com/users/cwellbournewood/packages/container/swissyphus/settings` — package
visibility can be independently pinned even after the source repo goes public.

### Success validation criteria
- [ ] `GET /repos/cwellbournewood/swissyphus` reports `"private": false`
- [ ] `docker pull ghcr.io/cwellbournewood/swissyphus:v0.4.0` succeeds from a machine with no
      GitHub auth configured
- [ ] README links (issues, homepage) resolve for a logged-out browser

---

## 1. Merge PR #1 — correctness fixes, resource caps, first test suite + CI

**Status:** ✅ done — merged into `main` (squash) as commit `4ae69e6`, both CI checks (Node
20.x/22.x) green before merge.

### Specification
Land https://github.com/cwellbournewood/swissyphus/pull/1 as-is (or after addressing any
review feedback). It fixes 6 correctness bugs (earthquakes event-type fabrication, geo solar
class 0, fx month-skip on day 29–31, energy EV-charger NaN guard, airquality distance-sort
gate, parliament OData date-timezone drop), bounds the previously-unbounded HTTP cache (5k-entry
cap, oldest-first eviction), fixes rate-limiter bucket clearing, and adds the first offline unit
test suite (`node:test`, 17 cases) plus a GitHub Actions CI workflow (build + test on Node 20/22).

### Success validation criteria
- [x] PR #1 shows all checks green (or checks re-run clean after fixups)
- [x] `npm run build` passes with strict TypeScript on the merged `main`
- [x] `npm test` passes locally on `main` (17/17)
- [x] `git log main` shows the merge commit; PR is closed as merged
- [ ] Spot-check: `get_earthquakes` no longer returns a fabricated `event_type`; `fx` monthly
      lookup on the 29th–31st returns the correct month (not yet independently re-verified
      post-merge)

---

## 2. Enable CI enforcement on `main` 👤 Owner-only (branch protection)

**Status:** in progress. `.github/workflows/ci.yml` now exists on `main` (landed via PR #1) and
has run successfully on subsequent PRs (#2, #3) — but branch protection requiring it is not yet
turned on, so it's currently advisory, not enforced.

CI was extended for 0.5.0. It now runs every `test/*.test.mjs` suite, `npm audit --omit=dev
--audit-level=high`, and staleness checks for both `manifest.json` and `tools.schema.json`. A
new `docker-build` job builds the image and health-checks it on every PR. The owner should
require these checks: **`build-and-test (20.x)`**, **`build-and-test (22.x)`** and
**`docker-build`**. Set this up under Settings → Branches → Add rule for `main` → "Require status
checks to pass before merging".

A nightly **live canary** (`.github/workflows/live-canary.yml`) runs `doctor`, `test/smoke.mjs`
and `test/rest.mjs` against the real upstreams. On failure it opens or updates one issue
labelled `live-canary`, and it closes that issue on the next green run. It is informational and
is **not** a required check.

### Specification
Turn on branch protection so that CI is a required check before merge — nothing lands on `main`
without build + tests passing, so the codebase never regresses to the pre-PR-#1 unverified
state.

### Success validation criteria
- [ ] `.github/workflows/ci.yml` exists on `main` and has at least one successful run against
      `main`
- [ ] Branch protection rule on `main` requires the CI check to pass before merge
- [ ] A deliberately-broken test PR (or dry run) is correctly blocked from merging

---

## 3. Establish a release process and cut a pre-1.0 baseline tag

**Status:** 🟡 automation landed and `main` is release-ready (2026-11-07); the first tag is not yet
cut. `.github/workflows/release.yml`
runs on any `v*` tag push. It checks that the tag matches `package.json` and `manifest.json`,
builds and tests, creates the GitHub Release with notes from the matching
[`CHANGELOG.md`](CHANGELOG.md) section, attaches `swissyphus.mcpb`, then publishes the GHCR image
and (optionally) npm. The process is documented in [`docs/RELEASING.md`](docs/RELEASING.md). The
first tag will be **`v0.5.0`**, cut after the hardening sprint. `v0.4.0` will not be tagged
retroactively.

👤 Owner-only: pushing the tag (`git push origin v0.5.0`) is the release trigger.

### Specification
Define how versions get tagged (manual `git tag` + GitHub Release, or automated via a workflow
on `package.json` version bump). Cut an initial tag (e.g. `v0.4.0` or `v0.5.0` reflecting
items 1–2 landing) so there's a known-good reference point before the remaining go-live work.

### Success validation criteria
- [ ] `git tag -l` shows at least one version tag
- [ ] A corresponding GitHub Release exists with release notes
- [ ] Release notes generation process is documented (even if manual) so v1.0.0 follows the
      same pattern

---

## 4. Publish the Docker image

**Status:** in progress. Automation landed: `.github/workflows/docker-publish.yml` builds and
pushes a multi-arch image to **GHCR** (`ghcr.io/cwellbournewood/swissyphus`). GHCR was chosen
over Docker Hub because it needs no separate account or secrets. The workflow is now a
reusable workflow (`workflow_call`) that `release.yml` calls on every `v*` tag. It can still be
run by hand via `workflow_dispatch`.

The old `release: published` trigger was dropped. Releases are created by `release.yml` with
`GITHUB_TOKEN`, and GitHub deliberately does not start other workflows from events that
`GITHUB_TOKEN` causes, so that trigger would never have fired. The README and
`deploy/docker-compose.yml` now use the GHCR image name. Not yet fired: no tag has been pushed.

👤 Owner-only: after the first publish, check that the GHCR package is **public** (see #0).

### Specification
Two registry options — pick one (or both):

- **GHCR (`ghcr.io/cwellbournewood/swissyphus`)** — simplest to bootstrap: no separate account,
  auth is automatic via `GITHUB_TOKEN` inside GitHub Actions, tied directly to this repo, free
  for public images.
- **Docker Hub (`swissyphus/server`)** — what the README/Dockerfile comments currently name;
  better standalone discoverability, but requires a Docker Hub org/account and a
  `DOCKERHUB_USERNAME` + `DOCKERHUB_TOKEN` (access token, not password) added as repo secrets.

Recommended: automate via a GitHub Actions workflow triggered on release-tag push
(`on: release: types: [published]`), using `docker/setup-buildx-action` +
`docker/build-push-action` to build **multi-arch** (`linux/amd64`, `linux/arm64`) and push both
`:<version>` and `:latest` tags. Manual fallback if automation is deferred:

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t swissyphus/server:1.0.0 -t swissyphus/server:latest \
  --push .
```

(swap the tag prefix for `ghcr.io/cwellbournewood/swissyphus` if using GHCR)

### Success validation criteria
- [ ] Registry account/org created (Docker Hub) or GHCR visibility set to public
- [ ] Image builds and pushes successfully for both `linux/amd64` and `linux/arm64`
- [ ] From a clean machine with no local build: `docker pull <image>:latest` succeeds
- [ ] `docker run -p 8000:8000 <image>:latest` boots and `curl localhost:8000/v1/health`
      returns healthy
- [ ] Container `HEALTHCHECK` reports `healthy` via `docker ps`
- [x] README's `docker run -p 8000:8000 swissyphus/server` command is updated if the final
      image name/registry differs from what's currently documented (now
      `ghcr.io/cwellbournewood/swissyphus`)

---

## 5. Decide OAuth scope for the hosted remote MCP endpoint

**Status:** ✅ decision recorded on 2026-09-26: **OAuth is deferred past 1.0.** The owner can
reverse this.

### Decision
At launch, the hosted `/mcp` endpoint and the REST API use **API-key auth plus per-IP / per-key
rate limits**, as they do today. OAuth (MCP authorization spec) is deferred past 1.0 and tracked
as [`docs/SCALING.md` VAL-28](docs/SCALING.md).

Why API keys are an acceptable interim control:
- Every tool is **read-only** over **public** data. A key authorizes rate and quota, not access
  to anything private. The only personal data behind auth is the key holder's own email and
  usage count (see [`ROPA.md`](ROPA.md)).
- Once the 0.5.0 hardening lands, the blast radius of an abusive caller is bounded by: a
  client IP that cannot be spoofed (`SWISSYPHUS_TRUST_PROXY` only behind Caddy), a request body
  cap, an upstream response cap, a byte-bounded cache, a cached health endpoint and single-flight
  upstream fetches.
- Keys travel in `Authorization: Bearer` / `X-API-Key` headers, which CORS now allows, so
  browsers don't need `?api_key=`.

Revisit OAuth when any of these happens: a tool that acts on user-specific or non-public data
is added; billing is turned on (#6); or a major MCP client stops supporting static bearer
tokens for remote servers.

### Success validation criteria
- [x] Written decision recorded (in this backlog or README) on OAuth-for-1.0 vs. deferred
- [ ] If deferred: rate limits and API-key auth on `/mcp` are confirmed sufficient and tested
      against abuse (e.g. key-less request is rejected/rate-limited as expected). This is
      covered by the offline `test/http-server.test.mjs` suite in the hardening sprint. Tick it
      once that suite covers XFF spoofing, the body cap and the anonymous limit on `/mcp`.
- [ ] ~~If included: OAuth flow implemented and a client can authenticate against `POST /mcp`
      end-to-end~~ (n/a, deferred)

---

## 6. Decide billing activation plan

**Status:** ✅ decision recorded on 2026-09-26: **billing is OFF at launch.** The trigger values
below are placeholders. 👤 **Owner's decision:** confirm or change them.

### Decision
Launch 0.5.0 and 1.0 with **metering on and billing off**. All tiers stay free of charge, as
the README says. Pro is granted by hand via `/v1/admin/keys`.

**Trigger to revisit.** Whichever of these comes first starts the billing work:
1. **Sustained adoption.** More than **100 active keys** (keys with at least 1 request in the
   month) for **2 consecutive months**. *Placeholder: owner to confirm.*
2. **Cost pressure.** Hosting or egress cost goes above **CHF 50/month**, or an upstream asks us
   to reduce volume in a way that needs paid capacity. *Placeholder: owner to confirm.*
3. **Demand.** **Any** written request to pay for Pro/Enterprise, an SLA or a DPA.
4. **Date backstop.** Re-review this decision on **2027-03-31** even if nothing above has
   happened.

Before billing turns on, these must be in place: email verification on `POST /v1/keys`
(readiness review S8), a registered business address (see `PRIVACY.md`), terms of service, and
an updated `ROPA.md` for the payment processor. Engineering is tracked as
[`docs/SCALING.md` VAL-26](docs/SCALING.md).

### Success validation criteria
- [x] Written decision recorded on billing-at-1.0 vs. deferred, with a named trigger if deferred
- [ ] If deferred: `/v1/usage` and `/v1/admin/keys` are confirmed to give the operator enough
      visibility to make the future billing-on call (this already works per the deploy doc;
      the operator should check it against a real deployment after soft launch)
- [ ] ~~If enabled: a real payment path exists and a test key can be upgraded to a paid tier
      end-to-end~~ (n/a, deferred)

---

## 7. npm publish: claim the name with 0.5.0 (7a), then publish 1.0.0 (7b)

**Status:** re-ordered on 2026-09-26. **7a moved up** to happen right after the hardening sprint.
7b stays with the 1.0 release.

### Why the order changed
This item used to say "npm publish is deliberately last because it is the point of no return."
That is true of the **name**, not of the version. `swissyphus` is **currently unregistered on
npm** (`npm view swissyphus` → 404). Anyone can register it today, and a squatted name cannot be
recovered without an npm dispute. A `0.x` version, by contrast, makes no stability promise
under semver. Users of `npx -y swissyphus` get whatever `latest` is, and `0.5.1` can replace
`0.5.0` as often as needed. So the irreversible risk is **not** claiming the name. Publishing
**0.5.0** once the hosted-API hardening is in removes that risk, and it lets real users try
`npx swissyphus` during the data-correctness sprint.

### 7a — publish 0.5.0 (after the hardening sprint)
👤 **Owner-only.** Do one of the following:
- **Automated:** add an `NPM_TOKEN` repo secret (an npm *granular* access token with
  publish rights; on the first publish the package doesn't exist yet, so it needs "all packages"
  scope). The `npm-publish` job in `release.yml` then publishes with `--provenance --access
  public` when `v0.5.0` is pushed. Provenance requires the repo to be **public** (#0). Once the
  package exists, you can switch to npm *trusted publishing* (OIDC) and delete the token.
- **Manual:** `npm login` on your machine, then `npm ci && npm run build && npm publish --access
  public` from the `v0.5.0` checkout.

Pre-publish checklist:
- Confirm `package.json` `version` matches the tag
- Confirm `files` field only ships what's needed (`dist`, `manifest.json`, `README.md`,
  `LICENSE`, `PRIVACY.md`, `ROPA.md`, `BREACH_RESPONSE.md`). This is already correct.
- `npm pack --dry-run` reviewed for unexpected file inclusion
- `npm publish --access public` (the first publish must say public access explicitly)

### 7b — publish 1.0.0
This happens via the same workflow when `v1.0.0` is tagged (#8). It is no longer a special step.

### Success validation criteria
- [ ] `npm view swissyphus version` returns the published version (currently 404)
- [ ] `npx swissyphus` works from a machine with no prior local checkout, completes in under
      60 seconds to first result as the README claims
- [ ] Package page on npmjs.com renders correctly (README, license, links)
- [ ] `claude mcp add swissyphus -- npx -y swissyphus` (the documented one-liner) works
      end-to-end against the published package

---

## 8. Cut the v1.0.0 release

**Status:** blocked on all of the above.

### Specification
After 2–4 weeks of soft launch on 0.5.x with metrics watched (readiness review, Phase 5), tag
`v1.0.0`. That is the actual "go-live" milestone. The release workflow publishes GHCR, npm and
the `.mcpb` bundle at the matching version. 👤 Owner-only: push the tag.

### Success validation criteria
- [ ] `git tag v1.0.0` pushed, GitHub Release published with changelog
- [ ] npm registry, Docker image, and git tag all report the same version (`1.0.0`)
- [ ] End-to-end smoke test from a completely clean environment: install via `npx`, install via
      Docker, both pass `npm run` / container health checks and return live data from at least
      one module (e.g. `get_weather`)

---

## 9. Licensing & data-access outreach 👤 Owner-only (sending)

**Added 2026-11-07:** the catalogue expansion merged for 0.5.0 adds upstreams that are not yet
in the tracker. Before the **hosted** launch, confirm terms (or disable the module in the hosted
preset) for: the Opendatasoft portals (`portals`: SBB, Basel-Stadt, Basel-Landschaft,
St. Gallen, Thurgau), sharedmobility.ch (REST API) and opentransportdata.swiss
(`mobility`), the UID register web service (`uid`), entscheidsuche.ch (`courts`) and the SNB
data portal (`fx`). Wikidata (CC0), geo.admin.ch / STAC, LINDAS and BFS STAT-TAB are federal OGD
or CC0 and need no email. Local stdio use is unaffected.

**Added 2026-11-07 (second expansion):** licence position of the sources added after 0.5.0 prep, for
the **hosted** deployment (local stdio use is unaffected):

| Source (module) | Terms as published | Hosted action |
|---|---|---|
| SECO sanctions list (`sanctions`) | Official federal publication | none — cite SECO |
| FOPH IDD (`health`) | opendata.swiss `terms_by` | none — cite FOPH |
| energiedashboard.ch (`energy`) | `terms_by` for flows/gas/forecasts; **`terms_by_ask`** (commercial use needs permission) for production, consumption, spot price | ask SFOE, or drop those three series from the hosted deployment |
| OpenParlData.ch (`localpolitics`) | CC BY 4.0 | none — attribution in every response |
| I14Y (`i14y`) | Open metadata | none |
| ÖREB cadastres (`cadastre`) | Official public information; only the PDF extract is binding | none — disclaimer in every response |
| EnviDat (`statistics`, portal `envidat`) | Per dataset (CC BY / CC0 / ODbL / WSL policy) | none — licence stated per dataset |
| Open Data Graubünden (`portals`) | Per dataset (OGD terms) | none |
| simap.ch (`procurement`) | No explicit open-data licence; simap.ch terms | **ask Verein simap.ch** before hosted commercial use |
| swisscovery / SLSP (`libraries`) | Not confirmed for redistribution | **ask SLSP**, or keep out of the hosted preset |
| GLAMOS (`glaciers`) | **Scientific and non-commercial use only** | **ask GLAMOS**, or keep out of the hosted preset |

**Status:** drafts ready and none sent. This is the long pole (readiness review §4 / Phase 3),
because providers take weeks to reply. **Send them now**, in parallel with the code sprints.

### Specification
[`docs/outreach/`](docs/outreach/README.md) has ready-to-send drafts for: FOJ/EHRA
(ZefixPublicREST credentials), SLF (commercial redistribution of the bulletin and IMIS data),
SRF (use of RSS headlines in an API), existenz.ch (terms and attribution) and MeteoSwiss (OGD
local forecasts, and moving off the app back-end). The controller must send each one from their
own address. Official contact channels are listed in each draft. Addresses are deliberately not
guessed.

### Success validation criteria
- [ ] Every row in `docs/outreach/README.md` has moved past "not sent"
- [ ] Replies are recorded in the tracker, and the licence register (`list_sources`) and
      `PRIVACY.md` / `ROPA.md` are updated to match
- [ ] ZEFIX credentials (if granted) are set as `ZEFIX_USER` / `ZEFIX_PASS` on the VPS
- [ ] Any source whose terms rule out hosted commercial use is disabled in the hosted preset or
      switched to an official OGD endpoint before 1.0
