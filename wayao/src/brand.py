"""Wayao brand marks: wordmark, monogram and the 12 embroidered crests.

Every crest is returned as an ordered list of thread layers so the embroidery renderer can
stitch each colour separately, and so the tech pack can list the thread colours.
Coordinates: crests live in a 100 x 100 box (scaled to 80 mm on the garment)."""
import math

import typo


class Layer:
    def __init__(self, svg, color, angle=45, kind="satin", name=""):
        self.svg, self.color, self.angle, self.kind, self.name = svg, color, angle, kind, name


def P(pts):
    return "M" + " L".join(f"{x:.2f},{y:.2f}" for x, y in pts) + " Z"


def circle(cx, cy, r):
    return f'M{cx - r},{cy} a{r},{r} 0 1,0 {2 * r},0 a{r},{r} 0 1,0 {-2 * r},0 Z'


def ring(cx, cy, r1, r2):
    return f'<path fill-rule="evenodd" d="{circle(cx, cy, r1)} {circle(cx, cy, r2)}"/>'


def path(d, extra=""):
    return f'<path d="{d}" {extra}/>'


def star(cx, cy, r1, r2, n=5, rot=-90):
    pts = []
    for i in range(n * 2):
        r = r1 if i % 2 == 0 else r2
        a = math.radians(rot + i * 180 / n)
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return P(pts)


def shield_d(x=14, y=8, w=72, h=84):
    cx = x + w / 2
    return (f"M{x},{y} L{x + w},{y} L{x + w},{y + h * 0.48} "
            f"C{x + w},{y + h * 0.78} {cx + w * 0.18},{y + h * 0.9} {cx},{y + h} "
            f"C{cx - w * 0.18},{y + h * 0.9} {x},{y + h * 0.78} {x},{y + h * 0.48} Z")


def octagon_d(cx, cy, r, rot=22.5):
    return P([(cx + r * math.cos(math.radians(rot + 45 * i)), cy + r * math.sin(math.radians(rot + 45 * i))) for i in range(8)])


def hexagon_d(cx, cy, r, rot=-90):
    return P([(cx + r * math.cos(math.radians(rot + 60 * i)), cy + r * math.sin(math.radians(rot + 60 * i))) for i in range(6)])


# ------------------------------------------------------------------ wordmark / monogram
def wordmark(x, y, size, fill, anchor="middle", track=0.12):
    return typo.text("wide", "WAYAO", x, y, size, anchor=anchor, track=track, fill=fill)


def monogram(cx, cy, r, fill, bg=None):
    """Disc + W monogram: a flight-plate disc with a W cut by two hyzer arcs."""
    s = r / 50
    def T(x, y):
        return (cx + (x - 50) * s, cy + (y - 50) * s)
    w = [T(18, 32), T(30, 32), T(38, 58), T(46, 36), T(54, 36), T(62, 58), T(70, 32), T(82, 32),
         T(67, 72), T(57, 72), T(50, 50), T(43, 72), T(33, 72)]
    out = f'<path fill-rule="evenodd" fill="{fill}" d="{circle(cx, cy, r)} {circle(cx, cy, r * 0.86)}"/>'
    out += f'<path fill="{fill}" d="{P(w)}"/>'
    return out


# ------------------------------------------------------------------ crest emblems
def emb_mountain(c):
    peaks = P([(22, 70), (36, 46), (42, 53), (52, 34), (60, 46), (65, 41), (78, 70)])
    snow = P([(46.8, 43.5), (52, 34), (57.2, 42.4), (54.5, 41), (52.4, 44.5), (50, 41.6)])
    snow2 = P([(33.4, 50.6), (36, 46), (39.1, 49.7), (36.5, 49)])
    sun = circle(50, 40, 15)
    ridge = P([(22, 70), (30, 62), (40, 66), (50, 58), (62, 64), (70, 60), (78, 70)])
    return [Layer(path(sun), c["accent"], 0, "fill", "sun"),
            Layer(path(peaks), c["c2"], 60, "fill", "peaks"),
            Layer(path(ridge), c["c3"], -30, "fill", "ridge"),
            Layer(path(snow) + path(snow2), c["light"], 80, "satin", "snow")]


