# Swissyphus — Scaling & Engineering Backlog

> Formerly `backlog.md` at the repo root. It was renamed because `backlog.md` and `BACKLOG.md`
> collide on case-insensitive file systems (macOS, Windows). The go-live checklist is
> [`BACKLOG.md`](../BACKLOG.md), and the go-live audit is
> [`docs/READINESS_REVIEW.md`](READINESS_REVIEW.md). This document is **not** a go-live
> prerequisite for a single-VPS launch. Some items were pulled forward into the 0.5.0 hardening
> sprint: SCALE-2 single-flight, SCALE-7 health caching and RES-16 body limits. See
> [`CHANGELOG.md`](../CHANGELOG.md).

Engineering backlog for Swissyphus — the AI gateway to Switzerland. This document
tracks work beyond the current feature set, organized around a primary **scaling
epic** (how to serve hundreds–thousands of concurrent users without breaking) plus
cross-cutting improvements to **resilience**, **accessibility**, **performance**,
**observability**, and **product value**.

Each item states the *problem* (grounded in the current code), a *proposal*, and
*acceptance criteria*. Effort is a rough T-shirt size (S ≤ 1 day, M ≤ 1 week,
L ≤ 1 sprint, XL multi-sprint).

> Status legend: 🔴 blocker for scale · 🟠 important · 🟡 nice-to-have · 🟢 opportunistic

---

## Part 1 — Scaling to hundreds / thousands of users

### Where we are today

Swissyphus is deliberately built as a **single-process, single-instance** service.
Three pieces of state live in the memory of one Node process and are the hard
blockers to running more than one replica:

| State | Location | Today | Breaks at scale because… |
|---|---|---|---|
| HTTP response cache | `src/core/http.ts` — `cache: Map` (5 000-entry LRU) | in-process | every replica has a cold, independent cache → upstream load multiplies by N replicas |
| Rate-limit counters | `src/http-server.ts` — `buckets: Map` | in-process | N replicas ⇒ a client gets N× its intended limit; limits become advisory |
| API keys + monthly usage | `src/core/keys.ts` — `keys.json` | one JSON file, full rewrite per mutation, flushed every 30 s | no file locking, linear scans, lost writes on crash, un-shareable between replicas |

The code itself flags this: `keys.ts` says *"single-instance friendly; move to
Redis/Postgres when a second instance is needed."* This epic is that move, plus the
upstream-protection work that scaling makes non-optional.

### The existential risk: upstream fair-use limits 🔴

Swissyphus fronts ~25 **free public** Swiss OGD sources (ZEFIX, MeteoSwiss, SBB,
swisstopo, Fedlex, …). These are public infrastructure with fair-use expectations,
not commercial APIs with paid quota. At hundreds–thousands of users the failure mode
is **not** our server falling over — it is *our egress IP getting throttled or
blocked by an upstream source*, which takes the whole product down at once. Every
scaling decision below is subordinate to one rule: **the number of requests we send
upstream must stay roughly flat as user count grows.** Caching, request coalescing,
and circuit breaking are what make that true.

---

### SCALE-1 — Externalize the response cache to a shared store 🔴 (L)

**Problem.** `fetchCached` (`src/core/http.ts:144`) caches in a per-process `Map`.
Run 4 replicas and you have 4 cold caches: the effective cache hit-rate falls and
upstream request volume rises ~linearly with replica count — the exact thing we
cannot allow (see existential risk above).

**Proposal.**
- Introduce a `CacheBackend` interface (`get/set/delete`) with two implementations:
  the current in-memory `Map` (default, for `npx`/stdio and local use) and a **Redis**
  backend selected by `SWISSYPHUS_REDIS_URL`.
- Keep the stale-while-revalidate semantics and `cache_status` envelope field intact;
  they move behind the interface unchanged.
- Store `{body, storedAt, ttlMs}` as the value; use Redis `PEXPIRE` at `ttlMs *
  STALE_FACTOR` so dead entries self-evict without the manual `MAX_CACHE_ENTRIES` sweep.
- Preserve the existing cache-key shape (`METHOD url body`).

**Acceptance criteria.**
- With `SWISSYPHUS_REDIS_URL` set, two replicas share cache hits (a `miss` on
  replica A becomes a `hit` on replica B for the same key).
