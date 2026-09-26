# Swissyphus — Go-Live Readiness Review

**Date:** 2026-09-26 · **Scope:** whole repo at `main` @ `ed57c5b` (v0.4.0) · **Method:** full read of
`src/core`, `src/*.ts`, deploy/CI/docs; line-level audit of all 25 modules; local reproduction of
server-side defects. No outbound access to the Swiss upstreams was available, so live tests
(`test/smoke.mjs`, `test/rest.mjs`) were **not** run and upstream-behaviour findings are marked
*unverified* where they rest on API knowledge rather than a live response.

Companion docs: [`BACKLOG.md`](../BACKLOG.md) (go-live checklist) and [`docs/SCALING.md`](SCALING.md)
(scaling epic, formerly `backlog.md`). This review adds what those two miss; it does not repeat them.

> **Status update (0.5.0 work, same day):** all code-side items in §2–§5 and Phases 0–4 of the
> gameplan are implemented on branch `claude/blissful-hopper-lr6d7c`. There are 137 offline tests,
> up from 21, and `npm audit` is clean. See [`CHANGELOG.md`](../CHANGELOG.md).
>
> Still open:
> - **Owner-only actions:** make the repo public, turn on branch protection, add the
>   `NPM_TOKEN` secret, push the `v0.5.0` tag, set the GHCR package to public, and send the
>   emails in [`docs/outreach/`](outreach/).
> - **Needs a live check:** the upstream assumptions flagged as *unverified*. The nightly
>   `live-canary` workflow will surface them once it runs against the real sources.
> - **Not done:** the MeteoSwiss OGD/STAC forecast migration.
> - **Still deferred:** the Redis/Postgres scaling epic.

---

## 1. Verdict

| Surface | Readiness | Summary |
|---|---|---|
| **Local stdio MCP (`npx swissyphus`)** | 🟡 **Beta-ready after data fixes** | Solid architecture, clean build, strict TS, 21/21 unit tests pass. No crash paths. But ~10 tools return *silently wrong* answers (see §3) — the worst failure mode for an LLM consumer. |
| **Hosted HTTP API / remote MCP** | 🔴 **Not ready for public exposure** | Five verified defects let an anonymous caller bypass rate limits, mint unlimited keys, exhaust memory, or lose every stored key (see §2). All are small fixes (≈2–3 days total). |
| **Release/distribution** | 🟠 **Plumbing exists, never fired** | No tags/releases, repo private, npm name unclaimed, CI not enforced. Well tracked in `BACKLOG.md`. |
| **Legal/licensing** | 🟠 **Gaps for a hosted product** | Several sources are undocumented app back-ends or have terms that don't match what the licence register claims (§4). |

Bottom line: the engineering foundation is good. The code is well structured and each module is one file, with an allowlist, stale-while-revalidate (SWR) caching and consistent envelopes. Getting to go-live takes **one hardening sprint, one data-correctness sprint, and a licensing pass**. It does not need a rewrite. The Redis/Postgres scaling epic in `backlog.md` is **not** a go-live prerequisite for a single-VPS launch.

---

## 2. Hosted-API security & stability (all verified locally)

