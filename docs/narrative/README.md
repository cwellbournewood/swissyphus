# Swissyphus — narrative package

How we explain, announce and sell Swissyphus. One story, told the same way everywhere:
README, npm, LinkedIn, talks, outreach emails to data providers, and sales conversations.

Companion file: [`linkedin-launch-post.md`](linkedin-launch-post.md).

---

## 1. The one-liner

> **Swissyphus is the AI gateway to Switzerland.** One open-source connector that gives any AI
> assistant live, attributed access to the country's public data — trains, weather, avalanches,
> companies, law, votes, maps, energy prices and more. No API keys. No signup.

Short form (bios, npm description, social cards):

> **The AI gateway to Switzerland.** 25 official-first data sources, one install.

## 2. Is "AI gateway to Switzerland" the right direction?

**Yes. Keep it, with three adjustments.**

The instinct is right because it rests on things that are true and specific to Switzerland:

- **Switzerland runs on public data.** SBB timetables, MeteoSwiss forecasts, swisstopo maps,
  the commercial register, Fedlex, the SLF avalanche bulletin, the BFS vote results. These are
  services people use every day and are proud of.
- **Most of it is already open (OGD), but scattered.** Each source has its own portal, API style,
  coordinate system (LV95 vs WGS84), language mix and licence. That fragmentation is the problem
  we solve. It is not a lack of data.
- **AI assistants can't use it well today.** An LLM asked "next train to Zermatt and is there
  avalanche danger?" either guesses or browses five sites. Swissyphus gives it one door.

The three adjustments:

1. **Make the institutions the heroes, not us.** The national-pride angle works best when we say
   *"Switzerland already built world-class public data. We built the doorway."* Name MeteoSwiss,
   SBB, swisstopo, SLF and the Federal Office of Justice. Every response already carries their
   attribution, so this is a story we can prove. It also keeps data providers friendly, and we
   need them (see `docs/outreach/`).
2. **Never imply we are official.** Swissyphus is an independent, open-source project. It is not
   affiliated with or endorsed by the Confederation or any federal office. Say "built on official
   Swiss open data", never "the official Swiss AI gateway". Don't use the Swiss coat of arms in
   the logo. Its commercial use is restricted by the Coat of Arms Protection Act (WSchG). Have
   the 🇨🇭 emoji in copy only, not in a trademark or logo.
3. **"Gateway" means access, not control.** Lead with *trust*: source, licence, freshness and
   cache status on every answer. That is the line that turns "another wrapper" into
   "infrastructure you can build on". The word **gateway** should come with **attributed** and
   **live** nearby.

## 3. The story (use this order)

1. **Switzerland is one of the best-documented countries on earth.** Trains to the minute, snow
   depth from 300+ alpine stations, every building in a federal register, every law in four
   languages.
2. **But it's locked in 25 different doors.** Different APIs, formats, coordinate systems,
   languages and licences. Great for specialists, unusable for an AI agent.
3. **Swissyphus is one door.** One connector, 71 tools across 25 domains. Install in under a
   minute, no keys.
4. **Every answer shows its receipt.** Source, operator, licence, attribution, when it was
   retrieved and how fresh the data is. Your agent cites MeteoSwiss rather than guessing.
5. **Open by default.** MIT-licensed, runs locally, free. A hosted API and REST/OpenAPI for teams
   that want it.

The name: *like Sisyphus, but the boulder is Swiss open data and we enjoy rolling it uphill.*
Use the joke once, early, then get serious. It is memorable and it honestly signals the hard part
we take on: keeping 25 flaky integrations working every night (live canary).

## 4. Messaging pillars

| Pillar | Claim | Proof we can point to |
|---|---|---|
| **One door** | All of Swiss public data through a single connector | 25 modules, 71 tools, MCP + REST + OpenAPI from one schema |
| **Live** | Real-time, not a stale snapshot | Live SBB boards, 10-min weather stations, Alertswiss, SLF IMIS |
| **Attributed** | Every answer says where it came from and under which licence | Response envelope, `list_sources` licence register |
| **Honest about health** | When a source is down, the agent knows | `check_source_health`, `swissyphus doctor`, nightly canary |
| **Zero friction** | No keys, no signup, under 60 seconds | `npx swissyphus`, one-click `.mcpb` bundle |
| **Swiss-grade privacy** | Built to the Swiss nFADP from day one | `PRIVACY.md`, `ROPA.md`, `BREACH_RESPONSE.md`, hashed keys, self-service erasure |

## 5. Audiences and what each one hears

| Audience | What they care about | Lead with | Example prompt to show |
|---|---|---|---|
| **AI builders / developers** | Speed, reliable tools, small context | One install, presets, OpenAPI | "Next train Bern→Lugano, and is there snow in Zermatt?" |
| **Swiss companies & startups** | Building Swiss-specific AI products fast | REST API, attribution, nFADP | "Due diligence on 'On AG': register entry and SOGC history" |
| **Legal, compliance, fiduciary** | Accuracy, citations | Fedlex in-force checks, ZEFIX, SOGC | "Is SR 235.1 still in force?" |
| **Energy, real estate, insurance** | Location intelligence | Buildings, solar potential, tariffs, hazards | "Full report for Marktgasse 1, Bern" |
| **Outdoor, tourism, mobility** | Live conditions | Avalanche, snow, trails, transport | "Ski tour near Davos: danger level, snow depth, closures, train" |
| **Public sector & data providers** | Their data used well and credited | Attribution on every response, fair-use caching | Show the envelope with "© MeteoSwiss" |
| **Press / general public** | Why it matters | "Ask your AI about Switzerland and get a real answer" | "How did Ticino vote on June 14?" |

