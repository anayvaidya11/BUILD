"""Orthogonal footprint boundary derived from the union of grid-aligned rooms."""
from __future__ import annotations

from collections import deque

from .geom import GRID, Rect


def outline(rects: dict[str, Rect]) -> tuple[list[dict], list[list[dict]]]:
    occupied: set[tuple[int, int]] = set()
    for r in rects.values():
        x0, x1 = round(r.x / GRID), round(r.x2 / GRID)
        y0, y1 = round(r.y / GRID), round(r.y2 / GRID)
        if min(x1 - x0, y1 - y0) <= 0:
            raise ValueError("Room has no area")
        for x in range(x0, x1):
            for y in range(y0, y1):
                if (x, y) in occupied:
                    raise ValueError("Rooms overlap")
                occupied.add((x, y))
    if not occupied:
        raise ValueError("Footprint has no rooms")
    seen = {next(iter(occupied))}
    q = deque(seen)
    while q:
        x, y = q.popleft()
        for cell in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if cell in occupied and cell not in seen:
                seen.add(cell)
                q.append(cell)
    if seen != occupied:
        raise ValueError("Footprint rooms are disconnected")
    edges = {}
    for x, y in occupied:
        for neighbor, a, b in (
            ((x, y - 1), (x, y), (x + 1, y)),
            ((x + 1, y), (x + 1, y), (x + 1, y + 1)),
            ((x, y + 1), (x + 1, y + 1), (x, y + 1)),
            ((x - 1, y), (x, y + 1), (x, y)),
        ):
            if neighbor not in occupied:
                edges.setdefault(a, []).append(b)
    loops = []
    while edges:
        start = min(edges)
        path = [start]
        cur = start
        while True:
            nxt = edges[cur].pop()
            if not edges[cur]:
                del edges[cur]
            if nxt == start:
                break
            if nxt in path:
                raise ValueError("Footprint boundary intersects itself")
            path.append(nxt)
            cur = nxt
        # Remove collinear grid vertices.
        path = [p for i, p in enumerate(path) if
                (path[i - 1][0] - p[0]) * (path[(i + 1) % len(path)][1] - p[1]) !=
                (path[i - 1][1] - p[1]) * (path[(i + 1) % len(path)][0] - p[0])]
        area2 = sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(path, path[1:] + path[:1]))
        loops.append((area2, [{"x": x * GRID, "y": y * GRID} for x, y in path]))
    outers = [path for area, path in loops if area > 0]
    if len(outers) != 1:
        raise ValueError("Footprint needs exactly one outer boundary")
    return outers[0], [path for area, path in loops if area < 0]
