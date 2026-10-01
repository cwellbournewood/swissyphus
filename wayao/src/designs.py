"""The 12-piece Wayao jersey collection: concept, palette and trim spec for each shirt."""

DESIGNS = [
    dict(
        no=1, slug="alpenglow", name="Alpenglow", sub="Hohe Tauern Edition",
        story="The last light on the Alps. Contour lines from Austria's high country climb the body "
              "of the shirt and catch fire at the chest, the way the peaks glow pink after the sun has "
              "gone down. It's for the long par 5s that drop off a ridge.",
        pattern="alpenglow",
        pal=dict(base="#0e1a3a", tone="#18295a", a="#ff7b5c", b="#ffb48a", c="#c34a7a", light="#f4ead8", dark="#081127"),
        crest=dict(frame="shield", emblem="mountain", top="WAYAO",
                   colors=dict(border="#f4ead8", field="#0e1a3a", ring="#ff7b5c", text="#0e1a3a",
                               accent="#ff9a6e", light="#f4ead8", c2="#3d5291", c3="#c34a7a")),
        rib=("#0e1a3a", ["#ff7b5c", "#f4ead8"]), cuff=("#0e1a3a", ["#ff7b5c", "#f4ead8"]),
        tape="WAYAO · ALPENGLOW · HOHE TAUERN · 3798 M ·", back_neck="ÜBER DEN WOLKEN",
        coords="47°04'N 12°41'E",
    ),
    dict(
        no=2, slug="chain-reaction", name="Chain Reaction", sub="Basket Series",
        story="The sound every putter chases. Hundreds of draped basket chains are knitted into a "
              "graphite lattice, with a brushed-gold chain band across the chest at basket height. "
              "Black and gold, made for the last putt of a final round.",
        pattern="chains",
        pal=dict(base="#0b0b0d", tone="#1c1d22", a="#c9a24a", b="#8d8f98", c="#e9d8a6", light="#ececec", dark="#000000"),
        crest=dict(frame="roundel", emblem="basket", top="WAYAO DISC GOLF", bottom="CHAINS DON'T LIE",
                   colors=dict(border="#c9a24a", field="#0b0b0d", ring="#1c1d22", text="#c9a24a",
                               accent="#c9a24a", light="#d9dbe0", c2="#5b5e68", c3="#c9a24a")),
        rib=("#0b0b0d", ["#c9a24a"]), cuff=("#0b0b0d", ["#c9a24a", "#c9a24a"]),
        tape="WAYAO · CHAIN REACTION · CHAINS DON'T LIE ·", back_neck="CHAINS DON'T LIE",
        coords="10 M CIRCLE",
    ),
    dict(
        no=3, slug="flight-path", name="Flight Path", sub="Numbers Edition",
        story="Speed, glide, turn and fade. Every line on this shirt is a real flight: hyzers, "
              "anhyzers, turnovers and flex shots overlapping in tonal forest green, with lime flight "
              "numbers running down the sides. It's a flight chart for the whole bag.",
        pattern="flight",
        pal=dict(base="#0f3a2c", tone="#155040", a="#c8f04e", b="#7fd3a0", c="#f4f1e6", light="#f4f1e6", dark="#082519"),
        crest=dict(frame="hex", emblem="flight", top="WAYAO",
                   colors=dict(border="#c8f04e", field="#0f3a2c", ring="#c8f04e", text="#0f3a2c",
                               accent="#c8f04e", light="#f4f1e6", c2="#7fd3a0", c3="#c8f04e")),
        rib=("#0f3a2c", ["#c8f04e"]), cuff=("#0f3a2c", ["#c8f04e"]),
        tape="WAYAO · FLIGHT PATH · 12 | 5 | -1 | 3 ·", back_neck="HYZER · FLIP · FLEX",
        coords="12 | 5 | -1 | 3",
    ),
    dict(
        no=4, slug="secession", name="Secession", sub="Wien 1900",
        story="Every age needs its art. Vienna's Secession movement gave the city gold-leaf spirals, "
              "Hoffmann grids and Klimt's circles. Here every circle is a disc and every spiral is a "
              "flight, set in black and gold leaf with ivory accents.",
        pattern="secession",
        pal=dict(base="#0d0c0a", tone="#1d1a14", a="#d4a937", b="#a8812a", c="#f1e6c8", light="#f1e6c8", dark="#000000"),
        crest=dict(frame="octagon", emblem="secession", top="WAYAO", bottom="WIEN 1900",
                   colors=dict(border="#d4a937", field="#0d0c0a", ring="#1d1a14", text="#d4a937",
                               accent="#d4a937", light="#f1e6c8", c2="#a8812a", c3="#0d0c0a")),
        rib=("#0d0c0a", ["#d4a937", "#f1e6c8"]), cuff=("#0d0c0a", ["#d4a937"]),
        tape="DER ZEIT IHRE KUNST · DER KUNST IHRE FREIHEIT ·", back_neck="DER ZEIT IHRE KUNST",
        coords="48°12'N 16°21'E",
    ),
    dict(
        no=5, slug="edelweiss", name="Edelweiss", sub="Tracht Edition",
        story="Austrian folk embroidery as a jersey. Edelweiss, gentian and alpine rose sit in a "
              "painted-furniture lattice on alpine cream, with red-white-red tipping on the collar "
              "and cuffs. It's a home shirt for the home course.",
        pattern="edelweiss",
        pal=dict(base="#f3ebd9", tone="#e8ddc4", a="#c8102e", b="#1f4fa3", c="#2f5d3a", light="#ffffff", dark="#3b2a1e"),
        crest=dict(frame="roundel", emblem="edelweiss", top="WAYAO DISC GOLF", bottom="ÖSTERREICH",
                   colors=dict(border="#c8102e", field="#2f5d3a", ring="#f3ebd9", text="#c8102e",
                               accent="#f2c230", light="#ffffff", c2="#2f5d3a", c3="#8fb37e")),
        rib=("#c8102e", ["#ffffff", "#c8102e"]), cuff=("#f3ebd9", ["#c8102e", "#ffffff", "#c8102e"]),
        tape="WAYAO · EDELWEISS · ROT-WEISS-ROT ·", back_neck="ROT · WEISS · ROT",
        coords="47°30'N 13°20'E",
    ),
    dict(
        no=6, slug="fairway-tartan", name="Fairway Tartan", sub="Heritage Sett",
        story="A registered-style sett drawn for Wayao. It's hunter green and fairway navy crossed "
              "with burgundy and a fine gold overcheck, woven in true 2/2 twill. It's for cold "
              "mornings and the club championship.",
        pattern="tartan",
        pal=dict(base="#173426", tone="#1b2a44", a="#7a1f2b", b="#d6b25e", c="#0c1a14", light="#efe6cf", dark="#0a1610"),
        crest=dict(frame="shield", emblem="tartan", top="WAYAO",
                   colors=dict(border="#d6b25e", field="#173426", ring="#7a1f2b", text="#efe6cf",
                               accent="#7a1f2b", light="#d6b25e", c2="#1b2a44", c3="#d6b25e")),
        rib=("#173426", ["#d6b25e", "#7a1f2b"]), cuff=("#173426", ["#d6b25e"]),
        tape="WAYAO · FAIRWAY TARTAN · HERITAGE SETT ·", back_neck="FAIRWAY SINCE DAY ONE",
        coords="SETT 64 · G24 N12 R8 Y2",
    ),
    dict(
        no=7, slug="ace-run-96", name="Ace Run '96", sub="Retro Keeper",
        story="Loud on purpose. It takes the 1996 goalkeeper-kit playbook: shattered shards, "
              "zigzags and brushstroke confetti in teal, violet and sunshine yellow. You wear it "
              "when you plan on hitting chains from the tee.",
        pattern="retro",
        pal=dict(base="#f7f5ef", tone="#e7e3d8", a="#13a89e", b="#5b2a86", c="#ffd23f", light="#ffffff", dark="#14121a"),
        crest=dict(frame="shield", emblem="retro", top="WAYAO",
                   colors=dict(border="#14121a", field="#5b2a86", ring="#ffd23f", text="#14121a",
                               accent="#ffd23f", light="#ffffff", c2="#13a89e", c3="#ffd23f")),
        rib=("#14121a", ["#13a89e", "#ffd23f"]), cuff=("#5b2a86", ["#ffd23f", "#13a89e"]),
        tape="WAYAO · ACE RUN '96 · SEND IT ·", back_neck="SEND IT",
        coords="HOLE 7 · 96 M · ACE",
    ),
    dict(
        no=8, slug="ice-bowl", name="Ice Bowl", sub="Winter Classic",
        story="Disc golf's oldest winter tradition: no weather is too extreme. Frost crystals build "
              "into a hexagonal ice lattice that fades from glacier white to steel blue, with silver "
              "tipping that catches the low winter sun.",
        pattern="ice",
        pal=dict(base="#dcedf6", tone="#bcd8e8", a="#2f6b95", b="#8fc3e0", c="#ffffff", light="#ffffff", dark="#173a55"),
        crest=dict(frame="hex", emblem="snow", top="ICE BOWL",
                   colors=dict(border="#2f6b95", field="#173a55", ring="#cfe3ef", text="#173a55",
                               accent="#8fc3e0", light="#ffffff", c2="#cfe3ef", c3="#2f6b95")),
        rib=("#173a55", ["#cfe3ef", "#8fc3e0"]), cuff=("#173a55", ["#cfe3ef"]),
        tape="WAYAO · ICE BOWL · NO WEATHER TOO EXTREME ·", back_neck="NO WEATHER TOO EXTREME",
        coords="-12 °C · FEB",
    ),
    dict(
        no=9, slug="mando", name="Mando", sub="Course Map Edition",
        story="The scorecard, unfolded. It's an 18-hole course map in charcoal and graphite, with "
              "tee pads, elevation hatching, mando arrows and hazard-orange OB lines. You learn "
              "the layout before you play it.",
        pattern="mando",
        pal=dict(base="#232528", tone="#2e3135", a="#ff6a13", b="#9aa3ab", c="#e9e6df", light="#e9e6df", dark="#141517"),
        crest=dict(frame="roundel", emblem="compass", top="WAYAO DISC GOLF", bottom="PLAY THE LINE",
                   colors=dict(border="#ff6a13", field="#232528", ring="#2e3135", text="#e9e6df",
                               accent="#ff6a13", light="#e9e6df", c2="#ff6a13", c3="#9aa3ab")),
        rib=("#232528", ["#ff6a13"]), cuff=("#232528", ["#ff6a13", "#e9e6df"]),
        tape="WAYAO · MANDO · OB IS OB · PLAY THE LINE ·", back_neck="PLAY THE LINE",
        coords="18 HOLES · PAR 58",
    ),
    dict(
        no=10, slug="hyzer-wave", name="Hyzer Wave", sub="Indigo Edition",
        story="Seigaiha waves in deep indigo, broken by long white hyzer arcs that roll like surf, "
              "with a vermilion sun rising on the chest. The drive comes off the hand calm, then "
              "turns into a big curve.",
        pattern="wave",
        pal=dict(base="#16234d", tone="#1f3168", a="#e8432e", b="#f2efe6", c="#5f79b8", light="#f2efe6", dark="#0c1430"),
        crest=dict(frame="roundel", emblem="wave", top="WAYAO DISC GOLF", bottom="RIDE THE HYZER",
                   colors=dict(border="#f2efe6", field="#16234d", ring="#e8432e", text="#f2efe6",
                               accent="#e8432e", light="#f2efe6", c2="#5f79b8", c3="#e8432e")),
        rib=("#16234d", ["#e8432e"]), cuff=("#16234d", ["#f2efe6", "#e8432e"]),
        tape="WAYAO · HYZER WAVE · RIDE THE HYZER ·", back_neck="RIDE THE HYZER",
        coords="ANHYZER ↔ HYZER",
    ),
    dict(
        no=11, slug="wooded", name="Wooded", sub="Forest Course Edition",
        story="For the tight wooded courses where you walk a 3-metre gap between spruce trunks. "
              "Tree-ring cross-sections and fern fronds grow over moss green, with bark-brown "
              "tipping. It's the deep-forest shirt.",
        pattern="wooded",
        pal=dict(base="#27321f", tone="#334128", a="#c79a5b", b="#7c9a52", c="#e2d3ad", light="#e2d3ad", dark="#161d11"),
        crest=dict(frame="shield", emblem="tree", top="WAYAO",
                   colors=dict(border="#c79a5b", field="#27321f", ring="#e2d3ad", text="#27321f",
                               accent="#c79a5b", light="#e2d3ad", c2="#7c9a52", c3="#7a4f2c")),
        rib=("#27321f", ["#c79a5b"]), cuff=("#27321f", ["#c79a5b", "#e2d3ad"]),
        tape="WAYAO · WOODED · HIT THE GAP ·", back_neck="HIT THE GAP",
        coords="WIENERWALD",
    ),
    dict(
        no=12, slug="glow-round", name="Glow Round", sub="After Dark",
        story="After sunset the discs light up. Long-exposure flight trails in cyan, magenta and "
              "acid lime streak across a midnight body, the way a glow round looks from behind the "
              "basket at 11pm.",
        pattern="glow",
        pal=dict(base="#090a1c", tone="#121433", a="#3cf2ff", b="#ff3fb4", c="#c8ff3c", light="#f0f4ff", dark="#03030b"),
        crest=dict(frame="hex", emblem="glow", top="AFTER DARK",
                   colors=dict(border="#3cf2ff", field="#090a1c", ring="#ff3fb4", text="#f0f4ff",
                               accent="#ff3fb4", light="#f0f4ff", c2="#c8ff3c", c3="#3cf2ff")),
        rib=("#090a1c", ["#3cf2ff", "#ff3fb4"]), cuff=("#090a1c", ["#ff3fb4", "#3cf2ff"]),
        tape="WAYAO · GLOW ROUND · AFTER DARK ·", back_neck="AFTER DARK",
        coords="23:00 · TEE 1",
    ),
]
