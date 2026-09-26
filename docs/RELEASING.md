# Releasing Swissyphus

Releases are **tag-driven**. You prepare a release commit on `main`, then push a `vX.Y.Z` tag, and
[`.github/workflows/release.yml`](../.github/workflows/release.yml) does the rest. Every release,
including `v1.0.0`, follows these steps.

👤 marks **owner-only** steps, which need push rights to tags, repo admin rights or the npm
account.

## One-time setup (👤 owner)

| What | Where | Why |
|---|---|---|
| Make the repo **public** | Settings → General → Danger Zone | GHCR pulls without auth, working README links, and npm `--provenance`, which only works for public repos. See `BACKLOG.md` #0 |
| **Branch protection** on `main`: require `build-and-test (20.x)`, `build-and-test (22.x)` and `docker-build` | Settings → Branches | Nothing reaches `main` (and therefore a tag) without passing CI. See `BACKLOG.md` #2 |
| Optional **tag protection**: restrict who can create `v*` tags | Settings → Rules → Rulesets → target tags `v*` | A tag push publishes to GHCR and npm |
| **`NPM_TOKEN`** repo secret: an npm *granular access token* with publish rights. The first publish needs "all packages" scope, because the package doesn't exist yet | Settings → Secrets and variables → Actions | Lets the `npm-publish` job run. Without it, the job skips with a notice and you publish by hand (see below). After the first publish, consider npm *trusted publishing* (OIDC) and delete the token |
| After the first image push: GHCR package visibility → **Public** | `https://github.com/users/cwellbournewood/packages/container/swissyphus/settings` | Package visibility can differ from repo visibility |

## Release steps

Examples use `0.5.0`. Replace it with the version you are releasing.

1. **Pick the version** ([semver](https://semver.org)). In `0.x`, bump the minor version for
   anything user-visible or breaking and the patch version for fixes only. Pre-releases
   (`0.5.0-rc.1`) are published as GitHub pre-releases, under the npm dist-tag `next`, and do
   **not** move Docker `:latest`.

2. **Bump the version in all three places** on a release branch:
   ```bash
   git switch -c release/v0.5.0
   npm version 0.5.0 --no-git-tag-version      # package.json + package-lock.json
   # src/server.ts: update VERSION, unless it is already derived from package.json
   npm run manifest                            # rebuilds, rewrites manifest.json with the new version
   npm run build && npm run catalogue          # refresh tools.schema.json (CI checks it's fresh)
   ```

3. **Update [`CHANGELOG.md`](../CHANGELOG.md).** Rename `## [Unreleased]` to
   `## [0.5.0] - YYYY-MM-DD`, reconcile its entries with what actually merged
   (`git log <previous tag>..HEAD --oneline`. For 0.5.0, which has no previous tag, use `ed57c5b..HEAD`), and add a fresh empty
   `## [Unreleased]` above it. Update the compare links at the bottom. The release notes are
   copied verbatim from this section, and **the release fails if the section is missing**.

4. **Verify locally:**
   ```bash
   npm ci && npm test                          # all offline suites
   npm audit --omit=dev --audit-level=high
   npm run test:live && npm run test:rest      # live upstreams. Investigate failures before releasing
   npm pack --dry-run                          # check that only dist/, manifest.json and the docs ship
   npm run bundle                              # optional: try swissyphus.mcpb in Claude Desktop
   ```

5. **Open a PR** (`Release v0.5.0`), let CI pass, and merge it to `main`.

6. 👤 **Tag the merge commit and push the tag:**
   ```bash
   git switch main && git pull
   git tag -a v0.5.0 -m "Swissyphus v0.5.0"
   git push origin v0.5.0
   ```

## What the automation does

`release.yml` runs when the tag is pushed:

| Job | Does | Fails if |
|---|---|---|
| `release` | Checks the tag against `package.json`, `manifest.json` and a literal `VERSION` in `src/server.ts`. Runs `npm ci`, `npm test`, `npm audit --omit=dev --audit-level=high` and `npm run bundle`, and checks `manifest.json` is unchanged. Extracts the CHANGELOG section. Creates the GitHub Release (or updates it, if one already exists) with those notes and **`swissyphus.mcpb`** attached | Versions disagree, tests or audit fail, the manifest is stale, or the CHANGELOG section is missing |
| `docker` | Calls [`docker-publish.yml`](../.github/workflows/docker-publish.yml), which builds `linux/amd64` + `linux/arm64` and pushes `ghcr.io/cwellbournewood/swissyphus:v0.5.0` and `:latest` (stable tags only) | The build fails |
| `npm-publish` | If `NPM_TOKEN` is set: `npm publish --provenance --access public` (dist-tag `latest`, or `next` for pre-releases). Skips if that version is already on npm | The repo is private (provenance), or the token lacks rights |

**Why the Docker job is called directly.** A Release created with `GITHUB_TOKEN` doesn't trigger
other workflows' `on: release` events, because GitHub suppresses them to prevent loops. So
`docker-publish.yml` is a reusable workflow that `release.yml` calls, and it can also be run
manually from the Actions tab (`workflow_dispatch`) to re-publish an image.

## After the release

1. Check the three channels agree:
   ```bash
   gh release view v0.5.0                           # notes and swissyphus.mcpb asset
   docker pull ghcr.io/cwellbournewood/swissyphus:v0.5.0 && \
     docker run --rm -p 8000:8000 ghcr.io/cwellbournewood/swissyphus:v0.5.0   # then curl :8000/v1/health
   npm view swissyphus version                      # 0.5.0
   npx -y swissyphus@0.5.0 --version
   ```
2. 👤 **Manual npm publish**, if `NPM_TOKEN` isn't configured:
   ```bash
   git switch --detach v0.5.0
   npm ci && npm run build
   npm login
   npm publish --access public          # add --provenance only when publishing from CI
   ```
3. 👤 **Deploy** to the VPS: `cd swissyphus/deploy && git pull && docker compose pull && docker compose up -d`
   (see [`deploy/README.md`](../deploy/README.md) §8). Take a manual backup first (§6).
4. Update [`BACKLOG.md`](../BACKLOG.md). Tick the validation criteria for #3, #4 and #7, and
   note the release.

## If something goes wrong

- **Wrong tag, nothing published yet.** Delete it with `git push --delete origin v0.5.0 && git tag -d v0.5.0`,
  fix the problem, and tag again.
- **Transient failure** (network, registry). Re-run the failed jobs. The release step is
  idempotent: it edits the notes and re-uploads the asset.
- **A code or changelog fix is needed.** Re-runs build the *tagged* commit, so a fix on `main`
  isn't picked up. If nothing reached npm yet, delete the Release and the tag
  (`gh release delete v0.5.0 --cleanup-tag`), merge the fix, and tag again. If npm already has
  the version, release a patch instead.
- **Docker publish failed.** Re-run the `docker` job, or run *Docker publish* manually with the tag.
- **Bad npm version.** npm versions are immutable. Publish a patch (`0.5.1`), and use
  `npm deprecate swissyphus@0.5.0 "reason"` rather than `npm unpublish`. Unpublish is limited to
  72 hours, and it blocks the version number forever.
- **Bad Docker `:latest`.** Re-run *Docker publish* with the previous good tag (it re-points
  `:latest`), or pin `SWISSYPHUS_TAG` on the VPS.
