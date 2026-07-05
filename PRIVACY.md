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
| IP address | Per-IP rate limiting (anonymous tier, signup abuse prevention) | **In-memory only**, never written to disk; cleared automatically within the rate-limit window (≤24h) or on process restart |

We do not log query parameters, request bodies, or response content anywhere.
We do not sell or share your email with third parties. We do not use it for
marketing.

## Retention

- **Active keys**: kept until you revoke or delete them.
- **Revoked/deleted keys**: permanently purged after `SWISSYPHUS_REVOKED_RETENTION_DAYS`
  (default 30 days) — see `src/core/keys.ts`.
- **Rate-limit counters**: in-memory, cleared every window (≤24h) and on restart.

## Your rights (Swiss nFADP / GDPR where applicable)

- **Access**: `GET /v1/usage` with your key shows what's stored against it.
- **Erasure (self-service)**: `DELETE /v1/keys` with `Authorization: Bearer <your key>`
  permanently and immediately deletes your key record (email, tier, usage
  history). This is a hard delete, not a soft revoke.
- **Rectification / other requests**: contact the address above.

## Data location

Switzerland — hosted via Infomaniak (Swiss-owned, data centers in Switzerland).

No cross-border transfer applies: both the operator and the hosting
infrastructure are Swiss, so nFADP Art. 16/17 cross-border-transfer
safeguards (e.g. EU SCCs) are not triggered. If Swissyphus is ever deployed
to additional regions, update this section and add appropriate safeguards
first if the new location falls outside Switzerland/an EU-adequate
jurisdiction.

## Security measures

- API keys are stored as SHA-256 hashes, never in plaintext.
- Admin-token authentication uses constant-time comparison and is rate-limited
  (10 attempts/min/IP), with security-event logging on lockouts and invalid
  attempts (stderr only, IP + timestamp, never persisted to disk).
- Admin endpoints (`/v1/admin/*`) never receive CORS headers, so browsers
  block cross-origin access to them regardless of any token in play.
- Production deployments should set `SWISSYPHUS_REQUIRE_TLS=1` and terminate
  TLS at a reverse proxy in front of this server — see the README's
  "Deploying to production" section.

## Records of processing & breach response

- [ROPA.md](ROPA.md) — what's processed, why, for whom, and for how long (nFADP Art. 12).
- [BREACH_RESPONSE.md](BREACH_RESPONSE.md) — what to do if a breach is suspected, including when the FDPIC must be notified (nFADP Art. 24).

## Before you launch (operator checklist)

1. ~~Fill in the controller name/contact~~ — done: Connor Wellbourne-Wood, cwellbournew@gmail.com.
2. ~~Fill in the data-location section~~ — done: Switzerland, Infomaniak.
3. Set `SWISSYPHUS_REQUIRE_TLS=1` and put a TLS-terminating proxy in front.
4. Set `ADMIN_TOKEN` to a long random value; keep it out of shell history/logs.