def emb_basket(c):
    band = (f'M28,30 h44 v5 h-44 Z')
    cage = P([(31, 52), (69, 52), (64, 66), (36, 66)])
    pole = 'M48.4,35 h3.2 v38 h-3.2 Z M40,73 h20 v3.5 h-20 Z'
    chains = ""
    for i in range(9):
        x0 = 30 + i * 5
        chains += f'<path d="M{x0},35 Q{50 + (x0 - 50) * 0.35},46 {50 + (x0 - 50) * 0.6},52" fill="none" stroke-width="1.3" stroke-dasharray="1.6 0.8"/>'
    slats = "".join(f'M{34 + i * 4.1},53 v12 h1 v-12 Z ' for i in range(8))
    return [Layer(f'<path d="{cage}"/>', c["c2"], 90, "fill", "cage"),
            Layer(f'<g stroke="#000">{chains}</g>', c["light"], 10, "run", "chains"),
            Layer(path(band) + path(pole), c["accent"], 0, "satin", "band+pole"),
            Layer(path(slats), c["c3"], 0, "satin", "slats")]


def emb_flight(c):
    disc = '<ellipse cx="38" cy="62" rx="12" ry="4.5"/>'
    arc = '<path d="M38,58 C46,30 70,24 72,40 C74,52 62,56 58,48" fill="none" stroke-width="2.4" stroke-linecap="round"/>'
    dots = "".join(f'<circle cx="{x}" cy="{y}" r="1.4"/>' for x, y in [(30, 72), (40, 74), (50, 74), (60, 72), (68, 69)])
    return [Layer(f'<g stroke="#000">{arc}</g>', c["accent"], 0, "satin", "flight"),
            Layer(disc, c["light"], 0, "satin", "disc"),
            Layer(dots, c["c2"], 0, "fill", "dots")]


def emb_secession(c):
    ball = circle(50, 46, 15)
    leaves = ""
    for i in range(16):
        a = i * 22.5
        r = math.radians(a)
        x, y = 50 + 10 * math.cos(r), 46 + 10 * math.sin(r)
        leaves += f'<ellipse cx="{x:.2f}" cy="{y:.2f}" rx="3.6" ry="1.7" transform="rotate({a + 90:.1f} {x:.2f} {y:.2f})"/>'
    base = 'M33,64 h34 v4 h-34 Z M37,68 h26 v6 h-26 Z'
    cols = "".join(f'M{39 + i * 6},69 h2.4 v4 h-2.4 Z ' for i in range(4))
    return [Layer(path(ball), c["accent"], 30, "fill", "dome"),
            Layer(leaves, c["c2"], 0, "satin", "laurel"),
            Layer(path(base), c["light"], 0, "satin", "pavilion"),
            Layer(path(cols), c["c3"], 90, "satin", "columns")]


def emb_edelweiss(c):
    pet = ""
    for i in range(9):
        a = i * 40
        pet += f'<path d="M50,50 C45,42 46,30 50,24 C54,30 55,42 50,50 Z" transform="rotate({a} 50 50)"/>'
    cen = "".join(f'<circle cx="{50 + 4.2 * math.cos(math.radians(k * 72))}" cy="{50 + 4.2 * math.sin(math.radians(k * 72))}" r="2.6"/>' for k in range(5)) + '<circle cx="50" cy="50" r="2.4"/>'
    leaves = '<path d="M50,52 C40,60 30,62 24,60 C32,66 42,64 50,56 Z"/><path d="M50,52 C60,60 70,62 76,60 C68,66 58,64 50,56 Z"/>'
    return [Layer(leaves, c["c3"], -40, "satin", "leaves"),
            Layer(pet, c["light"], 90, "satin", "petals"),
            Layer(cen, c["accent"], 0, "fill", "centre")]


def emb_tartan(c):
    sal = ('<path d="M24,26 L30,20 L76,66 L70,72 Z"/><path d="M76,26 L70,20 L24,66 L30,72 Z"/>')
    disc = path(circle(50, 46, 12))
    rim = ring(50, 46, 9.6, 8.2)
    st = path(star(50, 76, 4.2, 1.8)) + path(star(34, 78, 2.4, 1, 5)) + path(star(66, 78, 2.4, 1, 5))
    return [Layer(sal, c["light"], 45, "satin", "saltire"),
            Layer(disc, c["accent"], -45, "fill", "disc"),
            Layer(rim, c["light"], 0, "satin", "rim"),
            Layer(st, c["light"], 0, "satin", "stars")]


