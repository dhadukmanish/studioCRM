# Studio CRM — session handoff

Context for picking this project up in a fresh session. No secrets live in this file
(it is committed to GitHub) — credentials are in `apps/api/.env`, which is gitignored.

Last updated: 2026-09-23.

## What this project is

`studioCRM` — a business app for a photography/video studio, built **on top of an ERP
boilerplate**. The boilerplate provides multi-tenant auth, RBAC, custom fields, an audit log and
a data-table kit; the Masters layer on top of it is project code.

- Working directory: `C:\Dhaval Bhai\Studio Billing` (Windows 11, PowerShell + Git Bash)
- Stack: pnpm monorepo — `apps/api` (Fastify 5 + Drizzle + Postgres), `apps/web`
  (Vite + React 18 + Tailwind), `packages/shared` (enums, permission catalog, nav, zod schemas)
- `README.md` is still the boilerplate's README, and its "Adding a module (≈ 10 minutes)"
  recipe is still accurate — read it before adding a module.
- `CLAUDE.md` holds the always-loaded rules; `docs/ARCHITECTURE.md`, `docs/UI_DESIGN_SYSTEM.md`,
  `docs/DEVELOPMENT.md` and `docs/BILL_NUMBERING.md` hold the detail; `.claude/agents/` has five
  specialists, `.claude/skills/studio-*` the workflows, `.claude/hooks/guard-bash.mjs` blocks
  destructive commands.

### What is built

| Module | Permission | API | Screen |
| --- | --- | --- | --- |
| Item Master | `masters_items` | `/api/masters/items` | `/modules/masters/items` |
| Sub Item Master | `masters_sub_items` | `/api/masters/sub-items` | `/modules/masters/sub-items` |
| Account Group Master | `masters_account_groups` | `/api/masters/account-groups` | `/modules/masters/account-groups` |
| Account Master | `masters_accounts` | `/api/masters/accounts` | `/modules/masters/accounts` |
| Book Master | `masters_books` | `/api/masters/books` | `/modules/masters/books` |

All of them follow the same shape: `crudRoutes` + a shared zod schema + a compact Drawer form,
except Account Master, which is hand-written because an account and its group-specific detail
block are two tables written in one transaction.

### Book Master is the bill number series

Not a text master. Each book (`2026-27`, `2027-28`) is one **independent** bill number series:
bills under it run 1, 2, 3 … and a new book starts again from its own `seriesStartsAt`. Two
books may both hold a Bill No. 1. Nothing resets a series by calendar — creating a book is the
only boundary.

- The counter is `books.next_bill_number`, seeded from `series_starts_at` on create.
- It moves **only** through `allocateBillNumber` (`apps/api/src/services/billNumbers.ts`), a
  single `UPDATE … RETURNING` that is concurrency-safe. Never `SELECT max(...) + 1`.
- `bookSchema` has no `nextBillNumber` field, so no request body can set it. There is
  deliberately no "reset bill number" endpoint or permission.
- `seriesStartsAt` is editable only while the book has issued nothing; once the counter has
  moved the API refuses to change it. That lock needs no change when Billing arrives.
- **Nothing calls the allocator yet.** Bills do not exist. The contract the Billing phase must
  honour — the `bills` table shape, `UNIQUE(tenant_id, book_id, bill_number)`, the composite FK
  with RESTRICT — is written down in `docs/BILL_NUMBERING.md`. Read it before starting Billing.

## Git

| Remote | Purpose |
| --- | --- |
| `origin` → `https://dhadukmanish@github.com/dhadukmanish/studioCRM.git` | **This project** |
| `https://github.com/dhadukmanish/erp-boiler-plate-new.git` | The upstream boilerplate. Left untouched, not wired as a remote |

**Credential gotcha — do not "fix" this.** This machine has two saved GitHub credentials:
`git:https://github.com` belongs to `manish-nishad-1984`, which has **no write access** to
`dhadukmanish/*` and causes `403 Permission denied`. The origin URL therefore deliberately
embeds the username (`https://dhadukmanish@github.com/...`) so git picks the right account.
Keep the `dhadukmanish@` in the URL. Nothing needs to be deleted from Credential Manager.

**Nothing has been pushed in a while.** As of this update: current branch is
`masters/account-master` (no upstream), `main` is **4 commits ahead of `origin/main`**, and
Book Master is **uncommitted** in the working tree. Whoever picks this up should decide what to
commit and push rather than assume the remote is current.

Untracked in the working tree (intentionally not committed): `erp-boilerplate.bundle`
(the original boilerplate delivery, now redundant) and `studio form image.pdf`
(the client's form design reference — read it before guessing at a module's data model).

