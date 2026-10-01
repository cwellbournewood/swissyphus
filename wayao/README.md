# WAYAO — Disc Golf Jersey Collection (12 sublimated crew necks)

These are twelve all-over-sublimated crew-neck disc golf jerseys. They follow the independent
football-shirt studio playbook: rich culture-driven patterns, layered embroidered crests, a knit
rib collar with tipping, printed neck tape, a woven jock tag and micro-print details. Everything
is adapted for disc golf and for Wayao.

| No. | Name | Concept | Crest |
|----|------|---------|-------|
| 01 | **Alpenglow** — Hohe Tauern Edition | Topographic contours glowing coral over navy, with Alpine ridge band | Shield · mountain + sun |
| 02 | **Chain Reaction** — Basket Series | Draped basket chains, brushed-gold chain band at basket height | Roundel · basket |
| 03 | **Flight Path** — Numbers Edition | Hyzer / anhyzer / flex flight lines, lime flight-number columns | Hex · disc + flight arc |
| 04 | **Secession** — Wien 1900 | Klimt spirals, gold-leaf discs, Hoffmann checker side panels | Octagon · Secession dome |
| 05 | **Edelweiss** — Tracht Edition | Austrian folk lattice: edelweiss, gentian, alpine rose, red-white-red hem | Roundel · edelweiss |
| 06 | **Fairway Tartan** — Heritage Sett | Custom Wayao tartan in 2/2 twill: hunter, navy, burgundy, gold | Shield · saltire + disc |
| 07 | **Ace Run '96** — Retro Keeper | 90s shards, zigzags and brush confetti in teal / violet / yellow | Shield · bolt + disc |
| 08 | **Ice Bowl** — Winter Classic | Hex ice lattice and frost crystals, glacier white to steel blue | Hex · snow crystal |
| 09 | **Mando** — Course Map Edition | Fairways, tee pads, baskets, OB lines, mando arrows, map legend | Roundel · compass |
| 10 | **Hyzer Wave** — Indigo Edition | Seigaiha waves + white hyzer surf, vermilion rising sun | Roundel · wave + sun |
| 11 | **Wooded** — Forest Course Edition | Tree-ring cross-sections, fern fronds, bark grain on moss | Shield · spruce + rings |
| 12 | **Glow Round** — After Dark | Long-exposure neon flight trails, glowing basket at the tree line | Hex · moon + glow rings |

## What each design folder contains (`collection/NN-slug/`)

```
print/
  *_sublimation-sheet.pdf      ← PRODUCTION MASTER: vector, 1:1 mm, 1600 x 1220 mm roll layout
  *_sublimation-sheet.svg        same, editable (layers: ART / CutContour)
  *_proof.png                    proof with sew lines + embroidery / tag placement guides
  *_panel-front|back|sleeve_l|sleeve_r.svg   single flat panels with bleed + cut line
  *_crest-embroidery.svg         vector crest (78 mm) for the embroidery digitiser
  *_monogram-embroidery.svg      vector W monogram (46 mm)
mockups/
  01-front · 02-back             ghost-mannequin studio shots
  03-detail-crest                stitched embroidery close-up
  04-detail-collar               rib collar, tipping, neck tape, printed label
  05-detail-cuff                 sleeve cuff band + sleeve print
  06-detail-tag                  woven jock tag at hem
  07-detail-backneck             back-neck print
  08-flatlay                     lifestyle flat-lay with stamped disc, marker, scorecard, hang tag
video/  *.mp4                    ~18 s 4:5 product film (title, details, back, flat-lay)
*_tech-pack.pdf / .png           construction, trims, thread map, colour standards, placements
```

`collection/wayao-collection-reel.mp4` is a reel of all 12 shirts.

## Print-file spec

* Fabric: 140 gsm recycled polyester interlock with tonal jacquard knit.
* The sheet is size M at 1:1 in millimetres. It includes **15 mm bleed** beyond a **10 mm seam allowance**, and the cut line is drawn as a 0.25 mm
  magenta `CutContour` stroke in its own layer, with notches at centre front/back and the sleeve cap.
* All text is outlined to paths, so no fonts are needed at the RIP. Panel labels sit inside the seam allowance.
* There is a colour-control strip of the design palette plus a CMYK/grey patch row, and a job ticket on every sheet.
* Mirror on transfer paper and profile to the fabric ICC as usual. A raster TIFF can be generated at any DPI:
  `python3 src/build.py 1 --tiff 150`.
* Other sizes: grade the panels from `src/garment.py`. The block is parametric, so every panel and mockup regenerates.

## Rebuilding

```
pip install pillow numpy scipy opencv-python-headless cairosvg fonttools shapely
python3 src/build.py            # all 12 (≈ 3 min each, parallel)
python3 src/build.py 4 7        # just Secession and Ace Run '96
python3 src/build.py --reel     # collection reel from the built fronts
```

`src/` layout: `designs.py` (concepts, palettes, trims), `patterns.py` (12 vector pattern generators),
`brand.py` (wordmark, monogram, 12 crests as thread layers), `garment.py` (pattern block),
`printfile.py` (sheets), `mockup.py` (renderer: folds, lighting, knit, embroidery shader, rib, tag),
`scenes.py` (flat-lay, video), `techpack.py`.

> **Brand note:** the WAYAO wordmark and W-disc monogram here are placeholders drawn to match the brand's tone.
> Drop the official logo vectors into `brand.wordmark()` / `brand.monogram()` and rebuild. Every crest, tag,
> label and mockup updates automatically. Fonts are OFL Google Fonts (`fonts/`).
