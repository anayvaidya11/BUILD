"""What the solver does with the whole range of things people type (see prompt_programs.py)."""

import os

os.environ.setdefault("WALKTHRU_OFFLINE", "1")

import pytest

from prompt_programs import ALL, PROMPTS
from test_solver import door_geometry
from walkthru import checker, solver
from walkthru.geometry import solve as solve_dict
from walkthru.schema import RoomProgram


@pytest.mark.parametrize("name", list(ALL))
def test_every_input_tier_passes_first_solve(name):
    layout = solver.solve(RoomProgram.model_validate(ALL[name]))
    failed = [f"{c.rule}: {c.message}" for c in checker.check(layout) if not c.pass_]
    assert not failed, failed
    assert not door_geometry(layout)


@pytest.mark.parametrize("prompt", list(PROMPTS["eval"]) + list(PROMPTS["complex"]))
def test_prompt_fidelity_survives_the_solver(prompt):
    """Role 1's requirements.py counts rooms by type and target size; the solver must not
    drop, add or retype any room it counts. Skipped until requirements.py is on main."""
    requirements = pytest.importorskip("walkthru.requirements")
    program = {**PROMPTS["eval"], **PROMPTS["complex"]}[prompt]
    layout = solver.solve(RoomProgram.model_validate(program))
    assert requirements.mismatches(requirements.parse(prompt), layout.rooms, layout.requested_sqft) == []


def _doors(layout, rid):
    return {tuple(sorted(d["between"])) for d in layout["doors"] if rid in d["between"]}


def test_each_bedroom_keeps_its_own_bath():
    out = solve_dict(PROMPTS["eval"]["3 bed, 3 bath, each bedroom with its own bath, 2,000 sq ft"])
    beds = {"bathroom_1": "primary_bedroom", "bathroom_2": "bedroom_2", "bathroom_3": "bedroom_3"}
    for bath, bed in beds.items():
        assert tuple(sorted((bath, bed))) in _doors(out, bath)  # every bath opens into its bedroom
    assert sum(any("hall" in p for p in _doors(out, b)) for b in beds) == 1  # one also opens to the hall


def test_separate_dining_gets_narrow_openings_open_plan_gets_wide():
    walled = solve_dict(PROMPTS["eval"]["4 bed, 2.5 bath, separate dining and living, 2,300 sq ft"])
    open_ = solve_dict(PROMPTS["eval"]["3 bed, 2 bath, open kitchen, home office, about 1,800 sq ft"])

    def widths(out):
        return [d["width_ft"] for d in out["doors"] if d["kind"] == "opening" and "dining" in d["between"]]

    assert widths(walled) and max(widths(walled)) <= 4
    assert max(widths(open_)) >= 8


def test_garage_named_room_goes_at_the_end_of_the_hall():
    out = solve_dict(next(iter(PROMPTS["complex"].values())))
    garage = next(r for r in out["rooms"] if r["id"] == "garage")
    assert garage["type"] == "closet"  # the planner's type is kept
    assert garage["h"] == out["footprint"]["depth_ft"] and garage["x"] + garage["w"] == out["footprint"]["width_ft"]
    assert _doors(out, "pantry") == {("kitchen", "pantry")}


def test_basic_prompt_gets_a_sensible_default_house():
    out = solve_dict(PROMPTS["basic"]["3 bed 2 bath"])
    fp = out["footprint"]
    assert abs(fp["width_ft"] * fp["depth_ft"] - 1800) / 1800 <= 0.10
    assert {"living", "kitchen", "dining", "hall"} <= {r["type"] for r in out["rooms"]}
