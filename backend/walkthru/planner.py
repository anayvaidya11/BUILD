"""Role 1: AI planner. Prompt -> RoomProgram, plus fix and edit calls.

Uses structured outputs (messages.parse with a Pydantic model), so the response always
matches the schema. Set WALKTHRU_OFFLINE=1 to skip Claude and return a canned program
(useful for UI/3D work without an API key).

Before a program leaves the planner it goes through a preflight: cheap checks that need no
geometry (does it match the prompt's bedroom/bath/office/sq ft counts, are ids and
adjacencies valid, are room sizes and the total plausible). Failures go straight back to
Claude, so the solver and checker only ever see programs that are sane on paper.
The original ask rides along in `notes` as a "requires: ..." line, so later fix and edit
calls still know it without any pipeline change.
"""

from __future__ import annotations

import logging
import os
import re
from typing import TypeVar

import anthropic
from pydantic import BaseModel, Field

from . import prompts, requirements
from .requirements import Requirements
from .schema import Layout, RoomProgram, RoomSpec

MODEL = os.environ.get("WALKTHRU_MODEL", "claude-opus-5-5")
EFFORT = os.environ.get("WALKTHRU_EFFORT", "low")  # low keeps prompt->plan under 30 s
PREFLIGHT_FIXES = 2  # Claude calls allowed to repair a program before it reaches the solver

# Room targets as a share of requested_sqft; the rest is the solver's hallway.
ROOM_SHARE_MIN, ROOM_SHARE_MAX = 0.80, 0.95
MIN_SQFT = {"bedroom": 70, "primary_bedroom": 120, "bathroom": 18, "kitchen": 70, "living": 120, "dining": 70, "office": 50}

log = logging.getLogger("walkthru.planner")
T = TypeVar("T", bound=BaseModel)
_client: anthropic.Anthropic | None = None


class PlannerError(RuntimeError):
    pass


class EditResult(BaseModel):
    """Edit output: Claude must name every room it touched; anything else is restored."""

    changed_room_ids: list[str] = Field(description="ids of rooms added, removed or resized by this edit, and nothing else")
    program: RoomProgram


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


# ---------- the "requires:" line in notes ----------

_REQ_LINE = re.compile(r"\s*\|?\s*requires:[^\n|]*", re.I)


def requirements_of(program: RoomProgram) -> Requirements:
    m = re.search(r"requires:([^\n|]*)", program.notes, re.I)
    return requirements.parse(m.group(1)) if m else Requirements()


def _with_requirements(program: RoomProgram, req: Requirements) -> RoomProgram:
    intent = _REQ_LINE.sub("", program.notes).strip()
    if not req.is_empty():
        intent = f"{intent} | requires: {req.describe()}" if intent else f"requires: {req.describe()}"
    program.notes = intent
    return program


# ---------- preflight ----------


def tidy(program: RoomProgram) -> RoomProgram:
    """Bookkeeping Claude shouldn't have to get right: no halls, symmetric adjacency, no dangling ids."""
    program.rooms = [r for r in program.rooms if r.type != "hall"]
    ids = {r.id for r in program.rooms}
    adj = {r.id: {a for a in r.adjacent_to if a in ids and a != r.id} for r in program.rooms}
    for rid, others in list(adj.items()):
        for o in others:
            adj[o].add(rid)
    for r in program.rooms:
        r.adjacent_to = sorted(adj[r.id])
    program.aspect_ratio = min(max(program.aspect_ratio, 1.0), 2.0)
    return program


