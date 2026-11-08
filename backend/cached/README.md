Backup generations for the demo (role 6). Save full `/api/generate` responses here as `*.json`:

```bash
curl -s localhost:8000/api/generate -H 'content-type: application/json' \
  -d '{"prompt":"3 bed, 2 bath, open kitchen, home office, about 1,800 sq ft"}' > cached/3bed_office.json
```

`/api/generate?cached=true` serves one; the API also falls back here on errors and sets `cached: true`. Before serving a backup, the API reruns the current layout rules and ignores any invalid or unreadable file. If none pass, it returns 503.

Once the planner, solver, and checker are integrated and `ANTHROPIC_API_KEY` is exported, run `python cached/build_backups.py` from `backend/`. It generates and validates all three responses before saving any of them. Run `python cached/build_backups.py --check` after a solver or checker change and before rehearsing. The check needs no API key and fails if a file is missing, invalid, or duplicates another layout. Commit the three JSON files so the deployed service has them.
