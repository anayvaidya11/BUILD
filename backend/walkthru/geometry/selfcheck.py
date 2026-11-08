"""The solver's own pass over the rule list, run on a finished layout dict.

The solver uses this to choose between candidate layouts, so it mirrors
walkthru/checker.py (role 3) rule for rule, with the same rule ids, plus the
`door_geometry` rule from backend/eval/ROLE2_HANDOFF.md: every door names two
valid endpoints, lies on their shared wall (or the footprint boundary for the
front door), fits entirely inside it, the front door matches layout.entrance,
and a misplaced door doesn't count toward reachability.

It reads plain dicts (no pydantic), so it is cheap enough to run on every candidate.
"""
from __future__ import annotations

import math
from collections import deque
from typing import Dict, List

from .geom import Rect, exterior_edges, intersection_area, shared_edge

EXTERIOR = "exterior"
TOL = 0.01                 # same tolerance as checker.EPS
MIN_DOOR_FT = 2.67
MIN_HALL_FT = 3.0
SIZE_TOL = 0.10
BEDROOMS = ("bedroom", "primary_bedroom")


def _door_fits(d: dict, rects: Dict[str, Rect], W: float, D: float) -> str:
    """'' if the door sits on its wall and fits inside it, else what's wrong."""
    between = d.get("between") or []
    if len(between) != 2 or between[0] == between[1]:
        return "must name two different rooms"
    a, b = between
    for r in (a, b):
        if r != EXTERIOR and r not in rects:
            return f"names unknown room '{r}'"
    half = d["width_ft"] / 2
    if EXTERIOR in (a, b):
        room = b if a == EXTERIOR else a
        segs = [(o, c, s0, s1) for _, o, c, s0, s1 in exterior_edges(rects[room], W, D)]
    else:
        seg = shared_edge(rects[a], rects[b])
        if seg is None:
            return "joins rooms that don't share a wall"
        segs = [seg]
    for o, c, s0, s1 in segs:
        line, ctr = (d["x"], d["y"]) if o == "vertical" else (d["y"], d["x"])
        if abs(line - c) <= TOL and s0 - TOL <= ctr - half and ctr + half <= s1 + TOL:
            return ""
    return "isn't centered on, or doesn't fit inside, their shared wall"


