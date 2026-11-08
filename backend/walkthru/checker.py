"""Role 3: rule checker. Layout -> list[Check] with plain-English messages.

Each rule is a function (layout) -> list of failure messages (empty = pass).
Add a rule: write the function, add it to RULES. Messages are fed straight back to
Claude, so name the room and say what is wrong and by how much.
"""

from __future__ import annotations

from collections import deque
import math
from typing import Callable

from .schema import EXTERIOR, Check, Layout, Room

EPS = 0.01
MIN_HALL_W = 3.0
MIN_DOOR_W = 2.67
SIZE_TOL = 0.10
BEDROOMS = {"bedroom", "primary_bedroom"}
GRID = 0.5


# ---------- geometry helpers ----------


def _overlap_area(a: Room, b: Room) -> float:
    dx = min(a.x + a.w, b.x + b.w) - max(a.x, b.x)
    dy = min(a.y + a.h, b.y + b.h) - max(a.y, b.y)
    return max(dx, 0) * max(dy, 0)


def shared_wall(a: Room, b: Room) -> float:
    """Length of wall the two rooms share (0 if they don't touch)."""
    if abs(a.x + a.w - b.x) < EPS or abs(b.x + b.w - a.x) < EPS:
        return max(0.0, min(a.y + a.h, b.y + b.h) - max(a.y, b.y))
    if abs(a.y + a.h - b.y) < EPS or abs(b.y + b.h - a.y) < EPS:
        return max(0.0, min(a.x + a.w, b.x + b.w) - max(a.x, b.x))
    return 0.0


def touches_exterior(r: Room, layout: Layout) -> bool:
    fp = layout.footprint
    return r.x < EPS or r.y < EPS or abs(r.x + r.w - fp.width_ft) < EPS or abs(r.y + r.h - fp.depth_ft) < EPS


def _door_valid(d, layout: Layout) -> bool:
    if len(d.between) != 2 or d.between[0] == d.between[1] or d.width_ft <= 0:
        return False
    a, b = d.between
    if a == EXTERIOR or b == EXTERIOR:
        r = layout.room(b if a == EXTERIOR else a)
        if r is None:
            return False
        segments = []
        fp = layout.footprint
        if abs(r.y) < EPS: segments.append(("h", 0, r.x, r.x + r.w))
        if abs(r.y + r.h - fp.depth_ft) < EPS: segments.append(("h", fp.depth_ft, r.x, r.x + r.w))
        if abs(r.x) < EPS: segments.append(("v", 0, r.y, r.y + r.h))
        if abs(r.x + r.w - fp.width_ft) < EPS: segments.append(("v", fp.width_ft, r.y, r.y + r.h))
    else:
        ra, rb = layout.room(a), layout.room(b)
        if ra is None or rb is None:
            return False
        segments = []
        if abs(ra.x + ra.w - rb.x) < EPS or abs(rb.x + rb.w - ra.x) < EPS:
            segments.append(("v", rb.x if abs(ra.x + ra.w - rb.x) < EPS else ra.x,
                             max(ra.y, rb.y), min(ra.y + ra.h, rb.y + rb.h)))
        if abs(ra.y + ra.h - rb.y) < EPS or abs(rb.y + rb.h - ra.y) < EPS:
            segments.append(("h", rb.y if abs(ra.y + ra.h - rb.y) < EPS else ra.y,
                             max(ra.x, rb.x), min(ra.x + ra.w, rb.x + rb.w)))
    for axis, line, lo, hi in segments:
        center = d.x if axis == "h" else d.y
        cross = d.y if axis == "h" else d.x
        if abs(cross - line) < EPS and center - d.width_ft / 2 >= lo - EPS and center + d.width_ft / 2 <= hi + EPS:
            return True
    return False


def _window_valid(w, layout: Layout) -> bool:
    r = layout.room(w.room)
    if r is None or not math.isfinite(w.offset_ft) or not math.isfinite(w.width_ft) or w.width_ft <= 0:
        return False
    fp = layout.footprint
    length = r.w if w.wall in {"north", "south"} else r.h
    on_boundary = {
        "north": abs(r.y) < EPS,
        "south": abs(r.y + r.h - fp.depth_ft) < EPS,
        "west": abs(r.x) < EPS,
        "east": abs(r.x + r.w - fp.width_ft) < EPS,
    }[w.wall]
    return on_boundary and w.offset_ft >= -EPS and w.offset_ft + w.width_ft <= length + EPS


