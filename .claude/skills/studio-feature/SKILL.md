---
name: studio-feature
description: The standard StudioCRM lifecycle for building a feature end to end — discover, plan, implement, verify, review — including which specialist agents to involve and in what order. Use when starting any non-trivial feature or module in this repo.
---

# StudioCRM feature lifecycle

DISCOVER → PLAN → IMPLEMENT → VERIFY → REVIEW → REPORT

Scale the ceremony to the work. A one-file change skips straight to implement and verify;
a new module with a schema earns the full loop.

## 1. DISCOVER

- Restate the requirement in one sentence, including the business rule behind it. If money,
  numbering, statuses or permissions are involved and the rule is not stated, **ask** — do not
  invent an accounting rule.
- Find what already exists: `grep` for the entity name across `packages/shared`, `apps/api/src`
  and `apps/web/src`. Read the closest existing module rather than the whole tree.
- Note the reuse points: an existing zod schema, a `crudRoutes` config, `MasterPage`,
  a `DataTable` column set, a lookup hook.

## 2. PLAN

Produce a short plan (internal for small tasks, written for large ones) covering:

| Dimension | Question |
| --- | --- |
| Reuse | what existing code does most of this already? |
| Schema | new tables/columns? constraints, indexes, migration? |
| Shared | permission key, zod schema, enum, nav entry? |
| API | endpoints, permission keys, service logic, transactions? |
| UI | screens, columns, form fields, states? |
| Tests | is there money/numbering/permission/transition behavior to protect? |

Order of work is always **shared → schema → API → UI**, because each layer consumes the one
before it. Agree the API contract before any UI is written.

Delegation, when the piece is big enough to stand alone (see `CLAUDE.md`):
`database-engineer` for schema, then `backend-engineer` and `frontend-engineer` — the frontend
agent starts only once the contract is fixed. Small features: do it yourself.

## 3. IMPLEMENT

Smallest coherent change that fully satisfies the requirement. Per layer:

1. `packages/shared`: permission entry (+ module label), zod schema, nav item, enums.
2. `apps/api/src/db/schema/<module>.ts` → `pnpm db:generate` → read SQL → `pnpm db:migrate`.
3. `apps/api/src/routes/<module>.ts` → register in `routes/index.ts`.
4. `apps/web/src/pages/<module>/` → route in `App.tsx` wrapped in `<Guard>`.

Do not leave half-wired layers behind: a permission with no route, a route with no nav entry,
a table with no UI is worse than not starting.

## 4. VERIFY

Narrowest useful check first, then widen:

1. `pnpm --filter @erp/api typecheck` (or `@erp/web`) for the package you touched.
2. A real call: `curl` the endpoint with a token, or click the screen at `localhost:5173`.
   `.claude/scripts/verify-ui.mjs` drives a headless browser check without extra dependencies.
3. `pnpm typecheck` across the monorepo before calling it done.
4. Tests, if any exist for the touched area.

Never report "should work". If you did not run it, say you did not run it.

## 5. REVIEW

Run `code-reviewer` for anything touching money, permissions, migrations, auth, or more than
a couple of files. Fix BLOCKER and HIGH findings before reporting done; list MEDIUM/LOW with
your recommendation.

## 6. REPORT

Four short sections, no file dumps:

```
Implemented   — what now works, in the user's terms
Decisions     — choices a reviewer would question, and why
Verification  — what you actually ran, and its result
Open          — what is left, blocked, or deliberately skipped
```

If the session produced state the next session needs, update `.claude/HANDOFF.md`
(`/handoff update`) instead of writing a new document.
