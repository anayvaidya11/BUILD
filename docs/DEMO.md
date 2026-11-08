# Walkthru demo runbook

## Release checks

Run these after the solver and checker are both on `main`:

```bash
cd backend
.venv/bin/python -m pytest -q
.venv/bin/python cached/build_backups.py --check
```

The backup check requires three distinct, valid files: `3bed_office.json`,
`2bed_cottage.json`, and `4bed_family.json`. If they are missing, export
`ANTHROPIC_API_KEY` and run `.venv/bin/python cached/build_backups.py`, then
rerun `--check`. Commit the JSON files before deploying. A missing key cannot
be replaced with three copies of the offline sample.

After deployment, set `API_URL` to the Render service URL and check the live
service. Confirm the returned layouts have no failing checks and that the backup
response says `cached: true`.

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

The proof slide needs the **final** evaluation after the stricter checker and
solver refresh land. The earlier 73% raw versus 0% pipeline figure used the old
checker and should not be labeled as the final result. Run from `backend/`:

```bash
.venv/bin/python -m eval.run_eval --mode both --n 30
```

Record the raw and pipeline violation counts, average generation time, and any
API errors on the slide. Rehearse the sequence twice on the deployed URL, once
with live generation and once with a backup. Record the duration, result of the
edit, whether every displayed check passed, and the URL tested.
