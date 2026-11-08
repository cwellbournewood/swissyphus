# Swissyphus brand kit

One source of truth for how Swissyphus looks and sounds: the website, the README, social posts,
slides, and any design tool (Claude Design, Figma). Assets are in [`assets/`](../../assets);
machine-readable tokens are in [`tokens.json`](tokens.json); website copy is in
[`WEBSITE.md`](WEBSITE.md).

## Positioning

| | |
|---|---|
| **Name** | Swissyphus (one word, capital S; lower-case `swissyphus` only for the package and CLI) |
| **Category line** | The Swiss public-data rollup for AI agents |
| **Promise** | Swiss data your agent can cite |
| **Proof line** | 60 public sources · 143 tools · zero API keys · every answer cited, down to the exact upstream request |
| **Boilerplate (short)** | Swissyphus rolls up 60 Swiss public data sources into one MCP server and REST API, and keeps it running. Every answer carries its publisher, licence, the publisher's timestamp and the exact upstream requests behind it. Open source (MIT). |
| **Name story** (use sparingly) | Like Sisyphus, the work never ends: Swiss sources change, move and go down, and the rollup keeps running. The difference is that it's automated. |

### The idea: a rollup, always running

Swiss public data is spread across 60 services with different APIs, formats, languages and
licences. Swissyphus **rolls them up** into one interface and **keeps it running**: caching,
fail-over to the last good answer, a nightly check of every source. The spiral mark is that
idea: many lines rolled into one, with a single thread running out of it.

### Message pillars

1. **Cited.** Every answer says who published it, under which licence, how current it is, and
   exactly which request produced it. (`source`, `data_as_of`, `provenance.upstream`)
2. **Complete.** 60 sources and the catalogues behind them: `find_data` searches 15'000+
   datasets, layers and tables and queries their contents.
3. **Always running.** Built to degrade gracefully and to be polite to public infrastructure.
4. **Zero friction.** One command, no signup, no keys. Seven tools in context if you want, all
   143 reachable.

Lead with **Cited**. It is the difference no one else offers.

## Numbers

Use these exact figures. Re-derive them before a launch or redesign:

| Figure | Value (1.0.0) | Re-derive with |
|---|---|---|
| Tools | 143 | `npx -y swissyphus --list-modules` (last line) |
| Modules | 41 | same |
| Public sources | 60 | `docs/TOOLS.md` header (`npm run catalogue`) |
| Publishing organisations | 40+ | distinct `operator` values in `tools.schema.json` (52 strings, ~44 after merging spelling variants of the same office) |
| Queryable datasets, layers and tables | 15'000+ | opendata.swiss (~12'000) + geo.admin.ch (~900) + BFS tables + LINDAS cubes |
| Tools in discovery mode | 7 | `--preset discovery` |

Swiss number style: thousands separated with `'` (15'000), not a comma.

## Voice

- **Plain and precise.** Say what it does with numbers and names: "the SECO sanctions list", not
  "comprehensive compliance data".
- **Calm confidence.** No hype words (revolutionary, seamless, powerful, cutting-edge).
- **Credit the publishers.** The data is theirs. We roll it up and cite it.
- **Short sentences.** One idea each.

| Write | Avoid |
|---|---|
| "Every answer cited, down to the exact upstream request" | "Fully transparent AI data platform" |
| "60 public sources" | "all Swiss data" |
| "independent open-source project" | "official", "government-backed", "the Swiss API" |
| "rolls up", "rollup", "always running" | "uphill", "boulder", "struggle" |

## Logo

| File | Use |
|---|---|
| `assets/logo.svg` | The mark in Signal Red on any background, light or dark |
| `assets/icon.svg` / `assets/icon.png` (512 px) | App icon: white mark on a red rounded square (`.mcpb`, favicons, avatars) |
| `assets/banner-light.png` / `assets/banner-dark.png` | Mark + wordmark + category line, transparent background, for light and dark pages |
| `assets/social-preview.png` (1280×640) | GitHub social preview and link cards (Open Graph) |

**The mark** is an open spiral that runs out into a line ending in a dot: data rolled up into one
thread, with the dot as the rolling stone. Keep clear space of at least half the mark's width
around it, and use it at 16 px or larger (icon version below 24 px).

**Wordmark:** "Swissyphus" set in Inter ExtraBold, letter-spacing −3 %, next to the mark.

**Don't:** recolour the mark outside the palette, rotate it, add effects, or put the red mark on
a red background (use the icon version).

### No Swiss cross

Do not use the Swiss cross, the Swiss flag or the federal coat of arms in the logo, the
website's identity or marketing graphics. They are protected (Coat of Arms Protection Act, WSchG),
and they would make Swissyphus look like an official federal service, which it is not. Saying
"Swiss" in words is fine. The 🇨🇭 emoji can appear in casual social posts, never as the brand.

## Colour

| Token | Hex | Use |
|---|---|---|
| Signal Red | `#E5322D` | The mark, primary buttons, links, highlights. Sparingly |
| Ink | `#0B0F19` | Text on light, dark backgrounds |
| Snow | `#F7F6F3` | Light backgrounds, text on dark |
| Slate | `#5B6472` | Secondary text on light |
| Mist | `#AEB4BE` | Secondary text on dark |
| Glacier | `#7CC4E8` | Code keys, data accents, charts (secondary series) |
| Night | `#111827` | Code blocks and cards on dark |

Contrast: Ink on Snow and Snow on Ink pass WCAG AAA. Signal Red on Snow passes AA for large text
and UI (3:1+); for body-size red text on light backgrounds, use it only for links that are also
underlined.

## Type

| Role | Typeface | Weights |
|---|---|---|
| Headlines, UI, body | **Inter** (OFL) | 400, 600, 700, 800 |
| Code, numbers in data | **JetBrains Mono** (OFL) | 400, 600 |

Headlines: tight letter-spacing (−2 % to −3 %). Body: 16–18 px, line height 1.5–1.6.

## Imagery

Show the product, not stock photos: real tool answers, the envelope with its provenance, a
terminal with `npx -y swissyphus`, a map point resolving into a location report. Swiss landscape
photography is fine for editorial context; credit the photographer, and never imply official
endorsement.