- Redis unavailable ⇒ fall back to in-memory, log once, never 500 (cache is an
  optimization, not a dependency).
- Existing `test/rest.mjs` still passes against the in-memory default.

---

### SCALE-2 — Single-flight / request coalescing on cache MISS 🔴 (M)

**Problem.** The current stampede guard (`inflightRevalidations`, `http.ts:50`) only
covers *background revalidation of stale entries*. On a cold **miss**, N concurrent
requests for the same URL all call `rawFetch` — a classic cache stampede. At scale a
single popular query (weather for PLZ 8001, Bern→Zürich) fans a burst of duplicate
requests straight at the upstream source.

**Proposal.**
- Maintain an in-flight `Map<cacheKey, Promise<string>>`. A miss that finds an
  existing promise awaits it instead of issuing a second fetch.
- For multi-replica deployments, back the lock with Redis (`SET NX PX`) so coalescing
  works *across* replicas, with a short lock TTL and a "lost the race → poll cache
  briefly, then fetch" fallback to avoid deadlock if a holder dies.

**Acceptance criteria.**
- 100 simultaneous requests for one uncached key produce **exactly one** upstream
  fetch (assert via a mock upstream / request counter).
- A crashed lock holder does not wedge the key permanently (TTL-bounded).

---

### SCALE-3 — Move rate limiting to a shared, atomic store 🔴 (M)

**Problem.** `rateLimited()` (`src/http-server.ts:58`) counts in a per-process `Map`.
Behind a load balancer with N replicas, a client's real limit is N× the configured
one, and quotas are unenforceable. Sticky sessions would paper over it but break
autoscaling and fail on replica loss.

**Proposal.**
- Redis-backed fixed-window (or sliding-window / token-bucket) limiter using atomic
  `INCR` + `PEXPIRE`, keyed exactly as today (`key:<hash>` / `ip:<ip>` /
  `signup:<ip>` / `admin:<ip>`).
- Keep the in-memory limiter as the default when no Redis is configured.
- Preserve the `RateLimit-*` / `Retry-After` response headers unchanged.

**Acceptance criteria.**
- Two replicas enforce one shared limit for the same key/IP.
- Redis outage degrades to per-instance limiting (fail-open on the *limiter*, never on
  auth) with a logged warning.

---

### SCALE-4 — Persist keys & usage in a real datastore 🔴 (L)

**Problem.** `KeyStore` (`src/core/keys.ts`) rewrites the **entire** `keys.json` on
every create/revoke/tier-change (`persist()`, line 101), holds all keys in memory,
and does linear scans for `findByEmail`/`eraseByEmail`/`purgeExpiredRevocations`.
Usage is flushed every 30 s (`setInterval`, line 91) so a crash loses up to 30 s of
metering. None of this is shareable between replicas, and the full-file rewrite is
O(n) per write — fine at 100 keys, not at 100 000.

**Proposal.**
- Introduce a `KeyStore` interface; keep the JSON-file implementation as the
  zero-dependency default (local, single-instance, `npx`), add a **Postgres** (or
  SQLite-for-single-node) implementation selected by `SWISSYPHUS_DATABASE_URL`.
- Schema: `api_keys(hash PK, last4, email idx, tier, created, revoked_at)` and
  monthly usage as either a `usage(key_hash, month, count)` table **or** an atomic
  Redis counter (see SCALE-5). Index `email` and `revoked_at`.
- Preserve every guarantee already in place: SHA-256-only storage, one-time raw-key
  return, constant-time admin-token comparison, retention-window purge, self-service
  erasure (nFADP). These are correctness-critical and must not regress.

**Acceptance criteria.**
- Key create/lookup/revoke/erase behave identically to today via the interface
  (existing behavior covered by unit tests).
- Concurrent key creation from two replicas never corrupts the store.
- No full-table rewrite on a single key mutation.

---

### SCALE-5 — Correct, global usage metering & quota enforcement 🔴 (M)

**Problem.** `meter()` (`keys.ts:189`) increments an in-memory counter flushed every
30 s. Across replicas each has its own partial view, so the **monthly quota
(`perMonth`) cannot actually be enforced** — a Free-tier key could burn far past
50 000 by spreading traffic across replicas, and a crash silently drops counts.

