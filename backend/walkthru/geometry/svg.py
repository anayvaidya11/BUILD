"""Render a layout dict as a standalone SVG floor plan (debugging, slides, eval)."""
from __future__ import annotations

import math
from html import escape
from typing import Dict, List, Tuple

from .geom import Rect, exterior_edges, shared_edge
from .taxonomy import OPEN_PLAN, PUBLICNESS, canonical_type
from .walls import build_walls

FILL = {
    "living": "#FBE7C6", "family": "#FBE2BE", "dining": "#F8DCC6", "kitchen": "#F5D0B5",
    "foyer": "#EFE5D8", "entry": "#EFE5D8", "hallway": "#ECEAE5", "hall": "#ECEAE5",
    "bedroom": "#D9E7F5", "primary_bedroom": "#CCDDF2", "bathroom": "#CFECE7",
    "half_bath": "#CFECE7", "office": "#E4DCF3", "laundry": "#E1ECD6", "mudroom": "#E1ECD6",
    "closet": "#EDEDED", "pantry": "#EDEDED", "garage": "#E0E0E0", "other": "#E7E2F0",
}
INK = "#2B2B2B"
MUTED = "#6B6B6B"


def ft_in(v: float) -> str:
    inches = int(round(v * 12))
    f, i = divmod(inches, 12)
    return f"{f}'" if i == 0 else f"{f}'{i}\""


def _wall_pieces(length: float, openings: List[dict]) -> List[Tuple[float, float]]:
    cuts = sorted((o["offset_ft"], o["offset_ft"] + o["width_ft"]) for o in openings if o["type"] != "window")
    pieces, cur = [], 0.0
    for a, b in cuts:
        if a > cur + 1e-6:
            pieces.append((cur, a))
        cur = max(cur, b)
    if length > cur + 1e-6:
        pieces.append((cur, length))
    return pieces


def _enrich(layout: dict) -> dict:
    """Fill in what a bare contract layout lacks (door orientation/swing, window x/y, walls)."""
    if layout.get("walls") and all("orientation" in d for d in layout.get("doors", [])):
        return layout
    W, D = layout["footprint"]["width_ft"], layout["footprint"]["depth_ft"]
    rects = {r["id"]: Rect(r["x"], r["y"], r["w"], r["h"]) for r in layout["rooms"]}
    types = {r["id"]: r.get("type") for r in layout["rooms"]}
    pub = {r["id"]: PUBLICNESS.get(canonical_type(r.get("type")), 6) for r in layout["rooms"]}
    doors = []
    for d in layout.get("doors", []):
        d = dict(d)
        a, b = (d.get("between") or ["", ""])[:2]
        ext = "exterior" in (a, b) or "outside" in (a, b)
        orient = None
        if ext:
            room = b if a in ("exterior", "outside") else a
            for _, o, c, s0, s1 in exterior_edges(rects[room], W, D) if room in rects else []:
                if abs((d["x"] if o == "vertical" else d["y"]) - c) < 0.01:
                    orient = o
            d.setdefault("swing_into", room)
        elif a in rects and b in rects:
            seg = shared_edge(rects[a], rects[b])
            orient = seg[0] if seg else None
            d.setdefault("swing_into", a if pub.get(a, 6) >= pub.get(b, 6) else b)
        if orient is None:
            continue
        d.setdefault("orientation", orient)
        if "kind" not in d:  # bare contract layout: anything wider than a door, or open plan, is an opening
            ta, tb = (canonical_type(types.get(x)) for x in (a, b))
            open_pair = all(t in OPEN_PLAN or t == "hallway" for t in (ta, tb))
            d["kind"] = "front" if ext else ("opening" if d["width_ft"] > 3.01 or open_pair else "door")
        d.setdefault("hinge", "min")
        doors.append(d)
    windows = []
    for w in layout.get("windows", []):
        w = dict(w)
        r = rects.get(w["room"])
        if r is None:
            continue
        mid = w["offset_ft"] + w["width_ft"] / 2
        w.setdefault("x", {"north": r.x + mid, "south": r.x + mid, "west": r.x, "east": r.x2}[w["wall"]])
        w.setdefault("y", {"north": r.y, "south": r.y2, "west": r.y + mid, "east": r.y + mid}[w["wall"]])
        w.setdefault("sill_ft", 3.0)
        w.setdefault("head_ft", 7.0)
        windows.append(w)
    out = dict(layout, doors=doors, windows=windows)
    out["walls"] = build_walls(rects, doors, windows)
    return out


