# Walkthru

Describe a home in plain English → get a floor plan that passes real layout rules → walk
through it in first person in 3D. Full spec: [docs/PRD.md](docs/PRD.md).

```
prompt ─► planner (Claude) ─► room program ─► solver ─► layout ─► checker ─┬─ pass ─► 2D plan + 3D walk
              ▲                                                            │
              └────────────── plain-English failures (≤ 4 rounds) ◄────────┘
```

**Everything talks through one layout JSON: [docs/CONTRACTS.md](docs/CONTRACTS.md).**
Units are feet, origin top-left, rooms on a 0.5 ft grid.

## Quickstart

Backend (Python 3.11+):

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env              # add ANTHROPIC_API_KEY, then: export $(cat .env | xargs)
pytest -q                         # offline smoke tests, no key needed
uvicorn walkthru.api:app --reload --port 8000
```

No API key yet? `WALKTHRU_OFFLINE=1 uvicorn walkthru.api:app --reload` returns a canned
3-bed plan for every prompt, so UI and 3D work never block on Claude.

Frontend (Node 20+):

```bash
cd frontend
npm install
cp .env.example .env.local        # NEXT_PUBLIC_API_URL=http://localhost:8000
npm run dev                       # http://localhost:3000
```

The page loads `/api/sample` on start and falls back to the bundled
`src/lib/sample-layout.json` if the backend is down.

## The app (Site model)

`frontend/` is the build app: describe a home, watch it get planned and assembled on a floating
island model, then edit it, drag furniture between rooms, walk through it, view it on a real lot
("On site", Google 3D tiles) or open a photoreal Blender Cycles tour.

- Scene engine: `frontend/src/build/` (plain JS + three.js). `siteModelApp.js` is the page logic,
  `core.js` builds the house and furniture from the layout JSON, `planner.js` is an offline
  fallback planner used only when the API can't be reached.
- Generation and edits call the FastAPI backend (`NEXT_PUBLIC_API_URL`). The loading story replays
  the real checker rounds from the response; backup generations are labelled as such.
- Photoreal tour (optional): `render/blender_render.py` is a Modal app (`modal deploy render/blender_render.py`,
  reuses the `house-assets` volume) and `render/bridge.py` is a local server the app talks to:

```bash
python3 render/bridge.py          # http://127.0.0.1:8790, needs a logged-in Modal client
```

Each room renders on its own L40S (fast preview, then an automatic 4K pass). Without the bridge the
button reads "Photoreal offline".

## What works today (baseline, hour 0)

Every stage runs end to end with a deliberately simple implementation. Each owner replaces
theirs; the tests and contract keep everyone else unblocked.

- **Planner**: Claude (`claude-opus-5-5`, effort `low`) via structured outputs → `RoomProgram`; fix and edit prompts.
- **Solver**: open-plan public block + hallway spine with a band of rooms on each side; picks the
  best of a few hundred candidates against the checker's rules (incl. door geometry) in under 0.4 s;
  keeps unchanged rooms in place on edits. See `backend/walkthru/geometry/README.md`.
- **Checker**: all 7 PRD rules implemented with plain-English messages.
- **Pipeline/API**: fix loop (4 rounds, 1 fresh retry), cached-generation fallback.
- **2D**: SVG plan with names, dimensions, walls with door gaps, windows, entrance.
- **3D**: walls extruded from the same wall builder, floors, lights, PointerLock + WASD,
  AABB collision, minimap with position and heading.
- **Eval**: `backend/eval/run_eval.py`, 30 prompts, raw Claude vs. loop.

## Who owns what

| | Role | Owner | Code | First TODOs |
|---|---|---|---|---|
| 1 | AI planner | | `backend/walkthru/planner.py`, `prompts.py` | tune prompts so first-try JSON passes; measure rounds |
| 2 | Geometry solver | | `backend/walkthru/solver.py` | respect `adjacent_to`; avoid skinny rooms; keep rooms fixed on edits (`keep=`) |
| 3 | Rule checker + eval | | `backend/walkthru/checker.py`, `backend/eval/` | door-on-shared-wall rule; run eval, numbers by H18 |
| 4 | 2D plan + app UI | | `frontend/src/app/page.tsx`, `components/{PromptBox,CheckerPanel,PlanView,Minimap}.tsx` | stream fix rounds live; prompt timer; polish |
| 5 | 3D walkthrough | | `frontend/src/components/Walkthrough.tsx`, `lib/walls.ts` | door frames, materials, furniture placeholders, fps overlay |
| 6 | Backend + demo lead | | `backend/walkthru/api.py`, `pipeline.py`, `backend/cached/` | deploy; cache 3 backups; deck; rehearse |

Pairings: 1 ↔ 3 (error format), 2 ↔ 5 (units, walls), 4 ↔ 5 (plan state, minimap), 6 ↔ everyone (API).

## Repo layout

```
backend/
  walkthru/
    schema.py     layout JSON contract (Pydantic)         — shared, change with care
    prompts.py    Claude system prompts                    — role 1
    planner.py    prompt → RoomProgram, fix, edit          — role 1
    solver.py     RoomProgram → Layout                     — role 2
    checker.py    Layout → checks                          — role 3
    pipeline.py   planner → solver → checker fix loop      — role 6
    api.py        FastAPI                                  — role 6
  eval/           prompts.txt + run_eval.py (proof slide)  — role 3
  cached/         backup generations for the demo          — role 6
  tests/          offline smoke tests
