"""Role 6 glue: planner -> solver -> checker, with the fix loop.

Claude plans, the solver places, the checker judges; failures go back to Claude
until every rule passes (max MAX_ROUNDS), then one fresh retry before giving up.
"""

from __future__ import annotations

import logging
import time

from . import checker, planner, solver
from .schema import FixRound, GenerateResponse, Layout, RoomProgram

log = logging.getLogger("walkthru")
MAX_ROUNDS = 4
MAX_ATTEMPTS = 2


class GenerationFailed(RuntimeError):
    pass


def _loop(program: RoomProgram, keep: Layout | None = None, prompt: str | None = None) -> tuple[Layout, RoomProgram, list[FixRound]]:
    rounds: list[FixRound] = []
    for i in range(1, MAX_ROUNDS + 1):
        layout = solver.solve(program, keep=keep)
        layout.checks = checker.check(layout)
        if prompt is not None:
            layout.checks.append(checker.check_prompt(prompt, layout))
        failed = checker.failures(layout.checks)
        if not failed:
            return layout, program, rounds
        rounds.append(FixRound(round=i, failed=failed))
        log.info("round %d: %d rules failed", i, len(failed))
        if i < MAX_ROUNDS:
            program = planner.fix(program, [f"{c.rule}: {c.message}" for c in failed])
    raise GenerationFailed(rounds)


def generate(prompt: str) -> GenerateResponse:
    t0 = time.perf_counter()
    all_rounds: list[FixRound] = []
    for attempt in range(1, MAX_ATTEMPTS + 1):
        program = planner.plan(prompt)
        try:
            layout, program, rounds = _loop(program, prompt=prompt)
            return GenerateResponse(
                layout=layout, program=program, rounds=all_rounds + rounds,
                attempts=attempt, elapsed_s=round(time.perf_counter() - t0, 2),
            )
        except GenerationFailed as e:
            all_rounds += e.args[0]
    raise GenerationFailed(f"no valid plan after {MAX_ATTEMPTS} attempts")


def edit(program: RoomProgram, layout: Layout, instruction: str) -> GenerateResponse:
    t0 = time.perf_counter()
    new_program = planner.edit(program, instruction)
    layout, new_program, rounds = _loop(new_program, keep=layout)
    return GenerateResponse(layout=layout, program=new_program, rounds=rounds, elapsed_s=round(time.perf_counter() - t0, 2))
