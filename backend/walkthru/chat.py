"""Role 6: conversational design (POST /api/chat).

One turn of the chat: decide whether to ask a question, answer one, edit the current plan
(server-side, via pipeline.edit) or hand a refined brief to /api/generate.

With an API key, Claude makes the decision in one structured-output call (prompts.CHAT_SYSTEM).
Offline (planner.offline()), deterministic keyword heuristics stand in, so the UI can be built
and tested without Claude.
"""

from __future__ import annotations

import logging
import re
from typing import Literal, Optional

from pydantic import BaseModel, Field

from . import pipeline, planner, prompts, requirements
from .schema import ChatMessage, ChatRequest, ChatResponse, GenerateResponse, Layout, Room, RoomProgram

log = logging.getLogger("walkthru.chat")

MAX_QUESTIONS = 2  # questions in a row before we generate with defaults


class ChatDecision(BaseModel):
    """Claude's choice for this turn (structured output)."""

    action: Literal["ask", "answer", "edit", "generate"]
    reply: str = Field(description="one or two short friendly sentences shown in the chat")
    options: list[str] = Field(default_factory=list, description="0-4 short tappable answers or suggested next requests")
    brief: str = Field(default="", description="for generate: the full refined house brief; else empty")
    instruction: str = Field(default="", description="for edit: one clear sentence for the planner; else empty")


# ---------- formatting helpers ----------


def _ft(v: float) -> str:
    return f"{round(v * 2) / 2:g}"


def _sqft(v: float) -> str:
    return f"{round(v):,}"


def _dims(r: Room) -> str:
    return f"{_ft(r.w)} × {_ft(r.h)} ft ({_sqft(r.area)} sq ft)"


def _has_house(req: ChatRequest) -> bool:
    return req.layout is not None and req.program is not None and bool(req.layout.rooms)


def _user_texts(messages: list[ChatMessage]) -> list[str]:
    return [m.content.strip() for m in messages if m.role == "user" and m.content.strip()]


def _questions_in_a_row(messages: list[ChatMessage]) -> int:
    """Assistant turns so far. Before a house exists every assistant turn is a question."""
    return sum(m.role == "assistant" for m in messages)


def _rooms(layout: Layout) -> list[Room]:
    return [r for r in layout.rooms if r.type != "hall"]


def summarize(layout: Layout | None, program: RoomProgram | None) -> str:
    """Compact plan summary for the chat prompt."""
    if layout is None:
        return ""
    fp = layout.footprint
    rooms = _rooms(layout)
    lines = [
        f"Footprint {_ft(fp.width_ft)} × {_ft(fp.depth_ft)} ft ({_sqft(fp.width_ft * fp.depth_ft)} sq ft); "
        f"requested {_sqft(layout.requested_sqft or (program.requested_sqft if program else 0))} sq ft; "
        f"{len(rooms)} rooms totalling {_sqft(sum(r.area for r in rooms))} sq ft (plus hallways)."
    ]
    for r in rooms:
        adj = f", next to {', '.join(r.adjacent_to)}" if r.adjacent_to else ""
        lines.append(f"- {r.name} [{r.id}, {r.type}]: {_dims(r)}, target {_sqft(r.target_sqft)}{adj}")
    failing = [c for c in layout.checks if not c.pass_]
    if failing:
        lines.append("Failing checks: " + "; ".join(f"{c.rule}: {c.message}" for c in failing))
    elif layout.checks:
        lines.append(f"All {len(layout.checks)} checks pass.")
    if program and program.notes:
        lines.append(f"Design notes: {program.notes}")
    return "\n".join(lines)


