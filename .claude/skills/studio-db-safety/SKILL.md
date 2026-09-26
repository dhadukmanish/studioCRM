---
name: studio-db-safety
description: Guardrails that keep automated development and tests from writing to StudioCRM's shared hosted database — throwaway test DB setup, TEST_DATABASE_URL selection before any db import, verifying the connected database before writes, fail-closed rules, additive migrations and production migration review. Use before running DB-backed tests, writing a DB test suite, running a migration, or any script that connects to Postgres.
---

# StudioCRM database safety

`apps/api/.env` points at the **shared hosted database** (live data). Everything below exists so
automation never writes there by accident.

## The incident this encodes (2026-09-26)

A new suite imported a db-touching service at the top of the file. `db/client` connected with the
hosted URL from `.env` before `beforeAll` switched `DATABASE_URL`, and a run with only
`TEST_DATABASE_URL` set wrote 4 test tenants into the shared DB (removed with approval, by id).

## Rules for DB-backed tests

1. **Throwaway DB only.** Tests run against a private Postgres cluster, never the hosted one:
   ```
   PG="/c/Program Files/PostgreSQL/18/bin"; D=<scratchpad>/pgdata
   "$PG/initdb.exe" -D "$D" -U postgres -A trust -E UTF8 --locale=C     # once
   "$PG/pg_ctl.exe" -D "$D" -o "-p 55432 -c listen_addresses=127.0.0.1" -l <scratchpad>/pg.log start
   ```
   (`postgres.exe` refuses to run as Administrator — `pg_ctl` works.)
2. **Set BOTH variables** to the throwaway URL: `DATABASE_URL` and `TEST_DATABASE_URL`. dotenv never
   overrides a variable already set, so nothing can fall back to `.env`.
3. **No top-level import of anything that reaches `db/client`** in a DB suite. Import db-touching
   modules dynamically inside `beforeAll`; keep pure helpers in `@erp/shared` so pure tests need no db.
4. **Verify before the first write — fail closed:**
   ```ts
   const client = await import('../db/client');
   if (client.DATABASE_URL !== TEST_DB) throw new Error('The db client is not connected to TEST_DATABASE_URL — refusing to write test data');
   ```
   Every DB suite that seeds data carries this guard.
5. Gate DB suites with `describe.skipIf(!process.env.TEST_DATABASE_URL)`; `pnpm test` with no env
   var must write nothing anywhere.
6. Ad-hoc scripts (smoke servers, seeders, verification) take their URL explicitly and print only
   the host/port/db name — never the password.

## Rules for the shared / production database

- **Read-only by default.** No test bills, receipts, customers, appointments or tenants. If a live
  write is truly needed, ask first, tag it unmistakably, remove exactly those rows afterwards.
- Never reset, drop, truncate, reseed (`pnpm db:seed`) or `drizzle-kit push`.
- Never reset or rewind a numbering counter (`books.next_bill_number`, `document_counters`).

## Migrations

- Schema change → `pnpm db:generate` → **read the SQL** → apply to the throwaway DB → run the suite.
- Migrations are **additive** and immutable once applied: never edit `0000`–latest applied files.
  A data backfill is a separate hand-written migration (`drizzle-kit generate --custom`), reviewed.
- Look for: `DROP`, a rename generated as drop+add, `NOT NULL` without a default on a populated
  table, an FK that existing rows would violate, a unique key created after the FK that needs it
  (split the migration).
- **Production migration only after review**: compare `drizzle/meta/_journal.json` with
  `drizzle.__drizzle_migrations`, show the pending SQL, confirm additive / no counter reset / no
  renumbering / no destructive seed, then run `pnpm db:migrate` with explicit approval.
- Rollback is a new forward migration; take a `pg_dump` first for anything risky.

Never print, commit or paste `DATABASE_URL`, `JWT_SECRET` or any credential.
