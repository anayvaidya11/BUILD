"""Role 1: what the prompt explicitly asked for, and whether a plan honors it.

Shared with role 3's prompt_fidelity rule, so both judge "matches the prompt" the same way.
Only unambiguous requests are parsed: an explicit bedroom count, bathroom count (2.5 =
2 full + 1 half), office count (a bare "office" or "study" means at least one), and total
square feet. Anything the prompt doesn't state stays None and is never checked.

Counting rules:
- bedroom  = type bedroom or primary_bedroom
- bathroom = type bathroom; a half bath is a bathroom under HALF_BATH_MAX_SQFT
- office   = type office
- sqft     = RoomProgram.requested_sqft / Layout.requested_sqft, within SQFT_TOL
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Iterable, Optional

from .schema import RoomSpec

HALF_BATH_MAX_SQFT = 45
SQFT_TOL = 0.05
BEDROOM_TYPES = {"bedroom", "primary_bedroom"}

_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8}
_NUM = r"(\d+(?:\.\d+)?|" + "|".join(_WORDS) + r")"


def _num(tok: str) -> float:
    tok = tok.lower()
    return float(_WORDS[tok]) if tok in _WORDS else float(tok)


@dataclass(frozen=True)
class Requirements:
    bedrooms: Optional[int] = None
    full_baths: Optional[int] = None
    half_baths: Optional[int] = None
    offices_min: Optional[int] = None
    sqft: Optional[float] = None

    def is_empty(self) -> bool:
        return all(v is None for v in (self.bedrooms, self.full_baths, self.offices_min, self.sqft))

    def describe(self) -> str:
        """Round-trips through parse(): parse(req.describe()) == req."""
        parts = []
        if self.bedrooms is not None:
            parts.append(f"{self.bedrooms} bed")
        if self.full_baths is not None:
            baths = self.full_baths + 0.5 * (self.half_baths or 0)
            parts.append(f"{baths:g} bath")
        if self.offices_min:
            parts.append(f"{self.offices_min}+ office")
        if self.sqft is not None:
            parts.append(f"{self.sqft:.0f} sq ft")
        return ", ".join(parts)


def parse(text: str) -> Requirements:
    t = text.lower().replace(",", "")
    t = re.sub(r"(\d+(?:\.\d+)?)\s*k\b", lambda m: str(round(float(m.group(1)) * 1000)), t)  # "2.4k sq ft"

    beds = re.search(_NUM + r"\s*-?\s*(?:bedrooms?|beds?|br|bd)\b", t)
    baths = re.search(_NUM + r"\s*-?\s*(?:bathrooms?|baths?|ba)\b", t)
    offices = re.search(_NUM + r"\+?\s*(?:home\s+)?(?:offices?|studies|study)\b", t)
    sqft = re.search(r"(\d{3,5})\s*\+?\s*(?:sq\.?\s*ft|sqft|square\s+feet|sf)\b", t)

    full = half = None
    if baths:
        n = _num(baths.group(1))
        full, half = int(math.floor(n)), (1 if n % 1 else 0)
    if offices:
        office_min = int(_num(offices.group(1)))
    elif re.search(r"\b(?:office|study)\b(?!\s+(?:nook|corner|area|space))", t):  # a nook isn't a room
        office_min = 1
    else:
        office_min = None

    return Requirements(
        bedrooms=int(_num(beds.group(1))) if beds else None,
        full_baths=full,
        half_baths=half,
        offices_min=office_min,
        sqft=float(sqft.group(1)) if sqft else None,
    )


@dataclass(frozen=True)
class Counts:
    bedrooms: int
    full_baths: int
    half_baths: int
    offices: int


def count(rooms: Iterable[RoomSpec]) -> Counts:
    rooms = list(rooms)
    baths = [r for r in rooms if r.type == "bathroom"]
    half = sum(1 for r in baths if r.target_sqft < HALF_BATH_MAX_SQFT)
    return Counts(
        bedrooms=sum(1 for r in rooms if r.type in BEDROOM_TYPES),
        full_baths=len(baths) - half,
        half_baths=half,
        offices=sum(1 for r in rooms if r.type == "office"),
    )


def mismatches(req: Requirements, rooms: Iterable[RoomSpec], requested_sqft: Optional[float] = None) -> list[str]:
    """Plain-English list of ways the plan misses the prompt ([] = matches)."""
    c = count(rooms)
    errs = []
    if req.bedrooms is not None and c.bedrooms != req.bedrooms:
        errs.append(f"The prompt asks for {req.bedrooms} bedrooms but the plan has {c.bedrooms}")
    if req.full_baths is not None and c.full_baths != req.full_baths:
        errs.append(
            f"The prompt asks for {req.full_baths} full bathrooms but the plan has {c.full_baths} "
            f"(a bathroom under {HALF_BATH_MAX_SQFT} sq ft counts as a half bath)"
        )
    if req.half_baths is not None and c.half_baths != req.half_baths:
        errs.append(
            f"The prompt asks for {req.half_baths} half bath{'s' if req.half_baths != 1 else ''} "
            f"but the plan has {c.half_baths} (half bath = bathroom under {HALF_BATH_MAX_SQFT} sq ft)"
        )
    if req.offices_min is not None and c.offices < req.offices_min:
        errs.append(f"The prompt asks for {req.offices_min} office(s) but the plan has {c.offices}")
    if req.sqft is not None and requested_sqft is not None and abs(requested_sqft - req.sqft) > SQFT_TOL * req.sqft:
        errs.append(f"The prompt asks for {req.sqft:.0f} sq ft but requested_sqft is {requested_sqft:.0f}")
    return errs