def preflight(program: RoomProgram, req: Requirements) -> list[str]:
    """Problems visible without geometry, as plain English for the fix prompt ([] = ok)."""
    errs = requirements.mismatches(req, program.rooms, program.requested_sqft)
    ids = [r.id for r in program.rooms]
    if dupes := sorted({i for i in ids if ids.count(i) > 1}):
        errs.append(f"Room ids must be unique; duplicated: {', '.join(dupes)}")
    if not any(r.type == "bathroom" for r in program.rooms):
        errs.append("The plan has no bathroom")
    for r in program.rooms:
        if r.target_sqft < MIN_SQFT.get(r.type, 0):
            errs.append(f"{r.name} is {r.target_sqft:.0f} sq ft; a {r.type.replace('_', ' ')} needs at least {MIN_SQFT[r.type]}")
    if program.requested_sqft > 0:
        total = sum(r.target_sqft for r in program.rooms)
        share = total / program.requested_sqft
        if not ROOM_SHARE_MIN <= share <= ROOM_SHARE_MAX:
            want = round(0.88 * program.requested_sqft)
            errs.append(
                f"Room targets add up to {total:.0f} sq ft, {share:.0%} of the requested {program.requested_sqft:.0f}; "
                f"they must be {ROOM_SHARE_MIN:.0%}-{ROOM_SHARE_MAX:.0%} (aim for about {want}) so the hallway fits"
            )
    kitchens = [r for r in program.rooms if r.type == "kitchen"]
    social = {r.id for r in program.rooms if r.type in {"dining", "living"}}
    for k in kitchens:
        if social and not (set(k.adjacent_to) & social):
            errs.append(f"{k.name} must list the dining or living room in adjacent_to")
    return errs


def _repair(program: RoomProgram, req: Requirements, errs: list[str]) -> RoomProgram:
    """Send preflight failures back to Claude until the program passes or the budget runs out."""
    for i in range(PREFLIGHT_FIXES):
        if not errs:
            break
        log.info("preflight round %d: %s", i + 1, errs)
        msg = prompts.fix_user_message(program.model_dump_json(indent=2), errs, req.describe())
        program = _with_requirements(tidy(_parse(prompts.FIX_SYSTEM, msg, RoomProgram)), req)
        errs = preflight(program, req)
    if errs:
        log.warning("program still has preflight problems after %d fixes: %s", PREFLIGHT_FIXES, errs)
    return program


# ---------- public API (called by pipeline.py) ----------


def plan(prompt: str) -> RoomProgram:
    if offline():
        return sample_program()
    req = requirements.parse(prompt)
    program = _parse(prompts.PLAN_SYSTEM, prompts.plan_user_message(prompt, req.describe()), RoomProgram)
    program = _with_requirements(tidy(program), req)
    return _repair(program, req, preflight(program, req))


def fix(program: RoomProgram, failures: list[str]) -> RoomProgram:
    if offline():
        return program
    req = requirements_of(program)
    msg = prompts.fix_user_message(program.model_dump_json(indent=2), failures, req.describe())
    fixed = _with_requirements(tidy(_parse(prompts.FIX_SYSTEM, msg, RoomProgram)), req)
    return _repair(fixed, req, preflight(fixed, req))


def edit(program: RoomProgram, instruction: str) -> RoomProgram:
    if offline():
        return program
    msg = prompts.edit_user_message(program.model_dump_json(indent=2), instruction)
    result = _parse(prompts.EDIT_SYSTEM, msg, EditResult)
    edited = keep_untouched(program, result.program, set(result.changed_room_ids))
    edited.aspect_ratio = program.aspect_ratio  # same footprint shape, so the solver can keep rooms in place
    # The edit is the user's new ask: counts follow the edited plan, size follows the edit.
    old = requirements_of(program)
    c = requirements.count(edited.rooms)
    req = Requirements(
        bedrooms=c.bedrooms if old.bedrooms is not None else None,
        full_baths=c.full_baths if old.full_baths is not None else None,
        half_baths=c.half_baths if old.full_baths is not None else None,
        offices_min=c.offices if old.offices_min is not None else None,
        sqft=edited.requested_sqft if old.sqft is not None else None,
    )
    edited = _with_requirements(tidy(edited), req)
    return _repair(edited, req, preflight(edited, req))


def keep_untouched(before: RoomProgram, after: RoomProgram, changed: set[str]) -> RoomProgram:
    """Undo changes to rooms the edit didn't declare: an edit only touches what it names."""
    old = {r.id: r for r in before.rooms}
    new = {r.id: r for r in after.rooms}
    rooms = [old[r.id].model_copy(deep=True) if r.id in old and r.id not in changed else r for r in after.rooms]
    rooms += [r.model_copy(deep=True) for rid, r in old.items() if rid not in new and rid not in changed]
    restored = sorted(rid for rid in old if rid not in changed and new.get(rid) != old[rid])
    if restored:
        log.info("edit guard restored undeclared changes to: %s", restored)
    return after.model_copy(update={"rooms": rooms})


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
