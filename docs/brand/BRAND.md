# Swissyphus brand kit: the Carte Nationale system

One source of truth for how Swissyphus looks and sounds: website, README, social, slides, motion
and design tools. The system was designed in Claude Design ("Swissyphus brand identity options",
page *Brand Final*); this file records it for the repository. Assets are in
[`assets/`](../../assets), tokens in [`tokens.json`](tokens.json), website copy in
[`WEBSITE.md`](WEBSITE.md), motion pieces in [`docs/launch/motion/`](../launch/motion/).

The idea: a Swiss national map sheet. Cartographic precision, gridded Swiss typography, and a
myth for a mascot.

## Positioning

| | |
|---|---|
| **Name** | `swissyphus` in the wordmark (lower case); Swissyphus in running text |
| **Category line** | The Swiss public-data rollup for AI agents |
| **Hero line** | Every Swiss source. **Always running.** (second sentence in Trail Marker) |
| **Promise** | Swiss data your agent can cite |
| **Proof line** | 151 tools · 66 public sources · zero API keys · every answer cited, down to the exact upstream request |
| **Boilerplate** | Swissyphus rolls up 66 Swiss public data sources into one MCP server and REST API, and keeps it running. Every answer carries its publisher, licence, the publisher's timestamp and the exact upstream requests behind it. Open source (MIT). |

**The myth, retold.** Sisyphus rolls the same boulder forever. Swissyphus is the rollup that
never stops: 66 sources that change, move and go down, kept in one interface, every day,
automatically. Say "rollup" and "always running"; don't say "uphill" or "struggle".

### Message pillars (lead with the first)

1. **Cited.** Every answer says who published it, under which licence, how current it is and
   which exact request produced it.
2. **Complete.** 66 sources and the catalogues behind them; `find_data` searches 15'000+
   datasets, layers and tables and queries their contents.
3. **Always running.** Caching, immediate back-off on rate limits, the last good answer when a
   source is down, a nightly check of every source.
4. **Zero friction.** One command, no signup, no keys; 7 tools in context if you want, all 151
   reachable.

## Numbers

| Figure | Value (1.0.0) | Re-derive with |
|---|---|---|
| Tools | 151 | `npx -y swissyphus --list-modules` (last line) |
| Modules | 45 | same |
| Public sources | 66 | header of `docs/TOOLS.md` (`npm run catalogue`) |
| Queryable datasets, layers and tables | 15'000+ | opendata.swiss (~12'000) + geo.admin.ch (~900) + BFS tables + LINDAS cubes |
| Tools in discovery mode | 7 | `--preset discovery` |

Swiss number style: `15'000`, LV95 coordinates as `2'692'000 / 1'202'000`.

## Mark

**The boulder on the slope.** A Trail Marker circle above a Lake Deep right triangle. The circle
never touches the incline: the work is never done. The slope is fixed at 33°, the angle at which
avalanches start.

| File | Use |
|---|---|
| `assets/logo.svg` | Mark for light backgrounds (Lake Deep slope) |
| `assets/logo-dark.svg` | Mark for dark backgrounds (Glacier slope, so the boulder stays the only warm pixel) |
| `assets/icon.svg`, `assets/icon.png` (512 px) | Favicon / app tile: Lake Deep tile, Glacier slope, Trail Marker boulder. Used in the `.mcpb` bundle and the MCP Registry |
| `assets/banner-light.png`, `assets/banner-dark.png` | README lockups |
| `assets/social-preview.png` (1280×640) | GitHub social preview, Open Graph |

Geometry on a 38-unit grid: slope `M0 38 H38 V13 Z`, boulder `r=8` at `(28, 8)`. Favicon on a
64 grid: tile radius 12, slope `M8 54 H56 V23 Z`, boulder `r=10` at `(43, 19)`.

**Lockup:** mark + `swissyphus` in Archivo 700, letter-spacing −2 %. **Don't** recolour the
boulder, let it touch the slope, rotate the mark, or add shadows.

### No Swiss cross

Never use the Swiss cross, flag or coat of arms in the identity. They are protected (Coat of Arms
Protection Act, WSchG) and would make Swissyphus look like an official federal service, which it
is not. The 🇨🇭 emoji may appear in casual social posts, never as a mark.

## Colour

| Name | Hex | Role | Share |
|---|---|---|---|
| Lake Deep | `#123C4D` | Ink, surfaces, rules | ~40 % |
| Contour | `#1F7A8C` | Lines, links, secondary labels | ~20 % |
| Glacier | `#8FC1C4` | Fills; the slope and secondary text on dark | ~10 % |
| Snowfield | `#EEF3F2` | Paper | ~25 % |
| Trail Marker | `#D97B4F` | Accent only: the boulder, one highlight per view | ~5 % |

Support tones: Night `#0B2733` (deepest surfaces), Ink 2 `#3D5A63` (body text on paper), Trail
ink `#B0532A` (Trail Marker for small text on paper, AA contrast), Trail light `#E8956C` (accent
text on dark).

## Type

| Role | Typeface | Setting |
|---|---|---|
| Display | **Archivo Expanded** (Archivo, `wdth` 118) | 800, UPPERCASE, tracking −3 %, tight leading (0.9–1.0) |
| Body | **Archivo** | 400 / 600, 15–18 px, leading 1.55 |
| Data & code | **IBM Plex Mono** | 400 / 500; eyebrows in caps with +12 % tracking |

All three are open-licensed (OFL) and on Google Fonts.

## Grid discipline

Everything sits on a visible 1 px rule grid in Lake Deep. Columns divide the page like map
sheets. No soft shadows and no rounded cards: the border is the design. Radius only for pills
and the favicon tile. Paper carries a faint 105° hatch (`rgba(31,90,110,.08)` every 53 px).
Baseline 8 px, gutters 44 px.

Recurring details: coordinates in mono (`46.8003° N, 8.2318° E`), map-sheet footers
(`1:25'000 · CH · 2026`), numbered eyebrows (`01 — MARK`).

## Voice

**Declarative, exact, wry.** Coordinates over adjectives; the myth carries the humour so the docs
don't have to.

> "One must imagine the API happy."
> "Every Swiss source. Always running."
> "No signup. No keys. Under 60 seconds to first result."

| Write | Avoid |
|---|---|
| "every answer cited, down to the exact upstream request" | "fully transparent AI platform" |
| "66 public sources" | "all Swiss data" |
| "independent open-source project" | "official", "government-backed" |
| "rollup", "always running" | "uphill", "struggle", hype words |

## Motion

Cuts on the grid, not fades: rules draw in, numbers tick in mono, the boulder rolls along the
slope to mark a beat. One Trail Marker accent per frame. See [`docs/launch/motion/`](../launch/motion/).
