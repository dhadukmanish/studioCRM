# ERP Boilerplate

A production-ready starting point for multi-tenant business apps: **auth + RBAC (roles, permission matrix, per-user overrides)**, companies & branches, custom-fields engine, audit log, and a data-table kit with dynamic filters, saved filters, column customisation and sorting.

Built with React 18 + Vite + Tailwind (web), Fastify 5 + Drizzle ORM (api), PostgreSQL 16, in a pnpm monorepo.

```
apps/api          Fastify API            http://localhost:4000
apps/web          Vite SPA               http://localhost:5173  (proxies /api → api)
packages/shared   enums, permission catalog, nav, zod schemas, filter types — used by BOTH apps
```

## Quick start

```bash
pnpm install
docker compose up -d                  # Postgres 16 (user/pass/db = erp)
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
pnpm db:migrate
pnpm db:seed
pnpm dev
```

| Login | Password | Role |
| --- | --- | --- |
| admin@example.com | Admin@1234 | Super Admin (everything) |
| viewer@example.com | Admin@1234 | User (read-only) — use it to see RBAC in action |

## What's inside

| Area | Where | Notes |
| --- | --- | --- |
| Auth | `api/routes/auth.ts`, `web/pages/auth/Login.tsx` | JWT access + refresh tokens, profile, change password |
| RBAC | `shared/permissions.ts`, `api/plugins/auth.ts`, `web/components/data/PermissionMatrix.tsx` | `role.permissions ∪ user.permissionOverrides`; `super_admin` bypasses; `app.requirePermission()` on API, `can()` + `<Guard>` on web |
| Roles UI | `web/pages/settings/RolesPage.tsx` | matrix per module tab, clone role, system roles protected |
| Users UI | `web/pages/settings/UsersPage.tsx` | role select, company/branch access, per-user extra permissions |
| Companies / Branches | `api/routes/org.ts`, `web/pages/settings/OrgPages.tsx` | tenant → companies → branches |
| Custom fields | `api/routes/customFields.ts`, `web/components/data/CustomFieldInputs.tsx` | 20 field types; drop `<CustomFieldInputs moduleName="x">` in any form |
| Settings | `api/services/settings.ts`, `web/pages/settings/GeneralSettingsPage.tsx` | JSON key/value per tenant |
| Audit log | `api/services/activity.ts`, `web/pages/settings/ActivityLogsPage.tsx` | CRUD factory logs automatically |
| List kit | `web/components/data/DataTable.tsx` | search, dynamic filter builder, saved filters, drag-order columns (persisted per user), sort, pagination |
| CRUD in one call | `api/lib/crud.ts`, `web/components/data/MasterPage.tsx` | see the sample module |
| Sample module | `api/routes/sample.ts`, `web/pages/sample/CategoriesPage.tsx` | delete once you have real modules |

## Adding a module (≈ 10 minutes)

1. **Permission** — add to `packages/shared/src/permissions.ts`:
   ```ts
   { name: 'inv_products', displayName: 'Products', module: 'inventory' }
   // and a label: PERMISSION_MODULE_LABELS.inventory = 'Inventory'
   ```
2. **Schema** — create `apps/api/src/db/schema/inventory.ts` (copy `sample.ts`), export it from `schema/index.ts`, then `pnpm db:generate && pnpm db:migrate`.
3. **Validation** — add a zod schema in `packages/shared/src/schemas/`.
4. **API** — in a new `apps/api/src/routes/inventory.ts`:
   ```ts
   crudRoutes(app, { table: schema.products, base: '/api/inventory/products', permission: 'inv_products', schema: productSchema, label: 'Product', searchColumns: [schema.products.name] });
   ```
   and register it in `routes/index.ts`. You get list (search / filters / sort / pagination), get, create, update, delete, permission checks and audit logging.
5. **Web** — copy `pages/sample/CategoriesPage.tsx`, set `url`, `permission`, `columns`, `fields`; add the route in `App.tsx` wrapped in `<Guard permission="inv_products">`.
6. **Nav** — add the item to `NAV` in `packages/shared/src/nav.ts` with `permission: 'inv_products'`; it hides itself for users without read access.
7. (Optional) **Custom fields** — add `{ name: 'products', label: 'Products' }` to `CUSTOM_FIELD_MODULES` and render `<CustomFieldInputs moduleName="products" …>` in the form.

Seeded roles pick up new permissions automatically the next time you edit them; `Super Admin` always has everything.

## Theming

- Colors, fonts, radius and shadows live in `apps/web/tailwind.config.js` (`primary`, `gray`, `line`, `page`) and the component classes in `apps/web/src/index.css` (`.btn-*`, `.input`, `.card`, `.table-head` …). Change them once; every page follows.
- App name: `VITE_APP_NAME` in `apps/web/.env` (and per-tenant in Settings → General).
- Icons are registered explicitly in `apps/web/src/lib/icons.tsx` to keep the bundle small (~110 KB gzip).

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` / `dev:api` / `dev:web` | Dev servers |
| `pnpm build` | Bundle API (`apps/api/dist`, via esbuild) and web (`apps/web/dist`) |
| `pnpm typecheck` | `tsc --noEmit` everywhere |
| `pnpm db:generate` / `db:migrate` / `db:seed` | Drizzle migrations & demo seed |

## API conventions

- Success: `{ message, data }`; error: `{ error: { code, message, details } }` — validation errors carry zod `path`s so the web maps them onto fields (`applyApiErrors`).
- Lists accept `?page&limit&search&sortBy&sortOrder&filters=<json>` — see `packages/shared/src/filters.ts` for the filter grammar.
- Every table carries `tenant_id`; the CRUD factory scopes all queries to `req.user.tenantId`.
