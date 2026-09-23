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
- `CLAUDE.md` holds the always-loaded engineering rules — stable rules only; current
  implementation status lives in THIS file. `docs/ARCHITECTURE.md`, `docs/UI_DESIGN_SYSTEM.md`,
  `docs/DEVELOPMENT.md` and `docs/BILL_NUMBERING.md` hold the detail; `.claude/agents/` has five
  specialists, `.claude/skills/studio-*` the workflows, `.claude/hooks/guard-bash.mjs` blocks
  destructive commands.

## What is built

### Foundation — auth, login, RBAC

From the boilerplate, kept and branded: multi-tenant auth (JWT access + refresh tokens),
RBAC (`role.permissions ∪ user.permissionOverrides`, `super_admin` bypasses everything),
companies & branches, the custom-fields engine, the `activity_logs` audit trail, and the
DataTable kit (search, filter builder, saved filters, column ordering, sorting, pagination).
Login and the user/role screens were simplified and the app is branded StudioCRM. Three themes
ship: light, dark, olive.

### Masters — project code

| Module | Permission | API | Screen |
| --- | --- | --- | --- |
| Item Master | `masters_items` | `/api/masters/items` | `/modules/masters/items` |
| Sub Item Master | `masters_sub_items` | `/api/masters/sub-items` | `/modules/masters/sub-items` |
| Account Group Master | `masters_account_groups` | `/api/masters/account-groups` | `/modules/masters/account-groups` |
| Account Master | `masters_accounts` | `/api/masters/accounts` | `/modules/masters/accounts` |
| Book Master | `masters_books` | `/api/masters/books` | `/modules/masters/books` |

They share one shape — `crudRoutes` + a shared zod schema + a compact Drawer form, with a
case-insensitive unique index as the real duplicate guard and a friendly `beforeSave` message in
front of it. Account Master is the exception: its routes are hand-written because an account and
its group-specific detail block are two tables written in one transaction, and its form is a
large modal rather than a drawer.

### Operations — project code

| Module | Permission | API | Screen |
| --- | --- | --- | --- |
| Appointments | `operations_appointments` | `/api/appointments` | `/modules/appointments` |

The studio's booking record, and the first module that is not a master: customer calls, a date
and usually a time are agreed, and the customer name, mobile and baby name are noted so Billing
can pick them up instead of asking again. Fields: system-issued Appointment No., date, optional
time, customer name, mobile, optional baby name, optional remark. Hand-written routes (not
`crudRoutes`) because creation takes its number inside the insert's own transaction. Its form is
a 760px modal; the list defaults to newest-first with a Today quick filter.

### Bill Number Series foundation

`allocateBillNumber` (`apps/api/src/services/billNumbers.ts`) exists, is documented and is
concurrency-proven — but **nothing calls it yet**, because bills do not exist. Appointments do
NOT use it; they have their own tenant-level counter. See the sections below.

### The sample module is gone

The boilerplate's `sample` / `categories` template was deleted once real modules existed
(commit `6599fc5`): its route, schema, shared zod schema, page, permission, nav section,
dashboard shortcut, custom-field module entry and demo rows, plus migration `0006` dropping the
`categories` table. Do not resurrect it — copy Item Master instead.

## Architectural decisions that must survive

These are load-bearing. Changing any of them is a deliberate decision, not a refactor.

- **Tenant-safe composite foreign keys.** A child never references a parent by `id` alone. Every
  parent carries `unique(id, tenant_id)` (`accounts_id_tenant_uk`, `books_id_tenant_uk`, the
  same on `items`), and every child references the **pair** `(parent_id, tenant_id)`. Pointing
  at another tenant's row is structurally impossible, not merely checked for. Live examples:
  `sub_items → items`, `accounts → account_groups`, `account_party_details → items` (all
  RESTRICT), and the detail tables → `accounts` (CASCADE). RESTRICT is the rule for anything
  with history: such a row is deactivated, never deleted out from under its children.
- **Typed Account detail extension tables, not a JSON blob.** `account_bank_details`,
  `account_employee_details`, `account_loan_details`, `account_partner_details` and
  `account_party_details` are 1:1 extensions keyed by `account_id` as the primary key. They hold
  only the extra fields — never a second copy of the account's identity — and a row exists only
  while the account's group actually drives that block, so changing the group removes the stale
  row instead of hiding it. Typed columns keep the data queryable (every employee, every bank
  account) and keep money in a real `numeric` column.
