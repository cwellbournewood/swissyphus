"""Photoreal ghost-mannequin mockups rendered from the production print files.

Pipeline: vector panels (exact print art) -> raster at k px/mm -> sleeves perspective-mapped ->
fold height-field displacement + lighting -> knit texture -> stitched embroidery shader ->
woven tag -> studio background. All geometry lives in front-panel millimetres."""
import io
import math

import cairosvg
import cv2
import numpy as np
from PIL import Image

import brand
import garment as G
import printfile as PF
import typo

CX = G.BODY_W / 2


# ------------------------------------------------------------------ raster helpers
def svg_rgba(inner, win, k, defs=""):
    x0, y0, x1, y1 = win
    w, h = int(round((x1 - x0) * k)), int(round((y1 - y0) * k))
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="{x0} {y0} {x1 - x0} {y1 - y0}">'
           f'<defs>{defs}</defs>{inner}</svg>')
    png = cairosvg.svg2png(bytestring=svg.encode(), output_width=w, output_height=h)
    a = np.asarray(Image.open(io.BytesIO(png)).convert("RGBA"), dtype=np.float32) / 255.0
    return a


def over(dst, src):
    a = src[..., 3:4]
    out = dst.copy()
    out[..., :3] = src[..., :3] * a + dst[..., :3] * (1 - a)
    out[..., 3:4] = a + dst[..., 3:4] * (1 - a)
    return out


def hexrgb(h):
    return np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)], np.float32) / 255


def mm_grid(win, k, shape):
    h, w = shape[:2]
    xs = win[0] + (np.arange(w) + 0.5) / k
    ys = win[1] + (np.arange(h) + 0.5) / k
    return np.meshgrid(xs, ys)


# ------------------------------------------------------------------ silhouette geometry
SLEEVE_ANGLE = 40.0


def sleeve_quad(side):
    """Mannequin positions (front-panel mm) of sleeve apex S, underarm U, cuff top T, cuff bottom Bc."""
    s = 1 if side == "R" else -1
    S = np.array([CX + s * G.SHOULDER_HW, G.SHOULDER_DROP])
    U = np.array([CX + s * G.BODY_W / 2, G.UNDERARM_Y])
    th = math.radians(SLEEVE_ANGLE)
    d = np.array([s * math.cos(th), math.sin(th)])
    T = S + d * (G.SLEEVE_L + 8)
    Bc = T + np.array([-s * math.sin(th), math.cos(th)]) * (G.SLEEVE_HEM_HW * 0.98)
    return S, U, T, Bc


def arc_pts(cx, cy, r, a0, a1, n=60):
    t = np.radians(np.linspace(a0, a1, n))
    return np.c_[cx + r * np.cos(t), cy + r * np.sin(t)]


def circle_through(p0, pm):
    """Circle through symmetric endpoints p0/(mirror) and apex pm (pm above/below chord)."""
    half = CX - p0[0]
    sag = p0[1] - pm[1]
    R = (half ** 2 + sag ** 2) / (2 * sag)
    return CX, pm[1] + R, R


