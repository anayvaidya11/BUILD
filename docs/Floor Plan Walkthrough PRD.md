# Floor Plan Walkthrough PRD

Nov 7, 2026 · @Suhaan Temkar

## Overview

We are building a web app where you describe a home in plain English, get a floor plan that passes real layout rules, and then walk through it in first person in 3D. Working name: **Walkthru** (rename freely).

**The problem.** Custom home design is out of reach for most people: an architect costs thousands of dollars and weeks of back-and-forth before you can even picture the space. Flat floor plans are also hard to read. Most people can't tell from a drawing whether a hallway feels cramped or a kitchen feels open.

**What we build in 24 hours.**

1. **Text prompt in:** "3 bed, 2 bath, open kitchen, home office, about 1,800 sq ft."
2. **Rule-checked floor plan out:** Claude plans the rooms, a solver places exact walls, and a checker enforces layout rules. Failures are fed back to Claude until every rule passes.
3. **Walk through it:** one click turns the 2D plan into a 3D house you explore with WASD + mouse, at true human eye height.
4. **Edit by talking:** "make the kitchen bigger" updates the plan and the 3D house without regenerating everything.

**Why not just ask Claude?** Claude alone is weak at exact geometry: rooms overlap, doors open into walls, and sizes don't add up to the footprint. It also can't reliably check its own work. Our answer is the checker loop: Claude handles the creative layout, code enforces the rules. We measure both and show it on a slide: rule violations with Claude alone vs. with our loop.

## Goals, non-goals and success metrics

The demo succeeds if a judge types a prompt and walks through a valid house in under 60 seconds.

**Goals (must ship)**

