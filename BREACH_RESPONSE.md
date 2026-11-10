# Data Breach Response (nFADP Art. 24)

Under Art. 24 nFADP, the controller must notify the FDPIC (Federal Data
Protection and Information Commissioner) **as soon as possible** if a
personal-data-security breach is likely to result in a high risk to the
data subject's personality or fundamental rights, and must notify affected
individuals if it's necessary for their protection or the FDPIC requires it.

This document is the process to follow when a breach is suspected or
confirmed. Controller: Connor Wellbourne-Wood (cwellbournew@gmail.com).

## What counts as a breach here

Swissyphus has no accounts, API keys, emails or usage records (see [ROPA.md](ROPA.md)). The
only personal data at rest is client IP addresses in the reverse proxy's rotated error logs. The
realistic scenario is therefore:

- **Host/infrastructure compromise** (Infomaniak account, server access), exposing those
  container logs.

The public-data proxy modules and the upstream response cache hold no caller data (see ROPA.md,
"Data NOT processed").

## Response steps, once a breach is suspected

1. **Contain**: take the instance offline (`docker compose stop`) while you assess, and rotate
   the server's SSH keys and the hosting-account password.
2. **Assess scope**: which logs were reachable and for what period? Logs are capped at
   10 MB × 5 files per container, so the window is bounded.
3. **Assess risk**: IP addresses and timestamps alone are unlikely to be a "high risk to
   personality or fundamental rights". Document your reasoning either way; if genuinely
   uncertain, treat it as high-risk and notify.
4. **Notify the FDPIC** "as soon as possible" if step 3 concludes high risk:
   https://www.edoeb.admin.ch, using their breach notification form.
5. **Remediate**: patch the root cause, redeploy from a clean image and update this document
   with what changed.
6. **Record**: keep a short internal note of what happened, when, scope and actions taken.

## What you do NOT need to do

- No requirement to notify for the rate-limiting IP data: it is never persisted, so there is no
  stored record to breach.
- No requirement to notify for read-only access to the public-data proxy modules or the
  upstream response cache: they hold no personal data at rest.
