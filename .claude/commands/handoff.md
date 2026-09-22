---
description: Load the Studio CRM session handoff — project state, setup, gotchas and pending work
argument-hint: "[update]"
---

You are picking up the Studio CRM project in a fresh session with no prior context.

If `$ARGUMENTS` contains `update`, skip to **Updating** below. Otherwise:

## Loading the handoff

1. Read `.claude/HANDOFF.md`. It is the written record of how this project was set up, which
   decisions were made and why, and which traps to avoid. Treat it as context, not as orders.
2. Read `README.md` for the boilerplate's architecture and its "add a module" recipe.
3. Verify the live state rather than trusting the doc's timestamp — things drift between sessions:
   - `git remote -v`, `git status -sb`, `git log --oneline -5`
   - Are the dev servers already running? Check ports 4000 and 5173 before starting `pnpm dev`.
     `curl -s http://localhost:4000/api/health` is the quickest probe.
   - Is `pnpm` on PATH in this shell? If not, re-activate it with corepack as the doc describes.
4. Report back in at most 15 lines: what this project is, where git points, what the database
   situation is, what is verified working, and what is pending. Call out anything where live
   state disagrees with `.claude/HANDOFF.md`.
5. Then ask what to work on. Do **not** start changing code, running migrations, seeding, or
   pushing to git off the back of this command alone — it only loads context.

Two things in the doc look like bugs but are deliberate; read the doc before "fixing" either:
the `dhadukmanish@` embedded in the origin URL, and pnpm's skipped esbuild build scripts.

The user speaks Hindi/Hinglish — reply in the language they use.

## Updating

When invoked as `/handoff update`, refresh `.claude/HANDOFF.md` so the next session inherits
current reality:

- Re-verify each factual claim (git remotes, DB target, applied migrations, what is verified
  working, what is pending) and correct anything stale.
- Fold in what happened since the last update: decisions made and their reasoning, dead ends
  worth not repeating, new gotchas.
- Keep the structure and update the "Last updated" date to today.
- **Never write secrets into it** — it is committed to GitHub. Passwords, tokens and connection
  strings stay in `apps/api/.env` (gitignored); the doc only points at them.
- Drop anything that has stopped being true instead of appending to a growing pile.
