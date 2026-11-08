"""solve(program) -> layout JSON with exact walls, doors and windows (feet).

The solver tries a few hundred candidate arrangements (footprint depth x
public-block variant x north/south band split), builds exact geometry for
each, places doors, runs the self-check, and keeps the best-scoring one.
Any candidate that fails a rule scores +1000 per failed rule, so a passing
layout always wins when one exists.
"""
from __future__ import annotations

import copy
import math
import time
from dataclasses import dataclass
from typing import Dict, List, Optional

from .arrange import (Arrangement, aspect_pen, band_assignments, band_order, build,
                      make_units, needed_length)
from .geom import EPS, GRID, Rect, r2, shared_edge, snap
from .openings import Roles, plan_doors, plan_windows
from .program import Program, ProgramError, normalize
from .selfcheck import failures, selfcheck
from .taxonomy import CONTRACT_TYPES, MIN_DIM, TO_CONTRACT, WEIGHT
from .transform import Transform, choose_transform, entry_face_for
from .walls import build_walls
from .footprint import outline as room_outline
from .shapes import stepped_wing

VERSION = "0.1.0"
HALL_WIDTH_FT = 4.0   # rule minimum is 3 ft; 4 ft feels right in first person
CEILING_FT = 9.0
FIT_TOL = 0.06        # a given footprint is used as-is if rooms fit it within 6%
TOTAL_AIM = 0.05      # if rooms + hall miss requested_sqft by more than this, scale rooms toward it
MAX_SCALE = 0.06      # ...but never by more than this (every room must stay within 10%)
STABLE_SLACK = 40.0
BAND_KEEP = 16        # north/south splits fully evaluated per depth and public variant   # on edits, keep the previous arrangement unless a fresh one is much better


class SolverError(RuntimeError):
    """No arrangement could be built (e.g. absurd footprint)."""


@dataclass
class Candidate:
    score: float
    arr: Arrangement
    L: float
    k: float
    rects: Dict[str, Rect]
    layout: dict
    checks: List[dict]
    prog: Program


# ---------------------------------------------------------------- variants

def public_variants(prog: Program, entry_face: str):
    R = prog.rooms
    pub = prog.ids("public")
    foyer = prog.ids("foyer")
    kit = [r for r in pub if R[r].type == "kitchen"]
    din = [r for r in pub if R[r].type == "dining"]
    liv = sorted((r for r in pub if R[r].type == "living"), key=lambda r: -R[r].target)
    fam = [r for r in pub if R[r].type == "family"]
    out, seen = [], set()

    def add(back, front):
        back, front = list(back), list(front)
        if not front and len(back) >= 2:
            front = [back.pop()]
        if entry_face == "west" and not foyer and front:
            main = next((r for r in front if R[r].type == "living"), front[0])
            front = [main] + [r for r in front if r != main]
        if foyer:
            front = foyer + front if entry_face == "west" else front + foyer
        key = (tuple(back), tuple(front))
        if key not in seen:
            seen.add(key)
            out.append((back, front))

    social = liv + fam
    add(kit + din, social)
    if len(kit + din) >= 2:
        add(din + kit, social)
    if kit and din and social:
        add(kit, din + social)
    if fam and liv:
        add(kit + din + fam, liv)
    if not out:
        add([], [])
    return out


def _carved(prog: Program, rid: str) -> float:
    return prog.rooms[rid].target + sum(prog.rooms[c].target for c in prog.rooms[rid].children)


def h_candidates(prog: Program) -> List[float]:
    total = sum(r.target for r in prog.rooms.values())
    if total < 900:
        hs = [22.0, 24.0, 26.0]
    elif total < 1400:
        hs = [24.0, 26.0, 28.0]
    elif total < 2200:
        hs = [26.0, 28.0, 30.0]
    elif total < 3000:
        hs = [28.0, 30.0, 32.0]
    else:
        hs = [30.0, 33.0, 36.0]
    if prog.aspect:  # the depth the planner's aspect ratio implies, if it's not silly
        h = float(round(math.sqrt(total * 1.08 / min(max(prog.aspect, 1.0), 2.5))))
        if 20 <= h <= 40 and all(abs(h - x) >= 2 for x in hs):
            hs.append(h)
    return hs


