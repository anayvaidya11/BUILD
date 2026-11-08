# Walkthru demo runbook

Open [`demo-deck.html`](demo-deck.html) in a browser for the five-slide deck.
Use the left and right arrow keys to navigate; browser Print can export it
as a PDF. Slide 3 cues the live product demo, and slide 4 holds the proof number.

## Release checks

Run these after the solver and checker are both on `main`:

```bash
cd backend
.venv/bin/python -m pytest -q
.venv/bin/python cached/build_backups.py --check
```

The backup check requires three distinct, valid files: `3bed_office.json`,
`2bed_cottage.json`, and `4bed_family.json`. If they are missing, run
`.venv/bin/python cached/build_backups.py --offline` to build curated layouts,
or export `ANTHROPIC_API_KEY` and run the script without `--offline` to use
live Claude generations. Rerun `--check` and commit the JSON files before
deploying. Identify the offline builds as curated backups if they appear in
the demo.

After deployment, set `API_URL` to the Render service URL and check the live
service. The Blueprint uses Render's free plan, which spins down when idle;
call `/health` shortly before the demo and confirm it is warm. Confirm the
returned layouts have no failing checks and that the backup response says
`cached: true`.

```bash
curl -fsS "$API_URL/health"
curl -fsS "$API_URL/api/sample"
curl -fsS -X POST "$API_URL/api/generate?cached=true" \
  -H 'content-type: application/json' -d '{"prompt":"demo backup"}'
curl -fsS -X POST "$API_URL/api/generate" \
  -H 'content-type: application/json' \
  -d '{"prompt":"3 bed, 2 bath, open kitchen, home office, about 1,800 sq ft"}'
```

Set the frontend's `NEXT_PUBLIC_API_URL` to the same service URL and
`WALKTHRU_CORS` on Render to the deployed frontend origin. Test generation,
walking, and editing on that URL. If live generation returns `cached: true`,
state that the backup was used; do not present it as a fresh generation.

## Three-minute sequence

| Time | Action |
|---|---|
| 0:00–0:20 | Name the problem: floor plans take time and are hard to picture. |
| 0:20–1:00 | Ask a judge for a house description. Type it and show the checker panel. Call out any fix rounds. |
| 1:00–1:50 | Open the walkthrough; enter through the front door and visit the kitchen, hall, and a bedroom. |
| 1:50–2:20 | Edit the kitchen by text. Show the updated 2D and 3D plan. |
| 2:20–2:50 | Show the proof slide from the final 30-prompt evaluation. State the sample size and measured violation rates. |
| 2:50–3:00 | Close with the intended user and next step. |

Backup prompt: “3 bed, 2 bath, open kitchen, home office, about 1,800 sq ft.”
Keep two other prompt descriptions matching the cottage and family backups ready.
If the API or network fails, use the cached endpoint and say so aloud.

## Proof slide and rehearsal

The [final 30-prompt rerun](eval/README.md) used the stricter checker and
refreshed solver on `main` at `c481fc0`. The [per-prompt results](eval/results-2026-11-08.json)
are committed for review:

| Measure | Raw Claude geometry | Walkthru pipeline |
|---|---:|---:|
| Plans with a rule violation | 22/30 (73%) | 0/30 (0%) |
| Mean time | 19.3 s | 8.0 s |
| Generation errors | — | 0 |

All 30 pipeline plans passed on the first attempt; 25 needed no checker fix,
four needed one, and one needed two. The slide headline is: **73% violated a
layout rule with raw Claude; 0% did with Walkthru.** State `n=30` on the slide.
To rerun from `backend/` with a live Anthropic key:

```bash
.venv/bin/python -m eval.run_eval --mode both --n 30
```

Record the raw and pipeline violation counts, average generation time, and any
API errors on the slide. Rehearse the sequence twice on the deployed URL, once
with live generation and once with a backup. Record the duration, result of the
edit, whether every displayed check passed, and the URL tested.
