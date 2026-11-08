"""Arrangements (which room goes where, topologically) and their exact geometry.

Everything here works in a *canonical frame*; transform.py maps it to the
real footprint. In the canonical frame u runs along the hallway (0..L) and v
runs across it (0..H):

    v=0  +--------------+-------------------------------+--------+
         |  back row    |  north band  | col | col | ...|        |
         | (kitchen,    |-------------------------------| garage |
         |  dining)     |  hallway (hall_width deep)    | (opt.) |
         |--------------|-------------------------------|        |
         |  front row   |  south band  | col | col | ...|        |
         | (living,     |                               |        |
    v=H  +--foyer)------+-------------------------------+--------+
         u=0          u=Wp                                      u=L

Every band column spans the full band depth, so each column room touches
both the hallway (door) and an exterior wall (window). A column may stack
two rooms; then only the hall-side one needs a hallway door and the
exterior-side one is reached through its host in the neighbouring column
(ensuite bath, walk-in closet).
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Dict, List, Optional, Tuple

from .geom import EPS, GRID, Rect, snap, snap_down, snap_up
from .program import Program
from .taxonomy import MAX_ASPECT, SMALL_STACKABLE, WEIGHT

DOOR_FIT = 3.5   # shortest wall that fits a 3 ft door plus jambs (public rows)
HALL_DOOR_FIT = 3.0  # band column facing the hall: a 3 ft door may fill the whole wall
MIN_STRIP = 2.0  # thinnest carved closet/pantry


def aspect_pen(rtype: str, w: float, h: float) -> float:
    lo, hi = min(w, h), max(w, h)
    if lo <= EPS:
        return 1e3
    return WEIGHT[rtype] * max(0.0, hi / lo - MAX_ASPECT[rtype]) ** 2


# ---------------------------------------------------------------- units

@dataclass
class Unit:
    """A host room plus the columns that must stay next to it (west -> east)."""
    host: str
    columns: List[List[str]]
    rank: int
    area: float


def room_rank(prog: Program, rid: str) -> int:
    """Privacy order along a band: low ranks sit near the public block."""
    t = prog.rooms[rid].type
    if t in ("mudroom", "laundry", "closet", "pantry"):
        return 0
    if t == "half_bath":
        return 1
    if t in ("office", "other"):
        return 2
    if t == "bathroom":
        return 3
    if t == "bedroom":
        return 5 if rid == prog.primary_id else 4
    return 2


def column_pen(prog: Program, col: List[str], d: float) -> float:
    total = sum(prog.rooms[r].target for r in col)
    w = total / d
    return sum(aspect_pen(prog.rooms[r].type, w, d * prog.rooms[r].target / total) for r in col)


def make_units(prog: Program, d0: float, exclude=frozenset()) -> List[Unit]:
    R = prog.rooms
    corridor = [r for r in prog.ids("corridor") if r not in exclude]
    pool = [r for r in corridor if not R[r].children and R[r].type != "bedroom"
            and (R[r].type in SMALL_STACKABLE or R[r].target < 60)]  # e.g. an "office nook"
    used = set()
    units: List[Unit] = []
    for h in sorted((r for r in corridor if R[r].children), key=lambda r: -R[r].target):
        kids = sorted(R[h].children, key=lambda c: (R[c].type != "bathroom", -R[c].target))[:2]
        # Every kid column must touch the host column: [kid] [host] or [kid] [host] [kid].
        sep = [[kids[0]], [h]] + ([[kids[1]]] if len(kids) == 2 else [])
        options = [(sum(column_pen(prog, [c], d0) for c in kids), sep, None)]
        if any(R[c].dual for c in kids):
            pass  # a shared ensuite must reach the hall: full-depth column only
        elif len(kids) == 2:
            # stacked suite (bath over closet) keeps the bedroom on the corner; prefer it on near-ties
            options.append((column_pen(prog, kids, d0) - 0.25, [kids, [h]], None))
        else:
            for s in pool:
                if s in used:
                    continue
                # Stacking s under the kid removes s's own column, so credit its penalty back.
                pen = column_pen(prog, [kids[0], s], d0) + 0.3 - column_pen(prog, [s], d0)
                options.append((pen, [[kids[0], s], [h]], s))
        pen, cols, borrowed = min(options, key=lambda o: o[0])
        if borrowed:
            used.add(borrowed)
        area = sum(R[r].target for c in cols for r in c)
        units.append(Unit(host=h, columns=cols, rank=room_rank(prog, h), area=area))
    for r in corridor:
        if r in used or R[r].children:
            continue
        units.append(Unit(host=r, columns=[[r]], rank=room_rank(prog, r), area=R[r].target))
    return units


def band_order(units: List[Unit]) -> List[Unit]:
    return sorted(units, key=lambda u: (u.rank, u.area, u.host))


def band_assignments(prog: Program, units: List[Unit], H: float, hw: float, keep: int = 8,
                     seams: Tuple[float, ...] = ()):
    """Best few ways to split units between the north and south bands.

    `seams` are the public block's row seams (one per public-row variant). The hallway has to
    open onto a single public room, so a split whose hallway straddles every seam would need
    rooms resized to line up; those splits are penalised so the full evaluation sees ones
    that can line up."""
    k = len(units)
    if k == 0:
        return [([], [])]

    def prescore(north, south):
        an, as_ = sum(u.area for u in north), sum(u.area for u in south)
        if an > 0 and as_ > 0:
            dn = (H - hw) * an / (an + as_)
            ds = H - hw - dn
        else:
            dn = ds = H - hw
        pen = 0.0 if (north and south) else 2.0
        if seams and north and south:
            shift = min(0.0 if (dn >= c or dn + hw <= c) else min(dn + hw - c, c - dn) for c in seams)
            pen += 300.0 * (shift / max(min(dn, ds), 1.0) / 2) ** 2  # shift is shared by rows and bands
        for band, d in ((north, dn), (south, ds)):
            if not band:
                continue
            pen += 0.5 * max(0.0, 10.0 - d) ** 2 + 0.3 * max(0.0, d - 15.5) ** 2
            for u in band:
                for col in u.columns:
                    pen += column_pen(prog, col, d)
        return pen

    scored = []
    if k <= 12:
        for mask in range(1 << k):
            north = [u for i, u in enumerate(units) if mask >> i & 1]
            south = [u for i, u in enumerate(units) if not mask >> i & 1]
            scored.append((prescore(north, south), mask, north, south))
    else:  # greedy balance by area, then single-unit moves
        north, south = [], []
        for u in sorted(units, key=lambda u: -u.area):
            (north if sum(x.area for x in north) <= sum(x.area for x in south) else south).append(u)
        scored.append((prescore(north, south), 0, north, south))
        for i, u in enumerate(units):
            n2 = [x for x in north if x is not u] + ([] if u in north else [u])
            s2 = [x for x in units if x not in n2]
            scored.append((prescore(n2, s2), i + 1, n2, s2))
    scored.sort(key=lambda s: (s[0], s[1]))
    return [(band_order(n), band_order(s)) for _, _, n, s in scored[:keep]]


# ---------------------------------------------------------------- arrangement

@dataclass
class Arrangement:
    H: float
    hall_width: float
    entry_face: str = "south"           # canonical face holding the front door: "south" or "west"
    back: List[str] = field(default_factory=list)    # public back row, west -> east
    front: List[str] = field(default_factory=list)   # public front row, west -> east
    north: List[List[str]] = field(default_factory=list)  # band columns, each [exterior, ..., hall side]
    south: List[List[str]] = field(default_factory=list)
    stack: List[str] = field(default_factory=list)   # no-hallway mode: rooms stacked north -> south
    hall_end: List[str] = field(default_factory=list)  # tiny rooms carved from the hallway's dead end
    garage: Optional[str] = None
    swap: bool = False
    flip_u: bool = False
    flip_v: bool = False
    hall_at: Optional[List[float]] = None  # edits: [v, length] keeps the hallway (and private wing) as-is

    @property
    def hall(self) -> bool:
        return bool(self.north or self.south)

    def to_json(self) -> dict:
        return asdict(self)

    @staticmethod
    def from_json(d) -> Optional["Arrangement"]:
        if not isinstance(d, dict):
            return None
        try:
            return Arrangement(
                H=float(d["H"]), hall_width=float(d["hall_width"]),
                entry_face=str(d.get("entry_face", "south")),
                back=list(d.get("back", [])), front=list(d.get("front", [])),
                north=[list(c) for c in d.get("north", [])], south=[list(c) for c in d.get("south", [])],
                stack=list(d.get("stack", [])), garage=d.get("garage"), hall_end=list(d.get("hall_end", [])),
                swap=bool(d.get("swap")), flip_u=bool(d.get("flip_u")), flip_v=bool(d.get("flip_v")),
            )
        except (KeyError, TypeError, ValueError):
            return None


def needed_length(arr: Arrangement, prog: Program, k: float = 1.0) -> float:
    """Footprint length L that fits every room at scale k with no slack."""
    R = prog.rooms
    H, hw = arr.H, arr.hall_width

    def carved(r):
        return (R[r].target + sum(R[c].target for c in R[r].children)) * k

    a_pub = sum(carved(r) for r in arr.back + arr.front)
    a_gar = carved(arr.garage) if arr.garage else 0.0
    a_band = sum(R[r].target * k for col in arr.north + arr.south for r in col)
    a_stack = sum(R[r].target * k for r in arr.stack)
    if arr.hall:
        return (a_pub + a_gar) / H + a_band / (H - hw)
    return (a_pub + a_gar + a_stack) / H


# ---------------------------------------------------------------- geometry

def water_fill(total: float, weights: List[float], mins: List[float]) -> List[float]:
    n = len(weights)
    if sum(mins) > total:
        f = total / sum(mins)
        mins = [m * f for m in mins]
    fixed: List[Optional[float]] = [None] * n
    while True:
        free = [i for i in range(n) if fixed[i] is None]
        if not free:
            break
        rem = total - sum(f for f in fixed if f is not None)
        wsum = sum(weights[i] for i in free)
        grew = False
        for i in free:
            li = rem * weights[i] / wsum if wsum > 0 else rem / len(free)
            if li < mins[i] - 1e-9:
                fixed[i] = mins[i]
                grew = True
        if not grew:
            break
    free = [i for i in range(n) if fixed[i] is None]
    rem = total - sum(f for f in fixed if f is not None)
    wsum = sum(weights[i] for i in free) or 1.0
    return [fixed[i] if fixed[i] is not None else rem * weights[i] / wsum for i in range(n)]


def split(a: float, b: float, weights: List[float], mins: List[float]) -> List[float]:
    """Cut [a, b] (both on the grid) into consecutive pieces proportional to weights.

    Each cut goes to the grid line below or above its exact position; a small DP picks
    the combination with the smallest worst-case relative error, so a 40 sq ft closet
    isn't sacrificed to keep a 300 sq ft living room exact.
    """
    n = len(weights)
    if n == 0:
        return [a]
    if n == 1:
        return [a, b]
    lengths = water_fill(b - a, weights, mins)
    targets, acc = [], a
    for ln in lengths[:-1]:
        acc += ln
        targets.append(acc)

    def cost(i, p0, p1):
        ln = p1 - p0
        if ln < GRID - EPS:
            return 1e9
        c = abs(ln - lengths[i]) / max(lengths[i], EPS)
        return c + (1.0 if ln < mins[i] - EPS else 0.0)

    layers = []
    prev = {a: (0.0, 0.0, None)}
    for j, t in enumerate(targets):
        cur = {}
        for p in sorted({snap_down(t), snap_up(t)}):
            best = None
            for q, (mx, sm, _) in prev.items():
                c = cost(j, q, p)
                val = (max(mx, c), sm + c, q)
                if best is None or val[:2] < best[:2]:
                    best = val
            cur[p] = best
        layers.append(cur)
        prev = cur
    end = min(((max(mx, cost(n - 1, q, b)), sm + cost(n - 1, q, b), q) for q, (mx, sm, _) in prev.items()),
              key=lambda v: v[:2])
    bounds, q = [b], end[2]
    for j in range(n - 2, -1, -1):
        bounds.append(q)
        q = layers[j][q][2]
    bounds.append(a)
    return bounds[::-1]


def _align(c: float, dn: float, H: float, hw: float, two_bands: bool) -> Tuple[float, float]:
    """Move the public row seam (c) and/or hallway (dn) so the hallway's end
    lands entirely on one public room. Spreads the shift so the relative size
    change is equal on both sides."""
    if dn >= c - EPS or dn + hw <= c + EPS:
        return c, dn
    P = max(min(c, H - c), 1.0)
    options = []
    for target, hall_top in ((dn, 0.0), (dn + hw, hw)):  # seam at hallway top / bottom
        if two_bands:
            B = max(min(dn, H - hw - dn), 1.0)
            x = c + (target - c) * P / (P + B)
        else:
            x = target  # a single band can't move: the hallway is pinned to the edge
        options.append((abs(x - c) / P, x, x - hall_top))
    _, c2, dn2 = min(options)
    return c2, dn2


def _carve(rects: Dict[str, Rect], prog: Program, host: str, kids: List[str],
           protect: set, L: float, H: float, k: float) -> bool:
    """Cut each kid out of the host's rectangle as a strip along one side."""
    R = rects[host]
    htype = prog.rooms[host].type
    for kid in kids:
        a = prog.rooms[kid].target * k
        best = None
        for side in ("north", "south", "west", "east"):
            if side in protect:
                continue
            horiz = side in ("north", "south")
            t = max(MIN_STRIP, snap(a / (R.w if horiz else R.h)))
            if (R.h if horiz else R.w) - t < 5.0:
                continue
            if side == "north":
                kr, nr = Rect(R.x, R.y, R.w, t), Rect(R.x, R.y + t, R.w, R.h - t)
                ext = R.y < EPS
            elif side == "south":
                kr, nr = Rect(R.x, R.y2 - t, R.w, t), Rect(R.x, R.y, R.w, R.h - t)
                ext = abs(R.y2 - H) < EPS
            elif side == "west":
                kr, nr = Rect(R.x, R.y, t, R.h), Rect(R.x + t, R.y, R.w - t, R.h)
                ext = R.x < EPS
            else:
                kr, nr = Rect(R.x2 - t, R.y, t, R.h), Rect(R.x, R.y, R.w - t, R.h)
                ext = abs(R.x2 - L) < EPS
            s = (aspect_pen(prog.rooms[kid].type, kr.w, kr.h) + aspect_pen(htype, nr.w, nr.h)
                 + (0.0 if ext else 0.5))
            if best is None or s < best[0]:
                best = (s, kr, nr)
        if best is None:
            return False
        rects[kid], R = best[1], best[2]
    rects[host] = R
    return True


