"""POST /api/chat: offline heuristics (WALKTHRU_OFFLINE=1) plus the Claude path with a fake client."""

import os

os.environ["WALKTHRU_OFFLINE"] = "1"

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from walkthru import chat, pipeline, planner
from walkthru.api import app
from walkthru.schema import ChatResponse, GenerateResponse

client = TestClient(app)


@pytest.fixture(scope="module")
def house():
    return client.get("/api/sample").json()


def turn(messages, house=None):
    body = {
        "messages": [{"role": r, "content": t} for r, t in messages],
        "program": house["program"] if house else None,
        "layout": house["layout"] if house else None,
    }
    resp = client.post("/api/chat", json=body)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    ChatResponse.model_validate(data)
    assert len(data["options"]) <= 4
    return data


# ---------- landing (no house yet) ----------


def test_vague_brief_asks_bedrooms():
    r = turn([("user", "a house")])
    assert r["action"] == "ask" and "bedroom" in r["reply"].lower()
    assert "3 bedrooms" in r["options"] and r["brief"] is None and r["result"] is None


def test_second_question_is_size_then_generates():
    convo = [("user", "a house"), ("assistant", "How many bedrooms do you need?"), ("user", "3 bedrooms")]
    r = turn(convo)
    assert r["action"] == "ask" and any("sq ft" in o for o in r["options"])
    r = turn(convo + [("assistant", "Roughly how big?"), ("user", "Medium, about 1,800 sq ft")])
    assert r["action"] == "generate"
    assert "3 bedrooms" in r["brief"] and "1,800 sq ft" in r["brief"]


def test_stops_asking_after_two_questions():
    convo = [("user", "a house"), ("assistant", "How many bedrooms?"), ("user", "not sure"),
             ("assistant", "How big?"), ("user", "whatever you think")]
    r = turn(convo)
    assert r["action"] == "generate" and "assumed" in r["reply"]
    assert "bedrooms" in r["brief"] and "sq ft" in r["brief"]


def test_clear_brief_generates():
    r = turn([("user", "3 bed 2 bath with a home office, about 2,000 sq ft")])
    assert r["action"] == "generate"
    assert r["brief"].startswith("3 bed 2 bath with a home office, about 2,000 sq ft")
    assert r["result"] is None


def test_size_word_alone_generates_with_assumed_defaults():
    r = turn([("user", "a small cabin")])
    assert r["action"] == "generate" and "2 bedrooms" in r["brief"] and "1,200 sq ft" in r["brief"]


# ---------- with a house ----------


def test_ambiguous_edit_asks_with_room_options(house):
    r = turn([("user", "make it bigger")], house)
    assert r["action"] == "ask"
    names = {room["name"] for room in house["layout"]["rooms"]}
    assert 1 <= len(r["options"]) <= 4 and set(r["options"]) <= names
    assert r["options"][0] == "Living Room"  # largest first


def test_ambiguous_room_type_asks_which(house):
    r = turn([("user", "make the bedroom bigger")], house)
    assert r["action"] == "ask"
    assert set(r["options"]) == {"Primary Bedroom", "Bedroom 2", "Bedroom 3"}


def test_concrete_edit_returns_result(house):
    r = turn([("user", "make the kitchen bigger")], house)
    assert r["action"] == "edit" and "Kitchen" in r["reply"]
    res = GenerateResponse.model_validate(r["result"])
    assert all(c.pass_ for c in res.layout.checks)
    assert "offline" in r["reply"]  # offline planner can't change the plan: say so


def test_tapped_room_option_completes_edit(house):
    r = turn([("user", "make it bigger"), ("assistant", "Which room should I make bigger?"), ("user", "Kitchen")], house)
    assert r["action"] == "edit" and r["result"] is not None and "Kitchen" in r["reply"]


def test_room_size_question_answers(house):
    kitchen = next(x for x in house["layout"]["rooms"] if x["id"] == "kitchen")
    r = turn([("user", "how big is the kitchen?")], house)
    assert r["action"] == "answer" and r["result"] is None
    assert f"{round(kitchen['w'] * kitchen['h'])} sq ft" in r["reply"]


def test_house_size_question_answers(house):
    r = turn([("user", "how many sq ft is the house?")], house)
    assert r["action"] == "answer" and "sq ft" in r["reply"] and "checks pass" in r["reply"]


def test_start_over_generates(house):
    r = turn([("user", "start over: a 4 bed 3 bath ranch")], house)
    assert r["action"] == "generate" and r["brief"].startswith("a 4 bed 3 bath ranch")


def test_failed_edit_answers_instead_of_500(house, monkeypatch):
    def boom(*a, **k):
        raise pipeline.GenerationFailed("no valid plan")

    monkeypatch.setattr(pipeline, "edit", boom)
    r = turn([("user", "make the kitchen bigger")], house)
    assert r["action"] == "answer" and "couldn't" in r["reply"] and r["result"] is None


# ---------- Claude path (fake client) ----------


class FakeClaude:
    def __init__(self, decision):
        self.decision, self.calls = decision, []
        self.beta = SimpleNamespace(messages=SimpleNamespace(parse=self._parse))

    def _parse(self, **kw):
        self.calls.append(kw)
        assert kw["output_format"] is chat.ChatDecision
        return SimpleNamespace(stop_reason="end_turn", parsed_output=self.decision, stop_details=None)


@pytest.fixture
def online(monkeypatch):
    monkeypatch.setenv("WALKTHRU_OFFLINE", "0")

    def install(decision):
        fake = FakeClaude(decision)
        monkeypatch.setattr(planner, "_client", fake)
        return fake

    return install


def test_claude_edit_runs_pipeline_with_instruction(house, online, monkeypatch):
    fake = online(chat.ChatDecision(action="edit", reply="Making the kitchen bigger.",
                                    instruction="Make the Kitchen about 20% larger."))
    seen = {}

    def fake_edit(program, layout, instruction):
        seen["instruction"] = instruction
        return GenerateResponse(layout=layout, program=program, rounds=[], elapsed_s=0)

    monkeypatch.setattr(pipeline, "edit", fake_edit)
    r = turn([("user", "bigger kitchen please")], house)
    assert r["action"] == "edit" and seen["instruction"] == "Make the Kitchen about 20% larger."
    assert r["reply"].startswith("Making the kitchen bigger.")
    user_msg = fake.calls[0]["messages"][0]["content"]
    assert "Kitchen [kitchen, kitchen]" in user_msg and "Client: bigger kitchen please" in user_msg


def test_claude_generate_without_house(online):
    online(chat.ChatDecision(action="generate", reply="Drawing a 3 bed.", brief="3 bed, 2 bath, about 1,800 sq ft"))
    r = turn([("user", "3 bedrooms")])
    assert r["action"] == "generate" and r["brief"] == "3 bed, 2 bath, about 1,800 sq ft"
