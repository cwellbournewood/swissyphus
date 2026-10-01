"""All-over sublimation patterns. Pure vector, generated in millimetre space.

Each generator: fn(piece, W, H, pal, rng) -> svg fragment covering (-BLEED,-BLEED)..(W+BLEED,H+BLEED).
`piece` is one of front / back / sleeve_l / sleeve_r so each panel can carry its own hero
placement while sharing one visual language."""
import math

import cv2
import numpy as np
from scipy.ndimage import gaussian_filter

import typo
from garment import BLEED, SEAM

B = SEAM + BLEED + 6


# ---------------------------------------------------------------- helpers
def rect(x, y, w, h, fill, extra=""):
    return f'<rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h:.2f}" fill="{fill}" {extra}/>'


def bg(W, H, fill):
    return rect(-B, -B, W + 2 * B, H + 2 * B, fill)


def pl(pts, close=False):
    if len(pts) == 0:
        return ""
    s = "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in pts)
    return s + (" Z" if close else "")


def smooth_d(pts, close=False):
    """Catmull-Rom -> cubic bezier path through points."""
    pts = np.asarray(pts, float)
    n = len(pts)
    if n < 3:
        return pl(pts, close)
    if close:
        P = np.vstack([pts[-1], pts, pts[0], pts[1]])
    else:
        P = np.vstack([pts[0], pts, pts[-1]])
    d = f"M{P[1][0]:.1f},{P[1][1]:.1f}"
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        c1 = p1 + (p2 - p0) / 6
        c2 = p2 - (p3 - p1) / 6
        d += f" C{c1[0]:.1f},{c1[1]:.1f} {c2[0]:.1f},{c2[1]:.1f} {p2[0]:.1f},{p2[1]:.1f}"
    return d + (" Z" if close else "")


def noise(W, H, res, scales, rng, weights=None):
    gw, gh = int((W + 2 * B) / res) + 2, int((H + 2 * B) / res) + 2
    f = np.zeros((gh, gw))
    weights = weights or [1.0] * len(scales)
    for s, wt in zip(scales, weights):
        f += wt * gaussian_filter(rng.standard_normal((gh, gw)), s / res, mode="wrap")
    f = (f - f.min()) / (np.ptp(f) + 1e-9)
    return f


