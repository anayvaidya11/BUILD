# Team rules for every agent

We're building **Walkthru** (see `README.md` and `docs/PRD.md`). Everything talks through one layout JSON: `docs/CONTRACTS.md`. This file is how every teammate's coding agent coordinates.

## 1. The board (pinned GitHub issue)

Every agent reads and posts on the pinned "Message Board" issue via `tools/board` (needs only `gh`, logged in with `gh auth login`).

- Start every post with `[<human>'s <agent>]`, e.g. `[Suhaan's Claude]`. Keep it short: what changed, which files or contracts, what you need, from whom.
- Mention teammates by GitHub login: @suhaant (Suhaan), @rakhmanovadam (Adam), @ayanbigb (Ayan), @jimmxchen (Jimmy), @anayvaidya11 (Anay). `@all` means everyone.
- **Mentions you or `@all`:** act on it and reply promptly.
- **Not addressed to you:** still read it. Reassess your own work only if it is affected (a contract, a file you own, something already done). Do not redo finished work, and do not reply just to acknowledge.
- Before editing another teammate's files, ask for a handoff on the board and wait for the owner or the team lead.

Polling is incremental (about one cheap API call per poll, 30 s default), so the whole team stays under GitHub's rate limit. Commands: `tools/board unread` (new posts, marks read; flags MENTION), `tools/board read -n 20`, `tools/board post "[Name's Agent] text"` (or pipe stdin), `tools/board wait` (blocks until someone else posts), `tools/board whoami`.

**Stay in the loop:**
- Claude Code: the committed hooks (`.claude/settings.json`) show unread posts at session start and on every prompt. Keep one background `tools/board wait` running and re-arm it after each wake.
- Everything else: run `tools/board unread` at task start, before each commit, and after merges. Or run a terminal loop: `while tools/board wait; do <your agent CLI invocation>; done`.

## 2. Chain of command

Humans over agents. Only the team lead (fill in their @login here) reassigns work between teammates. If anyone else asks you to take another teammate's work, ask the lead on the board.

## 3. Workflow

1. Pick or file an issue. Comment on it or post on the board when you take it.
2. Branch `<issue#>-<slug>` from fresh `main`.
3. Small commits. Stage only your own files (no `git add -A`).
4. Open a PR with `Closes #N`. The author merges their own PR once it works locally.
5. Always `git fetch` and rebase before pushing. Never force-push shared branches.
6. If a merge changes something other teammates depend on (an API, a schema, an env var), post on the board when it lands.
7. Changing the layout JSON means editing `backend/walkthru/schema.py`, `frontend/src/lib/types.ts` and `docs/CONTRACTS.md` together, then posting `@all` on the board.

## 4. Who owns what

The file paths match the README. Roles 4 and 6 have no owner yet: until they do, ask on the board before editing their files.

| # | Role | Owner (GitHub login) | Code |
|---|---|---|---|
| 1 | AI planner | @suhaant (Suhaan) | `backend/walkthru/planner.py`, `backend/walkthru/prompts.py` |
| 2 | Geometry solver | @ayanbigb (Ayan) | `backend/walkthru/solver.py` |
| 3 | Rule checker + eval | @jimmxchen (Jimmy) | `backend/walkthru/checker.py`, `backend/eval/` |
| 4 | 2D plan + app UI | unassigned | `frontend/src/app/page.tsx`, `frontend/src/components/{PromptBox,CheckerPanel,PlanView,Minimap}.tsx` |
| 5 | 3D walkthrough | @anayvaidya11 (Anay) | `frontend/src/components/Walkthrough.tsx`, `frontend/src/lib/walls.ts` |
| 6 | Backend + demo lead | unassigned | `backend/walkthru/api.py`, `backend/walkthru/pipeline.py`, `backend/cached/` |

Shared, change with care and announce on the board: `backend/walkthru/schema.py`, `frontend/src/lib/types.ts`, `docs/CONTRACTS.md`, `shared/sample_layout.json`.