**Proposal.**
- Move the monthly counter to an atomic store: Redis `INCR usage:<hash>:<YYYY-MM>`
  with an expiry set past month end, or a Postgres `UPSERT … count = count + 1`.
- Enforce the quota against the shared counter on the request path; keep the
  `X-Monthly-Quota` / `X-Monthly-Used` headers.
- Decide and document the semantics: metering is *billing-grade* (durable, exact) vs.
  *advisory* (fast, may under-count on infra failure). Recommend durable for the
  counter, eventually-consistent for analytics.

**Acceptance criteria.**
- A key at its monthly limit is rejected regardless of which replica it hits.
- Process restart loses **zero** committed usage counts.

---

### SCALE-6 — Reuse the MCP server instance per request 🟠 (S)

**Problem.** `/mcp` calls `buildServer(modules)` and constructs a fresh transport on
**every** POST (`http-server.ts:530`). For a stateless JSON endpoint this rebuilds the
whole tool/resource/prompt registry per request — wasted CPU and allocation under MCP
load.

**Proposal.**
- Build the MCP `Server` once at startup (the tool set is static for a given module
  selection) and, if the SDK's stateless transport allows, reuse it; otherwise cache
  the expensive registry-construction and only create the cheap per-request transport.
- Benchmark before/after with a tight `/mcp` `tools/call` loop.

**Acceptance criteria.**
- `/mcp` throughput improves measurably (target ≥2× on a `tools/list`+`tools/call`
  loop) with identical responses; `test/rest.mjs` MCP checks still pass.

---

### SCALE-7 — Cache the source-health endpoint 🟠 (S)

**Problem.** `GET /v1/health/sources` (`http-server.ts:509`) runs `runHealthChecks()`,
which fires a live probe at **every** upstream source on **every** call
(`registry.ts:124`). It is CORS-enabled and public — a handful of clients (or a naive
uptime monitor) polling it turns Swissyphus into a request amplifier against the very
sources we must protect.

**Proposal.**
- Cache health results for ~30–60 s (shared cache when configured) and serve the
  cached snapshot; refresh on a background interval rather than on the request path.
- Optionally decouple: a background prober writes health into the cache; the endpoint
  only reads.

**Acceptance criteria.**
- N concurrent `/v1/health/sources` calls within the TTL produce **one** round of
  upstream probes, not N.

---

### SCALE-8 — Run more than one core / replica 🟠 (M)

**Problem.** Node is single-threaded; the deployment is one container on a 1-vCPU VPS
(`deploy/docker-compose.yml`, `deploy/README.md`). CPU-bound work (JSON parse of large
upstream payloads, `zodToJsonSchema`, envelope serialization) serializes on one core.

**Proposal.**
- Short term: `node:cluster` (or PM2) to fork one worker per core, sharing the port —
  *only viable after SCALE-1/3/4* make state external, otherwise workers desync.
- Medium term: a horizontally scalable deployment manifest (Kubernetes `Deployment`
  + `HorizontalPodAutoscaler`, or Docker Swarm) with replicas behind Caddy/an LB,
  all pointing at shared Redis + Postgres.
- Add graceful shutdown: on `SIGTERM`, stop accepting new connections, drain in-flight
  requests, flush usage, then exit (today `keys.ts` flushes usage but the HTTP server
  does not drain — `http-server.ts` has no `server.close()` path).

**Acceptance criteria.**
- A rolling restart drops zero in-flight requests and loses zero committed usage.
- Documented, reproducible multi-replica deployment (compose scale or k8s manifest).

---

### SCALE-9 — Outbound connection pooling & concurrency guard 🟠 (S/M)

**Problem.** `rawFetch` uses the global `fetch` with default agent settings. Under high
concurrency to the same upstream hosts there is no explicit keep-alive tuning and no
cap on simultaneous outbound requests — a slow source can pile up in-flight fetches
and pressure the event loop and upstream simultaneously.

**Proposal.**
- Configure an `undici` Agent with keep-alive and sane `connections`/pipelining per
  host.
- Add a per-host outbound concurrency limiter (bulkhead) so one degraded source cannot
  consume all outbound capacity (pairs with SCALE-11 circuit breakers).

**Acceptance criteria.**
- Load test shows stable connection reuse and no unbounded growth of outbound sockets
  when a source slows down.

---

### SCALE-10 — CDN / edge-cacheable public reads 🟡 (S)

