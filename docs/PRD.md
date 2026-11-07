# Floor Plan Walkthrough PRD

## Overview

A web app where you describe a home in plain English, get a floor plan that passes real
layout rules, and then walk through it in first person in 3D. Working name: **Walkthru**.

**The problem.** Custom home design is out of reach for most people: an architect costs
thousands of dollars and weeks of back-and-forth before you can even picture the space.
Flat floor plans are also hard to read.

**What we build in 24 hours.**

- **Text prompt in:** "3 bed, 2 bath, open kitchen, home office, about 1,800 sq ft."
- **Rule-checked floor plan out:** Claude plans the rooms, a solver places exact walls, and a
  checker enforces layout rules. Failures are fed back to Claude until every rule passes.
- **Walk through it:** one click turns the 2D plan into a 3D house you explore with WASD +
  mouse, at true human eye height.
- **Edit by talking:** "make the kitchen bigger" updates the plan and the 3D house without
  regenerating everything.

**Why not just ask Claude?** Claude alone is weak at exact geometry: rooms overlap, doors open
into walls, and sizes don't add up to the footprint. Our answer is the checker loop: Claude
handles the creative layout, code enforces the rules. We measure both and show it on a slide.

## Goals, non-goals and success metrics

The demo succeeds if a judge types a prompt and walks through a valid house in under 60 seconds.

**Goals (must ship)**

- Text prompt to valid floor plan in under 30 seconds
- Every generated plan passes all layout rules before the user sees it
- First-person 3D walkthrough with collision and working doorways
- Edit by text prompt, with plan and 3D updating together
- A measured before/after number: rule violations with raw Claude vs. with our checker loop

**Non-goals:** multi-story, stairs, basements; structural engineering, permits or real code
compliance; accounts, saving, sharing, payments; drawing/uploading a footprint; furniture beyond
a few placeholders.

| Metric | Target | How we measure |
|---|---|---|
| Plans passing all rules | 100% of plans shown | Checker runs on every plan before render |
| Raw Claude violation rate | Measured, on slide | 30 prompts through Claude alone and through our loop |
| Prompt to plan | < 30 s | Timer in the app |
| Fix loop rounds | ≤ 3 on average | Logged per generation |
| Walkthrough frame rate | 60 fps on a laptop | Browser performance overlay |

## User flow and demo script

1. One screen: a prompt box and an empty plan canvas.
2. Type the house description and press Generate.
3. The checking panel: each rule ticks green; any fix round shows what failed and how Claude fixed it.
4. The 2D plan appears with room names and dimensions in feet.
5. Press **Walk through**: the camera drops into the front door at 5'6" eye height.
6. Walk with WASD + mouse; a minimap shows where you are.
7. Type an edit; plan and 3D update in place.

| Time | What happens | Who |
|---|---|---|
| 0:00–0:20 | The problem | Pitch lead |
| 0:20–1:00 | Judge calls out a house; typed live; checker shows a fix round | Pitch lead + driver |
| 1:00–1:50 | Walk through: front door, kitchen, hall, bedroom | Driver |
| 1:50–2:20 | Live edit: "make the kitchen bigger", walk back in | Driver |
| 2:20–2:50 | Proof slide: raw Claude violation rate vs. ours (0%) | Pitch lead |
| 2:50–3:00 | Close: who it's for, what's next | Pitch lead |

Backup: 3 cached generations ready in case Wi-Fi or the API fails. Say so out loud if used.

## Six roles

Each role owns one piece and talks to the others only through the layout JSON
([CONTRACTS.md](CONTRACTS.md)).

| # | Role | Owner | Delivers | Done when |
|---|---|---|---|---|
| 1 | AI planner | | Prompt → room program JSON; fix prompt; edit prompt that changes only what was asked | 10 prompts return valid JSON first try; fed-back error fixed in ≤ 3 rounds |
| 2 | Geometry solver | | Room program → rectangles tiling the footprint, shared walls, doors, windows (feet) | No overlaps, sizes within 10%, every room has a door |
| 3 | Rule checker + eval | | Plain-English checker; 30-prompt eval raw Claude vs. loop | All rules < 1 s; eval numbers on the slide by hour 18 |
| 4 | 2D plan + app UI | | Prompt box, live checker panel, SVG plan, edit box, minimap | API plan renders; panel shows each rule and fix round |
| 5 | 3D walkthrough | | R3F scene: walls, door openings, floors, lighting, FPS controls, collision, minimap position | Front door to every room at 60 fps without clipping |
| 6 | Backend + demo lead | | FastAPI chaining planner → solver → checker; API contract; cached backups; deploy; deck | Full flow on deployed URL; demo rehearsed twice |

Pairings that must talk often: 1 ↔ 3 (error format), 2 ↔ 5 (units, walls), 4 ↔ 5 (plan state,
minimap), 6 ↔ everyone (API contract).

### Rule list (role 3 starting set)

- No two rooms overlap; all rooms fit inside the footprint
- Every room is reachable from the front door through doors
- Every bedroom has an exterior wall (for a window) and a door
- At least one bathroom is reachable without going through a bedroom
- Kitchen is next to the dining or living area
- Hallways ≥ 3 ft wide; doors ≥ 2'8" wide
- Each room within 10% of its requested size; total area within 10% of the prompt

## Architecture

```
prompt ─► Claude planner ─► room program ─► solver ─► layout ─► checker ─┬─ pass ─► 2D plan + 3D walkthrough
               ▲                                                          │
               └──────────────── plain-English failures (≤ 4 rounds) ◄────┘
```

Claude never draws walls: it outputs a room program, the solver places exact geometry, and the
checker sends failures back until every rule passes. 2D and 3D render the same layout JSON, so
they can never disagree.

**Stack:** Next.js + React Three Fiber + drei (PointerLockControls); FastAPI (Python) for planner,
solver, checker; Claude via the Anthropic SDK with structured output.

## 24-hour timeline

- **H2, schema agreed:** layout JSON locked; API returns a hardcoded sample (`/api/sample`), so
  roles 4 and 5 start immediately.
- **H8, end-to-end run:** prompt → plan → walkthrough works once, even if ugly. If not, switch the
  solver to the grid fallback immediately.
- **H14, features in:** every must-ship goal works on the deployed URL.
- **H18, code freeze:** eval numbers in the deck; only bug fixes after.
- **H18–H24:** cache backup generations, rehearse twice, sleep in shifts.

## Risks, fallbacks and cut list

| Risk | Fallback |
|---|---|
| Solver can't tile arbitrary room sets | Fixed rectangular footprint, 1 ft grid, simple greedy packer |
| Fix loop doesn't converge | Cap at 4 rounds; retry from a fresh plan; show attempt count honestly |
| Claude returns broken JSON | Structured output with a strict schema; validate and retry once |
| 3D collision is buggy | Axis-aligned wall boxes instead of mesh collision |
| API slow / Wi-Fi down | 3 cached generations; say so out loud |
| Edits regenerate the whole house | Edit prompt changes only named rooms; solver keeps others fixed |

**Cut list (drop in this order):** furniture → windows (keep doors) → minimap → edit-by-text.
**Never cut:** the checker loop, the walkthrough, the proof slide.
