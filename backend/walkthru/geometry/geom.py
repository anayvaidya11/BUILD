"""Tiny axis-aligned geometry helpers. All units are feet."""
from __future__ import annotations

from dataclasses import dataclass

import math

EPS = 1e-6
GRID = 0.5  # docs/CONTRACTS.md: rooms, doors and windows sit on a 0.5 ft grid (walls.ts relies on it)


def snap(v: float, grid: float = GRID) -> float:
    return round(round(v / grid) * grid, 6)


def snap_down(v: float, grid: float = GRID) -> float:
    return round(math.floor(v / grid + 1e-9) * grid, 6)


def snap_up(v: float, grid: float = GRID) -> float:
    return round(math.ceil(v / grid - 1e-9) * grid, 6)


def r2(v: float) -> float:
    """Round for JSON output (keeps 0.25-grid values exact)."""
    out = round(v, 3)
    return 0.0 if out == 0 else out


@dataclass
class Rect:
    x: float
    y: float
    w: float
    h: float

    @property
    def x2(self) -> float:
        return self.x + self.w

    @property
    def y2(self) -> float:
        return self.y + self.h

    @property
    def area(self) -> float:
        return self.w * self.h

    @property
    def cx(self) -> float:
        return self.x + self.w / 2

    @property
    def cy(self) -> float:
        return self.y + self.h / 2

    def aspect(self) -> float:
        lo = min(self.w, self.h)
        return max(self.w, self.h) / lo if lo > EPS else 1e9


def overlap_1d(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


def intersection_area(a: Rect, b: Rect) -> float:
    return overlap_1d(a.x, a.x2, b.x, b.x2) * overlap_1d(a.y, a.y2, b.y, b.y2)


def shared_edge(a: Rect, b: Rect):
    """Shared wall between two touching rectangles.

    Returns (orientation, coord, s0, s1) where orientation is the direction the
    wall runs ("vertical" = constant x, "horizontal" = constant y), coord is
    that constant, and [s0, s1] is the overlap along the wall. None if the
    rectangles don't share a wall of positive length.
    """
    for ax, bx in ((a.x2, b.x), (a.x, b.x2)):
        if abs(ax - bx) < EPS:
            s0, s1 = max(a.y, b.y), min(a.y2, b.y2)
            if s1 - s0 > EPS:
                return ("vertical", ax, s0, s1)
    for ay, by in ((a.y2, b.y), (a.y, b.y2)):
        if abs(ay - by) < EPS:
            s0, s1 = max(a.x, b.x), min(a.x2, b.x2)
            if s1 - s0 > EPS:
                return ("horizontal", ay, s0, s1)
    return None


def exterior_edges(r: Rect, W: float, D: float, rooms=None):
    """Edges of r that lie on the footprint boundary: list of (side, orientation, coord, s0, s1)."""
    if rooms is not None:
        out = []
        for side, orient, coord, start, end in (
            ("north", "horizontal", r.y, r.x, r.x2),
            ("south", "horizontal", r.y2, r.x, r.x2),
            ("west", "vertical", r.x, r.y, r.y2),
            ("east", "vertical", r.x2, r.y, r.y2),
        ):
            spans = [(start, end)]
            for other in rooms:
                if other is r:
                    continue
                touching = (abs(other.y2 - coord) < EPS if side == "north" else
                            abs(other.y - coord) < EPS if side == "south" else
                            abs(other.x2 - coord) < EPS if side == "west" else
                            abs(other.x - coord) < EPS)
                if not touching:
                    continue
                a, b = (other.x, other.x2) if orient == "horizontal" else (other.y, other.y2)
                spans = [(lo, hi) for s0, s1 in spans for lo, hi in
                         ((s0, min(s1, a)), (max(s0, b), s1)) if hi - lo > EPS]
            out.extend((side, orient, coord, a, b) for a, b in spans)
        return out
    out = []
    if abs(r.y) < EPS:
        out.append(("north", "horizontal", 0.0, r.x, r.x2))
    if abs(r.y2 - D) < EPS:
        out.append(("south", "horizontal", D, r.x, r.x2))
    if abs(r.x) < EPS:
        out.append(("west", "vertical", 0.0, r.y, r.y2))
    if abs(r.x2 - W) < EPS:
        out.append(("east", "vertical", W, r.y, r.y2))
    return out