frontend/         Next.js 16 + React Three Fiber + drei
  src/lib/        types.ts (contract mirror), api.ts, walls.ts, sample-layout.json
  src/components/ PromptBox, CheckerPanel, PlanView, Minimap, Walkthrough
shared/           sample_layout.json (canonical sample)
docs/             PRD.md, CONTRACTS.md
```

## Handy commands

```bash
# proof-slide numbers (from backend/, needs ANTHROPIC_API_KEY)
python -m eval.run_eval --mode both --n 30

# regenerate the shared sample after changing the solver (from backend/)
python -c "import json; from walkthru import solver, planner, checker; l=solver.solve(planner.sample_program()); l.checks=checker.check(l); open('../shared/sample_layout.json','w').write(json.dumps(l.to_json(), indent=2))"
cd ../frontend && npm run sync-sample

# save a backup generation for the demo (backend running)
curl -s localhost:8000/api/generate -H 'content-type: application/json' \
  -d '{"prompt":"3 bed, 2 bath, open kitchen, home office, about 1,800 sq ft"}' > backend/cached/3bed_office.json
```

## Deploy on Vercel

Deploy this GitHub repository as two Vercel projects: set one project's Root Directory to `backend/` for the FastAPI API and the other's to `frontend/` for Next.js. The backend's `pyproject.toml` points Vercel at `walkthru.api:app`.

Set these Vercel environment variables:

- Backend: `ANTHROPIC_API_KEY` and `WALKTHRU_CORS` set to the frontend's deployed origin.
- Frontend: `NEXT_PUBLIC_API_URL` set to the backend's deployed origin.

After deployment, verify the API's `/health`, `/api/sample`, and `/api/generate` endpoints and test generation, editing, and the 3D walkthrough on the frontend URL. See [docs/DEMO.md](docs/DEMO.md) for the full deployment and rehearsal checklist.

The API cache serves only backups that pass the current checker. Three distinct, validated curated backups are committed for the demo. Rebuild them with `python cached/build_backups.py --offline` from `backend/`, or run without `--offline` when an Anthropic key is available to capture live generations. See `backend/cached/README.md`.

## Timeline gates

- **H2** schema locked, `/api/sample` live ✅ (this skeleton)
- **H8** prompt → plan → walkthrough works once. If the solver can't, fall back to grid packing.
- **H14** all must-ship goals on the deployed URL
- **H18** code freeze, eval numbers in the deck

## Git

Small PRs to `main`, one per role where possible. Changing the layout JSON = edit
`schema.py` + `types.ts` + `docs/CONTRACTS.md` together and tell the team. Never commit `.env`.

## Agent board

Every teammate's coding agent coordinates on the pinned **Message Board** issue through `tools/board` (rules in [AGENTS.md](AGENTS.md)). One-time setup per person:

```bash
gh auth login          # GitHub CLI: https://cli.github.com
tools/board whoami     # prints your login if it works
```

Claude Code picks up the hooks in `.claude/` automatically: unread posts show at session start and on every prompt, and the agent keeps a background `tools/board wait` running so it wakes up when someone tags it. Other agents read `AGENTS.md` and run `tools/board unread` before each task.
