"""Generate the web lookbook (lookbook/index.html + web-sized media) from the built collection."""
import html
import os
import subprocess

from PIL import Image

import designs as DS

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
COL = os.path.join(ROOT, "collection")
OUT = os.path.join(ROOT, "lookbook")


def web(src, dst, w, q=82):
    im = Image.open(src).convert("RGB")
    if im.width > w:
        im = im.resize((w, int(im.height * w / im.width)), Image.LANCZOS)
    im.save(dst, quality=q, optimize=True, progressive=True)


def media():
    for d in DS.DESIGNS:
        nn = f"{d['no']:02d}"
        stem = f"wayao-{nn}-{d['slug']}"
        base = os.path.join(COL, f"{nn}-{d['slug']}")
        o = os.path.join(OUT, "m", nn)
        os.makedirs(o, exist_ok=True)
        mk = os.path.join(base, "mockups")
        web(f"{mk}/{stem}_01-front.jpg", f"{o}/front.jpg", 1200)
        web(f"{mk}/{stem}_02-back.jpg", f"{o}/back.jpg", 1200)
        for i, n in [(3, "crest"), (4, "collar"), (5, "cuff"), (6, "tag"), (7, "backneck")]:
            web(f"{mk}/{stem}_{i:02d}-detail-{n}.jpg", f"{o}/{n}.jpg", 800)
        web(f"{mk}/{stem}_08-flatlay.jpg", f"{o}/flatlay.jpg", 1400)
        web(f"{base}/print/{stem}_proof.png", f"{o}/print.jpg", 1400, 80)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", f"{base}/video/{stem}.mp4", "-vf", "scale=720:-2",
                        "-c:v", "libx264", "-crf", "28", "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                        f"{o}/film.mp4"], check=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", f"{COL}/wayao-collection-reel.mp4", "-vf", "scale=720:-2",
                    "-c:v", "libx264", "-crf", "27", "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                    f"{OUT}/m/reel.mp4"], check=True)


