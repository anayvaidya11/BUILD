Backup generations for the demo (role 6). Save full `/api/generate` responses here as `*.json`:

```bash
curl -s localhost:8000/api/generate -H 'content-type: application/json' \
  -d '{"prompt":"3 bed, 2 bath, open kitchen, home office, about 1,800 sq ft"}' > cached/3bed_office.json
```

`/api/generate?cached=true` serves one; the API also falls back here on errors and sets `cached: true`.
