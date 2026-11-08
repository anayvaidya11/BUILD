"""Map the canonical frame (u along the hallway, v across) onto the real footprint.

Real frame (the layout JSON contract): origin at the footprint's top-left
corner, x to the east, y to the south (down the page), units in feet.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from .geom import Rect

_FLIP_U = {"west": "east", "east": "west"}
_FLIP_V = {"north": "south", "south": "north"}
_SWAP = {"west": "north", "east": "south", "north": "west", "south": "east"}


@dataclass
class Transform:
    swap: bool    # True: canonical u runs along real y (deep footprints)
    flip_u: bool
    flip_v: bool
    L: float = 1.0
    H: float = 1.0

    @property
    def W(self) -> float:
        return self.H if self.swap else self.L

    @property
    def D(self) -> float:
        return self.L if self.swap else self.H

    def rect(self, r: Rect) -> Rect:
        u0, u1, v0, v1 = r.x, r.x2, r.y, r.y2
        if self.flip_u:
            u0, u1 = self.L - u1, self.L - u0
        if self.flip_v:
            v0, v1 = self.H - v1, self.H - v0
        if self.swap:
            return Rect(v0, u0, v1 - v0, u1 - u0)
        return Rect(u0, v0, u1 - u0, v1 - v0)

    def side(self, s: str) -> str:
        if self.flip_u:
            s = _FLIP_U.get(s, s)
        if self.flip_v:
            s = _FLIP_V.get(s, s)
        if self.swap:
            s = _SWAP[s]
        return s


def entry_face_for(swap: bool, desired_side: str) -> str:
    """Canonical face that can be mapped onto the desired real entrance side."""
    # canonical "south" maps to real north/south unswapped, east/west when swapped
    south_maps_to = ("east", "west") if swap else ("north", "south")
    return "south" if desired_side in south_maps_to else "west"


def choose_transform(swap: bool, entry_face: str, desired_side: str,
                     hint_pos: Optional[float]) -> Transform:
    """Pick flips so the front door ends up on desired_side and, if the planner
    gave an entrance point, the public block sits near it."""
    options = []
    for fu in (False, True):
        for fv in (False, True):
            t = Transform(swap, fu, fv)
            if t.side(entry_face) != desired_side:
                continue
            # Where along the entrance wall does the entrance room land (low/high end)?
            probe = t.side("west") if entry_face == "south" else t.side("south")
            low = probe in ("west", "north")
            miss = 0 if hint_pos is None or (hint_pos < 0.5) == low else 1
            options.append((miss, fu + fv, t))
    if not options:  # can't happen with entry_face_for(); keep a safe default
        return Transform(swap, False, False)
    options.sort(key=lambda o: (o[0], o[1]))
    return options[0][2]
