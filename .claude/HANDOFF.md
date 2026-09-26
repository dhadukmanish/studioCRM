# Studio CRM — session handoff

Context for picking this project up in a fresh session. No secrets live in this file
(it is committed to GitHub) — credentials are in `apps/api/.env`, which is gitignored.

Last updated: 2026-09-26.

## What this project is

`studioCRM` — a business app for a photography/video studio, built **on top of an ERP
boilerplate**. The boilerplate provides multi-tenant auth, RBAC, custom fields, an audit log and
a data-table kit; the Masters layer, Appointments and Billing on top of it are project code.

- Working directory: `C:\Dhaval Bhai\Studio Billing` (Windows 11, PowerShell + Git Bash)
- Stack: pnpm monorepo — `apps/api` (Fastify 5 + Drizzle + Postgres), `apps/web`
  (Vite + React 18 + Tailwind), `packages/shared` (enums, permission catalog, nav, zod schemas)
- `README.md` is still the boilerplate's README, and its "Adding a module (≈ 10 minutes)"
  recipe is still accurate — read it before adding a module.
- `CLAUDE.md` holds the always-loaded engineering rules — stable rules only; current
  implementation status lives in THIS file. `docs/ARCHITECTURE.md`, `docs/UI_DESIGN_SYSTEM.md`,
  `docs/DEVELOPMENT.md`, `docs/BILL_NUMBERING.md`, `docs/BILLING_CALCULATION.md`, `docs/SETTINGS.md`, `docs/INVOICE_TEMPLATES.md`, `docs/WHATSAPP_SHARING.md` and `docs/RECEIPTS_PAYMENTS.md` hold the
  detail; `.claude/agents/` has five
  specialists, `.claude/skills/studio-*` the workflows, `.claude/hooks/guard-bash.mjs` blocks
  destructive commands.

## What is built

### Foundation — auth, login, RBAC

From the boilerplate, kept and branded: multi-tenant auth (JWT access + refresh tokens),
RBAC (`role.permissions ∪ user.permissionOverrides`, `super_admin` bypasses everything),
companies & branches, the custom-fields engine, the `activity_logs` audit trail, and the
DataTable kit (search, filter builder, saved filters, column ordering, sorting, pagination).
Login and the user/role screens were simplified and the app is branded StudioCRM. Three themes
ship: light, dark, olive.

### Masters — project code

| Module | Permission | API | Screen |
| --- | --- | --- | --- |
| Item Master | `masters_items` | `/api/masters/items` | `/modules/masters/items` |
| Sub Item Master | `masters_sub_items` | `/api/masters/sub-items` | `/modules/masters/sub-items` |
| Account Group Master | `masters_account_groups` | `/api/masters/account-groups` | `/modules/masters/account-groups` |
| Account Master | `masters_accounts` | `/api/masters/accounts` | `/modules/masters/accounts` |
| Book Master | `masters_books` | `/api/masters/books` | `/modules/masters/books` |

They share one shape — `crudRoutes` + a shared zod schema + a compact Drawer form, with a
case-insensitive unique index as the real duplicate guard and a friendly `beforeSave` message in
front of it. Account Master is the exception: its routes are hand-written because an account and
its group-specific detail block are two tables written in one transaction, and its form is a
large modal rather than a drawer.

### Operations — project code

| Module | Permission | API | Screen |
| --- | --- | --- | --- |
| Appointments | `operations_appointments` | `/api/appointments` | `/modules/appointments` |
| Billing (Phase 2) | `operations_billing` | `/api/bills` | `/modules/billing`, `/new`, `/:id` |

**Appointments** — the studio's booking record, and the first module that was not a master: a
customer calls, a date and usually a time are agreed, and the customer name, mobile and baby
name are noted so Billing can pick them up instead of asking again. Fields: system-issued Appointment No., date, optional
time, customer name, mobile, optional baby name, optional remark. Hand-written routes (not
`crudRoutes`) because creation takes its number inside the insert's own transaction. Its form is
a 760px modal; the list defaults to newest-first with a Today quick filter.

### Billing — Phase 1 (core bill + lines + GST snapshot)

Phase 2 (discount, GST detail, final totals) is described after it. Phase 1 is the foundation
everything below still rests on, so it is kept here rather than rewritten.

