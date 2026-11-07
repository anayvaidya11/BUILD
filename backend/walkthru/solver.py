"""Role 2: geometry solver. RoomProgram -> Layout with exact rectangles, doors, windows.

BASELINE ("two rows + spine hall"): private rooms in a north row, public rooms in a south
row, a 4 ft hall across the middle, every room opens onto the hall. It always tiles the
footprint with no overlaps, so the pipeline runs end to end from hour 0. Role 2 replaces
or improves `solve()` (smarter packing, respecting adjacency, keeping rooms fixed on edits).

Grid: every coordinate is snapped to GRID ft so walls line up for the 3D extruder.
"""

from __future__ import annotations

import math

from .schema import EXTERIOR, Door, Footprint, Layout, Point, Room, RoomProgram, RoomSpec, Window

GRID = 0.5
HALL_W = 4.0
DOOR_W = 3.0
PUBLIC = {"living", "kitchen", "dining", "entry", "laundry"}
PRIVATE = {"bedroom", "primary_bedroom", "bathroom", "office", "closet"}
SOUTH_ORDER = ["laundry", "kitchen", "dining", "living", "entry"]  # kitchen next to dining/living


def snap(v: float) -> float:
    return round(v / GRID) * GRID


def _footprint(total_room_sqft: float, aspect: float) -> Footprint:
    # W * (D - HALL_W) = total, D = W / aspect  ->  W^2/aspect - HALL_W*W - total = 0
    aspect = min(max(aspect, 1.0), 2.0)
    w = (HALL_W + math.sqrt(HALL_W**2 + 4 * total_room_sqft / aspect)) * aspect / 2
    return Footprint(width_ft=snap(w), depth_ft=snap(w / aspect))


def _split_rows(rooms: list[RoomSpec]) -> tuple[list[RoomSpec], list[RoomSpec]]:
    north = [r for r in rooms if r.type not in PUBLIC]
    south = [r for r in rooms if r.type in PUBLIC]
    area = lambda rs: sum(r.target_sqft for r in rs)
    # Move small non-bedroom rooms south while it improves balance.
    movable = sorted((r for r in north if r.type in {"office", "bathroom", "closet"}), key=lambda r: r.target_sqft)
    for r in movable:
        if area(north) - area(south) > r.target_sqft:
            north.remove(r)
            south.append(r)
    rank = {t: i for i, t in enumerate(SOUTH_ORDER)}
    south.sort(key=lambda r: rank.get(r.type, -1))
    return north, south


def _place_row(specs: list[RoomSpec], y: float, depth: float, width: float) -> list[Room]:
    total = sum(s.target_sqft for s in specs) or 1
    rooms, x, acc = [], 0.0, 0.0
    for i, s in enumerate(specs):
        acc += s.target_sqft
        x2 = width if i == len(specs) - 1 else snap(width * acc / total)
        rooms.append(Room(**s.model_dump(), x=x, y=y, w=x2 - x, h=depth))
        x = x2
    return rooms


def solve(program: RoomProgram, keep: Layout | None = None) -> Layout:
    """`keep`: previous layout on edits. TODO(role 2): hold unchanged rooms fixed."""
    specs = [r for r in program.rooms if r.type != "hall"]
    north, south = _split_rows(specs)
    total = sum(r.target_sqft for r in specs)
    fp = _footprint(total, program.aspect_ratio)
    W, D = fp.width_ft, fp.depth_ft

    n_area = sum(r.target_sqft for r in north)
    d_north = snap((D - HALL_W) * n_area / total) if north else 0.0
    hall_y = d_north
    d_south = D - HALL_W - d_north

    rooms = _place_row(north, 0.0, d_north, W)
    rooms.append(Room(id="hall", type="hall", name="Hall", target_sqft=W * HALL_W, x=0, y=hall_y, w=W, h=HALL_W))
    rooms += _place_row(south, hall_y + HALL_W, d_south, W)

    doors: list[Door] = []
    windows: list[Window] = []
    for r in rooms:
        if r.type == "hall":
            continue
        on_north_row = r.y < hall_y
        doors.append(Door(between=[r.id, "hall"], x=snap(r.x + r.w / 2), y=r.y + r.h if on_north_row else r.y, width_ft=DOOR_W))

    # Front door: middle of the living room's south wall (or the middle south room).
    south_rooms = [r for r in rooms if r.y > hall_y]
    front = next((r for r in south_rooms if r.type == "living"), None) or (south_rooms[len(south_rooms) // 2] if south_rooms else rooms[0])
    entrance = Point(x=snap(front.x + front.w / 2), y=D)
    doors.append(Door(between=[EXTERIOR, front.id], x=entrance.x, y=D, width_ft=DOOR_W))

    for r in rooms:
        if r.type == "hall" or r is front:
            continue  # TODO: window on the front room that avoids the front door
        ww = min(4.0, r.w - 2)
        if ww >= 2:
            windows.append(Window(room=r.id, wall="north" if r.y < hall_y else "south", offset_ft=snap((r.w - ww) / 2), width_ft=ww))

    return Layout(footprint=fp, entrance=entrance, rooms=rooms, doors=doors, windows=windows, requested_sqft=program.requested_sqft)
