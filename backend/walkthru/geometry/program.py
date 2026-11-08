"""Parse and classify the planner's room program.

Input is the layout JSON *without* positions (see README):
    {"footprint": {...}?, "total_sqft": 1800?, "entrance": {...}?,
     "rooms": [{"id", "type", "name", "target_sqft", "adjacent_to"}, ...]}

classify() decides, for every room, which zone of the house it goes in:
    public   - open-plan block by the front door (living, family, dining, kitchen)
    foyer    - entry room, sits in the public block's front row
    corridor - opens off the hallway (bedrooms, baths, office, laundry, ...)
    child    - only reachable through its host (ensuite bath, walk-in closet, pantry)
    garage   - full-depth block at the far end of the hallway
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from .taxonomy import DEFAULT_SQFT, PUBLIC, canonical_type, slug

SIDES = ("north", "south", "east", "west")
PRIMARY_WORDS = ("primary", "master", "owner", "main")
ENSUITE_WORDS = ("ensuite", "en_suite", "primary", "master", "owner", "suite")
WIC_WORDS = ("walk", "wic", "primary", "master", "owner")
COAT_WORDS = ("coat", "entry", "foyer", "front")


class ProgramError(ValueError):
    """The program JSON can't be laid out at all (bad shape, no rooms)."""


@dataclass
class Room:
    id: str
    type: str
    name: str
    target: float
    adjacent: set
    raw: dict
    host: Optional[str] = None
    children: List[str] = field(default_factory=list)
    zone: str = ""
    dual: bool = False  # ensuite that also opens to the hall (every bedroom has its own bath)

    def words(self) -> str:
        return slug(f"{self.id} {self.name}")


@dataclass
class Program:
    rooms: Dict[str, Room]
    order: List[str]
    footprint: Optional[Tuple[float, float]]
    total_sqft: Optional[float]
    entrance_side: str
    entrance_pos: Optional[float]  # 0..1 along the entrance wall, if the planner gave a point
    hall_id: str
    hall_name: str
    raw: dict
    warnings: List[str] = field(default_factory=list)
    primary_id: Optional[str] = None
    aspect: Optional[float] = None  # RoomProgram.aspect_ratio (width / depth), a soft preference
    closed: set = field(default_factory=set)  # types the notes want walled off ("formal dining")

    def ids(self, zone: str) -> List[str]:
        return [r for r in self.order if self.rooms[r].zone == zone]


def _num(v) -> Optional[float]:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f > 0 else None


def _parse_footprint(fp) -> Optional[Tuple[float, float]]:
    if not isinstance(fp, dict):
        return None
    w = _num(fp.get("width_ft", fp.get("width")))
    d = _num(fp.get("depth_ft", fp.get("depth", fp.get("height_ft"))))
    if w is None or d is None:
        return None
    return (w, d)


def _parse_entrance(ent, fp, program: dict):
    side, pos = None, None
    if isinstance(program.get("entrance_side"), str):
        side = program["entrance_side"].lower()
    if isinstance(ent, str):
        side = ent.lower()
    elif isinstance(ent, dict):
        if isinstance(ent.get("side") or ent.get("wall"), str):
            side = str(ent.get("side") or ent.get("wall")).lower()
        x, y = _num(ent.get("x")), ent.get("y")
        try:
            y = float(y)
        except (TypeError, ValueError):
            y = None
        if x is not None and y is not None and fp:
            W, D = fp
            if side not in SIDES:
                dist = {"north": abs(y), "south": abs(D - y), "west": abs(x), "east": abs(W - x)}
                side = min(dist, key=dist.get)
            pos = x / W if side in ("north", "south") else y / D
            pos = min(1.0, max(0.0, pos))
    if side not in SIDES:
        side = "south"
    return side, pos


# The contract's 11 room types can't say "garage" or "powder room", so the planner puts those
# in the nearest allowed type and says what it is in the name. Placement follows the name;
# the output keeps the planner's type.
_NAME_TYPES = {"garage", "pantry", "mudroom", "half_bath", "family", "foyer"}
HALF_BATH_MAX_SQFT = 45  # same rule as walkthru/requirements.py (role 1)


def refine_type(ctype: str, name: str, target) -> str:
    named = canonical_type(None, name) if name else None
    if named in _NAME_TYPES and not (named == "family" and ctype not in ("living", "other")):
        return named
    if ctype == "bathroom" and (_num(target) or 99) < HALF_BATH_MAX_SQFT:
        return "half_bath"
    return ctype


def closed_types(notes: str) -> set:
    """Rooms the planner's notes want separate rather than open plan."""
    n = notes.lower()
    out = set()
    if re.search(r"(formal|separate|closed|enclosed)\s+dining|dining\s+(room\s+)?(is\s+)?separate", n):
        out.add("dining")
    if re.search(r"(closed|enclosed|separate)\s+kitchen", n):
        out.add("kitchen")
    if re.search(r"(formal|separate)\s+living|separate\s+dining\s+and\s+living", n):
        out.add("living")
    return out


