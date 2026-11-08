"""Role 2: the solver's output passes every checker rule, door_geometry included, for ~30 programs."""

import os
import time

os.environ.setdefault("WALKTHRU_OFFLINE", "1")

import pytest

from solver_programs import MESSY, PROGRAMS, SAMPLE
from walkthru import checker, solver
from walkthru.schema import EXTERIOR, Layout, RoomProgram

GRID = 0.5
TOL = 0.01


def on_grid(v: float) -> bool:
    return abs(v / GRID - round(v / GRID)) < 1e-6


def door_geometry(layout: Layout) -> list[str]:
    """ROLE2_HANDOFF.md, written independently of the solver: every door names two valid
    endpoints, sits on their shared wall (footprint boundary for the front door), fits
    entirely inside it, and the front door matches layout.entrance."""
    W, D = layout.footprint.width_ft, layout.footprint.depth_ft
    rooms = {r.id: r for r in layout.rooms}
    errs = []
    for d in layout.doors:
        if len(d.between) != 2 or any(x != EXTERIOR and x not in rooms for x in d.between):
            errs.append(f"bad endpoints {d.between}")
            continue
        a, b = d.between
        half = d.width_ft / 2
        walls = []  # (wall is horizontal?, coordinate, lo, hi)
        if EXTERIOR in (a, b):
            r = rooms[b if a == EXTERIOR else a]
            if abs(r.y) < TOL: walls.append((True, 0.0, r.x, r.x + r.w))
            if abs(r.y + r.h - D) < TOL: walls.append((True, D, r.x, r.x + r.w))
            if abs(r.x) < TOL: walls.append((False, 0.0, r.y, r.y + r.h))
            if abs(r.x + r.w - W) < TOL: walls.append((False, W, r.y, r.y + r.h))
            if abs(d.x - layout.entrance.x) > TOL or abs(d.y - layout.entrance.y) > TOL:
                errs.append("front door is not at layout.entrance")
        else:
            ra, rb = rooms[a], rooms[b]
            for p, q in ((ra, rb), (rb, ra)):
                if abs(p.x + p.w - q.x) < TOL:
                    walls.append((False, q.x, max(p.y, q.y), min(p.y + p.h, q.y + q.h)))
                if abs(p.y + p.h - q.y) < TOL:
                    walls.append((True, q.y, max(p.x, q.x), min(p.x + p.w, q.x + q.w)))
        fits = any(
            abs((d.y if horiz else d.x) - c) < TOL
            and lo - TOL <= (d.x if horiz else d.y) - half
            and (d.x if horiz else d.y) + half <= hi + TOL
            for horiz, c, lo, hi in walls)
        if not fits:
            errs.append(f"door {d.between} at ({d.x}, {d.y}) w={d.width_ft} is not inside their shared wall")
    return errs


def solve(name_or_program):
    prog = PROGRAMS[name_or_program] if isinstance(name_or_program, str) else name_or_program
    return solver.solve(RoomProgram.model_validate(prog))


@pytest.mark.parametrize("name", sorted(PROGRAMS))
def test_program_passes_every_rule(name):
    t0 = time.perf_counter()
    layout = solve(name)
    ms = (time.perf_counter() - t0) * 1000
    failed = [f"{c.rule}: {c.message}" for c in checker.check(layout) if not c.pass_]
    assert not failed, failed
    assert not door_geometry(layout), door_geometry(layout)
    assert ms < 1500, f"{ms:.0f} ms"

    W, D = layout.footprint.width_ft, layout.footprint.depth_ft
    assert abs(sum(r.area for r in layout.rooms) - W * D) < 0.01, "rooms must tile the footprint"
    assert all(on_grid(v) for r in layout.rooms for v in (r.x, r.y, r.w, r.h)), "rooms off the 0.5 ft grid"
    for d in layout.doors:  # centre and both ends on the grid (walls.ts cuts 0.5 ft wall units)
        assert on_grid(d.x) and on_grid(d.y) and on_grid(d.width_ft), d
    planned = {r["id"] for r in PROGRAMS[name]["rooms"] if r["type"] != "hall"}
    placed = {r.id for r in layout.rooms}
    assert len(placed) == len(layout.rooms)
    assert len(placed - {"hall"}) >= len(planned)
    assert sum(r.type == "hall" for r in layout.rooms) <= 1


@pytest.mark.parametrize("name", sorted(PROGRAMS))
def test_windows_sit_on_exterior_walls(name):
    layout = solve(name)
    W, D = layout.footprint.width_ft, layout.footprint.depth_ft
    rooms = {r.id: r for r in layout.rooms}
    for w in layout.windows:
        r = rooms[w.room]
        length = r.w if w.wall in ("north", "south") else r.h
        on_edge = {"north": abs(r.y) < TOL, "south": abs(r.y + r.h - D) < TOL,
                   "west": abs(r.x) < TOL, "east": abs(r.x + r.w - W) < TOL}[w.wall]
        assert on_edge, f"{w.room} window on interior {w.wall} wall"
        assert 0 <= w.offset_ft and w.offset_ft + w.width_ft <= length + TOL, w
        assert on_grid(w.offset_ft) and on_grid(w.width_ft), w