def neck_ring(view):
    """Visible collar construction in the mannequin view (front-panel mm).
    Returns dict of polylines: outer (seam on body), free (rib free edge), top_outer, top_inner."""
    out = {}
    hl, hr = (CX - G.NECK_HW, 0.0), (CX + G.NECK_HW, 0.0)
    if view == "front":
        seam = G.neckline(False, 40)
        C = np.array([CX, 22.0])
    else:
        seam = G.neckline(True, 40)
        C = np.array([CX, -14.0])
    if view == "front":
        v = seam - C
        r = np.linalg.norm(v, axis=1, keepdims=True)
        free = C + v * (1 - G.RIB_H / r)
    else:
        t = np.gradient(seam, axis=0)
        t /= np.linalg.norm(t, axis=1, keepdims=True) + 1e-9
        nrm = np.c_[t[:, 1], -t[:, 0]]
        if nrm[len(nrm) // 2, 1] > 0:
            nrm = -nrm
        free = seam + nrm * G.RIB_H
    out["seam"], out["free"] = seam, free
    # far side of the collar seen through the opening (circle arcs)
    p_end = free[0]
    if view == "front":
        cx, cy, R = circle_through(hl, (CX, -24.0))
        a0 = math.degrees(math.atan2(hl[1] - cy, hl[0] - cx))
        out["top_outer"] = arc_pts(cx, cy, R, a0, -180 - a0)
        cx2, cy2, R2 = circle_through(tuple(p_end), (CX, -2.0))
        a2 = math.degrees(math.atan2(p_end[1] - cy2, p_end[0] - cx2))
        out["top_inner"] = arc_pts(cx2, cy2, R2, a2, -180 - a2)
        out["inner_circle"] = (cx2, cy2, R2)
    else:
        tt = np.linspace(0, 1, len(free))
        top = free.copy()
        top[:, 1] -= 7 * np.sin(np.pi * tt)
        out["top_outer"] = top[::-1].copy()
    return out


# ------------------------------------------------------------------ fabric fields
class Folds:
    """Analytic height field (mm) of drape folds, shared across scales."""

    def __init__(self, view, rng):
        self.ridges = []
        s = 1
        for s in (1, -1):
            ux = CX + s * (G.BODY_W / 2 - 14)
            # drape from the armpit toward the sternum/waist
            for k in range(3):
                a = rng.uniform(-14, 14)
                self.ridges.append(((ux, G.UNDERARM_Y + 12 + k * 22), (CX + s * rng.uniform(40, 130), G.UNDERARM_Y + 150 + k * 60 + a), rng.uniform(9, 15), rng.uniform(3.4, 5.2)))
            # side drop folds
            for k in range(2):
                x0 = CX + s * rng.uniform(190, 245)
                self.ridges.append(((x0, rng.uniform(380, 460)), (x0 + s * rng.uniform(-10, 10), G.FRONT_L - 10), rng.uniform(12, 20), rng.uniform(1.5, 2.6)))
            # sleeve folds
            S, U, T, Bc = sleeve_quad("R" if s == 1 else "L")
            for k in range(3):
                f0 = U + (S - U) * rng.uniform(0.05, 0.35)
                f1 = T + (Bc - T) * rng.uniform(0.3, 0.8)
                self.ridges.append((tuple(f0), tuple(f1), rng.uniform(7, 12), rng.uniform(2, 3.2)))
        # hem ripples
        for k in range(5):
            x0 = rng.uniform(40, G.BODY_W - 40)
            self.ridges.append(((x0, G.FRONT_L - 90), (x0 + rng.uniform(-15, 15), G.FRONT_L + 5), rng.uniform(8, 14), rng.uniform(1.2, 2.2)))
        self.ph = rng.uniform(0, 6.28, 8)

    def height(self, X, Y):
        h = np.zeros_like(X)
        # mannequin volume: chest dome + barrel torso
        h += 22 * np.exp(-(((X - CX) / 190) ** 2 + ((Y - 250) / 260) ** 2))
        for (x0, y0), (x1, y1), w, a in self.ridges:
            dx, dy = x1 - x0, y1 - y0
            L2 = dx * dx + dy * dy
            t = np.clip(((X - x0) * dx + (Y - y0) * dy) / L2, 0, 1)
            px, py = x0 + t * dx, y0 + t * dy
            d2 = (X - px) ** 2 + (Y - py) ** 2
            taper = np.sin(np.pi * t) ** 0.6
            h += a * taper * (np.exp(-d2 / (2 * w * w)) - 0.55 * np.exp(-d2 / (2 * (w * 2.2) ** 2)))
        # soft low-frequency undulation
        p = self.ph
        h += 1.2 * np.sin(X / 47 + p[0]) * np.sin(Y / 61 + p[1]) + 0.8 * np.sin(X / 29 + Y / 37 + p[2])
        return h


def knit_texture(X, Y, k):
    """Tonal jacquard knit: micro mesh + diagonal twill, amplitude scales with resolution."""
    u = (X + Y) / 1.15
    v = (X - Y) / 1.15
    mesh = np.sin(u * 2 * np.pi) * np.sin(v * 2 * np.pi)
    rib = np.sin(X * 2 * np.pi / 0.62)
    amp = np.clip((k - 2.0) / 10.0, 0.0, 1.0)
    return 1 + amp * (0.07 * mesh + 0.035 * rib) + 0.012 * mesh


# ------------------------------------------------------------------ embroidery shader
def embroidery(layers, cx, cy, size, win, k, rng_seed=0):
    """Render thread layers (crest in 100-box) at (cx,cy) mm with given size. Returns RGBA, height."""
    sc = size / 100.0
    pad = 3
    ex0, ey0 = cx - size / 2 - pad, cy - size / 2 - pad
    sub = (ex0, ey0, ex0 + size + 2 * pad, ey0 + size + 2 * pad)
    # local supersampled render for crisp thread detail
    ks = max(k, 6.0) * 1.0
    masks = []
    for l in layers:
        g = f'<g transform="translate({cx - size / 2} {cy - size / 2}) scale({sc})"><g fill="#fff" stroke="#fff">{l.svg.replace("#000", "#fff")}</g></g>'
        m = svg_rgba(g, sub, ks)[..., 3]
        masks.append(m)
    h, w = masks[0].shape
    X, Y = mm_grid(sub, ks, masks[0].shape)
    col = np.zeros((h, w, 3), np.float32)
    height = np.zeros((h, w), np.float32)
    alpha = np.zeros((h, w), np.float32)
    pitch = max(0.38, 2.4 / ks)
    rng = np.random.default_rng(rng_seed)
    top_id = np.full((h, w), -1)
    for i, (l, m) in enumerate(zip(layers, masks)):
        mb = (m > 0.5).astype(np.uint8)
        dist = cv2.distanceTransform(mb, cv2.DIST_L2, 5) / ks
        prof = np.clip(dist / 0.55, 0, 1) ** 0.5
        th = math.radians(l.angle)
        uu = X * math.cos(th) + Y * math.sin(th)     # along thread
        vv = -X * math.sin(th) + Y * math.cos(th)    # across threads
        ridge = np.abs(np.sin(np.pi * vv / pitch))
        if l.kind == "fill":
            seg = 3.2
            row = np.floor(vv / pitch)
            ph = (row * 0.37) % 1.0
            gap = np.abs(((uu / seg + ph) % 1.0) - 0.5) * 2
            ridge = ridge * (0.55 + 0.45 * np.clip((gap - 0.06) * 20, 0, 1))
        height = height * (1 - m * 0.5) + m * (0.5 * prof + 0.24 * ridge * prof) + height * m * 0.5
        c = hexrgb(l.color)
        col = col * (1 - m[..., None]) + c * m[..., None]
        alpha = np.maximum(alpha, m)
        top_id = np.where(m > 0.5, i, top_id)
        layers[i]._ridge_dir = th
    # lighting
    gy, gx = np.gradient(height * ks)  # mm height per px -> slope
    nx, ny, nz = -gx, -gy, np.ones_like(gx) * 1.0
    nl = np.sqrt(nx * nx + ny * ny + nz * nz)
    nx, ny, nz = nx / nl, ny / nl, nz / nl
    L = np.array([-0.45, -0.6, 0.66]); L /= np.linalg.norm(L)
    diff = np.clip(nx * L[0] + ny * L[1] + nz * L[2], 0, 1)
    Hh = L + np.array([0, 0, 1.0]); Hh /= np.linalg.norm(Hh)
    spec = np.clip(nx * Hh[0] + ny * Hh[1] + nz * Hh[2], 0, 1) ** 28
    lum = 0.42 + 0.78 * diff
    out = col * lum[..., None] + spec[..., None] * 0.28
    # thread edge darkening between layers
    lab = (top_id + 1).astype(np.float32)
    e = (cv2.morphologyEx(lab, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8)) > 0).astype(np.float32)
    edge = cv2.GaussianBlur(e, (0, 0), max(ks * 0.12, 0.6))
    out *= (1 - 0.35 * edge)[..., None]
    rgba = np.dstack([np.clip(out, 0, 1), alpha])
    # resample to target window/k
    tw, th_ = int(round((sub[2] - sub[0]) * k)), int(round((sub[3] - sub[1]) * k))
    if (tw, th_) != (w, h):
        rgba = cv2.resize(rgba, (tw, th_), interpolation=cv2.INTER_AREA)
    return rgba, sub