## Environment setup already done

- `.npmrc` shipped with the repo (`auto-install-peers`, `strict-peer-dependencies=false`) — unchanged
- `apps/api/.env` and `apps/web/.env` created from their `.env.example` files
- `pnpm install` done. Node v24 is on PATH.
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
- **20 tables** in `public`; migrations `0000` … `0006` all applied (7 rows in
  `drizzle.__drizzle_migrations`). `0005` created `books`; `0006` dropped the sample
  `categories` table when the sample module was deleted.
- Seeded users `admin@example.com` and `viewer@example.com` are present

This is a **shared hosted database, not a scratch one.** It holds real entered data — there is
already a `2026-27` row in `books` that the owner created by hand. Never reseed it, never drop
it, never point a destructive test suite at it (see Testing below).

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
pnpm test
pnpm build
```

Dev servers are usually already running in the background from an earlier session — check ports
4000 and 5173 before starting another `pnpm dev`, or you will get a port conflict.
`curl -s http://localhost:4000/api/health` is the quickest probe.

## Testing

Vitest runs in `apps/api` only (pinned to v3 — v5 needs Vite 6, this repo is on Vite 5).
Each module's test file has two sections:

- **A — pure validation** (zod schemas). Always runs. ~208 tests pass today.
- **B — database-backed** (tenant isolation, RBAC, duplicate guards, the bill-number
  allocator's concurrency). `describe.skipIf(!TEST_DATABASE_URL)`, so it **skips by default**.

Section B creates and deletes tenants, roles and users. `TEST_DATABASE_URL` must point at a
**throwaway** database — never at the hosted `DATABASE_URL` above. Because no throwaway database
is configured on this machine, section B has never actually run; the behaviour it covers was
instead verified by hand against the dev API and then cleaned up.

## Verified working

Confirmed end-to-end in a real browser / against the live API, not just by reading code:

- `GET http://localhost:4000/api/health` → `200 {"status":"up"}`; `http://localhost:5173` serves
  the SPA and Vite's `/api` proxy reaches the API
- Login with `admin@example.com` / `Admin@1234` → `/dashboard`, sidebar and nav render
- Theme switcher: **Light**, **Dark** and **Olive** all apply (`data-theme` on `<html>`,
  persisted in `localStorage` under `erp-ui`), zero console errors
- Book Master (2026-09-23): list + columns, Add/Edit drawer, case-insensitive duplicate error,
  `seriesStartsAt` rejection of 0 / decimal / blank, custom start 1001, Ctrl+S save, Escape
  close, delete confirmation, active-only lookup. All temporary records were deleted afterwards.
- `allocateBillNumber` concurrency: 25 parallel allocations on one book returned 25 distinct,
  gapless numbers, while a second book stayed on its own series.
- `pnpm typecheck`, `pnpm test`, `pnpm build` all clean.

Seeded logins: `admin@example.com` (Super Admin, everything) and `viewer@example.com`
(read-only, useful for testing RBAC) — both password `Admin@1234`.

`.claude/scripts/verify-ui.mjs` re-runs the login + theme browser check with no extra
dependencies (headless Chrome over CDP, using Node's built-in `WebSocket`). See the header
comment for how to launch Chrome and run it. **Gotcha:** the Chrome profile it uses keeps the
session, so on a second run the app is already signed in and there is no login form — the script
assumes one and will throw. Guard the login step when reusing it.

## Known pending work

- **Appointments, Billing and Reports are not started.** Billing must start from
  `docs/BILL_NUMBERING.md`. The intended flow is Appointment first, then a Bill that picks up
  the appointment/customer instead of retyping it.
- **New permissions need existing roles re-saved.** Role grants are stored JSON, seeded before
  the newer permissions existed, so roles other than Super Admin (which bypasses everything)
  do not have `masters_items` … `masters_books` ticked. Per the README, opening a role in
  Settings → Roles and saving it picks up new permissions.
- Workspace packages are still named `@erp/*` (the UI says StudioCRM). Renaming them is its own
  task and touches every import.
- `README.md` is still the boilerplate's README.
- `JWT_SECRET=change-me-in-production` in `apps/api/.env` — fine for dev, must change before
  deploy. So must the seeded `Admin@1234` logins: the boilerplate publishes that default in
  `seed.ts` and `README.md`, and the database behind it is hosted, not local.
- No lint/format tooling is installed by design. Match the surrounding style; `.editorconfig`
  (2 spaces, LF) is the only rule.
