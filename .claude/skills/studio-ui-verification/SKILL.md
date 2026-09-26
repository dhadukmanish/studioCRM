---
name: studio-ui-verification
description: Standard real-browser verification for StudioCRM screens — 1440/1280/390 widths, no page-level horizontal overflow, no app-owned uncaught errors, keyboard access, responsive forms and tables, every theme, and stale Vite dev-server awareness. Use after typecheck/test/build pass, before calling any UI change done.
---

# StudioCRM UI verification

Typecheck and jsdom tests do not prove a screen works. Every UI change ends with a real browser.

## Environment

- Prefer the **built bundle** served by `apps/api/dist/server.js` against the **throwaway DB**
  (see `studio-db-safety`) on a spare port — it is what ships, and it cannot write to live data.
  Restart that server after a rebuild (new asset hashes are otherwise answered with index.html).
- If you use `pnpm dev`: a long-running Vite server can serve a **stale module** (the
  ShareInvoiceDialog incident: `useAuthStore is not defined` although source imported it). If a
  page errors in a way the source cannot explain, `curl -s localhost:5173/src/<path>` and compare
  imports; touch the file or restart `pnpm dev`.
- Drive headless Chrome over CDP with no extra dependencies — `.claude/scripts/verify-ui.mjs` is the
  pattern (Node's global WebSocket + fetch). Write per-task scripts in the scratchpad, not the repo.

## Checklist per screen

1. **Widths 1440, 1280, 390** (`Emulation.setDeviceMetricsOverride`, `mobile: true` at 390).
2. **No page-level horizontal overflow**: `document.documentElement.scrollWidth <= innerWidth`.
   Wide grids scroll inside their own container, never the page.
3. **No application-owned uncaught errors**: collect `Runtime.exceptionThrown` and console errors;
   ignore only known noise (an expired-token 401 that retries to 200, React Router v7 notices).
4. **Keyboard**: every action reachable by Tab, has an accessible name (`aria-label` for icon
   buttons), a visible focus ring, and Enter/Space activates it. Dialogs trap and restore focus.
5. **Forms**: labels, required marks, field errors next to the field; inputs keep their constraints
   (e.g. mobile `inputMode="numeric"`, max length) — test by actually typing and pasting.
6. **Tables**: compact, header aligned, stacked card or inner scroll at 390.
7. **Themes**: switch every theme in `lib/theme.ts` (`THEMES`) and screenshot representative
   screens; check text/border contrast, primary button text on `--primary`, focus rings, dialogs,
   dropdowns and tables. Theme colors only via CSS variables — never a hex in a component.
8. **Screenshots** into the scratchpad; look at them, don't just count them.

## Data safety

Browser checks that create data run only against the throwaway DB. Against the live site stay
read-only (login, navigate, open existing records, preview) unless the user approves a write.

## Report

What was checked, at which widths/themes, pass/fail counts, and any failure with its evidence.
