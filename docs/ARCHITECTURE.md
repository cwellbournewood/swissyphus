# How Swissyphus works

Swissyphus is a rollup: 66 public sources behind one server, kept running continuously. This
page covers the parts that make its answers trustworthy: provenance, reliability, and how a
source becomes a tool.

## The pipeline

```text
66 public sources (allowlisted hosts; catalogue resources on other hosts
   only through a DNS-pinned, public-address-only, redirect-rechecked client)
        │
        ▼
Fetch layer (src/core/http.ts)
   cache · single-flight · per-host concurrency cap · circuit breaker
   · stale-while-revalidate · stale-if-error · last-known-good store
   · per-call time budget · provenance trace
        │
        ▼
Modules (src/modules/*, one file per domain)
   source manifest (operator, licence, attribution, TTL, max-stale)
   + typed tools (Zod schemas) + health probes
        │
        ▼
Envelope (src/core/envelope.ts)
   data + source + retrieved_at + data_as_of + cache_status + provenance
        │
        ├─► MCP over stdio  (tools, resources, prompts)
        ├─► MCP over HTTP   (POST /mcp)
        └─► REST + OpenAPI  (/v1/tools/*, /openapi.json)
```

All three front ends are generated from the same tool definitions, so they cannot drift apart.
`tools.schema.json`, [`TOOLS.md`](TOOLS.md) and the `.mcpb` manifest are generated from them too.

## Provenance: every answer can be traced

Every tool answer, success or stale fallback, is an envelope:

```json
{
  "data": { "currency": "EUR", "rate_chf": 0.92841, "meaning": "1 EUR = 0.92841 CHF (monthly average)", "month": "2026-10" },
  "source": {
    "name": "SNB Data Portal — CHF exchange rates (monthly)",
    "operator": "Swiss National Bank",
    "url": "https://data.snb.ch",
    "licence": "SNB data portal terms — free use with attribution",
    "attribution": "© Swiss National Bank, data.snb.ch"
  },
  "retrieved_at": "2026-11-08T18:17:50.788Z",
  "data_as_of": "2026-10",
  "cache_status": "miss",
  "language": "en",
  "provenance": {
    "upstream": [
      { "url": "https://data.snb.ch/api/cube/devkum/data/json/en?fromDate=2026-08&toDate=2026-11", "cache_status": "miss", "retrieved_at": "2026-11-08T18:17:50.788Z" }
    ]
  }
}
```

| Field | Answers | Guarantee |
|---|---|---|
| `source` | Who publishes this, under which licence, how to credit it | Declared once per source in its manifest; every one of the 66 sources has an operator, URL, licence and attribution (enforced by tests) |
| `retrieved_at` | When Swissyphus fetched it | For a cached answer, the time of the original fetch, not the time of the call |
| `data_as_of` | How current the data itself is | The publisher's own timestamp (observation, bulletin issue, list date). **`null` when the source publishes none**, never the fetch time in disguise |
| `cache_status` | Fresh or not | `miss` (fetched now), `hit` (cached, within TTL), `stale` (older; source refreshing or down), `computed` (offline) |
| `stale_age_seconds`, `notes` | How stale | Present whenever stale data is served, with a plain-language note |
| `provenance.upstream` | Which exact requests produced this answer | Every request the call made or reused, with its own cache status and fetch time. Multi-source tools list each one. Credentials are never shown: URL user-info is dropped and secret-looking query values are redacted; header credentials are never recorded |

The licence register is one call away (`list_sources`, the MCP resource `swissyphus://sources`,
or `GET /v1/sources`).

### How the trace works

Each tool call runs inside its own trace (`AsyncLocalStorage`, so it follows every `await` and
concurrent calls never mix). The fetch layer records every upstream request it answers, from the
network, the cache or the on-disk store. Modules that answer from an in-memory index (sanctions,
EV chargers, FOPH exports) record the download the index was built from. `respond()` writes the
trace into the envelope. No module can opt out.

## Reliability: always running

Public infrastructure goes down, rate-limits and changes format. Swissyphus is built to degrade
gracefully and to be a polite client.

| Mechanism | Behaviour |
|---|---|
| Caching | Per-source TTL. Identical concurrent misses become one upstream request (single-flight) |
| Stale-while-revalidate | Slightly old data is served at once while it refreshes in the background |
| Stale-if-error | If a source fails, the last good answer is served, marked `stale`, within the source's own `maxStaleSeconds` (10 min for departures, 3 days for the sanctions list, ~400 days for annual statistics) |
| Last-known-good store | With `SWISSYPHUS_LKG_DIR`, good answers survive restarts and deploys on disk |
| Circuit breaker | Per host: 5 consecutive failures, or a single 429 / `Retry-After`, open the circuit. Cool-down doubles on repeated failures (30 s → 10 min) |
| Concurrency cap | At most 8 in-flight requests per upstream host |
| Time budget | Every call has a 30 s ceiling; each fetch gets min(its timeout, time left) and retries only when there is time |
| Response caps | Upstream bodies are size-capped; tool answers are capped at ~50 KB and stay valid JSON |
| Health | `npx swissyphus doctor`, the `check_source_health` tool and `/v1/health/sources` probe every source |
| Live canary | A nightly GitHub Action runs the doctor plus ~90 live tool calls and opens an issue when a source drifts |

## Adding a source

A module is one file in `src/modules/` that exports a `SwissyphusModule`:

1. A **source manifest** for each upstream: operator, URL, licence, attribution, cache TTL and
   `maxStaleSeconds`.
2. `allowHosts(...)` for its hosts (nothing else can be fetched).
3. **Tools** with Zod input schemas and handlers that return `respond(data, meta)`.
4. A **health probe**, and `registerSearcher(...)` if it is a catalogue, so `find_data` sees it.
5. Offline tests with recorded fixtures, and live cases in `test/smoke.mjs`.

Register it in `src/registry.ts`, add it to the right presets, then run `npm run catalogue` and
`npm run manifest`. [`CONTRIBUTING.md`](../CONTRIBUTING.md) has the details.
