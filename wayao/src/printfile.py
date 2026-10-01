"""Sublimation print files.

piece_art()  -> full-bleed vector art for one garment panel (pattern + printed details)
sheet_svg()  -> 1:1 production sheet (mm) with every panel, bleed, CutContour layer,
                notches, neck tape, colour-control strip and job ticket."""
import math

import numpy as np
from shapely.geometry import Polygon

import brand
import garment as G
import patterns
import typo

CUT_COLOR = "#ff00ff"   # 'CutContour' spot colour convention for print-and-cut RIPs


def lum(hexc):
    r, g, b = (int(hexc[i:i + 2], 16) / 255 for i in (1, 3, 5))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ink_on(d):
    """Detail-print colour that reads on the base."""
    p = d["pal"]
    return p["dark"] if lum(p["base"]) > 0.55 else p["light"]


def piece_dims(piece):
    if piece == "front":
        return G.BODY_W, G.FRONT_L, G.body(False)
    if piece == "back":
        return G.BODY_W, G.BACK_L, G.body(True)
    return G.SLEEVE_W, G.SLEEVE_L, G.sleeve()


def offset(pts, dist):
    poly = Polygon(pts).buffer(dist, join_style=2 if dist > 0 else 1, mitre_limit=3)
    return np.asarray(poly.exterior.coords)


def piece_details(d, piece, W, H):
    p = d["pal"]
    ink = ink_on(d)
    out = ""
    no = f"{d['no']:02d}"
    if piece == "front":
        # vertical micro-print up the wearer's-right side seam
        s = f"WAYAO DISC GOLF  —  No.{no}  {d['name'].upper()}  —  {d['sub'].upper()}"
        x, y = 16, H - 34
        out += f'<g transform="rotate(-90 {x} {y})" opacity="0.7">' + typo.text("mono", s, x, y, 4.6, anchor="start", track=0.08, fill=ink) + "</g>"
    elif piece == "back":
        cx = W / 2
        y0 = G.BACK_DROP
        out += f'<g opacity="0.92">{brand.monogram(cx, y0 + 30, 8.5, ink)}</g>'
        out += typo.text("condensed", d["back_neck"], cx, y0 + 54, 8.5, track=0.32, fill=ink)
        out += f'<rect x="{cx - 18}" y="{y0 + 59}" width="36" height="0.8" fill="{p["a"]}"/>'
        out += typo.text("mono", d["coords"], cx, H - 46, 5.2, track=0.12, fill=ink, extra='fill-opacity="0.75"')
    else:
        cuff_base, stripes = d["cuff"]
        hem = H + 2
        out += f'<rect x="-40" y="{hem - 26}" width="{W + 80}" height="80" fill="{cuff_base}"/>'
        for i, c in enumerate(stripes):
            out += f'<rect x="-40" y="{hem - 22 + i * 7}" width="{W + 80}" height="3.6" fill="{c}"/>'
        vis = W * 0.30 if piece == "sleeve_l" else W * 0.70
        if piece == "sleeve_l":
            out += brand.wordmark(vis, hem - 34, 8, ink, track=0.2)
        else:
            out += f'<circle cx="{vis}" cy="{hem - 44}" r="10" fill="{p["a"]}"/>'
            out += typo.text("black", no, vis, hem - 40.6, 9.4, fill=p["base"] if lum(p["a"]) > 0.45 else p["light"])
    return out


def piece_art(d, piece, uid=None):
    """Full-bleed art for a panel in its own mm coordinates."""
    W, H, _ = piece_dims(piece)
    seed = d["no"] * 1000 + ["front", "back", "sleeve_l", "sleeve_r"].index(piece) * 17
    rng = np.random.default_rng(seed)
    uid = uid or f"{d['no']}{piece[:2]}{piece[-1]}"
    art = patterns.PATTERNS[d["pattern"]](piece, W, H, d["pal"], rng, uid)
    return art + piece_details(d, piece, W, H)


