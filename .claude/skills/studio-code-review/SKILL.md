---
name: studio-code-review
description: StudioCRM review checklist and severity rubric — requirements, correctness, security, authorization, data integrity, concurrency, performance, maintainability, accessibility and tests. Use when reviewing a change in this repo, by hand or via the code-reviewer agent.
---

# StudioCRM review checklist

Review the **diff**, not the repository. Start from `git status -sb` and `git diff`, open only
what the diff touches, and verify each suspicion in the code before reporting it.

Focus on risk. This repo has no linter on purpose — naming taste, comment style and "you could
also write it as" are not findings.

## Checklist

**Requirements** — does it do what was asked? Anything silently dropped, widened, or a business
rule changed without being told to?

**Correctness** — empty list, null, first run, duplicate submit, very large input. Off-by-one,
inverted condition, wrong operator, unhandled promise rejection, `await` missing.

**Security / authorization**
- `requirePermission` present on every new route, with the right action verb
  (a POST must not be gated on `'read'`).
- Tenant predicate `eq(t.tenantId, req.user.tenantId)` on every query. Missing = BLOCKER.
- A client-supplied `tenantId`, `userId`, price or total trusted as truth = BLOCKER.
- Authorization enforced only in the UI, secrets in code/logs/commits, sensitive fields
  (`passwordHash`, tokens) in a response.

**Data integrity**
- Multi-table write outside `db.transaction` — partial state possible?
- Missing constraint or unique index where the rule is real.
- Migration that drops a column/table, or a rename modelled as drop+add.
- `real`/`float` used for money; rounding applied more than once.

**Concurrency** — document number from `SELECT max()`; read-then-write without atomicity; two
parallel requests producing duplicates or a lost update.

**Performance** — N+1 (a query inside a loop or `map`), unbounded list without pagination, a
filter on an unindexed column of a growing table, expensive work per render.

**Architecture** — business logic inside a route handler or a React component; DB access from a
route; a validation rule duplicated in web and api instead of `packages/shared`; a new
abstraction with one caller; a second implementation of something in `ui`/`data`/`lib`.

**Maintainability** — dead code, commented-out blocks, magic strings that should be a shared
enum, a component or service that outgrew its job, `any` hiding a real type.

**Accessibility** — icon-only button without `aria-label`, dialog without focus management,
broken keyboard path, meaning carried by color alone, hard-coded hex that breaks a theme.

**Tests** — is there money/numbering/permission/transition behavior with no test? Was a test
skipped, deleted or weakened in this diff?

## Severity

| Level | Meaning |
| --- | --- |
| BLOCKER | security hole, data loss or corruption, core requirement broken. Do not ship. |
| HIGH | real bug or integrity risk on a realistic path. |
| MEDIUM | maintainability or performance problem that will bite later. |
| LOW | worth knowing, safe to defer. |

## Output

```
BLOCKER  apps/api/src/routes/jobs.ts:34  List query has no tenant predicate
         Why it fails: a user of tenant A calling GET /api/studio/jobs receives tenant B's rows.
         Fix: add eq(schema.jobs.tenantId, req.user.tenantId) to the where clause.
```

One line of claim, one line of concrete failure path, one line of fix. Most severe first. Close
with `No blockers` or `N blockers, M high`. Finding nothing is a valid result — report it
plainly rather than inventing filler.
