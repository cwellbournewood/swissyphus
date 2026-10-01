"""Outlined typography: converts text to SVG paths so every print file is font-independent
(production RIPs never need the fonts installed)."""
import math
import os
from functools import lru_cache

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

FONT_DIR = os.path.join(os.path.dirname(__file__), "..", "fonts")

FONTS = {
    "black": "ArchivoBlack.ttf",
    "condensed": "BigShouldersDisplay.ttf",
    "wide": "Unbounded.ttf",
    "serif": "Fraunces.ttf",
    "italic": "CormorantGaramond.ttf",
    "grotesk": "SpaceGrotesk.ttf",
    "mono": "DMMono.ttf",
    "bebas": "BebasNeue.ttf",
    "sc": "PlayfairDisplaySC.ttf",
    "western": "Rye.ttf",
    "script": "Shrikhand.ttf",
    "lines": "Monoton.ttf",
}


@lru_cache(None)
def _font(key):
    f = TTFont(os.path.join(FONT_DIR, FONTS[key]))
    return f, f.getGlyphSet(), f.getBestCmap(), f["head"].unitsPerEm, f["hmtx"]


def glyph_path(key, ch, x, y, size, rot=0.0):
    """Path for a single glyph, baseline-left at (x, y), rotated rot degrees about that point."""
    font, gs, cmap, upm, hmtx = _font(key)
    gname = cmap.get(ord(ch))
    if gname is None:
        return "", 0
    s = size / upm
    c, sn = math.cos(math.radians(rot)), math.sin(math.radians(rot))
    # glyph space (y up) -> svg (y down), scaled, rotated, translated
    # matrix [a b c d e f]: x' = a*x + c*y + e ; y' = b*x + d*y + f
    a, b = s * c, s * sn
    cc, d = s * sn, -s * c
    pen = SVGPathPen(gs)
    gs[gname].draw(TransformPen(pen, (a, b, cc, d, x, y)))
    return pen.getCommands(), hmtx[gname][0] * s


def advance(key, ch, size):
    font, gs, cmap, upm, hmtx = _font(key)
    g = cmap.get(ord(ch))
    return hmtx[g][0] * size / upm if g else size * 0.3


def text_width(key, text, size, track=0.0):
    return sum(advance(key, ch, size) for ch in text) + track * size * max(len(text) - 1, 0)


def text(key, s, x, y, size, anchor="middle", track=0.0, fill="#000", extra=""):
    """Straight outlined text. track is in em units."""
    w = text_width(key, s, size, track)
    if anchor == "middle":
        x -= w / 2
    elif anchor == "end":
        x -= w
    d = []
    for ch in s:
        p, adv = glyph_path(key, ch, x, y, size)
        d.append(p)
        x += adv + track * size
    return f'<path d="{" ".join(d)}" fill="{fill}" {extra}/>'


def text_arc(key, s, cx, cy, r, size, center_deg=-90, track=0.0, fill="#000", inside=False, extra=""):
    """Text along a circle. center_deg: angle of text centre (-90 = top). inside=True reads
    counter-clockwise along the bottom (baseline toward centre)."""
    widths = [advance(key, ch, size) for ch in s]
    total = sum(widths) + track * size * (len(s) - 1)
    # angular length on radius r
    ang_total = math.degrees(total / r)
    d = []
    if not inside:
        a = center_deg - ang_total / 2
        for ch, w in zip(s, widths):
            amid = a + math.degrees((w / 2) / r)
            rad = math.radians(amid)
            # glyph centre placed on circle; baseline tangent
            gx = cx + r * math.cos(rad)
            gy = cy + r * math.sin(rad)
            rot = amid + 90
            # shift back half a width along tangent
            tx = -math.sin(rad) * (-w / 2)
            ty = math.cos(rad) * (-w / 2)
            p, _ = glyph_path(key, ch, gx + tx, gy + ty, size, rot)
            d.append(p)
            a += math.degrees((w + track * size) / r)
    else:
        a = center_deg + ang_total / 2
        for ch, w in zip(s, widths):
            amid = a - math.degrees((w / 2) / r)
            rad = math.radians(amid)
            gx = cx + r * math.cos(rad)
            gy = cy + r * math.sin(rad)
            rot = amid - 90
            tx = math.sin(rad) * (-w / 2)
            ty = -math.cos(rad) * (-w / 2)
            # baseline toward centre: offset outward by cap height
            ox = math.cos(rad) * size * 0.72
            oy = math.sin(rad) * size * 0.72
            p, _ = glyph_path(key, ch, gx + tx + ox, gy + ty + oy, size, rot)
            d.append(p)
            a -= math.degrees((w + track * size) / r)
    return f'<path d="{" ".join(d)}" fill="{fill}" {extra}/>'