def _change_summary(before: Layout, after: GenerateResponse) -> str:
    """Exact before/after numbers for rooms that changed, plus the check status."""
    old = {r.id: r for r in _rooms(before)}
    new = {r.id: r for r in _rooms(after.layout)}
    parts = []
    for rid, r in new.items():
        o = old.get(rid)
        if o is None:
            parts.append(f"added {r.name} at {_dims(r)}")
        elif (round(o.w, 1), round(o.h, 1)) != (round(r.w, 1), round(r.h, 1)):
            parts.append(f"{r.name} {_ft(o.w)} × {_ft(o.h)} → {_ft(r.w)} × {_ft(r.h)} ft ({_sqft(o.area)} → {_sqft(r.area)} sq ft)")
    parts += [f"removed {o.name}" for rid, o in old.items() if rid not in new]
    checks = after.layout.checks
    status = (
        f"All {len(checks)} checks still pass." if checks and all(c.pass_ for c in checks)
        else f"{sum(not c.pass_ for c in checks)} check(s) fail." if checks else ""
    )
    if not parts:
        return f"The plan came back unchanged. {status}".strip()
    return (("Changed: " + "; ".join(parts) + ".") + (" " + status if status else "")).strip()


def _run_edit(req: ChatRequest, instruction: str, lead: str, options: list[str] | None = None) -> ChatResponse:
    """pipeline.edit, never a 500: a failed edit becomes an 'answer' explaining what happened."""
    assert req.program is not None and req.layout is not None
    try:
        result = pipeline.edit(req.program, req.layout, instruction)
    except Exception as e:  # noqa: BLE001 - the chat must keep going
        log.warning("chat edit failed (%s): %s", instruction, e)
        return ChatResponse(
            action="answer",
            reply=(
                f"I couldn't make that change ({instruction.rstrip('.')}) without breaking the plan's rules. "
                "Try a smaller change, or take the space from a specific room, e.g. the living room."
            ),
            options=_suggestions(req.layout),
        )
    summary = _change_summary(req.layout, result)
    if summary.startswith("The plan came back unchanged") and planner.offline():
        summary = (
            "The planner is offline (no API key), so the plan came back unchanged. "
            "Edits apply once the live planner is connected."
        )
    return ChatResponse(action="edit", reply=f"{lead.strip()} {summary}".strip(), options=options or _suggestions(result.layout), result=result)


def _suggestions(layout: Layout) -> list[str]:
    rooms = sorted(_rooms(layout), key=lambda r: r.area, reverse=True)
    out = []
    kitchen = next((r for r in rooms if r.type == "kitchen"), None)
    if kitchen:
        out.append(f"Make the {kitchen.name} bigger")
    if not any(r.type == "office" for r in rooms):
        out.append("Add a home office")
    out.append("How big is the house?")
    return out[:3]


# ---------- Claude path ----------


def _transcript(messages: list[ChatMessage]) -> str:
    who = {"user": "Client", "assistant": "You"}
    return "\n".join(f"{who[m.role]}: {m.content.strip()}" for m in messages)


def _claude(req: ChatRequest) -> ChatResponse:
    has_house = _has_house(req)
    asked = _questions_in_a_row(req.messages) if not has_house else 0
    msg = prompts.chat_user_message(_transcript(req.messages), summarize(req.layout, req.program) if has_house else "", asked)
    d = planner._parse(prompts.CHAT_SYSTEM, msg, ChatDecision)
    options = [o.strip() for o in d.options if o.strip()][:4]
    action = d.action
    if action in ("edit", "answer") and not has_house:
        action = "generate"
    if action == "ask" and not has_house and asked >= MAX_QUESTIONS + 1:
        action = "generate"  # hard stop on endless questions
    if action == "generate":
        brief = d.brief.strip() or " ".join(_user_texts(req.messages))
        return ChatResponse(action="generate", reply=d.reply, options=options, brief=brief)
    if action == "edit":
        instruction = d.instruction.strip() or _user_texts(req.messages)[-1]
        return _run_edit(req, instruction, d.reply, options)
    return ChatResponse(action=action, reply=d.reply, options=options)


# ---------- offline heuristics ----------