def scale_for_total(prog: Program, H: float, hw: float) -> float:
    """Room scale k that brings the derived footprint within TOTAL_AIM of requested_sqft."""
    if not prog.total_sqft:
        return 1.0
    area = needed_length(_base_arr(prog, H, hw), prog) * H
    ratio = prog.total_sqft / area
    if abs(ratio - 1) <= TOTAL_AIM:
        return 1.0
    k = ratio / (1 + TOTAL_AIM) if ratio > 1 else ratio / (1 - TOTAL_AIM)
    return min(max(k, 1 - MAX_SCALE), 1 + MAX_SCALE)


def _base_arr(prog: Program, H: float, hw: float) -> Arrangement:
    """Arrangement with the right room sums, for footprint sizing only."""
    band = [[r] for r in prog.order if prog.rooms[r].zone == "corridor"
            or (prog.rooms[r].zone == "child" and prog.rooms[prog.rooms[r].host].zone == "corridor")]
    garage = (prog.ids("garage") or [None])[0]
    return Arrangement(H=H, hall_width=hw, back=prog.ids("public") + prog.ids("foyer"),
                       north=band, garage=garage)


def _resize(prog: Program, hw: float, aspect: float) -> float:
    lo, hi = hw + 6.0, 200.0
    for _ in range(60):
        mid = (lo + hi) / 2
        if needed_length(_base_arr(prog, mid, hw), prog) > aspect * mid:
            lo = mid
        else:
            hi = mid
    return float(round(hi))


def _adapt(prev: Arrangement, prog: Program, hw: float, garage: Optional[str]) -> Arrangement:
    """Carry an earlier arrangement over to an edited program (edits stay local)."""
    R = prog.rooms

    def zone(r):
        return R[r].zone if r in R else None

    def in_band(r):
        return zone(r) == "corridor" or (zone(r) == "child" and zone(R[r].host) == "corridor")

    back = [r for r in prev.back if zone(r) in ("public", "foyer")]
    front = [r for r in prev.front if zone(r) in ("public", "foyer")]
    for r in prog.ids("public") + prog.ids("foyer"):
        if r in back or r in front:
            continue
        if zone(r) == "foyer":
            front = [r] + front if prev.entry_face == "west" else front + [r]
        elif R[r].type in ("kitchen", "dining"):
            back.append(r)
        else:
            front.append(r)
    hall_end = [r for r in prev.hall_end if zone(r) == "corridor" and not R[r].children]
    north = [c for c in ([r for r in col if in_band(r)] for col in prev.north) if c]
    south = [c for c in ([r for r in col if in_band(r)] for col in prev.south) if c]
    stack = [r for r in prev.stack if in_band(r)]
    placed = {r for col in north + south for r in col} | set(stack) | set(hall_end)

    for r in prog.order:  # new child of an already-placed host: put it beside the host
        if zone(r) == "child" and in_band(r) and r not in placed and R[r].host in placed:
            for band in (north, south):
                for i, col in enumerate(band):
                    if R[r].host in col:
                        band.insert(i, [r])
                        break
                else:
                    continue
                break
            else:
                stack.insert(stack.index(R[r].host) + 1, r)
            placed.add(r)

    units = make_units(prog, (prev.H - hw) / 2)
    for u in band_order(units):
        cols = [[r for r in col if r not in placed] for col in u.columns]
        cols = [c for c in cols if c]
        if not cols:
            continue
        placed.update(r for c in cols for r in c)
        if stack and not (north or south):
            stack.extend(r for c in cols for r in c)
        else:
            area = lambda band: sum(R[r].target for col in band for r in col)
            (north if area(north) <= area(south) else south).extend(cols)
    return Arrangement(H=prev.H, hall_width=prev.hall_width, entry_face=prev.entry_face,
                       back=back, front=front, north=north, south=south, stack=stack, hall_end=hall_end,
                       garage=garage, swap=prev.swap, flip_u=prev.flip_u, flip_v=prev.flip_v)


