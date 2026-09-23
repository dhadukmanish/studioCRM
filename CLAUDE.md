# StudioCRM — Claude Code Guide

Business app for a photography/video studio, built on an in-house ERP boilerplate
(multi-tenant auth, RBAC, custom fields, audit log, data-table kit).
**Status: Masters + Appointments + Billing built through Phase 2** — Item, Sub Item, Account
Group, Account and Book Master, the Appointment module, and the Bill (header, lines, master
snapshots, book-wise numbering, bill-level discount, rate-wise GST summary and final totals).
Payment, ledger, the CGST/SGST/IGST split, invoice template, PDF and reports are not started.
Billing honours two contracts: `docs/BILL_NUMBERING.md` for identity and `docs/BILLING_CALCULATION.md`
for money. Current implementation status lives in `.claude/HANDOFF.md`.

The app presents itself as StudioCRM, but the workspace packages are still named `@erp/*`.
That is intentional for now; renaming the packages is a separate task.

## Verified stack

| Layer | Choice |
| --- | --- |
| Monorepo | pnpm workspaces (`pnpm@10.28.0`, Node >= 20). **Never use npm/yarn here.** |
| API | Fastify 5 + `@fastify/jwt` + Drizzle ORM + `postgres` driver, TypeScript ESM, `tsx` in dev |
| DB | PostgreSQL (hosted; target described in `.claude/HANDOFF.md`) — migrations via `drizzle-kit` |
| Web | React 18 + Vite 5 + Tailwind 3 + React Router 6 + TanStack Query 5 + react-hook-form + zustand |
| Shared | `packages/shared` — zod schemas, permission catalog, nav, filter types, API envelope. Imported by **both** apps. |
| Validation | zod, at the API boundary only (`lib/validate.ts` → `parse()`) |
| Lint/format | none installed. `.editorconfig` (2 spaces, LF) + match surrounding style. Do not add ESLint/Prettier unless asked. |
| Tests | Vitest in `apps/api` only (pinned to v3 — v5 needs Vite 6, this repo is on Vite 5). `pnpm test`. Read `.claude/skills/studio-testing` before adding any. |

## Repo map

```
apps/api/src/
  routes/      HTTP surface, one file per module, registered in routes/index.ts
  services/    cross-cutting logic (activity log, settings, tenant setup)
  lib/         crud.ts (CRUD factory), validate, errors, respond, list, filters
  plugins/     auth.ts (authenticate + requirePermission), errors.ts
  db/          client.ts, schema/*.ts, migrate.ts, seed.ts
apps/api/drizzle/   generated SQL migrations — committed, never hand-edited
apps/web/src/
  pages/       one folder per module
  components/ui/     primitives (Modal, Field, Select, Combobox, Switch, ...)
  components/data/   DataTable, MasterPage, CustomFieldInputs, PermissionMatrix
  lib/         api.ts (fetch + refresh), queries.ts (react-query helpers), format, theme
  store/       auth.ts (tokens + can()), ui.ts
packages/shared/src/  permissions.ts, nav.ts, schemas/, filters.ts, api.ts, enums.ts
```

## Commands

```
pnpm dev            # api :4000 + web :5173 (web proxies /api -> api)
pnpm typecheck      # all packages — the primary quality gate
pnpm test           # Vitest (apps/api); DB-backed suites skip without TEST_DATABASE_URL
pnpm build
pnpm db:generate    # after editing a schema file
pnpm db:migrate
pnpm db:seed
```

Dev servers are often already running from an earlier session — probe
`curl -s localhost:4000/api/health` before starting another `pnpm dev`.

## Rules that are never negotiable

1. **Authorization is server-side.** Every route gets `app.requirePermission(key, action)`.
   Web-side `can()` / `<Guard>` is UX only, never a security control.
2. **Tenant isolation.** Every tenant table uses `tenantRef()`; every read/write filters by
   `req.user.tenantId`. `crudRoutes` does this for you — do not bypass it with raw queries
   that forget the tenant predicate.
3. **Schema changes go through migrations**: edit `db/schema/*.ts` → `pnpm db:generate` →
   review the generated SQL → `pnpm db:migrate`. Never `drizzle-kit push`, never drop or
   reset a database to unstick a migration.
4. **Money and quantities are `numeric`, never `float`/`real`.** Compute totals server-side;
   never trust a client-sent total. A bill's rate is **GST-exclusive** (confirmed), a discount
   reduces the taxable value **before** GST, and all of it lives in one shared calculation —
   `docs/BILLING_CALCULATION.md`.
5. **Secrets stay in `apps/api/.env`** (gitignored). Never print, commit or paste them — not
   into docs, logs, commit messages or chat.
