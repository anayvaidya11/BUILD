"""Layout JSON contract (docs/CONTRACTS.md). Every role builds against these models.

All units are feet. Origin is the footprint's top-left corner; x grows east, y grows south.
The planner fills RoomProgram (no positions); the solver turns it into a Layout;
the checker fills Layout.checks. Change this file only together with docs/CONTRACTS.md
and frontend/src/lib/types.ts, and tell the team.
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

RoomType = Literal[
    "living",
    "kitchen",
    "dining",
    "bedroom",
    "primary_bedroom",
    "bathroom",
    "office",
    "laundry",
    "entry",
    "hall",
    "closet",
]

Wall = Literal["north", "south", "east", "west"]

EXTERIOR = "exterior"  # pseudo-room id used in Door.between for doors to the outside


class Footprint(BaseModel):
    width_ft: float
    depth_ft: float


class Point(BaseModel):
    x: float
    y: float


# ---------- planner output (role 1) ----------


class RoomSpec(BaseModel):
    """One room as Claude plans it: what it is and how big, never where."""

    id: str = Field(description="unique snake_case id, e.g. bedroom_2")
    type: RoomType
    name: str = Field(description="display name, e.g. 'Bedroom 2'")
    target_sqft: float
    adjacent_to: list[str] = Field(default_factory=list, description="ids of rooms it should share a wall with")


class RoomProgram(BaseModel):
    requested_sqft: float = Field(description="total house size from the prompt (gross, incl. halls)")
    aspect_ratio: float = Field(default=1.4, description="footprint width / depth, 1.0-2.0")
    rooms: list[RoomSpec]
    notes: str = Field(default="", description="one line on the design intent")


# ---------- solver output (role 2) ----------


class Room(RoomSpec):
    x: float
    y: float
    w: float
    h: float

    @property
    def area(self) -> float:
        return self.w * self.h


class Door(BaseModel):
    between: list[str] = Field(description="two room ids; use 'exterior' for the front door")
    x: float = Field(description="center of the opening, on the shared wall")
    y: float
    width_ft: float = 2.67


class Window(BaseModel):
    room: str
    wall: Wall
    offset_ft: float = Field(description="from the wall's west/north end")
    width_ft: float = 4


# ---------- checker output (role 3) ----------


class Check(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    rule: str
    pass_: bool = Field(alias="pass")
    message: str = ""


class Layout(BaseModel):
    footprint: Footprint
    entrance: Point
    rooms: list[Room]
    doors: list[Door] = Field(default_factory=list)
    windows: list[Window] = Field(default_factory=list)
    checks: list[Check] = Field(default_factory=list)
    requested_sqft: Optional[float] = None

    def room(self, room_id: str) -> Room | None:
        return next((r for r in self.rooms if r.id == room_id), None)

    def to_json(self) -> dict:
        return self.model_dump(by_alias=True)


# ---------- API (role 6) ----------


class FixRound(BaseModel):
    round: int
    failed: list[Check]
    note: str = ""


class GenerateRequest(BaseModel):
    prompt: str


class EditRequest(BaseModel):
    program: RoomProgram
    layout: Layout
    instruction: str


class GenerateResponse(BaseModel):
    layout: Layout
    program: RoomProgram
    rounds: list[FixRound]
    attempts: int = 1
    elapsed_s: float
    cached: bool = False
