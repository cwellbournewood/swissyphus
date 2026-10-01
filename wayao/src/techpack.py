"""One-page tech pack (A3 landscape, mm) per design: construction, trims, embroidery
thread map, colour standards and placements. Exported to vector PDF + PNG."""
import base64
import io

import numpy as np
from PIL import Image

import brand
import garment as G
import printfile as PF
import typo


def img_uri(arr, w=900, q=88):
    im = Image.fromarray((np.clip(arr, 0, 1) * 255).astype(np.uint8))
    if im.width > w:
        im = im.resize((w, int(im.height * w / im.width)), Image.LANCZOS)
    b = io.BytesIO()
    im.save(b, "JPEG", quality=q)
    return "data:image/jpeg;base64," + base64.b64encode(b.getvalue()).decode()


def cmyk(hexc):
    r, g, b = (int(hexc[i:i + 2], 16) / 255 for i in (1, 3, 5))
    k = 1 - max(r, g, b)
    if k >= 1:
        return (0, 0, 0, 100)
    c, m, y = ((1 - x - k) / (1 - k) for x in (r, g, b))
    return tuple(int(round(v * 100)) for v in (c, m, y, k))


def T(s, x, y, size, key="grotesk", anchor="start", fill="#1a1a1a", track=0.0):
    return typo.text(key, s, x, y, size, anchor=anchor, track=track, fill=fill)


