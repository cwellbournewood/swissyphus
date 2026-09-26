# SLF — avalanche bulletin & IMIS data redistribution terms

**To:** WSL Institute for Snow and Avalanche Research SLF. Use the contact page on
`www.slf.ch` and ask for the team responsible for **data services / open data** or the avalanche
warning service. If the SLF data pages name a specific data-licensing contact, use that.

**Subject:** Terms for redistributing the avalanche bulletin and IMIS measurements in a hosted API (Swissyphus)

---

Dear SLF team,

I maintain **Swissyphus** (https://github.com/cwellbournewood/swissyphus), an open-source (MIT)
server that gives AI assistants and developers structured access to Swiss public data, with the
source and attribution included in every response. It runs locally for individual users, and I
plan to offer a small hosted API in Switzerland at [HOSTED URL]. The hosted API is free at launch,
and paid tiers may be added later.

Two Swissyphus tools use SLF data:

- **Avalanche bulletin:** `https://aws.slf.ch/api/bulletin/caaml/en/geojson`, cached for 30
  minutes. We return the danger level and a region summary for a location, with a link to the
  official bulletin on whiterisk.ch / slf.ch.
- **IMIS station data:** `https://measurement-api.slf.ch/public/api/imis/...`, cached for 15
  minutes. We return snow depth, temperature and wind for stations.

Every response is labelled "© SLF/WSL" (or "© SLF/WSL IMIS") and links to the SLF source. I would
like to make sure this use is acceptable, so I would be grateful if you could tell me:

1. Can the bulletin and IMIS data be **redistributed through a hosted API** to third parties,
   including **commercial** users if paid tiers are introduced later? If not, which uses are
   allowed?
2. What **attribution text** and **disclaimer** do you require? For example, that the official
   bulletin is authoritative and must be consulted before going into avalanche terrain.
3. Are these endpoints intended for third-party use, and are there **rate limits** or a preferred
   endpoint (or API key) for services like this?
4. Is there a **licence document** I can reference in the project's licence register?

If hosted redistribution isn't allowed, I will limit these tools to the local, personal-use mode
and remove them from the hosted service.

Thank you for the invaluable work of the avalanche warning service.

Kind regards,
Connor Wellbourne-Wood
Maintainer, Swissyphus
[contact email] · https://github.com/cwellbournewood/swissyphus

---

**When a reply arrives:** record it in the tracker (row 2). Update the `licence`/`attribution` in
the `avalanche` and `snow` module manifests. If a safety disclaimer is required, add it to the
tool descriptions and responses.
