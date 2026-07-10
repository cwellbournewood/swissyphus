# Swissyphus — Path to 1.0 Backlog

Shared planning doc, tracked in the repo (not gitignored) so any agent or contributor working
off `main` has a single source of truth for outstanding go-live work. Generated from a gap
analysis between the state at the time (v0.4.0, no tags/releases) and "deployed, go-live 1.0
ready."

**If you pick up one of these items:** update its status and check off its validation criteria
in the same PR that does the work, so the doc stays truthful. Add new items here rather than
starting a separate tracker.

Ordered by dependency. **npm publish is deliberately last** — it's the point of no return
(package names are effectively permanent), so everything upstream of it must be green first.

---

## 0. Make the GitHub repository public

**Status:** ❌ not started — newly discovered blocker, higher priority than everything below it.

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

## 2. Enable CI enforcement on `main`

**Status:** in progress. `.github/workflows/ci.yml` now exists on `main` (landed via PR #1) and
has run successfully on subsequent PRs (#2, #3) — but branch protection requiring it is not yet
turned on, so it's currently advisory, not enforced.

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

**Status:** not started. No git tags, no GitHub Releases exist yet — v0.4.0 in `package.json`
has never been cut as a release.

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
pushes a multi-arch image to **GHCR** (`ghcr.io/cwellbournewood/swissyphus`) on every published
GitHub Release, or on-demand via `workflow_dispatch` — chosen over Docker Hub because it needs
no separate account/secrets. Not yet fired: no release has been published yet (blocked on item
3), and `workflow_dispatch` hasn't been run manually to validate it end-to-end.

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
- [ ] README's `docker run -p 8000:8000 swissyphus/server` command is updated if the final
      image name/registry differs from what's currently documented

---

## 5. Decide OAuth scope for the hosted remote MCP endpoint

**Status:** not started — currently listed as deferred roadmap, but relevant to go-live if the
hosted `/mcp` endpoint will be publicly reachable at launch.

### Specification
Decide: does 1.0 launch with the remote MCP endpoint open (API-key auth only, as today) or is
OAuth required before public exposure? If deferred past 1.0, document that decision explicitly
(so it isn't silently forgotten) and confirm the existing API-key auth model is an acceptable
interim control for the hosted endpoint's blast radius.

### Success validation criteria
- [ ] Written decision recorded (in this backlog or README) on OAuth-for-1.0 vs. deferred
- [ ] If deferred: rate limits and API-key auth on `/mcp` are confirmed sufficient and tested
      against abuse (e.g. key-less request is rejected/rate-limited as expected)
- [ ] If included: OAuth flow implemented and a client can authenticate against `POST /mcp`
      end-to-end

---

## 6. Decide billing activation plan

**Status:** not started. Currently "metering on, billing off" — all tiers free.

### Specification
Decide whether 1.0 go-live ships with billing still off (soft launch / adoption-building phase)
or requires billing turned on for Pro/Enterprise tiers. Document the decision and, if billing
stays off, define the trigger condition for turning it on later (usage threshold, date, etc.)
so it isn't an indefinite default.

### Success validation criteria
- [ ] Written decision recorded on billing-at-1.0 vs. deferred, with a named trigger if deferred
- [ ] If deferred: `/v1/usage` and `/v1/admin/keys` are confirmed to give the operator enough
      visibility to make the future billing-on call (this already works per the deploy doc)
- [ ] If enabled: a real payment path exists and a test key can be upgraded to a paid tier
      end-to-end

---

## 7. npm publish — final step

**Status:** intentionally last. Not started until items 1–6 are resolved.

### Specification
Publish `swissyphus` to the npm registry. This is effectively irreversible (name squatting,
unpublish restrictions after 24h/downloads), so it only happens once build, tests, CI, the
Docker image, and the OAuth/billing decisions above are all settled — this is the "we are ready
to tell the world `npx swissyphus` works" step.

Pre-publish checklist:
- Confirm `package.json` `version` matches the intended 1.0.0 (or chosen) release
- Confirm `files` field only ships what's needed (`dist`, `README.md`, `LICENSE`,
  `PRIVACY.md`, `ROPA.md`, `BREACH_RESPONSE.md`) — already correct as of today
- `npm pack --dry-run` reviewed for unexpected file inclusion
- `npm publish --access public` (first publish must be explicit about public access for a
  scoped or new package)

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
Once npm publish (item 7) succeeds and the Docker image (item 4) is live at the matching
version, tag and release `v1.0.0` — the actual "go-live" milestone.

### Success validation criteria
- [ ] `git tag v1.0.0` pushed, GitHub Release published with changelog
- [ ] npm registry, Docker image, and git tag all report the same version (`1.0.0`)
- [ ] End-to-end smoke test from a completely clean environment: install via `npx`, install via
      Docker, both pass `npm run` / container health checks and return live data from at least
      one module (e.g. `get_weather`)