def emb_retro(c):
    bolt = P([(55, 22), (36, 54), (49, 54), (43, 78), (66, 42), (52, 42), (60, 22)])
    disc = '<ellipse cx="50" cy="52" rx="24" ry="9"/>'
    return [Layer(disc, c["c2"], 0, "fill", "disc"),
            Layer(path(bolt), c["accent"], 70, "satin", "bolt"),
            Layer(typo.text("black", "96", 50, 81, 10, fill="#000"), c["light"], 0, "satin", "96")]


def emb_snow(c):
    arms = ""
    for i in range(6):
        a = i * 60
        arms += (f'<g transform="rotate({a} 50 50)"><rect x="48.6" y="24" width="2.8" height="26"/>'
                 f'<path d="M50,33 l-7,-6 l1.6,-1.6 l5.4,4.6 l5.4,-4.6 l1.6,1.6 Z"/>'
                 f'<path d="M50,41 l-5,-4 l1.4,-1.4 l3.6,3 l3.6,-3 l1.4,1.4 Z"/></g>')
    hexc = path(hexagon_d(50, 50, 6, -90))
    return [Layer(arms, c["light"], 0, "satin", "crystal"),
            Layer(hexc, c["accent"], 0, "fill", "core")]


def emb_compass(c):
    pts = []
    for i in range(8):
        a = math.radians(-90 + i * 45)
        r = 28 if i % 2 == 0 else 15
        pts.append((50 + r * math.cos(a), 50 + r * math.sin(a)))
        a2 = math.radians(-90 + i * 45 + 22.5)
        pts.append((50 + 4.5 * math.cos(a2), 50 + 4.5 * math.sin(a2)))
    rose = P(pts)
    north = P([(50, 22), (54.5, 45.8), (50, 50), (45.5, 45.8)])
    return [Layer(path(rose), c["light"], 45, "satin", "rose"),
            Layer(path(north), c["accent"], 90, "satin", "north"),
            Layer(path(circle(50, 50, 3)), c["c2"], 0, "fill", "pin")]


def emb_wave(c):
    sun = circle(62, 36, 12)
    wave = ("M18,74 C22,56 34,44 48,44 C58,44 64,52 60,58 C57,62 50,60 51,55 C52,51 56,52 56,54 "
            "C58,48 50,46 46,50 C40,56 44,66 54,68 C64,70 74,64 82,58 L82,74 Z")
    foam = "".join(f'<circle cx="{x}" cy="{y}" r="1.6"/>' for x, y in [(30, 52), (34, 48), (38, 46), (27, 57)])
    return [Layer(path(sun), c["accent"], 0, "fill", "sun"),
            Layer(path(wave), c["light"], 30, "satin", "wave"),
            Layer(foam, c["light"], 0, "fill", "foam")]


def emb_tree(c):
    tiers = P([(50, 20), (60, 34), (55, 34), (66, 48), (59, 48), (71, 62), (29, 62), (41, 48), (34, 48), (45, 34), (40, 34)])
    trunk = 'M47,62 h6 v10 h-6 Z'
    rings = ring(50, 76, 7, 5.6) + ring(50, 76, 4.3, 3.1) + path(circle(50, 76, 1.6))
    return [Layer(path(tiers), c["c2"], -60, "fill", "spruce"),
            Layer(path(trunk), c["c3"], 90, "satin", "trunk"),
            Layer(rings, c["accent"], 0, "satin", "rings")]


def emb_glow(c):
    moon = '<path fill-rule="evenodd" d="' + circle(40, 40, 13) + " " + circle(46, 36, 11.5) + '"/>'
    rings = ring(58, 58, 16, 13.4) + ring(58, 58, 9.4, 7.6)
    stars = path(star(70, 28, 4, 1.4, 4, -90)) + path(star(28, 66, 3, 1, 4, -90))
    return [Layer(rings, c["accent"], 0, "satin", "glow rings"),
            Layer(moon, c["light"], 60, "fill", "moon"),
            Layer(stars, c["c2"], 0, "satin", "stars")]


EMBLEMS = dict(mountain=emb_mountain, basket=emb_basket, flight=emb_flight, secession=emb_secession,
               edelweiss=emb_edelweiss, tartan=emb_tartan, retro=emb_retro, snow=emb_snow,
               compass=emb_compass, wave=emb_wave, tree=emb_tree, glow=emb_glow)