## 6. Boilerplates

**25 words**
> Swissyphus is the open-source AI gateway to Switzerland: one connector giving AI assistants
> live, attributed access to 25 official-first Swiss public data sources. No keys required.

**50 words**
> Swissyphus connects AI assistants to Switzerland's public data: SBB timetables, MeteoSwiss
> weather, SLF avalanche bulletins, the commercial register, federal law, vote results, maps and
> energy tariffs. One install, 71 tools, no API keys. Every answer carries its source, licence
> and freshness, so AI cites Swiss institutions instead of guessing.

**100 words**
> Switzerland is one of the best-documented countries in the world, but its public data lives
> behind dozens of separate portals, APIs and formats. Swissyphus is a single open-source gateway
> that lets any AI assistant (Claude, ChatGPT-compatible clients, Cursor and others via the Model
> Context Protocol, or any app via REST) query 25 official-first Swiss sources live: transport,
> weather, hydrology, avalanches, companies, law, parliament, votes, geodata, buildings, energy
> and more. Every response includes source attribution, licence and data freshness. It is
> MIT-licensed, installs in under a minute, needs no API key, and is built to Swiss nFADP
> privacy standards.

## 7. Tagline bank

- The AI gateway to Switzerland.
- Switzerland built the data. We built the door.
- Ask your AI about Switzerland. Get a Swiss answer.
- 25 sources. One install. Every answer cited.
- Swiss public data, ready for AI.
- One does not simply query 25 federal APIs. (developer audience only)

## 8. Free or paid? (current plan and how to talk about it)

**What was decided** (`BACKLOG.md` #6, 2026-09-26): **metering on, billing off at launch.**

| Offer | Price today | Notes |
|---|---|---|
| Local MCP server / Docker / `.mcpb` | **Free forever** (MIT) | No key, ever. This is the core promise. |
| Hosted API, Anonymous | Free | 60 req/min per IP |
| Hosted API, Free key | Free | 240 req/min, 50'000/month, self-service by email |
| Hosted API, Pro | Free during onboarding | 1'000 req/min, 1M/month, granted by hand |
| Enterprise | "Talk to us" | On-prem, SLA, DPA |

Triggers to revisit billing (all still *placeholders the owner needs to confirm*): more than 100
active keys for 2 consecutive months, hosting above CHF 50/month, any written request to pay for
Pro/Enterprise/SLA/DPA, or a backstop review on 2027-03-31.

**Recommendation for the narrative:**

- **Lead with "free and open source".** It is true, it removes the biggest adoption barrier and
  it fits the "public infrastructure" story. Public data should stay accessible.
- **Don't announce future prices.** Say "Free. Hosted API free during launch. Enterprise
  (SLA, DPA, on-prem): get in touch." That keeps the door open without a broken promise.
- **Plan to charge for service, not data.** If money comes, it should be for uptime, SLAs, higher
  quotas, DPAs, support and on-prem deployment, never for the public data itself. This matters
  for two reasons. It's the honest story, and some upstream terms (SLF, SRF, existenz.ch) are
  still unconfirmed for hosted or commercial use, so charging for that data before the outreach
  replies come back would be a real risk.
- **Before billing turns on**, the backlog already lists the prerequisites: email verification on
  key signup, a registered business address, terms of service and an updated ROPA.

## 9. Objections and answers

| Objection | Answer |
|---|---|
| "Isn't this just a wrapper?" | It is 25 wrappers, kept alive every night, with one consistent envelope, coordinate conversion, caching that respects upstream fair use, health checks and a licence register. That is the hard part. |
| "Is this official?" | No. It's independent and open source, built on official Swiss open data and crediting each source on every response. |
| "Can I trust the answers?" | Every response says where it came from, when it was fetched and how fresh the data is. If a source is down, the agent is told. |
| "What about privacy?" | The tools read public data only. The hosted API stores only a hashed key, your email and a usage count, under the Swiss nFADP, with self-service deletion. |
| "What does it cost?" | Free and open source. The hosted API is free during launch. |
| "What about the data licences?" | Each response carries its licence. Most sources are Swiss OGD (free use with attribution). We are confirming hosted-use terms with a few providers. |

## 10. Words to use / avoid

**Use:** gateway, one door, live, attributed, official-first, public data, open source, built on,
credited, Swiss open government data (OGD).

**Avoid:** "official" (about us), "the government's", "all Swiss data", "real-time everything",
"unlimited", "guaranteed", "scraped". Say "official-first" because a few sources are third-party
(e.g. existenz.ch for hydrology history).

Number style: Swiss apostrophe for thousands in Swiss-facing copy (12'000, 50'000).

## 11. Launch checklist (before the post goes out)

- [ ] `npx swissyphus` works (npm publish, `BACKLOG.md` #7). **The post's call to action depends
      on this.** Until then, use the "from source" variant in the LinkedIn file.
- [ ] GitHub Release with `swissyphus.mcpb` attached.
- [ ] Hosted endpoint live, or remove the hosted-API line from the post.
- [ ] Nightly canary green for the demo modules (transport, weather, avalanche, companies).
- [ ] Outreach emails sent (`docs/outreach/`). If SLF or SRF haven't replied, don't feature
      avalanche or news as *hosted* features. Local use is fine.
- [ ] 30–45 s screen recording: one prompt combining transport + weather + avalanche, showing
      the attribution in the answer.
- [ ] Social card image: "The AI gateway to Switzerland", no Swiss coat of arms.