def normalize(program: dict) -> Program:
    if not isinstance(program, dict):
        raise ProgramError("program must be a JSON object")
    rooms_in = program.get("rooms")
    if not isinstance(rooms_in, list) or not rooms_in:
        raise ProgramError("program.rooms must be a non-empty list")

    warnings: List[str] = []
    rooms: Dict[str, Room] = {}
    order: List[str] = []
    hall_id, hall_name = "hall", "Hallway"
    seen_hall = False
    pending_adj: Dict[str, list] = {}

    for i, r in enumerate(rooms_in):
        if not isinstance(r, dict):
            raise ProgramError(f"rooms[{i}] must be an object")
        name = str(r.get("name") or "").strip()
        rid = slug(r.get("id") or name or f"{r.get('type') or 'room'}_{i + 1}") or f"room_{i + 1}"
        rtype = refine_type(canonical_type(r.get("type"), name, rid), name, r.get("target_sqft"))
        if not name:
            name = rid.replace("_", " ").title()
        if rtype == "hallway":
            # The solver owns circulation; reuse the planner's id/name for it.
            if not seen_hall:
                hall_id, hall_name, seen_hall = rid, name, True
            else:
                warnings.append(f"Dropped extra hallway '{rid}'; the solver draws one hallway.")
            continue
        base, n = rid, 2
        while rid in rooms or rid in ("exterior", "outside", hall_id):
            rid = f"{base}_{n}"
            n += 1
        target = _num(r.get("target_sqft", r.get("sqft", r.get("area_sqft"))))
        if target is None:
            target = float(DEFAULT_SQFT[rtype])
            warnings.append(f"{name} had no target_sqft; used {target:.0f}.")
        if target < 12:
            warnings.append(f"{name} target {target:.0f} sq ft is too small; raised to 12.")
            target = 12.0
        adj = r.get("adjacent_to") or []
        if isinstance(adj, str):
            adj = [adj]
        pending_adj[rid] = [slug(a) for a in adj if a]
        r = dict(r)
        r["adjacent_to"] = pending_adj[rid]
        rooms[rid] = Room(id=rid, type=rtype, name=name, target=target, adjacent=set(), raw=dict(r))
        order.append(rid)

    if not rooms:
        raise ProgramError("program has no rooms besides hallways")
    while hall_id in rooms:
        hall_id += "_2"

    for rid, adj in pending_adj.items():
        for a in adj:
            if a in rooms and a != rid:
                rooms[rid].adjacent.add(a)
                rooms[a].adjacent.add(rid)

    fp = _parse_footprint(program.get("footprint"))
    side, pos = _parse_entrance(program.get("entrance"), fp, program)
    total = _num(program.get("requested_sqft", program.get("total_sqft", program.get("target_sqft"))))
    prog = Program(rooms=rooms, order=order, footprint=fp, total_sqft=total,
                   entrance_side=side, entrance_pos=pos, hall_id=hall_id,
                   hall_name=hall_name, raw=program, warnings=warnings,
                   aspect=_num(program.get("aspect_ratio")),
                   closed=closed_types(str(program.get("notes") or "")))
    classify(prog)
    return prog


def classify(prog: Program) -> None:
    R = prog.rooms
    bedrooms = [R[r] for r in prog.order if R[r].type == "bedroom"]
    primary = next((b for b in bedrooms if any(w in b.words() for w in PRIMARY_WORDS)), None)
    if primary is None and bedrooms:
        primary = max(bedrooms, key=lambda b: b.target)
    prog.primary_id = primary.id if primary else None
    kitchen = next((R[r] for r in prog.order if R[r].type == "kitchen"), None)
    foyer = next((R[r] for r in prog.order if R[r].type == "foyer"), None)

    host_kids: Dict[str, List[str]] = {}

    def can_host(h: str, ctype: str) -> bool:
        kids = host_kids.get(h, [])
        return not any(R[k].type == ctype for k in kids) and len(kids) < 2

    for rid in prog.order:
        r = R[rid]
        host = None
        if r.type == "bathroom":
            beds = [h for h in r.adjacent if R[h].type == "bedroom"]
            others = [h for h in r.adjacent if R[h].type not in ("bedroom", "closet")]
            ensuite = any(w in r.words() for w in ENSUITE_WORDS)
            if beds and (ensuite or (len(beds) == 1 and not others)):
                host = prog.primary_id if prog.primary_id in beds else sorted(beds)[0]
            elif ensuite and primary is not None:
                host = primary.id
        elif r.type == "closet":
            # the contract has no "pantry" type: a closet next to the kitchen is the pantry
            hosts = [h for h in r.adjacent if R[h].type in ("bedroom", "office", "foyer", "other", "kitchen")]
            if hosts:
                host = sorted(hosts)[0]
            elif any(w in r.words() for w in WIC_WORDS) and primary is not None:
                host = primary.id
            elif any(w in r.words() for w in COAT_WORDS) and foyer is not None:
                host = foyer.id
        elif r.type == "pantry" and kitchen is not None:
            host = kitchen.id
        if host and host != rid and can_host(host, r.type):
            r.host = host
            host_kids.setdefault(host, []).append(rid)

    # Rule: at least one full bathroom must be reachable without a bedroom.
    baths = [R[r] for r in prog.order if R[r].type == "bathroom"]
    public_baths = [r for r in prog.order if R[r].type in ("bathroom", "half_bath") and not R[r].host]
    if baths and not public_baths and all(b.host and R[b.host].type == "bedroom" for b in baths):
        # Every bedroom has its own bath: keep it, and give one a second door onto the hall
        # (Jack-and-Jill) so a bathroom is reachable without walking through a bedroom.
        shared = sorted(baths, key=lambda b: (b.host == prog.primary_id, b.target))[0]
        shared.dual = True
        prog.warnings.append(f"{shared.name} also opens onto the hallway so one bathroom is reachable "
                             "without walking through a bedroom.")

    seen_foyer = seen_garage = False
    for rid in prog.order:
        r = R[rid]
        if r.host:
            r.zone = "child"
            R[r.host].children.append(rid)
        elif r.type in PUBLIC:
            r.zone = "public"
        elif r.type == "foyer" and not seen_foyer:
            r.zone, seen_foyer = "foyer", True
        elif r.type == "garage" and not seen_garage:
            r.zone, seen_garage = "garage", True
        else:
            r.zone = "corridor"
