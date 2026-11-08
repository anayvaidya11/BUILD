"""Focused, offline checks for role 3's geometry gate."""

import time

from walkthru import checker, planner, solver
from walkthru.schema import Door


def valid_layout():
    layout = solver.solve(planner.sample_program())
    # Role 2 is fixing the baseline Laundry door; keep this checker fixture valid.
    laundry = next(d for d in layout.doors if "laundry" in d.between)
    # A 2.5 ft wall cannot fit even a minimum-width door; widen Laundry in fixture.
    room = layout.room("laundry")
    kitchen = layout.room("kitchen")
    room.w = 3.0
    kitchen.x += 0.5
    kitchen.w -= 0.5
    laundry.x = 1.5
    laundry.width_ft = 3.0
    return layout


def failed(layout):
    return {c.rule for c in checker.check(layout) if not c.pass_}


def test_geometry_accepts_corrected_fixture_under_one_second():
    layout = valid_layout()
    start = time.perf_counter()
    assert not failed(layout)
    assert time.perf_counter() - start < 1


def test_invalid_door_is_not_reachable():
    layout = valid_layout()
    door = next(d for d in layout.doors if "bedroom_2" in d.between)
    door.x = 1
    assert {"door_geometry", "all_rooms_reachable", "bedroom_exterior_wall"} <= failed(layout)


def test_oversized_door_and_wrong_entrance_fail():
    layout = valid_layout()
    door = next(d for d in layout.doors if "laundry" in d.between)
    door.width_ft = 4
    layout.entrance.x += 1
    assert "door_geometry" in failed(layout)


def test_gap_duplicate_id_and_off_grid_fail():
    layout = valid_layout()
    layout.rooms[0].w -= 0.5
    assert "no_overlap_in_footprint" in failed(layout)
    layout = valid_layout()
    layout.rooms[1].id = layout.rooms[0].id
    layout.rooms[2].x += 0.1
    assert "contract_integrity" in failed(layout)


def test_unknown_door_endpoint_fails():
    layout = valid_layout()
    layout.doors.append(Door(between=["ghost", "hall"], x=1, y=15, width_ft=3))
    assert "door_geometry" in failed(layout)