**Problem.** `/v1/tools`, `/openapi.json`, `/v1/sources`, the landing page, and many
tool responses are effectively static or slow-changing, but responses carry no
`Cache-Control`/`ETag`, so every hit reaches origin.

**Proposal.**
- Emit `Cache-Control` + `ETag` on public read endpoints and on tool responses,
  derived from the envelope's freshness metadata (e.g. `max-age` ≈ remaining TTL).
- Front the deployment with a CDN (Cloudflare/Fastly) or Caddy caching for anonymous
  GET traffic, keeping metered/authenticated routes `private, no-store`.

**Acceptance criteria.**
- Anonymous catalogue/spec/source reads are served from edge cache; authenticated
  routes are never cached.

---

### Suggested sequencing

1. **Unblock horizontal scale:** SCALE-1, SCALE-3, SCALE-4, SCALE-5 (shared cache,
   rate limits, keys, usage) — nothing else matters until state is external.
2. **Protect upstream:** SCALE-2, SCALE-7, SCALE-11 (single-flight, cached health,
   circuit breakers) — the difference between scaling and getting IP-banned.
3. **Use the hardware:** SCALE-6, SCALE-8, SCALE-9 (MCP reuse, multi-replica, pooling).
4. **Offload origin:** SCALE-10 (edge caching).

---

## Part 2 — Resilience

### RES-11 — Per-source circuit breakers 🟠 (M)

**Problem.** `rawFetch` (`http.ts:97`) does one retry with a fixed 600 ms backoff, then
fails. When a source is genuinely down, *every* request still pays full
timeout + retry (up to ~30 s) before failing — latency spikes and outbound sockets pile
up right when the source is least able to cope.

**Proposal.** A per-host circuit breaker: after K consecutive failures, open the circuit
and fail fast for a cooldown window, serving `last-known-good` stale cache where
available (see RES-12); half-open probes to recover. Surface breaker state in
`check_source_health` and the envelope.

**Acceptance criteria.** A down source fails fast (no 30 s hang) and auto-recovers;
health output reflects `open/half-open/closed`.

### RES-12 — "Last known good" extended-stale serving during outages 🟠 (S)

**Problem.** `STALE_FACTOR = 6` (`http.ts:53`) bounds how long stale data is served.
Past that window a source outage becomes a hard failure even though slightly older data
would be far more useful to an agent than an error.

**Proposal.** When the circuit is open (RES-11) or a fetch fails and a stale entry
exists, serve it with `cache_status: "stale"` and a `notes`/`data_as_of` making the age
explicit, rather than erroring. Cap the maximum served age per source class (e.g.
weather vs. legal texts have very different staleness tolerances).

**Acceptance criteria.** A source outage with a warm cache yields attributed stale data,
not a 503, until a configured max age.

### RES-13 — Negative caching for errors/empties 🟡 (S)

**Problem.** 404/empty and transient upstream errors are not cached, so a repeated bad
query (or a scripted client) re-hits upstream every time.

**Proposal.** Short-TTL negative cache for well-defined "no results" and 5xx, distinct
from success caching, with a much shorter TTL.

**Acceptance criteria.** Repeated identical no-result queries within the negative TTL do
not re-hit upstream.

### RES-14 — Structured logging, metrics & tracing 🟠 (M)

**Problem.** Observability is `console.error` only. At scale you cannot see per-source
error rates, cache hit-rate, p95 latency, rate-limit rejections, or quota exhaustion —
so you cannot tell you are being throttled upstream until it is too late.

**Proposal.** Structured JSON logs; a `/metrics` Prometheus endpoint (RED metrics per
route + per upstream source: request count, error rate, latency histogram, cache
hit/miss/stale, breaker state); optional OpenTelemetry traces. Keep logs PII-free
(consistent with the existing IP-only, non-persisted security logging).

**Acceptance criteria.** A dashboard shows per-source health, cache hit-rate, and
rate-limit/quota rejections in real time.

### RES-15 — Backpressure & load shedding 🟡 (M)

**Problem.** No global concurrency ceiling on inbound requests or the event loop; a
traffic spike can drive latency up unbounded rather than shedding gracefully.

**Proposal.** Bounded inbound concurrency with fast `503 + Retry-After` load shedding
when saturated (or when event-loop lag crosses a threshold), so healthy clients keep
getting fast responses instead of everyone slowing down together.