- Text prompt to valid floor plan in under 30 seconds
- Every generated plan passes all layout rules before the user sees it
- First-person 3D walkthrough with collision (you can't walk through walls) and working doorways
- Edit by text prompt, with plan and 3D updating together
- A measured before/after number: rule violations with raw Claude vs. with our checker loop

**Non-goals (do not build)**

- Multi-story homes, stairs, basements
- Structural engineering, permits or real building-code compliance (we check a small rule set, not the full code)
- Accounts, saving, sharing, payments
- Drawing or uploading a footprint (text prompt only)
- Furniture beyond a few simple placeholder pieces

**Success metrics**

| Metric | Target | How we measure |
| --- | --- | --- |
| Plans passing all rules | 100% of plans shown to users | Checker runs on every plan before render |
| Raw Claude violation rate | Measured, shown on slide | Run 30 prompts through Claude alone and through our loop |
| Prompt to plan | Under 30 s | Timer in the app |
| Fix loop rounds | 3 or fewer on average | Logged per generation |
| Walkthrough frame rate | 60 fps on a laptop | Browser performance overlay |

## User flow and demo script

The demo runs live end to end with no pre-recorded parts. A judge supplies the prompt.

**User flow**

1. Land on one screen: a prompt box and an empty plan canvas.
2. Type the house description and press Generate.
3. Watch the "checking" panel: each rule ticks green, and any fix round shows what failed and how Claude fixed it.
4. The 2D plan appears with room names and dimensions in feet.
5. Press **Walk through**: the camera drops into the front door at 5'6" eye height.
6. Walk with WASD + mouse; a minimap in the corner shows where you are on the plan.
7. Type an edit ("make the primary bedroom bigger"); plan and 3D update in place.

**3-minute demo script**

| Time | What happens | Who talks |
| --- | --- | --- |
| 0:00 to 0:20 | The problem: custom design costs thousands, plans are hard to picture | Pitch lead |
| 0:20 to 1:00 | A judge calls out a house; we type it live; the checker panel shows a fix round | Pitch lead + driver |
| 1:00 to 1:50 | Walk through it: front door, kitchen, down the hall, into a bedroom | Driver |
| 1:50 to 2:20 | Live edit: "make the kitchen bigger," walk back in to see it | Driver |
| 2:20 to 2:50 | Proof slide: raw Claude violation rate vs. ours (0%) | Pitch lead |
| 2:50 to 3:00 | Close: who this is for and what's next | Pitch lead |

**Backup:** keep 3 cached generations ready in case Wi-Fi or the API fails. Say so out loud if you use one.

## Six roles

Each role owns one piece and talks to the others only through the layout JSON (see Architecture). Fill in names in the Owner column.

| Role | Owner | Owns | Delivers | Done when |
| --- | --- | --- | --- | --- |
| 1. AI planner |  | Claude prompts and the fix loop | Prompt → room program JSON (rooms, target sizes, adjacencies); fix prompt that takes checker errors and returns a corrected program; edit prompt that changes only what was asked | 10 different prompts return valid JSON on the first try; a fed-back error gets fixed in 3 rounds or fewer |
| 2. Geometry solver |  | Turning the room program into exact walls | Python module: room program → rectangles that tile the footprint, shared walls, door and window positions, all in feet | Rooms never overlap, sizes stay within 10% of target, every room has a door |
| 3. Rule checker + eval |  | Layout rules and the proof number | Checker that returns plain-English errors ("Bedroom 2 has no exterior wall"); 30-prompt eval script comparing raw Claude vs. our loop | All rules in the rule list run in under 1 s; eval numbers ready for the proof slide by hour 18 |
| 4. 2D plan + app UI |  | Everything on screen except 3D | Next.js page: prompt box, live checker panel, SVG floor plan with names and dimensions, edit box, minimap component | A plan from the API renders correctly; the checker panel shows each rule and each fix round |
| 5. 3D walkthrough |  | The house you walk through | React Three Fiber scene: walls extruded from the plan, door openings, floors, simple lighting, first-person controls, wall collision, position sent to the minimap | Walk from the front door to every room at 60 fps without clipping through walls |
| 6. Backend + demo lead |  | Glue, deploy and the pitch | FastAPI server chaining planner → solver → checker; API contract; cached backup generations; deploy; pitch deck and demo script | Full flow runs on the deployed URL; the 3-minute demo has been rehearsed twice |

**Rule list for role 3 (starting set)**

- No two rooms overlap; all rooms fit inside the footprint
- Every room is reachable from the front door through doors
- Every bedroom has an exterior wall (for a window) and a door
- At least one bathroom is reachable without going through a bedroom
- Kitchen is next to the dining or living area
- Hallways are at least 3 ft wide; doors at least 2'8" wide
- Each room is within 10% of its requested size; total area within 10% of the prompt

**Pairings that must talk often:** 1 ↔ 3 (error message format), 2 ↔ 5 (units and wall format), 4 ↔ 5 (shared plan state and minimap), 6 ↔ everyone (API contract).

## Architecture

&#91;embedded content: system architecture · role per component\]

Claude never draws walls: it outputs a room program, the solver places exact geometry, and the checker sends failures back until every rule passes. The 2D plan and the 3D walkthrough both render the same layout JSON, so they can never disagree.

**Stack**

- Frontend: Next.js + React Three Fiber + drei (`PointerLockControls` for first person)
- Backend: FastAPI (Python) for planner, solver and checker
- AI: Claude via the Anthropic SDK with tool use, so output always matches the schema

**Layout JSON (the contract every role builds against; agree on it by hour 2)**

The planner fills `rooms` without positions; the solver adds `x`, `y`, `w`, `h`, `doors` and `windows`; the checker adds `checks`. All units are feet; origin is the footprint's top-left corner.

```json
{
  "footprint": {"width_ft": 50, "depth_ft": 36},
  "entrance": {"x": 25, "y": 36},
  "rooms": [
    {"id": "kitchen", "type": "kitchen", "name": "Kitchen",
     "target_sqft": 180, "adjacent_to": ["dining"],
     "x": 0, "y": 0, "w": 15, "h": 12}
  ],
  "doors": [{"between": ["kitchen", "hall"], "x": 15, "y": 4, "width_ft": 2.67}],
  "windows": [{"room": "kitchen", "wall": "south", "offset_ft": 4, "width_ft": 4}],
  "checks": [{"rule": "bedroom_exterior_wall", "pass": true, "message": ""}]
}
```

## 24-hour timeline

&#91;embedded content: 24-hour build plan · 5 checkpoints\]

Hour 8 is the gate that matters: if a prompt can't become a walkable house by then, switch the solver to the grid fallback immediately.

- **H2, schema agreed:** the layout JSON is locked and the API returns a hardcoded sample, so roles 4 and 5 start building against it right away.
- **H8, end-to-end run:** prompt → plan → walkthrough works once, even if ugly.
- **H14, features in:** every must-ship goal works on the deployed URL.
- **H18, code freeze:** eval numbers are in the deck; only bug fixes after this.
- **H18 to H24:** cache backup generations, rehearse the demo twice, sleep in shifts.

## Risks, fallbacks and cut list

The biggest risk is the solver: if rooms can't be placed cleanly, nothing downstream works, so it gets the first integration checkpoint.

| Risk | Fallback |
| --- | --- |
| Solver can't tile arbitrary room sets | Restrict to a fixed rectangular footprint and a grid of 1 ft cells; place rooms with a simple greedy packer before trying anything smarter |
| Fix loop doesn't converge | Cap at 4 rounds; if still failing, retry from a fresh plan; show the attempt count honestly |
| Claude returns broken JSON | Use tool use / structured output with a strict schema; validate and retry once |
| 3D collision is buggy | Use simple axis-aligned wall boxes for collision instead of mesh collision |
| API slow or Wi-Fi down at demo | 3 cached generations ready; say out loud when you use one |
| Edits regenerate the whole house | Edit prompt changes only the named rooms; solver keeps every other room fixed |

**Cut list (drop in this order if behind)**

1. Furniture placeholders
2. Windows (keep doors)
3. Minimap
4. Edit-by-text (keep generate + walk through)

**Never cut:** the checker loop, the walkthrough, and the proof slide. Those three are the pitch.
