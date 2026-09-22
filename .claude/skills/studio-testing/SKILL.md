---
name: studio-testing
description: StudioCRM testing workflow — choosing the right test level, setting up Vitest the first time it is genuinely needed, fixtures, financial precision tests, authorization tests, regression tests and running the smallest useful suite. Use before writing or running tests in this repo.
---

# StudioCRM testing

**Vitest is installed in `apps/api` only** (pinned to v3: Vitest 5 requires Vite 6 and this repo
is on Vite 5 — do not "upgrade" it without moving the whole monorepo). Run `pnpm test`, or
`pnpm --filter @erp/api test` for just that package. Keep it to one runner in one package until
there is a real reason for a second.

## Choosing the level

| Level | Use when | Cost |
| --- | --- | --- |
| Unit (no DB) | a pure rule: totals, tax, rounding, a status-transition table, a zod schema | cheap — prefer this |
| Integration (API + DB) | permission enforcement, tenant isolation, transactional writes, numbering under concurrency | real DB needed |
| Browser | only when an interaction cannot be verified any other way | avoid; use `.claude/scripts/verify-ui.mjs` |

Push logic into a pure function in `services/` so it can be unit-tested. If a rule can only be
tested through HTTP, that is usually a sign it is stuck in a route handler.

## How it is set up

`apps/api/package.json`: `"test": "vitest run"`, `"test:watch": "vitest"`; root:
`"test": "pnpm -r test"`. No config file, no coverage threshold, no RTL, no Playwright, no CI
wiring — add none of those speculatively. Tests live next to the code as `<name>.test.ts`.

Integration tests need a **separate** database. Never point a test suite at the shared hosted
database — a seeded run would wipe real rows. Gate DB suites on `TEST_DATABASE_URL`
(`describe.skipIf(!process.env.TEST_DATABASE_URL)`) and import every db-touching module
dynamically inside `beforeAll`, after the env var is overridden. `apps/api/src/routes/items.test.ts`
is the working example of both halves.

Known wart: `buildApp()` lives in `server.ts`, which also calls `listen()` at import time, so
DB-backed suites set `PORT=0`. Moving `buildApp` into its own module would remove that.

## What to test, in priority order

1. **Money** — line totals, tax, discount, round-off, balance due.
2. **Numbering** — format, per-tenant/per-year reset, uniqueness under parallel calls.
3. **Authorization** — a role without the grant gets 403; tenant A cannot read tenant B.
4. **Status transitions** — legal transitions succeed, illegal ones throw, side effects fire.
5. **Validation boundaries** — shared zod schemas at their edges (empty, max, wrong type).
6. **Regression** — every confirmed bug gets a failing test before the fix.

Skip: getters, passthroughs, framework behavior, `crudRoutes` config with no custom hooks, and
anything written purely to move a coverage number.

## Writing them

```ts
describe('invoiceTotals', () => {
  it('rounds the invoice total once, after tax, to 2 decimals', () => {
    expect(invoiceTotals({ lines: [{ qty: '3', rate: '33.333', taxPct: '18' }] }))
      .toEqual({ subTotal: '100.00', tax: '18.00', total: '118.00' });
  });
});
```

- Name the test after the rule, not the function.
- Money assertions are exact strings/values including scale — never `toBeCloseTo`.
- Fixtures come from small factory helpers (`makeJob(overrides)`), not copy-pasted literals.
- Arrange–act–assert, one behavior per test, no logic in the test body.
- Test behavior through the public surface; do not assert on private calls or call counts.

## Running

Smallest first: `pnpm --filter @erp/api test -- invoice` → the package suite → the repo.
Always run `pnpm typecheck` alongside; it catches more in this codebase than most tests would.

## Absolute rules

Never skip, delete or weaken a valid failing test to get green — report it with its output.
Never special-case a value in production code so a test passes. If a test encodes the wrong
business rule, fix the test and say why.