def arrangement_from_layout(layout: dict, prog: Program) -> Optional[Arrangement]:
    """Read the arrangement back out of a layout this solver produced.

    The API round-trips layouts through the pydantic Layout model, which keeps only
    contract fields, so on edits we recover rows and band columns from the geometry.
    Returns None for anything that doesn't look like one of our unrotated plans.
    """
    try:
        W = float(layout["footprint"]["width_ft"])
        D = float(layout["footprint"]["depth_ft"])
        rects = {r["id"]: Rect(float(r["x"]), float(r["y"]), float(r["w"]), float(r["h"]))
                 for r in layout["rooms"]}
        types = {r["id"]: r.get("type") for r in layout["rooms"]}
        ent = layout.get("entrance") or {}
    except (KeyError, TypeError, ValueError):
        return None
    halls = [rid for rid, t in types.items() if t == "hall"]
    if len(halls) != 1:
        return None
    hr = rects[halls[0]]
    if hr.w < hr.h or hr.x < -EPS or hr.x2 > W + EPS:
        return None  # rotated plan: just solve fresh
    u0, dn, hw = hr.x, hr.y, hr.h
    others = [rid for rid in rects if rid != halls[0]]
    public = [rid for rid in others if rects[rid].x2 <= u0 + EPS]
    north = [rid for rid in others if rects[rid].x >= u0 - EPS and rects[rid].y2 <= dn + EPS]
    south = [rid for rid in others if rects[rid].x >= u0 - EPS and rects[rid].y >= dn + hw - EPS]
    hall_end = sorted((rid for rid in others if abs(rects[rid].y - dn) < EPS and abs(rects[rid].h - hw) < EPS
                       and rects[rid].x >= hr.x2 - EPS), key=lambda r: -rects[r].x)
    if len(public) + len(north) + len(south) + len(hall_end) != len(others):
        return None
    back = sorted((r for r in public if rects[r].y < EPS and rects[r].y2 < D - EPS), key=lambda r: rects[r].x)
    front = sorted((r for r in public if r not in back), key=lambda r: rects[r].x)

    def columns(ids, ext_first):
        cols: Dict[tuple, List[str]] = {}
        for r in ids:
            cols.setdefault((rects[r].x, rects[r].x2), []).append(r)
        out = []
        for key in sorted(cols):
            col = sorted(cols[key], key=lambda r: rects[r].y)
            out.append(col if ext_first else col[::-1])
        return out

    if abs(ent.get("y", -1) - D) < EPS:
        entry_face = "south"
    elif abs(ent.get("x", -1)) < EPS:
        entry_face = "west"
    else:
        return None
    if hall_end and abs(rects[hall_end[-1]].x2 - W) > EPS and abs(max(rects[r].x2 for r in hall_end) - W) > EPS:
        return None
    if not hall_end and abs(hr.x2 - W) > EPS:
        return None  # mirrored plan
    return Arrangement(H=D, hall_width=hw, entry_face=entry_face, back=back, front=front,
                       north=columns(north, True), south=columns(south, False), hall_end=hall_end)


# ---------------------------------------------------------------- evaluation