def test_every_bedroom_gets_a_window():
    for name in PROGRAMS:
        layout = solve(name)
        with_window = {w.room for w in layout.windows}
        for r in layout.rooms:
            if r.type in ("bedroom", "primary_bedroom"):
                assert r.id in with_window, (name, r.id)


def test_ensuite_opens_only_into_its_bedroom():
    layout = solver.solve(RoomProgram.model_validate(SAMPLE))
    doors = [set(d.between) for d in layout.doors if "bathroom_1" in d.between]
    assert doors == [{"bathroom_1", "primary_bedroom"}]
    layout = solve("demo_3bed_office_wic")
    for kid in ("primary_bath", "wic"):
        assert [set(d.between) for d in layout.doors if kid in d.between] == [{kid, "primary"}]


def test_deterministic():
    a = solver.solve(RoomProgram.model_validate(SAMPLE)).model_dump()
    b = solver.solve(RoomProgram.model_validate(SAMPLE)).model_dump()
    assert a == b


def _edit(changes):
    from walkthru.geometry import solve as solve_dict

    program = RoomProgram.model_validate(SAMPLE)
    before = solver.solve(program)
    edited = program.model_copy(deep=True)
    for r in edited.rooms:
        if r.id in changes:
            r.target_sqft = changes[r.id]
    keep = Layout.model_validate_json(before.model_dump_json(by_alias=True))  # API round trip
    after = solver.solve(edited, keep=keep)
    assert all(c.pass_ for c in checker.check(after)), [c.message for c in checker.check(after) if not c.pass_]
    assert not door_geometry(after)
    meta = solve_dict(edited.model_dump(), previous=keep.model_dump(by_alias=True))["solver"]
    return before, after, meta


def test_edit_bigger_living_keeps_private_wing_exactly():
    before, after, meta = _edit({"living": 470})
    assert meta["reused_previous"] == "pinned"
    old = {r.id: r for r in before.rooms}
    shifts = set()
    for r in after.rooms:  # the private wing keeps its shape; at most it slides east/west as one piece
        if r.id in ("kitchen", "living", "dining"):
            continue
        o = old[r.id]
        assert (r.y, r.w, r.h) == (o.y, o.w, o.h), r.id
        shifts.add(r.x - o.x)
    assert len(shifts) == 1, shifts
    assert next(r for r in after.rooms if r.id == "living").area > old["living"].area


def test_edit_bigger_kitchen_keeps_the_arrangement():
    # what the edit prompt does for "make the kitchen bigger": grow it, shrink living
    before, after, meta = _edit({"kitchen": 260, "living": 370})
    assert meta["reused_previous"] in ("pinned", "rearranged")

    def sides(layout):
        hall = next(r for r in layout.rooms if r.type == "hall")
        return {r.id: ("public" if r.x + r.w <= hall.x else "north" if r.y + r.h <= hall.y else "south")
                for r in layout.rooms if r.type != "hall"}

    assert sides(before) == sides(after)
    k_old = next(r for r in before.rooms if r.id == "kitchen")
    assert next(r for r in after.rooms if r.id == "kitchen").area > k_old.area
    k = next(r for r in after.rooms if r.id == "kitchen")
    assert k.area > next(r for r in before.rooms if r.id == "kitchen").area


def test_edit_add_and_remove_rooms():
    program = RoomProgram.model_validate(SAMPLE)
    before = solver.solve(program)
    edited = program.model_copy(deep=True)
    edited.rooms = [r for r in edited.rooms if r.id != "office"]
    edited.rooms.append(edited.rooms[2].model_copy(update={"id": "bedroom_4", "name": "Bedroom 4"}))
    keep = Layout.model_validate_json(before.model_dump_json(by_alias=True))
    after = solver.solve(edited, keep=keep)
    failed = [c.message for c in checker.check(after) if not c.pass_]
    assert not failed, failed
    assert not door_geometry(after)
    ids = {r.id for r in after.rooms}
    assert "office" not in ids and "bedroom_4" in ids
    def side(layout, rid):  # which side of the hallway a room is on
        hall = next(r for r in layout.rooms if r.type == "hall")
        r = next(r for r in layout.rooms if r.id == rid)
        if r.x + r.w <= hall.x:
            return "public"
        return "north" if r.y + r.h <= hall.y else "south"

    for rid in ("bedroom_2", "bedroom_3", "primary_bedroom", "bathroom_2", "kitchen", "living"):
        assert side(before, rid) == side(after, rid), rid


def test_messy_free_form_input_still_validates():
    from walkthru.geometry import solve as solve_dict

    out = solve_dict(MESSY)
    layout = Layout.model_validate(out)  # every output type is a schema RoomType
    assert not door_geometry(layout)
    assert all(c["pass"] for c in out["solver"]["selfcheck"]), out["solver"]["selfcheck"]


def test_selfcheck_agrees_with_checker():
    """The solver picks candidates with its own copy of the rules; make sure it matches checker.py."""
    from walkthru.geometry.selfcheck import selfcheck

    for name in PROGRAMS:
        layout = solve(name)
        mine = {c["rule"]: c["pass"] for c in selfcheck(layout.model_dump(by_alias=True))}
        theirs = {c.rule: c.pass_ for c in checker.check(layout)}
        for rule in mine.keys() & theirs.keys():  # role 3 may add rules before we mirror them
            assert mine[rule] == theirs[rule], (name, rule)
