"""Room-type vocabulary shared by the solver, the self-check and the renderer.

The solver normalizes whatever `type` string the planner sends into one of
CANONICAL_TYPES, and every downstream consumer (checker, 2D, 3D) can rely on
those values.
"""
from __future__ import annotations

import re

# RoomType in walkthru/schema.py. Output `type` must be one of these.
CONTRACT_TYPES = frozenset({
    "living", "kitchen", "dining", "bedroom", "primary_bedroom", "bathroom",
    "office", "laundry", "entry", "hall", "closet",
})
# Internal type -> contract type, for rooms whose input type wasn't already a contract type.
TO_CONTRACT = {
    "living": "living", "family": "living", "dining": "dining", "kitchen": "kitchen",
    "foyer": "entry", "bedroom": "bedroom", "bathroom": "bathroom", "half_bath": "bathroom",
    "office": "office", "laundry": "laundry", "mudroom": "laundry", "closet": "closet",
    "pantry": "closet", "garage": "closet", "hallway": "hall", "other": "office",
}

CANONICAL_TYPES = (
    "living", "family", "dining", "kitchen", "foyer",
    "bedroom", "bathroom", "half_bath", "office",
    "laundry", "closet", "pantry", "mudroom", "garage",
    "hallway", "other",
)

# Rooms that live in the open-plan "public block" next to the entrance.
PUBLIC = frozenset({"living", "family", "dining", "kitchen"})
# Rooms that get wide cased openings (no door leaf) between each other.
OPEN_PLAN = PUBLIC | {"foyer"}
# Small rooms that may be stacked two-deep in a band column.
SMALL_STACKABLE = frozenset({"bathroom", "half_bath", "laundry", "closet", "pantry", "mudroom"})

# Default target size when the planner leaves target_sqft out.
DEFAULT_SQFT = {
    "living": 280, "family": 240, "dining": 140, "kitchen": 160, "foyer": 50,
    "bedroom": 140, "bathroom": 55, "half_bath": 25, "office": 110,
    "laundry": 45, "closet": 25, "pantry": 25, "mudroom": 45, "garage": 420,
    "hallway": 80, "other": 120,
}

# Soft limits used only for scoring candidate layouts (not hard rules).
MIN_DIM = {
    "living": 11, "family": 10, "dining": 9, "kitchen": 8, "foyer": 4,
    "bedroom": 9.5, "bathroom": 5, "half_bath": 3.5, "office": 7,
    "laundry": 4.5, "closet": 2.5, "pantry": 3, "mudroom": 5, "garage": 11,
    "hallway": 3, "other": 8,
}
MAX_ASPECT = {
    "living": 1.7, "family": 1.7, "dining": 1.6, "kitchen": 1.8, "foyer": 3.5,
    "bedroom": 1.5, "bathroom": 2.3, "half_bath": 2.5, "office": 1.6,
    "laundry": 2.8, "closet": 3.5, "pantry": 3.5, "mudroom": 2.5, "garage": 1.7,
    "hallway": 99.0, "other": 1.7,
}
WEIGHT = {
    "living": 3.0, "family": 2.5, "dining": 2.0, "kitchen": 2.5, "foyer": 0.7,
    "bedroom": 4.0, "bathroom": 1.5, "half_bath": 1.0, "office": 2.0,
    "laundry": 1.0, "closet": 0.4, "pantry": 0.5, "mudroom": 1.0, "garage": 1.0,
    "hallway": 0.0, "other": 2.0,
}

# How "public" a room is (lower = more public). Doors swing into the more
# private room, and connectivity repair prefers to route through public rooms.
PUBLICNESS = {
    "hallway": 0, "foyer": 1, "living": 2, "family": 2, "dining": 3, "kitchen": 4,
    "mudroom": 5, "laundry": 6, "office": 6, "other": 6, "garage": 7,
    "half_bath": 8, "bathroom": 8, "bedroom": 9, "pantry": 9, "closet": 10,
}

_EXACT = {t: t for t in CANONICAL_TYPES}
_EXACT.update({
    "living_room": "living", "livingroom": "living", "great_room": "living", "greatroom": "living",
    "family_room": "family", "dining_room": "dining", "kitchenette": "kitchen",
    "entry": "foyer", "entryway": "foyer", "entrance": "foyer",
    "bed": "bedroom", "primary_bedroom": "bedroom", "master_bedroom": "bedroom",
    "bath": "bathroom", "full_bath": "bathroom", "ensuite": "bathroom",
    "powder_room": "half_bath", "powder": "half_bath", "halfbath": "half_bath",
    "study": "office", "den": "office", "home_office": "office",
    "utility": "laundry", "laundry_room": "laundry", "walk_in_closet": "closet", "wic": "closet",
    "hall": "hallway", "corridor": "hallway",
})

# Ordered: earlier entries win ("hall bath" -> bathroom, "hall closet" -> closet).
_KEYWORDS = (
    ("half_bath", ("half_bath", "halfbath", "half", "powder", "wc", "toilet", "lavatory")),
    ("bathroom", ("bath", "ensuite", "en_suite", "shower")),
    ("closet", ("closet", "wic", "wardrobe", "storage", "linen")),
    ("pantry", ("pantry", "larder")),
    ("laundry", ("laundry", "utility", "washer")),
    ("mudroom", ("mud",)),
    ("garage", ("garage", "carport")),
    ("kitchen", ("kitchen",)),
    ("dining", ("dining", "breakfast", "nook", "eat_in")),
    ("foyer", ("foyer", "entry", "entrance", "vestibule", "lobby")),
    ("bedroom", ("bed", "nursery", "master", "primary", "guest", "kids", "sleep", "suite")),
    ("office", ("office", "study", "den", "library", "workspace")),
    ("living", ("living", "great", "lounge", "sitting", "parlor")),
    ("family", ("family", "rec_room", "recreation")),
    ("hallway", ("hall", "corridor", "passage")),
)


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(text).lower()).strip("_")


def _match(text: str):
    s = slug(text)
    if not s:
        return None
    if s in _EXACT:
        return _EXACT[s]
    tokens = [t for t in s.split("_") if t]
    for ctype, words in _KEYWORDS:
        for w in words:
            if len(w) >= 4 or "_" in w:
                if w in s:
                    return ctype
            elif any(tok.startswith(w) for tok in tokens):
                return ctype
    return None


def canonical_type(raw_type, name: str = "", rid: str = "") -> str:
    """Map a free-form room type (plus name/id as fallbacks) to a canonical type."""
    for text in (raw_type, name, rid):
        if text:
            t = _match(str(text))
            if t:
                return t
    return "other"
