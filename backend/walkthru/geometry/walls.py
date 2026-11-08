"""Deduplicated wall segments with their openings — what the 3D scene extrudes.

Each wall is a centre-line segment between exactly one pair of rooms (or one
room and the outside). Rooms are measured to wall centre lines, so the 3D side
can give walls any thickness it likes (thickness_ft is a suggestion).

    {"id": "w12", "x1": 15, "y1": 0, "x2": 15, "y2": 12,
     "orientation": "vertical", "exterior": false, "rooms": ["kitchen", "dining"],
     "thickness_ft": 0.375,
     "openings": [{"type": "door", "door": 3, "offset_ft": 1.5, "width_ft": 3,
                   "sill_ft": 0, "head_ft": 6.67}]}

offset_ft is measured from (x1, y1); x1 <= x2 and y1 <= y2 always.
"""
from __future__ import annotations

from typing import Dict, List

from .geom import EPS, Rect, r2
from .openings import DOOR_HEAD, OPENING_HEAD

EXTERIOR_T = 0.5
INTERIOR_T = 0.375


def _segments(rects: Dict[str, Rect], horizontal: bool):
    out = []
    lines = sorted({round(r.y if horizontal else r.x, 6) for r in rects.values()}
                   | {round(r.y2 if horizontal else r.x2, 6) for r in rects.values()})
    for line in lines:
        if horizontal:
            before = [(k, r.x, r.x2) for k, r in rects.items() if abs(r.y2 - line) < EPS]  # north side
            after = [(k, r.x, r.x2) for k, r in rects.items() if abs(r.y - line) < EPS]    # south side
        else:
            before = [(k, r.y, r.y2) for k, r in rects.items() if abs(r.x2 - line) < EPS]  # west side
            after = [(k, r.y, r.y2) for k, r in rects.items() if abs(r.x - line) < EPS]    # east side
        cuts = sorted({round(v, 6) for _, a, b in before + after for v in (a, b)})
        segs = []
        for a, b in zip(cuts, cuts[1:]):
            if b - a < EPS:
                continue
            mid = (a + b) / 2
            p = next((k for k, s0, s1 in before if s0 < mid < s1), None)
            q = next((k for k, s0, s1 in after if s0 < mid < s1), None)
            if p is None and q is None:
                continue
            if segs and segs[-1][2] == (p, q) and abs(segs[-1][1] - a) < EPS:
                segs[-1][1] = b
            else:
                segs.append([a, b, (p, q)])
        for a, b, (p, q) in segs:
            out.append((line, a, b, p, q))
    return out


def build_walls(rects: Dict[str, Rect], doors: List[dict], windows: List[dict]) -> List[dict]:
    walls = []
    for horizontal in (True, False):
        for line, a, b, p, q in _segments(rects, horizontal):
            ext = p is None or q is None
            x1, y1, x2, y2 = (a, line, b, line) if horizontal else (line, a, line, b)
            walls.append({
                "id": f"w{len(walls)}", "x1": r2(x1), "y1": r2(y1), "x2": r2(x2), "y2": r2(y2),
                "orientation": "horizontal" if horizontal else "vertical",
                "exterior": ext, "rooms": [k for k in (p, q) if k is not None],
                "thickness_ft": EXTERIOR_T if ext else INTERIOR_T, "openings": [],
            })

    def attach(orient, line, ctr, width, entry):
        lo, hi = ctr - width / 2, ctr + width / 2
        for w in walls:
            if w["orientation"] != orient:
                continue
            wl = w["x1"] if orient == "vertical" else w["y1"]
            w0, w1 = (w["y1"], w["y2"]) if orient == "vertical" else (w["x1"], w["x2"])
            if abs(wl - line) < 1e-3 and lo >= w0 - 1e-3 and hi <= w1 + 1e-3:
                entry["offset_ft"] = r2(lo - w0)
                w["openings"].append(entry)
                return True
        return False

    for i, d in enumerate(doors):
        vert = d["orientation"] == "vertical"
        head = OPENING_HEAD if d["kind"] == "opening" else DOOR_HEAD
        attach(d["orientation"], d["x"] if vert else d["y"], d["y"] if vert else d["x"], d["width_ft"],
               {"type": d["kind"], "door": i, "width_ft": d["width_ft"], "sill_ft": 0.0, "head_ft": head})
    for i, wn in enumerate(windows):
        vert = wn["wall"] in ("east", "west")
        orient = "vertical" if vert else "horizontal"
        attach(orient, wn["x"] if vert else wn["y"], wn["y"] if vert else wn["x"], wn["width_ft"],
               {"type": "window", "window": i, "width_ft": wn["width_ft"],
                "sill_ft": wn["sill_ft"], "head_ft": wn["head_ft"]})
    for w in walls:
        w["openings"].sort(key=lambda o: o["offset_ft"])
    return walls