def selfcheck(layout: dict) -> List[dict]:
    W = float(layout["footprint"]["width_ft"])
    D = float(layout["footprint"]["depth_ft"])
    rooms = layout["rooms"]
    rects: Dict[str, Rect] = {r["id"]: Rect(r["x"], r["y"], r["w"], r["h"]) for r in rooms}
    types = {r["id"]: r.get("type") for r in rooms}
    names = {r["id"]: r.get("name") or r["id"] for r in rooms}
    names[EXTERIOR] = "outside"
    doors = layout.get("doors", [])
    checks: List[dict] = []

    def add(rule: str, errs: List[str]) -> None:
        checks.append({"rule": rule, "pass": not errs, "message": "; ".join(errs)})

    errs = []
    if len(rooms) != len(rects):
        errs.append("Room IDs must be unique")
    vals = [("footprint width", W), ("footprint depth", D)]
    for r in rooms:
        vals += [(f"{names[r['id']]} {f}", float(r[f])) for f in ("x", "y", "w", "h")]
    errs += [f"{n} must be finite and on the 0.5 ft grid" for n, v in vals
             if not math.isfinite(v) or abs(v / 0.5 - round(v / 0.5)) > TOL]
    add("contract_integrity", errs)

    errs = []
    ids = list(rects)
    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            ov = intersection_area(rects[a], rects[b])
            if ov > TOL:
                errs.append(f"{names[a]} and {names[b]} overlap by {ov:.0f} sq ft")
        r = rects[a]
        if r.x < -TOL or r.y < -TOL or r.x2 > W + TOL or r.y2 > D + TOL or r.w <= 0 or r.h <= 0:
            errs.append(f"{names[a]} extends outside the {W:g}x{D:g} ft footprint")
    missing = W * D - sum(r.area for r in rects.values())
    if missing > TOL:
        errs.append(f"Rooms leave {missing:.1f} sq ft of the footprint uncovered")
    add("no_overlap_in_footprint", errs)

    good, door_errs = [], []
    ent = layout.get("entrance") or {}
    fronts = [d for d in doors if EXTERIOR in (d.get("between") or [])]
    for d in doors:
        why = _door_fits(d, rects, W, D)
        if why:
            label = " and ".join(names.get(x, x) for x in (d.get("between") or []))
            door_errs.append(f"Door between {label} {why}")
        else:
            good.append(d)
    if not fronts:
        door_errs.append("There is no front door")
    elif not any(abs(d["x"] - ent.get("x", -1e9)) <= TOL and abs(d["y"] - ent.get("y", -1e9)) <= TOL
                 for d in fronts):
        door_errs.append("The front door doesn't match layout.entrance")

    graph = {k: set() for k in rects}
    graph[EXTERIOR] = set()
    for d in good:
        a, b = d["between"]
        graph[a].add(b)
        graph[b].add(a)

    def reach(blocked=()):
        seen, q = {EXTERIOR}, deque([EXTERIOR])
        while q:
            for n in graph[q.popleft()]:
                if n not in seen:
                    seen.add(n)
                    if n not in blocked:
                        q.append(n)
        return seen

    seen = reach()
    reach_errs = [f"{names[k]} can't be reached from the front door" for k in rects if k not in seen]
    if not fronts:
        reach_errs = ["The house has no front door"]
    add("all_rooms_reachable", reach_errs)

    errs_bed = []
    for k in rects:
        if types[k] in BEDROOMS:
            if not exterior_edges(rects[k], W, D):
                errs_bed.append(f"{names[k]} has no exterior wall (needs one for a window)")
            if not graph[k]:
                errs_bed.append(f"{names[k]} has no door")
    add("bedroom_exterior_wall", errs_bed)

    baths = [k for k in rects if types[k] == "bathroom"]
    bedroom_ids = {k for k in rects if types[k] in BEDROOMS}
    if not baths:
        add("public_bathroom", ["There is no bathroom"])
    else:
        free = reach(blocked=bedroom_ids)
        ok = any(b in free and not graph[b] <= bedroom_ids for b in baths)
        add("public_bathroom", [] if ok else
            ["Every bathroom is only reachable through a bedroom; add one off a hall or common room"])

    social = [k for k in rects if types[k] in ("dining", "living")]

    def wall(a, b):
        seg = shared_edge(rects[a], rects[b])
        return seg[3] - seg[2] if seg else 0.0

    add("kitchen_adjacent", [f"{names[k]} does not share a wall with the dining or living area"
                             for k in rects if types[k] == "kitchen"
                             and not any(wall(k, s) >= 3 for s in social)])

    errs = [f"{names[k]} is {min(rects[k].w, rects[k].h):.1f} ft wide; hallways need at least 3 ft"
            for k in rects if types[k] == "hall" and min(rects[k].w, rects[k].h) < MIN_HALL_FT - TOL]
    errs += [f"Door between {' and '.join(d['between'])} is {d['width_ft']:.2f} ft; doors need at least 2'8\""
             for d in doors if d["width_ft"] < MIN_DOOR_FT - TOL]
    add("min_hall_and_door_width", errs)

    errs = []
    for r in rooms:
        t = r.get("target_sqft") or 0
        if types[r["id"]] == "hall" or t <= 0:
            continue
        area = r["w"] * r["h"]
        if abs(area - t) / t > SIZE_TOL:
            errs.append(f"{names[r['id']]} is {area:.0f} sq ft but was asked to be {t:.0f} (more than 10% off)")
    req = layout.get("requested_sqft")
    if req:
        total = W * D
        if abs(total - req) / req > SIZE_TOL:
            errs.append(f"House is {total:.0f} sq ft but {req:.0f} was requested (more than 10% off)")
    add("sizes_within_10pct", errs)

    add("door_geometry", door_errs)
    return checks


def failures(checks: List[dict]) -> List[dict]:
    return [c for c in checks if not c["pass"]]
