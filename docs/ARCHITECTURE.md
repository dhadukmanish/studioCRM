# StudioCRM — Architecture

Stable architectural decisions and module boundaries. Live project state (what is running,
which database, what is pending) lives in `.claude/HANDOFF.md`, not here.

## Shape

A pnpm monorepo with three workspaces:

```
apps/api         Fastify 5 HTTP API          :4000
apps/web         React 18 SPA (Vite)         :5173, proxies /api -> :4000
packages/shared  contracts used by BOTH      zod schemas, permissions, nav, filters, enums
```

`packages/shared` is consumed as TypeScript source (`"main": "./src/index.ts"`), so there is no
build step between the packages. Anything the two apps must agree on goes there; that is the
mechanism that keeps validation, permission keys and navigation from drifting apart.

## Request lifecycle (API)

```
HTTP
 └─ plugins/errors.ts      setErrorHandler / setNotFoundHandler — the only error formatter
 └─ plugins/auth.ts        authenticate (JWT -> AuthUser) + requirePermission(key, action)
 └─ routes/<module>.ts     lib/validate.ts parse(zodSchema)  → shape of input guaranteed
      └─ lib/crud.ts       tenant-scoped list/get/create/update/delete + audit  (most modules)
      └─ services/*.ts     business rules, transactions                        (non-CRUD work)
           └─ db/          Drizzle over postgres-js
 └─ lib/respond.ts ok()    { message, data }
```

Decisions behind it:

- **No controller/repository/DTO layers.** Routes call `crudRoutes` or a service; services call
  Drizzle. At this codebase's size the extra layers would be ceremony, and Drizzle's typed
  queries already are the data-access abstraction.
- **One error path.** Everything throws `AppError` (or a helper: `notFound`, `forbidden`,
  `validation`); the error plugin renders `{ error: { code, message, details, timestamp } }`.
  Postgres `23505` is mapped to a 409 there. No handler builds an error response itself.
- **One success envelope.** `ok(data, message)` → `{ message, data }`; lists are
  `{ rows, total, page, pageSize }`. The web client unwraps `.data` centrally in `lib/api.ts`.
- **Validation lives at the boundary, once**, using the shared zod schema.

## Multi-tenancy

Row-level, by `tenant_id`, not schema- or database-per-tenant.

- Every tenant-owned table carries `tenantRef()` with `onDelete: 'cascade'`.
- `req.user.tenantId` comes from the verified JWT and the database (`loadAuthUser`), never from
  the request body.
- `crudRoutes` adds the tenant predicate to every read and the tenant id to every insert.
  Hand-written queries must do the same — this is the single most important invariant in the
  codebase.
- Unique constraints are tenant-scoped: `(tenant_id, name)`, never a global unique.
- Inside a tenant, `companies` → `branches` model legal entities and locations. Users carry
  `companyIds` / `branchIds` for visibility.

## Permission model

**One user → one role → the role's permissions.** That is the whole administrator-facing
model; there is nothing else to configure per user.

A permission is `subModule × action`, `action ∈ read | create | update | delete`. The UI labels
them View / Create / Edit / Delete (`PERMISSION_ACTION_LABELS`) — the identifiers never change.

- The catalog is `packages/shared/src/permissions.ts` — the single source of truth, used by the
  API guard, the roles matrix UI and the nav filter alike.
- Effective grants are computed in `loadAuthUser`. The `super_admin` role key bypasses all
  checks — the only bypass in the system.
- API: `app.requirePermission('admin_users', 'update')` as a `preHandler`. This is the real
  enforcement.
- Web: `useAuthStore().can(key, action)` hides actions and `<Guard permission>` blocks routes.
  Presentation only — it never protects data.

Adding a module means adding one catalog entry, referencing the key in `nav.ts`, and passing it
to `crudRoutes`.

### Per-user permission overrides — retired, not deleted

The boilerplate also allowed per-user grants on top of the role. StudioCRM does not: two places
to look when answering "why can this person do that?" is one too many for a business admin.

- The UI is gone (no Extra Permissions tab on the user form).
- `permissionOverrides` is **not accepted by the API** — it is absent from `userSchema`, so zod
  strips it from any create/update payload. Hiding the control was not enough; a crafted request
  had to be ignored too.
- The `users.permission_overrides` column **stays**, and `loadAuthUser` still merges it, so any
  rows that already carry overrides keep working exactly as before. Dropping the column would be
  a destructive migration bought with nothing but tidiness.
- Consequence: an override written by the old UI still grants access and can no longer be
  edited or cleared through the app. The user form flags such a row so the state is at least
  visible to an administrator. Clearing them (`UPDATE users SET permission_overrides = '{}'`)
  is a deliberate one-off migration, run with the owner's approval — not a UI feature.

## Extension points built into the boilerplate

| Mechanism | Where | Use for |
| --- | --- | --- |
| CRUD factory | `apps/api/src/lib/crud.ts` | any tenant-scoped master; hooks for custom rules |
| Custom fields | `custom_fields` table + `<CustomFieldInputs>` | tenant-defined attributes — no migration needed |
| Tenant settings | `app_settings` jsonb + `services/settings.ts` | configuration, not entities |
| List preferences | `list_preferences` | per-user column layout and saved filters |
| Audit log | `services/activity.ts` | automatic on CRUD; call explicitly for custom state changes |
| Dynamic filters | `packages/shared/src/filters.ts` + `lib/filters.ts` | the DataTable filter builder maps straight to SQL |

Prefer these over new tables and new machinery. A tenant-configurable attribute is usually a
custom field; a tenant-level toggle is usually a setting.

## Web architecture

- **Routing**: `App.tsx`. `Protected` (token) → `AppShell` (layout) → `Guard` (permission).
  Pages are lazy-loaded, so each becomes its own chunk.
- **Server state**: TanStack Query via `lib/queries.ts` (`useList`, `useSave`, lookup hooks).
  Query keys are the invalidation contract — mutations invalidate by key.
- **Client state**: zustand. `store/auth.ts` (persisted tokens + `can()`), `store/ui.ts`
  (theme, sidebar). Nothing else is global.
- **Transport**: `lib/api.ts` owns the auth header, the 401 → refresh → retry cycle and error
  unwrapping into `ApiError`. Components never call `fetch`.
- **Composition**: `components/ui` = primitives, `components/data` = the reusable kit
  (`DataTable`, `MasterPage`, `CustomFieldInputs`, `PermissionMatrix`), `pages/` = screens.
  A screen is configuration over the kit wherever it can be.
- **Theming**: every color is a CSS variable in `themes.css`, exposed through Tailwind tokens;
  `data-theme` on `<html>` switches light/dark/olive. See `docs/UI_DESIGN_SYSTEM.md`.

## Boundaries, stated as rules

1. UI renders and collects input. It never computes a business number.
2. Routes handle HTTP. They never hold a business rule longer than a few lines.
3. Services hold business rules and own transactions. They do not know about HTTP.
4. Schema holds structure and integrity. Constraints live here, not only in code.
5. Shared holds contracts. A rule needed by both apps lives here exactly once.

## Known deviations (accepted for now)

- Workspace packages are still named `@erp/*` (the UI itself now says StudioCRM); renaming the
  packages is a separate, deliberate task.
- `README.md` is still the boilerplate's README and documents the boilerplate accurately.
