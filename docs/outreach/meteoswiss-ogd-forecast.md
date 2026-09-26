# MeteoSwiss — OGD local forecasts and moving off the app back-end

**To:** MeteoSwiss **Open Government Data** team. Use the contact given in the MeteoSwiss OGD
documentation (linked from `www.meteoswiss.admin.ch` → open data). Otherwise, use the general
MeteoSwiss contact form and ask for it to be routed to the OGD team.

**Subject:** Migrating Swissyphus from the MeteoSwiss app back-end to OGD local forecasts

---

Dear MeteoSwiss OGD team,

I maintain **Swissyphus** (https://github.com/cwellbournewood/swissyphus), an open-source (MIT)
server that gives AI assistants structured, attributed access to Swiss public data. It already
uses your OGD SwissMetNet measurement files on data.geo.admin.ch. Thank you for the open-data
programme.

For **local forecasts by postcode**, Swissyphus currently calls
`https://app-prod-ws.meteoswiss-app.ch/v1/plzDetail`, which I understand is the back-end of the
MeteoSwiss mobile app and **not** an OGD interface. I don't want to rely on an interface that
isn't intended for third parties, especially for the small hosted API I plan to run in
Switzerland at [HOSTED URL]. I plan to migrate, and would appreciate your guidance on:

1. **Replacement dataset.** Is the OGD **local forecast** product on data.geo.admin.ch (I believe
   the STAC collection `ch.meteoschweiz.ogd-local-forecasting`; please correct me if not) the
   right replacement for postcode-level forecasts? Is there a recommended way to map a postcode
   or coordinate to its forecast point?
2. **Interim use.** Until the migration ships (target: [DATE]), is limited, cached use of the
   app back-end acceptable, or should I switch it off in the hosted service right away?
3. **Terms and attribution.** Is "Source: MeteoSwiss" (with a link) the correct attribution for
   OGD data used in a hosted API, including if paid tiers are introduced later?
4. **Warnings and pollen.** Are OGD equivalents available (or planned) for weather warnings by
   region and for pollen measurements?
5. **Fair use.** Are there access limits for data.geo.admin.ch downloads I should design for?
   Responses are cached (10–30 minutes) and repeated requests are coalesced.

Thank you for your help.

Kind regards,
Connor Wellbourne-Wood
Maintainer, Swissyphus
[contact email] · https://github.com/cwellbournewood/swissyphus

---

**When a reply arrives:** record it in the tracker (row 5). The migration of `get_weather` to OGD
local forecasts should go ahead regardless of the reply. If interim use is refused, remove
`get_weather`'s forecast part from the hosted preset until the migration lands.
