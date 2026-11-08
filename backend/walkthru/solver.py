"""Role 2: geometry solver. RoomProgram -> Layout with exact rectangles, doors, windows.

The work happens in walkthru/geometry/ (pure Python, no pydantic inside):

    public block (open kitchen / dining / living + entry) | hallway spine with a band of
    rooms on each side; every band room touches the hall (door) and an exterior wall
    (window); ensuite baths and walk-in closets open only into their bedroom.

It tries a few hundred arrangements (footprint depth, public-row order, north/south
split of the private rooms), builds exact geometry on the 0.5 ft grid for each, places
doors and windows, scores them with the same rules as checker.py (plus door_geometry),
and returns the best. Typical run: 20-360 ms.

Edits: pass the previous layout as `keep`; rows and band columns are carried over, so
rooms the user didn't mention keep their size and stay in the same place in the plan.
"""

from __future__ import annotations

from .geometry import ProgramError, SolverError, render_svg
from .geometry import solve as solve_dict
from .geometry.geom import GRID
from .geometry.openings import DOOR_W
from .geometry.solve import HALL_WIDTH_FT as HALL_W
from .schema import Layout, RoomProgram

__all__ = ["solve", "solve_dict", "render_svg", "GRID", "HALL_W", "DOOR_W", "ProgramError", "SolverError"]


def solve(program: RoomProgram, keep: Layout | None = None) -> Layout:
    """`keep`: the layout being edited; unchanged rooms stay where they were."""
    previous = keep.model_dump(by_alias=True) if keep is not None else None
    prog = program.model_dump()
    if keep is not None and not prog.get("footprint"):
        # Same footprint as the layout being edited, so rooms the user didn't mention stay put
        # (the solver's "auto" mode keeps it when the rooms still fit within 6%).
        prog["footprint"] = keep.footprint.model_dump()
    return Layout.model_validate(solve_dict(prog, previous=previous))