def render_svg(layout: dict, scale: float = 14.0, margin: float = 56.0, title: str = "") -> str:
    layout = _enrich(layout)
    W = layout["footprint"]["width_ft"]
    D = layout["footprint"]["depth_ft"]
    top = margin + (22 if title else 0)
    vw, vh = W * scale + 2 * margin, D * scale + top + margin

    def X(x):
        return margin + x * scale

    def Y(y):
        return top + y * scale

    rooms: Dict[str, dict] = {r["id"]: r for r in layout["rooms"]}
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {vw:.0f} {vh:.0f}" '
           f'width="{vw:.0f}" height="{vh:.0f}" font-family="Helvetica, Arial, sans-serif">',
           f'<rect width="100%" height="100%" fill="#FFFFFF"/>']
    if title:
        out.append(f'<text x="{margin}" y="{margin - 10}" font-size="15" font-weight="700" '
                   f'fill="{INK}">{escape(title)}</text>')

    for r in layout["rooms"]:
        out.append(f'<rect x="{X(r["x"]):.2f}" y="{Y(r["y"]):.2f}" width="{r["w"] * scale:.2f}" '
                   f'height="{r["h"] * scale:.2f}" fill="{FILL.get(r["type"], "#EEE")}"/>')

    # Walls as filled bars, with gaps for doors and openings.
    for w in layout.get("walls", []):
        t = w["thickness_ft"] * scale
        horiz = w["orientation"] == "horizontal"
        length = (w["x2"] - w["x1"]) if horiz else (w["y2"] - w["y1"])
        for a, b in _wall_pieces(length, w["openings"]):
            ea = t / 2 if a < 1e-6 else 0.0
            eb = t / 2 if b > length - 1e-6 else 0.0
            if horiz:
                x0, x1 = X(w["x1"] + a) - ea, X(w["x1"] + b) + eb
                out.append(f'<rect x="{x0:.2f}" y="{Y(w["y1"]) - t / 2:.2f}" width="{x1 - x0:.2f}" '
                           f'height="{t:.2f}" fill="{INK}"/>')
            else:
                y0, y1 = Y(w["y1"] + a) - ea, Y(w["y1"] + b) + eb
                out.append(f'<rect x="{X(w["x1"]) - t / 2:.2f}" y="{y0:.2f}" width="{t:.2f}" '
                           f'height="{y1 - y0:.2f}" fill="{INK}"/>')
        for o in w["openings"]:
            a, b = o["offset_ft"], o["offset_ft"] + o["width_ft"]
            if o["type"] == "window":
                if horiz:
                    x0, y0, ww, hh = X(w["x1"] + a), Y(w["y1"]) - t / 2, (b - a) * scale, t
                    mid = f'M{x0:.2f},{Y(w["y1"]):.2f}h{ww:.2f}'
                else:
                    x0, y0, ww, hh = X(w["x1"]) - t / 2, Y(w["y1"] + a), t, (b - a) * scale
                    mid = f'M{X(w["x1"]):.2f},{y0:.2f}v{hh:.2f}'
                out.append(f'<rect x="{x0:.2f}" y="{y0:.2f}" width="{ww:.2f}" height="{hh:.2f}" '
                           f'fill="#FFFFFF" stroke="{INK}" stroke-width="1"/>')
                out.append(f'<path d="{mid}" stroke="{INK}" stroke-width="1"/>')
            elif o["type"] == "opening":
                if horiz:
                    d = f'M{X(w["x1"] + a):.2f},{Y(w["y1"]):.2f}H{X(w["x1"] + b):.2f}'
                else:
                    d = f'M{X(w["x1"]):.2f},{Y(w["y1"] + a):.2f}V{Y(w["y1"] + b):.2f}'
                out.append(f'<path d="{d}" stroke="{MUTED}" stroke-width="1" stroke-dasharray="3 3"/>')

    # Door leaves and swing arcs.
    for d in layout.get("doors", []):
        if d["kind"] == "opening":
            continue
        vert = d["orientation"] == "vertical"
        half = d["width_ft"] / 2
        if vert:
            j0, j1 = (d["x"], d["y"] - half), (d["x"], d["y"] + half)
        else:
            j0, j1 = (d["x"] - half, d["y"]), (d["x"] + half, d["y"])
        hinge, other = (j0, j1) if d.get("hinge") != "max" else (j1, j0)
        room = rooms.get(d.get("swing_into"))
        if room is None:
            continue
        cx, cy = room["x"] + room["w"] / 2, room["y"] + room["h"] / 2
        nx, ny = ((1.0 if cx > d["x"] else -1.0), 0.0) if vert else (0.0, (1.0 if cy > d["y"] else -1.0))
        ex, ey = (other[0] - hinge[0]) / d["width_ft"], (other[1] - hinge[1]) / d["width_ft"]
        wft = d["width_ft"]
        tip = (hinge[0] + nx * wft, hinge[1] + ny * wft)
        pts = []
        for i in range(13):
            phi = (math.pi / 2) * i / 12
            pts.append((hinge[0] + wft * (math.cos(phi) * nx + math.sin(phi) * ex),
                        hinge[1] + wft * (math.cos(phi) * ny + math.sin(phi) * ey)))
        out.append(f'<path d="M{X(hinge[0]):.2f},{Y(hinge[1]):.2f}L{X(tip[0]):.2f},{Y(tip[1]):.2f}" '
                   f'stroke="{INK}" stroke-width="1.5"/>')
        poly = " ".join(f"{X(px):.2f},{Y(py):.2f}" for px, py in pts)
        out.append(f'<polyline points="{poly}" fill="none" stroke="{MUTED}" stroke-width="0.8"/>')

    # Labels.
    for r in layout["rooms"]:
        cx, cy = X(r["x"] + r["w"] / 2), Y(r["y"] + r["h"] / 2)
        wpx, hpx = r["w"] * scale, r["h"] * scale
        name = r.get("name") or r["id"]
        dims = f'{ft_in(r["w"])} × {ft_in(r["h"])}'
        rotate = wpx < hpx and wpx < len(name) * 7.5
        span = hpx if rotate else wpx
        fs = max(7.0, min(13.0, (span - 8) / max(len(name), 1) / 0.58))
        ds = max(6.5, min(10.5, fs - 1.5))
        show_dims = (wpx if not rotate else hpx) > len(dims) * ds * 0.55 and (hpx if not rotate else wpx) > 30
        tr = f' transform="rotate(-90 {cx:.2f} {cy:.2f})"' if rotate else ""
        dy = -ds * 0.45 if show_dims else fs * 0.35
        out.append(f'<text x="{cx:.2f}" y="{cy + dy:.2f}" font-size="{fs:.1f}" font-weight="700" '
                   f'text-anchor="middle" fill="{INK}"{tr}>{escape(name)}</text>')
        if show_dims:
            out.append(f'<text x="{cx:.2f}" y="{cy + ds * 1.25:.2f}" font-size="{ds:.1f}" '
                       f'text-anchor="middle" fill="{MUTED}"{tr}>{dims}</text>')

    # Front door marker.
    ent = layout.get("entrance")
    if ent:
        side = ent.get("side", "south")
        ox, oy = {"south": (0, 1), "north": (0, -1), "east": (1, 0), "west": (-1, 0)}[side]
        px, py = X(ent["x"]) + ox * 26, Y(ent["y"]) + oy * 26
        tx, ty = X(ent["x"]) + ox * 10, Y(ent["y"]) + oy * 10
        out.append(f'<path d="M{px:.2f},{py:.2f}L{tx:.2f},{ty:.2f}" stroke="#C0392B" stroke-width="2.5" '
                   f'marker-end="url(#arrow)"/>')
        lx, ly = X(ent["x"]) + ox * 38, Y(ent["y"]) + oy * 38 + (4 if oy == 0 else (4 if oy > 0 else 0))
        out.append(f'<text x="{lx:.2f}" y="{ly:.2f}" font-size="10" font-weight="700" fill="#C0392B" '
                   f'text-anchor="middle">ENTRY</text>')
        out.insert(2, '<defs><marker id="arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" '
                      'markerHeight="5" orient="auto"><path d="M0,0L10,5L0,10z" fill="#C0392B"/></marker></defs>')

    # Overall dimensions.
    y_dim = top - 18
    out.append(f'<path d="M{X(0):.2f},{y_dim:.2f}H{X(W):.2f}M{X(0):.2f},{y_dim - 4:.2f}v8M{X(W):.2f},'
               f'{y_dim - 4:.2f}v8" stroke="{MUTED}" stroke-width="1"/>')
    out.append(f'<text x="{X(W / 2):.2f}" y="{y_dim - 5:.2f}" font-size="11" text-anchor="middle" '
               f'fill="{MUTED}">{ft_in(W)}</text>')
    x_dim = margin - 18
    out.append(f'<path d="M{x_dim:.2f},{Y(0):.2f}V{Y(D):.2f}M{x_dim - 4:.2f},{Y(0):.2f}h8M{x_dim - 4:.2f},'
               f'{Y(D):.2f}h8" stroke="{MUTED}" stroke-width="1"/>')
    out.append(f'<text x="{x_dim - 5:.2f}" y="{Y(D / 2):.2f}" font-size="11" text-anchor="middle" '
               f'fill="{MUTED}" transform="rotate(-90 {x_dim - 5:.2f} {Y(D / 2):.2f})">{ft_in(D)}</text>')
    nx0, ny0 = X(W) + 22, top + 8
    out.append(f'<path d="M{nx0:.2f},{ny0 + 18:.2f}L{nx0:.2f},{ny0:.2f}" stroke="{MUTED}" stroke-width="1.5" '
               f'marker-end="url(#arrow)"/><text x="{nx0:.2f}" y="{ny0 + 30:.2f}" font-size="10" '
               f'text-anchor="middle" fill="{MUTED}">N</text>')
    if not ent:
        out.insert(2, '<defs><marker id="arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" '
                      'markerHeight="5" orient="auto"><path d="M0,0L10,5L0,10z" fill="#C0392B"/></marker></defs>')
    out.append("</svg>")
    return "\n".join(out)