**Acceptance criteria.** Under overload the service sheds excess load with 503s and keeps
p95 latency bounded for accepted requests.

### RES-16 — Request body size limits & timeouts 🟡 (S)

**Problem.** `readBody` (`http-server.ts:130`) buffers the entire request body with no
size cap; `/mcp` and POST tool bodies are unbounded. A large or slow-loris body ties up
memory/sockets.

**Proposal.** Enforce a max body size (413 on exceed) and a header/body read timeout.

**Acceptance criteria.** Oversized/slow bodies are rejected promptly without memory
growth.

---

## Part 3 — Accessibility & internationalization

### A11Y-17 — Multilingual responses & error messages 🟠 (L)

**Problem.** Switzerland has four national languages (DE/FR/IT/RM) plus English. The
envelope carries a `language` field (`envelope.ts`) but responses, `notes`, and error
messages are English-only. For a civic Swiss tool this is an accessibility gap, not just
a nicety — and several upstreams (Fedlex, MeteoSwiss, ZEFIX) already return localized
data.

**Proposal.** Honor an `Accept-Language` header / `lang` parameter; pass language
through to sources that support it; localize tool error messages and `notes`; set the
envelope `language` to what was actually served. Start with DE/FR/IT/EN.

**Acceptance criteria.** `lang=fr` (or `Accept-Language: fr`) yields French upstream
content where available and French error/notes text, with `language: "fr"` in the
envelope.

### A11Y-18 — Accessible landing / docs page 🟡 (S)

**Problem.** The landing HTML (`http-server.ts:266`) omits `<html lang>`, uses only a
red accent color (`#d52b1e`) without a checked contrast ratio, and is not marked up for
assistive tech.

**Proposal.** Add `<html lang="en">`, verify WCAG AA contrast, add landmarks/skip-link,
ensure keyboard operability, and provide a language switcher consistent with A11Y-17.

**Acceptance criteria.** Page passes an automated a11y audit (e.g. axe) at AA.

### A11Y-19 — Machine-accessibility: richer OpenAPI & examples 🟢 (S)

**Problem.** The generated OpenAPI (`buildOpenApi`) lists parameters but few examples or
response schemas, which limits auto-generated client/doc quality — an accessibility
concern for the machine consumers that are Swissyphus's primary audience.

**Proposal.** Add response schemas for the standard envelope, per-tool examples, and
`operationId`s so generated SDKs and docs are self-explanatory.

**Acceptance criteria.** OpenAPI validates and generates a usable typed client with
examples.

---

## Part 4 — Performance

### PERF-20 — Cache warming for hot queries 🟡 (M)

**Problem.** Cold-cache latency is upstream-bound (up to 15 s timeout). Popular queries
(major-city weather, top station pairs, common PLZ) pay this repeatedly after evictions.

**Proposal.** A background warmer that periodically refreshes a configurable hot-set
(and/or the most-requested keys observed via metrics) so common queries are near-always
warm — with strict rate limits so warming itself respects upstream fair use.

**Acceptance criteria.** Hot-set queries return `hit`/`stale` (never a cold `miss`)
during steady-state traffic.

### PERF-21 — Streaming / pagination for large result sets 🟡 (M)

**Problem.** The envelope hard-caps responses at 50 KB (`envelope.ts:13`) and *withholds*
oversized payloads. Large legitimate result sets (statistics datasets, register
searches, hydrology history) are truncated to an error instead of paginated.

**Proposal.** Cursor-based pagination (`limit`/`cursor`) on list-heavy tools and/or
opt-in streaming for the REST endpoint, keeping the 50 KB cap per page.

**Acceptance criteria.** A large query returns page 1 + a cursor instead of a
withheld-payload error.

### PERF-22 — Precompute static artifacts once 🟢 (S)

**Problem.** `catalogue`, `sources`, `openapi`, and `landing` are already built once at
startup (good). Verify nothing per-request re-runs `zodToJsonSchema` for the same tool,
and memoize any parameter-coercion schema-walk (`coerceParams`, `http-server.ts:107`)
that repeats per request.

**Proposal.** Precompute and memoize per-tool coercion metadata at startup so the hot
request path does no schema reflection.