- **Account Master uses a large modal on purpose.** `<Modal size="xl" maxHeight="max-h-[88vh]">`,
  not the `<Drawer>` the other masters use: the common fields plus the group-driven detail block
  do not fit a drawer without burying the operator in scrolling. Ctrl/Cmd+S saves; Escape, focus
  trapping and focus restore belong to `<Modal>`.
- **A Book is the explicit bill-series boundary.** A series exists because somebody created a
  Book. Creating a new Book starts a fresh, **independent** series from its own
  `seriesStartsAt` — two books may both hold a Bill No. 1.
- **No calendar-driven reset.** Nothing resets a bill number by month, year or financial year.
  If the numbering is meant to restart, a new Book is created. There is deliberately no "reset
  bill number" endpoint and no permission for one.
- **Bill numbers come from an atomic server-side `UPDATE … RETURNING`.** One statement takes the
  number and advances the counter; Postgres locks the book row, so simultaneous operators queue
  up and receive different numbers.
- **Never `SELECT max(bill_no) + 1`.** That read-then-write window is exactly what
  `allocateBillNumber` exists to replace. It must not reappear anywhere, in any module.
- **`allocateBillNumber` must later run INSIDE the same transaction that inserts the bill.** It
  takes an `Executor` (`db` or a transaction handle) as its first argument for precisely this
  reason, so a failed bill rolls its number back with it. Never call it to preview or display a
  number: every call consumes one.
- **Generic lookups expose only what a picker needs.** `/api/common/lookups/*` is readable by
  every authenticated user, so it never carries sensitive or internal fields. `lookups/books`
  returns `id` + `bookNumber` only — the counter is not a picker's business. `lookups/accounts`
  returns id, name and group / head group — never PAN, GST, salary, bank account number or
  opening balance. Active rows only, so a deactivated row is not offered for a new transaction.
  `lookups/appointments` goes further and requires `operations_appointments` read, because it
  carries a customer's name and number rather than a picker label.
- **Two numbering shapes, never coupled.** A BILL number belongs to a Book row
  (`books.next_bill_number`), so two books can each hold a Bill No. 1. An APPOINTMENT number is
  a tenant-level sequence held in `document_counters` (one row per tenant per document type)
  and taken through `allocateDocumentNumber` (`services/documentNumbers.ts`) — a single
  `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` that creates the counter on first use and
  otherwise advances it under a row lock. Creating an appointment must never move a book's
  counter, and `services/billNumbers.ts` stays untouched. A future Voucher or Receipt number
  belongs in `document_counters` too — it needs no new table, only a new `DocumentNumberType`.
- **Every allocator runs inside the document's own transaction.** A failed insert rolls the
  number back with it instead of burning one, and no allocator is ever called to preview a
  number. Proven by a test that allocates, throws, and asserts the counter is unmoved.
- **A mobile number is stored as typed and searched normalized.** `appointments.mobile_number`
  keeps exactly what the operator entered; `mobile_search` is derived server-side by
  `normalizeMobile` (`@erp/shared`) — digits only, and the last ten when more remain, which
  drops an Indian country/trunk prefix without pretending to parse international numbers. It is
  never accepted from a client, and it is what makes "+91 98765 43210", "98765-43210" and
  "9876543210" find each other. One index: `(tenant_id, mobile_search)`.
- **A mobile number is not an identity.** There is no `UNIQUE(mobile_number)` and no Customer
  Master: the same number may hold any number of bookings. The lookup therefore returns
  CANDIDATES, most recent first, and never picks one for the operator.
- **A business date is a `date`, a business time is a `time`.** They are separate columns and
  never combined into a timestamptz, so a booking cannot shift a day through UTC. Nothing
  parses a date-only value with `new Date()` — `fmtDateOnly` formats the string, and
  `todayISO` reads the browser's local date, never `toISOString().slice(0, 10)`.
- **Money is `numeric`, always positive, never computed on the client.** An opening balance is
  stated as an amount plus a `DEBIT` / `CREDIT` side, never as a negative number. There is
  deliberately no mutable `currentBalance` anywhere — this phase is accounting *foundation*, and
  nothing posts a ledger entry, journal or voucher from it.

## Book Master is the bill number series

Not a text master. Each book (`2026-27`, `2027-28`) is one independent bill number series:
bills under it run 1, 2, 3 … and a new book starts again from its own `seriesStartsAt`.

- The counter is `books.next_bill_number`, seeded from `series_starts_at` on create.
- It moves **only** through `allocateBillNumber`. `toRow` in `routes/books.ts` is the only other
  code that writes it, and only while the series is still untouched.