| # | Sev | Finding | Evidence | Fix |
|---|---|---|---|---|
| S1 | 🔴 | **Client IP is taken from `X-Forwarded-For` unconditionally** (`http-server.ts:304`). Any caller can rotate the header to bypass the anonymous 60/min limit, the 5-signups/IP/day limit and the admin-attempt limit. | 62nd request → 429; the same request with `X-Forwarded-For: 10.0.0.N` → 200. 8/8 signups from one host → 201. | Use `req.socket.remoteAddress` by default; honour XFF only when `SWISSYPHUS_TRUST_PROXY=1` (and take the *right-most* untrusted hop). The shipped Caddy config is safe because Caddy overwrites XFF from untrusted clients, but the README-documented `docker run -p 8000:8000` path is not. |
| S2 | 🔴 | **Unbounded request bodies** (`readBody`, `:130`). | One anonymous 300 MB POST to `/mcp` took RSS from 95 MB to 585 MB. Three in parallel would OOM the 2 GB VPS. | Cap at ~1 MB → 413; add a body read timeout. |
| S3 | 🔴 | **A corrupted `keys.json` silently wipes all keys.** A parse failure logs one line and starts with an empty store, and the next `persist()` overwrites the file (`keys.ts:82-88`). `writeFileSync` isn't atomic, so a crash or full disk mid-write triggers exactly this. | Truncated the file with 8 keys → restart → signup → file now holds 1 key. | Write to `keys.json.tmp` + `fsync` + `rename`. On a parse error, **refuse to start** (or move the bad file to `keys.json.corrupt-<ts>` and alert). |
| S4 | 🟠 | **The process ignores SIGTERM.** `KeyStore` registers `process.once("SIGTERM", flush)`, which replaces Node's default exit. The HTTP server never closes. | Still running 3 s after `kill -TERM`. Every `docker compose up` / deploy waits out the 10 s grace period and then SIGKILLs. | One shutdown handler: `server.close()`, drain, `flushUsage()`, `process.exit(0)`. |
| S5 | 🟠 | **`/v1/health/sources` and `check_source_health` are uncached request amplifiers.** Each call fires ~25 live upstream probes (`registry.ts:124`). With S1, one client can drive ~1,500 upstream requests/min against public government infra. | Code read. | Cache the snapshot for 60 s; refresh in the background. (= backlog SCALE-7; it belongs in go-live, not "scale".) |
| S6 | 🟠 | **Redirects bypass the SSRF allowlist.** `redirect: "follow"` (`http.ts:107`) checks the allowlist only on the first URL. There is also no cap on upstream response size (`res.text()` reads everything; the cache holds up to 5,000 entries × any size). | Code read. | `redirect: "manual"` + re-check each `Location`; stream with a byte cap (e.g. 20 MB); make the cache bounded by bytes, not by entry count. |
| S7 | 🟠 | **CORS blocks the documented browser auth.** `Access-Control-Allow-Headers` omits `Authorization` / `X-API-Key`, and `Allow-Methods` omits `DELETE`. Browsers can only authenticate via `?api_key=`, which leaks keys into logs and history. | Preflight response captured. | Add `Authorization, X-API-Key` and `DELETE`; add `Access-Control-Expose-Headers` for `RateLimit-*`, `X-Monthly-*` and `Mcp-Session-Id`. |
| S8 | 🟡 | **Free keys have no email verification**, so the tier system is advisory. Anyone can mint 240/min keys at will (worse with S1). | — | Acceptable for a soft launch if S1 is fixed and signups are watched. Add magic-link verification before billing. |
| S9 | 🟡 | **Metering and error mapping are off.** Unknown-tool 404s and 400s count against the monthly quota. Every MCP JSON-RPC message (initialize, list, notifications) is metered. Timeouts (AbortError) surface as "Unexpected error… changed format" and map to **404 "No results"** instead of 503. | Code read. | Meter only after validation; wrap AbortError in `SourceError`; map non-source tool errors to 400/422, not 404. |
| S10 | 🟡 | **Weak admin token accepted.** There is no minimum length for `ADMIN_TOKEN`. | — | Refuse to enable admin unless it has at least 32 characters. |
| S11 | 🟡 | **`npm audit`: 5 transitive vulnerabilities (2 high)** in `ip-address`, `fast-uri`, `hono`, `@hono/node-server` and `qs`, all via `@modelcontextprotocol/sdk@1.29`. Low real exposure (those code paths go unused), but they will flag in any due-diligence scan. | `npm audit`. | `npm audit fix` + bump the SDK to 1.30.x. |
| S12 | 🟡 | **Deploy config contradicts the privacy docs.** `docker-compose.yml` doesn't set `SWISSYPHUS_REQUIRE_TLS=1`. `PRIVACY.md`/`ROPA.md` say IPs are "never written to disk", but `[security]` lines go to stderr, which Docker persists in json-file logs indefinitely. `PRIVACY.md` links a README section ("Deploying to production") that doesn't exist. | — | Set the flag in compose; add `logging: { driver: json-file, options: { max-size, max-file } }`; correct the docs. |

---

## 3. Data correctness — silently wrong answers

These are worse than outages: the agent gets a confident, attributed, wrong answer. Items marked ✔ were confirmed in code. Items marked *unverified* rest on upstream-API knowledge and need one live check each.

### HIGH

| Module | Location | Defect |
|---|---|---|
| weather | `weather.ts:253, 377` (+ station list) | The MeteoSwiss `messwerte-*` GeoJSON files are **LV95**, but the code reads `[lon, lat]`. The returned `wgs84` holds metres in the millions, and `near_lat/near_lon` sorting is effectively random. `airquality.ts:78` already handles LV95 for the same kind of data. ✔ (CRS: verify with one live file.) |
| geo | `geo.ts:320` | `irradiation_kwh_m2_year: gstrahlung ?? mstrahlung`. `gstrahlung` is the **whole-roof total** (kWh/yr), not per m², so values are off by the roof area (often 100×). ✔ |
| companies | `companies.ts:56-74` | The `LEGAL_FORMS` table is shifted relative to ZEFIX `legalFormId` (3 = AG, 4 = GmbH, 5 = Genossenschaft…). Every AG is labelled "Partnership limited by shares". Very likely; fetch `/legalForm` from ZEFIX instead of hard-coding. |
| law | `law.ts:139-171` | `get_law_by_sr` merges every `ConsolidationAbstract` sharing an SR number (e.g. the repealed and current DSG, both 235.1). The last row wins for `endDate`, so **`in_force` can be wrong** on exactly the headline example in the README. ✔ |