def contours(field, levels, res, ox=-B, oy=-B, eps=0.6, min_len=6):
    """Iso-lines of a scalar field -> list of (level_index, points_mm)."""
    out = []
    up = 4
    big = cv2.resize(field.astype(np.float32), None, fx=up, fy=up, interpolation=cv2.INTER_CUBIC)
    for li, lv in enumerate(levels):
        m = (big > lv).astype(np.uint8)
        cs, _ = cv2.findContours(m, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
        for c in cs:
            if len(c) < min_len * up:
                continue
            c = c[:, 0, :].astype(np.float32)
            # circular gaussian smoothing removes the pixel staircase before simplification
            sig = 3.0
            r = int(sig * 3)
            kern = np.exp(-0.5 * (np.arange(-r, r + 1) / sig) ** 2)
            kern /= kern.sum()
            cp = np.vstack([c[-r:], c, c[:r]])
            c = np.c_[np.convolve(cp[:, 0], kern, "valid"), np.convolve(cp[:, 1], kern, "valid")].astype(np.float32)
            c = cv2.approxPolyDP(c[:, None, :], 0.35 * up / res, True)[:, 0, :].astype(float)
            if len(c) < 3:
                continue
            pts = c / up * res + [ox, oy]
            out.append((li, pts))
    return out


def lin_grad(gid, x1, y1, x2, y2, stops):
    s = "".join(f'<stop offset="{o}" stop-color="{c}" stop-opacity="{a}"/>' for o, c, a in stops)
    return f'<linearGradient id="{gid}" gradientUnits="userSpaceOnUse" x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}">{s}</linearGradient>'


def rad_grad(gid, cx, cy, r, stops):
    s = "".join(f'<stop offset="{o}" stop-color="{c}" stop-opacity="{a}"/>' for o, c, a in stops)
    return f'<radialGradient id="{gid}" gradientUnits="userSpaceOnUse" cx="{cx}" cy="{cy}" r="{r}">{s}</radialGradient>'


def mix(c1, c2, t):
    a = np.array([int(c1[i:i + 2], 16) for i in (1, 3, 5)])
    b = np.array([int(c2[i:i + 2], 16) for i in (1, 3, 5)])
    c = np.clip(a + (b - a) * t, 0, 255).astype(int)
    return "#%02x%02x%02x" % tuple(c)


def is_sleeve(piece):
    return piece.startswith("sleeve")


# ================================================================ 01 ALPENGLOW
def alpenglow(piece, W, H, p, rng, uid):
    res = 3.0
    f = noise(W, H, res, [60, 25, 9], rng, [1.0, 0.45, 0.12])
    # tilt the terrain so lines rise toward the shoulders
    gy = np.linspace(0, 1, f.shape[0])[:, None]
    f = f * 0.75 + (1 - gy) * 0.35
    f = (f - f.min()) / np.ptp(f)
    levels = np.linspace(0.04, 0.98, 44)
    cs = contours(f, levels, res)
    g = f'<defs>{lin_grad("ag" + uid, 0, H + B, 0, -B, [(0, p["tone"], 1), (0.42, p["c"], 1), (0.7, p["a"], 1), (1, p["b"], 1)])}'
    g += rad_grad("ah" + uid, W * 0.5, H * 0.18, W * 0.75, [(0, p["a"], 0.35), (0.6, p["c"], 0.12), (1, p["base"], 0)]) + "</defs>"
    g += bg(W, H, p["base"]) + rect(-B, -B, W + 2 * B, H + 2 * B, f"url(#ah{uid})")
    thin, thick = [], []
    for li, pts in cs:
        (thick if li % 5 == 0 else thin).append(smooth_d(pts, True))
    g += f'<path d="{" ".join(thin)}" fill="none" stroke="url(#ag{uid})" stroke-width="0.9" stroke-opacity="0.75"/>'
    g += f'<path d="{" ".join(thick)}" fill="none" stroke="url(#ag{uid})" stroke-width="2.1"/>'
    # summit markers + elevation labels on the index contours
    peaks = []
    lab = ""
    for li, pts in cs[::7]:
        if li % 5 == 0 and len(pts) > 20:
            k = len(pts) // 3
            x, y = pts[k]
            if 0 < x < W and 0 < y < H:
                elev = 1800 + li * 45
                lab += typo.text("mono", f"{elev}", x, y - 2.2, 4.2, fill=p["light"], extra='fill-opacity="0.55"')
    g += lab
    if not is_sleeve(piece):
        # layered Alpine ridge band across the chest/waist
        yb = H * (0.47 if piece == "front" else 0.42)
        ridge_last = None
        for k, (col, amp, off, op) in enumerate([(p["c"], 46, -40, 0.6), (p["tone"], 60, 0, 0.85), (p["base"], 72, 46, 0.92)]):
            xs = np.linspace(-B, W + B, 40)
            ys = yb + off - amp * np.abs(np.sin(xs / (55 + 18 * k) + k * 1.7)) * (0.6 + 0.4 * rng.random(40))
            ys[::3] += rng.uniform(-14, 6, len(ys[::3]))
            pts = np.c_[xs, ys]
            d = pl(np.vstack([pts, [[W + B, H + B], [-B, H + B]]]), True)
            g += f'<path d="{d}" fill="{col}" fill-opacity="{op}"/>'
            ridge_last = d
            if k == 0:
                # snow caps along the farthest ridge
                for i in range(1, len(xs) - 1):
                    if ys[i] < ys[i - 1] and ys[i] < ys[i + 1]:
                        x, y = xs[i], ys[i]
                        g += f'<path d="M{x:.1f},{y:.1f} L{x + 9:.1f},{y + 9:.1f} L{x + 4:.1f},{y + 7:.1f} L{x:.1f},{y + 11:.1f} L{x - 4:.1f},{y + 7:.1f} L{x - 9:.1f},{y + 9:.1f} Z" fill="{p["light"]}" fill-opacity="0.85"/>'
        # terrain keeps going under the ridge: tonal contours clipped to the foreground range
        g += f'<defs><clipPath id="rc{uid}"><path d="{ridge_last}"/></clipPath>{lin_grad("rg" + uid, 0, yb, 0, H + B, [(0, p["c"], 0.85), (1, p["tone"], 1)])}</defs>'
        g += f'<g clip-path="url(#rc{uid})"><path d="{" ".join(thin)}" fill="none" stroke="url(#rg{uid})" stroke-width="0.9" stroke-opacity="0.7"/>'
        g += f'<path d="{" ".join(thick)}" fill="none" stroke="url(#rg{uid})" stroke-width="2"/></g>'
    return g


# ================================================================ 02 CHAIN REACTION
def chain_link(x, y, ang, L, face, col, hi):
    """One chain link centred at (x,y), long axis at angle ang (deg)."""
    if face:
        return (f'<ellipse cx="{x:.1f}" cy="{y:.1f}" rx="{L / 2:.2f}" ry="{L * 0.3:.2f}" transform="rotate({ang:.1f} {x:.1f} {y:.1f})" '
                f'fill="none" stroke="{col}" stroke-width="{L * 0.13:.2f}"/>'
                f'<ellipse cx="{x:.1f}" cy="{y:.1f}" rx="{L / 2:.2f}" ry="{L * 0.3:.2f}" transform="rotate({ang:.1f} {x:.1f} {y:.1f})" '
                f'fill="none" stroke="{hi}" stroke-width="{L * 0.035:.2f}" stroke-dasharray="{L * 0.5:.1f} {L * 1.2:.1f}"/>')
    return (f'<rect x="{x - L / 2:.1f}" y="{y - L * 0.075:.2f}" width="{L:.2f}" height="{L * 0.15:.2f}" rx="{L * 0.075:.2f}" '
            f'transform="rotate({ang:.1f} {x:.1f} {y:.1f})" fill="{col}"/>'
            f'<rect x="{x - L * 0.4:.1f}" y="{y - L * 0.02:.2f}" width="{L * 0.8:.2f}" height="{L * 0.04:.2f}" '
            f'transform="rotate({ang:.1f} {x:.1f} {y:.1f})" fill="{hi}"/>')


def chains(piece, W, H, p, rng, uid):
    g = f'<defs>{lin_grad("cf" + uid, 0, 0, 0, H, [(0, p["tone"], 1), (1, p["base"], 1)])}'
    g += lin_grad("gold" + uid, 0, 0, 0, 30, [(0, "#f3e2a6", 1), (0.35, p["a"], 1), (0.7, "#8a6a22", 1), (1, "#d9b85e", 1)])
    g += f'<pattern id="pin{uid}" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="0.5" height="7" fill="{p["b"]}" fill-opacity="0.18"/></pattern></defs>'
    g += bg(W, H, f"url(#cf{uid})")
    sleeve = is_sleeve(piece)
    band_y = -10 if sleeve else (250 if piece == "front" else 210)
    g += rect(-B, -B, W + 2 * B, band_y + B, f"url(#pin{uid})")
    # hanging chain curtains: catenaries from band to hem
    L = 12.0
    nchains = int((W + 2 * B) / 19)
    for i in range(nchains):
        x0 = -B + i * 19 + 9
        sway = rng.uniform(-18, 18)
        length = H - band_y + B
        n = int(length / (L * 0.78))
        col = mix(p["tone"], p["b"], 0.5 + 0.3 * rng.random())
        hi = mix(p["b"], p["light"], 0.75)
        for k in range(n):
            t = k / max(n - 1, 1)
            y = band_y + 18 + k * L * 0.78
            x = x0 + sway * math.sin(t * math.pi) + 6 * math.sin(t * 7 + i)
            fade = 1 - 0.55 * t
            g += f'<g opacity="{fade:.2f}">' + chain_link(x, y, 90 + sway * 0.4 * math.cos(t * math.pi), L, k % 2 == 0, col, hi) + "</g>"
    if not sleeve:
        # the brushed gold basket band
        g += f'<g transform="translate(0 {band_y})">'
        g += rect(-B, 0, W + 2 * B, 30, f"url(#gold{uid})")
        g += rect(-B, 3, W + 2 * B, 0.7, p["base"], 'fill-opacity="0.6"') + rect(-B, 26.3, W + 2 * B, 0.7, p["base"], 'fill-opacity="0.6"')
        for x in np.arange(-B + 12, W + B, 24):
            g += f'<circle cx="{x:.1f}" cy="15" r="2.4" fill="{p["base"]}" fill-opacity="0.55"/><circle cx="{x - 0.6:.1f}" cy="14.4" r="0.9" fill="#fff6d0" fill-opacity="0.8"/>'
        g += typo.text("condensed", "CHAINS DON'T LIE  ·  WAYAO DISC GOLF  ·  CHAINS DON'T LIE  ·  WAYAO DISC GOLF  ·  CHAINS DON'T LIE", W / 2, 19.4, 9, track=0.3, fill=p["base"], extra='fill-opacity="0.75"')
        g += "</g>"
    else:
        # sleeve: tonal chain-link micro lattice
        for y in np.arange(-B, H + B, 16):
            for x in np.arange(-B + (y % 32) / 2, W + B, 16):
                g += chain_link(x, y, 0, 8, True, p["tone"], p["b"])
    return g


# ================================================================ 03 FLIGHT PATH
def flight(piece, W, H, p, rng, uid):
    g = bg(W, H, p["base"])
    # flight-chart dotted grid
    dots = "".join(f"M{x:.0f},{y:.0f} h0.01 " for x in range(-B, int(W + B), 20) for y in range(-B, int(H + B), 20))
    g += f'<path d="{dots}" stroke="{p["tone"]}" stroke-width="1.6" stroke-linecap="round"/>'
    sleeve = is_sleeve(piece)
    paths_t, paths_hi = [], []
    ribbons = []
    for i in range(90 if not sleeve else 36):
        x0 = rng.uniform(-80, W + 80)
        turn = rng.uniform(-1, 1)
        fade = rng.uniform(-1, 1)
        y0, y1 = H + 40, rng.uniform(-60, H * 0.3)
        L = y0 - y1
        pts = []
        for t in np.linspace(0, 1, 30):
            # turn early-mid flight, fade at the end (classic S)
            dx = turn * 210 * math.sin(math.pi * t) * (1 - t) + fade * 240 * t ** 3
            pts.append((x0 + dx, y0 - L * t))
        d = smooth_d(pts)
        if i % 6 == 0:
            ribbons.append(d)
        (paths_hi if i % 8 == 0 else paths_t).append((d, pts))
    g += f'<path d="{" ".join(ribbons)}" fill="none" stroke="{p["tone"]}" stroke-width="16" stroke-linecap="round" stroke-opacity="0.7"/>'
    g += f'<path d="{" ".join(ribbons)}" fill="none" stroke="{p["base"]}" stroke-width="1.2"/>'
    g += f'<path d="{" ".join(d for d, _ in paths_t)}" fill="none" stroke="{mix(p["tone"], p["b"], 0.25)}" stroke-width="1.6"/>'
    g += f'<path d="{" ".join(d for d, _ in paths_t[::3])}" fill="none" stroke="{p["b"]}" stroke-opacity="0.35" stroke-width="0.8" stroke-dasharray="6 5"/>'
    for d, pts in paths_hi:
        g += f'<path d="{d}" fill="none" stroke="{p["a"]}" stroke-width="2" stroke-dasharray="16 4 2 4"/>'
        x, y = pts[-1]
        g += f'<ellipse cx="{x:.1f}" cy="{y:.1f}" rx="9" ry="3.2" fill="{p["a"]}"/><ellipse cx="{x:.1f}" cy="{y - 0.6:.1f}" rx="5" ry="1.4" fill="{p["base"]}" fill-opacity="0.35"/>'
        for t in (0.33, 0.66):
            x, y = pts[int(t * 29)]
            g += f'<circle cx="{x:.1f}" cy="{y:.1f}" r="2.6" fill="{p["base"]}" stroke="{p["a"]}" stroke-width="1.2"/>'
    # flight-number columns down both side seams
    nums = ["12 | 5 | -1 | 3", "9 | 5 | -2 | 2", "7 | 5 | -1 | 1", "5 | 5 | 0 | 1", "2 | 3 | 0 | 1", "4 | 4 | -3 | 1"]
    side = [8, W - 8] if not sleeve else [W * 0.2, W * 0.8]
    for k, x in enumerate(side):
        for j, y in enumerate(np.arange(30, H + 20, 26)):
            s = nums[(j + k) % len(nums)]
            col = p["a"] if j % 7 == 3 else p["tone"]
            g += f'<g transform="rotate(-90 {x} {y})">' + typo.text("mono", s, x, y + 2, 5.6, fill=col, extra='fill-opacity="0.95"') + "</g>"
    if piece == "back":
        # big tonal flight chart axes on the back
        g += f'<path d="M{W * 0.15},{H * 0.92} L{W * 0.15},{H * 0.18} M{W * 0.15},{H * 0.92} L{W * 0.85},{H * 0.92}" stroke="{p["tone"]}" stroke-width="2"/>'
        for k, lab in enumerate(["0 M", "30", "60", "90", "120 M"]):
            y = H * 0.92 - k * (H * 0.74 / 4)
            g += typo.text("mono", lab, W * 0.15 - 6, y + 2, 6, anchor="end", fill=p["tone"])
    return g


# ================================================================ 04 SECESSION
def spiral_d(cx, cy, r, turns=3.2, rot=0):
    pts = []
    for t in np.linspace(0, 1, int(60 * turns)):
        a = rot + t * turns * 2 * math.pi
        rr = r * t
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    return smooth_d(pts)


def secession(piece, W, H, p, rng, uid):
    g = f'<defs>{lin_grad("sg" + uid, 0, 0, W, H, [(0, "#f6e3a1", 1), (0.3, p["a"], 1), (0.55, p["b"], 1), (0.8, "#f1d27a", 1), (1, p["b"], 1)])}</defs>'
    G = f"url(#sg{uid})"
    g += bg(W, H, p["base"])
    # tonal mosaic of rectangles (Klimt background)
    mos = ""
    for _ in range(int(W * H / 150)):
        x, y = rng.uniform(-B, W + B), rng.uniform(-B, H + B)
        w, h = rng.uniform(3, 10), rng.uniform(3, 14)
        mos += f"M{x:.1f},{y:.1f} h{w:.1f} v{h:.1f} h{-w:.1f} Z "
    g += f'<path d="{mos}" fill="{p["tone"]}"/>'
    mos2 = ""
    for _ in range(int(W * H / 1400)):
        x, y = rng.uniform(-B, W + B), rng.uniform(-B, H + B)
        w, h = rng.uniform(2, 6), rng.uniform(2, 6)
        mos2 += f"M{x:.1f},{y:.1f} h{w:.1f} v{h:.1f} h{-w:.1f} Z "
    g += f'<path d="{mos2}" fill="{p["b"]}" fill-opacity="0.35"/>'
    sleeve = is_sleeve(piece)
    # Hoffmann checker bands at the side seams (or sleeve hem)
    sq = 7
    if not sleeve:
        for x0 in (0, W - 4 * sq):
            for i in range(4):
                for j in range(int((H + 2 * B) / sq)):
                    if (i + j) % 2 == 0:
                        g += rect(x0 + i * sq, -B + j * sq, sq, sq, p["c"])
            g += rect(x0 - 2.5, -B, 1.4, H + 2 * B, G) + rect(x0 + 4 * sq + 1.1, -B, 1.4, H + 2 * B, G)
    # tree-of-life spirals and disc clusters
    n = 15 if not sleeve else 6
    xs_lo, xs_hi = (40, W - 40) if not sleeve else (20, W - 20)
    for _ in range(n):
        cx, cy = rng.uniform(xs_lo, xs_hi), rng.uniform(40, H - 40)
        r = rng.uniform(26, 48)
        g += f'<path d="{spiral_d(cx, cy, r, rng.uniform(2.5, 3.6), rng.uniform(0, 6))}" fill="none" stroke="{G}" stroke-width="3.2" stroke-linecap="round"/>'
    for _ in range(int(n * 4.5)):
        cx, cy = rng.uniform(xs_lo, xs_hi), rng.uniform(20, H - 20)
        r = rng.uniform(5, 16)
        g += f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r:.1f}" fill="{G}"/>'
        g += f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r * 0.7:.1f}" fill="{p["base"]}"/>'
        g += f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r * 0.45:.1f}" fill="{p["c"]}"/>'
        g += f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r * 0.2:.1f}" fill="{G}"/>'
    # Klimt 'eyes' (almond shapes)
    for _ in range(n):
        cx, cy = rng.uniform(xs_lo, xs_hi), rng.uniform(30, H - 30)
        s = rng.uniform(8, 14)
        a = rng.uniform(-30, 30)
        g += (f'<g transform="rotate({a:.0f} {cx:.1f} {cy:.1f})"><path d="M{cx - s * 1.6:.1f},{cy:.1f} Q{cx:.1f},{cy - s:.1f} {cx + s * 1.6:.1f},{cy:.1f} '
              f'Q{cx:.1f},{cy + s:.1f} {cx - s * 1.6:.1f},{cy:.1f} Z" fill="{p["c"]}"/><circle cx="{cx:.1f}" cy="{cy:.1f}" r="{s * 0.42:.1f}" fill="{p["base"]}"/></g>')
    if piece == "front":
        # gold-leaf grid panel framing the upper chest
        for i in range(30):
            x = 60 + i * 14
            g += rect(x, 120, 1.2, 4, G)
        g += rect(40, 112, W - 80, 1.6, G) + rect(40, 128, W - 80, 1.6, G)
    return g


