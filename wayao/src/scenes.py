"""Lifestyle flat-lay, product video and collection reel."""
import math
import os
import subprocess

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

import brand
import garment as G
import mockup as MK
import printfile as PF
import typo

FONT_DIR = os.path.join(os.path.dirname(__file__), "..", "fonts")


# ------------------------------------------------------------------ surfaces
def surface(w, h, dark, seed):
    rng = np.random.default_rng(seed)
    base = MK.hexrgb("#3a3d40" if dark else "#dcd6cc")
    f = np.zeros((h, w), np.float32)
    for s, a in [(260, 0.022), (60, 0.012), (10, 0.012), (1.5, 0.03)]:
        n = rng.standard_normal((h // 4 + 2, w // 4 + 2)).astype(np.float32)
        n = cv2.GaussianBlur(n, (0, 0), max(s / 4, 0.5))
        n = cv2.resize(n, (w, h), interpolation=cv2.INTER_CUBIC)
        f += a * n / (n.std() + 1e-6)
    img = base[None, None, :] * (1 + f[..., None])
    # aggregate specks
    sp = (rng.random((h, w)) > 0.9985).astype(np.float32)
    sp = cv2.GaussianBlur(sp, (0, 0), 1.2) * 6
    img *= (1 - 0.25 * np.clip(sp, 0, 1))[..., None]
    # sunlight falloff
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    v = 1.08 - 0.22 * (((xx - w * 0.3) / w) ** 2 + ((yy - h * 0.2) / h) ** 2)
    return np.clip(img * v[..., None], 0, 1)


def drop(canvas, rgba, x, y, sun=(0.018, 0.03), soft=0.012, op=0.42):
    """Composite RGBA at (x,y) with a hard sun shadow + ambient contact shadow."""
    h, w = rgba.shape[:2]
    H, W = canvas.shape[:2]
    a = np.zeros((H, W), np.float32)
    rgb = np.zeros((H, W, 3), np.float32)
    xa, ya, xb, yb = max(x, 0), max(y, 0), min(x + w, W), min(y + h, H)
    a[ya:yb, xa:xb] = rgba[ya - y:yb - y, xa - x:xb - x, 3]
    rgb[ya:yb, xa:xb] = rgba[ya - y:yb - y, xa - x:xb - x, :3]
    sx, sy = int(sun[0] * W), int(sun[1] * W)
    hard = cv2.warpAffine(cv2.GaussianBlur(a, (0, 0), 3), np.float32([[1, 0, sx], [0, 1, sy]]), (W, H))
    amb = cv2.GaussianBlur(a, (0, 0), soft * W)
    sh = np.clip(op * hard + 0.25 * amb, 0, 0.6)
    canvas = canvas * (1 - sh[..., None])
    return canvas * (1 - a[..., None]) + rgb * a[..., None]


def rotate_rgba(img, deg):
    h, w = img.shape[:2]
    M = cv2.getRotationMatrix2D((w / 2, h / 2), deg, 1)
    c, s = abs(M[0, 0]), abs(M[0, 1])
    nw, nh = int(h * s + w * c), int(h * c + w * s)
    M[0, 2] += nw / 2 - w / 2
    M[1, 2] += nh / 2 - h / 2
    pre = img.copy()
    pre[..., :3] *= pre[..., 3:4]
    out = cv2.warpAffine(pre, M, (nw, nh), flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0, 0))
    a = out[..., 3:4]
    out[..., :3] = np.where(a > 1e-4, out[..., :3] / np.maximum(a, 1e-4), 0)
    return out


# ------------------------------------------------------------------ props
def disc(d, R, color, stamp=True, seed=0):
    """Top-down golf disc with dome shading, rim and foil hot-stamp."""
    n = int(2 * R + 8)
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    c = n / 2
    r = np.sqrt((xx - c) ** 2 + (yy - c) ** 2) / R
    a = np.clip((1 - r) * R * 0.8, 0, 1)
    base = MK.hexrgb(color)
    # dome normal (flight plate) and rim torus
    h = np.where(r < 0.82, 0.10 * (1 - (r / 0.82) ** 2), 0) + np.where(r >= 0.8, np.sqrt(np.clip(1 - ((r - 0.91) / 0.1) ** 2, 0, 1)) * 0.035, 0)
    gy, gx = np.gradient(h * R)
    L = np.array([-0.5, -0.6, 0.62]); L /= np.linalg.norm(L)
    nz = np.ones_like(gx)
    nl = np.sqrt(gx ** 2 + gy ** 2 + 1)
    dif = (-gx * L[0] - gy * L[1] + nz * L[2]) / nl / L[2]
    H_ = L + [0, 0, 1]; H_ /= np.linalg.norm(H_)
    spec = np.clip((-gx * H_[0] - gy * H_[1] + H_[2]) / nl, 0, 1) ** 60
    img = base * (0.55 + 0.45 * dif)[..., None] + spec[..., None] * 0.55
    # parting-line ring + translucent rim
    ring = np.exp(-((r - 0.8) / 0.008) ** 2)
    img *= (1 - 0.35 * ring)[..., None]
    out = np.dstack([np.clip(img, 0, 1), a])
    if stamp:
        layers = brand.crest(d["crest"])
        s = R * 1.05
        cr = MK.svg_rgba(brand.crest_svg(layers, x=c - s / 2, y=c - s / 2, scale=s / 100), (0, 0, n, n), 1.0)
        lumc = cr[..., :3] @ np.array([0.2126, 0.7152, 0.0722], np.float32)
        border = MK.svg_rgba(brand.crest_svg(layers[:1], x=c - s / 2, y=c - s / 2, scale=s / 100), (0, 0, n, n), 1.0)[..., 3]
        inner = MK.svg_rgba(brand.crest_svg(layers[1:2], x=c - s / 2, y=c - s / 2, scale=s / 100), (0, 0, n, n), 1.0)[..., 3]
        # foil = outer border ring + every emblem/lettering element brighter than the field
        fieldl = float(np.median(lumc[inner > 0.5])) if (inner > 0.5).any() else 0.2
        m = np.clip(border - inner, 0, 1) + cr[..., 3] * inner * (np.abs(lumc - fieldl) > 0.12)
        m = np.clip(m, 0, 1)
        # foil: brushed metallic gradient
        foil = np.array([0.93, 0.93, 0.95]) if MK.hexrgb(color).mean() < 0.55 else np.array([0.12, 0.12, 0.14])
        sheen = 0.75 + 0.35 * np.sin((xx + yy) / n * 6)[..., None]
        out[..., :3] = out[..., :3] * (1 - m[..., None] * 0.92) + (foil * sheen) * m[..., None] * 0.92
        # wordmark ring
        wm = typo.text_arc("black", "WAYAO · DISC GOLF · " + d["name"].upper(), c, c, R * 0.66, R * 0.07, -90, track=0.2, fill="#fff")
        m2 = MK.svg_rgba(wm, (0, 0, n, n), 1.0)[..., 3]
        out[..., :3] = out[..., :3] * (1 - m2[..., None] * 0.85) + foil * m2[..., None] * 0.85
    return out


def card_rgba(svg, wmm, hmm, k):
    return MK.svg_rgba(svg, (0, 0, wmm, hmm), k)


def hangtag_svg(d):
    p = d["pal"]
    bgc, ink = p["base"], PF.ink_on(d)
    s = f'<rect x="0" y="0" width="70" height="120" rx="4" fill="{bgc}"/>'
    s += f'<rect x="3" y="3" width="64" height="114" rx="2.5" fill="none" stroke="{p["a"]}" stroke-width="0.5"/>'
    s += f'<circle cx="35" cy="11" r="3" fill="#00000055"/><circle cx="35" cy="11" r="2.2" fill="#e8e3da"/>'
    s += brand.crest_svg(brand.crest(d["crest"]), x=15, y=22, scale=0.4)
    s += typo.text("mono", f"No.{d['no']:02d} / 12", 35, 72, 3.6, fill=p["a"])
    s += typo.text("wide", d["name"].upper(), 35, 82, 5.0 if len(d["name"]) < 12 else 4.2, track=0.06, fill=ink)
    s += typo.text("condensed", d["sub"].upper(), 35, 89, 4.2, track=0.25, fill=ink)
    s += f'<rect x="20" y="94" width="30" height="0.4" fill="{p["a"]}"/>'
    s += brand.wordmark(35, 108, 5.4, ink, track=0.2)
    return s


def scorecard_svg(d):
    p = d["pal"]
    s = '<rect width="95" height="140" rx="2" fill="#f6f3ec"/>'
    s += brand.wordmark(47.5, 13, 6, "#1a1a1a", track=0.2)
    s += typo.text("mono", "SCORECARD · PAR 58", 47.5, 20, 3.4, fill="#666")
    for i in range(18):
        y = 28 + i * 6
        s += f'<rect x="8" y="{y}" width="79" height="6" fill="none" stroke="#c9c2b4" stroke-width="0.3"/>'
        s += typo.text("mono", f"{i + 1:02d}", 13, y + 4.4, 3.2, fill="#555")
        s += typo.text("mono", "3" if i % 6 else "4", 30, y + 4.4, 3.2, fill="#888")
        sc = [2, 3, 3, 4, 2, 3, 1, 3, 3, 2, 3, 4, 3, 2, 3, 3, 2, 3][i]
        s += typo.text("script", str(sc), 70, y + 5, 5, fill=p["a"] if sc < 3 else "#2b4a8b")
        if sc == 1:
            s += f'<ellipse cx="70.6" cy="{y + 3}" rx="5" ry="3.4" fill="none" stroke="{p["a"]}" stroke-width="0.5"/>'
    return s


def flatlay(d, garment_rgba, k_g, out_w=3000, out_h=2400):
    dark_shirt = PF.lum(d["pal"]["base"]) < 0.5
    rng = np.random.default_rng(d["no"])
    canvas = surface(out_w, out_h, dark=not dark_shirt and False, seed=d["no"])
    kk = out_w / 1300.0   # canvas px per mm (1.3 m wide surface)
    # scorecard under the shirt
    sc = card_rgba(scorecard_svg(d), 95, 140, kk)
    sc = rotate_rgba(sc, 18)
    canvas = drop(canvas, sc, int(out_w * 0.03), int(out_h * 0.62), op=0.3)
    # shirt
    g = garment_rgba
    scale = kk / k_g
    g = cv2.resize(g, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    g = rotate_rgba(g, -5)
    canvas = drop(canvas, g, int(out_w * 0.12), int(out_h * 0.03), op=0.32)
    # discs
    R = 105 * kk
    dsk = disc(d, R, d["pal"]["a"], seed=d["no"])
    dsk = rotate_rgba(dsk, rng.uniform(-30, 30))
    canvas = drop(canvas, dsk, int(out_w * 0.77), int(out_h * 0.06))
    mk = disc(d, 42 * kk, d["pal"]["light"] if dark_shirt else d["pal"]["dark"], stamp=False)
    canvas = drop(canvas, mk, int(out_w * 0.87), int(out_h * 0.52))
    # hang tag on the shirt
    ht = card_rgba(hangtag_svg(d), 70, 120, kk)
    ht = rotate_rgba(ht, -14)
    canvas = drop(canvas, ht, int(out_w * 0.63), int(out_h * 0.6), op=0.4)
    canvas += np.random.default_rng(1).normal(0, 0.008, canvas.shape)
    return np.clip(canvas, 0, 1)


# ------------------------------------------------------------------ video
def _font(name, size):
    return ImageFont.truetype(os.path.join(FONT_DIR, name), size)


def title_overlay(frame, lines, alpha):
    if alpha <= 0:
        return frame
    im = Image.fromarray((frame * 255).astype(np.uint8)).convert("RGBA")
    ov = Image.new("RGBA", im.size, (0, 0, 0, 0))
    dr = ImageDraw.Draw(ov)
    W, H = im.size
    y = H - 210
    dr.rectangle([0, H - 260, W, H], fill=(10, 10, 12, int(140 * alpha)))
    for txt, font, size, col in lines:
        f = _font(font, size)
        tw = dr.textlength(txt, font=f)
        dr.text(((W - tw) / 2, y), txt, font=f, fill=col + (int(255 * alpha),))
        y += size + 14
    im = Image.alpha_composite(im, ov).convert("RGB")
    return np.asarray(im, np.float32) / 255


def ease(t):
    return 0.5 - 0.5 * math.cos(math.pi * min(max(t, 0), 1))


def crop_zoom(img, cx, cy, z, W, H):
    """Crop around normalised centre with zoom z (1 = fit width)."""
    h, w = img.shape[:2]
    cw = w / z
    ch = cw * H / W
    if ch > h:
        ch = h / z
        cw = ch * W / H
    x0 = np.clip(cx * w - cw / 2, 0, w - cw)
    y0 = np.clip(cy * h - ch / 2, 0, h - ch)
    M = np.float32([[W / cw, 0, -x0 * W / cw], [0, H / ch, -y0 * H / ch]])
    return cv2.warpAffine(img, M, (W, H), flags=cv2.INTER_AREA if cw > W else cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT)


def breeze(img, t, amp=4.0):
    h, w = img.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    ph = t * 2 * math.pi
    dx = amp * np.sin(yy / 90 + ph * 0.8) * np.sin(xx / 140 + ph * 0.5)
    dy = amp * 0.6 * np.sin(xx / 110 + ph)
    out = cv2.remap(img, xx + dx, yy + dy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    shade = 1 + 0.035 * np.cos(yy / 90 + ph * 0.8) * np.sin(xx / 140 + ph * 0.5)
    return np.clip(out * shade[..., None], 0, 1)


def product_video(d, shots, path, W=1080, H=1350, fps=30):
    """shots: dict name -> float image (front, back, crest, collar, tag, cuff, flatlay)."""
    p = d["pal"]
    acc = tuple(int(p["a"][i:i + 2], 16) for i in (1, 3, 5))
    seq = [  # (shot, seconds, (cx0,cy0,z0) -> (cx1,cy1,z1), breeze)
        ("front", 3.4, (0.5, 0.5, 1.0), (0.5, 0.46, 1.12), True),
        ("crest", 2.4, (0.5, 0.5, 1.0), (0.5, 0.52, 1.18), False),
        ("collar", 2.2, (0.38, 0.5, 1.0), (0.62, 0.5, 1.12), False),
        ("cuff", 2.0, (0.5, 0.4, 1.05), (0.5, 0.55, 1.15), False),
        ("tag", 2.0, (0.45, 0.5, 1.0), (0.55, 0.5, 1.15), False),
        ("back", 3.0, (0.5, 0.45, 1.15), (0.5, 0.5, 1.0), True),
        ("flatlay", 3.2, (0.45, 0.45, 1.25), (0.5, 0.5, 1.0), False),
    ]
    xf = 0.45
    frames_per = [int(s * fps) for _, s, *_ in seq]
    proc = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
                             "-r", str(fps), "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "25",
                             "-pix_fmt", "yuv420p", "-movflags", "+faststart", path], stdin=subprocess.PIPE)
    prev_tail = None
    total = sum(frames_per)
    fi = 0

    def shot_frame(i, f, n):
        name, sec, a, b, bz = seq[i]
        t = ease(f / max(n - 1, 1))
        cx, cy, z = (a[j] + (b[j] - a[j]) * t for j in range(3))
        img = crop_zoom(shots[name], cx, cy, z, W, H)
        if bz:
            img = breeze(img, f / fps, 3.0)
        return img

    xn = int(xf * fps)
    for i, n in enumerate(frames_per):
        for f in range(n):
            img = shot_frame(i, f, n + xn)
            if i > 0 and f < xn:
                pimg = shot_frame(i - 1, frames_per[i - 1] + f, frames_per[i - 1] + xn)
                a = ease(f / xn)
                img = pimg * (1 - a) + img * a
            if i == 0:
                al = min(1, f / 12) * (1 - max(0, (f - n + 18) / 18))
                img = title_overlay(img, [(f"No.{d['no']:02d} / 12", "DMMono.ttf", 34, acc),
                                          (d["name"].upper(), "Unbounded.ttf", 66, (245, 242, 235)),
                                          (d["sub"].upper() + "  ·  WAYAO DISC GOLF", "BigShouldersDisplay.ttf", 36, (220, 216, 208))], al)
            if i == len(frames_per) - 1:
                al = max(0, min(1, (f - n * 0.45) / 15))
                img = title_overlay(img, [("WAYAO", "Unbounded.ttf", 72, (245, 242, 235)),
                                          (f"{d['name'].upper()}  ·  SUBLIMATED DISC GOLF JERSEY", "BigShouldersDisplay.ttf", 36, acc)], al)
            proc.stdin.write((np.clip(img, 0, 1) * 255).astype(np.uint8).tobytes())
            fi += 1
    proc.stdin.close()
    proc.wait()


def collection_reel(fronts, designs, path, W=1080, H=1350, fps=30, per=1.6):
    proc = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
                             "-r", str(fps), "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "25",
                             "-pix_fmt", "yuv420p", "-movflags", "+faststart", path], stdin=subprocess.PIPE)
    n = int(per * fps)
    xn = 8
    for i, (img, d) in enumerate(zip(fronts, designs)):
        for f in range(n):
            t = f / n
            fr = crop_zoom(img, 0.5, 0.5, 1.0 + 0.06 * t, W, H)
            if i > 0 and f < xn:
                pf = crop_zoom(fronts[i - 1], 0.5, 0.5, 1.06 + 0.004 * f, W, H)
                a = f / xn
                fr = pf * (1 - a) + fr * a
            acc = tuple(int(d["pal"]["a"][j:j + 2], 16) for j in (1, 3, 5))
            fr = title_overlay(fr, [(f"No.{d['no']:02d} / 12", "DMMono.ttf", 32, acc), (d["name"].upper(), "Unbounded.ttf", 60, (245, 242, 235))], 1.0)
            proc.stdin.write((np.clip(fr, 0, 1) * 255).astype(np.uint8).tobytes())
    proc.stdin.close()
    proc.wait()
