# Security policy

## Supported versions

Security fixes go into the latest minor release of the current major version (1.x). Upgrade with
`npx -y swissyphus@latest` or by pulling the latest Docker image.

## Reporting a vulnerability

Please **do not open a public issue.** Report it privately through GitHub:
**Security → Report a vulnerability** on this repository
([direct link](https://github.com/cwellbournewood/swissyphus/security/advisories/new)).

Include what is affected (version, mode: stdio, REST or remote MCP), how to reproduce it, and the
impact you see. You will get an acknowledgement within 3 working days and an assessment within
10. We will agree a disclosure date with you and credit you in the advisory unless you prefer
not to be named.

## Scope

In scope: the Swissyphus server (stdio, REST API, remote MCP), the Docker image, the release
artefacts and the deployment in `deploy/`. Examples of what we care about:

- server-side request forgery past the host allowlist or the public-resource client;
- leaking upstream credentials (`ZEFIX_*`, `OPENTRANSPORTDATA_API_KEY`) in responses,
  provenance records, logs or error messages;
- bypassing the per-IP rate limit;
- denial of service through a single request (size or time limits not enforced).

Out of scope: vulnerabilities in the upstream public services themselves (report those to their
operators), and the accuracy of upstream data (open a normal issue).

## How Swissyphus limits risk

Every tool is read-only and works on public data. Upstream hosts are allowlisted; catalogue
resources on other hosts are fetched only through a DNS-pinned client that refuses private
addresses and re-checks every redirect. Request bodies and upstream responses are size-capped,
and every call has a time budget. There are no accounts or API keys, so the server stores
nothing about its callers. Personal data handling is documented in [`PRIVACY.md`](PRIVACY.md) and [`BREACH_RESPONSE.md`](BREACH_RESPONSE.md).
