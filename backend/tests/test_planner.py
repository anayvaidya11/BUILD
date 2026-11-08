"""Role 1 planner tests. Offline: a fake client stands in for Claude."""

from types import SimpleNamespace

import pytest

from walkthru import planner, requirements
from walkthru.requirements import Requirements
from walkthru.schema import RoomProgram, RoomSpec


# ---------- requirements parsing ----------


@pytest.mark.parametrize(
    "prompt, beds, full, half, offices, sqft",
    [
        ("3 bed, 2 bath, open kitchen, home office, about 1,800 sq ft", 3, 2, 0, 1, 1800),
        ("3 bedroom, 2.5 bath, two home offices, 2,000 sq ft", 3, 2, 1, 2, 2000),
        ("starter home: 2 bedrooms, 1 bathroom, small kitchen, 1,000 sq ft", 2, 1, 0, None, 1000),
        ("four bedroom house with three baths, 2.4k sq ft", 4, 3, 0, None, 2400),
        ("2 bed, 1 bath, open kitchen, office nook, 1,050 sq ft", 2, 1, 0, None, 1050),
        ("a cozy cabin", None, None, None, None, None),
    ],
)
def test_parse(prompt, beds, full, half, offices, sqft):
    r = requirements.parse(prompt)
    assert (r.bedrooms, r.full_baths, r.half_baths, r.offices_min, r.sqft) == (beds, full, half, offices, sqft)


def test_describe_round_trips():
    r = Requirements(bedrooms=3, full_baths=2, half_baths=1, offices_min=2, sqft=2000)
    assert requirements.parse(r.describe()) == r


def test_mismatches_count_half_baths_and_beds():
    rooms = planner.sample_program().rooms  # 3 beds, 2 full baths, 1 office
    req = requirements.parse("4 bed, 2.5 bath, office, 1,800 sq ft")
    errs = " ".join(requirements.mismatches(req, rooms, 1800))
    assert "4 bedrooms but the plan has 3" in errs
    assert "1 half bath" in errs
    assert requirements.mismatches(requirements.parse("3 bed 2 bath office 1800 sq ft"), rooms, 1800) == []


# ---------- fake Claude ----------


class FakeClaude:
    def __init__(self, outputs):
        self.outputs, self.prompts = list(outputs), []
        self.beta = SimpleNamespace(messages=SimpleNamespace(parse=self._parse))

    def _parse(self, **kw):
        self.prompts.append(kw["messages"][0]["content"])
        out = self.outputs.pop(0)
        assert isinstance(out, kw["output_format"])
        return SimpleNamespace(stop_reason="end_turn", parsed_output=out.model_copy(deep=True), stop_details=None)


@pytest.fixture
def fake(monkeypatch):
    monkeypatch.delenv("WALKTHRU_OFFLINE", raising=False)

    def install(*outputs):
        client = FakeClaude(outputs)
        monkeypatch.setattr(planner, "_client", client)
        return client

    return install


def two_bed_program() -> RoomProgram:
    p = planner.sample_program()
    p.rooms = [r for r in p.rooms if r.id != "bedroom_3"]  # Claude "forgot" a bedroom
    return p


def three_bed_program() -> RoomProgram:
    return planner.sample_program()


PROMPT = "3 bed, 2 bath, open kitchen, home office, about 1,800 sq ft"


# ---------- plan / fix / edit ----------


def test_plan_passes_first_try_with_one_call(fake):
    client = fake(three_bed_program())
    program = planner.plan(PROMPT)
    assert len(client.prompts) == 1
    assert "3 bed, 2 bath, 1+ office, 1800 sq ft" in client.prompts[0]  # requirements spelled out for Claude
    assert "requires: 3 bed, 2 bath, 1+ office, 1800 sq ft" in program.notes


def test_plan_repairs_a_missing_bedroom_before_the_solver(fake):
    client = fake(two_bed_program(), three_bed_program())
    program = planner.plan(PROMPT)
    assert sum(r.type in {"bedroom", "primary_bedroom"} for r in program.rooms) == 3
    assert "asks for 3 bedrooms but the plan has 2" in client.prompts[1]


