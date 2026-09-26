# Licensing & data-access outreach

Several Swissyphus sources are fine for a local, personal-use MCP server, but are unconfirmed or
unofficial for a **hosted, publicly reachable** API. See
[`docs/READINESS_REVIEW.md`](../READINESS_REVIEW.md) §4. Providers take weeks to reply, so these
requests are the long pole for go-live and should be **sent now**, in parallel with the code work
([`BACKLOG.md`](../../BACKLOG.md) #9).

👤 **Owner-only:** the data controller must send each email from their own address. Don't guess
contact addresses. Each draft says where the official contact is published. Before sending, fill
in the `[…]` placeholders: the hosted URL, launch date and your contact email.

## Tracker

Update this table when you send an email and when a reply arrives. Record the outcome in the
licence register as well: the module's `SourceManifest` `licence`/`attribution`, which feed
`list_sources`.

| # | Source | Ask | Draft | Status | Owner | Sent | Outcome / next step |
|---|---|---|---|---|---|---|---|
| 1 | **ZEFIX**, run by the Federal Commercial Registry Office (EHRA) at the Federal Office of Justice (FOJ) | Credentials for the official **ZefixPublicREST** API, and permission to use it in a hosted API | [foj-zefix-public-rest.md](foj-zefix-public-rest.md) | not sent | owner | — | Once granted, set `ZEFIX_USER`/`ZEFIX_PASS` on the VPS. The keyless `ZefixREST` path stays as the local fallback. |
| 2 | **SLF** (WSL Institute for Snow and Avalanche Research) | Terms for commercial or hosted redistribution of the avalanche bulletin (CAAML) and IMIS station data, plus attribution wording | [slf-avalanche-imis.md](slf-avalanche-imis.md) | not sent | owner | — | If refused, drop `avalanche`/`snow` from the hosted deployment (keep them for local use) |
| 3 | **SRF** (Schweizer Radio und Fernsehen) | Permission to show RSS headlines and links (no summaries) in a hosted API | [srf-rss-headlines.md](srf-rss-headlines.md) | not sent | owner | — | If refused, disable `news` in the hosted deployment |
| 4 | **existenz.ch** (third-party API used for hydrology and weather history) | Usage and attribution terms, fair-use limits, and whether hosted use is OK | [existenz-ch.md](existenz-ch.md) | not sent | owner | — | Add the credit to the `hydrology`/`weather` attribution. Longer term, go direct to FOEN/MeteoSwiss OGD. |
| 5 | **MeteoSwiss** | Confirm that the app back-end (`app-prod-ws.meteoswiss-app.ch`) must not be used, and which OGD local-forecast dataset to migrate to, with its terms | [meteoswiss-ogd-forecast.md](meteoswiss-ogd-forecast.md) | not sent | owner | — | Migrate `get_weather` to the OGD local forecasts on data.geo.admin.ch, whatever the reply |

Status values: `not sent` → `sent` → `replied` → `resolved (granted / refused / n/a)`.

## Notes

- **English is fine** for federal offices and SLF. For SRF and existenz.ch, a German version may
  get a faster reply. Translating the draft is fine, but keep the specific asks unchanged.
- Keep replies (PDF or email export) in a private location, **not in this repo**. Link or
  summarise them in the tracker without personal details.
- The **OpenHolidays** licence fix (it is ODbL share-alike, not attribution-only) needs no email.
  It is a change to the licence register in code.
- Before quoting any traffic numbers to a provider, check the cache TTLs in the module source.
  The drafts quote the values current at 0.5.0.
