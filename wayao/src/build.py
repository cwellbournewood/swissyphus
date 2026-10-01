"""Build the full Wayao collection: print files, mockups, details, flat-lay, video, tech pack.

usage: python3 build.py [design numbers...] [--jobs N] [--tiff DPI]"""
import argparse
import json
import os
import time
from multiprocessing import Pool

import cairosvg
import numpy as np
from PIL import Image

import brand
import designs as DS
import garment as G
import mockup as MK
import printfile as PF
import scenes
import techpack

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "collection"))


def save_jpg(img, path, w=None, q=90):
    im = Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8))
    if w and im.width > w:
        im = im.resize((w, int(im.height * w / im.width)), Image.LANCZOS)
    im.save(path, quality=q, subsampling=0, optimize=True, progressive=True)


def build_one(args):
    n, tiff = args
    d = DS.DESIGNS[n - 1]
    t0 = time.time()
    base = os.path.join(ROOT, f"{d['no']:02d}-{d['slug']}")
    for sub in ("print", "mockups", "video"):
        os.makedirs(os.path.join(base, sub), exist_ok=True)
    stem = f"wayao-{d['no']:02d}-{d['slug']}"

    # ---------------- print files (vector master + proof)
    svg, w, h = PF.sheet_svg(d, proof=False)
    with open(os.path.join(base, "print", f"{stem}_sublimation-sheet.svg"), "w") as f:
        f.write(svg)
    cairosvg.svg2pdf(bytestring=svg.encode(), write_to=os.path.join(base, "print", f"{stem}_sublimation-sheet.pdf"))
    psvg, _, _ = PF.sheet_svg(d, proof=True)
    cairosvg.svg2png(bytestring=psvg.encode(), write_to=os.path.join(base, "print", f"{stem}_proof.png"), output_width=2400)
    if tiff:
        px = int(w / 25.4 * tiff)
        png = cairosvg.svg2png(bytestring=svg.encode(), output_width=px)
        Image.open(__import__("io").BytesIO(png)).convert("RGB").save(
            os.path.join(base, "print", f"{stem}_sublimation-sheet_{tiff}dpi.tif"), compression="tiff_lzw", dpi=(tiff, tiff))
    # individual flat panels (front/back/sleeves) for quick review
    panels = []
    for piece in ("front", "back", "sleeve_l", "sleeve_r"):
        W, H, fin = PF.piece_dims(piece)
        cut = PF.offset(fin, G.SEAM + G.BLEED)
        x0, y0, x1, y1 = cut[:, 0].min(), cut[:, 1].min(), cut[:, 0].max(), cut[:, 1].max()
        art = PF.piece_art(d, piece)
        pv = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{x1 - x0:.0f}mm" height="{y1 - y0:.0f}mm" viewBox="{x0} {y0} {x1 - x0} {y1 - y0}">'
              f'<defs><clipPath id="c"><path d="{G.path_d(cut)}"/></clipPath></defs><g clip-path="url(#c)">{art}</g>'
              f'<path d="{G.path_d(PF.offset(fin, G.SEAM))}" fill="none" stroke="{PF.CUT_COLOR}" stroke-width="0.3"/></svg>')
        with open(os.path.join(base, "print", f"{stem}_panel-{piece}.svg"), "w") as f:
            f.write(pv)
        png = cairosvg.svg2png(bytestring=pv.encode(), output_width=500, background_color="white")
        panels.append((piece, np.asarray(Image.open(__import__("io").BytesIO(png)).convert("RGB"), np.float32) / 255))
    # embroidery artwork (vector, for the digitiser)
    layers = brand.crest(d["crest"])
    csvg = f'<svg xmlns="http://www.w3.org/2000/svg" width="78mm" height="78mm" viewBox="0 0 100 100">{brand.crest_svg(layers)}</svg>'
    with open(os.path.join(base, "print", f"{stem}_crest-embroidery.svg"), "w") as f:
        f.write(csvg)
    mono_col = d["crest"]["colors"]["border"]
    msvg = f'<svg xmlns="http://www.w3.org/2000/svg" width="46mm" height="46mm" viewBox="0 0 100 100">{brand.monogram(50, 50, 48, mono_col)}</svg>'
    with open(os.path.join(base, "print", f"{stem}_monogram-embroidery.svg"), "w") as f:
        f.write(msvg)
    t1 = time.time()

    # ---------------- mockups
    shots = {}
    k = 2.6
    front = MK.render(d, "front", k=k, bg=False)
    shots["front"] = MK.studio(front.copy(), k, d)
    save_jpg(shots["front"], os.path.join(base, "mockups", f"{stem}_01-front.jpg"))
    back = MK.render(d, "back", k=k)
    shots["back"] = back
    save_jpg(back, os.path.join(base, "mockups", f"{stem}_02-back.jpg"))
    cx = G.BODY_W / 2
    S, U, T, Bc = MK.sleeve_quad("R")
    cm = (T + Bc) / 2
    details = [
        ("crest", (cx + 105 - 58, 172 - 58, cx + 105 + 58, 172 + 58), 12.0, "front"),
        ("collar", (cx - 120, -48, cx + 120, 112), 7.0, "front"),
        ("cuff", (cm[0] - 120, cm[1] - 120, cm[0] + 50, cm[1] + 50), 7.0, "front"),
        ("tag", (G.BODY_W - 150, G.FRONT_L - 110, G.BODY_W - 20, G.FRONT_L + 10), 10.0, "front"),
        ("backneck", (cx - 95, -30, cx + 95, 110), 7.0, "back"),
    ]
    for i, (name, win, kk, view) in enumerate(details):
        img = MK.render(d, view, win=win, k=kk)
        shots[name] = img
        save_jpg(img, os.path.join(base, "mockups", f"{stem}_{i + 3:02d}-detail-{name}.jpg"), w=1600)
    fl = scenes.flatlay(d, front, k)
    shots["flatlay"] = fl
    save_jpg(fl, os.path.join(base, "mockups", f"{stem}_08-flatlay.jpg"), w=2400)
    t2 = time.time()

    # ---------------- tech pack
    tp = techpack.techpack_svg(d, shots["front"], shots["back"], shots["crest"], panels)
    cairosvg.svg2pdf(bytestring=tp.encode(), write_to=os.path.join(base, f"{stem}_tech-pack.pdf"))
    cairosvg.svg2png(bytestring=tp.encode(), write_to=os.path.join(base, f"{stem}_tech-pack.png"), output_width=3000)

    # ---------------- video
    scenes.product_video(d, shots, os.path.join(base, "video", f"{stem}.mp4"))
    # small web thumbnail of the front for the collection reel
    save_jpg(shots["front"], os.path.join(base, "mockups", f"{stem}_thumb.jpg"), w=1100, q=86)
    t3 = time.time()
    return f"{n:02d} {d['slug']}: print {t1 - t0:.0f}s, mockups {t2 - t1:.0f}s, pack+video {t3 - t2:.0f}s"


def reel():
    fronts = []
    for d in DS.DESIGNS:
        p = os.path.join(ROOT, f"{d['no']:02d}-{d['slug']}", "mockups", f"wayao-{d['no']:02d}-{d['slug']}_01-front.jpg")
        fronts.append(np.asarray(Image.open(p).convert("RGB"), np.float32) / 255)
    scenes.collection_reel(fronts, DS.DESIGNS, os.path.join(ROOT, "wayao-collection-reel.mp4"))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("nums", nargs="*", type=int)
    ap.add_argument("--jobs", type=int, default=3)
    ap.add_argument("--tiff", type=int, default=0)
    ap.add_argument("--reel", action="store_true")
    a = ap.parse_args()
    nums = a.nums or list(range(1, 13))
    if nums and not (a.reel and not a.nums):
        with Pool(a.jobs) as pool:
            for r in pool.imap_unordered(build_one, [(n, a.tiff) for n in nums]):
                print(r, flush=True)
    if a.reel:
        reel()
        print("reel done")