def paste(canvas, rgba, sub, win, k, shadow=True):
    x = int(round((sub[0] - win[0]) * k))
    y = int(round((sub[1] - win[1]) * k))
    h, w = rgba.shape[:2]
    H, W = canvas.shape[:2]
    xa, ya, xb, yb = max(x, 0), max(y, 0), min(x + w, W), min(y + h, H)
    if xa >= xb or ya >= yb:
        return canvas
    r = rgba[ya - y:yb - y, xa - x:xb - x]
    if shadow:
        a = r[..., 3]
        sh = cv2.GaussianBlur(a, (0, 0), max(0.7 * k, 1.2))
        M = np.float32([[1, 0, 0.5 * k], [0, 1, 0.7 * k]])
        sh = cv2.warpAffine(sh, M, (sh.shape[1], sh.shape[0]))
        canvas[ya:yb, xa:xb, :3] *= (1 - 0.45 * sh)[..., None]
    a = r[..., 3:4]
    canvas[ya:yb, xa:xb, :3] = r[..., :3] * a + canvas[ya:yb, xa:xb, :3] * (1 - a)
    return canvas


# ------------------------------------------------------------------ garment svg layers
def mix_hex(c1, c2, t):
    a, b = hexrgb(c1), hexrgb(c2)
    c = (a + (b - a) * t) * 255
    return "#%02x%02x%02x" % tuple(int(v) for v in c)