def neck_tape(d, L=420, h=12):
    p = d["pal"]
    out = f'<rect x="0" y="0" width="{L}" height="{h}" fill="{d["rib"][0]}"/>'
    out += f'<rect x="0" y="1" width="{L}" height="0.6" fill="{p["a"]}"/><rect x="0" y="{h - 1.6}" width="{L}" height="0.6" fill="{p["a"]}"/>'
    s = (d["tape"] + " ") * 6
    ink = p["light"] if lum(d["rib"][0]) < 0.5 else p["dark"]
    out += typo.text("condensed", s, 4, h / 2 + 2.1, 5.6, anchor="start", track=0.2, fill=ink)
    return out


def neck_label(d, x, y, ink):
    """Tagless printed neck label (inside back)."""
    out = brand.monogram(x, y, 6, ink)
    out += typo.text("wide", "WAYAO", x, y + 14, 4.2, track=0.2, fill=ink)
    out += typo.text("mono", "M  ·  100% RECYCLED POLY", x, y + 21, 2.8, fill=ink)
    out += typo.text("mono", f"No.{d['no']:02d} {d['name'].upper()}", x, y + 26, 2.8, fill=ink)
    return out


# ------------------------------------------------------------------ production sheet
SHEET_W = 1600   # 1.6 m roll


