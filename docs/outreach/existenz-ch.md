# existenz.ch — usage and attribution terms

**To:** the maintainer of `api.existenz.ch`. Use the contact details on the API documentation
page (`https://api.existenz.ch/`) or in the imprint on `existenz.ch`. A German version of this
email may be friendlier.

**Subject:** Swissyphus uses api.existenz.ch (hydro + SwissMetNet): terms, attribution and fair use

---

Hello,

I maintain **Swissyphus** (https://github.com/cwellbournewood/swissyphus), an open-source (MIT)
server that gives AI assistants structured access to Swiss public data. Thank you for running
api.existenz.ch. Swissyphus currently uses it for:

- **Hydrology** (FOEN/BAFU): `/apiv1/hydro/latest`, `/apiv1/hydro/daterange` and
  `/apiv1/hydro/locations`, with caching of 10 minutes, 1 hour and 24 hours respectively.
- **Weather history** (MeteoSwiss SwissMetNet): `/apiv1/smn/daterange`, cached for 1 hour.

Right now our responses credit FOEN and MeteoSwiss as the original sources, but **not
existenz.ch**. I'd like to fix that, and I want to make sure our use is welcome. The tool runs
locally for individual users, and I plan a small hosted API in Switzerland at [HOSTED URL]. It is
free at launch, and paid tiers may be added later. So I'd like to ask:

1. Are you OK with Swissyphus using api.existenz.ch, including from a **hosted service**? That
   service would call from a single IP, with caching and request coalescing.
2. How would you like to be **credited**? For example: "Data delivered via api.existenz.ch".
3. Are there **fair-use limits** (requests per minute or day) I should stay under, or a preferred
   `User-Agent`/contact header?
4. Is there anything you'd prefer we **not** do, for example heavy history queries?

In the longer term I plan to fetch the official FOEN/MeteoSwiss open-data feeds directly for the
hosted service, to take load off your API. I'd still like to credit you for as long as we use it.

Many thanks,
Connor Wellbourne-Wood
Maintainer, Swissyphus
[contact email] · https://github.com/cwellbournewood/swissyphus

---

**When a reply arrives:** record it in the tracker (row 4). Add the requested credit to the
`hydrology` and `weather` source manifests (`attribution`/`notes`), and apply any rate limit
(for example via `SWISSYPHUS_UPSTREAM_CONCURRENCY` or per-module TTLs).