def _band(rects, prog: Program, cols, areas, u0, u1, v0, v1, ext_first: bool, k: float):
    if not cols:
        return
    mins = [HALL_DOOR_FIT if prog.rooms[col[-1]].zone == "corridor" else 2.0 for col in cols]
    b = split(u0, u1, areas, mins)
    for i, col in enumerate(cols):
        x0, x1 = b[i], b[i + 1]
        if len(col) == 1:
            rects[col[0]] = Rect(x0, v0, x1 - x0, v1 - v0)
            continue
        seq = col if ext_first else list(reversed(col))  # north->south order
        vb = split(v0, v1, [prog.rooms[r].target * k for r in seq], [3.0] * len(seq))
        for j, rid in enumerate(seq):
            rects[rid] = Rect(x0, vb[j], x1 - x0, vb[j + 1] - vb[j])


def build(arr: Arrangement, prog: Program, L: float, k: float = 1.0):
    """Exact canonical rectangles for an arrangement in an L x arr.H frame.

    Returns (rects, info) or None if the arrangement can't fit.
    """
    R = prog.rooms
    H, hw = arr.H, arr.hall_width

    def A(r):
        return R[r].target * k

    def carved(r):
        return A(r) + sum(A(c) for c in R[r].children)

    back_a = [carved(r) for r in arr.back]
    front_a = [carved(r) for r in arr.front]
    a_back, a_front = sum(back_a), sum(front_a)
    a_pub = a_back + a_front
    a_gar = carved(arr.garage) if arr.garage else 0.0
    n_a = [sum(A(r) for r in col) for col in arr.north]
    s_a = [sum(A(r) for r in col) for col in arr.south]
    a_n, a_s = sum(n_a), sum(s_a)
    st_a = [A(r) for r in arr.stack]
    hall = arr.hall
    if hall and H - hw < 6.0:
        return None
    need = needed_length(arr, prog, k)
    if need <= EPS:
        return None
    f = L / need
    has_cor = hall or bool(arr.stack)
    two_bands = a_n > 0 and a_s > 0
    bands = H - hw

    # Exact (unsnapped) cut positions.
    wp_x = a_pub / H * f if a_pub > 0 else 0.0
    wg = snap(a_gar / H * f) if a_gar > 0 else 0.0
    c_x = H * a_back / a_pub if (arr.back and arr.front) else (H if arr.back else 0.0)
    dn_x = 0.0
    if hall:
        dn_x = bands * a_n / (a_n + a_s) if two_bands else (bands if a_n > 0 else 0.0)
        if arr.hall_at is not None:
            dn_x = arr.hall_at[0]
        if wp_x > 0 and arr.back and arr.front:
            # When pinned, only the public rows move to meet the hallway.
            c_x, dn_x = _align(c_x, dn_x, H, hw, two_bands and arr.hall_at is None)

    def opts(v, lo, hi, free):
        if not free:
            return [v]
        return sorted({min(max(x, lo), hi) for x in (snap_down(v), snap_up(v))})

    need_align = hall and wp_x > 0 and bool(arr.back and arr.front)
    best = None
    if not has_cor:
        wp_opts = [L - wg if a_pub > 0 else 0.0]
    elif arr.hall_at is not None and wp_x > 0 and L - wg - arr.hall_at[1] >= GRID:
        wp_opts = [L - wg - arr.hall_at[1]]  # the public block absorbs the whole edit
    else:
        wp_opts = opts(wp_x, GRID, L - wg - DOOR_FIT, wp_x > 0)
    for Wp in wp_opts:
        for c in opts(c_x, 4.0, H - 4.0, bool(arr.back and arr.front)):
            for dn in opts(dn_x, 4.0, bands - 4.0, hall and two_bands and arr.hall_at is None):
                if hall and not two_bands:
                    dn = snap(dn_x)
                if need_align and not (dn >= c - EPS or dn + hw <= c + EPS):
                    continue
                res = _make(arr, prog, L, k, Wp, wg, c, dn)
                if res is None:
                    continue
                rects = res[0]
                errs = [abs(rects[r].area - prog.rooms[r].target * k) / (prog.rooms[r].target * k)
                        for r in prog.order if r in rects]
                key = (round(max(errs, default=0.0), 4), sum(e * e for e in errs))
                if best is None or key < best[0]:
                    best = (key, res)
    return best[1] if best else None