6. **No destructive git or DB action without explicit approval**: force push, history rewrite,
   `reset --hard` over user work, deleting data, reseeding a populated database.
7. **Never disable or delete a failing test to get a green run.**
8. **Document numbers are issued by the server, atomically, inside the transaction that writes
   the document.** A bill number comes from its Book (`allocateBillNumber`); every other
   document number comes from `document_counters` (`allocateDocumentNumber`). Never
   `SELECT max(...) + 1`, never number a document in the browser, and never let one document
   type move another's counter.

## Architecture boundaries

- `routes/` = HTTP: validate → authorize → call service or CRUD factory → `ok(data, message)`.
  No business rules inline once a rule grows past a couple of lines.
- `services/` = business rules and multi-table work. Owns transactions (`db.transaction`).
- `db/schema/` = the only place tables are defined. Constraints and indexes live here.
- `packages/shared` = anything both apps must agree on (zod schema, permission key, enum,
  nav entry). A validation rule duplicated in web and api is a bug — move it to shared.
- Web pages consume `lib/queries.ts` hooks; components never call `fetch` directly.
- No business calculation in a React component. If a number follows from business rules,
  the API returns it.

## Code rules

Understand before editing · reuse before creating · prefer the existing pattern over a new one ·
strong types, no `any` in new code unless mirroring an existing generic helper · small focused
modules · KISS and YAGNI aggressively · no abstraction for a single use · no speculative options ·
no new dependency without a clear reason · never silently change a business rule · leave the repo
cleaner only where the task touches it.

Before writing a new API module or list/form screen, read the "Adding a module" recipe in
`README.md` — `crudRoutes` + `MasterPage` usually replace ~200 lines of hand-written code.

## UI principles

Compact desktop-productivity CRM. White/neutral-gray dominant, sky-blue as accent only, sharp
typography, minimal bold, thin icons, flat tables, few cards, minimal shadow, low vertical
scrolling, keyboard-friendly data entry. All colors come from CSS variables (`themes.css`) via
Tailwind tokens — **never hard-code a hex value in a component**.
Details: `docs/UI_DESIGN_SYSTEM.md`.

## Testing expectations

Vitest runs in `apps/api` (`pnpm test`). Cover behavior worth protecting — billing math,
document numbering, permission logic, status transitions, boundary validation — not
implementation details. Pure schema/service tests always run; suites that need a database are
gated on `TEST_DATABASE_URL` and skip without it, because the only database configured here is
a shared hosted one. `pnpm typecheck` plus a real browser/API check remains part of the bar.
See `.claude/skills/studio-testing`.

## Agent delegation

The main session orchestrates and owns final integration. Delegate when a workstream is
independent or a specialist review materially raises quality:

| Situation | Agents |
| --- | --- |
| New full-stack feature | `backend-engineer` + `frontend-engineer` |
| Schema-heavy feature | `database-engineer` then `backend-engineer` |
| Behavior worth protecting | `test-engineer` |
| Substantial or risky change | `code-reviewer`, after implementation |

Do **not** delegate typo fixes, single-file edits, small style tweaks, simple searches, or
anything needing constant shared context. Parallelize read/analysis work; serialize writes that
touch the same files. Never spawn an agent just because it exists.

## Context efficiency

Read `CLAUDE.md` first, then only what the task touches. Grep for symbols instead of opening
trees. Use `git status` / `git diff` to learn what changed. Don't reread unchanged files, don't
paste source into summaries, don't write throwaway docs, delete temp scripts after use. Agents
return findings, not file dumps. Saving tokens never justifies guessing at correctness.

## Definition of done

1. Requirement actually met, edge cases considered.
2. Follows existing patterns; no duplicated logic.
3. Permission check + tenant scope present on every new endpoint.
4. Migration generated, reviewed and applied if the schema changed.
5. `pnpm typecheck` clean.
6. Verified the narrowest useful way (API call or browser), not only by reading code.
7. Concise report: implemented / decisions / verification / open issues.

## Further reading (load only when relevant)

- `docs/ARCHITECTURE.md` — module boundaries, request lifecycle, permission model
- `docs/UI_DESIGN_SYSTEM.md` — visual tokens, list/form patterns, interaction rules
- `docs/DEVELOPMENT.md` — setup, environment, workflows, troubleshooting
- `docs/BILL_NUMBERING.md` — the bill number series contract Billing must honour
- `docs/BILLING_CALCULATION.md` — the money contract: GST-exclusive rate, discount and its
  allocation, rounding, the rate-wise GST summary, and the snapshot rules an edit follows
- `.claude/HANDOFF.md` — live project state, DB target, gotchas, pending work (`/handoff`)
- `README.md` — boilerplate feature map and the "add a module" recipe