def rib_band(outer, inner, base, stripes, ribs=True, seam_at_outer=True):
    """Knit rib between two polylines; tipping stripes near the free (inner) edge."""
    n = len(outer)
    out = f'<path d="{G.path_d(np.vstack([outer, inner[::-1]]))}" fill="{base}"/>'
    H = G.RIB_H
    for i, c in enumerate(stripes):
        t0, t1 = (H - 5 - i * 4.2) / H, (H - 2.8 - i * 4.2) / H
        a = outer + (inner - outer) * t0
        b = outer + (inner - outer) * t1
        out += f'<path d="{G.path_d(np.vstack([a, b[::-1]]))}" fill="{c}"/>'
    if ribs:
        # knit ribs perpendicular to the band
        L = np.r_[0, np.cumsum(np.linalg.norm(np.diff(outer, axis=0), axis=1))]
        d1, d2 = "", ""
        for s in np.arange(0, L[-1], 1.5):
            i = np.searchsorted(L, s)
            i = min(max(i, 1), n - 1)
            f = (s - L[i - 1]) / max(L[i] - L[i - 1], 1e-6)
            po = outer[i - 1] + (outer[i] - outer[i - 1]) * f
            pi = inner[i - 1] + (inner[i] - inner[i - 1]) * f
            seg = f"M{po[0]:.2f},{po[1]:.2f} L{pi[0]:.2f},{pi[1]:.2f} "
            if int(s / 1.5) % 2:
                d1 += seg
            else:
                d2 += seg
        out += f'<path d="{d1}" stroke="#000" stroke-opacity="0.22" stroke-width="0.55"/>'
        out += f'<path d="{d2}" stroke="#fff" stroke-opacity="0.10" stroke-width="0.45"/>'
        # seam where rib meets body
        out += f'<path d="{G.path_d(outer, close=False)}" fill="none" stroke="#000" stroke-opacity="0.35" stroke-width="0.7"/>'
        out += f'<path d="{G.path_d(outer + (inner - outer) * 0.12, close=False)}" fill="none" stroke="#000" stroke-opacity="0.25" stroke-width="0.35" stroke-dasharray="1.2 0.8"/>'
    return out