CSS = """
:root{
  /* layout: catalogue — masthead + 12-shirt index rail, then one full spread per jersey */
  --ground:#e6e7e2; --paper:#f2f2ee; --ink:#14161a; --mute:#5d625f; --line:#c9ccc4; --chip:#ffffff;
  --display:"Unbounded","Arial Black",system-ui,sans-serif;
  --label:"Big Shoulders Display","Arial Narrow",system-ui,sans-serif;
  --body:"Archivo",system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:"DM Mono",ui-monospace,Menlo,monospace;
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--ground:#121412;--paper:#1b1d1b;--ink:#ecece6;--mute:#9da39d;--line:#2f332f;--chip:#262926;color-scheme:dark}}
:root[data-theme="dark"]{--ground:#121412;--paper:#1b1d1b;--ink:#ecece6;--mute:#9da39d;--line:#2f332f;--chip:#262926;color-scheme:dark}
*{box-sizing:border-box}
body{background:var(--ground);color:var(--ink);font-family:var(--body);font-size:16px;line-height:1.55;margin:0}
.wrap{max-width:1240px;margin:0 auto;padding-inline:clamp(16px,4vw,40px);padding-block:0}
header.mast{padding-block:48px 28px;display:grid;gap:18px}
.brand{font-family:var(--display);font-weight:700;letter-spacing:.32em;font-size:clamp(28px,6vw,64px);line-height:1;margin:0}
.kick{font-family:var(--label);font-weight:800;text-transform:uppercase;letter-spacing:.18em;font-size:15px;color:var(--mute)}
.lede{max-width:62ch;margin:0;font-size:18px}
.reel{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,340px);gap:28px;align-items:end;padding-block:12px 36px;border-bottom:1px solid var(--line)}
.reel video{width:100%;max-width:340px;aspect-ratio:4/5;object-fit:cover;background:#000;display:block;justify-self:end}
.facts{display:flex;flex-wrap:wrap;gap:10px 26px;font-family:var(--mono);font-size:13px;color:var(--mute);margin:0;padding:0;list-style:none}
.index{display:grid;grid-template-columns:repeat(auto-fill,minmax(176px,1fr));gap:14px;padding-block:32px}
.index a{color:inherit;text-decoration:none;display:grid;gap:6px;outline-offset:4px}
.index img{width:100%;aspect-ratio:1.1;object-fit:cover;background:var(--paper);display:block;transition:transform .25s ease}
.index a:hover img,.index a:focus-visible img{transform:translateY(-3px)}
.index .n{font-family:var(--mono);font-size:12px;color:var(--mute);font-variant-numeric:tabular-nums}
.index .t{font-family:var(--label);font-weight:800;text-transform:uppercase;letter-spacing:.08em;font-size:18px;line-height:1.1}
section.kit{padding-block:56px;border-top:1px solid var(--line);display:grid;gap:26px}
.kit-head{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 22px;align-items:baseline}
.kit-no{font-family:var(--mono);font-size:14px;padding:4px 10px;background:var(--acc);color:var(--acc-ink);font-variant-numeric:tabular-nums}
.kit-head h2{font-family:var(--display);font-weight:700;font-size:clamp(28px,5vw,54px);line-height:1;margin:0;letter-spacing:.01em;text-wrap:balance}
.kit-head .sub{grid-column:2;font-family:var(--label);font-weight:800;text-transform:uppercase;letter-spacing:.2em;color:var(--mute);font-size:15px}
.stage{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(0,1fr);gap:22px;align-items:start}
.hero{position:relative;background:var(--paper)}
.hero img{width:100%;display:block}
.flip{position:absolute;left:12px;bottom:12px;display:flex;gap:0;border:1px solid #0003;background:#ffffffd9}
.flip button{font:600 12px var(--mono);letter-spacing:.08em;text-transform:uppercase;border:0;background:transparent;color:#14161a;padding:7px 12px;cursor:pointer}
.flip button[aria-pressed="true"]{background:#14161a;color:#fff}
.flip button:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.side{display:grid;gap:18px;min-width:0}
.side p{margin:0;max-width:60ch}
.side video{width:100%;aspect-ratio:4/5;object-fit:cover;background:#000;display:block}
.swatches{display:flex;flex-wrap:wrap;gap:6px}
.sw{display:grid;gap:3px;font-family:var(--mono);font-size:10.5px;color:var(--mute)}
.sw i{display:block;width:44px;height:30px;border:1px solid var(--line)}
dl.spec{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 16px;margin:0;font-size:14px}
dl.spec dt{font-family:var(--mono);font-size:12px;color:var(--mute);text-transform:uppercase;padding-top:2px}
dl.spec dd{margin:0}
.details{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}
.details figure{margin:0;display:grid;gap:6px}
.details img{width:100%;aspect-ratio:1;object-fit:cover;display:block;background:var(--paper)}
figcaption{font-family:var(--mono);font-size:11.5px;color:var(--mute);text-transform:uppercase;letter-spacing:.06em}
.wide{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:10px}
.wide img{width:100%;display:block;background:#fff}
footer{padding-block:48px;color:var(--mute);font-size:14px;border-top:1px solid var(--line)}
@media (max-width:860px){.stage,.wide,.reel{grid-template-columns:minmax(0,1fr)}.details{grid-template-columns:repeat(2,minmax(0,1fr))}.reel video{justify-self:start}}
@media (prefers-reduced-motion:reduce){.index img{transition:none}}
"""