- `bookSchema` has no `nextBillNumber` field and zod strips unknown keys, so no request body
  can set it.
- `seriesStartsAt` is editable only while the book has issued nothing; once the counter has
  moved the API refuses to change it. The counter having moved *is* the evidence that numbers
  were issued — nothing invents bill-existence. That lock needs no change when Billing arrives.
- The database backs all of it: `books_next_bill_number_check` (`next >= start`),
  `books_series_starts_at_positive_check`, and the case-insensitive unique index on the book
  number.
- **Nothing calls the allocator yet.** The contract the Billing phase must honour — the `bills`
  table shape, `UNIQUE(tenant_id, book_id, bill_number)`, the composite FK to
  `books_id_tenant_uk` with RESTRICT — is written down in `docs/BILL_NUMBERING.md`. Read it
  before starting Billing.

## The Billing lookup contract (written, not implemented)

`GET /api/common/lookups/appointments?mobile=...` is what the future Billing screen will call.

- Tenant-scoped and guarded by `operations_appointments` read — it carries a customer's name
  and number, so it is not an open lookup like books or items.
- Matches the normalized key, so any shape of the number works. A blank mobile returns `[]`,
  never the whole table.
- Returns `id`, `appointmentNumber`, `appointmentDate`, `appointmentTime`, `customerName`,
  `mobileNumber`, `babyName` — no counters, no `mobileSearch`, no `tenantId`.
- Ordered appointment date desc, then appointment number desc; capped at 20 candidates.

Intended (NOT built) Billing behaviour: the operator types a mobile, Billing offers the
candidates, the operator picks one, and the bill prefills customer/baby/mobile and stores
`appointment_id`. It must never silently overwrite what the operator already typed, and the
bill must keep its OWN snapshot of those values — an issued invoice is history and must not
change when someone later edits the appointment. See `docs/BILL_NUMBERING.md`.

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

**Nothing has been pushed yet.** As of this update the working tree is clean, the current branch
is `masters/account-master` (no upstream), and **6 commits are unpushed**: `main` is 4 ahead of
`origin/main`, and this branch is 2 ahead of `main` (`6731507` Account Group + Account Master,
`6599fc5` Book Master + sample-module removal). Whoever picks this up should decide whether to
merge into `main` and push, rather than assume the remote is current.