def jock_tag(d, x, y, w=50, h=22):
    p = d["pal"]
    bgc = p["dark"] if PF.lum(p["base"]) > 0.5 else p["light"]
    ink = p["light"] if PF.lum(bgc) < 0.5 else p["dark"]
    out = f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="0.8" fill="{bgc}"/>'
    out += f'<rect x="{x + 1.2}" y="{y + 1.2}" width="{w - 2.4}" height="{h - 2.4}" fill="none" stroke="{p["a"]}" stroke-width="0.5"/>'
    out += brand.monogram(x + 9, y + h / 2, 5.6, ink)
    out += typo.text("wide", "WAYAO", x + 17, y + 9.4, 4.6, anchor="start", track=0.16, fill=ink)
    out += typo.text("mono", f"No.{d['no']:02d} · {d['name'].upper()}", x + 17, y + 14.6, 2.6, anchor="start", fill=ink)
    out += typo.text("mono", "AUTHENTIC DISC GOLF KIT", x + 17, y + 18.4, 2.2, anchor="start", fill=p["a"])
    stitch = f'<rect x="{x + 0.5}" y="{y + 0.5}" width="{w - 1}" height="{h - 1}" fill="none" stroke="{ink}" stroke-opacity="0.65" stroke-width="0.3" stroke-dasharray="1 0.7"/>'
    return out + stitch


def body_layer(d, view):
    """Front/back body panel + neck construction + seams, in front-panel mm."""
    back = view == "back"
    piece = "back" if back else "front"
    W, H, fin = PF.piece_dims(piece)
    p = d["pal"]
    art = PF.piece_art(d, piece, uid=f"mk{d['no']}{view}")
    defs = f'<clipPath id="bodyclip"><path d="{G.path_d(fin)}"/></clipPath>'
    out = ""
    ring = neck_ring(view)
    rib_base, rib_stripes = d["rib"]
    if not back:
        # inside of the back: faded mirrored print, neck tape on the back seam, printed label
        hole = np.vstack([ring["top_outer"], ring["free"][::-1]])
        defs += f'<clipPath id="innerclip"><path d="{G.path_d(hole)}"/></clipPath>'
        rngi = np.random.default_rng(d["no"] * 1000 + 17)
        import patterns as PT
        inner_back = PT.PATTERNS[d["pattern"]]("back", W, G.BACK_L, d["pal"], rngi, f"in{d['no']}")
        out += (f'<g clip-path="url(#innerclip)"><g transform="translate({W} 0) scale(-1 1)">{inner_back}</g>'
                f'<rect x="0" y="-60" width="{W}" height="200" fill="#ffffff" fill-opacity="0.42"/>')
        cx2, cy2, R2 = ring["inner_circle"]
        ti = ring["top_inner"]
        tape_bot = arc_pts(cx2, cy2, R2 - 11, math.degrees(math.atan2(ti[0][1] - cy2, ti[0][0] - cx2)) - 2,
                           math.degrees(math.atan2(ti[-1][1] - cy2, ti[-1][0] - cx2)) + 2)
        tape_top = arc_pts(cx2, cy2, R2 + 1, math.degrees(math.atan2(ti[0][1] - cy2, ti[0][0] - cx2)) - 2,
                           math.degrees(math.atan2(ti[-1][1] - cy2, ti[-1][0] - cx2)) + 2)
        out += f'<path d="{G.path_d(np.vstack([tape_top, tape_bot[::-1]]))}" fill="{rib_base}"/>'
        out += f'<path d="{G.path_d(arc_pts(cx2, cy2, R2 - 1.6, 180, 360), close=False)}" fill="none" stroke="{p["a"]}" stroke-width="0.5"/>'
        out += f'<path d="{G.path_d(arc_pts(cx2, cy2, R2 - 9.4, 180, 360), close=False)}" fill="none" stroke="{p["a"]}" stroke-width="0.5"/>'
        tink = p["light"] if PF.lum(rib_base) < 0.5 else p["dark"]
        out += typo.text_arc("condensed", d["tape"], cx2, cy2, R2 - 7.4, 4.4, -90, track=0.2, fill=tink, inside=False)
        out += f'<path d="{G.path_d(arc_pts(cx2, cy2, R2 - 12, 180, 360), close=False)}" fill="none" stroke="#000" stroke-opacity="0.4" stroke-width="0.35" stroke-dasharray="1.4 0.9"/>'
        out += f'<g opacity="0.8">{PF.neck_label(d, CX, 24, PF.ink_on(d))}</g>'
        # interior is in shadow, darker toward the top of the opening
        out += (f'<defs><linearGradient id="ish" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0.5"/>'
                f'<stop offset="1" stop-color="#000" stop-opacity="0.18"/></linearGradient></defs>'
                f'<rect x="0" y="-30" width="{W}" height="110" fill="url(#ish)"/></g>')
        # back rib inner face
        out += rib_band(ring["top_inner"], ring["top_outer"], rib_base, rib_stripes[::-1], seam_at_outer=True)
        out += f'<path d="{G.path_d(np.vstack([ring["top_inner"], ring["top_outer"][::-1]]))}" fill="#000" fill-opacity="0.22"/>'
    else:
        hole = np.vstack([ring["top_outer"], ring["free"][::-1]])
        out += f'<path d="{G.path_d(hole)}" fill="{mix_hex(rib_base, "#000000", 0.55)}"/>'
    # body panel
    out += f'<g clip-path="url(#bodyclip)">{art}'
    # seams: shoulder, armhole, hem twin-needle
    out += "</g>"
    hem_y = H
    for off in (18, 21.5):
        xs = np.linspace(2, W - 2, 60)
        ys = H - 6 + 8 * (1 - ((xs - W / 2) / (W / 2)) ** 2) * 0.5 - off
        out += f'<path d="{G.path_d(np.c_[xs, ys], close=False)}" fill="none" stroke="#000" stroke-opacity="0.32" stroke-width="0.32" stroke-dasharray="1.6 0.8"/>'
    out += rib_band(ring["seam"], ring["free"], rib_base, rib_stripes)
    if not back:
        # woven jock tag, wearer's left hem
        out += jock_tag(d, W - 112, H - 66)
    return out, defs


