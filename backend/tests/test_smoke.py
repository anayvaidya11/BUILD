"""Runs offline (no API key): sample program -> solver -> checker -> API."""

import os

os.environ["WALKTHRU_OFFLINE"] = "1"

from fastapi.testclient import TestClient

from walkthru import checker, planner, solver
from walkthru.api import app
from walkthru.schema import Door, Layout


def test_sample_passes_all_rules():
    layout = solver.solve(planner.sample_program())
    checks = checker.check(layout)
    assert all(c.pass_ for c in checks), [c.message for c in checks if not c.pass_]


def test_checker_catches_overlap_and_missing_door():
    layout = solver.solve(planner.sample_program())
    layout.rooms[1].x = layout.rooms[0].x  # stack two rooms
    layout.doors = [d for d in layout.doors if "bedroom_2" not in d.between]
    failed = {c.rule for c in checker.check(layout) if not c.pass_}
    assert {"no_overlap_in_footprint", "all_rooms_reachable", "bedroom_exterior_wall"} <= failed


def test_narrow_door_fails():
    layout = solver.solve(planner.sample_program())
    layout.doors.append(Door(between=["hall", "kitchen"], x=1, y=1, width_ft=2.0))
    assert "min_hall_and_door_width" in {c.rule for c in checker.check(layout) if not c.pass_}


def test_api_sample_and_generate_offline():
    c = TestClient(app)
    s = c.get("/api/sample").json()
    Layout.model_validate(s["layout"])
    assert "pass" in s["layout"]["checks"][0]
    g = c.post("/api/generate", json={"prompt": "3 bed 2 bath"}).json()
    assert all(ch["pass"] for ch in g["layout"]["checks"])