def _assemble(prog: Program, rects: Dict[str, Rect], W: float, D: float) -> List[dict]:
    rooms = []
    order = list(prog.order)
    if prog.hall_id in rects:
        order.append(prog.hall_id)
    for rid in order:
        r = rects[rid]
        if rid == prog.hall_id and rid not in prog.rooms:
            out = {"id": rid, "type": "hall", "name": prog.hall_name,
                   "target_sqft": r2(r.area), "adjacent_to": []}
        else:
            room = prog.rooms[rid]
            raw_type = str(room.raw.get("type") or "")
            out = {k: v for k, v in room.raw.items() if k not in ("x", "y", "w", "h")}
            out.update({"id": rid, "name": room.name, "target_sqft": r2(room.target),
                        "type": raw_type if raw_type in CONTRACT_TYPES else TO_CONTRACT[room.type],
                        "adjacent_to": [a for a in room.raw.get("adjacent_to", []) if a in prog.rooms]})
        out.update({"x": r2(r.x), "y": r2(r.y), "w": r2(r.w), "h": r2(r.h), "area_sqft": r2(r.area)})
        rooms.append(out)
    return rooms


def _score(layout: dict, checks: List[dict], prog: Program, rects: Dict[str, Rect]) -> float:
    s = 1000.0 * len(failures(checks))
    for rid, rect in rects.items():
        w, h = rect.w, rect.h
        if rid not in prog.rooms:  # the hallway
            s += 0.01 * w * h
            continue
        t = prog.rooms[rid].type
        e = abs(w * h - prog.rooms[rid].target) / prog.rooms[rid].target
        s += 300.0 * max(0.0, e - 0.02) ** 2
        s += 3.0 * aspect_pen(t, w, h)
        md = min(w, h)
        if md < MIN_DIM[t]:
            s += WEIGHT[t] * (MIN_DIM[t] - md) ** 2
    linked = {frozenset(d["between"]) for d in layout["doors"]}
    for rid, room in prog.rooms.items():  # an ensuite must open into its bedroom, not the hall
        if room.host and frozenset((rid, room.host)) not in linked:
            s += 50.0
    for a, room in prog.rooms.items():  # adjacencies the planner asked for
        for b in room.adjacent:
            if a < b and a in rects and b in rects:
                seg = shared_edge(rects[a], rects[b])
                if seg is None or seg[3] - seg[2] < 3.0:
                    s += 1.0
    if prog.aspect:  # soft preference for the planner's width/depth ratio
        fp = layout["footprint"]
        s += 4.0 * abs(math.log((fp["width_ft"] / fp["depth_ft"]) / prog.aspect))
    return s


def _evaluate(arr: Arrangement, prog: Program, L: Optional[float], k: float,
              hint_pos: Optional[float]) -> Optional[Candidate]:
    if L is None:
        L = max(4.0, snap(needed_length(arr, prog, k)))
    res = build(arr, prog, L, k)
    if res is None:
        return None
    rects_c, info = res
    if any(r not in rects_c for r in prog.order):
        return None
    tf = Transform(arr.swap, arr.flip_u, arr.flip_v, L, arr.H)
    rects = {rid: tf.rect(r) for rid, r in rects_c.items()}
    W, D = tf.W, tf.D
    types = {rid: (prog.rooms[rid].type if rid in prog.rooms else "hallway") for rid in rects}
    roles = Roles(types=types, hall=prog.hall_id if arr.hall else None, entrance=info["entrance"],
                  host={r: prog.rooms[r].host for r in prog.order if prog.rooms[r].host},
                  garage=arr.garage,
                  dual=frozenset(r for r in prog.order if prog.rooms[r].dual),
                  closed=frozenset(r for r in prog.order if prog.rooms[r].type in prog.closed))
    doors, entrance = plan_doors(rects, roles, W, D, tf.side(arr.entry_face), hint_pos)
    layout = {"footprint": {"width_ft": r2(W), "depth_ft": r2(D)}, "requested_sqft": prog.total_sqft}
    layout.update({"entrance": entrance, "rooms": _assemble(prog, rects, W, D), "doors": doors})
    checks = selfcheck(layout)
    return Candidate(_score(layout, checks, prog, rects), arr, L, k, rects, layout, checks, prog)


