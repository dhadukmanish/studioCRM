# StudioCRM — UI design system

The visual and interaction standard. *How* to build a screen is in the `studio-frontend`
skill; this file is *what it must look and behave like*.

## Design intent

A compact desktop productivity CRM for people who work in it all day — closer to an
accounting package than to a marketing site. Density over whitespace, clarity over decoration,
keyboard over mouse.

- White / neutral-gray dominant; sky-blue **only** as an accent (primary action, active state,
  link, focus ring).
- Sharp, small typography. Bold is a signal, not a texture.
- Thin-stroke icons (lucide, default stroke), never filled or colorful icon sets.
- Flat data tables: a header rule and row separators, no zebra stripes, no card per row.
- Few cards. A page usually has one surface, not five nested boxes.
- Minimal shadow — `shadow-card` on a surface, `shadow-lg` only on floating popovers.
- Low vertical scrolling: the primary work of a screen should fit a 1366×768 viewport.

## Tokens

All color comes from CSS variables in `apps/web/src/themes.css`, exposed as Tailwind tokens in
`tailwind.config.js`. Three themes ship: **light**, **dark**, **olive**, switched by
`data-theme` on `<html>`. A hard-coded hex in a component is a defect — it will be wrong in at
least one theme.

| Token | Role |
| --- | --- |
| `primary`, `primary-dark`, `primary-lighter`, `primary-50` | accent, hover, selected background |
| `gray-0` … `gray-1000` | text and neutral surfaces (`gray-900` headings, `gray-600` body, `gray-500` meta, `gray-400` placeholder) |
| `surface` | cards, inputs, sidebar |
| `page` | app background |
| `head` | table header background |
| `line` | borders and separators |
| `input` | input border |
| red / green / amber (Tailwind defaults) | destructive, success, warning — status only |

Radius: `rounded-lg` (8px default) for inputs, buttons, cards; `rounded-full` for badges and
avatars. Shadow: `shadow-card`, `shadow-btn` on the primary button, `shadow-lg` on popovers.

## Typography

Inter for UI, Lexend Deca for headings (`font-heading`). Root font size is 14px.

| Use | Size / weight |
| --- | --- |
| Page title | `text-[20px] font-semibold text-gray-900` |
| Section title | `text-[15px] font-semibold` or `.section-title` (12px uppercase, tracked) |
| Dialog title | `text-[18px] font-semibold` |
| Body / table cell | 14px, `text-gray-700` |
| Label | 13px `font-medium text-gray-600` (`.label`; `.label-req` adds the red asterisk) |
| Meta, hint, error | 12px (`text-gray-500`, errors `text-red-600`) |
| Table header | 12px `font-bold uppercase tracking-[0.6px] text-gray-500` |

Never bold a whole row, sentence or table column for emphasis — use color or a badge.

## Spacing and density

4px scale. Table cells `px-5 py-3`, headers `px-2.5` vertical, dialog padding `px-6 py-5`,
form grid gap `gap-4`. Controls:

| Control | Height |
| --- | --- |
| Button, icon button, toolbar control | 32px (`.btn`, `.icon-btn`) |
| In-row action button | 28px (`h-7 w-7`) |
| Form input | 40px (`.input`) — 32px in dense contexts (`.input-sm`) |
| Large/primary CTA (login) | 40px (`.btn-lg`) |

## Component inventory

Reuse these; do not build a second one.

- **Primitives** (`components/ui/index.tsx`): `Modal`, `Drawer`, `ConfirmDialog`, `Field`,
  `FormSection`, `Select`, `Combobox` (single/multi/creatable), `Checkbox`, `Switch`,
  `TextInput`, `TextArea`, `Dropdown`, `EmptyState`, `Spinner`, badges via `.badge`.
- **Kit** (`components/data/`): `DataTable`, `MasterPage` + `MasterForm`, `CustomFieldInputs`,
  `PermissionMatrix`.
- **CSS component classes** (`index.css`): `.card`, `.input`, `.input-sm`, `.btn`,
  `.btn-primary`, `.btn-outline`, `.btn-outline-primary`, `.btn-danger`, `.btn-ghost`,
  `.icon-btn`, `.row-action`, `.row-action-danger`, `.table-head`, `.table-cell`, `.badge`,
  `.label`, `.section-title`, `.link`.

Buttons: exactly one `btn-primary` per view (the primary action). Secondary actions are
`btn-outline`, tertiary `btn-ghost`, destructive `btn-danger` and always confirmed.

## List screens

Title → optional filter strip → toolbar (search left; refresh, columns, filters, primary action
right) → table → pagination. Row click opens edit when the user has update permission; row
actions are icon buttons at the right edge. Numbers and money right-aligned, dates
`dd-MM-yyyy` via `fmtDate`, money via `fmtMoney` (₹, `en-IN`, 2 decimals). Status is a `.badge`
with text, never color alone. Default-visible columns must fit without horizontal scrolling;
everything else ships `hidden: true` and the user enables it (the layout persists per user).

## Form screens

Two-column grid, full-width for long fields. Labels above inputs, required marked with the red
asterisk, hint text below in 12px, errors replacing the hint in red. Group long forms with
`FormSection` (title + description on the left, fields on the right). Masters edit in a `Modal`;
documents with lines get their own route. Footer actions right-aligned: Cancel then the primary
action, which shows a spinner and disables while saving.

## Interaction

- **Keyboard**: every data-entry flow completable without a mouse. Focus the first field on
  open, Enter submits, Escape cancels, tab order follows reading order, `Combobox` filters as
  you type and selects with Enter.
- **Feedback**: toast for the result of an action (the API's own `message`), inline errors for
  field problems, `ConfirmDialog` naming the record before anything destructive.
- **States**: loading, empty, error and ready are all designed — never a blank region. Keep the
  previous data on screen while refetching.
- **Focus**: visible ring (`focus:ring-2 focus:ring-primary/40`) on every interactive element;
  dialogs trap focus and restore it on close.

## Responsive

Desktop-first, 1366px+ is the design target. Tables scroll horizontally on small screens; form
grids collapse to one column at `sm`; the sidebar collapses. There is no separate mobile UI.

## Accessibility floor

Semantic elements over divs with handlers · `aria-label` on every icon-only control · labels
tied to inputs · contrast holds in light, dark and olive · status never by color alone ·
`role="switch"` / `aria-checked` on custom toggles · no keyboard trap.
