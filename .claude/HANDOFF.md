# Studio CRM — session handoff

Context for picking this project up in a fresh session. No secrets live in this file
(it is committed to GitHub) — credentials are in `apps/api/.env`, which is gitignored.

Last updated: 2026-09-22.

## What this project is

`studioCRM` — a business app being built **on top of an ERP boilerplate**. The boilerplate
was set up and verified working; no feature code has been written yet. Everything currently
in git history is boilerplate, not project code.

- Working directory: `C:\Dhaval Bhai\Studio Billing` (Windows 11, PowerShell + Git Bash)
- Stack: pnpm monorepo — `apps/api` (Fastify 5 + Drizzle + Postgres), `apps/web`
  (Vite + React 18 + Tailwind), `packages/shared` (enums, permission catalog, nav, zod schemas)
- `README.md` documents the boilerplate's architecture and the ~10-minute "add a module" recipe.
  Read it before adding modules — it is still accurate for how the code works.
- **Phase 0 (done, 2026-09-22): the Claude Code development environment.** `CLAUDE.md` holds the
  always-loaded rules; `docs/ARCHITECTURE.md`, `docs/UI_DESIGN_SYSTEM.md` and `docs/DEVELOPMENT.md`
  hold the detail; `.claude/agents/` has five specialists and `.claude/skills/studio-*` the
  workflows; `.claude/hooks/guard-bash.mjs` blocks destructive commands. No business code changed.

## Git

| Remote | Purpose |
| --- | --- |
| `origin` → `https://dhadukmanish@github.com/dhadukmanish/studioCRM.git` | **This project.** `main` tracks `origin/main` |
| `https://github.com/dhadukmanish/erp-boiler-plate-new.git` | The upstream boilerplate. Left untouched, not wired as a remote |

**Credential gotcha — do not "fix" this.** This machine has two saved GitHub credentials:
`git:https://github.com` belongs to `manish-nishad-1984`, which has **no write access** to
`dhadukmanish/*` and causes `403 Permission denied`. The origin URL therefore deliberately
embeds the username (`https://dhadukmanish@github.com/...`) so git picks the right account.
Keep the `dhadukmanish@` in the URL. Nothing needs to be deleted from Credential Manager.

Untracked in the working tree (intentionally not committed): `erp-boilerplate.bundle`
(the original boilerplate delivery, now redundant) and `studio form image.pdf`
(a form design reference for this project).

## Environment setup already done

- `.npmrc` shipped with the repo (`auto-install-peers`, `strict-peer-dependencies=false`) — unchanged
- `apps/api/.env` and `apps/web/.env` created from their `.env.example` files
- `pnpm install` done (269 packages)
- **pnpm is not installed globally.** It was activated via corepack:
  `corepack prepare pnpm@10.28.0 --activate` (version is pinned by `packageManager` in
  `package.json`). If `pnpm` is missing in a new shell, run that again.
- pnpm skipped esbuild's build scripts (its default policy). This is **harmless** — Vite boots
  and builds fine. Do not run `pnpm approve-builds` to chase it.

## Database — not the boilerplate default

The README's `docker compose up -d` path does **not** work here: Docker is not installed on
this machine. The app points at a **hosted Postgres 18.4** instead:

- Host `pg8001.site4now.net`, port `6432`, database `db_9a7009_studio`, user `9a7009_studio`
- Full `DATABASE_URL` (with password) is in `apps/api/.env` — read it from there
- The password contains `@@`, which **must stay percent-encoded** as `%40%40` inside the URL,
  or the connection string parses wrong
- No SSL parameters needed
- Migrations and seed have been applied: 11 tables in `public`, users `admin@example.com`
  and `viewer@example.com` present

Local Postgres also exists but **could not be used**: PG 18 on port 5432 and PG 17 on 5433 are
both running with `scram-sha-256` auth and the `postgres` superuser password is unknown, so the
`erp` role/database the boilerplate expects could not be created. If you ever switch to local,
that password is the only blocker. `psql` is not on PATH — it lives at
`C:\Program Files\PostgreSQL\18\bin\psql.exe`.

## Commands

```
pnpm dev          # both servers  (api :4000, web :5173 — web proxies /api → api)
pnpm dev:api      # api only
pnpm dev:web      # web only
pnpm db:generate  # after editing a schema file
pnpm db:migrate
pnpm db:seed
pnpm typecheck
pnpm build
```

Dev servers may already be running in the background from an earlier session — check ports
4000 and 5173 before starting another `pnpm dev`, or you will get a port conflict.

## Verified working

Confirmed end-to-end in a real browser, not just by reading code:

- `GET http://localhost:4000/api/health` → `200 {"status":"up"}`
- `http://localhost:5173` serves the SPA; Vite's `/api` proxy reaches the API
- Login with `admin@example.com` / `Admin@1234` → redirects to `/dashboard`, sidebar and nav render
- Top-bar theme switcher: **Light**, **Dark** and **Olive** all apply correctly
  (`data-theme` on `<html>`, persisted in `localStorage` under `erp-ui`), zero console errors

Seeded logins: `admin@example.com` (Super Admin, everything) and `viewer@example.com`
(read-only, useful for testing RBAC) — both password `Admin@1234`.

`.claude/scripts/verify-ui.mjs` re-runs that browser check with no extra dependencies
(headless Chrome over CDP, using Node's built-in `WebSocket`). See the header comment in the
file for how to launch Chrome and run it.

## Known pending work

Nothing here is broken — these are boilerplate leftovers to deal with when real work starts:

- Workspace packages are still named `@erp/*` (the UI says StudioCRM) — renaming them is its
  own task and touches every import
- `README.md` is still the boilerplate's README
- `JWT_SECRET=change-me-in-production` in `apps/api/.env` — fine for dev, must change before deploy
- The sample module (`apps/api/src/routes/sample.ts`, `apps/web/src/pages/sample/CategoriesPage.tsx`,
  `apps/api/src/db/schema/sample.ts`) is a template meant to be deleted once real modules exist
- **Item Master is built** (`masters_items` permission, `items` table, `/api/masters/items`,
  `/modules/masters/items`). Two follow-ups: existing roles other than Super Admin need the
  new permission ticked in Settings → Roles (role grants are stored JSON, seeded before the
  permission existed), and the item list starts empty — no business data was invented.
- Sub Item Master, Book Master, Appointments, Billing and Reports are not started.
  `studio form image.pdf` in the working directory is the client's form reference — read it
  before guessing at the next module's data model