def _studio_variants(prog: Program) -> List[Program]:
    """No bedrooms and only a bath/laundry or two: carve them out of a public room
    instead of giving them a hallway or a full-depth strip."""
    cor = prog.ids("corridor")
    pub = prog.ids("public")
    if not cor or not pub or len(cor) > 2 or any(prog.rooms[r].type == "bedroom" for r in cor):
        return []
    out = []
    for host in pub:
        p2 = copy.deepcopy(prog)
        for r in cor:
            p2.rooms[r].host, p2.rooms[r].zone = host, "child"
            p2.rooms[host].children.append(r)
        out.append(p2)
    return out


def _pinned_hall(previous: dict, prev: Arrangement, arr: Arrangement, prog: Program) -> Optional[List[float]]:
    """On an edit that leaves every band room untouched, keep the hallway exactly where it was
    so the whole private wing stays put and only the public rows absorb the change."""
    if not arr.hall or arr.swap or arr.flip_v:
        return None
    before = {r for col in prev.north + prev.south for r in col}
    after = {r for col in arr.north + arr.south for r in col}
    rooms = {r.get("id"): r for r in previous.get("rooms", []) if isinstance(r, dict)}
    if before != after or any(r not in rooms or abs(float(rooms[r].get("target_sqft", -1))
                                                     - prog.rooms[r].target) > 1e-6 for r in after):
        return None
    hall = next((r for r in rooms.values() if r.get("type") == "hall"), None)
    if hall is None or abs(float(hall.get("h", -1)) - arr.hall_width) > EPS:
        return None
    return [float(hall["y"]), float(hall["w"])]


# ---------------------------------------------------------------- entry point

