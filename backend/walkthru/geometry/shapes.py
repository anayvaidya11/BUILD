"""Opt-in orthogonal silhouettes built from rectangular rooms."""
from __future__ import annotations

from .geom import EPS, GRID, Rect, snap


def stepped_wing(rects: dict[str, Rect], hall_id: str | None,
                 shape: str = "l") -> dict[str, Rect] | None:
    """Extend one or two hall-side rooms to make an L, T, or U-like outline.

    Selected rooms keep their hall-facing edge and approximately their area.
    Every other room is translated together; doors and windows must be replanned.
    """
    if not hall_id or hall_id not in rects:
        return None
    hall = rects[hall_id]
    top = sorted(((rid, r) for rid, r in rects.items()
                  if rid != hall_id and abs(r.y2 - hall.y) < EPS
                  and r.y <= min(v.y for v in rects.values()) + EPS
                  and r.w >= 8 and r.h >= 7 and r.x >= hall.x - EPS),
                 key=lambda item: item[1].x)
    if not top:
        return None
    if shape == "l":
        chosen = [top[-1]]
    elif shape == "t":
        center = (min(r.x for r in rects.values()) + max(r.x2 for r in rects.values())) / 2
        chosen = [min(top, key=lambda item: abs(item[1].cx - center))]
    elif shape == "u" and len(top) >= 2:
        chosen = [top[0], top[-1]]
    else:
        return None
    altered = {}
    for rid, r in chosen:
        cut = min(5.0, snap(r.w * 0.25))
        new_w = r.w - cut
        if new_w < 7:
            new_w = 7.0
            cut = r.w - new_w
        if cut < GRID:
            return None
        new_h = snap(r.area / new_w)
        if new_h - r.h < GRID:
            return None
        altered[rid] = (r.x, new_w, new_h, new_h - r.h)
    delta = max(v[3] for v in altered.values())
    result = {key: Rect(v.x, v.y + delta, v.w, v.h) for key, v in rects.items()}
    for rid, (x, w, h, _) in altered.items():
        old = rects[rid]
        result[rid] = Rect(x, old.y2 + delta - h, w, h)
    return result
