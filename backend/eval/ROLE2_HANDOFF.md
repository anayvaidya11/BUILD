# Role 3 → Role 2: door geometry handoff

Role 3 is adding a hard `door_geometry` check. Every door must name two valid endpoints, sit on their shared wall (or the footprint boundary for an exterior door), and fit entirely within that wall. The front door must match `layout.entrance`. A misplaced door will not count toward reachability.

## Baseline defect to fix

The current sample gives Laundry a 2.5 ft wall shared with Hall (`x = 0` to `2.5`, `y = 19`). The solver places a 3 ft door centered at `(1, 19)`, so the opening spans `x = -0.5` to `2.5` and extends 0.5 ft beyond Laundry's wall. The current checker passes this because it checks door width but not placement or fit.

Please update `solver.solve()` so every emitted doorway fits its actual shared wall. A door must still meet the existing minimum width of 2'8". Avoid fixing this case by narrowing the Laundry door below that minimum. Check other narrow rooms and exterior doors as well.

After the solver fix, regenerate `shared/sample_layout.json`, sync `frontend/src/lib/sample-layout.json`, and refresh `backend/cached/sample_offline.json` if it still contains the old layout. The generated sample and offline smoke test should pass all checker rules, including `door_geometry`.

## Contract reminder

Coordinates and widths are in feet. `Door.x` and `Door.y` are the center of the opening. The room rectangles and doors use the 0.5 ft grid described in `docs/CONTRACTS.md`.