_NEW_HOUSE = re.compile(
    r"\b(start over|start again|from scratch|new house|different house|another house|new plan|"
    r"different plan|instead)\b"
)
_BIGGER = re.compile(r"\b(bigger|larger|wider|longer|enlarge|expand|grow|increase|more space|more room)\b")
_SMALLER = re.compile(r"\b(smaller|narrower|shorter|shrink|reduce|decrease|less space|tighter)\b")
_STRUCTURAL = re.compile(r"\b(add|remove|delete|drop|get rid of|move|swap|combine|merge|split|put)\b")
_QUESTION = re.compile(r"^(how|what|why|where|which|is|are|does|do|can|could|will|would|tell me)\b|\?\s*$")
_SIZE_WORDS = re.compile(
    r"\b(small|tiny|compact|cozy|cosy|starter|little|medium|mid-size|large|big|spacious|huge|"
    r"family|mansion|sq ?ft|sqft|square feet|square foot|sf)\b"
)
_BED_WORDS = re.compile(r"\b(bed|beds|bedroom|bedrooms|br|bd|studio)\b")

_TYPE_ALIASES: dict[str, set[str]] = {
    "primary bedroom": {"primary_bedroom"}, "master bedroom": {"primary_bedroom"},
    "primary suite": {"primary_bedroom"}, "master suite": {"primary_bedroom"},
    "primary": {"primary_bedroom"}, "master": {"primary_bedroom"},
    "bedrooms": {"bedroom", "primary_bedroom"}, "bedroom": {"bedroom", "primary_bedroom"},
    "bathrooms": {"bathroom"}, "bathroom": {"bathroom"}, "bath": {"bathroom"},
    "living room": {"living"}, "family room": {"living"}, "lounge": {"living"}, "living": {"living"},
    "kitchen": {"kitchen"}, "dining room": {"dining"}, "dining": {"dining"},
    "office": {"office"}, "study": {"office"}, "laundry": {"laundry"}, "entry": {"entry"},
    "foyer": {"entry"}, "closet": {"closet"},
}

ROOM_TYPE_WORDS = re.compile(r"\b(" + "|".join(sorted(map(re.escape, _TYPE_ALIASES), key=len, reverse=True)) + r")\b")


def _find_rooms(text: str, layout: Layout) -> list[Room]:
    """Rooms the text refers to: exact names/ids first, else every room of a mentioned type."""
    rooms = _rooms(layout)
    hits: list[tuple[int, Room]] = []
    for r in rooms:
        for alias in {r.name.lower(), r.id.replace("_", " ")}:
            m = re.search(r"\b" + re.escape(alias) + r"\b", text)
            if m:
                hits.append((m.start(), r))
                break
    if hits:
        # drop rooms whose name is part of another hit's name ("bedroom" vs "primary bedroom")
        names = [r.name.lower() for _, r in hits]
        keep = [(p, r) for p, r in hits if not any(r.name.lower() != n and r.name.lower() in n for n in names)]
        return [r for _, r in sorted(keep, key=lambda t: t[0])]
    m = ROOM_TYPE_WORDS.search(text)
    if m:
        types = _TYPE_ALIASES[m.group(1)]
        return [r for r in rooms if r.type in types]
    return []


def _largest(layout: Layout, n: int = 4) -> list[Room]:
    return sorted(_rooms(layout), key=lambda r: r.area, reverse=True)[:n]


def _defaults_for(text: str) -> tuple[Optional[int], Optional[int]]:
    """(bedrooms, sqft) defaults implied by size words."""
    if re.search(r"\b(studio)\b", text):
        return 1, 700
    if re.search(r"\b(tiny|little)\b", text):
        return 1, 900
    if re.search(r"\b(small|compact|cozy|cosy|starter)\b", text):
        return 2, 1200
    if re.search(r"\b(large|big|spacious|family)\b", text):
        return 4, 2600
    if re.search(r"\b(huge|mansion)\b", text):
        return 5, 3500
    return 3, 1800