# ================================================================ 05 EDELWEISS
def edelweiss_flower(x, y, s, p, rot=0):
    out = f'<g transform="translate({x:.1f} {y:.1f}) rotate({rot:.0f}) scale({s / 10:.3f})">'
    for i in range(9):
        out += f'<path d="M0,0 C-2.8,-3 -2.6,-8 0,-10.5 C2.6,-8 2.8,-3 0,0 Z" transform="rotate({i * 40})" fill="{p["light"]}" stroke="{p["c"]}" stroke-width="0.45"/>'
        out += f'<path d="M0,-2 L0,-8.5" transform="rotate({i * 40})" stroke="{p["tone"]}" stroke-width="0.35"/>'
    for k in range(5):
        a = math.radians(k * 72)
        out += f'<circle cx="{2 * math.cos(a):.2f}" cy="{2 * math.sin(a):.2f}" r="1.25" fill="#e8c23a" stroke="{p["c"]}" stroke-width="0.25"/>'
    return out + "</g>"


def gentian(x, y, s, p, rot=0):
    return (f'<g transform="translate({x:.1f} {y:.1f}) rotate({rot:.0f}) scale({s / 10:.3f})">'
            f'<path d="M0,6 L0,14" stroke="{p["c"]}" stroke-width="1.2"/>'
            f'<path d="M-5,-8 L-3,-4 L0,-9 L3,-4 L5,-8 C6,0 3,6 0,6 C-3,6 -6,0 -5,-8 Z" fill="{p["b"]}"/>'
            f'<path d="M-1.5,-3 C-1,2 1,2 1.5,-3" fill="none" stroke="#9fc0ff" stroke-width="0.6"/>'
            f'<path d="M0,10 C-4,8 -7,10 -8,13 C-4,13 -2,12 0,10 Z M0,10 C4,8 7,10 8,13 C4,13 2,12 0,10 Z" fill="{p["c"]}"/></g>')