The invoice document: a header with its own customer snapshot, at least one line, and totals the
server derives. `bills` + `bill_items`, hand-written routes (creation takes its number inside the
insert's transaction), and a full-page workspace rather than a dialog — a document with lines
needs the header, the grid and the totals on screen together.

What Phase 1 establishes, and what the next phases must not break:

- **Identity is (tenant, book, bill number).** The number comes from `allocateBillNumber`, which
  Billing is now the only caller of, inside the create transaction. Two books can each hold a
  Bill No. 1. Opening the form allocates nothing — it shows `Auto on Save`.
- **The number and the book are immutable.** `billUpdateSchema` has no `bookId`, so no edit can
  renumber a bill or move a counter. Deleting a bill does NOT rewind the counter.
- **A bill is history.** It stores its own customer name, mobile and baby name, and every line
  snapshots the item name, product name, HSN and GST rate it was built from. Editing an
  Appointment or an Item Master row afterwards never rewrites an issued bill, and re-saving a
  bill keeps the snapshots of the lines it already had.
- **The appointment is optional and traceability only** — a walk-in bill has none.
- **One calculation, in `packages/shared/src/billing.ts`**, used by the browser for preview and
  by the API inside the transaction. The rate is tax-EXCLUSIVE (an assumption then, **confirmed**
  by the studio in Phase 2), rounding is half-up per line on integer paise, and totals are the
  sums of the already-rounded lines. WITHOUT_GST charges no tax but keeps each line's GST snapshot.
- **Nothing a client sends can become a snapshot or an amount.** Those fields do not exist in
  the schemas; the server reads the masters and recomputes every figure.
- **A billed master cannot be deleted.** `bill_items` references Item and Sub Item with
  RESTRICT, and both masters now explain the refusal ("used on N bill lines … set it Inactive
  instead") instead of letting the database raise a 500 — the same guard Book Master got.
- **Re-saving a bill keeps the snapshot of a product the bill already carries**, keyed by
  item+product rather than by line, so one invoice can never print two different GST rates for
  the same product. The trade-off is written down in `resolveLines` (`services/bills.ts`).
- **The quantity and rate ceilings are business limits, not column limits** (`BILL_QUANTITY_MAX`
  9999.99, `BILL_RATE_MAX` 999999.99). They are what keeps every accepted payload inside the
  amount columns AND inside exact integer arithmetic. Raising either means re-checking both.

Full contract: `docs/BILL_NUMBERING.md`, which is now the implemented record, not a plan.

### Billing — Phase 2 (discount, GST detail, final totals)

Built on Phase 1 without rebuilding any of it. **Full contract: `docs/BILLING_CALCULATION.md`** —
read it before touching any figure on a bill.

- **The rate is GST-exclusive — CONFIRMED by the studio.** It is no longer an assumption, and
  nothing should be written as though it might flip. ₹1,000 @ 18% bills 1,000 taxable + 180 GST
  = 1,180.
- **The calculation order is `Gross Taxable -> Discount -> Net Taxable -> GST -> Grand Total`.**
  The discount reduces the taxable base BEFORE tax. Doing it the other way round would make the
  rate-wise GST summary arithmetically false on a bill that mixes slabs.
- **The discount is BILL-level** and stored as the pair the operator chose:
  `discount_type` (NONE | AMOUNT | PERCENT), `discount_value` (what was typed) and
  `discount_amount` (what it came to — the server's). There is deliberately **no per-line
  discount field**; a line's `discount_allocated` is computed, never typed.
- **Allocation is largest-remainder (Hamilton) in integer paise**, in `allocateDiscount`
  (`packages/shared/src/billing.ts`). `sum(line allocations) === discount_amount` exactly — a
  ₹100 discount over three ₹100 lines is 33.34 + 33.33 + 33.33, never 99.99. Ties go to the
  larger line, then to the earlier one, so the result is deterministic. A zero-value line never
  takes a remainder paisa, and no line can be driven negative. The products that pass 2^53 at the
  schemas' ceilings are done in `bigint`.
- **101% and an amount above the sub total are REFUSED with a field error, never clamped.** The
  rule lives once, in `billDiscountError` (`packages/shared/src/schemas/bills.ts`): the zod
  refinement and the billing screen's live warning are the same function.
- **`sub_total` is GROSS** (before discount, before GST). `netTaxable` (= sub total − discount)
  and each line's `grossTaxable` (= taxable + allocated) are **derived in `shapeBill` /
  `shapeBillItem`, not stored** — two stored columns already determine each, and a third could
  only drift. That is also why migration `0011` needed no backfill: every new column defaults to
  a value that is already correct for a Phase 1 bill.
- **The rate-wise GST summary is derived from the lines' own amounts** by `gstSummary`, returned
  on `GET /api/bills/:id`, never stored and never recalculated from quantities. Its taxable
  figure is the NET one, after the allocated discount. A 0% group is kept.
- **WITHOUT_GST** applies the discount normally and charges 0 tax, so the grand total is the net
  taxable. Every line keeps its GST snapshot; the screen hides the GST Details table in that mode
  so retained rates can never read as charged tax.
- **Snapshot rules on an edit** (all four proven by test and in a browser): re-save keeps the
  snapshot; a rate-only change keeps it; changing the Item/Product identity refreshes it from the
  master as it stands today; a genuinely new product takes today's master. A second line for a
  product the bill ALREADY carries takes that bill's own rate — the Phase 1 trade-off, kept on
  purpose so one invoice cannot print two rates for one product.
- **CGST/SGST/IGST is deliberately NOT split.** It needs a supplier state, a place of supply and
  an intra/inter-state rule that nothing in this repository establishes. The summary is
  `Rate / Taxable / GST` until those are confirmed. Do not guess at it.
- UI: the discount control lives inside the totals panel (`None | ₹ | %` + value), the totals read
  Sub Total / Discount / Taxable Amount / GST / **Grand Total**, and a collapsible "GST Details"
  table sits beside them. The grid gained a **Taxable** column; GST % and GST Amt stay visible.
  No new permission — `operations_billing` covers all of it.

### Settings foundation — Phase 3 (company profile, logo, tenant date format)

**Full contract: `docs/SETTINGS.md`.** Built so the Invoice phase has one place to read branding
and date format from. Committed as `e64a222` on `feature/settings-branding` (see Git).

- **Two sources, never mixed.** Company identity (name, logo, GSTIN, address, contact) = the
  tenant's DEFAULT company row + `company_logos`, read through `GET /api/settings/company`
  (`getCompanyProfile`). Application settings (date/time format …) = `app_settings`, read
  through `GET /api/settings`. Both authentication-only, tenant from the token.
- **Why "Demo Company" showed:** the sidebar rendered `tenants.name` (the seed's "Demo Company"),
  while Settings → Companies edits `companies.name` ("ClickG"). The sidebar now reads the company
  profile; `tenants.name` is rendered nowhere. Product name StudioCRM stays as the second line.
- **Why MM/DD/YYYY showed:** the stored format was always `dd-MM-yyyy`, but every date FIELD was a
  native `<input type="date">`, which renders in the OS locale. All of them are now `<DateInput>`
  (text in the tenant's format, canonical `YYYY-MM-DD` value, native calendar via `showPicker()`
  only). Lists never used the setting either — `fmtDate` / `fmtDateOnly` hard-coded dd-MM-yyyy;
  they are deleted and every screen uses `useDateFormatters()` over `packages/shared/src/dates.ts`.
- **Retired, not dropped:** `companies.date_format` (duplicate of the app setting — removed from
  the company form and schema) and `companies.logo_url`. The `appName` setting was removed (it
  duplicated the company name and nothing rendered it).
- **Logo lives in the database** (`bytea`), because the host overwrites the site folder on
  deploy. PNG/JPEG/WebP by magic bytes, SVG refused, 1 MB cap. Versioned URL
  (`?v=<updated_at ms>`) so it caches as immutable and a replacement shows at once.
- **Gotcha fixed during verification:** `@fastify/multipart` TRUNCATES an oversized file to the
  limit instead of always throwing, so a 2 MB upload arrived as exactly 1 MB and was stored as a
  broken image. The route reads `LOGO_MAX_BYTES + 1` and refuses on `truncated` or length.
- Live effect: saving General Settings invalidates `['settings']`; saving a company or its logo
  invalidates `companies`, which covers `['companies','profile']`. No reload, no sign-out.
- Still native on purpose: the Appointment `type="time"` input (time behaviour was out of scope)
  and the custom-field `datetime-local` / `time` types (no tenant uses them).

### Invoice templates, preview and PDF — Phase 4

**Full contract: `docs/INVOICE_TEMPLATES.md`.** Branch `feature/invoice-templates` (from `e64a222`).

- **One model, two renderers.** `buildInvoiceModel` (shared) turns the SAVED bill + company
  profile + date format + template into an `InvoiceRenderModel`; the browser (`InvoiceDocument`)
  and the PDF (`renderInvoicePdf`) only draw it. It formats; it never calculates, and it never
  reads Item/Sub Item Master. `getBillInvoicePdf` is the reusable entry point for WhatsApp.
- **Templates are controlled config** (strict zod, plain text only), three presets
  (Classic/Compact/Detailed), `supportedMode` BOTH/WITH_GST/WITHOUT_GST. Starters Classic
  (default, BOTH), Compact, Detailed GST are seeded ONCE per tenant (lazily on first use for
  existing tenants — the real tenant got them on 2026-09-25). One default per tenant: set in one
  transaction, backed by a partial unique index; the default can't be deleted or deactivated.
  An explicitly chosen incompatible template is refused; otherwise default → first compatible
  (BOTH first) → built-in Classic.
- **WITHOUT_GST** prints `titleWithoutGst` ("Invoice"), drops GST %, GST and Taxable columns, GST
  and Taxable totals and the GST summary; the lines' GST snapshot is untouched.
- **PDF = pdf-lib for layout + HarfBuzz (harfbuzzjs WASM) for text** — English, Gujarati and
  Hindi/Devanagari, mixed in one string, shaped like Chrome shapes them (`services/invoicePdfText.ts`).
  Bundled into `dist/server.js`; the only files read at runtime are `dist/fonts/*` and
  `dist/harfbuzz.wasm`, both copied by `build.mjs`. Proven by running the built server from a folder
  with no `node_modules` above it and downloading English/Gujarati/Hindi PDFs of Bill #1.
  **`Deploy-StudioCRM.ps1 -Hotfix` uploads only server.js — the first deploy of this needs a full
  deploy** (new fonts + WASM).
- **Font gotcha (cost an hour):** pdf-lib's own subsetting drops Noto glyph OUTLINES — the text
  layer is perfect but the page prints almost blank. Fonts (Noto Sans, Sans Gujarati, Sans
  Devanagari × regular/semibold) are pre-subset once by `pnpm --filter @erp/api fonts:invoice`
  and embedded whole by our own CID-font writer; a test checks every drawn glyph has an outline.
- **Searchable-text gotcha (cost the most time):** pdf.js treats a glyph whose ToUnicode text
  contains a nonspacing mark (virama, vowel signs, anusvara) as ZERO-width, and ignores an empty
  mapping (`<>` extracts as the raw CID code). Naive "whole cluster on the first glyph" mapping
  therefore extracts with stray control characters and invented/missing spaces. The fix — tokens
  dealt to advancing glyphs, marks on zero-width space-glyph "carriers", marks and surplus glyphs
  drawn as outlines — is explained in `docs/INVOICE_TEMPLATES.md` ("PDF text"). Don't "simplify" it.
- **Unsupported characters** (Tamil, emoji…) → the PDF endpoint answers 422
  `INVOICE_UNPRINTABLE_TEXT` naming the characters and where; it never prints boxes.
- **Scratch-testing gotcha:** Node's `fetch` refuses some ports outright ("bad port", e.g. 4190 —
  ManageSieve). Pick another port for a smoke server rather than debugging the server.
- **Bundle gotcha:** `build.mjs`'s banner declares `createRequire` in `dist/server.js`; a module
  that imports `{ createRequire }` from `node:module` makes the bundled server refuse to start
  ("already declared"). Found by a bundle smoke test before it shipped.
- **Layout rules found by looking at real PDFs:** numbers, serial and HSN never wrap (natural
  width; the table's type steps down to 6 pt before a figure breaks); text is split into lines
  before control characters are stripped (terms kept their line breaks).
- **Logo**: PNG/JPEG embed; pdf-lib can't embed WebP, so the logo form converts WebP → PNG in the
  browser before upload.
- **Print** = only the invoice (portal under `<body>` + print CSS), A4 with the template's margin.
- **RBAC**: `settings_invoice_templates` to manage; previewing/printing/downloading a bill's
  invoice needs only `operations_billing` read. Existing roles need re-saving to get the new key.

### WhatsApp invoice sharing — Phase 5

**Full contract: `docs/WHATSAPP_SHARING.md`.** Committed as `cc80226` on
`feature/whatsapp-invoice-sharing` (from `bef9e04`). Its "download the PDF and attach it" flow was
**replaced by Phase 5.1's secure link** (below); what follows is what still stands.

- **Browser click-to-chat only** (`https://wa.me/<digits>?text=…`): it prefills number and text and
  can NOT attach a file — which is why 5.1 sends a link instead. "Open WhatsApp" is a real
  `target=_blank` link, one click. It never claims sent/delivered; no bill status changes.
- **Where:** Invoice Preview (uses the preview's template), saved bill form (Preview · PDF ·
  WhatsApp — disabled while dirty, absent on a new bill), Bills list row menu.
- **Number:** the bill's saved mobile, editable for that share only (the bill is never written).
  `whatsappDestination` (shared) adds 91 to a bare Indian mobile and keeps an explicit `+`/`00` code.
- **Message:** tenant setting `whatsappInvoiceMessage` in `app_settings` (Settings → General →
  Invoice sharing; no migration), fixed placeholders only, unknown ones refused; stored Grand Total,
  company from Company Settings, date in the tenant format.
- **API:** `GET /api/bills/:id/invoice/share` and `POST …/share-opened` (activity-log action
  `whatsapp_share_opened`, meta = transport + template; no number, no message) — both
  `operations_billing` read, tenant-scoped. The shared DB already holds a few such audit rows from
  manual and verification runs on 2026-09-25 — harmless.

### Secure public invoice link — Phase 5.1

**Full contract: `docs/WHATSAPP_SHARING.md`.** Branch `feature/public-invoice-links` (from
`cc80226`), committed as `515b01a`. The WhatsApp message now carries
`https://<PUBLIC_APP_URL>/i/<token>`; the customer taps it and the Phase 4 PDF opens inline — no
login, no attachment, no need to be in the operator's contacts.

- **Token:** 32 chars = first 24 bytes of `HMAC-SHA256(PUBLIC_LINK_SECRET, "…:v1:" + link uuid)`,
  base64url. **Only SHA-256(token) is stored** (`public_invoice_links.token_hash`). HMAC, not a
  stored random token, because the spec wanted both "never store the token" and "reuse the link on
  an unchanged re-share" — the server rebuilds the token from the row id. Every request is also
  checked (constant-time) against the token the CURRENT secret signs, so **changing
  `PUBLIC_LINK_SECRET` invalidates every issued link** — accepted, and the emergency "revoke all".
- **Manual revoke needs `operations_billing` update** (DELETE route; the dialog hides "Revoke link"
  without it). Creating/reusing a link and preview/PDF stay on Billing read.
- **One active link per bill**: partial unique index `(tenant_id, bill_id) WHERE revoked_at IS NULL`
  + the bill row lock in `preparePublicLink`. Reuse = same template AND same bill revision.
- **Revocation lives in the services, in the writer's transaction:** `updateBill` (every successful
  save, even an identical one; `BILL_UPDATED`), `updateTemplate`/`deleteTemplate` (`TEMPLATE_CHANGED`),
  a share with another template (`REPLACED`), the operator's Revoke (`MANUAL`). A bill edit makes no
  new link. Defence in depth: a link stores `bill_revision` (= `bills.updated_at`, copied in SQL for
  the microseconds); a mismatch on access is refused and revoked (`STALE`); the public route
  re-checks the link after rendering and before sending.
- **Company branding / date format changes do NOT revoke** — a link renders current presentation
  like every invoice output; its revision is the bill's. Documented, deliberate.
- **Public route `GET /i/:token`** (`routes/publicInvoice.ts`): outside `/api/`, no auth; shape
  check → one hash lookup → rate limit per LINK (30 renders/min; not per IP, which behind IIS is
  shared or spoofable) → render → re-check → PDF. Unknown / malformed / revoked / stale = the
  identical 404 HTML page; render failure = calm 503 page. Fastify's request log serializer redacts
  `/i/<token>` (proven: zero tokens in the built server's log) — **the host's IIS access log still
  records full URLs**; treat it as sensitive or turn URI logging off for `/i/`.
- **Base URL from `PUBLIC_APP_URL` only** (an origin, no path; never the Host header; https except
  localhost). Both
  `PUBLIC_APP_URL` and `PUBLIC_LINK_SECRET` must be set or link creation answers 503. Local
  `apps/api/.env` has them (`http://localhost:5173` + a generated secret); **production needs its own
  in the site-root `.env` before this is deployed** (`docs/DEPLOYMENT.md`). Vite proxies `^/i/` to
  the API in dev.
- **Dialog:** opening creates nothing; "Create link" / "Replace link" (another template) / subtle
  "Revoke link" with confirm; the draft keeps the literal `{InvoiceLink}` and shows the URL, so a
  template switch never leaves a stale URL in the text. The "attach the PDF" instruction is gone.
- **Message:** new `{InvoiceLink}` placeholder and default; a tenant message saved before 5.1 is not
  rewritten — `View Invoice:\n{InvoiceLink}` is appended on every compose.
- **API:** `GET|POST|DELETE /api/bills/:id/invoice/public-link`, all `operations_billing` read (no new
  permission). Audit `invoice_public_link_created` / `…_revoked` with link id + reason — never the
  token, hash, number or message. Unprintable text (Tamil…) is refused 422 before a link is made.
- **Migrations `0015`** (`invoice_templates_id_tenant_uk`) and **`0016`** (`public_invoice_links`) —
  split for the generator gotcha again. Applied to the shared DB on 2026-09-25. An unapplied first
  draft of `0016` was deleted and regenerated (revoke-reason rename) before anything ran it.
- `updateBill` now returns `{ bill, revokedLinkIds }`; `updateTemplate`/`deleteTemplate` return
  `revokedLinks`. Bill and template services import `revokeActiveLinks` from
  `services/publicInvoiceLinkRevoke.ts` (DB layer only) — keep it that way, or the services form an
  import cycle through `invoice.ts`.

### Receipts, payments and outstanding — Phase 6

**Full contract: `docs/RECEIPTS_PAYMENTS.md`.** Branch `feature/receipts-payments` (from `515b01a`),
committed as `2ef33c3` feat: add receipts payments and outstanding.

- **Model:** `receipts` (number, date, customer snapshot + key, CASH|BANK, account, amount, status
  ACTIVE|CANCELLED, cancelled at/by/reason, created_by) and `receipt_allocations` (receipt × bill ×
  amount, unique per receipt+bill). Composite tenant FKs; allocation→bill is RESTRICT.
- **Paid / Outstanding / Payment Status are derived, never stored** — `services/billPayments.ts` is
  the only definition (Paid = allocations on ACTIVE receipts). The bill list LEFT JOINs one grouped
  aggregate; its Paid / Outstanding / Payment Status filter and sort like columns.
- **Customer = `bills.mobile_search`** (the normalized mobile), because bills carry their own
  customer snapshot and nothing links them to a CLIENT account. Every allocated bill must carry the
  receipt's key. It is a TEMPORARY identity until a customer master exists. Consequence: a bill with
  ANY receipt history (cancelled included) cannot change its mobile (name can).
- **A receipt cannot pre-date any bill it settles** (server under lock + form). **At most 100 bills
  per receipt**, never silently: Pay all / Auto allocate stop at 100 and say so.
- **Cash account** = group under head group CASH (or named CASH); **Bank** = the BANK group (the one
  that drives Bank Details) — `paymentModeForGroup`. The shared DB has no account groups yet, so the
  studio must create a CASH and a BANK account before the first receipt.
- **Credit is not a receipt**: the bill simply stays UNPAID. No advances: amount = allocations.
- **Locking:** receipts lock their bills `FOR UPDATE OF bills ORDER BY id` before reading Paid;
  `updateBill` (Grand Total ≥ Paid) and the new `deleteBill` (any allocation → 409
  `BILL_HAS_PAYMENTS`) take the same lock. Proven by concurrent tests (racing overpay, 15 receipts
  over overlapping bills in mixed orders, receipt vs shrinking edit).
- **Cancel, never delete**; second cancel 409. Receipts never revoke a bill's public invoice link.
- **Numbers** from `document_counters` type `receipt` (tenant-wide, no reset), taken last in the tx.
- **RBAC** `operations_receipts` read/create/update (update = cancel). `GET /api/bills/:id/payments`
  needs only Billing read. Existing non-Super-Admin roles must be re-saved to get the permission.
- **UI:** Receipts list, full-page New Receipt (customer first, pending bills oldest first, Full /
  Pay all / Clear / Auto allocate, derived amount, Ctrl+S, stacked rows at phone width), printable
  detail with cancel, Billing list columns + "Receive payment", bill payment panel + history. The
  bill list now hides Mobile No., Delivery Date, Tax Mode, Paid and Last Modified by default so Outstanding, Payment and Actions fit 1440px (Columns brings them back); long book numbers / names get an ellipsis.
- **Migration `0017`** (`receipts`, `receipt_allocations`) — additive; **applied to the shared DB on
  2026-09-25** (18 rows), Bill #1 / counters re-checked unchanged afterwards.
- Not built: advances, receipt edit, receipt PDF / WhatsApp, refunds, any GL posting.

### Receivables / Outstanding & Aging reports — Phase 7

**Full contract: `docs/RECEIVABLES_REPORTS.md`.** Branch `feature/receivables-reports` (from
`2ef33c3`), **uncommitted** at the time of writing. **No migration** — existing indexes serve it.

- **Read-only, derived, stored nowhere.** `services/receivables.ts` builds ONE bill-level model on
  Phase 6's `paidSubquery` / `paymentColumns` (now with an optional `asOf` receipt-date cutoff) plus
  age and bucket; the KPI strip, Summary, Outstanding Bills, Aging and the customer drill-down all
  aggregate it, so they reconcile to the paisa (tested and browser-verified).
- **Scope** shared by every view, kept in the URL: `asOf` (default = today in the default company's
  time zone, server-decided), bill-date `from`/`to`, `bookId`. Search/status/bucket narrow one table.
- **As of** = bills and ACTIVE receipts dated ≤ As of. A cancelled receipt counts nowhere (void from
  the start — `cancelled_at` is a timestamp, not a business date), and bill edits are not versioned —
  documented; not a frozen historical snapshot.
- **Aging anchor = bill date** (no due date exists; none invented). Buckets 0 / 1–30 / 31–60 / 61–90
  / 91+ from `AGING_BUCKET_MAX_DAYS`, age = Postgres date arithmetic (no TZ drift).
- **Customer = normalized mobile** (temporary). Summary aggregates customers first, then pages; a
  search selects customers but totals all their in-scope bills.
- **CSV** (`GET /api/reports/receivables/export`) is built server-side by `lib/csv.ts`: whole filtered
  result, BOM + CRLF, ISO dates, plain numbers, formula-injection guard; 20,000-row ceiling refused,
  never cut. **Print** = `.print-root` sheet of the whole result (A4 portrait/landscape).
- **RBAC** `reports_receivables` (View only, module "Reports", nav section "Reports › Receivables").
  Existing non-Super-Admin roles must be re-saved. Receive payment still needs Receipts Create.
- **UI:** `/modules/reports/receivables` (tabs Summary / Outstanding Bills / Aging) and
  `/modules/reports/receivables/customers/:key`. `DataTable` gained `compact` (12px cell padding —
  now also on the Bills list, whose Actions slipped ~15px off a 1440px screen at real volume) and
  `mobileCard` (stacked rows below `sm`). The books lookup takes `includeInactive=1`.
- **Measured** on 2,248 bills / 330 customers / 468 allocations: every report request 9–23 ms,
  one aggregate per query (`loops=1`), no per-row queries; the drill-down uses
  `bills_tenant_mobile_idx`. Seq scans on `bills` are the planner's right choice at that size.

### Bill numbering

`allocateBillNumber` (`apps/api/src/services/billNumbers.ts`) is unchanged from the phase that
introduced it, and now has exactly one caller: `createBill` in `services/bills.ts`. Appointments
do NOT use it; they have their own tenant-level counter.

### The sample module is gone

The boilerplate's `sample` / `categories` template was deleted once real modules existed
(commit `6599fc5`): its route, schema, shared zod schema, page, permission, nav section,
dashboard shortcut, custom-field module entry and demo rows, plus migration `0006` dropping the
`categories` table. Do not resurrect it — copy Item Master instead.

## Architectural decisions that must survive

These are load-bearing. Changing any of them is a deliberate decision, not a refactor.

- **Tenant-safe composite foreign keys.** A child never references a parent by `id` alone. Every
  parent carries `unique(id, tenant_id)` (`accounts_id_tenant_uk`, `books_id_tenant_uk`, the
  same on `items`), and every child references the **pair** `(parent_id, tenant_id)`. Pointing
  at another tenant's row is structurally impossible, not merely checked for. Live examples:
  `sub_items → items`, `accounts → account_groups`, `account_party_details → items`,
  `bills → books`, `bills → appointments` (nullable, so a walk-in bill passes), `bill_items →
  items` and `bill_items → sub_items` (all RESTRICT), and the detail tables → `accounts` plus
  `bill_items → bills` (CASCADE, because a line is part of its bill rather than a row that
  outlives it). RESTRICT is the rule for anything
  with history: such a row is deactivated, never deleted out from under its children.
- **Typed Account detail extension tables, not a JSON blob.** `account_bank_details`,
  `account_employee_details`, `account_loan_details`, `account_partner_details` and
  `account_party_details` are 1:1 extensions keyed by `account_id` as the primary key. They hold
  only the extra fields — never a second copy of the account's identity — and a row exists only
  while the account's group actually drives that block, so changing the group removes the stale
  row instead of hiding it. Typed columns keep the data queryable (every employee, every bank
  account) and keep money in a real `numeric` column.
- **Account Master uses a large modal on purpose.** `<Modal size="xl" maxHeight="max-h-[88vh]">`,
  not the `<Drawer>` the other masters use: the common fields plus the group-driven detail block
  do not fit a drawer without burying the operator in scrolling. Ctrl/Cmd+S saves; Escape, focus
  trapping and focus restore belong to `<Modal>`.
- **A Book is the explicit bill-series boundary.** A series exists because somebody created a
  Book. Creating a new Book starts a fresh, **independent** series from its own
  `seriesStartsAt` — two books may both hold a Bill No. 1.
- **No calendar-driven reset.** Nothing resets a bill number by month, year or financial year.
  If the numbering is meant to restart, a new Book is created. There is deliberately no "reset
  bill number" endpoint and no permission for one.
- **Bill numbers come from an atomic server-side `UPDATE … RETURNING`.** One statement takes the
  number and advances the counter; Postgres locks the book row, so simultaneous operators queue
  up and receive different numbers.
- **Never `SELECT max(bill_no) + 1`.** That read-then-write window is exactly what
  `allocateBillNumber` exists to replace. It must not reappear anywhere, in any module.
- **`allocateBillNumber` must later run INSIDE the same transaction that inserts the bill.** It
  takes an `Executor` (`db` or a transaction handle) as its first argument for precisely this
  reason, so a failed bill rolls its number back with it. Never call it to preview or display a
  number: every call consumes one.
- **Generic lookups expose only what a picker needs.** `/api/common/lookups/*` is readable by
  every authenticated user, so it never carries sensitive or internal fields. `lookups/books`
  returns `id` + `bookNumber` only — the counter is not a picker's business. `lookups/accounts`
  returns id, name and group / head group — never PAN, GST, salary, bank account number or
  opening balance. Active rows only, so a deactivated row is not offered for a new transaction.
  `lookups/appointments` goes further and requires `operations_appointments` read, because it
  carries a customer's name and number rather than a picker label.
- **Two numbering shapes, never coupled.** A BILL number belongs to a Book row
  (`books.next_bill_number`), so two books can each hold a Bill No. 1. An APPOINTMENT number is
  a tenant-level sequence held in `document_counters` (one row per tenant per document type)
  and taken through `allocateDocumentNumber` (`services/documentNumbers.ts`) — a single
  `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` that creates the counter on first use and
  otherwise advances it under a row lock. Creating an appointment must never move a book's
  counter, and `services/billNumbers.ts` stays untouched. A future Voucher or Receipt number
  belongs in `document_counters` too — it needs no new table, only a new `DocumentNumberType`.
- **Every allocator runs inside the document's own transaction.** A failed insert rolls the
  number back with it instead of burning one, and no allocator is ever called to preview a
  number. Proven by a test that allocates, throws, and asserts the counter is unmoved.
- **A mobile number is stored as typed and searched normalized.** `appointments.mobile_number`
  keeps exactly what the operator entered; `mobile_search` is derived server-side by
  `normalizeMobile` (`@erp/shared`) — digits only, and the last ten when more remain, which
  drops an Indian country/trunk prefix without pretending to parse international numbers. It is
  never accepted from a client, and it is what makes "+91 98765 43210", "98765-43210" and
  "9876543210" find each other. One index: `(tenant_id, mobile_search)`.
- **A mobile number is not an identity.** There is no `UNIQUE(mobile_number)` and no Customer
  Master: the same number may hold any number of bookings. The lookup therefore returns
  CANDIDATES, most recent first, and never picks one for the operator.
- **A business date is a `date`, a business time is a `time`.** They are separate columns and
  never combined into a timestamptz, so a booking cannot shift a day through UTC. Nothing
  parses a date-only value with `new Date()` — `fmtDateOnly` formats the string, and
  `todayISO` reads the browser's local date, never `toISOString().slice(0, 10)`.
- **Money is `numeric`, always positive, never computed on the client.** An opening balance is
  stated as an amount plus a `DEBIT` / `CREDIT` side, never as a negative number. There is
  deliberately no mutable `currentBalance` anywhere — this phase is accounting *foundation*, and
  nothing posts a ledger entry, journal or voucher from it.

## Book Master is the bill number series

Not a text master. Each book (`2026-27`, `2027-28`) is one independent bill number series:
bills under it run 1, 2, 3 … and a new book starts again from its own `seriesStartsAt`.

- The counter is `books.next_bill_number`, seeded from `series_starts_at` on create.
- It moves **only** through `allocateBillNumber`. `toRow` in `routes/books.ts` is the only other
  code that writes it, and only while the series is still untouched.
- `bookSchema` has no `nextBillNumber` field and zod strips unknown keys, so no request body
  can set it.
- `seriesStartsAt` is editable only while the book has issued nothing; once the counter has
  moved the API refuses to change it. The counter having moved *is* the evidence that numbers
  were issued — nothing invents bill-existence. That lock needs no change when Billing arrives.
- The database backs all of it: `books_next_bill_number_check` (`next >= start`),
  `books_series_starts_at_positive_check`, and the case-insensitive unique index on the book
  number.
- **Nothing calls the allocator yet.** The contract the Billing phase must honour — the `bills`
  table shape, `UNIQUE(tenant_id, book_id, bill_number)`, the composite FK to
  `books_id_tenant_uk` with RESTRICT — is written down in `docs/BILL_NUMBERING.md`. Read it
  before starting Billing.

## The Billing lookup contract (now in use)

`GET /api/common/lookups/appointments?mobile=...` is what the Billing screen calls.

- Tenant-scoped and guarded by `operations_appointments` read — it carries a customer's name
  and number, so it is not an open lookup like books or items.
- Matches the normalized key, so any shape of the number works. A blank mobile returns `[]`,
  never the whole table.
- Returns `id`, `appointmentNumber`, `appointmentDate`, `appointmentTime`, `customerName`,
  `mobileNumber`, `babyName` — no counters, no `mobileSearch`, no `tenantId`.
- Ordered appointment date desc, then appointment number desc; capped at 20 candidates.

Built exactly as intended: the operator types a mobile (debounced, from four digits), Billing
offers the candidates and never picks one, and selecting a candidate prefills customer, mobile
and baby name and stores `appointment_id`. Clearing the link leaves the typed values alone, and
the bill keeps its OWN snapshot — an issued invoice is history and does not change when someone
later edits the appointment. Verified in a browser, including the later-edit case.

Two more lookups were added for Billing, both tenant-scoped:

- `GET /api/common/lookups/items` now also returns `gstRate` — a bill line has to show the tax
  the chosen item carries. It stays a display DEFAULT; the rate that reaches a bill is the one
  the server snapshots.
- `GET /api/common/lookups/sub-items?itemId=...` — active products of ONE item, with their rate
  and remark (the defaults selecting a product fills in). A blank `itemId` returns `[]` rather
  than the tenant's whole price list.

## Git

| Remote | Purpose |
| --- | --- |
| `origin` → `https://dhadukmanish@github.com/dhadukmanish/studioCRM.git` | **This project** |
| `https://github.com/dhadukmanish/erp-boiler-plate-new.git` | The upstream boilerplate. Left untouched, not wired as a remote |

**Credential gotcha — do not "fix" this.** This machine has two saved GitHub credentials:
`git:https://github.com` belongs to `manish-nishad-1984`, which has **no write access** to
`dhadukmanish/*` and causes `403 Permission denied`. The origin URL therefore deliberately
embeds the username (`https://dhadukmanish@github.com/...`) so git picks the right account.
Keep the `dhadukmanish@` in the URL. Nothing needs to be deleted from Credential Manager.

**`main` is the deployed branch, and it is pushed** — `origin/main` was at `c4a0985` on
2026-09-25 (the Masters / Appointments / Billing layer plus the deployment work and its fixes).
The live site's `/api/health` reported build `6f9ac2e`; the two commits after it touch only the
deploy script and docs. `masters/account-master` was fast-forward merged into `main` and still
exists; future feature branches start from `main` and merge back into it before a deploy.

**Unmerged, unpushed feature branches — a stack, oldest first:**

| Branch | Holds | State |
| --- | --- | --- |
| `feature/settings-branding` | `e64a222` feat: add global date settings and company branding (Phase 3) | committed, not pushed, not merged |
| `feature/invoice-templates` | branched from `e64a222`; Phase 4 (invoice templates, preview, PDF with Gujarati/Hindi shaping) — `bef9e04` feat: add invoice templates preview and PDF | committed, not pushed, not merged |
| `feature/whatsapp-invoice-sharing` | branched from `bef9e04`; Phase 5 (WhatsApp invoice sharing) — `cc80226` feat: add WhatsApp invoice sharing | committed, not pushed, not merged |
| `feature/public-invoice-links` | branched from `cc80226`; Phase 5.1 (secure public invoice link) — `515b01a` feat: add secure public invoice links | committed, not pushed, not merged |
| `feature/receipts-payments` | branched from `515b01a`; Phase 6 (receipts, allocation, outstanding) — `2ef33c3` feat: add receipts payments and outstanding | committed, not pushed, not merged |
| `feature/receivables-reports` | branched from `2ef33c3`; Phase 7 (receivables / outstanding / aging reports) | **uncommitted** working tree at the time of writing |

`main` has none of them. Merge in order (settings → invoices → whatsapp → public links → receipts → receivables) — never
start new work from `main` while these are open, or it will lack the settings foundation. None is
deployed; their migrations (`0012`–`0017`) are already applied to the shared database (additive,
the live build ignores them).

The repository is **public** (`private: false` on the GitHub API). No secret is in it —
`apps/api/.env` is gitignored and every deployment credential lives in the hosting panel — but the
code, the docs and the database host name are readable by anyone. Making it private is fine; it
just means giving the hosting panel a read-only PAT.

**Billing Phase 2 is committed** (`ca96589`): the shared calculation and the discount schema, the
two `bills` / `bill_items` column sets, the service, the billing screens, the tests and
`docs/BILLING_CALCULATION.md`, plus migration `0011` — already applied to the shared database, so
a fresh clone matches this machine's schema.

**StudioCRM IS LIVE at `https://studio.kriviinfotech.com`** — read `docs/DEPLOYMENT.md` before
touching any of it. `/api/health` reports `status: up`, `db: up` and the build's commit; the SPA
deep link, the JSON 404 on an unknown `/api` path and the 401 on `/api/bills` were all checked
against the live site.

How the host really works, established from its own deploy log and the deployed files — **not** what
the plan name suggests: railpack **builds in a Linux container** from a git clone, the built tree is
then copied out, SCP'd to the **Windows** site folder `h:\root\home\jigneshsatani-001\www\studio`
and extracted, and **IIS starts Node through `httpPlatformHandler`**. Three consequences that cost
a whole evening between them:

- **`web.config` is what starts the app**, not the panel's Start Command. The host rewrites it at
  the END of every deploy into a version with the handler but **no `<httpPlatform>` element**, which
  is a 502 on every path. `deploy/web.config` is the correct file and must be re-applied after each
  deploy: `.\deploy\Deploy-StudioCRM.ps1 -FixWebConfig`. It also must carry **no rewrite rules** —
  the host's template rewrites non-files to `/index.html`, which would turn `/api/health` into the
  SPA shell.
- **`PORT` arrives padded with spaces** from `%HTTP_PLATFORM_PORT%`. The original code read that as
  a named pipe and Node exited with `ERR_INVALID_ARG_VALUE` after logging that it was serving —
  a 502 with a healthy-looking startup line. Fixed and tested in `apps/api/src/lib/listen.ts`; do
  not "simplify" that trim away.
- **The deploy hook answers 200 while refusing.** It is a GitHub webhook receiver and says
  `{"state":"ERROR","msg":"Invalid"}` in the body for any hand-made POST. Trigger a deploy by
  clicking **Deploy Now** in the panel, or wire the hook into the repository's webhook settings.

Not zero-downtime: the host extracts over the site folder and then breaks `web.config`, so the site
is down until it is repaired. Deploy when a few minutes of downtime is acceptable.

Diagnostics all live in the site root over FTPS (`win8194.site4now.net`, user `studiodev`):
`node_app_automate_deploy_<id>.log` for the build, `logs\node.log` for the running process, and the
host's own `production_studio_<id>.tar.gz.backup` of the previous tree.

**Two open items on the live site, neither cosmetic:** the site-root `.env` supplies
`DATABASE_URL` and `JWT_SECRET`, and `JWT_SECRET` has **not** been proven to be a fresh value — if
it is still `change-me-in-production`, anyone can mint a token for a public site. And `http://` is
served alongside `https://` with no redirect.

**The deployed tree is currently a hotfix, not a clean pipeline deploy.** `server.js` was uploaded
directly (`-Hotfix`) because the hook could not be triggered and the site was down; the rest of the
tree is from the previous run. The web assets are identical between the two, so the live app is
coherent — but the next **Deploy Now** from the panel should be allowed to replace the whole tree
from git, followed by `-FixWebConfig`.

Untracked in the working tree and **intentionally left untouched — never add, move or delete
them**: `erp-boilerplate.bundle` (the original boilerplate delivery, now redundant) and
`studio form image.pdf` (the client's form design reference — read it before guessing at a
module's data model).

## Environment setup already done

- `.npmrc` shipped with the repo (`auto-install-peers`, `strict-peer-dependencies=false`) — unchanged
- `apps/api/.env` and `apps/web/.env` created from their `.env.example` files
- `pnpm install` done. Node v24 is on PATH.
- **pnpm is not installed globally.** It was activated via corepack:
  `corepack prepare pnpm@10.28.0 --activate` (version is pinned by `packageManager` in
  `package.json`). If `pnpm` is missing in a new shell, run that again.
- pnpm skipped esbuild's build scripts (its default policy). This is **harmless** — Vite boots
  and builds fine. Do not run `pnpm approve-builds` to chase it.

## Database — not the boilerplate default

The README's `docker compose up -d` path does **not** work here: Docker is not installed on
this machine. The app points at a **hosted Postgres 18.4** instead:

- Host `pg8001.site4now.net`, port `6432`, database `db_9a7009_studio`, user `9a7009_studio`
- Full `DATABASE_URL` (with password) is in `apps/api/.env` — read it from there
- The password contains `@@`, which **must stay percent-encoded** as `%40%40` inside the URL,
  or the connection string parses wrong
- No SSL parameters needed
- **29 tables** in `public`; migrations `0000` … `0017` all applied (18 rows in
  `drizzle.__drizzle_migrations`). `0017` added `receipts` + `receipt_allocations` (Phase 6). `0015` added `invoice_templates_id_tenant_uk` and `0016` added
  `public_invoice_links` (Phase 5.1 — split for the generator gotcha below; the whole chain
  `0000`–`0016` was also proven to apply cleanly to an empty database). `0014` added `invoice_templates` (one migration, correctly
  ordered — no new FK target). `0012` added `companies_id_tenant_uk`; `0013` added
  `company_logos` with its composite FK to it — split in two for the generator gotcha below,
  which recurred exactly. All additive; the live site's older build ignores them. Earlier: `0005` created `books`; `0006` dropped the sample
  `categories` table; `0007` added `appointments` and `document_counters`; `0008` added
  `sub_items_id_tenant_uk`; `0009` added `bills` and `bill_items`; `0010` widened the three
  `bill_items` amount columns to `numeric(16, 2)`; `0011` added the four discount columns
  (`bills.discount_type / discount_value / discount_amount`, `bill_items.discount_allocated`)
  and their seven check constraints. All additive — `0011` needed **no backfill**, because each
  new column's default (NONE / 0) is already the truth about a Phase 1 bill, so no existing
  bill's totals moved.
- **Generator gotcha worth remembering:** drizzle-kit put the new `sub_items` unique key AFTER
  the foreign key that references it, so the single migration failed (and rolled back cleanly).
  The fix was to split it into two migrations — the key first, then the tables — not to
  hand-edit generated SQL.
- The demo users `admin@example.com` and `viewer@example.com` are present

This is a **shared hosted database, not a scratch one.** It holds real entered data: the owner's
`2026-27` book (now on `next_bill_number = 2`), one real item and product, Appointment #1 and
Bill #1 (₹65,625.00) — the studio has started using the app. Verification must only READ these
documents; anything a check creates is deleted afterwards, and a check must never issue a real
bill or appointment number. Never re-run the seed against
it, never drop it, never point a destructive test suite at it (see Testing below).

The installed local Postgres services (PG 18 on 5432, PG 17 on 5433) **cannot be used**: both use
`scram-sha-256` and the `postgres` password is unknown. **But their binaries can run a private
throwaway cluster** — that is how the DB-backed tests finally ran (see Testing). `psql`, `initdb`
and `pg_ctl` are not on PATH — they live in `C:\Program Files\PostgreSQL\18\bin\`.

## Commands

```
pnpm dev          # both servers  (api :4000, web :5173 — web proxies /api → api)
pnpm dev:api      # api only
pnpm dev:web      # web only
pnpm db:generate  # after editing a schema file
pnpm db:migrate
pnpm typecheck
pnpm test
pnpm build
```

There is also a `db:seed` script. **Do not run it** — it targets the shared hosted database
above, and `.claude/hooks/guard-bash.mjs` blocks it on purpose.

Dev servers are usually already running in the background from an earlier session — check ports
4000 and 5173 before starting another `pnpm dev`, or you will get a port conflict.
`curl -s http://localhost:4000/api/health` is the quickest probe.

**Gotcha — a long-running Vite dev server can serve a STALE module.** On 2026-09-26 the Bills page
crashed with `useAuthStore is not defined` (`ShareInvoiceDialog.tsx:31`) although the source and
commit `515b01a` both import it: the :5173 server, up since the morning, still served a transform
from mid-edit (usage added, import not yet) — the file watcher never picked up the later write. The
built bundle was never affected. Check with `curl -s localhost:5173/src/<path>` and compare the
imports; `touch` the file (or restart `pnpm dev`) to make Vite re-read it.

**Normal console noise, not bugs:** a 401 on `/api/settings/company` and
`/api/common/lookups/companies` when the app opens with an EXPIRED access token (they are the
shell's first calls) — `lib/api.ts` refreshes the token and retries, both then answer 200
(reproduced in the browser). A 401 that repeats after a fresh sign-in would be a real problem;
none was seen. React Router's `v7_startTransition` / `v7_relativeSplatPath` warnings are future
upgrade notices (React Router 7), deliberately not acted on.

## Testing

Vitest runs in `apps/api` and, since Phase 6, `apps/web` (pinned to v3 — v5 needs Vite 6, this repo
is on Vite 5). The web suite (jsdom) renders real components — `ShareInvoiceDialog.test.tsx` fails if
a hook the dialog uses is not imported, and checks the read-only vs update Revoke rule — plus the
receipt allocation helpers (`allocation.test.ts`) and the receivables pages (`ReceivablesPage.test.tsx`:
KPI/rows as the server sent them, the Aging strip = scope, Receive payment only with Receipts Create):
3 files, 10 tests, always run. API: fourteen files (items, sub-items, account groups, accounts, books, appointments, bills, settings,
invoices, whatsapp, publicInvoiceLinks, receipts, receivables, plus `lib/listen`), 1154 tests. The route suites have two
sections:

- **A — pure validation and calculation** (zod schemas, `normalizeMobile`, the bill money
  functions, the discount allocation, the rate-wise GST summary, the shared date
  format/parse rules incl. a TZ-shift guard, the settings payload rule, logo magic-byte
  sniffing, the invoice template schema, template compatibility/fallback, the invoice render
  model, and real PDFs parsed back with pdf.js — text, pages, images, glyph outlines,
  determinism, nothing drawn off the page, unprintable-character refusal, Gujarati/Hindi shaping,
  extraction and wrapping, public-link tokens/hash/redaction/config/rate limit, malformed-token
  refusal, the receipt schema / derived payment status / Cash-Bank rule / paise). Always runs.
  **`pnpm test`: API 704 pass, 450 skipped; web 10 pass.**
- **B — database-backed** (tenant isolation, RBAC, duplicate guards, lookup field exposure, the
  allocators' sequences and concurrency, the rollback that keeps a failed create from burning a
  number, bill snapshots, the stored discount and its allocation, the atomic line replacement, and
  the whole public-link lifecycle incl. concurrent shares and share-vs-edit races, and every
  receipt rule incl. concurrent overpayment, deadlock-free multi-bill locking, cancel, the bill
  edit/delete guards, account validation, 25-way receipt numbering and tenant isolation).
  `describe.skipIf(!TEST_DATABASE_URL)`, so it **skips by default**.

Section B creates and deletes tenants, roles and users. `TEST_DATABASE_URL` must point at a
**throwaway** database — never at the hosted `DATABASE_URL` above. **It ran for the first time on
2026-09-25: 1080/1080 pass; with Phase 6, 1126/1126; with Phase 7, 1154/1154** (one latent Phase 5 test bug surfaced and was fixed — it read the
bill's first audit row instead of the share row). How to get a throwaway database here, no admin
rights or passwords needed (use a scratch folder, never the repo):

```
PG="/c/Program Files/PostgreSQL/18/bin"; D=<scratch>/pgdata
"$PG/initdb.exe" -D "$D" -U postgres -A trust -E UTF8 --locale=C
"$PG/pg_ctl.exe" -D "$D" -o "-p 55432 -c listen_addresses=127.0.0.1" -l <scratch>/pg.log start
"$PG/psql.exe" -h 127.0.0.1 -p 55432 -U postgres -c "create database studio_test"
cd apps/api && export DATABASE_URL=postgres://postgres@127.0.0.1:55432/studio_test TEST_DATABASE_URL=$DATABASE_URL
npx tsx src/db/migrate.ts && npx vitest run      # stop afterwards: pg_ctl -D "$D" stop
```

Set **both** variables: `DATABASE_URL` too, so nothing in the run can fall back to the hosted URL
in `apps/api/.env` (dotenv never overrides a variable that is already set).

**This bit once (2026-09-26):** a new suite imported a db-touching service at the TOP of the file,
so `db/client` connected with the hosted URL before `beforeAll` switched `DATABASE_URL`, and a run
with only `TEST_DATABASE_URL` set wrote 4 test tenants into the shared DB (removed the same day,
with approval, by tenant id; genuine data untouched). Rules: import db-touching modules only
dynamically inside `beforeAll`, keep pure helpers in `@erp/shared`, and assert
`client.DATABASE_URL === TEST_DATABASE_URL` before seeding (as `receivables.test.ts` does).

## Verified working

Confirmed end-to-end against the live API / in a real browser, not just by reading code:

- `GET http://localhost:4000/api/health` → `200 {"status":"up"}`; `http://localhost:5173` serves
  the SPA and Vite's `/api` proxy reaches the API
- Login with `admin@example.com` / `Admin@1234` → `/dashboard`, sidebar and nav render
- Theme switcher: **Light**, **Dark** and **Olive** all apply (`data-theme` on `<html>`,
  persisted in `localStorage` under `erp-ui`), zero console errors
- Book Master: list + columns, Add/Edit drawer, case-insensitive duplicate error,
  `seriesStartsAt` rejection of 0 / decimal / blank, custom start 1001, Ctrl+S save, Escape
  close, delete confirmation, active-only lookup. All temporary records were deleted afterwards.
- `allocateBillNumber` concurrency: 25 parallel allocations on one book returned 25 distinct,
  gapless numbers, while a second book stayed on its own series.
- Sample-module removal (2026-09-23): `/api/sample/categories` → 404 while
  `/api/masters/books` and `/api/masters/accounts` still answer `401` (registered, auth
  required); `categories` dropped, public tables 21 → 20, and the owner's `2026-27` book plus
  the items / sub-items rows all intact afterwards.
- Appointments (2026-09-23), in a real headless-Chrome session with **zero console errors**:
  the Operations nav entry, the list and its default columns, the 760px New Appointment modal,
  the date defaulting to the local business date with the time left blank, the tab order
  date → time → customer → mobile → baby → remark, Ctrl+S save, Escape close, a second booking
  on the same mobile in `+91 98765 00011` form, search finding both formats from one term, the
  Today filter, the Columns chooser, edit (titled `Edit Appointment #31`, no number field), the
  delete confirmation, and a 390px phone viewport where the modal is near full width, the
  fields stack to one column and nothing scrolls sideways.
- Appointment numbering: 25 parallel creates through the live API returned 25 distinct, gapless
  numbers, and `books.next_bill_number` did not move.
- All 33 verification appointments, their 36 activity-log entries and the appointment counter
  row were deleted afterwards — the table is empty again, so the studio's first real
  appointment will be #1.
- **Billing Phase 1 (2026-09-23), against the live API — 47 checks:** the first bill takes the
  book's `seriesStartsAt`, the next increments, a second book holds its own Bill No. 1, reads
  allocate nothing, snapshots (item name / product / HSN / GST / rate / remark) are stored,
  `2 x 2500.50 @ 12%` gives exactly `5001.00 / 600.12 / 5601.12`, mixed slabs and a 0% line add
  up, WITHOUT_GST charges 0 while keeping the 12% snapshot, a forged payload (bill number,
  snapshots, totals) is ignored, an inactive book / a product from another item / an inactive
  product / an empty bill / qty 0 / a 3-decimal rate / a ticked Birthdate with no date are all
  refused, an appointment link survives the appointment being renamed, Item Master changing to
  18% leaves the old bill at 12%, an edit keeps the number and the snapshot, deleting a bill
  does not rewind the counter, a book with bills cannot be deleted, **25 parallel bills returned
  1…25 gapless**, search/filter/pagination work, and a role without `operations_billing` gets
  403.
- **Billing Phase 1 in a real browser — 36 checks, zero console errors:** nav entry, list, the
  full-page New Bill, `Auto on Save`, today's local date, the book picker, appointment
  suggestions from a differently formatted mobile and the prefill, item → product → qty → rate
  with the rate and remark defaulted, live line and bill totals, Enter opening the next line
  with focus, removing a line, the With/Without GST toggle, save issuing the book-wise number,
  edit (book read-only, number unchanged, no second allocation), delete with confirmation, all
  three themes, and no sideways page scroll at 390px.
- Three defects were found by that browser pass and fixed: the line preview stayed at 0.00
  while the operator typed (`watch` → `useWatch`), a removed line desynced the grid from the
  field array (React key warning, then a crash on save), and the grid's `sr-only` header span
  escaped its scroller and dragged the page sideways on a phone.
- Every temporary bill, book, item, sub item and appointment created by those runs was deleted,
  the appointment counter row was removed and the verification audit entries were cleaned up:
  `bills`, `bill_items` and `appointments` are all empty, and the owner's `2026-27` book is
  still on `next_bill_number = 1`.
- **Billing Phase 2 (2026-09-23), against the live API — 42 checks:** the GST-exclusive rule
  (1,000 @ 18% -> 1,180; 2 x 500 @ 12% -> 1,120), a ₹300 discount over a 5% and an 18% line
  allocating 100 / 200 and giving 2,700 taxable / 369 GST / 3,069 total, 10% of 10,000 read
  against the sub total and not the grand total, 3 x ₹100 less ₹100 allocating 33.34 / 33.33 /
  33.33 and summing exactly, a 0% group kept in the summary, 100% taking a bill to zero while
  still issuing a number, WITHOUT_GST charging 0 while keeping its snapshots, 101% / an amount
  above the sub total / a negative / a 3-decimal / an unknown type all refused, a refused
  discount burning no bill number, forged discount amounts and line allocations ignored, an
  issued bill still reading at 12% after Item Master moved to 28%, a rate-only edit keeping the
  snapshot, a newly added product taking today's master, changing the product identity
  refreshing the snapshot, and adding then removing a discount by edit without renumbering.
- **Billing Phase 2 in a real browser (headless Chrome, 1440x900) — 30 checks, zero console
  errors:** the Taxable / GST % / GST Amt columns per line, totals before any discount, the
  rate-wise GST Details table, a ₹ discount re-taxing the lines instantly (900 / 45 and
  1,800 / 324), the same for a %, the 101% and above-sub-total warnings appearing live and
  clearing again, Without GST zeroing the tax and hiding the GST Details table, switching back
  restoring it, save → the stored bill matching the screen exactly, reopening showing the same
  totals with the discount control on what was chosen, a rate-only edit keeping 5% after Item
  Master moved to 28%, choosing a different item refreshing the line to 12%, and no sideways
  page scroll at 390px.
- One UI issue was found by that pass and fixed: `<Select>`'s blank placeholder option could set
  the discount type to `''`, which the preview then read as a percentage; `pickDiscountType`
  now treats a blank as NONE. The grid's column widths were also tightened (min-width 1160 ->
  1100) so the Remark column is not pushed off a 1440px screen.
- Every temporary bill, book, item and sub item those two passes created was deleted and the
  166 verification audit entries were removed — `bills`, `bill_items` and `appointments` are
  empty again, and the owner's `2026-27` book is still on `next_bill_number = 1`.
- **Settings Phase 3 (2026-09-25), live API — 31 checks** with a temporary second tenant
  (deleted afterwards): profile = own default company only (a `?companyId=` of another tenant is
  ignored), 401 without a session, date format saved per tenant and refused when unknown, viewer
  403 on settings and logo, upload → versioned profile → byte-exact image with `nosniff` and an
  immutable cache header, cross-tenant logo read/write 404, SVG-as-PNG 400, >1 MB 400 (after the
  truncation fix; exactly 1 MB 200), rename propagates to the profile only for that tenant, and
  bill figures unchanged by any of it.
- **Settings Phase 3 in headless Chrome forced to `--lang=en-US` — 44 checks, zero console
  errors:** DD/MM/YYYY saved through General Settings and shown on the Appointment list and form,
  Billing list, bill edit (Bill / Delivery Date), new bill (Delivery / Birth Date typed as
  `29.2.2028` / `1-1-2026`), the appointment suggestion inside Billing, all five masters' Last
  Modified, and the Billing date filter (typed keystroke by keystroke, then applied); `31/02/2026`
  refused with a field error; Edit shows the row's own date and Add after Edit shows today;
  switching to DD-MM-YYYY updates lists with no reload; MM/DD/YYYY still selectable and honoured;
  Company form has no Date Format and has the Logo control; rename and logo upload show in the
  sidebar at once; a 240x80 logo sits in the initials' square without growing the header;
  removing it falls back to initials; no sideways scroll at 390px. Settings, company name and
  logo were restored and the 37 verification audit entries removed. Only the real Appointment #1
  and Bill #1 were read; nothing was issued a number.
- A code review of Phase 3 found one HIGH (an autofocused `DateInput` kept stale text through a
  form `reset()`, so Edit could show today while holding the row's date) and one MEDIUM (custom
  date fields could store half-typed text); both fixed and re-verified in the browser.
- **Invoice Phase 4 (2026-09-25), live API — 27 checks** with a temporary second tenant (deleted
  afterwards): starters seeded once, bill #1's invoice (Classic, ₹65,625.00, company, date format),
  switching to Compact without moving the default, the PDF's headers/file name/text, 401/403/404
  paths, template create/refuse-bad-config/refuse-duplicate-name/duplicate/set-default/one
  default/refuse-delete-default/delete, a WITHOUT_GST bill's presentation, an incompatible
  template refused, and cross-tenant bill/PDF/template access all 404. Bill #1, its lines, every
  book counter and the appointment counter were byte-identical before and after.
- **Invoice Phase 4 in headless Chrome (`--lang=en-US`) — 35 + 2 checks, zero console errors:**
  gallery with real thumbnails and the Default badge, sample preview modal, designer live preview
  (add/reorder a column, title, Without-GST sample), create / edit / duplicate / set default /
  default has no Delete / delete, bill Preview with DD/MM/YYYY, the bill's own totals and GST
  summary, template switch without moving the default, Download PDF (`Invoice-2026-27-1.pdf`,
  application/pdf — captured from the page; headless Chrome does not write downloads to disk),
  print media showing only the invoice, list row actions, no Preview on an unsaved bill, 390px.
- **The production bundle** (`apps/api/dist`, run from a folder with no `node_modules`) served bill
  #1's PDF: 200, `application/pdf`, correct file name, fully rendered text.
- **Incident, fixed and restored (2026-09-25):** a sloppy menu helper in my browser test script
  clicked Delete in the wrong open menu and deleted the real tenant's **Classic** starter template
  (its cleanup then could not restore the default). Only template rows were affected — no bill,
  line or counter. Classic was recreated from the exact starter config and made default again and
  the test template removed; all three starters verified identical to their seeded config. The
  script now refuses to delete anything not named `VERIFY…`. Browser runs also exposed a real UI
  bug (the card menu was clipped by `overflow-hidden`) — fixed.
- A code review of Phase 4 found no blocker and one HIGH (after editing a bill, the cached preview
  and Print could show the old figures for 30 s while the PDF was right) — fixed: the invoice is
  always refetched, bill/company/logo saves invalidate it, Print waits for fresh data. Also fixed
  from that review: section labels and layout metrics moved into the shared model (the two
  renderers had each hard-coded them); a PDF warning for characters the fonts cannot print
  (since replaced: Gujarati and Hindi now PRINT, and unsupported scripts are refused); rows /
  terms taller than a page continue line by line instead of running off
  it; a delete that raced set-default could remove the default; an undecodable logo broke every
  PDF; a stuck preview when the chosen template stopped fitting; a duplicate "Amount" column.
  Left as LOW: concurrent template edits get a generic 409/500 message (data stays consistent).
- **Public invoice links, Phase 5.1 (2026-09-25):**
  - DB-backed suite on a throwaway cluster: lifecycle, reuse, replace, revoke on every kind of bill
    edit (customer, mobile, remark, qty, rate, discount, tax mode, identical re-save) and on
    template edit/deactivate/delete, refused edit keeps the link, stale revision refused + revoked,
    identical responses for unknown/malformed/revoked, tenant isolation (B's token = B's PDF byte for
    byte), RBAC, 12 concurrent shares → one link, share racing edits → no old-revision link alive,
    no bill/line/counter change.
  - Live dev API, temporary `VERIFY-51` book/item/bill only — 20 checks: dialog-open creates
    nothing, `{InvoiceLink}` in the share message, opaque URL on `PUBLIC_APP_URL`, PDF inline without
    login and byte-identical to the authenticated download, reuse, edit → old link 404 page and no
    new link, template switch, refused edit keeps it, preview/PDF/share-opened don't revoke, manual
    revoke. Real Bill 2026-27/1 only READ (link state) — its data and the book counters identical
    before/after.
  - Headless Chrome (`--lang=en-US`) — 20 checks, zero console errors: prefilled number, template
    picker, no "attach" wording, Revoke with confirm, Create link, URL in the message, intercepted
    `wa.me` URL with `919876500051` and Gujarati/₹/link intact, "Press Send in WhatsApp", the link
    opening as `application/pdf` in a separate no-session browser context, UI bill edit → the
    friendly invalid page (screenshot at 390px), re-share → new working link, template switch →
    "Replace link" with no stale URL, 390px dialog fits with no sideways scroll.
  - Built bundle from an isolated folder (no `node_modules`): `/i/<token>` → 178 KB PDF with
    Gujarati/Hindi (so `harfbuzz.wasm` + fonts load), invalid → the friendly page (not the SPA),
    SPA deep link and `/api` JSON 404 unchanged, **zero tokens in the server log** (redacted).
  - All `VERIFY-51` rows (books, items, products, bills, their links) and their audit rows were
    deleted, matched by id. Shared DB afterwards: 0 links, 1 bill, `2026-27` on 2.
  - **Genuine link, leave it alone:** at 11:12 UTC on 2026-09-25 "Super Admin" shared the real Bill
    2026-27/1 from the dev app (one Classic link + its `invoice_public_link_created` and
    `whatsapp_share_opened` audit rows). It points at `localhost:5173` and is signed with the DEV
    secret, so production will neither open nor reuse it — the next production share replaces it.
  - Code review found no blocker. Fixed from it: HIGH — choosing the picker's blank "Default" left
    the dialog stuck (link resolved to the default's id, never matched `null`); MEDIUM — the rate
    limit was per client IP (spoofable/shared behind IIS) → now per link, after validation; MEDIUM —
    `deleteTemplate` locked links before the template (deadlock / dead URL vs a concurrent share) →
    template row locked first. Also: post-lock revision check in `preparePublicLink` (409
    `BILL_CHANGED`), a built-in-template link that can no longer render is revoked, `PUBLIC_APP_URL`
    must be an origin (a path made every link dead), the revoke helper moved to
    `publicInvoiceLinkRevoke.ts` so there is no import cycle. Left as documented decisions: read
    permission may also revoke; branding/date-format changes don't revoke; IIS access logs.
- `pnpm typecheck`, `pnpm test` (686 passed, 394 skipped; 1080/1080 with a throwaway DB) and
  `pnpm build` all clean.

Demo logins: `admin@example.com` (Super Admin, everything) and `viewer@example.com`
(read-only, useful for testing RBAC) — both password `Admin@1234`.

`.claude/scripts/verify-ui.mjs` re-runs the login + theme browser check with no extra
dependencies (headless Chrome over CDP, using Node's built-in `WebSocket`). See the header
comment for how to launch Chrome and run it. **Gotcha:** the Chrome profile it uses keeps the
session, so on a second run the app is already signed in and there is no login form — the script
assumes one and will throw. Guard the login step when reusing it.

## Known pending work

- **Phases 3–6 are committed, Phase 7 is uncommitted; all unpushed, unmerged and
  undeployed** — see the branch table under Git. Migrations `0012`–`0017` are already on the shared
  database. **The first deploy containing Phase 4/5/5.1 must be a FULL deploy — never
  `Deploy-StudioCRM.ps1 -Hotfix`**, which uploads only server.js and would leave the host without
  `dist/harfbuzz.wasm` and the new fonts.
- **Before that deploy, add `PUBLIC_APP_URL=https://studio.kriviinfotech.com` and a fresh
  `PUBLIC_LINK_SECRET` to the site-root `.env`** (`docs/DEPLOYMENT.md`), or the Share dialog's
  "Create link" answers 503. `/i/<token>` needs no IIS change (every path already reaches Node, and
  `web.config` must keep having no rewrite rules). `http://` is still served without a redirect —
  a customer tapping an `https://` link is fine, but the redirect is still worth adding.
- **WhatsApp is browser click-to-chat + a public link.** An official WhatsApp Business API transport
  (send, delivery status) is a later decision — no credentials exist or are wanted yet. Not built for
  links: expiry (`expires_at` column is reserved), "customer opened it" tracking, a per-bill link
  history screen.
- **Invoice limitations, by design for now:** A4 portrait only; the screen/print preview flows
  continuously (the PDF is where pages are split); PDF text covers English, Gujarati, Hindi and ₹ —
  other scripts (Tamil, emoji…) are refused with a 422; a WebP logo stored other than
  through the form is left out of the PDF; the invoice uses CURRENT company branding (no
  historical branding snapshot — no requirement asked for one).
- Small known gaps left from the Phase 3 review, judged acceptable: the calendar icon does
  nothing on browsers without `showPicker()` (Safari < 16.4 — typing still works); a half-typed
  date in a list FILTER is cleared on blur without a message; custom-field values are still not
  type-checked on the server.
- **Ledger, Voucher and GL posting are NOT implemented.** Receipts (Phase 6) record money
  received and settle bills, and Phase 7's receivables reports read them — but nothing posts an
  accounting transaction; a later GL phase posts from `receipts` once the account mappings are
  decided. Customer advances / on-account money, receipt PDF + WhatsApp share, refunds, a Customer /
  Party Master, payment reminders, collection follow-ups and a bill due date are also not built.
- **Before the first real receipt, the studio needs a CASH and a BANK account** in Account Master
  (group under head group CASH / the group named BANK) — the shared DB has no account groups yet.
- **Billing beyond Phase 2 is NOT implemented**, deliberately and by instruction: advance; the CGST/SGST/IGST split; the delivery workflow (the `delivery_date` column
  exists, the statuses do not); a draft/cancelled bill status; a Customer
  Master. (Invoice templates, preview, print and PDF are built — Phase 4.) The data is shaped so each of these
  is an addition, not a rewrite.
- **The CGST/SGST/IGST split needs business input before it can be built:** the studio's state,
  the place-of-supply rule and how an intra-state bill is told from an inter-state one. Nothing
  in the repo establishes any of them, and guessing would put wrong numbers on a statutory
  document. The summary stays `Rate / Taxable / GST` until they are answered.
- **One business question is still open:** **what is "Item Description" in the legacy
  requirement?** Billing keeps only the per-line `remark` (defaulted from the Sub Item). Whether
  Item Description is a separate line field, a bill-level field, or just another name for the
  same thing is unresolved, so nothing was invented for it.
  (The other Phase 1 question — tax-exclusive or tax-inclusive rate — has been **answered**:
  EXCLUSIVE, confirmed by the studio. See `docs/BILLING_CALCULATION.md`.)
- **Deliberately NOT built into Appointments, because no requirement establishes them:** a
  status workflow (Scheduled / Confirmed / Completed / Cancelled / No Show), a Customer Master
  or any customer deduplication, calendar or scheduler views, slot-conflict detection (two
  bookings may share a date and time — there is no room, photographer, duration or capacity in
  the model), and WhatsApp reminders. Each is a real later decision, not an oversight.
- **New permissions need existing roles re-saved.** Role grants are stored JSON, written before
  the newer permissions existed, so roles other than Super Admin (which bypasses everything)
  do not have `masters_items` … `masters_books`, `operations_appointments`, `operations_billing`
  or the Phase 6 `operations_receipts` / Phase 7 `reports_receivables` ticked — verified: the `viewer@example.com` role gets 403 on every
  billing route until its role is re-saved. Per the README, opening a role in
  Settings → Roles and saving it picks up new permissions. A stale `sample_categories` key may
  still sit in that JSON; it is harmless (no route checks it) and clears on the next save.
- Workspace packages are still named `@erp/*` (the UI says StudioCRM). Renaming them is its own
  task and touches every import.
- `README.md` is still the boilerplate's README (its file references were repointed at Item
  Master when the sample module was deleted).
- **`JWT_SECRET` and the demo passwords are now a live exposure, not a future chore.** The app is
  published on the internet and the repository is public. `apps/api/.env` still has
  `JWT_SECRET=change-me-in-production`, and the site-root `.env` on the host has not been proven to
  differ — if it does not, anyone can mint a valid token. The `Admin@1234` logins are published in
  `seed.ts` and `README.md` for anyone to read, and the database behind them is the real hosted one.
  Rotate the secret on the host and change those passwords before the client is given the link.
- No lint/format tooling is installed by design. Match the surrounding style; `.editorconfig`
  (2 spaces, LF) is the only rule.
