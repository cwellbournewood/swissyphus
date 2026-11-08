# LinkedIn launch post

Two versions: **launch day** (after `npx swissyphus` works) and **pre-release** (from source).
Post from a personal profile. LinkedIn shows about 210 characters before "…see more", so the
first two lines carry the post. Put links in the first comment, not the post body, because
LinkedIn reach drops for posts with outbound links.

Attach: a 30–45 s screen recording of one multi-source prompt, or a social card that reads
"The AI gateway to Switzerland".

---

## A. Launch day (use once npm 0.5.0 is published)

> Switzerland is one of the best-documented countries on earth.
> Your AI assistant still can't tell you if the 8:02 to Zermatt is on time and whether there's avalanche danger when you arrive.
>
> Today I'm launching **Swissyphus 🇨🇭 — the AI gateway to Switzerland.**
>
> We have extraordinary public data here. SBB timetables to the minute. MeteoSwiss stations every 10 minutes. Snow depth from 300+ SLF alpine stations. Every company in the commercial register, every law in Fedlex, every federal vote result.
>
> But it lives behind 30+ different doors, each with its own API, format, language and coordinate system. Great for specialists. Unusable for an AI agent.
>
> Swissyphus is one door.
>
> 🚆 Transport, weather, rivers & lakes, avalanches, snow, earthquakes
> 🏢 Companies, the SOGC gazette, federal law, parliament, vote results
> 🗺️ Maps, buildings, solar potential, electricity tariffs, EV chargers
> 🚉 Yesterday's punctuality at any station, live rail disruptions, vote results down to your municipality
> …30 domains, 108 tools, one install.
>
> Three things I cared about:
>
> ✅ **Every answer shows its receipt.** Source, licence, attribution and data freshness on every response. Your AI cites MeteoSwiss instead of guessing.
> ✅ **Zero friction.** `npx swissyphus`. No API key, no signup, under a minute.
> ✅ **Open and free.** MIT-licensed, runs locally. Works with Claude, Cursor and any MCP client, plus a REST API with OpenAPI.
>
> The credit belongs to the people who built this data: swisstopo, MeteoSwiss, SBB, SLF, FOEN, the Federal Office of Justice, BFS, and many more. Switzerland built the data. I built the door.
>
> Why the name? Like Sisyphus, except the boulder is 30+ fragmented data sources, and we roll it uphill every night so your agent doesn't have to.
>
> Try asking it:
> 💬 "Ski tour near Davos: avalanche danger, snow depth, trail closures and the train there."
> 💬 "Due diligence on a Swiss company: register entry and gazette history."
> 💬 "Is the Data Protection Act in force, and how did Ticino vote last month?"
>
> Link in the comments. I'd love feedback, and especially to hear which Swiss data source you'd want next. 👇
>
> #Switzerland #OpenData #AI #MCP #OpenSource #SwissTech #OGD

**First comment:**

> 🔗 GitHub: https://github.com/cwellbournewood/swissyphus
> Install: `npx swissyphus` (Claude Desktop users: one-click `.mcpb` on the Releases page)
>
> Independent open-source project, not affiliated with the Swiss federal administration. Built on Swiss open government data, credited on every response.

---

## B. Pre-release (if posting before npm publish)

Same post, with these changes:

- Replace "Today I'm launching" with **"I've been building"**.
- Replace the "Zero friction" line with:
  > ✅ **Zero keys.** No API key, no signup. Run it from source today; one-line `npx` install is coming with the first release.
- End with: *"It's pre-release. If you build with AI in Switzerland, I'm looking for early testers. 👇"*

---

## C. Short version (for reposts, or a follow-up a week later)

> What if your AI assistant actually knew Switzerland?
>
> Swissyphus is an open-source gateway that gives any AI live access to Swiss public data: SBB, MeteoSwiss, swisstopo, SLF, the commercial register, Fedlex, vote results and more. 30+ sources, 108 tools, one install, no API keys. Every answer cites its source.
>
> Switzerland built the data. Swissyphus is the door. 🇨🇭
>
> Link in comments 👇
>
> #Switzerland #OpenData #AI #MCP

---

## D. German version (short)

> Die Schweiz gehört zu den am besten dokumentierten Ländern der Welt. Trotzdem weiss dein KI-Assistent nicht, ob der Zug nach Zermatt pünktlich ist und wie hoch die Lawinengefahr ist.
>
> Swissyphus ist das KI-Tor zur Schweiz: ein Open-Source-Connector, der jeder KI Live-Zugriff auf Schweizer Open Government Data gibt. SBB, MeteoSwiss, swisstopo, SLF, Handelsregister, Fedlex, Abstimmungsresultate und mehr. über 30 Quellen, 108 Tools, eine Installation, kein API-Key. Jede Antwort nennt Quelle, Lizenz und Aktualität.
>
> Die Schweiz hat die Daten gebaut. Swissyphus ist die Tür. 🇨🇭
>
> Link in den Kommentaren 👇
>
> #Schweiz #OpenData #KI #OpenSource

---

## Notes before posting

- **Check every claim on the day.** Module and tool counts come from the README (30 / 108). If the
  hosted API isn't live, don't mention it. If SLF hasn't confirmed hosted use, the avalanche demo
  should run locally.
- **Tag carefully.** Tagging federal offices' LinkedIn pages can read as implied endorsement.
  Name them in text instead, unless they have agreed.
- **Reply to every comment in the first hour.** "Which source should come next?" invites replies
  and feeds the roadmap (SIMAP, FINMA, ESTV, cantonal GIS are already listed).
