---
name: studio-frontend
description: StudioCRM UI construction rules — page composition, list and form screens, DataTable and MasterPage configuration, compact control sizing, dialogs, keyboard interaction, loading/empty/error states, responsive behavior, accessibility and visual tokens. Use before building or changing any screen in apps/web.
---

# StudioCRM frontend patterns

Visual standards live in `docs/UI_DESIGN_SYSTEM.md`. This is the build workflow.

## Page composition

Every module page is one of three shapes. Pick the cheapest one that fits.

| Shape | Use | Build with |
| --- | --- | --- |
| Master | a simple entity: list + add/edit dialog | `MasterPage` config — see `pages/settings/OrgPages.tsx` |
| List + detail | entity needing its own screen (invoice, job) | `DataTable` + a routed detail page |
| Settings/tool | matrix, wizard, dashboard | hand-built, still from `ui` primitives |

Standard page frame: `h2` title (`text-[20px] font-semibold`) → optional filter strip →
table or form card. No hero headers, no breadcrumb bar, no decorative cards.

## List screens

`DataTable` (`components/data/DataTable.tsx`) already provides search, the dynamic filter
builder, saved filter groups, column show/hide/reorder (persisted per user via `storageKey`),
sorting, pagination, refresh, export hooks, row actions and empty state. Configure it; do not
reimplement any of it.

- `columns`: `{ key, header, render?, sortable?, sortValue?, width?, align?, hidden?, locked? }`.
  Lock the first identifying column. Right-align numbers and money. Keep default visible
  columns to what fits without horizontal scrolling; ship the rest as `hidden: true`.
- Server-side list (default): `useList(key, url, state)` from `lib/queries.ts` — the API does
  search/filter/sort/paginate. Use `clientSide` + `hidePagination` only for small fixed lists.
- `filterFields`: give real types (`number`, `date`, `select` with options) so the filter
  builder offers the right operators; `false` disables the builder.
- Row actions are icon buttons (`icon-btn h-7 w-7`), gated by `can(permission, 'update'|'delete')`.

## Form screens

- Dialogs for masters (`Modal`, size `sm|md|lg|xl`), a routed page for long documents.
- `react-hook-form` + `<Field label required error hint>` + primitives. Two-column grid
  (`grid gap-4 sm:grid-cols-2`), `span: 2` for wide fields; group long forms with `FormSection`.
- Validation: client rules mirror the shared zod schema — never a second, different rule.
  Server errors map back onto fields with `applyApiErrors`.
- Save via `useSave({ invalidate: [queryKey] })`; it toasts and invalidates. Disable the submit
  button while `isPending` and show `<Spinner />`.
- Custom fields: drop `<CustomFieldInputs moduleName="x" />` into the form and register the
  module in `packages/shared/src/enums.ts`.

## Control sizing (compact by default)

| Element | Size |
| --- | --- |
| Toolbar/table buttons | `h-8` (`.btn`), icon buttons `h-8 w-8`, in-row `h-7 w-7` |
| Form inputs | `.input` = `h-10`; dense contexts `.input-sm` = `h-8` |
| Table cell | `.table-cell` (`px-5 py-3`, 14px); header `.table-head` (12px uppercase) |
| Body text | 14px; secondary 13px; meta 12px; page title 20px |

Weight: `font-medium` for labels and buttons, `font-semibold` only for headings. Never bold a
whole row or sentence for emphasis.

## Dialogs

Open on a row click or an explicit action; close on Escape, backdrop click or Cancel. Focus the
first input on open and return focus to the trigger on close. Destructive actions go through
`ConfirmDialog` and name the record. Never stack a dialog on a dialog — use a drawer or a step.

## Keyboard

Data entry must be completable without a mouse: logical tab order, Enter submits a form,
Escape cancels, `Combobox` opens on Enter and filters as you type, arrow keys move within a
list. Never trap focus in a control that has no keyboard exit.

## States

Every async surface renders four states explicitly:
`loading` (spinner or the table's own loading row) · `empty` (`EmptyState` with a title and,
where useful, the primary action) · `error` (the API message via toast or inline, never a blank
screen) · `ready`. Keep the previous page of data visible while refetching
(`placeholderData: (prev) => prev`).

## Responsive

Desktop-first: the target is a 1366px+ workstation. Tables may scroll horizontally on small
screens; forms collapse to one column (`sm:grid-cols-2`). The sidebar collapses on narrow
viewports (`AppShell`). Do not build a separate mobile layout.

## Accessibility

Semantic elements (`button`, `table`, `label`) over divs with handlers · `aria-label` on every
icon-only control · visible focus ring (`focus:ring-2 focus:ring-primary/40`) · status never
conveyed by color alone — pair it with text · contrast must hold in light, dark **and** olive
themes.

## Visual tokens

Colors come only from Tailwind tokens backed by `themes.css` variables: `primary`,
`primary-dark`, `primary-lighter`, `gray-0..1000`, `surface`, `page`, `head`, `line`, `input`.
Semantic red/green/amber for status badges. A literal hex in a component is a defect: it breaks
one of the three themes. Radius `rounded-lg`, shadow only `shadow-card` on cards and
`shadow-lg` on popovers.

## Checklist before you finish

reused existing primitives · no hard-coded colors · permission-gated actions · loading/empty/
error present · keyboard path works · `pnpm --filter @erp/web typecheck` clean · looked at it in
the browser.