def sleeve_layer(d, piece, half, side, win, k):
    """Raster of a half sleeve, perspective-mapped onto the mannequin arm."""
    W, H, fin = PF.piece_dims(piece)
    art = PF.piece_art(d, piece, uid=f"sl{d['no']}{piece}{half}")
    cx = W / 2
    if half == "hi":
        poly = np.vstack([fin[(fin[:, 0] >= cx - 0.01)]])
        src = np.float32([[cx, 0], [W, G.SLEEVE_CAP], [cx, H + 4], [cx + G.SLEEVE_HEM_HW, H]])
    else:
        poly = np.vstack([fin[(fin[:, 0] <= cx + 0.01)]])
        src = np.float32([[cx, 0], [0, G.SLEEVE_CAP], [cx, H + 4], [cx - G.SLEEVE_HEM_HW, H]])
    # extend the cap edge inward so the sleeve tucks under the armhole seam
    S, U, T, Bc = sleeve_quad(side)
    ks = k
    sw = (-30, -30, W + 30, H + 30)
    clip = f'<clipPath id="slc"><path d="{G.path_d(fin)}"/></clipPath>'
    hem_st = ""
    for off in (16, 19.5):
        hem_st += f'<path d="M-10,{H - off} L{W + 10},{H - off}" stroke="#000" stroke-opacity="0.3" stroke-width="0.32" stroke-dasharray="1.6 0.8"/>'
    img = svg_rgba(f'<g clip-path="url(#slc)">{art}{hem_st}</g>', sw, ks, defs=clip)
    # keep only the visible half (+ overlap region under the body)
    hm = np.zeros(img.shape[:2], np.float32)
    keep = np.vstack([[cx, -30], [cx, H + 30], [(W + 30) if half == "hi" else -30, H + 30], [(W + 30) if half == "hi" else -30, -30]])
    pts = ((keep - [sw[0], sw[1]]) * ks).astype(np.int32)
    cv2.fillPoly(hm, [pts], 1.0)
    img[..., 3] *= hm
    srcp = (src - [sw[0], sw[1]]) * ks
    dst = np.float32([S, U, T, Bc])
    dstp = (dst - [win[0], win[1]]) * k
    # affine on apex / hem-centre / hem-corner keeps the print undistorted; the cap tucks under the body
    M = cv2.getAffineTransform(srcp[[0, 2, 3]].astype(np.float32), dstp[[0, 2, 3]].astype(np.float32))
    Wc, Hc = int(round((win[2] - win[0]) * k)), int(round((win[3] - win[1]) * k))
    pre = img.copy()
    pre[..., :3] *= pre[..., 3:4]
    warped = cv2.warpAffine(pre, M, (Wc, Hc), flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0, 0))
    a = warped[..., 3:4]
    warped[..., :3] = np.where(a > 1e-4, warped[..., :3] / np.maximum(a, 1e-4), 0)
    return warped