def _graph(layout: Layout) -> dict[str, set[str]]:
    g: dict[str, set[str]] = {r.id: set() for r in layout.rooms}
    g[EXTERIOR] = set()
    for d in layout.doors:
        if _door_valid(d, layout):
            a, b = d.between
            if EXTERIOR in d.between and (abs(d.x - layout.entrance.x) >= EPS or abs(d.y - layout.entrance.y) >= EPS):
                continue
            g.setdefault(a, set()).add(b)
            g.setdefault(b, set()).add(a)
    return g


def _reachable(layout: Layout, blocked: set[str] = frozenset()) -> set[str]:
    g, seen, q = _graph(layout), {EXTERIOR}, deque([EXTERIOR])
    while q:
        for n in g.get(q.popleft(), ()):
            if n not in seen:
                seen.add(n)
                if n not in blocked:
                    q.append(n)
    return seen


# ---------- rules ----------


def no_overlap(layout: Layout) -> list[str]:
    errs, rs, fp = [], layout.rooms, layout.footprint
    for i, a in enumerate(rs):
        if a.w <= 0 or a.h <= 0:
            errs.append(f"{a.name} must have positive width and depth")
        for b in rs[i + 1 :]:
            if (ov := _overlap_area(a, b)) > EPS:
                errs.append(f"{a.name} and {b.name} overlap by {ov:.0f} sq ft")
        if a.x < -EPS or a.y < -EPS or a.x + a.w > fp.width_ft + EPS or a.y + a.h > fp.depth_ft + EPS:
            errs.append(f"{a.name} extends outside the {fp.width_ft:g}x{fp.depth_ft:g} ft footprint")
    if all(r.w > 0 and r.h > 0 for r in rs):
        covered = sum(r.area for r in rs)
        missing = fp.width_ft * fp.depth_ft - covered
        if missing > EPS:
            errs.append(f"Rooms leave {missing:.1f} sq ft of the footprint uncovered")
    return errs


def contract_integrity(layout: Layout) -> list[str]:
    errs = []
    ids = [r.id for r in layout.rooms]
    if len(ids) != len(set(ids)):
        errs.append("Room IDs must be unique")
    vals = [("footprint width", layout.footprint.width_ft), ("footprint depth", layout.footprint.depth_ft)]
    for r in layout.rooms:
        vals.extend((f"{r.name} {field}", getattr(r, field)) for field in ("x", "y", "w", "h"))
    for name, value in vals:
        if not math.isfinite(value) or abs(value / GRID - round(value / GRID)) > EPS:
            errs.append(f"{name} must be finite and on the 0.5 ft grid")
    for name, value in (("footprint width", layout.footprint.width_ft),
                        ("footprint depth", layout.footprint.depth_ft),
                        *((f"{r.name} target area", r.target_sqft) for r in layout.rooms)):
        if not math.isfinite(value) or value <= 0:
            errs.append(f"{name} must be finite and positive")
    if layout.requested_sqft is not None and (not math.isfinite(layout.requested_sqft) or layout.requested_sqft <= 0):
        errs.append("Requested house area must be finite and positive")
    return errs


def door_geometry(layout: Layout) -> list[str]:
    errs = []
    for d in layout.doors:
        if not _door_valid(d, layout):
            errs.append(f"Door between {' and '.join(d.between)} at ({d.x:g}, {d.y:g}) does not fit on a shared or exterior wall")
    front = [d for d in layout.doors if EXTERIOR in d.between and _door_valid(d, layout)
             and abs(d.x - layout.entrance.x) < EPS and abs(d.y - layout.entrance.y) < EPS]
    if not front:
        errs.append(f"Front door must sit at entrance ({layout.entrance.x:g}, {layout.entrance.y:g})")
    for w in layout.windows:
        if not _window_valid(w, layout):
            errs.append(f"Window for {w.room} on {w.wall} wall must fit entirely on that room's exterior wall")
    return errs


def all_reachable(layout: Layout) -> list[str]:
    seen = _reachable(layout)
    if EXTERIOR not in seen or not _graph(layout)[EXTERIOR]:
        return ["The house has no front door"]
    return [f"{r.name} can't be reached from the front door" for r in layout.rooms if r.id not in seen]


