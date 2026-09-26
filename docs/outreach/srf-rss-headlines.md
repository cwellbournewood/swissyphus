# SRF — use of RSS headlines in an API

**To:** Schweizer Radio und Fernsehen (SRF). Use the **SRF Kundendienst** (customer service)
contact form on `www.srf.ch`, and ask for the message to go to the team responsible for **RSS
feeds / content rights (Rechte & Lizenzen)**. If `srf.ch` publishes RSS terms of use with a named
contact, use that. A German version of this email may get a faster reply.

**Subject:** Permission to display SRF News RSS headlines and links in an open-source API (Swissyphus)

---

Dear SRF team,

I maintain **Swissyphus** (https://github.com/cwellbournewood/swissyphus), an open-source (MIT)
server that gives AI assistants structured access to Swiss public information. One of its tools
lists current Swiss news headlines. It reads the SRF News RSS feed
(`https://www.srf.ch/news/bnf/rss/1646`), refreshed at most every 5 minutes.

For each item, the tool returns **only the headline, the link to the article on srf.ch and the
publication time**, labelled "News headlines © SRF". It returns no summaries, teasers, images or
article text, so readers who want the story are sent to srf.ch.

The tool is used locally by individual users. I also plan a small hosted API in Switzerland at
[HOSTED URL], which is free at launch, and paid tiers may be added later. Your RSS terms point
to personal, non-commercial use, so I would like to ask:

1. May Swissyphus show SRF RSS **headlines and links** (as described) through a **hosted API**
   used by third parties?
2. If so, what **attribution** do you require, and are there any conditions (for example no use
   in paid tiers, a cap on the number of items, a required link format)?
3. If not, is there a licensing route you would suggest?

If this use isn't permitted, I will switch the news tool off in the hosted service.

Thank you very much.

Kind regards,
Connor Wellbourne-Wood
Maintainer, Swissyphus
[contact email] · https://github.com/cwellbournewood/swissyphus

---

**When a reply arrives:** record it in the tracker (row 3). If permission is refused or has
conditions, disable or adjust the `news` module in the hosted deployment's preset, and update
the `news` manifest licence text.
