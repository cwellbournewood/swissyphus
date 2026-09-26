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
- **Recipients**: no data is shared with or sold to third parties. **Processor:** Infomaniak (hosting provider; see "Processors" below) stores the data as infrastructure provider.
- **Cross-border transfer**: none. The controller, the hosting (Infomaniak) and the backups are all in Switzerland.
- **Retention**: active keys are kept until the holder revokes or erases them. Revoked records are purged automatically after `SWISSYPHUS_REVOKED_RETENTION_DAYS` (default 30 days). Self-service `DELETE /v1/keys` is immediate and permanent in the live store. Nightly backups of `keys.json` are kept for 30 days, so an erased record can stay in a backup for up to 30 days. Erasures are re-applied if a backup is ever restored.
- **Security measures**: the key is stored as a SHA-256 hash only. The store is written atomically, and the server refuses to start on corruption. TLS is required at the edge in production (`SWISSYPHUS_REQUIRE_TLS` behind Caddy). Admin access is gated by a constant-time-compared token of at least 32 characters, rate-limited to 10 attempts/min/IP. The data volume and backups are readable by root only.
- **Legal basis**: performance of a service requested by the data subject (providing the API key they asked for).

## Processing activity 2 — Anonymous & keyed rate limiting

- **Purpose**: prevent abuse of the free/anonymous tiers.
- **Categories of data subjects**: anyone calling the API without (or with) a key.
- **Categories of personal data**: IP address. By default it comes from the TCP socket. Only when `SWISSYPHUS_TRUST_PROXY=1` (hosted deployment, behind Caddy) is it taken from the right-most `X-Forwarded-For` hop set by the proxy.
- **Recipients**: none.
- **Cross-border transfer**: none.
- **Retention**: in-memory only, cleared every rate-limit window (≤24h for signup abuse checks, 60s for general limits) and on every process restart. Never written to disk.
- **Security measures**: no persistence; process-local memory only, capped map size with automatic eviction.
- **Legal basis**: legitimate interest (Art. 31 nFADP) — operating the service reliably and preventing abuse, proportionate to the minimal data involved.

## Processing activity 3 — Security-event logging

- **Purpose**: detect brute-force/abuse attempts against admin endpoints (supports the breach-detection duty implicit in Art. 24 nFADP).
- **Categories of data subjects**: anyone attempting to access `/v1/admin/*` without a valid token.
- **Categories of personal data**: IP address, timestamp.
- **Recipients**: no third parties. Swissyphus writes the lines to process stderr. On the hosted deployment, Docker's `json-file` log driver stores them on the VPS disk, so the hosting **processor** (Infomaniak) holds them as infrastructure provider. They are not shipped to any log aggregator.
- **Retention**: rotated at **10 MB × 5 files per container** (`deploy/docker-compose.yml`). Older lines are overwritten as new logs arrive, and a container's logs are deleted when it is recreated (every upgrade). Caddy access logs are off, and Caddy error logs (which can contain a client IP for failed proxied requests) use the same rotation. If a log shipper is ever added, update this entry.
- **Legal basis**: legitimate interest — securing the service.

## Processors (nFADP Art. 9)

| Processor | Role | Data | Location |
|---|---|---|---|
| **Infomaniak** (Infomaniak Network SA, Geneva) | VPS hosting of the API server, the `swissyphus-data` volume (`keys.json`) and container logs. Backup storage if Infomaniak Swiss Backup/kDrive is used. | Everything in activities 1–3 at rest (emails, key hashes, usage counts, security-log IPs) | Switzerland |

Infomaniak processes the data only to provide the infrastructure, under its standard terms and
data-processing agreement. The controller should keep a copy of the accepted DPA with these
records. There are no other processors: no analytics, no email-sending provider, no CDN, no
payment provider while billing is off. Add any new one here **before** it goes live.

## Data NOT processed

Swissyphus's ~25 data-proxy modules (companies, parliament, buildings,
weather, transport, etc.) fetch and return **public official-register data**
without storing it. A code review (2026-07) confirmed these modules return
institution-level records (company names, aggregate vote counts, building
metadata) rather than data about identifiable individuals in their private
capacity, and nothing submitted by a caller through those modules is stored
or forwarded anywhere. The `news` module returns only SRF RSS **headlines, links and publication
dates**. It returns no article text or summaries, and headlines are not stored beyond the
short-lived in-memory response cache. No sensitive personal data (Art. 5 lit. c nFADP:
health, religion, political/union views, intimate sphere, etc.) is processed.

## Review

This record should be re-reviewed whenever a new processing activity is
added (e.g. billing, a new data-collecting module, analytics) — re-derive
from the code (`src/core/keys.ts`, `src/http-server.ts`) and the deployment
(`deploy/docker-compose.yml`, `deploy/README.md`) rather than trusting this
snapshot indefinitely. Last reviewed: 2026-09-26 (0.5.0 hardening: trusted-proxy
IPs, log rotation, backups, processor listing).