def _make(arr: Arrangement, prog: Program, L: float, k: float, Wp: float, Wg: float,
          c: float, dn: float):
    R = prog.rooms
    H, hw = arr.H, arr.hall_width
    hall = arr.hall
    has_cor = hall or bool(arr.stack)
    Lc = L - Wp - Wg if has_cor else 0.0
    if has_cor and Lc < HALL_DOOR_FIT - EPS:
        return None

    def A(r):
        return R[r].target * k

    def carved(r):
        return A(r) + sum(A(ch) for ch in R[r].children)

    rects: Dict[str, Rect] = {}

    def row(ids, v0, v1):
        b = split(0.0, Wp, [carved(r) for r in ids], [HALL_DOOR_FIT] * len(ids))
        for i, rid in enumerate(ids):
            rects[rid] = Rect(b[i], v0, b[i + 1] - b[i], v1 - v0)

    if arr.back:
        row(arr.back, 0.0, c if arr.front else H)
    if arr.front:
        row(arr.front, c if arr.back else 0.0, H)

    u0, u1 = Wp, Wp + Lc
    if hall:
        end = u1
        for rid in arr.hall_end:  # powder room / linen closet at the hall's dead end, door up the hall
            t = max(2.5, snap(A(rid) / hw))
            end -= t
            rects[rid] = Rect(end, dn, t, hw)
        if end - u0 < 4.0:
            return None
        rects[prog.hall_id] = Rect(u0, dn, end - u0, hw)
        _band(rects, prog, arr.north, [sum(A(r) for r in col) for col in arr.north], u0, u1, 0.0, dn, True, k)
        _band(rects, prog, arr.south, [sum(A(r) for r in col) for col in arr.south], u0, u1, dn + hw, H, False, k)
    elif arr.stack:
        b = split(0.0, H, [A(r) for r in arr.stack], [DOOR_FIT] * len(arr.stack))
        for i, rid in enumerate(arr.stack):
            rects[rid] = Rect(u0, b[i], Lc, b[i + 1] - b[i])
    if arr.garage:
        rects[arr.garage] = Rect(L - Wg, 0.0, Wg, H)
    if any(r.w < GRID - EPS or r.h < GRID - EPS for r in rects.values()):
        return None

    # Which public room the hallway opens into, and which one holds the front door.
    hall_conn = None
    if hall and Wp > 0:
        for rid in arr.back + arr.front:
            r = rects[rid]
            if abs(r.x2 - Wp) < EPS and r.y <= dn + EPS and r.y2 >= dn + hw - EPS:
                hall_conn = rid
    entrance = entrance_room(arr, prog)

    for host in arr.back + arr.front + ([arr.garage] if arr.garage else []):
        kids = R[host].children
        if not kids:
            continue
        protect = set()
        if host == entrance:
            protect.add(arr.entry_face)
        if host == hall_conn:
            protect.add("east")
        if host == arr.garage:
            protect.add("west")
        if R[host].type == "kitchen":
            protect.add("south" if host in arr.back else "north")
        if not _carve(rects, prog, host, kids, protect, L, H, k):
            return None

    info = {"Wp": Wp, "Lc": Lc, "Wg": Wg, "c": c, "dn": dn, "hall_conn": hall_conn, "entrance": entrance}
    return rects, info


def entrance_room(arr: Arrangement, prog: Program) -> Optional[str]:
    """Room that holds the front door."""
    if arr.front:
        foyer = [r for r in arr.front if prog.rooms[r].zone == "foyer"]
        if foyer:
            return foyer[0]
        if arr.entry_face == "west":
            return arr.front[0]
        livings = [r for r in arr.front if prog.rooms[r].type == "living"] or \
                  [r for r in arr.front if prog.rooms[r].type == "family"]
        if livings:
            return max(livings, key=lambda r: prog.rooms[r].target)
        return max(arr.front, key=lambda r: prog.rooms[r].target)
    if arr.back:
        return arr.back[0]
    if arr.hall:
        return prog.hall_id
    if arr.stack:
        return arr.stack[-1]
    return arr.garage
