# Privacy Notice: Swissyphus hosted API

Swissyphus is free and open source. There are no accounts, no signup, no API keys and no
paid plans, so the hosted REST/MCP API holds no record of who you are.

This notice covers the **hosted** Swissyphus REST/MCP API. If you run Swissyphus locally via
`npx swissyphus` (stdio/MCP mode) or your own `--http` instance, no data leaves your machine and
this notice does not apply; you are the controller of your own deployment.

## Controller

Connor Wellbourne-Wood
Contact: cwellbournew@gmail.com

## What we process

| Data | Purpose | Storage |
|---|---|---|
| IP address (rate limiting) | A per-IP request limit that protects the public sources behind the API | **In memory only**, never written to disk. Cleared every 60-second window and on every restart |
| IP address (proxy error log) | Diagnosing requests that fail at the reverse proxy | Caddy's error log can record the client IP of a failed request. It is kept by Docker's `json-file` log driver **on the server's disk**, rotated at **10 MB × 5 files** per container, and deleted when the container is recreated (every upgrade). Logs are not shipped anywhere else |

We do not log query parameters, request bodies or response content. The reverse proxy (Caddy)
has access logging switched off.

**Upstream response cache.** To keep answering when a public source is down (including right
after a restart), the hosted deployment keeps a copy of recent responses *from the public data
sources* on the server's disk (`SWISSYPHUS_LKG_DIR`). It holds what the source returned (e.g.
a weather forecast or a register entry), not who asked. No IP address or other caller data is
stored with it. Files are named by a one-way hash of the upstream request, so the request text
itself is not written. Responses to credentialed upstream calls are never stored. Each copy is
deleted once it is too old to serve (minutes for live departures, at most about a year for
annual statistics), and the whole store is capped at 64 MiB by default.

## Retention

- **Rate-limit counters**: in memory, cleared every 60-second window and on restart.
- **Container logs**: capped at 10 MB × 5 files per container and deleted when the container is
  recreated. There is no separate log archive.
- **Upstream response cache**: public source data only, deleted when it exceeds its source's
  max-stale window (see above).

## Your rights (Swiss nFADP / GDPR where applicable)

We hold no record linked to you beyond the short-lived data above. For any question or request,
contact the address above.

## Data location

Switzerland. The service is hosted on a VPS from **Infomaniak** (Swiss-owned, data centres in
Switzerland). Infomaniak acts as our **processor**: it provides the server on which the logs and
cache above are stored, and it doesn't use that data for its own purposes. There are no other
processors (no analytics, no email provider, no CDN, no payment provider).

No cross-border transfer applies: both the operator and the hosting infrastructure are Swiss. If
Swissyphus is ever deployed to additional regions, update this section first.

## Security measures

- The client IP used for rate limiting comes from the TCP connection. Only behind our own reverse
  proxy (`SWISSYPHUS_TRUST_PROXY=1`) does it come from the proxy-set `X-Forwarded-For` hop, so it
  can't be spoofed by a client.
- TLS is terminated at a reverse proxy and required by the server (`SWISSYPHUS_REQUIRE_TLS=1`).
  See the ["Production deployment"](docs/HOSTING.md#production-deployment) section of the hosting
  guide and [`deploy/README.md`](deploy/README.md).

## Records of processing & breach response

- [ROPA.md](ROPA.md): what's processed, why, and for how long (nFADP Art. 12).
- [BREACH_RESPONSE.md](BREACH_RESPONSE.md): what to do if a breach is suspected (nFADP Art. 24).

## Running your own deployment

If you operate a public Swissyphus deployment, you are the controller for it. Before opening it
to users:

1. Replace the controller name, contact and data location in this notice with your own.
2. Terminate TLS at a reverse proxy and set `SWISSYPHUS_REQUIRE_TLS=1` with
   `SWISSYPHUS_TRUST_PROXY=1` (as `deploy/docker-compose.yml` does behind Caddy).
3. Keep container log rotation on (10 MB × 5, set in `deploy/docker-compose.yml`). If you add a
   log shipper or aggregator, update the log-retention wording above and in `ROPA.md`.