### MEDIUM

- **holidays**: "nationwide" `is_today_holiday` returns true for *any* cantonal holiday (`holidays.ts:150-169`) ✔. "Today" is the UTC date, wrong for the first 1–2 h after Swiss midnight (also `waste.ts:55`) ✔.
- **voting**: `cantonal_majority` ignores half-cantons (`jaStaendeHalb`/`neinStaendeHalb`), so it is wrong on every double-majority vote ✔.
- **weather history**: downsampling picks every Nth point, so for precipitation and sunshine (10-min totals) ~95% of 30-day rainfall disappears.
- **law search**: unanchored `CONTAINS` with no `ORDER BY`; the advertised example "OR" matches every "Verordnung" and returns an arbitrary 15.
- **parliament**: OData `substringof` is case-sensitive, so "klimaschutz" or "müller" return "not found". The member-search description promises a party filter that doesn't exist.
- **avalanche** *(unverified)*: the SLF CAAML features are per bulletin, not per region. `region_count` counts bulletins, region names are lost, and `danger_rating` is an array of words, not the documented 1–5.
- **earthquakes**: the SeisComP instance (`sc25a`) is hard-coded in event lookup, so other instances can't be resolved. Missing magnitude becomes M0.0. The `date_to` end day is excluded. *Unverified:* SED text output may carry an `EventType` column, in which case quarry blasts are presented as earthquakes.
- **airquality**: the PM10 daily-limit exceedance allowance is stated as 1/yr; the LRV allows 3 (verify against the current LRV).
- **alerts**: uses an undocumented AEM JSON path. A shape change reads as **"no active alerts"**, which is dangerous for a warnings tool. Fail loudly when the `alerts` key is missing.
- **hydrology**: the example station IDs in the tool description point to the wrong stations, and the LLM will copy them.
- **companies**: `get_company` by name silently takes the first fuzzy hit. A numeric UID without `CHE` is treated as EHRAID, and the resulting 404 is shown as "ZEFIX unavailable".
- **energy**: the EV-charger dataset (multi-MB) is re-`JSON.parse`d on every call, including cache hits. Each connector counts as a "station".
- **lindas**: the `LIMIT` guard is fooled by a subquery `LIMIT`. `SERVICE` federation isn't blocked (Swissyphus becomes a relay). No max query length or response-byte cap.

A long tail of LOW items (diacritic-sensitive region filters, `null` FX rates, `- Zürich` postcode labels, POIs returned as "stations", stale health-probe dates in fx, …) is in the audit notes. Fix them opportunistically.

**Root cause:** `test/smoke.mjs` checks that keys *exist*, not that values are *right*, and nothing runs against live sources on a schedule. See §6, Phase 2.

---

## 4. Source & licensing risk (hosted product)

| Source | Issue | Action |
|---|---|---|
| ZEFIX | Uses `ZefixREST`, the web app's internal back-end, keyless. The supported machine API is `ZefixPublicREST` with FOJ-issued Basic-auth credentials. | Apply for credentials; support `ZEFIX_USER`/`ZEFIX_PASS` and keep the current path as fallback. |
| MeteoSwiss forecast | `app-prod-ws.meteoswiss-app.ch` is the mobile-app back-end, not OGD, so the "Swiss OGD" licence label doesn't cover it. | Migrate to MeteoSwiss OGD local forecasts on data.geo.admin.ch (STAC). |
| existenz.ch | Third-party private proxy used for hydrology and weather history, and not credited. | Attribute it, check its terms, and consider going direct to BAFU/MeteoSwiss OGD. |
| SRF news | The manifest says "headlines/links only", but the code republishes 300-character summaries. SRF RSS terms are personal/non-commercial. | Drop the summaries or get permission. |
| SLF | Bulletin/IMIS redistribution terms are unconfirmed for commercial use. | Confirm with SLF. |
| OpenHolidays | ODbL is share-alike; the register says attribution only. | Correct the licence text. |
| ROPA | "No sub-processors", yet Infomaniak hosts the data. | List the hosting provider as a processor. |

A hosted service also sends every user's traffic from **one egress IP** to per-IP fair-use sources (transport.opendata.ch especially). That makes caching and coalescing (§5) a go-live requirement, not an optimisation.

---

## 5. Optimisation opportunities (ranked by value/effort)

