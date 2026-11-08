"""Tour planning for build photoreal walkthroughs (pure Python, no Blender).

plan_tour(payload) -> {start, scenes: {id: {x, y, label, links:[{to, yaw, pitch}]}}, rooms, size}
Coordinates are Blender metres: x east, y north (plan y is south, so y_b = (depth - y_plan) * FT).
Yaw 0 = looking north (+Y), positive yaw turns east — the panorama camera's convention.
"""
import math

FT = 0.3048
EYE = 1.6
SKIP_TYPES = {"closet"}


def _parts_by_room(payload):
    out = {}
    for p in payload.get("parts", []):
        (x0, y0, z0), (x1, y1, z1) = p["min"], p["max"]
        if z0 > 5.0 or (z1 - z0) < 0.1:      # ignore ceiling pendants, wall art up high, rugs
            continue
        out.setdefault(p["room"], []).append((x0, y0, x1, y1))
    return out


def _dist_to_box(px, py, b):
    x0, y0, x1, y1 = b
    dx = max(x0 - px, 0, px - x1)
    dy = max(y0 - py, 0, py - y1)
    return math.hypot(dx, dy)


def camera_spot(room, boxes):
    """Point in the room (plan feet) with the most clearance from furniture, biased to the centre."""
    m = min(1.6, room["w"] / 3, room["h"] / 3)
    cx, cy = room["x"] + room["w"] / 2, room["y"] + room["h"] / 2
    best, best_s = (cx, cy), -1e9
    steps = 14
    for i in range(steps + 1):
        for j in range(steps + 1):
            px = room["x"] + m + (room["w"] - 2 * m) * i / steps
            py = room["y"] + m + (room["h"] - 2 * m) * j / steps
            clear = min([_dist_to_box(px, py, b) for b in boxes] + [3.0])
            if clear < 0.8:
                continue
            s = min(clear, 3.0) - 0.12 * math.hypot(px - cx, py - cy)
            if s > best_s:
                best, best_s = (px, py), s
    return best


def plan_tour(payload):
    L = payload["layout"]
    FD, FW = L["footprint"]["depth_ft"], L["footprint"]["width_ft"]
    B = lambda x, y: (round(x * FT, 3), round((FD - y) * FT, 3))
    rooms = {r["id"]: r for r in L["rooms"]}
    boxes = _parts_by_room(payload)
    scenes = {}
    for r in L["rooms"]:
        if r["type"] in SKIP_TYPES or min(r["w"], r["h"]) < 4:
            continue
        px, py = camera_spot(r, boxes.get(r["id"], []))
        x, y = B(px, py)
        scenes[r["id"]] = {"x": x, "y": y, "label": r["name"], "plan": [round(px, 2), round(py, 2)], "links": []}

    # connections: doors between rooms, and open-plan edges (via the middle of the shared edge)
    edges = []
    for d in L["doors"]:
        a, b = d["between"]
        if a in scenes and b in scenes:
            edges.append((a, b, (d["x"], d["y"])))
    for a, b in L.get("open", []):
        if a in scenes and b in scenes:
            A, Bb = rooms[a], rooms[b]
            if abs(A["x"] + A["w"] - Bb["x"]) < 0.01 or abs(Bb["x"] + Bb["w"] - A["x"]) < 0.01:
                xx = A["x"] + A["w"] if abs(A["x"] + A["w"] - Bb["x"]) < 0.01 else A["x"]
                y0, y1 = max(A["y"], Bb["y"]), min(A["y"] + A["h"], Bb["y"] + Bb["h"])
                edges.append((a, b, (xx, (y0 + y1) / 2)))
            else:
                yy = A["y"] + A["h"] if abs(A["y"] + A["h"] - Bb["y"]) < 0.01 else A["y"]
                x0, x1 = max(A["x"], Bb["x"]), min(A["x"] + A["w"], Bb["x"] + Bb["w"])
                edges.append((a, b, ((x0 + x1) / 2, yy)))
    seen = set()
    for a, b, via in edges:
        if (a, b) in seen or (b, a) in seen:
            continue
        seen.add((a, b))
        vx, vy = B(*via)
        for src, dst in ((a, b), (b, a)):
            s = scenes[src]
            # aim at the doorway, unless we are standing in it — then aim at the next room's camera
            tx, ty = (vx, vy) if math.hypot(vx - s["x"], vy - s["y"]) > 0.6 else (scenes[dst]["x"], scenes[dst]["y"])
            dist = math.hypot(tx - s["x"], ty - s["y"])
            yaw = math.degrees(math.atan2(tx - s["x"], ty - s["y"]))
            pitch = -max(12.0, min(38.0, math.degrees(math.atan2(EYE, max(dist, 0.5))) * 0.7))
            s["links"].append({"to": dst, "yaw": round(yaw, 2), "pitch": round(pitch, 2), "label": scenes[dst]["label"]})
    start = "living" if "living" in scenes else next(iter(scenes))
    room_rects = [[round(r["x"] * FT, 3), round(r["y"] * FT, 3), round((r["x"] + r["w"]) * FT, 3), round((r["y"] + r["h"]) * FT, 3), r["name"], r["id"]]
                  for r in L["rooms"]]
    return {"start": start, "scenes": scenes, "rooms": room_rects, "size": [round(FW * FT, 3), round(FD * FT, 3)]}