Untracked in the working tree and **intentionally left untouched — never add, move or delete
them**: `erp-boilerplate.bundle` (the original boilerplate delivery, now redundant) and
`studio form image.pdf` (the client's form design reference — read it before guessing at a
module's data model).

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
- **22 tables** in `public`; migrations `0000` … `0007` all applied (8 rows in
  `drizzle.__drizzle_migrations`). `0005` created `books`; `0006` dropped the sample
  `categories` table; `0007` added `appointments` and `document_counters` (purely additive).
- The demo users `admin@example.com` and `viewer@example.com` are present

This is a **shared hosted database, not a scratch one.** It holds real entered data — there is
already a `2026-27` row in `books` that the owner created by hand. Never re-run the seed against
it, never drop it, never point a destructive test suite at it (see Testing below).

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
pnpm typecheck
pnpm test
pnpm build
```

There is also a `db:seed` script. **Do not run it** — it targets the shared hosted database
above, and `.claude/hooks/guard-bash.mjs` blocks it on purpose.

Dev servers are usually already running in the background from an earlier session — check ports
4000 and 5173 before starting another `pnpm dev`, or you will get a port conflict.
`curl -s http://localhost:4000/api/health` is the quickest probe.

## Testing

Vitest runs in `apps/api` only (pinned to v3 — v5 needs Vite 6, this repo is on Vite 5).
Six files (items, sub-items, account groups, accounts, books, appointments), 504 tests. Each
has two sections:

- **A — pure validation** (zod schemas, `normalizeMobile`). Always runs. **272 tests pass today.**
- **B — database-backed** (tenant isolation, RBAC, duplicate guards, lookup field exposure, the
  allocators' sequences and concurrency, the rollback that keeps a failed create from burning a
  number). `describe.skipIf(!TEST_DATABASE_URL)`, so it **skips by default** — 232 skipped.

Section B creates and deletes tenants, roles and users. `TEST_DATABASE_URL` must point at a
**throwaway** database — never at the hosted `DATABASE_URL` above. Because no throwaway database
is configured on this machine, section B has never actually run; the behaviour it covers was
instead verified by hand against the dev API and then cleaned up.

## Verified working

Confirmed end-to-end against the live API / in a real browser, not just by reading code:

- `GET http://localhost:4000/api/health` → `200 {"status":"up"}`; `http://localhost:5173` serves
  the SPA and Vite's `/api` proxy reaches the API
- Login with `admin@example.com` / `Admin@1234` → `/dashboard`, sidebar and nav render
- Theme switcher: **Light**, **Dark** and **Olive** all apply (`data-theme` on `<html>`,
  persisted in `localStorage` under `erp-ui`), zero console errors
- Book Master: list + columns, Add/Edit drawer, case-insensitive duplicate error,
  `seriesStartsAt` rejection of 0 / decimal / blank, custom start 1001, Ctrl+S save, Escape
  close, delete confirmation, active-only lookup. All temporary records were deleted afterwards.
- `allocateBillNumber` concurrency: 25 parallel allocations on one book returned 25 distinct,
  gapless numbers, while a second book stayed on its own series.
- Sample-module removal (2026-09-23): `/api/sample/categories` → 404 while
  `/api/masters/books` and `/api/masters/accounts` still answer `401` (registered, auth
  required); `categories` dropped, public tables 21 → 20, and the owner's `2026-27` book plus
  the items / sub-items rows all intact afterwards.
- Appointments (2026-09-23), in a real headless-Chrome session with **zero console errors**:
  the Operations nav entry, the list and its default columns, the 760px New Appointment modal,
  the date defaulting to the local business date with the time left blank, the tab order
  date → time → customer → mobile → baby → remark, Ctrl+S save, Escape close, a second booking
  on the same mobile in `+91 98765 00011` form, search finding both formats from one term, the
  Today filter, the Columns chooser, edit (titled `Edit Appointment #31`, no number field), the
  delete confirmation, and a 390px phone viewport where the modal is near full width, the
  fields stack to one column and nothing scrolls sideways.
- Appointment numbering: 25 parallel creates through the live API returned 25 distinct, gapless
  numbers, and `books.next_bill_number` did not move.
- All 33 verification appointments, their 36 activity-log entries and the appointment counter
  row were deleted afterwards — the table is empty again, so the studio's first real
  appointment will be #1.
- `pnpm typecheck`, `pnpm test` (272 passed) and `pnpm build` all clean.

Demo logins: `admin@example.com` (Super Admin, everything) and `viewer@example.com`
(read-only, useful for testing RBAC) — both password `Admin@1234`.

`.claude/scripts/verify-ui.mjs` re-runs the login + theme browser check with no extra
dependencies (headless Chrome over CDP, using Node's built-in `WebSocket`). See the header
comment for how to launch Chrome and run it. **Gotcha:** the Chrome profile it uses keeps the
session, so on a second run the app is already signed in and there is no login form — the script
assumes one and will throw. Guard the login step when reusing it.

## Known pending work

- **Billing, Payment, Ledger, Voucher and Reports are NOT implemented.** Nothing posts a
  transaction anywhere yet. Billing is the next step and must start from
  `docs/BILL_NUMBERING.md` plus the lookup contract above: a Bill picks an Appointment up by
  mobile instead of retyping it.
- **Deliberately NOT built into Appointments, because no requirement establishes them:** a
  status workflow (Scheduled / Confirmed / Completed / Cancelled / No Show), a Customer Master
  or any customer deduplication, calendar or scheduler views, slot-conflict detection (two
  bookings may share a date and time — there is no room, photographer, duration or capacity in
  the model), and WhatsApp reminders. Each is a real later decision, not an oversight.
- **New permissions need existing roles re-saved.** Role grants are stored JSON, written before
  the newer permissions existed, so roles other than Super Admin (which bypasses everything)
  do not have `masters_items` … `masters_books` or `operations_appointments` ticked. Per the
  README, opening a role in
  Settings → Roles and saving it picks up new permissions. A stale `sample_categories` key may
  still sit in that JSON; it is harmless (no route checks it) and clears on the next save.
- Workspace packages are still named `@erp/*` (the UI says StudioCRM). Renaming them is its own
  task and touches every import.
- `README.md` is still the boilerplate's README (its file references were repointed at Item
  Master when the sample module was deleted).
- `JWT_SECRET=change-me-in-production` in `apps/api/.env` — fine for dev, must change before
  deploy. So must the `Admin@1234` logins: the boilerplate publishes that default in `seed.ts`
  and `README.md`, and the database behind it is hosted, not local.
- No lint/format tooling is installed by design. Match the surrounding style; `.editorconfig`
  (2 spaces, LF) is the only rule.
