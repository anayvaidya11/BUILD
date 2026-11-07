"""Role 1: AI planner. Prompt -> RoomProgram, plus fix and edit calls.

Uses structured outputs (messages.parse with a Pydantic model), so the response always
matches the schema. Set WALKTHRU_OFFLINE=1 to skip Claude and return a canned program
(useful for UI/3D work without an API key).
"""

from __future__ import annotations

import os
from typing import TypeVar

import anthropic
from pydantic import BaseModel

from . import prompts
from .schema import Layout, RoomProgram, RoomSpec

MODEL = os.environ.get("WALKTHRU_MODEL", "claude-opus-5-5")
EFFORT = os.environ.get("WALKTHRU_EFFORT", "low")  # low keeps prompt->plan under 30 s

T = TypeVar("T", bound=BaseModel)
_client: anthropic.Anthropic | None = None


class PlannerError(RuntimeError):
    pass


def offline() -> bool:
    return os.environ.get("WALKTHRU_OFFLINE") == "1"


def _client_() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic()
    return _client


def _parse(system: str, user: str, model_cls: type[T]) -> T:
    resp = _client_().beta.messages.parse(
        model=MODEL,
        max_tokens=16000,
        system=system,
        messages=[{"role": "user", "content": user}],
        output_format=model_cls,
        output_config={"effort": EFFORT},
        # Server-side fallback if a safety classifier declines the request.
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    )
    if resp.stop_reason == "refusal":
        raise PlannerError(f"Claude declined: {resp.stop_details}")
    if resp.stop_reason == "max_tokens" or resp.parsed_output is None:
        raise PlannerError(f"no parsed output (stop_reason={resp.stop_reason})")
    return resp.parsed_output


def plan(prompt: str) -> RoomProgram:
    if offline():
        return sample_program()
    return _parse(prompts.PLAN_SYSTEM, prompt, RoomProgram)


def fix(program: RoomProgram, failures: list[str]) -> RoomProgram:
    if offline():
        return program
    msg = prompts.fix_user_message(program.model_dump_json(indent=2), failures)
    return _parse(prompts.FIX_SYSTEM, msg, RoomProgram)


def edit(program: RoomProgram, instruction: str) -> RoomProgram:
    if offline():
        return program
    msg = prompts.edit_user_message(program.model_dump_json(indent=2), instruction)
    return _parse(prompts.EDIT_SYSTEM, msg, RoomProgram)


def raw_layout(prompt: str) -> Layout:
    """Claude alone, drawing exact geometry. Used only by the eval baseline (role 3)."""
    return _parse(prompts.RAW_LAYOUT_SYSTEM, prompt, Layout)


def sample_program() -> RoomProgram:
    r = lambda i, t, n, s, adj=(): RoomSpec(id=i, type=t, name=n, target_sqft=s, adjacent_to=list(adj))
    return RoomProgram(
        requested_sqft=1800,
        aspect_ratio=1.4,
        notes="3 bed, 2 bath, open kitchen, home office",
        rooms=[
            r("primary_bedroom", "primary_bedroom", "Primary Bedroom", 250, ["bathroom_1"]),
            r("bathroom_1", "bathroom", "Primary Bath", 70, ["primary_bedroom"]),
            r("bedroom_2", "bedroom", "Bedroom 2", 130),
            r("bathroom_2", "bathroom", "Bath 2", 55),
            r("bedroom_3", "bedroom", "Bedroom 3", 125),
            r("office", "office", "Office", 110),
            r("kitchen", "kitchen", "Kitchen", 210, ["dining"]),
            r("dining", "dining", "Dining", 150, ["kitchen", "living"]),
            r("living", "living", "Living Room", 420, ["dining"]),
            r("laundry", "laundry", "Laundry", 45),
        ],
    )
