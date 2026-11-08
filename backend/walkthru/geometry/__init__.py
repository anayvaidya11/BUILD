"""Geometry solver: room program JSON -> exact floor plan layout JSON (feet).

    from walkthru.geometry import solve, selfcheck, render_svg
    layout = solve(program_dict)                           # first generation (plain dicts)
    layout = solve(edited_program_dict, previous=layout)   # edits keep other rooms in place

walkthru/solver.py wraps this with the pydantic RoomProgram -> Layout signature.
"""
from .program import ProgramError
from .selfcheck import selfcheck
from .solve import VERSION as __version__
from .solve import SolverError, solve
from .svg import render_svg

__all__ = ["solve", "selfcheck", "render_svg", "SolverError", "ProgramError", "__version__"]