def _generate_reply(texts: list[str]) -> ChatResponse:
    brief = ". ".join(t.rstrip(".") for t in texts)
    low = brief.lower()
    req = requirements.parse(brief)
    beds, sqft = _defaults_for(low)
    assumed = []
    if req.bedrooms is None and not re.search(r"\bstudio\b", low):
        assumed.append(f"{beds} bedrooms")
    n_beds = req.bedrooms if req.bedrooms is not None else beds
    if req.full_baths is None:
        n_baths = 1 if n_beds <= 2 else 2 if n_beds <= 4 else 3
        assumed.append(f"{n_baths} bathroom{'s' if n_baths != 1 else ''}")
    if req.sqft is None:
        if not _SIZE_WORDS.search(low):  # no size words: size follows the bedroom count
            sqft = {1: 800, 2: 1200, 3: 1800, 4: 2400}.get(n_beds, 3000)
        assumed.append(f"about {sqft:,} sq ft")
    if assumed:
        brief = f"{brief}. {', '.join(assumed)}"
        reply = f"Great, drawing it now. I assumed {', '.join(assumed)}; you can change anything after."
    else:
        reply = "Great, drawing it now. You can ask for changes once it's up."
    return ChatResponse(action="generate", reply=reply, brief=brief)


_BED_OPTIONS = ["1 bedroom", "2 bedrooms", "3 bedrooms", "4 bedrooms"]
_SIZE_OPTIONS = ["Small, about 1,200 sq ft", "Medium, about 1,800 sq ft", "Large, about 2,500 sq ft"]


def _offline_landing(req: ChatRequest, texts: list[str]) -> ChatResponse:
    joined = " ".join(texts).lower()
    asked = _questions_in_a_row(req.messages)
    has_beds = requirements.parse(joined).bedrooms is not None or bool(_BED_WORDS.search(joined))
    has_size = requirements.parse(joined).sqft is not None or bool(_SIZE_WORDS.search(joined))
    has_digits = bool(re.search(r"\d", joined))
    if asked < MAX_QUESTIONS:
        if not has_beds and not has_size and not has_digits:
            return ChatResponse(action="ask", reply="Happy to design it. How many bedrooms do you need?", options=_BED_OPTIONS)
        if asked >= 1 and has_beds and not has_size:
            return ChatResponse(action="ask", reply="Got it. Roughly how big should the house be?", options=_SIZE_OPTIONS)
    return _generate_reply(texts)


def _answer(text: str, layout: Layout, program: RoomProgram | None) -> ChatResponse:
    found = _find_rooms(text, layout)
    fp = layout.footprint
    rooms = _rooms(layout)
    if found:
        lines = []
        for r in found[:4]:
            line = f"The {r.name} is {_dims(r)}, against a target of {_sqft(r.target_sqft)} sq ft"
            if r.adjacent_to:
                names = {x.id: x.name for x in rooms}
                line += f"; it shares a wall with {', '.join(names.get(a, a) for a in r.adjacent_to)}"
            lines.append(line + ".")
        r0 = found[0]
        return ChatResponse(action="answer", reply=" ".join(lines), options=[f"Make the {r0.name} bigger", f"Make the {r0.name} smaller"])
    total = sum(r.area for r in rooms)
    beds = sum(r.type in requirements.BEDROOM_TYPES for r in rooms)
    baths = sum(r.type == "bathroom" for r in rooms)
    requested = layout.requested_sqft or (program.requested_sqft if program else None)
    reply = (
        f"The house is {_ft(fp.width_ft)} × {_ft(fp.depth_ft)} ft, a {_sqft(fp.width_ft * fp.depth_ft)} sq ft footprint"
        + (f" (you asked for {_sqft(requested)})" if requested else "")
        + f". It has {beds} bedrooms and {baths} bathrooms; the {len(rooms)} rooms add up to {_sqft(total)} sq ft and the rest is hallway."
    )
    failing = [c for c in layout.checks if not c.pass_]
    if layout.checks:
        reply += f" {len(failing)} check(s) fail." if failing else f" All {len(layout.checks)} checks pass."
    return ChatResponse(action="answer", reply=reply, options=_suggestions(layout))


