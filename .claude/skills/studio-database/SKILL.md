---
name: studio-database
description: StudioCRM database workflow — inspecting the current schema, Drizzle conventions, relationships, indexes, constraints, numeric/money handling, safe migrations, concurrency-safe numbering and rollback options. Use before editing anything under apps/api/src/db or running a migration.
---

# StudioCRM database workflow

## 1. Inspect before you design

```bash
grep -n "pgTable(" apps/api/src/db/schema/*.ts     # what exists
sed -n '1,40p' apps/api/src/db/schema/core.ts      # helpers: id(), tenantRef(), ts
ls apps/api/drizzle                                # applied migrations
```

Never design a table without reading `core.ts` first — half of what you need is already there.
Check whether the entity really needs a table: tenant-level configuration belongs in
`app_settings`, and user-defined attributes belong in the custom-fields engine.

## 2. Conventions

```ts
export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    tenantId: tenantRef(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    status: text('status').notNull().default('draft'),
    total: numeric('total', { precision: 14, scale: 2 }).notNull().default('0'),
    eventDate: timestamp('event_date', { withTimezone: true }),
    isActive: boolean('is_active').notNull().default(true),
    customFields: jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default({}),
    ...ts,
  },
  (t) => [
    uniqueIndex('jobs_tenant_code_idx').on(t.tenantId, t.code),
    index('jobs_tenant_status_idx').on(t.tenantId, t.status),
  ],
);
```

- snake_case in SQL, camelCase in TS. Table names plural.
- Every tenant-owned table: `id()` + `tenantRef()` + `...ts`.
- Explicit `onDelete` on every FK: `cascade` (child of tenant/parent), `restrict` (must block
  deletion, e.g. a customer with invoices), `set null` (optional historical link).
- Status columns are `text` with a default, validated by the shared zod enum — not a PG enum
  type (migrating a PG enum is painful and the value set will change).
- `customFields` jsonb only on entities that should support custom fields; also register the
  module in `packages/shared/src/enums.ts` (`CUSTOM_FIELD_MODULES`).

## 3. Money and numbers

- Money and quantity: `numeric(14, 2)` (quantities may need scale 3). **Never `real` or
  `double precision`.** Drizzle returns `numeric` as a **string** — arithmetic must be explicit
  in the service, and the stored value is a fixed-scale string.
- Percentages: `numeric(5, 2)`. Integers (counts, sort order): `integer`.
- Store currency alongside an amount only if more than one currency is possible; otherwise it
  belongs on the company.
- Add `check` constraints for real invariants (`total >= 0`, `end_date >= start_date`).

## 4. Relationships

One-to-many = FK on the child. Many-to-many = an explicit join table with its own
`uniqueIndex(a_id, b_id)` — not a jsonb array of ids, once the relation needs to be queried or
counted. Document lines (invoice_items) are a child table with `onDelete: 'cascade'`, a
`lineNo` integer, and their own amounts.

## 5. Indexes

Index from real query patterns, not from a feeling:

- The tenant predicate is in every query — make composites `(tenant_id, <filter or sort col>)`.
- Every FK used for lookup gets an index; Postgres does not create one automatically.
- `uniqueIndex` for business keys, always tenant-scoped: `(tenant_id, code)`,
  `(tenant_id, company_id, invoice_no)`.
- Skip indexes on low-cardinality booleans and on tables that stay small.

## 6. Migrations

```bash
pnpm db:generate     # writes apps/api/drizzle/NNNN_*.sql
# READ the generated SQL — every time
pnpm db:migrate
```

- Review the SQL for: unexpected `DROP`, a rename modelled as drop+add (that loses data), a
  `NOT NULL` added to a populated table without a default, an FK that will fail on existing
  rows.
- A column rename or a non-null backfill is a hand-written, reviewed migration: add nullable →
  backfill → set not null.
- Migrations are committed and immutable once applied. Fix a mistake with a **new** migration.
- Never `drizzle-kit push` against this project's database.

## 7. Document numbering

Must be unique under concurrent requests. Allocate inside the same transaction as the insert:
a Postgres sequence, or an atomic `UPDATE counters SET next = next + 1 WHERE ... RETURNING
next`. Back it with `uniqueIndex(tenant_id, company_id, number)` as the final guard and let a
duplicate surface as the mapped 409. `SELECT max(number) + 1` is never acceptable.

## 8. Safety

Test-DB selection, the fail-closed connection guard and the production migration review are
owned by the `studio-db-safety` skill — load it before running a migration or a DB suite.

- Do not delete or truncate data to make a migration apply. Do not reseed a database that
  holds real rows (`pnpm db:seed` is for a fresh environment).
- Before anything irreversible: stop and ask, and state what would be lost.
- Rollback plan: Drizzle generates no down-migration, so the rollback is a new forward
  migration. For a risky change, take a backup first (`pg_dump`) and say so.
- Connection details live in `apps/api/.env` only. Never paste a connection string with a
  password into a file, a log or a commit message.
