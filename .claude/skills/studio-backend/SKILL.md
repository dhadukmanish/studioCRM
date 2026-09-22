---
name: studio-backend
description: StudioCRM API construction workflow — adding a module with crudRoutes, validation, permissions, services, transactions, idempotency, financial calculation rules, error handling and audit. Use before adding or changing anything in apps/api.
---

# StudioCRM backend patterns

Request path: **route → validate → authorize → service/CRUD → persist → `ok()`**

## Adding a module

Four files, in this order:

1. **Permission** — `packages/shared/src/permissions.ts`:
   ```ts
   { name: 'studio_jobs', displayName: 'Jobs', module: 'studio' }
   // plus PERMISSION_MODULE_LABELS.studio = 'Studio'
   ```
2. **Schema** — `apps/api/src/db/schema/<module>.ts`, exported from `schema/index.ts`,
   then `pnpm db:generate && pnpm db:migrate` (see the `studio-database` skill).
3. **Validation** — a zod schema in `packages/shared/src/schemas/<module>.ts`, exported from
   `schemas/index.ts`. This is the contract both apps use.
4. **Route** — `apps/api/src/routes/<module>.ts`, registered in `routes/index.ts`:
   ```ts
   crudRoutes(app, {
     table: schema.jobs,
     base: '/api/studio/jobs',
     permission: 'studio_jobs',
     schema: jobSchema,
     label: 'Job',
     searchColumns: [schema.jobs.code, schema.jobs.title],
     defaultSort: schema.jobs.createdAt,
   });
   ```

`crudRoutes` gives list (search + dynamic filters + sort + pagination), get, create, update,
delete, permission checks, tenant scoping and audit logging. Extend it through its hooks
before considering a hand-written handler:

| Hook | Use for |
| --- | --- |
| `toRow(body, req, existing)` | map validated input to columns, default nullables |
| `beforeSave` | cross-row rules (clear other `isDefault`, check uniqueness) |
| `afterCreate` / `afterUpdate` | side effects (create child rows, recalc a parent) |
| `filter(req, q)` | extra WHERE from query params (companyId, status, date range) |
| `shape(row)` | decorate the response (computed labels, joined names) |
| `protectSystem`, `audit`, `labelField` | deletion guard, audit control |

Write a custom handler only for genuinely non-CRUD operations (post an invoice, generate a
number, bulk import) — and put its logic in `services/`, not in the handler.

## Validation

- `const body = parse(jobSchema, req.body)` — the only entry point. `parse` throws `AppError`
  with `details[]` that the web app maps onto form fields.
- Validate query params for custom endpoints too; `parseListQuery` handles list params.
- Ids that arrive from the client are untrusted: re-read the row scoped by `tenantId` before
  acting on it. Never accept `tenantId`, `userId` or a price from the request body as truth.

## Authorization

- `preHandler: app.requirePermission('<key>', 'read'|'create'|'update'|'delete')` on every
  route. A state-changing route must not use `'read'`.
- `app.authenticate` alone only for lookups any authenticated user may read
  (`/api/common/lookups/*`).
- `super_admin` bypasses grants in `plugins/auth.ts` — never add a second bypass anywhere else.
- Company/branch visibility: filter by `req.user.companyIds` / `branchIds` when the entity is
  company-scoped and the user is not a super admin.

## Services and transactions

- A service is a plain exported function in `apps/api/src/services/` taking explicit arguments
  (not `req`), returning data or throwing `AppError`. Easy to test, easy to reuse.
- Anything writing more than one table runs inside `db.transaction(async (tx) => { ... })`,
  and everything inside uses `tx`, not `db`.
- Keep the transaction short: no HTTP calls, no file I/O, no PDF generation inside it.

## Financial rules

1. Line amount, tax, discount, round-off and grand total are **computed on the server** from
   stored inputs. A client total is validated (and rejected on mismatch) or ignored — never
   persisted blindly.
2. `numeric` columns come back as strings. Convert deliberately for arithmetic and format the
   result back to a fixed scale before storing. Do not let floating point drift into a total.
3. Round once, at the defined level (per line or per invoice — decide and document it in the
   service), not repeatedly.
4. A posted/paid document is immutable in the ways the business says it is: enforce that in the
   service and surface a clear `AppError`, don't rely on the UI hiding the button.

## Idempotency and concurrency

- Document numbers: allocate atomically inside the transaction (sequence or
  `UPDATE ... RETURNING` on a counter row) and back it with a unique index. Never
  `SELECT max()` + insert.
- Actions a user can double-submit should be safe to repeat: a natural unique constraint plus
  a friendly 409 (`code '23505'` is already mapped) beats a bespoke lock.

## Errors and responses

- Success: `ok(data, 'Job created successfully')` → `{ message, data }`. Lists:
  `{ rows, total, page, pageSize }`.
- Failure: `throw notFound('Job')` / `forbidden()` / `validation(msg, details)` / a custom
  `new AppError(code, message, status)`. The error plugin formats every one of them; do not
  send error payloads by hand.
- Messages are user-facing: state what went wrong and what to do, never leak SQL or stack.

## Audit

`crudRoutes` logs create/update/delete via `logActivity`. Custom state changes that matter
(posting, cancelling, sending) call `logActivity(req, entityType, id, action, description)`
explicitly. Audit logging never blocks or fails a request.

## Verify

`pnpm --filter @erp/api typecheck`, then a real request against `localhost:4000` with a token
(login as `admin@example.com`; the seeded `viewer@example.com` is the fastest way to prove a
permission check actually denies).