def test_preflight_catches_bad_totals_and_tiny_rooms():
    p = three_bed_program()
    p.rooms[2].target_sqft = 40  # bedroom_2 too small, and total drops
    p.requested_sqft = 3000  # rooms are now far under 80% of the total
    errs = " ".join(planner.preflight(p, Requirements()))
    assert "needs at least 70" in errs and "Room targets add up to" in errs


def test_tidy_makes_adjacency_symmetric_and_drops_halls():
    p = three_bed_program()
    p.rooms.append(RoomSpec(id="hall", type="hall", name="Hall", target_sqft=100))
    p.rooms[6].adjacent_to = ["dining", "ghost_room"]  # kitchen
    p = planner.tidy(p)
    assert "hall" not in {r.id for r in p.rooms}
    assert "ghost_room" not in next(r for r in p.rooms if r.id == "kitchen").adjacent_to
    assert "kitchen" in next(r for r in p.rooms if r.id == "dining").adjacent_to


def test_undersized_program_is_rescaled_without_a_claude_call(fake):
    p = three_bed_program()
    for r in p.rooms:
        r.target_sqft *= 0.85  # rooms ~74% of requested, like the live run's 78%
    p.rooms.append(RoomSpec(id="half_bath", type="bathroom", name="Half Bath", target_sqft=35))
    client = fake(p)
    program = planner.plan(PROMPT.replace("2 bath", "2.5 bath"))
    assert len(client.prompts) == 1  # no repair round needed
    share = sum(r.target_sqft for r in program.rooms) / program.requested_sqft
    assert 0.85 <= share <= 0.91
    c = requirements.count(program.rooms)
    assert (c.full_baths, c.half_baths) == (2, 1)  # scaling kept the half bath a half bath


def test_fix_keeps_the_original_requirements(fake):
    fake(three_bed_program())
    program = planner.plan(PROMPT)
    client = fake(two_bed_program(), three_bed_program())  # checker fix drops a bedroom, preflight catches it
    fixed = planner.fix(program, ["kitchen_adjacent: Kitchen does not share a wall with the dining or living area"])
    assert "Original requirements (must still match): 3 bed" in client.prompts[0]
    assert len(client.prompts) == 2
    assert sum(r.type in {"bedroom", "primary_bedroom"} for r in fixed.rooms) == 3


def test_edit_restores_undeclared_changes(fake):
    fake(three_bed_program())
    before = planner.plan(PROMPT)
    after = before.model_copy(deep=True)
    sizes = {r.id: r for r in after.rooms}
    sizes["kitchen"].target_sqft = 260
    sizes["living"].target_sqft = 370  # declared: shrinks to make room
    sizes["office"].target_sqft = 60  # NOT declared: must be restored
    after.aspect_ratio = 1.9  # footprint shape must not change on an edit
    fake(planner.EditResult(changed_room_ids=["kitchen", "living"], program=after))
    edited = planner.edit(before, "make the kitchen bigger")
    got = {r.id: r.target_sqft for r in edited.rooms}
    assert (got["kitchen"], got["living"], got["office"]) == (260, 370, 110)
    assert edited.aspect_ratio == before.aspect_ratio


def test_edit_updates_requirements_when_rooms_are_added(fake):
    fake(three_bed_program())
    before = planner.plan(PROMPT)
    after = before.model_copy(deep=True)
    after.rooms.append(RoomSpec(id="bedroom_4", type="bedroom", name="Bedroom 4", target_sqft=120))
    after.requested_sqft = 1940
    fake(planner.EditResult(changed_room_ids=["bedroom_4"], program=after))
    edited = planner.edit(before, "add a fourth bedroom")
    assert "requires: 4 bed" in edited.notes
    assert planner.preflight(edited, planner.requirements_of(edited)) == []


def test_offline_mode_never_calls_claude(monkeypatch):
    monkeypatch.setenv("WALKTHRU_OFFLINE", "1")
    monkeypatch.setattr(planner, "_client", None)
    assert planner.plan("anything") == planner.sample_program()
