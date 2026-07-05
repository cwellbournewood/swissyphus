# Data Breach Response (nFADP Art. 24)

Under Art. 24 nFADP, the controller must notify the FDPIC (Federal Data
Protection and Information Commissioner) **as soon as possible** if a
personal-data-security breach is likely to result in a high risk to the
data subject's personality or fundamental rights, and must notify affected
individuals if it's necessary for their protection or the FDPIC requires it.

This document is the process to follow when a breach is suspected or
confirmed. Controller: Connor Wellbourne-Wood (cwellbournew@gmail.com).

## What counts as a breach here

Given [ROPA.md](ROPA.md), the realistic breach scenarios for Swissyphus are:

1. **Unauthorized read/exfiltration of `keys.json`** (`SWISSYPHUS_DATA_DIR`) — exposes email addresses and key hashes (not raw keys — hashes are not directly usable to authenticate, but email exposure alone is a personal-data breach).
2. **Admin token compromise** — lets an attacker create/promote/revoke/erase keys and read the (masked) key list including emails.
3. **Host/infrastructure compromise** (Infomaniak account, server access) — broader access to the data directory and running process.

There is no realistic scenario involving the ~25 public-data proxy modules
themselves, since they don't store or forward caller-submitted personal data
(see ROPA.md, "Data NOT processed").

## Detection

- `[security]` lines on stderr flag admin rate-limit trips and invalid
  admin-token attempts (`src/http-server.ts`) — if you run this behind a
  process manager or log aggregator, alert on repeated `[security]` lines
  from the same IP in a short window.
- Unexpected growth in `keys.json` record count, or entries with emails you
  don't recognize signing up in bulk, may indicate signup-endpoint abuse
  (distinct from a breach, but worth watching — see `SIGNUPS_PER_IP_PER_DAY`).
- Unexplained admin actions (keys revoked/promoted you didn't initiate) —
  check `/v1/admin/keys` against your own memory of actions taken; there is
  no separate audit log today, so this is manual.

## Response steps, once a breach is suspected

1. **Contain**: rotate `ADMIN_TOKEN` immediately (new random value, redeploy).
   If the host itself is compromised, take the instance offline
   (`docker stop` / stop the process) while you assess.
2. **Assess scope**: how many records in `keys.json` were exposed/affected?
   Pull the file (or a snapshot/backup) and count entries with `revokedAt`
   unset (active) at the time of the incident.
3. **Assess risk**: is this a "high risk to personality or fundamental
   rights" under Art. 24? For this system, exposure is limited to email
   addresses + non-reversible key hashes + usage counts — no financial,
   health, or other sensitive data. Document your reasoning either way; if
   genuinely uncertain, treat it as high-risk and notify.
4. **Notify the FDPIC** "as soon as possible" if step 3 concludes high risk:
   https://www.edoeb.admin.ch — use their breach notification form. Include:
   nature of the breach, categories/approx. number of data subjects and
   records affected, likely consequences, measures taken/proposed.
5. **Notify affected individuals** if necessary for their protection (e.g.
   they should change credentials elsewhere, watch for phishing using the
   leaked email) or if the FDPIC requires it. A short, plain-language email
   to the addresses in the affected record set is sufficient at this scale.
6. **Remediate**: patch the root cause, rotate any other credentials that
   could have been derived from the exposure, and update this document with
   what changed.
7. **Record**: keep a short internal note of what happened, when, scope, and
   actions taken — even though there's no formal RoPA obligation to log
   incidents, this is what you'd show the FDPIC if asked "what did you do."

## What you do NOT need to do

- No requirement to notify for the rate-limiting IP data (never persisted,
  not a stored record to breach).
- No requirement to notify for read-only access to the public-data proxy
  modules — they hold no personal data at rest to expose.
