# Records of Processing Activities (nFADP Art. 12)

Maintained voluntarily as an accountability measure. At current scale (one
operator, a handful of low-volume processing activities, no sensitive
personal data, no profiling), Swissyphus likely qualifies for the small-scale
exemption in Art. 24 of the Ordinance on Data Protection (VDSG) — but this
record is kept anyway so the exemption is a documented judgment, not an
assumption, and so it's ready if scale changes.

## Processing activity 1 — API key issuance & metering

- **Purpose**: authenticate hosted-API requests and enforce tiered rate/quota limits.
- **Categories of data subjects**: individuals who self-register for a hosted API key via `POST /v1/keys`.
- **Categories of personal data**: email address; a SHA-256 hash of the issued API key (the raw key itself is never stored); monthly request-count usage.
- **Recipients**: none. No data is shared with, sold to, or processed by any third party or sub-processor.
- **Cross-border transfer**: none — controller and hosting (Infomaniak) are both in Switzerland.
- **Retention**: active keys until revoked/erased by the holder; revoked records purged automatically after `SWISSYPHUS_REVOKED_RETENTION_DAYS` (default 30 days); self-service `DELETE /v1/keys` is immediate and permanent.
- **Security measures**: key stored as SHA-256 hash only; TLS required at the edge in production (`SWISSYPHUS_REQUIRE_TLS`); admin access gated by a constant-time-compared token, rate-limited to 10 attempts/min/IP.
- **Legal basis**: performance of a service requested by the data subject (providing the API key they asked for).

## Processing activity 2 — Anonymous & keyed rate limiting

- **Purpose**: prevent abuse of the free/anonymous tiers.
- **Categories of data subjects**: anyone calling the API without (or with) a key.
- **Categories of personal data**: IP address (from `X-Forwarded-For` or socket address).
- **Recipients**: none.
- **Cross-border transfer**: none.
- **Retention**: in-memory only, cleared every rate-limit window (≤24h for signup abuse checks, 60s for general limits) and on every process restart. Never written to disk.
- **Security measures**: no persistence; process-local memory only, capped map size with automatic eviction.
- **Legal basis**: legitimate interest (Art. 31 nFADP) — operating the service reliably and preventing abuse, proportionate to the minimal data involved.

## Processing activity 3 — Security-event logging

- **Purpose**: detect brute-force/abuse attempts against admin endpoints (supports the breach-detection duty implicit in Art. 24 nFADP).
- **Categories of data subjects**: anyone attempting to access `/v1/admin/*` without a valid token.
- **Categories of personal data**: IP address, timestamp.
- **Recipients**: none — written to process stderr only (operator's own terminal/log aggregator, if any is configured by the operator).
- **Retention**: not persisted by Swissyphus itself; retention depends on whatever the operator's own stderr/log pipeline does with it (document this once a specific hosting/logging setup exists).
- **Legal basis**: legitimate interest — securing the service.

## Data NOT processed

Swissyphus's ~25 data-proxy modules (companies, parliament, buildings,
weather, transport, etc.) fetch and return **public official-register data**
without storing it. A code review (2026-07) confirmed these modules return
institution-level records (company names, aggregate vote counts, building
metadata) rather than data about identifiable individuals in their private
capacity, and nothing submitted by a caller through those modules is stored
or forwarded anywhere. No sensitive personal data (Art. 5 lit. c nFADP:
health, religion, political/union views, intimate sphere, etc.) is processed.

## Review

This record should be re-reviewed whenever a new processing activity is
added (e.g. billing, a new data-collecting module, analytics) — re-derive
from the code (`src/core/keys.ts`, `src/http-server.ts`) rather than trusting
this snapshot indefinitely.