def bedroom_exterior_wall(layout: Layout) -> list[str]:
    errs = []
    door_rooms = {rid for d in layout.doors if _door_valid(d, layout) for rid in d.between}
    for r in layout.rooms:
        if r.type in BEDROOMS:
            if not touches_exterior(r, layout):
                errs.append(f"{r.name} has no exterior wall (needs one for a window)")
            if r.id not in door_rooms:
                errs.append(f"{r.name} has no door")
            if not any(w.room == r.id and _window_valid(w, layout) for w in layout.windows):
                errs.append(f"{r.name} has no valid exterior window")
    return errs


def public_bathroom(layout: Layout) -> list[str]:
    baths = [r for r in layout.rooms if r.type == "bathroom"]
    if not baths:
        return ["There is no bathroom"]
    bedroom_ids = {r.id for r in layout.rooms if r.type in BEDROOMS}
    seen = _reachable(layout, blocked=bedroom_ids)
    ok = any(b.id in seen and not (_graph(layout)[b.id] <= bedroom_ids) for b in baths)
    return [] if ok else ["Every bathroom is only reachable through a bedroom; add one off a hall or common room"]


def kitchen_adjacent(layout: Layout) -> list[str]:
    errs = []
    social = [r for r in layout.rooms if r.type in {"dining", "living"}]
    for k in (r for r in layout.rooms if r.type == "kitchen"):
        if not any(shared_wall(k, s) >= 3 for s in social):
            errs.append(f"{k.name} does not share a wall with the dining or living area")
    return errs


def min_widths(layout: Layout) -> list[str]:
    errs = []
    for r in layout.rooms:
        if r.type == "hall" and min(r.w, r.h) < MIN_HALL_W - EPS:
            errs.append(f"{r.name} is {min(r.w, r.h):.1f} ft wide; hallways need at least 3 ft")
    for d in layout.doors:
        if d.width_ft < MIN_DOOR_W - EPS:
            errs.append(f"Door between {' and '.join(d.between)} is {d.width_ft:.2f} ft; doors need at least 2'8\"")
    return errs


def sizes_match(layout: Layout) -> list[str]:
    errs = []
    for r in layout.rooms:
        if r.type == "hall" or r.target_sqft <= 0:
            continue
        if abs(r.area - r.target_sqft) / r.target_sqft > SIZE_TOL:
            errs.append(f"{r.name} is {r.area:.0f} sq ft but was asked to be {r.target_sqft:.0f} (more than 10% off)")
    if layout.requested_sqft:
        total = layout.footprint.width_ft * layout.footprint.depth_ft
        if abs(total - layout.requested_sqft) / layout.requested_sqft > SIZE_TOL:
            errs.append(f"House is {total:.0f} sq ft but {layout.requested_sqft:.0f} was requested (more than 10% off)")
    return errs


RULES: dict[str, Callable[[Layout], list[str]]] = {
    "contract_integrity": contract_integrity,
    "no_overlap_in_footprint": no_overlap,
    "door_geometry": door_geometry,
    "all_rooms_reachable": all_reachable,
    "bedroom_exterior_wall": bedroom_exterior_wall,
    "public_bathroom": public_bathroom,
    "kitchen_adjacent": kitchen_adjacent,
    "min_hall_and_door_width": min_widths,
    "sizes_within_10pct": sizes_match,
}


def check(layout: Layout) -> list[Check]:
    out = []
    for name, rule in RULES.items():
        try:
            errs = rule(layout)
        except Exception as e:  # a broken rule must not crash generation
            errs = [f"rule crashed: {e!r}"]
        out.append(Check(rule=name, pass_=not errs, message="; ".join(errs)))
    return out


def failures(checks: list[Check]) -> list[Check]:
    return [c for c in checks if not c.pass_]


def check_prompt(prompt: str, layout: Layout) -> Check:
    """Judge explicit requests using role 1's shared requirements parser."""
    from . import requirements  # role 1's module, shared with the planner

    errs = requirements.mismatches(requirements.parse(prompt), layout.rooms, layout.requested_sqft)
    return Check(rule="prompt_fidelity", pass_=not errs, message="; ".join(errs))


