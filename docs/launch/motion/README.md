# Launch films

Three 16-second films (1920×1080, 30 fps, H.264), one use case each, in the Carte Nationale
system ([`docs/brand/BRAND.md`](../../brand/BRAND.md)). Every figure on screen comes from a real
Swissyphus call made on **8 November 2026**: the films do what they advertise.

| Film | Use case | For | Device |
|---|---|---|---|
| [`01-weekend-in-davos.mp4`](01-weekend-in-davos.mp4) | Planning a mountain weekend: train, snow, trails, avalanche season | Everyday users, travel, outdoor | A 1:25'000 map sheet; the route draws from Zürich to Davos while four tools answer |
| [`02-supplier-check.mp4`](02-supplier-check.mp4) | Supplier due diligence: register, gazette, sanctions, public contracts | Business, procurement, compliance | A dossier that stamps each check "cited", with the upstream requests alongside |
| [`03-number-behind-the-headline.mp4`](03-number-behind-the-headline.mp4) | Checking a figure before you publish it | Journalists, researchers, analysts | A number counts up, then the envelope behind it unfolds: publisher, timestamp, exact request |

Each ends on the same card: the boulder rolls up its slope; *Every Swiss source. Always
running.*; `npx -y swissyphus`.

## Posting

| Film | Best channel | Caption |
|---|---|---|
| 01 | X, Bluesky, Instagram, Mastodon | Ski touring above Davos this weekend? Swissyphus asks the timetable, SLF's snow stations and the trail-closure map, and cites each answer. Verdict on 8 November: trains run, snow doesn't, yet. `npx -y swissyphus` |
| 02 | LinkedIn | Supplier due diligence in one question. Commercial register, sanctions screen and public-contract record, each with its publisher and the exact request behind it. Ready for the file. Swissyphus 1.0: 66 Swiss public sources, one MCP server, every answer cited. |
| 03 | Show HN comment, Reddit, newsletter, blog | Don't trust the number. Check it. Every Swissyphus answer carries its publisher, licence, the publisher's own timestamp and the exact upstream request, so a figure can be re-run before it is published. |

Post 03 with the launch announcement (it shows the core idea), 02 on LinkedIn the same day, and
01 a day later. Upload natively (not as links) so they autoplay; add the caption's first line as
burned-in text only if the channel mutes without captions (the films have no audio).

## Where every figure comes from

| Film | On screen | Tool | Source | As of |
|---|---|---|---|---|
| 01 | Zürich HB 22:38 (IC3) → Landquart 23:49, R 00:00 → Davos Platz 01:10; 2 h 32, 1 change | `get_connections` | transport.opendata.ch (Swiss timetable) | 8 Nov 2026 |
| 01 | 1 cm snow at 2'558 m, −3.2 °C, Bärentälli (DAV2), 21:30 | `get_snow_conditions` | SLF/WSL IMIS | 8 Nov 2026, 20:30 UTC |
| 01 | 11 trail closures within ±15 km of Davos | `get_trail_closures` | ASTRA / SwitzerlandMobility | 8 Nov 2026 |
| 01 | No avalanche bulletin published yet | `get_avalanche_danger_at` | SLF | 8 Nov 2026 |
| 02 | Stadler Rail AG: active, corporation, Bussnang TG, UID CHE-101.581.089; last SOGC publication 4 Nov 2026 | `search_companies` | ZEFIX (FOJ) | 8 Nov 2026 |
| 02 | No match on the Swiss sanctions list | `search_sanctions_list` | SECO list of 4 Nov 2026 | 8 Nov 2026 |
| 02 | CHF 9'188'500 award by BLS AG to Stadler Signalling AG (group company), decision 4 May 2026 | `search_public_tenders`, `get_tender_details` | simap.ch | 8 Nov 2026 |
| 03 | 136'836 vehicles/day at A1 Wallisellen (busiest of 340 counting stations); evening peak 9'144/h; weekday 140'139; heavy goods 4.7 % | `get_traffic_counts` | FEDRO (ASTRA), annual average 2025 | 8 Nov 2026 |

Live data changes. Before re-using a film after a few weeks, re-run the calls above and
re-render if a figure has moved.

## Re-rendering

Sources are in [`src/`](src): one HTML scene per film (`window.render(t)` draws frame *t*), a
shared runtime and stylesheet, and the brand fonts (Archivo and IBM Plex Mono, both SIL Open
Font License; licences in `src/fonts/`).

```bash
cd docs/launch/motion/src
npm i --no-save playwright && npx playwright install chromium
node render.cjs 01-weekend-in-davos.html ../01-weekend-in-davos.mp4
```

Needs `ffmpeg` on the PATH. Change a figure in the scene's HTML, re-render, and update the table
above.
