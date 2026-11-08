# Eval results, 2026-11-08

Source for the demo proof slide. Raw JSON: [results-2026-11-08.json](results-2026-11-08.json).

- **Code:** main @ c481fc0 (role 2 solver, role 3 stricter checker with `door_geometry`, `prompt_fidelity`, `contract_integrity`)
- **Model:** claude-opus-5-5, effort `low`, 30 prompts from `backend/eval/prompts.txt`, 6 workers
- **Reproduce** (from `backend/`, needs `ANTHROPIC_API_KEY`): `python -m eval.run_eval --mode both --n 30`

| | Plans breaking a rule | Mean time |
|---|---|---|
| Raw Claude (draws geometry itself) | 73.3% | 19.3 s |
| Pipeline (planner -> solver -> checker) | 0.0% | 8.0 s |

Raw violations by rule: all_rooms_reachable 13, door_geometry 11, public_bathroom 10, sizes_within_10pct 9, bedroom_exterior_wall 8, min_hall_and_door_width 7, no_overlap_in_footprint 3, prompt_fidelity 2.

Pipeline: every plan passed on the first attempt; mean checker fix rounds 0.2.