# ------------------------------------------------------------------ crest frames
def crest(spec):
    """spec: dict(frame, emblem, colors{field, border, accent, light, c2, c3, text}, top, bottom)."""
    c = spec["colors"]
    frame = spec["frame"]
    L = []
    if frame == "roundel":
        L.append(Layer(path(circle(50, 50, 48)), c["border"], 0, "fill", "border"))
        L.append(Layer(path(circle(50, 50, 45)), c["ring"], 30, "fill", "text ring"))
        L.append(Layer(ring(50, 50, 33.5, 31.5) + ring(50, 50, 46.6, 45.6), c["border"], 0, "satin", "rule"))
        L.append(Layer(path(circle(50, 50, 31.5)), c["field"], -30, "fill", "field"))
        txt = typo.text_arc("black", spec.get("top", "WAYAO DISC GOLF"), 50, 50, 35.6, 7.2, -90, track=0.16, fill="#000")
        txt += typo.text_arc("condensed", spec.get("bottom", "EVERY THROW COUNTS"), 50, 50, 35.4, 7.6, 90, inside=True, track=0.2, fill="#000")
        txt += path(star(16.5, 50, 2.4, 1, 5)) + path(star(83.5, 50, 2.4, 1, 5))
        L.append(Layer(txt, c["text"], 0, "satin", "lettering"))
        clip = (50, 50, 31.5)
    elif frame == "shield":
        L.append(Layer(path(shield_d(10, 4, 80, 92)), c["border"], 0, "fill", "border"))
        L.append(Layer(path(shield_d(14, 8, 72, 84)), c["field"], -30, "fill", "field"))
        L.append(Layer(path("M14,8 h72 v16 h-72 Z"), c["ring"], 0, "satin", "chief"))
        L.append(Layer(typo.text("black", spec.get("top", "WAYAO"), 50, 19.6, 9, track=0.22, fill="#000"), c["text"], 0, "satin", "lettering"))
        clip = None
    elif frame == "octagon":
        L.append(Layer(path(octagon_d(50, 50, 50)), c["border"], 0, "fill", "border"))
        L.append(Layer(path(octagon_d(50, 50, 45.5)), c["ring"], 30, "fill", "frame"))
        L.append(Layer(path(octagon_d(50, 50, 34)), c["field"], -30, "fill", "field"))
        txt = typo.text("condensed", spec.get("top", "WAYAO"), 50, 15.4, 6.6, track=0.34, fill="#000")
        txt += typo.text("condensed", spec.get("bottom", "DISC GOLF"), 50, 90.2, 6.2, track=0.34, fill="#000")
        L.append(Layer(txt, c["text"], 0, "satin", "lettering"))
        clip = None
    elif frame == "hex":
        L.append(Layer(path(hexagon_d(50, 50, 49, 0)), c["border"], 0, "fill", "border"))
        L.append(Layer(path(hexagon_d(50, 50, 44.5, 0)), c["field"], -30, "fill", "field"))
        L.append(Layer(f'<path fill-rule="evenodd" d="{hexagon_d(50, 50, 42.4, 0)} {hexagon_d(50, 50, 41.4, 0)}"/>', c["ring"], 0, "satin", "rule"))
        L.append(Layer(path("M27,73.5 h46 l-3,10 h-40 Z"), c["ring"], 0, "satin", "banner"))
        L.append(Layer(typo.text("condensed", spec.get("top", "WAYAO"), 50, 81.6, 7.2, track=0.28, fill="#000"), c["text"], 0, "satin", "lettering"))
        clip = None
    em = EMBLEMS[spec["emblem"]](c)
    if frame == "hex":
        for l in em:
            l.svg = f'<g transform="translate(50 43) scale(0.78) translate(-50 -50)">{l.svg}</g>'
    elif frame == "shield":
        for l in em:
            l.svg = f'<g transform="translate(50 56) scale(0.92) translate(-50 -50)">{l.svg}</g>'
    L.extend(em)
    return L


def crest_svg(layers, size=100, x=0, y=0, scale=1.0):
    g = "".join(f'<g fill="{l.color}" stroke="{l.color}" stroke-width="0">{l.svg.replace("#000", l.color)}</g>' for l in layers)
    return f'<g transform="translate({x},{y}) scale({scale})">{g}</g>'
