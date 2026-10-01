"""Garment block (size M, millimetres). One source of truth shared by the sublimation
print files and the mockup renderer, so what is printed is exactly what is shown."""
import numpy as np

# --- body block -------------------------------------------------------------
BODY_W = 540          # flat chest width (half circumference 108 cm)
FRONT_L = 720         # HPS to hem, centre front
BACK_L = 735          # back is 15 mm longer (drop tail)
NECK_HW = 92          # half neck width at HPS
FRONT_DROP = 95       # front neck drop
BACK_DROP = 22        # back neck drop
SHOULDER_HW = 218     # half across-shoulder
SHOULDER_DROP = 44    # shoulder slope
UNDERARM_Y = 245      # armhole depth from HPS
BLEED = 15            # print bleed beyond cut line

SLEEVE_W = 450        # flat sleeve width at bicep (underarm to underarm)
SLEEVE_CAP = 118
SLEEVE_L = 235        # cap top to hem
SLEEVE_HEM_HW = 168   # half hem opening (flat)

RIB_H = 22            # finished crew-neck rib height
CUFF_H = 0            # sublimated hem sleeves (cuff trim is printed + taped)
SEAM = 10             # seam allowance included in cut line


def cubic(p0, p1, p2, p3, n=24):
    t = np.linspace(0, 1, n)[:, None]
    p0, p1, p2, p3 = map(np.asarray, (p0, p1, p2, p3))
    return (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3 * p3


def _poly(*segs):
    out = []
    for s in segs:
        s = np.asarray(s, float)
        if out and np.allclose(out[-1][-1], s[0]):
            s = s[1:]
        out.append(s)
    return np.vstack(out)


def body(back=False):
    """Closed outline of front/back body piece, origin at top-left of bounding box (HPS y=0)."""
    W, cx = BODY_W, BODY_W / 2
    L = BACK_L if back else FRONT_L
    drop = BACK_DROP if back else FRONT_DROP
    nl, nr = (cx - NECK_HW, 0), (cx + NECK_HW, 0)
    sl, sr = (cx - SHOULDER_HW, SHOULDER_DROP), (cx + SHOULDER_HW, SHOULDER_DROP)
    ul, ur = (0, UNDERARM_Y), (W, UNDERARM_Y)
    neck = _poly(cubic(nl, (nl[0] + 4, drop * 0.75), (cx - NECK_HW * 0.55, drop), (cx, drop)),
                 cubic((cx, drop), (cx + NECK_HW * 0.55, drop), (nr[0] - 4, drop * 0.75), nr))
    shoulder_r = np.array([nr, sr])
    arm_r = cubic(sr, (sr[0] - 16, sr[1] + 90), (W - 22, UNDERARM_Y - 18), ur)
    side_r = cubic(ur, (W + 2, 420), (W - 4, 560), (W, L - 6))
    hem = cubic((W, L - 6), (W * 0.7, L + 2), (W * 0.3, L + 2), (0, L - 6))
    side_l = cubic((0, L - 6), (-4, 560), (2, 420), ul)
    arm_l = cubic(ul, (22, UNDERARM_Y - 18), (sl[0] + 16, sl[1] + 90), sl)
    shoulder_l = np.array([sl, nl])
    return _poly(neck, shoulder_r, arm_r, side_r, hem, side_l, arm_l, shoulder_l)


def neckline(back=False, n=40):
    cx = BODY_W / 2
    drop = BACK_DROP if back else FRONT_DROP
    nl, nr = (cx - NECK_HW, 0), (cx + NECK_HW, 0)
    return _poly(cubic(nl, (nl[0] + 4, drop * 0.75), (cx - NECK_HW * 0.55, drop), (cx, drop), n),
                 cubic((cx, drop), (cx + NECK_HW * 0.55, drop), (nr[0] - 4, drop * 0.75), nr, n))


def sleeve():
    """Flat set-in sleeve, origin top-left, cap apex at (SLEEVE_W/2, 0)."""
    W, cx = SLEEVE_W, SLEEVE_W / 2
    a, b = (0, SLEEVE_CAP), (W, SLEEVE_CAP)
    cap = _poly(cubic(a, (60, SLEEVE_CAP - 20), (cx - 110, 0), (cx, 0)),
                cubic((cx, 0), (cx + 110, 0), (W - 60, SLEEVE_CAP - 20), b))
    hr, hl = (cx + SLEEVE_HEM_HW, SLEEVE_L), (cx - SLEEVE_HEM_HW, SLEEVE_L)
    return _poly(cap, np.array([b, hr]), cubic(hr, (cx + 60, SLEEVE_L + 4), (cx - 60, SLEEVE_L + 4), hl),
                 np.array([hl, a]))


def path_d(pts, ox=0, oy=0, close=True):
    s = "M" + " L".join(f"{x + ox:.2f},{y + oy:.2f}" for x, y in pts)
    return s + (" Z" if close else "")


def bbox(pts):
    return pts[:, 0].min(), pts[:, 1].min(), pts[:, 0].max(), pts[:, 1].max()