# ------------------------------------------------------------------ main render
FULL_WIN = (-215, -70, G.BODY_W + 215, G.BACK_L + 75)


def render(d, view="front", win=FULL_WIN, k=3.0, bg=True, folds_seed=None):
    rng = np.random.default_rng(folds_seed if folds_seed is not None else d["no"] * 31 + (view == "back"))
    folds = Folds(view, rng)
    Wc, Hc = int(round((win[2] - win[0]) * k)), int(round((win[3] - win[1]) * k))
    canvas = np.zeros((Hc, Wc, 4), np.float32)
    # sleeves (behind body)
    if view == "front":
        sl = [("sleeve_l", "lo", "R"), ("sleeve_r", "hi", "L")]
    else:
        sl = [("sleeve_r", "lo", "R"), ("sleeve_l", "hi", "L")]
    smask = np.zeros((Hc, Wc), np.float32)
    for piece, half, side in sl:
        s = sleeve_layer(d, piece, half, side, win, k)
        canvas = over(canvas, s)
        smask = np.maximum(smask, s[..., 3])
    body, defs = body_layer(d, view)
    b = svg_rgba(body, win, k, defs)
    canvas = over(canvas, b)
    bmask = b[..., 3]
    # armhole seam shadow where body meets sleeve
    X, Y = mm_grid(win, k, canvas.shape)
    fin = G.body(view == "back")
    seam = np.zeros((Hc, Wc), np.float32)
    pts = ((fin - [win[0], win[1]]) * k).astype(np.int32)
    cv2.polylines(seam, [pts], True, 1.0, max(1, int(k * 0.5)), cv2.LINE_AA)
    seam *= smask
    # ---- fold displacement + lighting
    hgt = folds.height(X, Y)
    gy, gx = np.gradient(hgt, 1.0 / k)
    disp = 1.6
    mapx = (np.arange(Wc)[None, :] + gx * disp * k * 0.6).astype(np.float32)
    mapy = (np.arange(Hc)[:, None] + gy * disp * k * 0.6).astype(np.float32)
    canvas = cv2.remap(canvas, mapx, mapy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
    seam = cv2.remap(seam, mapx, mapy, cv2.INTER_LINEAR)
    alpha = canvas[..., 3]
    nx, ny = -gx * 1.0, -gy * 1.0
    nz = np.ones_like(nx)
    nl = np.sqrt(nx ** 2 + ny ** 2 + nz ** 2)
    L = np.array([-0.42, -0.55, 0.72]); L /= np.linalg.norm(L)
    diff = (nx * L[0] + ny * L[1] + nz * L[2]) / nl
    flat = L[2]
    shade = 0.5 + 0.5 * diff / flat
    Hh = L + [0, 0, 1]; Hh /= np.linalg.norm(Hh)
    spec = np.clip((nx * Hh[0] + ny * Hh[1] + nz * Hh[2]) / nl, 0, 1) ** 40
    # wrap-around darkening near silhouette edges
    am = (alpha > 0.5).astype(np.uint8)
    dist = cv2.distanceTransform(am, cv2.DIST_L2, 5) / k
    ao = 1 - 0.38 * np.exp(-dist / 16) - 0.12 * np.exp(-dist / 60)
    # rib casts a soft shadow just below the neckline
    ns = np.zeros((Hc, Wc), np.float32)
    ref = neck_ring(view)["seam"]
    cv2.polylines(ns, [((ref + [0, 2.5] - [win[0], win[1]]) * k).astype(np.int32)], False, 1.0, max(1, int(k * 2.5)), cv2.LINE_AA)
    ns = cv2.GaussianBlur(ns, (0, 0), 2.2 * k)
    vert = 1.04 - 0.1 * np.clip((Y - 0) / G.BACK_L, 0, 1)
    tex = knit_texture(X, Y, k)
    light = shade * ao * vert * tex * (1 - 0.35 * ns) * (1 - 0.45 * cv2.GaussianBlur(seam, (0, 0), 0.8 * k))
    if view == "front":
        # woven jock tag: raised label with fine weft ribs
        tx0, ty0 = G.BODY_W - 112, G.FRONT_L - 66
        Xs, Ys = X + gx * disp * 0.6, Y + gy * disp * 0.6
        tm = ((Xs > tx0) & (Xs < tx0 + 50) & (Ys > ty0) & (Ys < ty0 + 22)).astype(np.float32)
        if tm.any():
            pitch = max(0.3, 2.6 / k)
            weave = 1 + 0.09 * np.sin(2 * np.pi * Ys / pitch) * (0.7 + 0.3 * np.sin(2 * np.pi * Xs / (pitch * 1.7)))
            edge_d = np.minimum.reduce([Xs - tx0, tx0 + 50 - Xs, Ys - ty0, ty0 + 22 - Ys])
            bevel = 1 - 0.18 * np.exp(-np.clip(edge_d, 0, None) / 0.6)
            light = light * np.where(tm > 0, weave * bevel, 1.0)
            out_sh = cv2.GaussianBlur(tm, (0, 0), 0.8 * k)
            out_sh = cv2.warpAffine(out_sh, np.float32([[1, 0, 0.5 * k], [0, 1, 0.8 * k]]), (Wc, Hc))
            light = light * (1 - 0.35 * out_sh * (1 - tm))
    rgb = canvas[..., :3] * light[..., None] + (spec * 0.10)[..., None]
    canvas[..., :3] = np.clip(rgb, 0, 1)
    # ---- embroidery (follows the folds at its centre)
    if view == "front":
        crest_layers = brand.crest(d["crest"])
        p = d["pal"]
        mono_col = d["crest"]["colors"]["border"]
        mono = [brand.Layer(brand.monogram(50, 50, 48, "#000"), mono_col, 35, "satin", "monogram")]
        for layers, (ex, ey, sz), seed in [(crest_layers, (CX + 105, 172, 78), 1), (mono, (CX - 105, 172, 46), 2)]:
            if ex + sz < win[0] or ex - sz > win[2] or ey + sz < win[1] or ey - sz > win[3]:
                continue
            iy, ix = int((ey - win[1]) * k), int((ex - win[0]) * k)
            if 0 <= iy < Hc and 0 <= ix < Wc:
                ex2, ey2 = ex - gx[iy, ix] * disp * 0.6, ey - gy[iy, ix] * disp * 0.6
                sh = light[iy, ix]
            else:
                ex2, ey2, sh = ex, ey, 1.0
            rgba, sub = embroidery(layers, ex2, ey2, sz, win, k, seed)
            rgba[..., :3] *= min(1.05, 0.25 + 0.75 * sh)
            canvas = paste(canvas, rgba, sub, win, k)
    else:
        pass
    if not bg:
        return canvas
    return studio(canvas, k, d)


def studio(canvas, k, d, colors=("#efece6", "#dcd7cf")):
    Hc, Wc = canvas.shape[:2]
    yy, xx = np.mgrid[0:Hc, 0:Wc].astype(np.float32)
    c1, c2 = hexrgb(colors[0]), hexrgb(colors[1])
    r = np.sqrt(((xx - Wc / 2) / Wc) ** 2 + ((yy - Hc * 0.45) / Hc) ** 2)
    t = np.clip(r * 1.6, 0, 1)[..., None]
    bgimg = c1 * (1 - t) + c2 * t
    a = canvas[..., 3]
    sh = cv2.GaussianBlur(a, (0, 0), 9 * k)
    M = np.float32([[1, 0, 4 * k], [0, 1, 9 * k]])
    sh = cv2.warpAffine(sh, M, (Wc, Hc))
    bgimg *= (1 - 0.28 * sh)[..., None]
    out = canvas[..., :3] * a[..., None] + bgimg * (1 - a[..., None])
    # subtle grain
    out += np.random.default_rng(0).normal(0, 0.006, out.shape).astype(np.float32)
    return np.clip(out, 0, 1)


def save(img, path, q=92):
    im = Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8))
    im.save(path, quality=q, subsampling=0, optimize=True)
