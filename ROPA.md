# Records of Processing Activities (nFADP Art. 12)

Maintained voluntarily as an accountability measure. Swissyphus is free and open source with no
accounts, API keys or paid plans, so the hosted API processes very little personal data. It
qualifies for the small-scale exemption in Art. 24 of the Ordinance on Data Protection (VDSG),
but this record is kept anyway so the exemption is a documented judgment, not an assumption.

## Processing activity 1: Per-IP rate limiting

- **Purpose**: protect the public upstream sources from overload by capping requests per client.
- **Categories of data subjects**: anyone calling the hosted API.
- **Categories of personal data**: IP address. By default it comes from the TCP socket. Only when `SWISSYPHUS_TRUST_PROXY=1` (hosted deployment, behind Caddy) is it taken from the right-most `X-Forwarded-For` hop set by the proxy.
- **Recipients**: none.
- **Cross-border transfer**: none.
- **Retention**: in memory only, cleared every 60-second window and on every process restart. Never written to disk.
- **Security measures**: no persistence; process-local memory only, capped map size with automatic eviction.
- **Legal basis**: legitimate interest (Art. 31 nFADP): operating the service reliably and protecting the public sources, proportionate to the minimal data involved.

## Processing activity 2: Reverse-proxy error logs

- **Purpose**: diagnose requests that fail at the reverse proxy.
- **Categories of data subjects**: callers whose request fails at the proxy.
- **Categories of personal data**: IP address, timestamp.
- **Recipients**: no third parties. On the hosted deployment, Docker's `json-file` log driver stores the lines on the VPS disk, so the hosting **processor** (Infomaniak) holds them as infrastructure provider. They are not shipped to any log aggregator.
- **Retention**: rotated at **10 MB × 5 files per container** (`deploy/docker-compose.yml`). Older lines are overwritten as new logs arrive, and a container's logs are deleted when it is recreated (every upgrade). Caddy access logs are off. If a log shipper is ever added, update this entry.
- **Legal basis**: legitimate interest: operating and securing the service.

## Processors (nFADP Art. 9)

| Processor | Role | Data | Location |
|---|---|---|---|
| **Infomaniak** (Infomaniak Network SA, Geneva) | VPS hosting of the API server and its container logs | The proxy error-log lines in activity 2 | Switzerland |

Infomaniak processes the data only to provide the infrastructure, under its standard terms and
data-processing agreement. There are no other processors: no analytics, no email provider, no
CDN, no payment provider. Add any new one here **before** it goes live.

## Data NOT processed

Swissyphus stores no accounts, emails, API keys or usage history. Its data-proxy modules
(companies, parliament, buildings, weather, transport, etc.) fetch and return **public
official-register data**. A code review (2026-07) confirmed these modules return
institution-level records (company names, aggregate vote counts, building metadata) rather than
data about identifiable individuals in their private capacity, and nothing submitted by a caller
through those modules is stored or forwarded anywhere. The upstream response cache
(`SWISSYPHUS_LKG_DIR`) holds what public sources returned, never who asked. The `news` module
returns only SRF RSS **headlines, links and publication dates**. No sensitive personal data
(Art. 5 lit. c nFADP: health, religion, political/union views, intimate sphere, etc.) is
processed.

## Review

This record should be re-reviewed whenever a new processing activity is added (e.g. a new
data-collecting module or analytics): re-derive from the code (`src/http-server.ts`) and the
deployment (`deploy/docker-compose.yml`, `deploy/README.md`) rather than trusting this snapshot
indefinitely. Last reviewed: 2026-11-09 (API keys, tiers and metering removed).