def solve(program: dict, previous: Optional[dict] = None, *,
          hall_width: float = HALL_WIDTH_FT, footprint_mode: str = "auto") -> dict:
    """Turn a room program into a full layout.

    program         planner output: rooms (id, type, name, target_sqft, adjacent_to),
                    optional footprint, total_sqft, entrance.
    previous        layout this solver returned earlier; pass it on edits so rooms the
                    user didn't mention stay where they were.
    footprint_mode  "auto": use the given footprint if the rooms fit it within 6%,
                    otherwise resize it (same proportions) and warn;
                    "strict": always use it, scaling rooms; "derive": ignore it.
    Raises ProgramError for malformed input and SolverError if nothing fits.
    """
    t0 = time.perf_counter()
    prog = normalize(program)
    warnings = list(prog.warnings)
    hw = max(3.0, float(hall_width))
    garage = (prog.ids("garage") or [None])[0]

    fp = prog.footprint if footprint_mode != "derive" else None
    swap = bool(fp and fp[1] > fp[0])
    desired = prog.entrance_side
    entry_face = entry_face_for(swap, desired)
    if not (prog.ids("public") or prog.ids("foyer")):
        entry_face = "west"  # the front door opens straight into the hallway's end
        desired = Transform(swap, False, False).side("west")
    tf = choose_transform(swap, entry_face, desired, prog.entrance_pos)

    plans = []   # (H, fixed L or None, room scale k)
    mode = "derived"
    if fp:
        L_fp, H_fp = max(fp), min(fp)
        k = L_fp / needed_length(_base_arr(prog, H_fp, hw), prog)
        if footprint_mode == "strict" or abs(k - 1) <= FIT_TOL:
            plans, mode = [(H_fp, L_fp, k)], "fixed"
            if abs(k - 1) > 0.02:
                warnings.append(f"Rooms were scaled by {k:.2f} to fill the "
                                f"{fp[0]:g} x {fp[1]:g} ft footprint.")
        else:
            H2 = _resize(prog, hw, L_fp / H_fp)
            plans, mode = [(H2, None, 1.0)], "resized"
            room_sum = sum(r.target for r in prog.rooms.values())
            warnings.append(
                f"Room targets add up to {room_sum:.0f} sq ft plus hallway, which doesn't fit the "
                f"{fp[0]:g} x {fp[1]:g} ft footprint ({fp[0] * fp[1]:.0f} sq ft); the footprint "
                f"was resized to keep room sizes. Adjust room targets to change the house size.")
    else:
        plans = [(H, None, scale_for_total(prog, H, hw)) for H in h_candidates(prog)]
        if all(abs(k - 1) > 1e-9 for _, _, k in plans):
            room_sum = sum(r.target for r in prog.rooms.values())
            warnings.append(f"Room targets ({room_sum:.0f} sq ft) plus hallway don't add up to the requested "
                            f"{prog.total_sqft:.0f} sq ft; rooms were scaled by up to {MAX_SCALE:.0%} to close the gap.")

    cands: List[Candidate] = []
    n_built = 0
    for variant in [prog] + _studio_variants(prog):
        pubs = public_variants(variant, entry_face)
        tiny = [r for r in variant.ids("corridor") if variant.rooms[r].target <= 40
                and variant.rooms[r].type in ("half_bath", "closet", "laundry", "pantry")
                and not variant.rooms[r].children]
        ends = [[]] + ([tiny[:1]] if tiny else []) + ([tiny[:2]] if len(tiny) >= 2 else [])
        for (H, L_fixed, k), hall_end in ((p, e) for p in plans for e in ends):
            units = make_units(variant, (H - hw) / 2, exclude=frozenset(hall_end))
            if hall_end and not units:
                continue
            seams = tuple(H * sum(_carved(variant, r) for r in back) / max(sum(_carved(variant, r) for r in back + front), 1e-9)
                          for back, front in pubs if back and front)
            assigns = band_assignments(variant, units, H, hw, keep=BAND_KEEP, seams=seams)
            base = dict(H=H, hall_width=hw, entry_face=entry_face, garage=garage, hall_end=list(hall_end),
                        swap=tf.swap, flip_u=tf.flip_u, flip_v=tf.flip_v)
            arrs = []
            for back, front in pubs:
                for north_u, south_u in assigns:
                    arrs.append(Arrangement(back=back, front=front,
                                            north=[c for u in north_u for c in u.columns],
                                            south=[c for u in south_u for c in u.columns], **base))
                n_corr = sum(len(col) for u in units for col in u.columns)
                if units and n_corr <= 4 and not hall_end:  # tiny program: rooms open straight off the living area
                    stack = []
                    for u in band_order(units):
                        stack += [u.host] + [r for col in u.columns for r in col if r != u.host]
                    arrs.append(Arrangement(back=back, front=front, stack=stack, **base))
            for arr in arrs:
                n_built += 1
                c = _evaluate(arr, variant, L_fixed, k, prog.entrance_pos)
                if c:
                    cands.append(c)

    if not cands:
        raise SolverError("No arrangement fits these rooms; check the footprint and room sizes.")
    best = min(cands, key=lambda c: c.score)

    prev_arr = None
    if isinstance(previous, dict):
        prev_arr = Arrangement.from_json((previous.get("solver") or {}).get("arrangement"))
        if prev_arr is None:  # came back through the API: pydantic drops our extras
            prev_arr = arrangement_from_layout(previous, prog)
    reused = ""
    if prev_arr is not None:
        arr = _adapt(prev_arr, prog, hw, garage)
        if mode != "derived":
            arr.H = plans[0][0]
            arr.swap, arr.flip_u, arr.flip_v = tf.swap, tf.flip_u, tf.flip_v
        k_prev = plans[0][2] if mode == "fixed" else scale_for_total(prog, arr.H, hw)
        pin = _pinned_hall(previous, prev_arr, arr, prog)
        rows = [(arr.back, arr.front)] + [v for v in public_variants(prog, arr.entry_face)
                                          if v != (arr.back, arr.front)]
        # Preference: private wing pinned exactly (public rows as before, then re-arranged),
        # then the hallway free to slide; otherwise fall through to the fresh best.
        tries = [(pin, r) for r in rows if pin is not None] + [(None, r) for r in rows]
        for hall_at, (back, front) in tries:
            trial = copy.copy(arr)
            trial.hall_at, trial.back, trial.front = hall_at, back, front
            n_built += 1
            c = _evaluate(trial, prog, plans[0][1] if mode == "fixed" else None, k_prev, prog.entrance_pos)
            if c and not failures(c.checks) and c.score <= best.score + STABLE_SLACK:
                best, reused = c, ("pinned" if hall_at is not None else "rearranged")
                break

    layout = best.layout
    shape_request = str(program.get("shape") or program.get("notes") or "").lower()
    shape = next((kind for kind in ("l", "t", "u") if
                  shape_request in {kind, f"{kind}-shape", f"{kind}-shaped"} or
                  f"{kind}-shaped" in shape_request), None)
    if shape:
        shaped = stepped_wing(best.rects, best.prog.hall_id, shape)
        if shaped:
            try:
                boundary, holes = room_outline(shaped)
                W2 = max(r.x2 for r in shaped.values())
                D2 = max(r.y2 for r in shaped.values())
                old_entry = layout["entrance"]
                roles = Roles(
                    types={rid: (best.prog.rooms[rid].type if rid in best.prog.rooms else "hallway") for rid in shaped},
                    hall=best.prog.hall_id if best.prog.hall_id in shaped else None,
                    entrance=old_entry["room"],
                    host={rid: room.host for rid, room in best.prog.rooms.items() if room.host},
                    garage=best.arr.garage,
                    dual=frozenset(rid for rid, room in best.prog.rooms.items() if room.dual),
                    closed=frozenset(rid for rid, room in best.prog.rooms.items() if room.type in best.prog.closed),
                )
                doors, entrance = plan_doors(shaped, roles, W2, D2, old_entry["side"], prog.entrance_pos)
                trial = copy.deepcopy(layout)
                trial["footprint"] = {"width_ft": r2(W2), "depth_ft": r2(D2),
                                      "outline": boundary, "holes": holes}
                trial["rooms"] = [{**r, "x": shaped[r["id"]].x, "y": shaped[r["id"]].y,
                                    "w": shaped[r["id"]].w, "h": shaped[r["id"]].h}
                                   for r in layout["rooms"]]
                trial["doors"], trial["entrance"] = doors, entrance
                trial["windows"] = plan_windows(shaped, roles.types, W2, D2, doors)
                if not failures(selfcheck(trial)):
                    best.rects, layout = shaped, trial
                else:
                    warnings.append("Requested irregular outline could not pass layout checks; used rectangle.")
            except ValueError:
                warnings.append("Requested irregular outline could not be formed; used rectangle.")
        else:
            warnings.append("Requested irregular outline could not be formed for these rooms; used rectangle.")
    W, D = layout["footprint"]["width_ft"], layout["footprint"]["depth_ft"]
    types = {rid: (best.prog.rooms[rid].type if rid in best.prog.rooms else "hallway") for rid in best.rects}
    windows = plan_windows(best.rects, types, W, D, layout["doors"])
    layout["windows"] = windows
    layout["walls"] = build_walls(best.rects, layout["doors"], windows)
    layout["ceiling_ft"] = CEILING_FT
    layout["checks"] = []  # filled by the rule checker (role 3)
    fails = failures(best.checks)
    if fails:
        warnings.append("Best layout still breaks: " + "; ".join(f["message"] for f in fails))
    layout["solver"] = {
        "version": VERSION,
        "footprint_mode": mode,
        "reused_previous": reused,
        "warnings": warnings,
        "selfcheck": best.checks,
        "score": round(best.score, 2),
        "candidates": n_built,
        "ms": round((time.perf_counter() - t0) * 1000, 1),
        "arrangement": best.arr.to_json(),
    }
    return layout


__all__ = ["solve", "SolverError", "ProgramError"]