1. **Single-flight on cache miss** (backlog SCALE-2). N concurrent identical misses currently cause N upstream fetches. Doing this in memory is ~30 lines and protects upstreams more than anything else.
2. **Stale-if-error.** Past the 6×TTL window, a failed fetch is a hard error even when an old body is sitting there. Serve it with `cache_status: "stale"` plus its age (RES-12).
3. **Cache hygiene.** Bound the cache by bytes (not 5,000 entries of any size). Make it a true LRU (re-insert on hit; today it's FIFO despite the comment). Cache *parsed* objects for large payloads (EV chargers, SLF, measurements).
4. **Token efficiency for LLM clients.**
   - `respond()` pretty-prints with 2-space indent; compact JSON saves roughly 20–30% of the tokens in every tool result.
   - The full `source` block repeats on every call. Consider the `attribution` string plus a `source_id`, with the full block available via `list_sources`.
   - `tools/list` for the default `full` preset is **~49 KB (~12k tokens) of context per session** (outdoor 25 KB, minimal 15 KB). Tighten descriptions, or default the `.mcpb` bundle to a smaller preset.
5. **`/mcp` builds a new `McpServer` with 71 tools on every POST** (SCALE-6). Build once. Likewise, precompile `z.object(inputSchema)` per tool at startup instead of per REST request.
6. **Per-host circuit breaker + concurrency cap** (RES-11, SCALE-9). A dead source currently costs up to 2×timeout + 0.6 s (≈91 s for the 45 s calls) on every request.
7. **`Cache-Control`/`ETag`** on catalogue, OpenAPI and sources, and on anonymous tool GETs (SCALE-10). Cheap, and lets Caddy or a CDN absorb read traffic.
8. **Observability:** a `/metrics` endpoint (per-source error rate, latency, cache hit rate, 429s) plus structured logs (RES-14). Without these you learn you've been IP-blocked upstream from users.

**Defer** until real traffic justifies it: Redis/Postgres (SCALE-1/3/4/5), multi-replica, webhooks, OAuth, billing. One well-cached Node process on the planned VPS will serve far more than early-launch load.

---

## 6. Gameplan

### Phase 0 — Admin & hygiene (½ day, owner-only actions)
- [ ] Make the repo public; set the GHCR package to public (`BACKLOG.md` #0).
- [ ] Turn on branch protection requiring CI (#2).
- [ ] **Claim the npm name early.** `swissyphus` is currently unregistered (`npm view` → 404). The *name* is the irreversible part, not a 0.x version. Publishing `0.5.0` after Phase 1 removes the squatting risk and lets real users try it. Suggest re-ordering `BACKLOG.md` #7 accordingly.
- [ ] Resolve the `BACKLOG.md` / `backlog.md` filename collision. On macOS/Windows (case-insensitive file systems) only one survives checkout and git shows a permanent diff. Rename `backlog.md` → `docs/SCALING.md`.
- [ ] Fix the stale identity strings: User-Agent `swissyphus/0.1.0 (…github.com/swissyphus)` in `http.ts:12` and `registry.ts:138`, and the `meta.ts` source URL. Derive the version from `package.json`.

### Phase 1 — Hosted hardening sprint (2–3 days) → *go-live gate for the HTTP API*
S1–S7, S9–S12 from §2, plus single-flight (§5.1) and a response-byte cap. Add an offline `node:test` suite for `http-server` (rate limit, XFF, body cap, CORS, auth, SIGTERM, key-store corruption), which currently has no automated coverage.

### Phase 2 — Data-correctness sprint (≈1 week) → *go-live gate for "trustworthy answers"*
- [ ] Fix every HIGH and MEDIUM item in §3.
- [ ] **Fixture-based contract tests:** capture one real response per upstream into `test/fixtures/` and unit-test each parser against it for *values* (coordinates in CH bounds, per-m² irradiation in 800–1,500, AG ↔ legalFormId 3, …).
- [ ] **Nightly live canary:** a scheduled GitHub Actions workflow runs `test/smoke.mjs` and `swissyphus doctor` and opens or updates an issue on failure. With 25 unofficial-ish upstreams, drift is certain; this catches it before users do.

### Phase 3 — Licensing & sources (parallel with Phase 2; mostly emails)
Everything in §4. ZEFIX credentials and SLF/SRF confirmations have external lead times, so **start them now**.

### Phase 4 — Release & soft launch (1–2 days)
Tag `v0.5.0`, then publish GHCR, publish npm, and deploy to the Infomaniak VPS with log rotation, an external uptime check and a nightly `keys.json` backup. Soft-launch with metering on and billing off (record that decision in `BACKLOG.md` #6). Keep OAuth deferred and write down that deferral (#5).

### Phase 5 — 1.0 and beyond
Watch metrics for 2–4 weeks, then cut `v1.0.0`. Next: observability, circuit breakers, stale-if-error, token-efficiency work, and the `.mcpb` default preset. Take the Redis/Postgres epic from `backlog.md` only when a second replica is actually needed.

**Critical path:** Phase 0 → Phase 1 → (Phase 2 ∥ Phase 3) → Phase 4. That is roughly **2–3 weeks of focused work** to a credible public launch, with the licensing emails as the long pole.