def alprose(x, y, s, p, rot=0):
    out = f'<g transform="translate({x:.1f} {y:.1f}) rotate({rot:.0f}) scale({s / 10:.3f})">'
    for i in range(5):
        out += f'<circle cx="0" cy="-3.6" r="3.2" transform="rotate({i * 72})" fill="{p["a"]}"/>'
    out += f'<circle r="1.8" fill="#f6d27a"/></g>'
    return out


def heart(x, y, s, col):
    return (f'<path transform="translate({x:.1f} {y:.1f}) scale({s / 10:.3f})" '
            f'd="M0,4 C-6,-1 -5,-6 -2.5,-6 C-1,-6 0,-5 0,-4 C0,-5 1,-6 2.5,-6 C5,-6 6,-1 0,4 Z" fill="{col}"/>')


def edelweiss(piece, W, H, p, rng, uid):
    g = bg(W, H, p["base"])
    # linen texture
    lin = "".join(f"M{-B},{y:.1f} H{W + B} " for y in np.arange(-B, H + B, 2.2))
    g += f'<path d="{lin}" stroke="{p["tone"]}" stroke-width="0.5"/>'
    s = 92  # diamond lattice cell
    lat = ""
    for k in range(-12, 20):
        x = k * s / 2
        lat += f"M{x - H:.1f},{-B - H:.1f} L{x + H * 2:.1f},{H * 2:.1f} M{x + H * 2:.1f},{-B - H * 2:.1f} L{x - H:.1f},{H * 2:.1f} "
    g += f'<path d="{lat}" stroke="{p["a"]}" stroke-width="1.6" fill="none"/>'
    g += f'<path d="{lat}" stroke="{p["a"]}" stroke-width="0.5" fill="none" transform="translate(4.5 0)"/>'
    # motifs in each diamond cell
    cells = []
    for i in range(-2, int(W / s * 2) + 3):
        for j in range(-2, int(H / s * 2) + 3):
            cx = i * s / 2
            cy = j * s / 2
            if (i + j) % 2:
                continue
            cells.append((cx, cy, i, j))
    for cx, cy, i, j in cells:
        cy2 = cy + s / 4 * 0  # cell centre
        kind = (i // 2 + j // 2) % 3
        if kind == 0:
            g += edelweiss_flower(cx + s / 4, cy + s / 4, 19, p, rng.uniform(0, 40))
            for a in range(4):
                ang = math.radians(a * 90 + 45)
                g += f'<circle cx="{cx + s / 4 + 22 * math.cos(ang):.1f}" cy="{cy + s / 4 + 22 * math.sin(ang):.1f}" r="1.6" fill="{p["b"]}"/>'
        elif kind == 1:
            g += gentian(cx + s / 4 - 10, cy + s / 4 - 2, 13, p, -18) + gentian(cx + s / 4 + 10, cy + s / 4 - 2, 13, p, 18)
        else:
            g += alprose(cx + s / 4, cy + s / 4 - 7, 12, p) + alprose(cx + s / 4 - 13, cy + s / 4 + 8, 9, p) + alprose(cx + s / 4 + 13, cy + s / 4 + 8, 9, p)
            g += f'<path d="M{cx + s / 4 - 18:.1f},{cy + s / 4 + 14:.1f} Q{cx + s / 4:.1f},{cy + s / 4 + 2:.1f} {cx + s / 4 + 18:.1f},{cy + s / 4 + 14:.1f}" fill="none" stroke="{p["c"]}" stroke-width="1.4"/>'
        # heart at lattice node
        g += heart(cx + s / 4, cy - s / 4 + s / 2 - s / 2, 7, p["a"])
    if not is_sleeve(piece):
        # folk border at the hem: zigzag + scallops (red-white-red)
        y0 = H - 70
        g += rect(-B, y0, W + 2 * B, 70 + B, p["a"])
        g += rect(-B, y0 + 8, W + 2 * B, 10, p["light"])
        zz = "M-20," + f"{y0 + 30}" + "".join(f" L{x + 7},{y0 + 22 if (x // 7) % 2 == 0 else y0 + 38}" for x in range(-20, int(W + 30), 7))
        g += f'<path d="{zz}" fill="none" stroke="{p["light"]}" stroke-width="2"/>'
        for x in np.arange(-B, W + B, 28):
            g += edelweiss_flower(x + 14, y0 + 52, 9, p)
    return g


# ================================================================ 06 TARTAN
def tartan(piece, W, H, p, rng, uid):
    # sett (thread count in mm): green, navy, red, gold overcheck
    sett = [(p["base"], 30), (p["c"], 4), (p["base"], 5), (p["c"], 4), (p["base"], 5), (p["tone"], 22),
            (p["a"], 12), (p["tone"], 22), (p["c"], 3), (p["base"], 30), (p["b"], 2.6)]
    unit = sum(w for _, w in sett)
    pid = "tw" + uid
    g = (f'<defs><pattern id="{pid}" width="1.6" height="1.6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">'
         f'<rect width="0.8" height="1.6" fill="#000" fill-opacity="0.22"/></pattern>'
         f'<pattern id="{pid}b" width="2.4" height="2.4" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">'
         f'<rect width="0.35" height="2.4" fill="#fff" fill-opacity="0.07"/></pattern></defs>')
    g += bg(W, H, p["base"])
    angle = 0 if not is_sleeve(piece) else 0
    x = -B - rng.uniform(0, unit)
    vert, hor = "", ""
    # horizontal (weft) bands
    y = -B - 30
    while y < H + B:
        for col, w in sett + sett[::-1][1:-1]:
            hor += rect(-B, y, W + 2 * B, w, col, 'fill-opacity="0.92"')
            y += w
    while x < W + B:
        for col, w in sett + sett[::-1][1:-1]:
            vert += rect(x, -B, w, H + 2 * B, col, 'fill-opacity="0.55"')
            x += w
    g += hor + vert
    g += rect(-B, -B, W + 2 * B, H + 2 * B, f"url(#{pid})") + rect(-B, -B, W + 2 * B, H + 2 * B, f"url(#{pid}b)")
    return g


# ================================================================ 07 ACE RUN '96
def retro(piece, W, H, p, rng, uid):
    g = bg(W, H, p["base"])
    # tonal memphis squiggles
    sq = ""
    for _ in range(int(W * H / 2200)):
        x, y = rng.uniform(-B, W + B), rng.uniform(-B, H + B)
        a = rng.uniform(0, 360)
        sq += f'<path d="M0,0 q4,-6 8,0 t8,0 t8,0" transform="translate({x:.0f} {y:.0f}) rotate({a:.0f})" fill="none" stroke="{p["tone"]}" stroke-width="1.6"/>'
    g += sq
    sleeve = is_sleeve(piece)
    # shattered shards sweeping diagonally
    cols = [p["a"], p["b"], p["a"], p["dark"], p["c"], p["b"]]
    nshard = 110 if not sleeve else 40
    for i in range(nshard):
        t = rng.random()
        cx = -60 + t * (W + 120) + rng.normal(0, 30)
        cy = (H * 0.15 + t * H * 0.75) + rng.normal(0, 85) if not sleeve else rng.uniform(0, H)
        r = rng.uniform(16, 62) * (1.25 - 0.6 * abs(t - 0.5))
        k = rng.integers(3, 5)
        base_a = rng.uniform(0, 2 * math.pi)
        pts = [(cx + r * rng.uniform(0.4, 1) * math.cos(base_a + j * 2 * math.pi / k + rng.uniform(-0.4, 0.4)),
                cy + r * rng.uniform(0.4, 1) * math.sin(base_a + j * 2 * math.pi / k + rng.uniform(-0.4, 0.4))) for j in range(k)]
        col = cols[i % len(cols)]
        # drop shadow offset (classic 90s)
        g += f'<path d="{pl(np.array(pts) + [5, 5], True)}" fill="{p["dark"]}" fill-opacity="0.85"/>'
        g += f'<path d="{pl(pts, True)}" fill="{col}"/>'
        if i % 4 == 0:
            # hatch inside shard
            g += f'<path d="{pl(pts, True)}" fill="none" stroke="{p["light"]}" stroke-width="0.8" stroke-dasharray="2 3"/>'
    # zigzag bolts
    for i in range(5 if not sleeve else 2):
        x0 = rng.uniform(0, W)
        y0 = rng.uniform(0, H)
        d = f"M{x0:.0f},{y0:.0f}" + "".join(f" l{14 * (1 if j % 2 == 0 else -1)},{10}" for j in range(12))
        g += f'<path d="{d}" fill="none" stroke="{p["c"]}" stroke-width="5" stroke-linejoin="miter" transform="rotate({rng.uniform(-60, 60):.0f} {x0:.0f} {y0:.0f})"/>'
    # brush confetti
    for _ in range(int(W * H / 1400)):
        x, y = rng.uniform(-B, W + B), rng.uniform(-B, H + B)
        L = rng.uniform(4, 12)
        a = rng.uniform(0, 180)
        g += f'<path d="M{x:.0f},{y:.0f} l{L * math.cos(math.radians(a)):.1f},{L * math.sin(math.radians(a)):.1f}" stroke="{p["dark"]}" stroke-width="{rng.uniform(1.2, 3):.1f}" stroke-linecap="round"/>'
    return g


# ================================================================ 08 ICE BOWL
def dendrite(x, y, r, rot, rng, depth=3):
    """Six-fold snow crystal as a path (stroked)."""
    d = ""
    for k in range(6):
        a = math.radians(rot + k * 60)
        ex, ey = x + r * math.cos(a), y + r * math.sin(a)
        d += f"M{x:.1f},{y:.1f} L{ex:.1f},{ey:.1f} "
        for j in range(1, depth + 1):
            t = j / (depth + 1)
            bx, by = x + r * t * math.cos(a), y + r * t * math.sin(a)
            bl = r * (0.42 - 0.08 * j)
            for s in (-1, 1):
                b = a + s * math.radians(60)
                d += f"M{bx:.1f},{by:.1f} l{bl * math.cos(b):.1f},{bl * math.sin(b):.1f} "
    return d


def ice(piece, W, H, p, rng, uid):
    g = f'<defs>{lin_grad("ig" + uid, 0, -B, 0, H + B, [(0, p["base"], 1), (0.3, p["tone"], 1), (0.72, p["b"], 1), (1, p["a"], 1)])}</defs>'
    g += bg(W, H, f"url(#ig{uid})")
    # hexagonal ice lattice
    r = 22
    hx = ""
    for j in range(-2, int(H / (r * 1.5)) + 3):
        for i in range(-2, int(W / (r * math.sqrt(3))) + 3):
            cx = i * r * math.sqrt(3) + (j % 2) * r * math.sqrt(3) / 2
            cy = j * r * 1.5
            pts = [(cx + r * math.cos(math.radians(30 + 60 * k)), cy + r * math.sin(math.radians(30 + 60 * k))) for k in range(6)]
            hx += pl(pts, True) + " "
    g += f'<path d="{hx}" fill="none" stroke="{p["light"]}" stroke-opacity="0.45" stroke-width="0.9"/>'
    g += f'<path d="{hx}" fill="none" stroke="{p["a"]}" stroke-opacity="0.12" stroke-width="0.6" transform="translate(1.4 1.4)"/>'
    # frost crystals, denser toward hem
    big, small = "", ""
    for _ in range(190 if not is_sleeve(piece) else 70):
        x = rng.uniform(-B, W + B)
        y = H * (1 - rng.random() ** 1.3)
        rr = rng.uniform(5, 30)
        d = dendrite(x, y, rr, rng.uniform(0, 60), rng, 3 if rr > 14 else 2)
        if rr > 16:
            big += d
        else:
            small += d
    g += f'<path d="{big}" fill="none" stroke="{p["light"]}" stroke-width="1.8" stroke-linecap="round"/>'
    g += f'<path d="{big}" fill="none" stroke="{p["dark"]}" stroke-opacity="0.25" stroke-width="0.6" stroke-linecap="round" transform="translate(0.8 0.8)"/>'
    g += f'<path d="{small}" fill="none" stroke="{p["light"]}" stroke-opacity="0.9" stroke-width="1.0" stroke-linecap="round"/>'
    # ice cracks
    cr = ""
    for _ in range(14):
        x, y = rng.uniform(0, W), rng.uniform(H * 0.4, H + 10)
        a = rng.uniform(0, 2 * math.pi)
        for _k in range(rng.integers(5, 12)):
            L = rng.uniform(8, 26)
            a += rng.normal(0, 0.6)
            nx, ny = x + L * math.cos(a), y + L * math.sin(a)
            cr += f"M{x:.1f},{y:.1f} L{nx:.1f},{ny:.1f} "
            x, y = nx, ny
    g += f'<path d="{cr}" fill="none" stroke="{p["light"]}" stroke-width="0.7" stroke-opacity="0.8"/>'
    return g


# ================================================================ 09 MANDO
def mando(piece, W, H, p, rng, uid):
    g = bg(W, H, p["base"])
    res = 3.0
    f = noise(W, H, res, [70, 30], rng, [1, 0.4])
    for li, pts in contours(f, np.linspace(0.05, 0.95, 26), res):
        g += f'<path d="{smooth_d(pts, True)}" fill="none" stroke="{p["tone"]}" stroke-width="{1.6 if li % 4 == 0 else 0.8}"/>'
    # tree clusters
    tr = ""
    for _ in range(int(W * H / 900)):
        x, y = rng.uniform(-B, W + B), rng.uniform(-B, H + B)
        rr = rng.uniform(2.5, 6)
        tr += f'M{x - rr:.1f},{y:.1f} a{rr:.1f},{rr:.1f} 0 1,0 {2 * rr:.1f},0 a{rr:.1f},{rr:.1f} 0 1,0 {-2 * rr:.1f},0 Z '
    g += f'<path d="{tr}" fill="none" stroke="{p["b"]}" stroke-opacity="0.35" stroke-width="0.7"/>'
    # fairways: tee -> basket corridors
    holes = 4 if not is_sleeve(piece) else 2
    start = {"front": 1, "back": 5, "sleeve_l": 9, "sleeve_r": 11}[piece]
    for h in range(holes):
        x0, y0 = rng.uniform(60, W - 60), rng.uniform(H * 0.55, H - 40)
        x1, y1 = rng.uniform(60, W - 60), rng.uniform(40, H * 0.45)
        mx, my = (x0 + x1) / 2 + rng.uniform(-120, 120), (y0 + y1) / 2
        pts = [(x0, y0), (mx, my), (x1, y1)]
        center = smooth_d(pts)
        g += f'<path d="{center}" fill="none" stroke="{p["tone"]}" stroke-width="46" stroke-linecap="round"/>'
        g += f'<path d="{center}" fill="none" stroke="{mix(p["tone"], p["b"], 0.25)}" stroke-width="44" stroke-linecap="round" stroke-opacity="0.5"/>'
        g += f'<path d="{center}" fill="none" stroke="{p["c"]}" stroke-width="0.8" stroke-dasharray="3 4"/>'
        # OB lines along one edge
        ob_off = rng.choice([-1, 1]) * 30
        g += f'<path d="{center}" transform="translate({ob_off} 0)" fill="none" stroke="{p["a"]}" stroke-width="2" stroke-dasharray="10 6"/>'
        # tee pad
        ang = math.degrees(math.atan2(my - y0, mx - x0))
        g += f'<rect x="{x0 - 5:.1f}" y="{y0 - 10:.1f}" width="10" height="20" fill="{p["c"]}" transform="rotate({ang + 90:.0f} {x0:.1f} {y0:.1f})"/>'
        # basket target
        g += f'<circle cx="{x1:.1f}" cy="{y1:.1f}" r="10" fill="none" stroke="{p["c"]}" stroke-width="1.2"/><circle cx="{x1:.1f}" cy="{y1:.1f}" r="5" fill="{p["c"]}"/><circle cx="{x1:.1f}" cy="{y1:.1f}" r="2" fill="{p["a"]}"/>'
        # mando arrow near midpoint
        ax, ay = mx + rng.choice([-1, 1]) * 20, my
        g += f'<path d="M{ax - 7:.1f},{ay - 7:.1f} L{ax + 5:.1f},{ay:.1f} L{ax - 7:.1f},{ay + 7:.1f} L{ax - 3:.1f},{ay:.1f} Z" fill="{p["a"]}" transform="rotate({rng.choice([0, 180])} {ax:.1f} {ay:.1f})"/>'
        # hole number roundel
        n = start + h
        g += f'<circle cx="{x0 + 18:.1f}" cy="{y0 + 14:.1f}" r="8" fill="{p["a"]}"/>' + typo.text("black", str(n), x0 + 18, y0 + 17.2, 9, fill=p["base"])
        dist = int(math.hypot(x1 - x0, y1 - y0) / 4)
        g += typo.text("mono", f"{dist} M · PAR 3", x0 + 30, y0 + 16, 5.4, anchor="start", fill=p["c"], extra='fill-opacity="0.8"')
    if piece == "front":
        # map legend near the hem (small detail)
        lx, ly = W - 175, H - 72
        g += rect(lx, ly, 150, 50, p["dark"], f'stroke="{p["b"]}" stroke-width="0.6"')
        g += typo.text("mono", "LEGEND", lx + 8, ly + 10, 5.5, anchor="start", fill=p["c"])
        g += f'<rect x="{lx + 8}" y="{ly + 16}" width="10" height="5" fill="{p["c"]}"/>' + typo.text("mono", "TEE PAD", lx + 22, ly + 21, 4.6, anchor="start", fill=p["b"])
        g += f'<circle cx="{lx + 13}" cy="{ly + 31}" r="3" fill="{p["c"]}"/>' + typo.text("mono", "BASKET", lx + 22, ly + 33, 4.6, anchor="start", fill=p["b"])
        g += f'<path d="M{lx + 8},{ly + 42} h12" stroke="{p["a"]}" stroke-width="1.6" stroke-dasharray="3 2"/>' + typo.text("mono", "OB LINE", lx + 22, ly + 44, 4.6, anchor="start", fill=p["b"])
        g += f'<path d="M{lx + 82},{ly + 14} l9,4.5 l-9,4.5 l2.5,-4.5 Z" fill="{p["a"]}"/>' + typo.text("mono", "MANDO", lx + 96, ly + 21, 4.6, anchor="start", fill=p["b"])
        g += f'<path d="M{lx + 82},{ly + 33} h40" stroke="{p["c"]}" stroke-width="1.2"/>' + "".join(f'<path d="M{lx + 82 + k * 10},{ly + 30} v6" stroke="{p["c"]}" stroke-width="0.8"/>' for k in range(5)) + typo.text("mono", "0   50 M", lx + 82, ly + 44, 4.2, anchor="start", fill=p["b"])
    return g


# ================================================================ 10 HYZER WAVE
def wave(piece, W, H, p, rng, uid):
    g = bg(W, H, p["base"])
    R = 26
    sg = ""
    for j in range(-2, int(H / (R / 2)) + 4):
        for i in range(-2, int(W / R) + 3):
            cx = i * R * 1.0 + (j % 2) * R / 2
            cy = j * R / 2
            for k in range(4):
                rr = R * 0.5 * (1 - k * 0.22)
                sg += f"M{cx - rr:.1f},{cy:.1f} A{rr:.1f},{rr:.1f} 0 0,1 {cx + rr:.1f},{cy:.1f} "
    # draw seigaiha as filled stacked scales: base fill then arcs
    g += f'<path d="{sg}" fill="none" stroke="{p["dark"]}" stroke-width="3.2"/>'
    g += f'<path d="{sg}" fill="none" stroke="{p["c"]}" stroke-opacity="0.45" stroke-width="1.2"/>'
    if piece == "back":
        g += f'<circle cx="{W * 0.62:.0f}" cy="{H * 0.36:.0f}" r="118" fill="{p["a"]}"/>'
    if piece == "front":
        g += f'<circle cx="{W * 0.24:.0f}" cy="{H * 0.78:.0f}" r="56" fill="{p["a"]}"/>'
    # sweeping hyzer arcs (surf), each a thick band with comb-line foam
    for k in range(6 if not is_sleeve(piece) else 3):
        y0 = rng.uniform(H * 0.25, H * 1.05)
        amp = rng.uniform(60, 150)
        pts = [(x, y0 - amp * math.sin(math.pi * (x + B) / (W + 2 * B)) + 18 * math.sin(x / 40 + k)) for x in np.linspace(-B - 20, W + B + 20, 50)]
        d = smooth_d(pts)
        g += f'<path d="{d}" fill="none" stroke="{p["base"]}" stroke-width="30"/>'
        g += f'<path d="{d}" fill="none" stroke="{p["b"]}" stroke-width="14"/>'
        for off in (-12, 12, -18, 18):
            g += f'<path d="{d}" transform="translate(0 {off})" fill="none" stroke="{p["b"]}" stroke-width="1.6" stroke-opacity="{0.9 if abs(off) < 15 else 0.5}"/>'
        # foam claws curling off the crest
        for t in np.linspace(0.1, 0.9, 7):
            x, y = pts[int(t * (len(pts) - 1))]
            sc = rng.uniform(0.9, 1.4)
            g += (f'<g transform="translate({x:.1f} {y - 6:.1f}) scale({sc:.2f})"><path d="M0,0 C-4,-10 2,-22 14,-22 C22,-22 26,-16 24,-11 '
                  f'C22,-15 16,-16 13,-12 C17,-12 19,-9 18,-6 C15,-9 10,-9 8,-5 C11,-5 12,-2 11,0 Z" fill="{p["b"]}"/>'
                  f'<path d="M4,-4 C3,-12 8,-18 15,-19" fill="none" stroke="{p["c"]}" stroke-width="1"/></g>')
    # scattered vermilion discs (spray)
    for _ in range(18 if not is_sleeve(piece) else 6):
        x, y = rng.uniform(0, W), rng.uniform(0, H)
        rr = rng.uniform(2, 6)
        g += f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{rr:.1f}" fill="{p["b"]}" fill-opacity="0.85"/>'
    return g


# ================================================================ 11 WOODED
def wooded(piece, W, H, p, rng, uid):
    g = bg(W, H, p["base"])
    # bark grain (vertical wavy lines)
    bark = ""
    for x in np.arange(-B, W + B, 6):
        pts = [(x + 3 * math.sin(y / 30 + x * 0.1) + rng.normal(0, 0.4), y) for y in np.arange(-B, H + B + 10, 12)]
        bark += smooth_d(pts) + " "
    g += f'<path d="{bark}" fill="none" stroke="{p["tone"]}" stroke-width="2.2"/>'
    # tree-ring cross sections
    for _ in range(3 if not is_sleeve(piece) else 1):
        cx, cy = rng.uniform(40, W - 40), rng.uniform(60, H - 60)
        R = rng.uniform(110, 190)
        nring = int(R / 6.5)
        rings = ""
        phase = rng.uniform(0, 6, 4)
        for k in range(1, nring):
            r = R * k / nring
            pts = []
            for a in np.linspace(0, 2 * math.pi, 90, endpoint=False):
                wob = 1 + 0.05 * math.sin(3 * a + phase[0]) + 0.03 * math.sin(5 * a + phase[1]) + 0.015 * math.sin(11 * a + k)
                pts.append((cx + r * wob * math.cos(a), cy + r * wob * 0.92 * math.sin(a)))
            rings += smooth_d(pts, True) + " "
        g += f'<path d="{rings}" fill="none" stroke="{p["a"]}" stroke-opacity="0.75" stroke-width="1.4"/>'
        # radial cracks
        for _k in range(5):
            a = rng.uniform(0, 2 * math.pi)
            r0, r1 = R * rng.uniform(0.3, 0.6), R
            g += f'<path d="M{cx + r0 * math.cos(a):.1f},{cy + r0 * math.sin(a):.1f} L{cx + r1 * math.cos(a + 0.02):.1f},{cy + r1 * math.sin(a + 0.02) * 0.92:.1f}" stroke="{p["dark"]}" stroke-width="1.6"/>'
    # fern fronds
    for _ in range(9 if not is_sleeve(piece) else 4):
        x0, y0 = rng.uniform(-20, W + 20), rng.uniform(H * 0.3, H + 30)
        L = rng.uniform(140, 260)
        ang = math.radians(rng.uniform(-120, -60))
        bend = rng.uniform(-0.6, 0.6)
        stem = []
        leaves = ""
        for t in np.linspace(0, 1, 26):
            a = ang + bend * t
            x = x0 + L * t * math.cos(ang + bend * t * 0.5)
            y = y0 + L * t * math.sin(ang + bend * t * 0.5)
            stem.append((x, y))
            ll = 34 * (1 - t) ** 0.8 * (0.4 + t * 1.2 if t < 0.3 else 1)
            for s in (-1, 1):
                b = a + s * math.radians(62)
                ex, ey = x + ll * math.cos(b), y + ll * math.sin(b)
                mx, my = x + ll * 0.5 * math.cos(b) + s * 3 * math.cos(a), y + ll * 0.5 * math.sin(b) + s * 3 * math.sin(a)
                leaves += f'M{x:.1f},{y:.1f} Q{mx + 4 * math.cos(a):.1f},{my + 4 * math.sin(a):.1f} {ex:.1f},{ey:.1f} Q{mx - 2 * math.cos(a):.1f},{my - 2 * math.sin(a):.1f} {x:.1f},{y:.1f} Z '
        g += f'<path d="{leaves}" fill="{p["b"]}"/>'
        g += f'<path d="{leaves}" fill="none" stroke="{p["dark"]}" stroke-opacity="0.5" stroke-width="0.5"/>'
        g += f'<path d="{smooth_d(stem)}" fill="none" stroke="{p["c"]}" stroke-opacity="0.6" stroke-width="1.4"/>'
    # needle confetti
    nd = ""
    for _ in range(int(W * H / 700)):
        x, y = rng.uniform(-B, W + B), rng.uniform(-B, H + B)
        a = rng.uniform(0, math.pi)
        nd += f"M{x:.1f},{y:.1f} l{7 * math.cos(a):.1f},{7 * math.sin(a):.1f} "
    g += f'<path d="{nd}" stroke="{p["a"]}" stroke-opacity="0.45" stroke-width="0.9" stroke-linecap="round"/>'
    return g


# ================================================================ 12 GLOW ROUND
def glow_stroke(d, col, width, core="#ffffff"):
    out = ""
    for w, a in [(width * 9, 0.05), (width * 6, 0.08), (width * 3.6, 0.14), (width * 2.2, 0.28), (width * 1.3, 0.6)]:
        out += f'<path d="{d}" fill="none" stroke="{col}" stroke-width="{w:.1f}" stroke-opacity="{a}" stroke-linecap="round"/>'
    out += f'<path d="{d}" fill="none" stroke="{core}" stroke-width="{width * 0.45:.2f}" stroke-opacity="0.9" stroke-linecap="round"/>'
    return out


def glow(piece, W, H, p, rng, uid):
    g = f'<defs>{lin_grad("gg" + uid, 0, -B, 0, H + B, [(0, p["tone"], 1), (0.6, p["base"], 1), (1, p["dark"], 1)])}</defs>'
    g += bg(W, H, f"url(#gg{uid})")
    # star field
    st = ""
    for _ in range(int(W * H / 500)):
        x, y = rng.uniform(-B, W + B), H * rng.random() ** 1.6
        st += f"M{x:.1f},{y:.1f} h0.01 "
    g += f'<path d="{st}" stroke="{p["light"]}" stroke-opacity="0.55" stroke-width="1.1" stroke-linecap="round"/>'
    cols = [p["a"], p["b"], p["c"]]
    for i in range(11 if not is_sleeve(piece) else 4):
        x0 = rng.uniform(-40, W * 0.4)
        y0 = rng.uniform(H * 0.5, H)
        x1 = rng.uniform(W * 0.6, W + 40)
        y1 = rng.uniform(0, H * 0.6)
        turn = rng.uniform(-1, 1) * 140
        pts = [(x0 + (x1 - x0) * t + turn * math.sin(math.pi * t) * 0.5, y0 + (y1 - y0) * t - abs(turn) * math.sin(math.pi * t) * 0.6) for t in np.linspace(0, 1, 30)]
        g += glow_stroke(smooth_d(pts), cols[i % 3], rng.uniform(2.2, 4.2))
    # glowing disc rings at rest
    for i in range(4 if not is_sleeve(piece) else 1):
        x, y = rng.uniform(40, W - 40), rng.uniform(H * 0.6, H - 30)
        d = f"M{x - 22},{y} a22,8 0 1,0 44,0 a22,8 0 1,0 -44,0 Z"
        g += glow_stroke(d, cols[(i + 1) % 3], 2.2)
    if not is_sleeve(piece):
        # tree-line silhouette at the hem with a glowing basket
        xs = np.linspace(-B, W + B, 70)
        ys = H - 40 - np.abs(rng.normal(0, 1, 70)) * 26 - 30 * (np.arange(70) % 3 == 0)
        d = pl(np.vstack([np.c_[xs, ys], [[W + B, H + B], [-B, H + B]]]), True)
        g += f'<path d="{d}" fill="{p["dark"]}"/>'
        bx, by = W * 0.72 if piece == "front" else W * 0.3, H - 70
        bk = (f"M{bx - 16},{by - 40} h32 M{bx},{by - 40} v62 M{bx - 12},{by + 4} h24 l-4,10 h-16 Z "
              + "".join(f"M{bx - 15 + k * 5},{by - 39} Q{bx - 6 + k * 2},{by - 18} {bx - 6 + k * 2.2},{by - 4} " for k in range(7)))
        g += glow_stroke(bk, p["a"], 1.4)
    return g


PATTERNS = dict(alpenglow=alpenglow, chains=chains, flight=flight, secession=secession, edelweiss=edelweiss,
                tartan=tartan, retro=retro, ice=ice, mando=mando, wave=wave, wooded=wooded, glow=glow)