def techpack_svg(d, front_img, back_img, crest_img, panels=None):
    W, H = 420, 297
    p = d["pal"]
    s = f'<rect width="{W}" height="{H}" fill="#f7f5f0"/>'
    # header
    s += f'<rect x="0" y="0" width="{W}" height="26" fill="#111"/>'
    s += brand.wordmark(12, 17, 9, "#f7f5f0", anchor="start", track=0.18)
    s += T(f"TECH PACK · No.{d['no']:02d}/12 · {d['name'].upper()} — {d['sub'].upper()}", 70, 16.5, 6, "condensed", fill="#f7f5f0", track=0.15)
    s += T("STYLE WY-JSY-CREW-26 · SIZE RUN XS–3XL · SAMPLE SIZE M", W - 12, 16.5, 4.2, "mono", anchor="end", fill="#bbbbbb")
    # images
    s += f'<image x="10" y="32" width="125" height="{125 * front_img.shape[0] / front_img.shape[1]:.1f}" href="{img_uri(front_img)}"/>'
    s += f'<image x="138" y="32" width="125" height="{125 * back_img.shape[0] / back_img.shape[1]:.1f}" href="{img_uri(back_img)}"/>'
    s += T("FRONT", 72, 150, 4, "mono", "middle", "#666") + T("BACK", 200, 150, 4, "mono", "middle", "#666")
    # story
    s += T("CONCEPT", 10, 162, 5, "condensed", track=0.2, fill=p["a"] if PF.lum(p["a"]) < 0.8 else "#111")
    words, line, y = d["story"].split(), "", 170
    for w in words:
        if typo.text_width("grotesk", line + " " + w, 4.1) > 250:
            s += T(line.strip(), 10, y, 4.1, fill="#333")
            y += 5.6
            line = ""
        line += " " + w
    s += T(line.strip(), 10, y, 4.1, fill="#333")
    # palette
    y0 = 205
    s += T("COLOUR STANDARDS (MATCH TO LAB DIP / PANTONE TCX AT PROOFING)", 10, y0, 4.4, "condensed", track=0.15)
    names = [("BASE", p["base"]), ("TONE", p["tone"]), ("ACCENT A", p["a"]), ("ACCENT B", p["b"]), ("ACCENT C", p["c"]), ("LIGHT", p["light"]), ("DARK", p["dark"])]
    for i, (n, c) in enumerate(names):
        x = 10 + i * 36
        s += f'<rect x="{x}" y="{y0 + 4}" width="33" height="20" fill="{c}" stroke="#00000022" stroke-width="0.3"/>'
        s += T(n, x, y0 + 29, 3.2, "mono", fill="#333")
        s += T(c.upper(), x, y0 + 33.5, 3.2, "mono", fill="#333")
        cm = cmyk(c)
        s += T("C{} M{} Y{} K{}".format(*cm), x, y0 + 38, 2.6, "mono", fill="#777")
    # construction table
    x0 = 272
    s += f'<rect x="{x0 - 4}" y="32" width="{W - x0 - 6}" height="{H - 40}" fill="#ffffff" stroke="#e3ded3" stroke-width="0.4"/>'
    rows = [
        ("FABRIC", "140 gsm 100% recycled polyester interlock,"),
        ("", "tonal knit jacquard, moisture-wicking, UPF 30+"),
        ("PRINT", "Full-panel dye sublimation, 4-panel cut & sew"),
        ("", "Front / back / 2 sleeves · sheet 1600 x 1220 mm"),
        ("COLLAR", f"22 mm 1x1 rib crew, yarn-dyed {d['rib'][0].upper()}"),
        ("", "Tipping: " + " / ".join(c.upper() for c in d["rib"][1])),
        ("CUFFS", "Sublimated cuff band 26 mm + " + str(len(d["cuff"][1])) + " printed stripes"),
        ("NECK", "Printed neck tape 12 mm + tagless printed label"),
        ("HEM", "Twin-needle 20 mm, curved drop tail +15 mm back"),
        ("SEAMS", "4-thread overlock, flatlock at shoulders"),
        ("TAG", "Woven jock tag 50 x 22 mm, L front hem"),
        ("BRANDING", "Embroidered crest 78 mm (wearer's L chest)"),
        ("", "Embroidered W monogram 46 mm (wearer's R chest)"),
        ("FIT", "Regular athletic · chest 108 cm (M)"),
    ]
    y = 42
    s += T("CONSTRUCTION & TRIMS", x0, y, 5, "condensed", track=0.2)
    y += 8
    for k, v in rows:
        if k:
            s += f'<rect x="{x0}" y="{y - 4}" width="{W - x0 - 14}" height="0.2" fill="#ddd"/>'
        s += T(k, x0, y, 3.4, "mono", fill="#888") + T(v, x0 + 24, y, 3.5, fill="#222")
        y += 6.2
    # embroidery thread map
    y += 6
    s += T("EMBROIDERY THREAD MAP — CREST (78 MM)", x0, y, 5, "condensed", track=0.2)
    s += f'<image x="{x0}" y="{y + 3}" width="34" height="34" href="{img_uri(crest_img, 500)}"/>'
    layers = brand.crest(d["crest"])
    yy = y + 6
    seen = []
    for l in layers:
        key = (l.color, l.kind)
        if key in seen:
            continue
        seen.append(key)
        s += f'<rect x="{x0 + 38}" y="{yy - 3}" width="5" height="4" fill="{l.color}" stroke="#00000033" stroke-width="0.2"/>'
        s += T(f"{l.color.upper()}  {l.kind.upper():5s}  {l.name}", x0 + 45, yy, 3.0, "mono", fill="#333")
        yy += 4.6
    y = max(yy, y + 40) + 4
    s += T("Polyester 40wt thread · tear-away backing · 0.4 mm density", x0, y, 3.2, "mono", fill="#666")
    # placements
    y += 10
    s += T("PLACEMENTS (FROM HPS / CENTRE FRONT)", x0, y, 5, "condensed", track=0.2)
    pl = [("Crest centre", "172 mm down · 105 mm L of CF"), ("Monogram centre", "172 mm down · 105 mm R of CF"),
          ("Jock tag", "22 mm above hem · 62 mm from L side"), ("Back neck print", f"'{d['back_neck']}' 54 mm below CB neck"),
          ("Side micro-print", "Wearer's R side seam, 34 mm above hem"), ("Sleeve L / R", "Wordmark / No. badge above cuff band")]
    y += 7
    for k, v in pl:
        s += T(k.upper(), x0, y, 3.2, "mono", fill="#888") + T(v, x0 + 34, y, 3.4, fill="#222")
        y += 5.6
    if panels:
        s += T("SUBLIMATION PANELS (SIZE M, CUT LINE IN MAGENTA)", 10, 252, 4.4, "condensed", track=0.15)
        x = 10
        for name, im in panels:
            h_ = 24
            w_ = h_ * im.shape[1] / im.shape[0]
            s += f'<image x="{x:.1f}" y="256" width="{w_:.1f}" height="{h_}" href="{img_uri(im, 600)}"/>'
            s += T(name.upper().replace("_", " "), x + w_ / 2, 284, 2.8, "mono", "middle", "#777")
            x += w_ + 6
    s += f'<rect x="0" y="{H - 8}" width="{W}" height="8" fill="{p["base"]}"/>'
    for i, c in enumerate(d["rib"][1]):
        s += f'<rect x="0" y="{H - 8 + 2 + i * 2}" width="{W}" height="0.8" fill="{c}"/>'
    return f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{W}mm" height="{H}mm" viewBox="0 0 {W} {H}">{s}</svg>'
