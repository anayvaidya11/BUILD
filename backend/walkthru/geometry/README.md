# Geometry solver (role 2)

`walkthru.solver.solve(program, keep=None) -> Layout` — same signature as the baseline. The
work lives in this package (plain dicts, no pydantic); `solver.py` is a thin wrapper.

## How it lays out a house

```
+--------------+-----------------------------------+
|  back row    |  north band: col | col | col ...  |   every band room touches the hall (door)
| kitchen,     |-----------------------------------|   and an exterior wall (window)
| dining       |  hall (4 ft)                      |
|--------------|-----------------------------------|   a column can stack two rooms: the outer
|  front row   |  south band: col | col | col ...  |   one opens only into its host bedroom
| living, entry|                                   |   (ensuite bath, walk-in closet)
+----ENTRY-----+-----------------------------------+
```

It builds a few hundred candidates (footprint depth × public-row order × north/south split),
computes exact rectangles on the 0.5 ft grid for each, places doors and windows, scores them
with the same rules as `checker.py` (incl. `door_geometry`), and returns the best. 20-360 ms.

Guaranteed by construction and tested on 69 programs (`tests/test_solver.py`, `tests/test_prompts.py`):

- rooms tile the footprint, never overlap, every coordinate on the 0.5 ft grid
- every door sits on its two rooms' shared wall and fits inside it; both ends on the grid, so
  `walls.ts` cuts exactly the door's width; the front door is `["exterior", room]` at `entrance`
- every bedroom has an exterior wall, a door and a window; one bathroom opens off the hall
- kitchen shares a wall with dining or living; open-plan rooms get wide cased openings
- the house is sized toward `requested_sqft` (rooms scaled at most 6% if targets don't add up)

## What different prompts turn into

The solver only sees the planner's RoomProgram, so "what the user typed" reaches it as room
types, names, sizes, `adjacent_to` and `notes`. `tests/prompt_programs.py` has 40 prompts in
four tiers (basic, the 30 eval prompts, complex paragraphs, out-of-scope asks), each with the
program a planner following `PLAN_SYSTEM` would plausibly return; all 40 pass every rule on
the first solve (`tests/test_prompts.py`, slowest 0.36 s).

| What the user asks | What the solver does |
|---|---|
| Just counts: "3 bed 2 bath" | Planner defaults to 1,800 sq ft; open kitchen/dining/living by the front door, bedrooms off a hallway, primary on the far corner |
| Sizes: "about 2,400 sq ft", "big living room" | House sized to `requested_sqft` (rooms scaled ≤ 6% if targets don't add up); room sizes within 10% |
| Suites: primary bath, walk-in closet | A `bathroom`/`closet` with `adjacent_to` one bedroom opens only into that bedroom |
| "Each bedroom with its own bath" | Every bath stays with its bedroom; one also gets a hall door so a bathroom is reachable without a bedroom |
| Half baths: "2.5 bath", powder room | A `bathroom` under 45 sq ft (role 1's rule) or named "Powder"/"Half Bath"; tiny rooms can sit in the hall's dead end |
| Pantry, mudroom, garage, family room, foyer | No such RoomType, so the planner uses the nearest type and the **name**; placement follows the name (pantry off the kitchen, garage at the end of the hall), output keeps the planner's type |
| "Formal / separate dining", "closed kitchen" | Read from `notes`: those rooms get 4 ft cased openings instead of wide open plan |
| "Office nook" | Small offices stack into a band column instead of becoming a sliver |
| Two stories, basement, pool, porch, L-shaped, a specific lot | Not built (PRD non-goals); the planner flattens to one story, the solver picks the footprint |
| "Split-bedroom plan", "office near the entry" | Approximated: all bedrooms share one wing; other `adjacent_to` pairs are a soft preference |

Known limits: a program dominated by a few large suites can't balance across the two sides
of the hallway, which gives one long bedroom (e.g. 27' × 11' for "3 bed, 3 bath, each bedroom
with its own bath"); very large houses (3,500+ sq ft) come out long and narrow.

## Edits (`keep=`)

The API sends the old layout back as `keep`. The solver reads the arrangement out of its
geometry and reuses it. If the edit doesn't touch bedrooms/baths/office/laundry, the whole
private wing stays exactly where it was and only kitchen/dining/living move ("make the
kitchen bigger"). Otherwise rooms keep their side of the hall and their order.

## Notes for other roles

- **Planner (1):** don't send halls (the solver adds one; if you do, its id/name are reused).
  A `bathroom` or `closet` with `adjacent_to: [<one bedroom>]` becomes that bedroom's ensuite /
  walk-in; a `closet` next to the kitchen is a pantry; put "Garage", "Mudroom", "Pantry",
  "Powder Room", "Family Room" in the name. Formal/separate rooms: say so in `notes`. The
  solver never changes a room's type or target, so `requirements.py` counts survive solving.
- **Checker (3):** `geometry/selfcheck.py` mirrors your rule ids incl. `contract_integrity` and
  `door_geometry`; `test_selfcheck_agrees_with_checker` fails if shared rules drift.
- **3D (5):** doors are 3 ft (cased openings wider, whole feet); `x, y` is the centre on the wall.
- **Debug:** `python -m walkthru.geometry program.json -o layout.json --svg plan.svg` prints
  timing and any failed rule. `solve_dict()` output also has `walls` (deduped segments with
  openings) and `solver` (warnings, score, arrangement); the pydantic `Layout` drops both.