def _size_edit(req: ChatRequest, text: str, bigger: bool) -> ChatResponse:
    assert req.layout is not None
    word = "bigger" if bigger else "smaller"
    found = _find_rooms(text, req.layout)
    if not found:
        rooms = _largest(req.layout)
        return ChatResponse(action="ask", reply=f"Which room should I make {word}?", options=[r.name for r in rooms])
    if len(found) > 1:
        return ChatResponse(action="ask", reply=f"Which one should I make {word}?", options=[r.name for r in found[:4]])
    r = found[0]
    target = round(r.area * (1.2 if bigger else 0.8) / 5) * 5
    # Grow or shrink the house by the difference; taking the area from another room made the
    # solver re-arrange everything, since the pinned layout cannot absorb a smaller unmentioned room.
    take = "growing the house by that amount" if bigger else "shrinking the house by that amount"
    take += " and keeping every other room exactly as it is"
    instruction = f"Make the {r.name} {'larger' if bigger else 'smaller'}, from about {_sqft(r.area)} to {_sqft(target)} sq ft, {take}."
    return _run_edit(req, instruction, f"Making the {r.name} {word} (about {_sqft(r.area)} → {_sqft(target)} sq ft).")


def _offline(req: ChatRequest) -> ChatResponse:
    texts = _user_texts(req.messages)
    if not texts:
        return ChatResponse(action="ask", reply="Describe the house you'd like: how many bedrooms, and roughly how big?", options=_BED_OPTIONS)
    if not _has_house(req):
        return _offline_landing(req, texts)
    layout = req.layout
    assert layout is not None
    text = texts[-1].lower()

    if _NEW_HOUSE.search(text):
        brief = re.sub(r"\b(let'?s |please |can you |i want to )?(start over|start again|from scratch)\b[,.:;!\s-]*", "", texts[-1], flags=re.I).strip()
        brief = re.sub(r"^(actually|instead|no)[,\s]+", "", brief, flags=re.I).strip() or "a new house"
        return _generate_reply([brief])

    # A tapped option ("Kitchen") answers our "which room?" question: reuse the previous request's verb.
    verb_text = text
    prev = req.messages[-2] if len(req.messages) > 1 else None
    if len(texts) > 1 and prev is not None and prev.role == "assistant" and prev.content.lower().startswith("which") \
            and not (_BIGGER.search(text) or _SMALLER.search(text)):
        verb_text = f"{text} {texts[-2].lower()}"

    asking = bool(_QUESTION.search(text)) and not re.search(r"\b(make|can you|could you|please)\b", text)
    if not asking and _BIGGER.search(verb_text):
        return _size_edit(req, verb_text, bigger=True)
    if not asking and _SMALLER.search(verb_text):
        return _size_edit(req, verb_text, bigger=False)
    if _STRUCTURAL.search(text) and not text.startswith(("why", "how", "what", "where")):
        instruction = texts[-1].strip().rstrip(".!?") + "."
        return _run_edit(req, instruction[0].upper() + instruction[1:], "On it.")
    if _QUESTION.search(text) or re.search(r"\b(how big|sq ?ft|square feet|size)\b", text):
        return _answer(text, layout, req.program)
    return ChatResponse(
        action="answer",
        reply="I can resize, add or remove rooms, or answer questions about the plan. What would you like to change?",
        options=_suggestions(layout),
    )


# ---------- entry point ----------


def respond(req: ChatRequest) -> ChatResponse:
    if planner.offline():
        return _offline(req)
    try:
        return _claude(req)
    except Exception as e:  # noqa: BLE001 - API/parse failure: degrade to heuristics, never 500
        log.warning("chat decision failed, using heuristics: %s", e)
        return _offline(req)
