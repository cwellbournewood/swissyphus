# Privacy Notice — Swissyphus hosted API

This notice covers the **hosted** Swissyphus REST/MCP API only (the `/v1/keys`
signup flow and anything requiring an API key). If you run Swissyphus locally
via `npx swissyphus` (stdio/MCP mode) or your own `--http` instance, no data
leaves your machine and this notice does not apply — you are the controller
of your own deployment.

## Controller

Connor Wellbourne-Wood
Contact: cwellbournew@gmail.com

A postal address and phone number are not required under Swiss nFADP at this
stage (a name + reachable contact channel satisfies the Art. 19 duty to
inform for an individual operator). A registered address becomes a
requirement under the Unfair Competition Act only once this stops being a
free onboarding-phase service — add one before charging for Pro/Enterprise.

## What we collect

| Data | Purpose | Storage |
|---|---|---|
| Email address (`POST /v1/keys`) | Associate an API key with an account, contact about quota/tier | Plaintext, in `keys.json` |
| API key | Authenticate requests | **SHA-256 hash only** — the raw key is shown once at creation and cannot be recovered, even by us |
| Monthly request count | Enforce tier quotas | Aggregated count per key, no request content or payload stored |
| IP address (rate limiting) | Per-IP rate limiting (anonymous tier, signup abuse prevention) | **In-memory only**, never written to disk. Cleared automatically within the rate-limit window (≤24h) or on process restart |
| IP address + timestamp (security events) | Detecting brute-force attempts on admin endpoints (invalid admin token, admin lockout) | Written as `[security]` lines to the server's stderr. On the hosted deployment, Docker's `json-file` log driver keeps them **on the server's disk**, rotated at **10 MB × 5 files** per container. Old lines are overwritten as new logs arrive, and all of a container's logs are deleted when it is recreated (every upgrade). Logs are not shipped anywhere else |

We do not log query parameters, request bodies, or response content anywhere. The reverse
proxy (Caddy) has access logging switched off. Its error log can record a client IP when a
request fails at the proxy, and it is rotated the same way.
We do not sell or share your email with third parties. We do not use it for
marketing.

## Retention

- **Active keys**: kept until you revoke or delete them.
- **Revoked/deleted keys**: permanently purged after `SWISSYPHUS_REVOKED_RETENTION_DAYS`
  (default 30 days) — see `src/core/keys.ts`.
- **Rate-limit counters**: in-memory, cleared every window (≤24h) and on restart.
- **Container logs (security events)**: capped at 10 MB × 5 files per container and deleted when
  the container is recreated. How long a given line survives depends on traffic, but it is bounded
  by that cap. There is no separate log archive.
- **Backups**: `keys.json` (emails, key hashes, usage) is backed up nightly. Backups are kept for
  **30 days** and then deleted, and stay in Switzerland. A key you erase with `DELETE /v1/keys` can
  therefore stay in a backup for up to 30 days. If a backup is ever restored, erasures made after
  that backup are re-applied.

## Your rights (Swiss nFADP / GDPR where applicable)

- **Access**: `GET /v1/usage` with your key shows what's stored against it.
- **Erasure (self-service)**: `DELETE /v1/keys` with `Authorization: Bearer <your key>`
  permanently and immediately deletes your key record (email, tier, usage
  history). This is a hard delete, not a soft revoke.
- **Rectification / other requests**: contact the address above.

## Data location

Switzerland. The service is hosted on a VPS from **Infomaniak** (Swiss-owned, data centres in
Switzerland). Infomaniak acts as our **processor**: it provides the server infrastructure on which
the data above is stored, and it doesn't use that data for its own purposes. Backups are kept on
Swiss storage. There are no other processors or sub-processors (no analytics, no email provider,
no CDN).

No cross-border transfer applies: both the operator and the hosting
infrastructure are Swiss, so nFADP Art. 16/17 cross-border-transfer
safeguards (e.g. EU SCCs) are not triggered. If Swissyphus is ever deployed
to additional regions, update this section and add appropriate safeguards
first if the new location falls outside Switzerland/an EU-adequate
jurisdiction.

## Security measures

- API keys are stored as SHA-256 hashes, never in plaintext.
- Admin-token authentication uses constant-time comparison, requires a token of at least 32
  characters, and is rate-limited (10 attempts/min/IP). Lockouts and invalid attempts are logged
  (IP + timestamp) to stderr, which the hosted deployment keeps in size-capped, rotated container
  logs (see "What we collect").
- The client IP used for rate limiting and security logging comes from the TCP connection. Only
  behind our own reverse proxy (`SWISSYPHUS_TRUST_PROXY=1`) does it come from the proxy-set
  `X-Forwarded-For` hop, so it can't be spoofed by a client.
- `keys.json` is written atomically, and the server refuses to start on a corrupt store rather
  than silently discarding it.
- Admin endpoints (`/v1/admin/*`) never receive CORS headers, so browsers
  block cross-origin access to them regardless of any token in play.
- Production deployments should set `SWISSYPHUS_REQUIRE_TLS=1` and terminate
  TLS at a reverse proxy in front of this server. See the README's
  ["Deploying to production"](README.md#deploying-to-production) section and
  [`deploy/README.md`](deploy/README.md).

## Records of processing & breach response

- [ROPA.md](ROPA.md) — what's processed, why, for whom, and for how long (nFADP Art. 12).
- [BREACH_RESPONSE.md](BREACH_RESPONSE.md) — what to do if a breach is suspected, including when the FDPIC must be notified (nFADP Art. 24).

## Before you launch (operator checklist)

1. ~~Fill in the controller name/contact~~ — done: Connor Wellbourne-Wood, cwellbournew@gmail.com.
2. ~~Fill in the data-location section~~ — done: Switzerland, Infomaniak.
3. ~~Set `SWISSYPHUS_REQUIRE_TLS=1` and put a TLS-terminating proxy in front~~ is done in
   `deploy/docker-compose.yml` (with `SWISSYPHUS_TRUST_PROXY=1` behind Caddy).
4. Set `ADMIN_TOKEN` to `openssl rand -hex 32` (≥ 32 characters, otherwise admin is disabled),
   and keep it out of shell history and logs.
5. Keep container log rotation on (10 MB × 5, set in `deploy/docker-compose.yml`). If you add a
   log shipper or aggregator, update the log-retention wording above and in `ROPA.md`.
6. Set up the nightly backup with 30-day retention (`deploy/README.md` §6), and keep backups in
   Switzerland.