**Acceptance criteria.** No `zodToJsonSchema`/schema-walk allocation on the tool-invoke
hot path (verified by profiling).

---

## Part 5 — Product value

### VAL-23 — Batch / multi-tool endpoint 🟡 (M)

**Problem.** Agent workflows often need several calls (the README's own examples combine
weather + transport + avalanche). Each is a separate round-trip.

**Proposal.** A `POST /v1/batch` accepting an array of `{tool, args}` and returning an
array of envelopes, executed with bounded concurrency server-side (cache-shared, so
overlapping sub-queries dedupe). Counts as N metered calls.

**Acceptance criteria.** One request returns N attributed envelopes; metering counts N.

### VAL-24 — Webhooks / push for time-critical hazards 🟡 (L)

**Problem.** Emergency alerts (`alerts`), avalanche bulletins (`avalanche`), and warnings
change on their own schedule; today agents must poll.

**Proposal.** Opt-in webhook subscriptions filtered by hazard type + region, delivering
the same envelope on change. Requires the shared datastore (Part 1) for subscription
state and a durable delivery queue.

**Acceptance criteria.** A registered subscriber receives a signed callback within a
bounded delay of a bulletin change.

### VAL-25 — Public status page & source-health history 🟡 (S)

**Problem.** `check_source_health` / `/v1/health/sources` are point-in-time only. Users
and operators have no view of trends or incident history.

**Proposal.** Persist periodic health snapshots (RES-14 metrics feed this) and expose a
lightweight status page with per-source uptime and latency history.

**Acceptance criteria.** A status page shows 7/30-day uptime per source.

### VAL-26 — Billing readiness (metering is already on) 🟢 (M)

**Problem.** The README/keys note *"metering on, billing off (onboarding phase)."*
Turning billing on later needs durable, exact usage (SCALE-5) plus invoicing hooks.

**Proposal.** Once SCALE-5 makes usage billing-grade, add usage export + a Stripe (or
similar) integration behind a feature flag; keep all tiers free until explicitly enabled.

**Acceptance criteria.** Usage can be exported per key/month for billing without changing
the free-during-onboarding default.

### VAL-27 — Expand data coverage (from README roadmap) 🟢 (varies)

Carried from the README roadmap, unblocked/prioritized by the scaling work:
SIMAP procurement · ASTRA live traffic (keyed) · FINMA registers · ESTV tax burden ·
cantonal GIS federation · multi-municipality waste calendars · dam registry ·
companies-by-address · parliament speeches/interests. Each is one connector module
(`src/modules/*`) plus an allowlist entry (`http.ts` `ALLOWED_HOSTS`).

### VAL-28 — OAuth on the remote MCP endpoint 🟡 (M)

**Problem.** The README roadmap lists "OAuth on the remote MCP endpoint." Today `/mcp`
authenticates only via the same `sy_` API keys. Proper OAuth (per the MCP auth spec)
would let hosted MCP clients authorize without hand-managing raw keys.

**Proposal.** Implement the MCP authorization spec (OAuth 2.1) for `/mcp`, mapping tokens
to the existing tier/quota model; keep API-key auth for REST.

**Acceptance criteria.** An MCP client completes an OAuth flow and its calls are metered
against the mapped tier.

---

## Cross-cutting: introduce a shared-infra profile

Most of Part 1 converges on the same dependency: an optional **Redis + Postgres**
profile, selected purely by environment (`SWISSYPHUS_REDIS_URL`,
`SWISSYPHUS_DATABASE_URL`). The design principle to preserve throughout:

- **Zero-dependency default stays intact.** `npx swissyphus` and stdio mode keep working
  with in-memory cache, in-memory rate limits, and the JSON key store — no Redis, no
  Postgres, no signup. Scaling infra is *opt-in* and additive, never required for the
  local/keyless experience that is the product's headline promise.
- **Every backend sits behind an interface** (`CacheBackend`, `RateLimiter`, `KeyStore`)
  so the single-node and clustered paths share one code path and one test suite.
- **Degrade, never fail.** Redis/Postgres unavailability degrades performance or limit
  precision but must never take down request serving or, especially, weaken auth.

A companion deployment manifest (`deploy/` — a `docker-compose.scale.yml` with Redis +
Postgres + N replicas, and/or a Kubernetes example) should land alongside SCALE-8.
