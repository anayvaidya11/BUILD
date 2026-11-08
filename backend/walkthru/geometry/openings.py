"""Doors, cased openings, the front door and windows, in the real frame.

Door JSON (extends the contract's {"between", "x", "y", "width_ft"}):
    x, y         centre of the opening, on the wall line
    orientation  direction the WALL runs: "vertical" (constant x) or "horizontal" (constant y)
    kind         "door" (swing door), "opening" (cased opening, no leaf) or "front"
    swing_into   room the leaf swings into (None for openings)
    hinge        "min"/"max": hinge at the low-/high-coordinate end of the opening
The front door is {"between": ["exterior", <room>], "kind": "front"} and its centre equals
layout.entrance. Every opening's two ends sit on the 0.5 ft grid, inside the wall the two rooms
share (walls.ts cuts 0.5 ft wall units, and the checker's door_geometry rule needs the fit).
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Dict, List, Optional

import math

from .geom import EPS, GRID, Rect, exterior_edges, r2, shared_edge, snap, snap_down, snap_up
from .taxonomy import OPEN_PLAN, PUBLICNESS

EXTERIOR = "exterior"  # pseudo-room id for the front door (schema.EXTERIOR)
DOOR_W = 3.0       # 36" interior doors (rule minimum is 2'8")
FRONT_W = 3.0
DOOR_HEAD = 6.67   # 6'8" door head
OPENING_HEAD = 7.0

# type: (max windows, max per wall, width, sill, head)
WINDOW_SPEC = {
    "living": (3, 2, 5.0, 2.5, 7.0), "family": (3, 2, 5.0, 2.5, 7.0),
    "dining": (2, 2, 4.0, 2.5, 7.0), "kitchen": (2, 1, 4.0, 3.5, 7.0),
    "bedroom": (2, 1, 4.0, 2.5, 7.0), "office": (2, 1, 4.0, 2.5, 7.0),
    "other": (2, 1, 4.0, 2.5, 7.0), "mudroom": (1, 1, 3.0, 3.0, 7.0),
    "bathroom": (1, 1, 2.5, 4.5, 6.75), "half_bath": (1, 1, 2.0, 4.5, 6.75),
    "laundry": (1, 1, 2.5, 4.0, 6.75), "hallway": (1, 1, 3.0, 3.0, 7.0),
}


def _pub(t: str) -> int:
    return PUBLICNESS.get(t, 6)


@dataclass
class Roles:
    types: Dict[str, str]
    hall: Optional[str]
    entrance: str
    host: Dict[str, str]
    garage: Optional[str]
    dual: frozenset = frozenset()    # ensuites that also open onto the hall
    closed: frozenset = frozenset()  # rooms that get a narrow opening instead of open plan


class DoorPlanner:
    def __init__(self, rects: Dict[str, Rect], roles: Roles, focus):
        self.rects, self.roles, self.focus = rects, roles, focus
        self.types = roles.types
        ids = list(rects)
        self.adj = {}
        self.nbrs = {r: set() for r in ids}
        for i, a in enumerate(ids):
            ra = rects[a]
            for b in ids[i + 1:]:
                seg = shared_edge(ra, rects[b])
                if seg:
                    self.adj[(a, b)] = self.adj[(b, a)] = seg
                    self.nbrs[a].add(b)
                    self.nbrs[b].add(a)
        self.doors: List[dict] = []
        self.links = {r: set() for r in ids}

    def add(self, a: str, b: str, kind: str, max_w: float = 99.0) -> bool:
        if b in self.links[a]:
            return True
        seg = self.adj.get((a, b))
        if not seg:
            return False
        orient, c, s0, s1 = seg
        length = s1 - s0
        swing = hinge = None
        if kind == "opening":
            m = 1.0 if length >= 5.0 else (0.5 if length >= 4.0 else 0.0)
            width = float(math.floor(min(length - 2 * m, max_w) + EPS))  # whole feet: ends stay on grid
            if width < DOOR_W - EPS:
                return False
            start = s0 + m + snap_down((length - 2 * m - width) / 2)
            center = start + width / 2
        else:
            for m in (0.5, 0.0):
                if length >= DOOR_W + 2 * m - EPS:
                    break
            else:
                return False
            f = self.focus[1] if orient == "vertical" else self.focus[0]
            if abs(f - s0) <= abs(f - s1):
                center, hinge = s0 + m + DOOR_W / 2, "min"
            else:
                center, hinge = s1 - m - DOOR_W / 2, "max"
            width = DOOR_W
            swing = a if _pub(self.types[a]) > _pub(self.types[b]) else b
        x, y = (c, center) if orient == "vertical" else (center, c)
        self.doors.append({
            "between": [a, b], "x": r2(x), "y": r2(y), "width_ft": r2(width),
            "orientation": orient, "kind": kind, "swing_into": swing, "hinge": hinge,
        })
        self.links[a].add(b)
        self.links[b].add(a)
        return True

    def reach(self, start: str, blocked=()) -> set:
        seen, q = {start}, deque([start])
        while q:
            cur = q.popleft()
            if cur != start and cur in blocked:
                continue  # can enter, but not pass through
            for n in self.links[cur]:
                if n not in seen:
                    seen.add(n)
                    q.append(n)
        return seen

    def kind_for(self, a: str, b: str) -> str:
        ta, tb = self.types[a], self.types[b]
        circ = ("hallway",)
        if (ta in OPEN_PLAN or ta in circ) and (tb in OPEN_PLAN or tb in circ):
            return "opening"
        return "door"

    def repair(self, start: str) -> None:
        """Add doors until every room is reachable, routing through public rooms first."""
        while True:
            seen = self.reach(start)
            missing = [r for r in self.rects if r not in seen]
            if not missing:
                return
            done = False
            for u in sorted(missing, key=lambda r: (_pub(self.types[r]), r)):
                for n in sorted((n for n in self.nbrs[u] if n in seen),
                                key=lambda n: (_pub(self.types[n]), n)):
                    if self.add(u, n, self.kind_for(u, n)) or self.add(u, n, "door"):
                        done = True
                        break
                if done:
                    break
            if not done:
                return

    def repair_bathroom(self, start: str) -> None:
        """Make sure one full bathroom is reachable without passing through a bedroom."""
        baths = [r for r, t in self.types.items() if t == "bathroom"]
        if not baths:
            return
        bedrooms = {r for r, t in self.types.items() if t == "bedroom"}
        seen = self.reach(start, blocked=bedrooms)
        if any(b in seen for b in baths):
            return
        for b in baths:
            for n in sorted((n for n in self.nbrs[b] if n in seen and n not in bedrooms),
                            key=lambda n: (_pub(self.types[n]), n)):
                if self.add(b, n, "door"):
                    return


def plan_doors(rects: Dict[str, Rect], roles: Roles, W: float, D: float,
               entry_side: str, hint_pos: Optional[float]):
    """Returns (doors, entrance) where entrance = {"x","y","room","side"}."""
    T = roles.types
    er = rects[roles.entrance]
    edges = exterior_edges(er, W, D)
    edge = next((e for e in edges if e[0] == entry_side), None)
    if edge is None:  # shouldn't happen; fall back to the room's longest outside wall
        edge = max(edges, key=lambda e: e[4] - e[3]) if edges else ("south", "horizontal", er.y2, er.x, er.x2)
    side, orient, c, s0, s1 = edge
    target = (s0 + s1) / 2
    if hint_pos is not None:
        target = hint_pos * (W if orient == "horizontal" else D)
    lo, hi = s0 + 0.5 + FRONT_W / 2, s1 - 0.5 - FRONT_W / 2
    if lo > hi:
        lo = hi = s0 + FRONT_W / 2
    center = min(max(snap(target), lo), hi)
    fx, fy = (c, center) if orient == "vertical" else (center, c)
    entrance = {"x": r2(fx), "y": r2(fy), "room": roles.entrance, "side": side}

    P = DoorPlanner(rects, roles, (fx, fy))
    P.doors.append({
        "between": [EXTERIOR, roles.entrance], "x": r2(fx), "y": r2(fy), "width_ft": FRONT_W,
        "orientation": orient, "kind": "front", "swing_into": roles.entrance, "hinge": "min",
    })

    # Open plan: cased openings between public rooms and from the hallway into them.
    open_ids = [r for r in rects if T[r] in OPEN_PLAN]
    if roles.hall:
        for n in sorted(P.nbrs[roles.hall]):
            if T[n] in OPEN_PLAN:
                P.add(roles.hall, n, "opening")
    for i, a in enumerate(open_ids):
        for b in open_ids[i + 1:]:
            seg = P.adj.get((a, b))
            if seg and seg[3] - seg[2] >= 4.0:
                walled = a in roles.closed or b in roles.closed  # "formal dining": a 4 ft cased opening
                P.add(a, b, "opening", max_w=4.0 if walled else 99.0)

    for r in rects:
        t = T[r]
        if r == roles.hall or t in OPEN_PLAN:
            continue
        if r in roles.host:
            P.add(r, roles.host[r], "door")
            if r in roles.dual and roles.hall:
                P.add(r, roles.hall, "door")
            continue
        if roles.hall and roles.hall in P.nbrs[r] and P.add(r, roles.hall, "door"):
            continue
        for n in sorted(P.nbrs[r], key=lambda n: (_pub(T[n]), n)):
            if T[n] in OPEN_PLAN or (r == roles.garage and T[n] in ("mudroom", "laundry")):
                if P.add(r, n, "door"):
                    break

    P.repair(roles.entrance)
    P.repair_bathroom(roles.entrance)
    return P.doors, entrance


def plan_windows(rects: Dict[str, Rect], types: Dict[str, str], W: float, D: float,
                 doors: List[dict]) -> List[dict]:
    exterior_doors = []
    for d in doors:
        if d["kind"] == "front":
            ctr = d["y"] if d["orientation"] == "vertical" else d["x"]
            line = d["x"] if d["orientation"] == "vertical" else d["y"]
            exterior_doors.append((d["orientation"], line, ctr - d["width_ft"] / 2, ctr + d["width_ft"] / 2))
    windows = []
    for rid, r in rects.items():
        spec = WINDOW_SPEC.get(types[rid])
        if not spec:
            continue
        max_n, per_edge, width, sill, head = spec
        count = 0
        for side, orient, c, s0, s1 in sorted(exterior_edges(r, W, D), key=lambda e: -(e[4] - e[3])):
            if count >= max_n:
                break
            length = s1 - s0
            w = width if length >= width + 2.0 else snap_down(length - 2.0)
            if w < 2.0 - EPS:
                continue
            n = max(1, min(per_edge, max_n - count, int(length // (w + 2.0))))
            blocked = [(a - 0.75, b + 0.75) for o, ln, a, b in exterior_doors
                       if o == orient and abs(ln - c) < EPS and b > s0 and a < s1]
            placed = []
            for i in range(n):
                want = s0 + length * (i + 0.5) / n
                spot = _fit(want, w, s0 + 1.0, s1 - 1.0, blocked + placed)
                if spot is None:
                    continue
                a = spot - w / 2
                placed.append((a - 1.0, a + w + 1.0))
                x, y = (c, spot) if orient == "vertical" else (spot, c)
                start = r.y if orient == "vertical" else r.x
                windows.append({
                    "room": rid, "wall": side, "offset_ft": r2(a - start), "width_ft": r2(w),
                    "x": r2(x), "y": r2(y), "sill_ft": sill, "head_ft": head,
                })
                count += 1
    return windows


def _fit(want: float, w: float, lo: float, hi: float, blocked) -> Optional[float]:
    """Centre nearest `want` for a w-wide window inside [lo, hi] avoiding blocked spans."""
    free = [(snap_up(lo), snap_down(hi))]
    for a, b in sorted((snap_down(a), snap_up(b)) for a, b in blocked):
        nxt = []
        for f0, f1 in free:
            if b <= f0 or a >= f1:
                nxt.append((f0, f1))
            else:
                if a > f0:
                    nxt.append((f0, a))
                if b < f1:
                    nxt.append((b, f1))
        free = nxt
    best = None
    for f0, f1 in free:
        if f1 - f0 < w - EPS:
            continue
        start = min(max(snap(want - w / 2), f0), f1 - w)  # grid-aligned left end
        ctr = start + w / 2
        if best is None or abs(ctr - want) < abs(best - want):
            best = ctr
    return best