def lum(h):
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (1, 3, 5))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def page():
    e = html.escape
    idx = "".join(
        f'<a href="#k{d["no"]:02d}"><img src="m/{d["no"]:02d}/front.jpg" alt="{e(d["name"])} jersey, front" loading="lazy">'
        f'<span class="n">No.{d["no"]:02d}</span><span class="t">{e(d["name"])}</span></a>' for d in DS.DESIGNS)
    kits = ""
    for d in DS.DESIGNS:
        nn = f"{d['no']:02d}"
        p = d["pal"]
        acc = p["a"]
        acc_ink = "#111" if lum(acc) > 0.5 else "#fff"
        sw = "".join(f'<span class="sw"><i style="background:{c}"></i>{c.upper()}</span>' for c in [p["base"], p["tone"], p["a"], p["b"], p["c"], p["light"]])
        rib = " / ".join(c.upper() for c in d["rib"][1])
        det = "".join(f'<figure><img src="m/{nn}/{f}.jpg" alt="{e(d["name"])} {c}" loading="lazy"><figcaption>{c}</figcaption></figure>'
                      for f, c in [("crest", "Embroidered crest"), ("collar", "Rib collar + neck tape"), ("cuff", "Sleeve cuff"),
                                   ("tag", "Woven jock tag"), ("backneck", "Back-neck print")])
        kits += f"""
<section class="kit" id="k{nn}" style="--acc:{acc};--acc-ink:{acc_ink}">
  <div class="kit-head"><span class="kit-no">No.{nn} / 12</span><h2>{e(d["name"])}</h2><span class="sub">{e(d["sub"])}</span></div>
  <div class="stage">
    <div class="hero"><img id="h{nn}" src="m/{nn}/front.jpg" alt="{e(d["name"])} jersey on a ghost mannequin">
      <div class="flip" role="group" aria-label="View"><button type="button" aria-pressed="true" data-k="{nn}" data-v="front">Front</button><button type="button" aria-pressed="false" data-k="{nn}" data-v="back">Back</button></div></div>
    <div class="side">
      <p>{e(d["story"])}</p>
      <video src="m/{nn}/film.mp4" poster="m/{nn}/crest.jpg" controls muted playsinline preload="none" aria-label="{e(d["name"])} product film"></video>
      <div class="swatches">{sw}</div>
      <dl class="spec">
        <dt>Crest</dt><dd>{e(d["crest"]["frame"].title())} · {e(d["crest"]["emblem"])} · embroidered 78 mm</dd>
        <dt>Collar</dt><dd>22 mm rib {d["rib"][0].upper()} · tipping {rib}</dd>
        <dt>Neck tape</dt><dd>{e(d["tape"].strip(" ·"))}</dd>
        <dt>Back neck</dt><dd>{e(d["back_neck"])}</dd>
        <dt>Detail</dt><dd>{e(d["coords"])}</dd>
      </dl>
    </div>
  </div>
  <div class="details">{det}</div>
  <div class="wide"><figure style="margin:0"><img src="m/{nn}/flatlay.jpg" alt="{e(d["name"])} flat-lay with stamped disc" loading="lazy"><figcaption>Flat-lay</figcaption></figure>
  <figure style="margin:0"><img src="m/{nn}/print.jpg" alt="{e(d["name"])} sublimation print sheet" loading="lazy"><figcaption>Sublimation sheet · 1600 × 1220 mm · cut line magenta</figcaption></figure></div>
</section>"""
    return f"""<title>Wayao Twelve</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600&family=Big+Shoulders+Display:wght@800&family=DM+Mono:wght@500&family=Unbounded:wght@700&display=swap">
<style>{CSS}</style>
<div class="wrap">
<header class="mast">
  <span class="kick">Disc golf jersey collection · 12 sublimated crew necks</span>
  <h1 class="brand">WAYAO</h1>
</header>
<div class="reel">
  <div style="display:grid;gap:18px;min-width:0">
    <p class="lede">Twelve crew-neck jerseys, each built around one idea from the sport or from Austria: alpine contours, basket chains, flight numbers, Klimt's Vienna, folk embroidery, a course map, a night round. Every shirt has an embroidered crest, a tipped rib collar, a printed neck tape and a woven hem tag.</p>
    <ul class="facts"><li>140 gsm recycled poly jacquard</li><li>4-panel sublimation</li><li>Crest 78 mm · monogram 46 mm</li><li>Sizes XS–3XL</li></ul>
  </div>
  <video src="m/reel.mp4" poster="m/01/front.jpg" controls muted playsinline loop preload="metadata" aria-label="Collection reel"></video>
</div>
<nav class="index" aria-label="Collection index">{idx}</nav>
{kits}
<footer>Mockups, films and print sheets are rendered from the same vector production files. The wordmark and monogram are placeholders for the official Wayao logo.</footer>
</div>
<script>
document.querySelectorAll('.flip button').forEach(b=>b.addEventListener('click',()=>{{
  const k=b.dataset.k;document.getElementById('h'+k).src='m/'+k+'/'+b.dataset.v+'.jpg';
  b.parentElement.querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',x===b?'true':'false'));
}}));
</script>
"""


if __name__ == "__main__":
    import sys
    os.makedirs(OUT, exist_ok=True)
    if "--no-media" not in sys.argv:
        media()
    with open(os.path.join(OUT, "index.html"), "w") as f:
        f.write(page())
    print("ok")
