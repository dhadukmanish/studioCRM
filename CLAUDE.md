# StudioCRM — Claude Code Guide

Business app for a photography/video studio, built on an in-house ERP boilerplate
(multi-tenant auth, RBAC, custom fields, audit log, data-table kit).
**Status: Masters + Appointments + Billing built through Phase 2** — Item, Sub Item, Account
Group, Account and Book Master, the Appointment module, the settings foundation (company profile + logo, tenant
date format), and the Bill (header, lines, master
snapshots, book-wise numbering, bill-level discount, rate-wise GST summary and final totals),
plus invoice templates, the invoice preview, print and server-side PDF (`docs/INVOICE_TEMPLATES.md`).
WhatsApp invoice sharing is browser click-to-chat carrying a secure public invoice link (`/i/<token>`,
`docs/WHATSAPP_SHARING.md`) — it never claims a message was sent. Receipts record money received
against bills — one receipt across many bills, partial and multiple payments, derived Paid /
Outstanding, cancel-never-delete (`docs/RECEIPTS_PAYMENTS.md`). Receivables reports — customer
Summary, Outstanding Bills, Aging from bill date, drill-down, CSV, print — read the same derived
figures (`docs/RECEIVABLES_REPORTS.md`). Each Book is a With GST or Without GST series that decides a new bill's tax mode;
a new bill opens on the only / configured / last-used active book; the bill mobile is exactly 10
digits; a Next Visit Date creates one linked appointment in the bill's transaction
(`docs/BILL_NUMBERING.md`). The ledger / GL, customer advances, a customer master and
the CGST/SGST/IGST split are not started.
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
| Tests | Vitest (pinned to v3 — v5 needs Vite 6, this repo is on Vite 5) in `apps/api`, and in `apps/web` for component render tests (jsdom, `// @vitest-environment jsdom`). `pnpm test` runs both. Read `.claude/skills/studio-testing` before adding any. |

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
9. **An invoice is drawn, never calculated.** Every invoice output — preview, print, PDF, a future
   WhatsApp share — comes from `buildInvoiceModel` over the SAVED bill's snapshot and stored
   totals; renderers only draw that model. A template controls presentation and can never change a
   figure, and nothing that renders an invoice may write a bill, a line or a counter.
10. **A public invoice link is a capability for exactly one saved bill revision.** `/i/<token>` is
    the only anonymous route that returns business data. Store only the token's hash, take its
    origin from `PUBLIC_APP_URL` (never the Host header), never log a full token, and keep at most
    one active link per bill. Any code path that changes a saved bill or an invoice template must
    revoke the affected links in the same transaction (`revokeActiveLinks`).
11. **A bill's Paid and Outstanding are derived, never stored.** Paid = the sum of its allocations on
    ACTIVE receipts (`services/billPayments.ts` is the only definition). A receipt's amount equals its
    allocations exactly; it is never edited or deleted, only cancelled. Anything that can change a
    bill's payment position — creating a receipt, editing or deleting a bill — takes the bill's
    `FOR UPDATE` lock first (receipts lock in bill-id order), so Paid can never exceed Grand Total.
    A bill with any receipt history is never deleted (`docs/RECEIPTS_PAYMENTS.md`). Reports aggregate
    that same definition (`services/receivables.ts`) — never a stored balance or a second formula.

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
Tailwind tokens — **never hard-code a hex value in a component**. (The invoice document is the one
exception: paper ignores the app theme, so it uses the shared `INVOICE_COLORS`.)
Dates follow the tenant's Date Format setting: show them only through `useDateFormatters()` and
enter them only through `<DateInput>` — never `<input type="date">`, `toLocaleDateString` or a
hand-rolled formatter, and never parse a `YYYY-MM-DD` business date with `new Date()`.
Company name and logo come from the company profile, never a hard-coded string (`docs/SETTINGS.md`).
Details: `docs/UI_DESIGN_SYSTEM.md`.

## Testing expectations

Vitest runs in `apps/api` and `apps/web` (`pnpm test`). Web tests render real components
(`ShareInvoiceDialog.test.tsx` is the pattern) so a runtime-only failure — a hook used but not
imported — fails a test, not a user's page. Cover behavior worth protecting — billing math,
document numbering, permission logic, status transitions, boundary validation — not
implementation details. Pure schema/service tests always run; suites that need a database are
gated on `TEST_DATABASE_URL` and skip without it, because the only database configured here is
a shared hosted one. A DB suite imports db-touching modules only dynamically, inside `beforeAll`
(a top-level import connects with the hosted URL from `.env` before the test can switch it), and
runs with BOTH `DATABASE_URL` and `TEST_DATABASE_URL` set to the throwaway database, and calls
`assertTestDatabase` (`src/test-support/dbGuard.ts`) before its first write — it fails closed unless the
pool really reached that database. `pnpm typecheck` plus a real browser/API check remains part of the bar.
Skills: `studio-testing`, `studio-db-safety` (test DB, migrations), `studio-ui-verification` (browser),
`studio-billing-domain` (billing rules), `studio-release` (commit → deploy → smoke).

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
- `docs/BILL_NUMBERING.md` — the bill number series contract Billing must honour, the Book series type →
  tax mode rule, the default/last-used book, and the Next Visit appointment link
- `docs/BILLING_CALCULATION.md` — the money contract: GST-exclusive rate, discount and its
  allocation, rounding, the rate-wise GST summary, and the snapshot rules an edit follows
- `docs/SETTINGS.md` — company profile vs application settings, date storage vs display,
  `DateInput`, logo storage/versioning, cache invalidation, what the Invoice phase reads
- `docs/INVOICE_TEMPLATES.md` — template model and rules, the render model, preview/print, the
  PDF renderer (pdf-lib + HarfBuzz shaping for Gujarati/Hindi, pre-subset fonts, the searchable-text
  mapping — read before touching any of it), RBAC
- `docs/WHATSAPP_SHARING.md` — WhatsApp sharing: the secure public invoice link (token, hash-only
  storage, one-active-link rule, revocation on bill/template edit, `/i/:token`, `PUBLIC_APP_URL`),
  click-to-chat, number normalisation, message placeholders, audit ("opened", never "sent")
- `docs/RECEIPTS_PAYMENTS.md` — receipts and allocation, derived Paid/Outstanding/status, the
  customer key, Cash/Bank account rule, credit, locking, cancel, bill edit/delete protection, RBAC
- `docs/RECEIVABLES_REPORTS.md` — receivables reports: shared scope, As-of semantics and limits,
  aging anchor (bill date) and buckets, reconciliation, CSV (formula-injection guard), print, RBAC
- `.claude/HANDOFF.md` — live project state, DB target, gotchas, pending work (`/handoff`)
- `README.md` — boilerplate feature map and the "add a module" recipe