def sheet_svg(d, proof=False):
    """Returns (svg, width_mm, height_mm). proof=True overlays sew lines, embroidery
    placements and annotations (never sent to the printer)."""
    pieces = [("front", 40, 60), ("back", 660, 60), ("sleeve_l", 40, 880), ("sleeve_r", 580, 880)]
    defs, art, cut, guides = "", "", "", ""
    for piece, px, py in pieces:
        W, H, fin = piece_dims(piece)
        cutl = offset(fin, G.SEAM)
        bleed = offset(fin, G.SEAM + G.BLEED)
        ox, oy = px + G.SEAM + G.BLEED, py + G.SEAM + G.BLEED
        cid = f"clip_{piece}"
        defs += f'<clipPath id="{cid}"><path d="{G.path_d(bleed, ox, oy)}"/></clipPath>'
        art += f'<g clip-path="url(#{cid})"><g transform="translate({ox} {oy})">{piece_art(d, piece)}</g></g>'
        cut += f'<path d="{G.path_d(cutl, ox, oy)}" fill="none" stroke="{CUT_COLOR}" stroke-width="0.25"/>'
        # notches: centre front/back and shoulder points (3 mm triangles on the cut line)
        if piece in ("front", "back"):
            for nx, ny in [(W / 2, H + 2 + G.SEAM), (W / 2, (G.BACK_DROP if piece == "back" else G.FRONT_DROP) - G.SEAM)]:
                cut += f'<path d="M{ox + nx - 2},{oy + ny} L{ox + nx},{oy + ny + (3 if ny < 100 else -3)} L{ox + nx + 2},{oy + ny}" fill="none" stroke="{CUT_COLOR}" stroke-width="0.25"/>'
        else:
            cut += f'<path d="M{ox + W / 2 - 2},{oy - G.SEAM} L{ox + W / 2},{oy - G.SEAM + 3} L{ox + W / 2 + 2},{oy - G.SEAM}" fill="none" stroke="{CUT_COLOR}" stroke-width="0.25"/>'
        # piece label inside seam allowance zone (prints, gets sewn in)
        lbl = f"WAYAO {d['no']:02d} {d['slug'].upper()} · {piece.upper().replace('_', ' ')} · SIZE M"
        art += typo.text("mono", lbl, ox + W / 2, oy + H + G.SEAM - 2.5, 3.2, fill="#888888")
        if proof:
            guides += f'<path d="{G.path_d(fin, ox, oy)}" fill="none" stroke="#00a0ff" stroke-width="0.5" stroke-dasharray="4 3"/>'
            guides += typo.text("grotesk", piece.upper().replace("_", " "), ox + W / 2, oy - G.SEAM - G.BLEED - 8, 9, fill="#222")
            if piece == "front":
                cx = W / 2
                for (ex, ey, sz, name) in [(cx + 105, 172, 78, "CREST — EMBROIDERY 78 MM"), (cx - 105, 172, 46, "MONOGRAM — EMBROIDERY 46 MM")]:
                    guides += f'<rect x="{ox + ex - sz / 2}" y="{oy + ey - sz / 2}" width="{sz}" height="{sz}" fill="none" stroke="#00a0ff" stroke-width="0.6" stroke-dasharray="3 2"/>'
                    guides += typo.text("grotesk", name, ox + ex, oy + ey + sz / 2 + 7, 4.5, fill="#00a0ff")
                guides += f'<rect x="{ox + W - 110}" y="{oy + H - 64}" width="50" height="22" fill="none" stroke="#00a0ff" stroke-width="0.6" stroke-dasharray="3 2"/>'
                guides += typo.text("grotesk", "WOVEN TAG 50x22", ox + W - 85, oy + H - 36, 4.5, fill="#00a0ff")
    # neck tape strip + printed neck label
    tx, ty = 1140, 900
    defs += '<clipPath id="tapeclip"><rect x="0" y="0" width="420" height="12"/></clipPath>'
    art += f'<g transform="translate({tx} {ty})"><g clip-path="url(#tapeclip)">{neck_tape(d)}</g></g>'
    cut += f'<rect x="{tx}" y="{ty}" width="420" height="12" fill="none" stroke="{CUT_COLOR}" stroke-width="0.25"/>'
    if proof:
        guides += typo.text("grotesk", "NECK TAPE 420 x 12 (BACK NECK SEAM)", tx + 210, ty - 6, 7, fill="#222")
    # colour control strip
    p = d["pal"]
    sw = [p["base"], p["tone"], p["a"], p["b"], p["c"], p["light"], p["dark"], d["rib"][0]] + d["rib"][1]
    cy0 = 945
    for i, c in enumerate(sw):
        art += f'<rect x="{1140 + i * 22}" y="{cy0}" width="20" height="20" fill="{c}"/>'
        art += typo.text("mono", c.upper(), 1150 + i * 22, cy0 + 25, 2.6, fill="#555555")
    for i, k in enumerate(["#00ffff", "#ff00ff", "#ffff00", "#000000", "#808080", "#c0c0c0"]):
        art += f'<rect x="{1140 + i * 22}" y="{cy0 + 32}" width="20" height="10" fill="{k}"/>'
    # job ticket
    jt = 1140, 1030
    art += typo.text("wide", "WAYAO", jt[0], jt[1], 14, anchor="start", track=0.15, fill="#111111")
    lines = [f"No.{d['no']:02d} / 12 — {d['name'].upper()} — {d['sub'].upper()}",
             "SUBLIMATION PRINT SHEET · SIZE M · SCALE 1:1 (MM)",
             "FABRIC: 140 GSM RECYCLED POLY INTERLOCK, TONAL JACQUARD",
             "BLEED 15 MM · SEAM ALLOWANCE 10 MM INCL. · CUT ON MAGENTA",
             "MIRROR ON TRANSFER PAPER · PROFILE TO FABRIC ICC",
             f"PALETTE: {' '.join(sw[:7]).upper()}"]
    for i, l in enumerate(lines):
        art += typo.text("mono", l, jt[0], jt[1] + 14 + i * 9, 5.2, anchor="start", fill="#333333")
    Hs = 1220
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{SHEET_W}mm" height="{Hs}mm" viewBox="0 0 {SHEET_W} {Hs}">'
           f'<defs>{defs}</defs><rect width="{SHEET_W}" height="{Hs}" fill="#ffffff"/>'
           f'<g id="ART">{art}</g><g id="CutContour">{cut}</g>' + (f'<g id="PROOF-GUIDES">{guides}</g>' if proof else "") + "</svg>")
    return svg, SHEET_W, Hs
