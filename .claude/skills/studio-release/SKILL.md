---
name: studio-release
description: StudioCRM release lifecycle — discover, implement, test, review, commit, deploy, smoke test — with the staging hygiene, full-vs-hotfix decision, production migration review, environment preservation and read-safe live smoke test. The deployment mechanics themselves are the /deploy command and docs/DEPLOYMENT.md; this skill decides what must happen around them. Use when committing a finished feature or shipping to the live site.
---

# StudioCRM release

`discover → implement → test → review → commit → deploy → smoke test`

## 1. Before the commit

- Gates: `pnpm typecheck`, `pnpm test`, `pnpm build`, and the DB-backed suite on the throwaway DB
  (`studio-db-safety`) — report counts; the count never goes down.
- Browser check done (`studio-ui-verification`); a `code-reviewer` pass for anything substantial,
  blockers and high-confidence findings fixed.
- `git status`, `git diff --stat`, `git diff`. Stage files **by name**. Never stage `apps/api/.env`,
  any `.env*`, credentials, build output, screenshots, `erp-boilerplate.bundle` or
  `studio form image.pdf` (intentional untracked files — leave them alone).
- Commit only when the user asked for it in this session. Standard Co-Authored-By trailer.

## 2. Deciding the deployment kind

- **Full deployment** (panel rebuild from git, then `-FixWebConfig`) whenever the release changes
  the web bundle/assets, API routes, migrations, fonts/WASM (`harfbuzz.wasm`, PDF fonts), or
  dependencies — i.e. almost always.
- **`-Hotfix` is only for a server.js-only emergency fix** of an already-full-deployed tree. It
  uploads one file: never use it for a release that carries anything else.
- The host builds the **pushed branch** (`deploy/deploy.config.json` → `git.branch`, `main`), so a
  deploy needs the commit merged to that branch and pushed. Pushing and merging need the user's
  explicit authorization in this session — ask; do not infer it.

## 3. Production database

Before a deploy whose code needs new migrations: list pending (journal vs
`drizzle.__drizzle_migrations`), show the SQL, confirm additive / no counter reset / no bill
renumbering / no destructive seed, and apply with `pnpm db:migrate` only after approval. The
schema must be migrated before the new code serves traffic. Never reset the database because its
rows look like test data.

## 4. Environment

Preserve the host's site-root `.env` (DATABASE_URL, JWT_SECRET, PUBLIC_APP_URL,
PUBLIC_LINK_SECRET …); a release that needs a new variable says so before deploying. Never print
or commit a value.

## 5. Deploy and smoke

Follow `/deploy` (`.claude/commands/deploy.md`) exactly — dry-run, push, rebuild, `-FixWebConfig`,
`-VerifyOnly` (live `/api/health` SHA equals the pushed commit). Not zero-downtime; say so.
Then a **read-safe** live smoke test: login, each module's list and an existing record, invoice
preview/PDF, public link of an existing bill, themes — no dummy transactions unless approved.

## 6. Report

Commit SHA, live SHA, gates, migration result, smoke results, rollback pointer, final `git status`.
