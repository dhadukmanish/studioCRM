# StudioCRM — Development

How to set up and work in this repo. Live environment facts that change between sessions
(which database is in use, what is running, what is pending) live in `.claude/HANDOFF.md`.

## Prerequisites

- Node >= 20 (developed on 24.x)
- pnpm 10.28.0 — pinned by `packageManager`. Not installed globally on the current machine;
  activate it with `corepack prepare pnpm@10.28.0 --activate` if `pnpm` is missing from a new
  shell. **Never use npm or yarn in this repo** — it would fork the lockfile.
- PostgreSQL. The repo ships a `docker-compose.yml`, but the current machine has no Docker and
  points at a hosted Postgres instead; see `.claude/HANDOFF.md`.

## First-time setup

```bash
pnpm install
cp apps/api/.env.example apps/api/.env      # then fill in DATABASE_URL, JWT_SECRET
cp apps/web/.env.example apps/web/.env
pnpm db:migrate
pnpm db:seed                                 # fresh database only
pnpm dev
```

Seeded logins (dev only): `admin@example.com` (Super Admin) and `viewer@example.com`
(read-only, the quickest way to prove an RBAC check works) — password `Admin@1234`.

`pnpm install` reports skipped build scripts for esbuild. That is pnpm's default policy and is
harmless here; do not run `pnpm approve-builds` to chase it.

## Environment

`apps/api/.env` — `DATABASE_URL`, `JWT_SECRET`, `PORT`, `CORS_ORIGIN`, `LOG_LEVEL`.
`apps/web/.env` — `VITE_APP_NAME`, other `VITE_*` values.

Both are gitignored and **must stay that way**. Never paste a connection string, password or
token into a file, a commit message, a log or a chat. If a URL-encoded password is involved,
keep it encoded (`@` → `%40`) or the connection string parses wrong.

## Daily commands

```bash
pnpm dev            # api :4000 + web :5173 in parallel
pnpm dev:api
pnpm dev:web
pnpm typecheck      # whole monorepo — the primary quality gate
pnpm --filter @erp/api typecheck    # narrow, run this first
pnpm test           # Vitest (apps/api). DB-backed suites need TEST_DATABASE_URL, else they skip
pnpm build
pnpm db:generate    # after editing apps/api/src/db/schema/*.ts
pnpm db:migrate
pnpm db:seed
```

Servers are often already running from an earlier session. Check before starting another:

```bash
curl -s http://localhost:4000/api/health     # {"data":{"status":"up"}}
curl -s -o /dev/null -w "%{http_code}" http://localhost:5173
```

## Adding a module

Shared contract → schema → migration → API route → web page. The step-by-step recipe with code
is in `README.md` ("Adding a module"); the rules and hooks are in the `studio-backend`,
`studio-database` and `studio-frontend` skills. `crudRoutes` + `MasterPage` cover most masters
in a few dozen lines of configuration.

## Verifying a change

1. `pnpm --filter <package> typecheck` for what you touched.
2. Exercise it for real: `curl` the endpoint with a bearer token, or use the screen at
   `localhost:5173`. `.claude/scripts/verify-ui.mjs` runs a dependency-free headless-browser
   check (login + theme switch) — see the header comment in that file.
3. `pnpm typecheck` across the monorepo before calling it done.

## Git

`git status` before starting — the working tree may hold the user's own changes; never
overwrite them. Commits stay focused, and only when asked. Nothing is pushed unless the user
asks. Force push, history rewrite and `reset --hard` over uncommitted work need explicit
approval. Never commit `.env`, a dump, or anything containing a credential.

The origin URL deliberately embeds the account name (`https://dhadukmanish@github.com/...`)
because this machine has a second saved GitHub credential without write access — see
`.claude/HANDOFF.md`. Leave it as it is.

## Claude Code setup in this repo

```
CLAUDE.md                    always-loaded project rules — keep it short
.claude/agents/*.md          frontend / backend / database / test / code-reviewer specialists
.claude/skills/*/SKILL.md    studio-feature, -frontend, -backend, -database, -testing, -code-review
.claude/commands/handoff.md  /handoff — load or update the session handoff
.claude/settings.json        shared permissions + the dangerous-command guard hook
.claude/hooks/guard-bash.mjs blocks force push, history rewrite, DB destruction, secret printing
.claude/HANDOFF.md           live session state
docs/                        ARCHITECTURE, UI_DESIGN_SYSTEM, DEVELOPMENT (this file)
```

Starting a fresh session: read `CLAUDE.md`, run `/handoff`, check `git log --oneline -5`, then
open only the code the task needs.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `pnpm: command not found` | `corepack prepare pnpm@10.28.0 --activate` |
| Port 4000/5173 already in use | a dev server from an earlier session is still running — reuse it |
| API cannot connect to Postgres | check `DATABASE_URL` in `apps/api/.env`; a `@` in the password must be `%40` |
| Migration already applied / out of sync | write a new forward migration. Never drop or reset the database |
| 403 on an endpoint that should work | the permission key is missing from the role — check the roles matrix, not the code |
| Login works but calls 401 | access token expired and refresh failed — check `JWT_SECRET` and the refresh flow in `lib/api.ts` |
