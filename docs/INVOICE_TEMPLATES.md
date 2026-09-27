# Invoice templates, preview and PDF

How a saved bill becomes an invoice on screen, on paper and as a PDF — and why a template can
never change a figure on it.

```
saved bill (its own snapshot) ─┐
company profile + logo ────────┼─> buildInvoiceModel ─> InvoiceRenderModel ─┬─> browser preview / print
date format (app settings) ────┤   (packages/shared)     (display-ready)      └─> PDF (pdf-lib, server)
invoice template ──────────────┘                                                └─> WhatsApp share (docs/WHATSAPP_SHARING.md)
```

## The one rule

The **bill is the financial source of truth.** Qty, rate, discount, taxable, GST, Grand Total,
bill number, bill date and the customer come from the saved bill — its own snapshot and the
totals the server stored when it was saved (`docs/BILLING_CALCULATION.md`). A template decides
**presentation only**: which sections and columns print, their order, titles, spacing, style.

`buildInvoiceModel` (`packages/shared/src/invoice.ts`) formats; it never adds, rounds or
re-allocates. It reads nothing from Item or Sub Item Master, so renaming an item or changing its
GST rate never alters an old invoice. Rendering is read-only end to end: no endpoint here writes a
bill, a line, a book counter or the appointment counter.

## Data model — `invoice_templates` (migration `0014`)

| Column | Notes |
| --- | --- |
| `id`, `tenant_id` | tenant-scoped (`tenantRef`, cascade with the tenant) |
| `template_name` | unique per tenant, case-insensitive (`invoice_templates_tenant_name_lower_idx`) |
| `description` | optional internal note |
| `supported_mode` | `BOTH` \| `WITH_GST` \| `WITHOUT_GST` (check constraint) |
| `layout_preset` | `CLASSIC` \| `COMPACT` \| `DETAILED` \| `STUDIO` (check constraint; `STUDIO` added by migration `0023`) |
| `is_default` | at most one per tenant — partial unique index `invoice_templates_one_default_idx` |
| `is_active` | a default must be active (`invoice_templates_default_is_active_check`) |
| `config` | jsonb, the controlled presentation config below |

No bill references a template — a bill does not remember which template printed it — so deleting
a template can never touch a bill. Additive migration; no existing table changed. Since Phase 5.1
the one thing that references a template is a **public invoice link** (`public_invoice_links`,
composite FK to `invoice_templates_id_tenant_uk`, migration `0015`): editing, deactivating or
deleting a template revokes its live links in the same transaction, so a URL a customer already
has never starts rendering differently (`docs/WHATSAPP_SHARING.md`).

## Configuration schema

`invoiceTemplateConfigSchema` (`packages/shared/src/schemas/invoiceTemplates.ts`). Every level is
`.strict()`: an unknown key, section, column, alignment or paper setting is **refused**, not
dropped. Text fields are plain text (length-capped, control characters refused) and are only ever
drawn as text — there is no HTML, CSS, script, URL or expression anywhere.

| Section | Settings |
| --- | --- |
| `header` | show logo / company name / address / phone / email / GSTIN; logo alignment; header alignment; `title` (GST bill) and `titleWithoutGst` (so "Tax Invoice" never heads a bill that charged no tax) |
| `customer` | show mobile, baby name, birth date, delivery date, appointment no., bill remark |
| `columns` | ordered list from `serial, item, product, hsn, quantity, rate, amount, taxable, gstRate, gstAmount, total, remark`. Membership = visible, position = order. Must include `total` and one of `item`/`product`; no duplicates |
| `totals` | show Sub Total, Discount, Taxable Amount, GST, rate-wise GST summary |
| `footer` | terms (≤ 1000 chars), thank-you note, authorised signatory |
| `page` | A4 or A5, portrait, margins `NORMAL`/`NARROW`, spacing `NORMAL`/`COMPACT` |

**Always printed, whatever the template says** (they identify the invoice): the title, Bill No.,
Book, Bill Date, the customer name and the Grand Total.

## Defaults and compatibility

- Starter templates, seeded once per tenant by `ensureStarterTemplates` (new tenants in
  `seedTenantDefaults`, existing tenants on first use): **Classic** (BOTH, default), **Compact**
  (BOTH), **Detailed GST** (WITH_GST). "Once" is exact: the default can never be deleted, so a
  tenant with zero templates has never been seeded; a concurrent first request is absorbed by the
  unique indexes. A tenant's own templates are never overwritten.
- **Set default** clears the old default and sets the new one in ONE transaction; the partial
  unique index makes a race fail rather than leave two defaults. The default cannot be deleted or
  made inactive — make another template the default first. Duplicating never copies the default flag.
- **Which template renders a bill** (`pickInvoiceTemplate`, used when none is chosen):
  1. the tenant default, if active and compatible with the bill's tax mode;
  2. else the first active compatible template — BOTH before single-mode, then by name, then id;
  3. else the built-in Classic (not a stored row), so a bill can always be rendered.
- A template the operator picks explicitly must be the tenant's, active, and compatible — an
  incompatible one (e.g. "Detailed GST" for a WITHOUT_GST bill) is refused, never silently used.
- Choosing a template in the preview previews it only; the default is changed only in Settings.

## The render model

`InvoiceRenderModel`: template ref, tax mode, title, **style** (preset metrics in PDF points),
header (company name, the address/contact/GSTIN lines that exist, a logo *reference*), meta and
customer fields, columns (label, alignment, weight, `wrap`), rows of formatted cells, totals, the
GST summary, remark, footer, `documentLabel` and `fileName`. Every visibility and ordering
decision is taken here, once — both renderers only draw.

- **Company** from the Phase 3 company profile (`getCompanyProfile`), only details that exist.
- **Dates** in the tenant's Date Format (`formatDateOnly`) — never browser locale, no separate
  invoice date setting; preview and PDF print the same string.
- **Money** in Indian grouping (`formatAmount`), locale-free and deterministic; values come from
  the stored `numeric(…, 2)` columns.
- **WITH_GST**: GST %, GST and Taxable columns as configured; totals Sub Total / Discount /
  Taxable Amount / GST / Grand Total; the rate-wise summary is the bill's own `gstSummary` and its
  total row is the bill's `netTaxable` and `gstAmount`.
- **WITHOUT_GST**: title `titleWithoutGst`; the GST %, GST and Taxable columns are dropped (Taxable
  would only repeat Total, which is labelled "Amount"); no GST or Taxable total, no GST summary.
  The saved GST snapshot on the lines is untouched — it is simply not presented as charged.
- **Discount** is the bill's stored `discountAmount` ("Discount (10%)" for a percentage); a zero
  discount is not printed. A line's allocated share is available to the model but not re-derived.
- **CGST/SGST/IGST is not split** — it needs place-of-supply rules nothing here establishes.

## Browser preview and print

`InvoiceDocument` (`apps/web/src/components/invoice/`) draws the model in the same units as the PDF
(CSS `pt`), with fixed invoice colours (a document ignores the app theme). `InvoiceSheet` scales an
A4 sheet to its container, keeping the proportions. The gallery thumbnails and the designer's
live preview use the same renderer over the in-memory **sample bill** (`sampleInvoiceBill`, marked
SAMPLE, never saved) with the real company profile and date format — no PDF is generated for them.

**Print**: `InvoicePrintRoot` renders the invoice straight under `<body>`, outside the app; the
print stylesheet hides everything else, so the sidebar, top bar and controls never print. The page
margin is the template's (`@page`). Screen and print flow continuously; the PDF is where pages are
split.

## PDF

`renderInvoicePdf` (`apps/api/src/services/invoicePdf.ts`) lays the page out with **pdf-lib**; all
text goes through the text engine in `invoicePdfText.ts` — **HarfBuzz (harfbuzzjs, WASM)** shaping
and a CID-font writer of our own. English, **Gujarati**, **Hindi/Devanagari**, digits, punctuation
and ₹ are supported, mixed freely in one string.

**Why this works on the Windows Node hosting**: everything is pure JavaScript + WASM — no native
addon, no executable, no headless browser, no system fonts, no network. esbuild bundles it into
`dist/server.js` (the deploy ships `apps/api/dist`, not `node_modules`). The only files read at
runtime sit beside server.js, copied by `build.mjs`: the fonts in `dist/fonts/` and
`dist/harfbuzz.wasm` (harfbuzzjs finds it via `new URL('harfbuzz.wasm', import.meta.url)`, i.e.
next to server.js, whatever the working directory). Verified by running the built server from a
folder with no `node_modules` anywhere above it and downloading English, Gujarati and Hindi PDFs.
**`Deploy-StudioCRM.ps1 -Hotfix` uploads only server.js** — never use it for the first deploy of
this code, which needs `dist/harfbuzz.wasm` and the new fonts on the host.

### PDF text: scripts and shaping

```
Unicode string ─> script runs ─> HarfBuzz shaping ─> positioned glyphs ─> PDF (CID fonts + ToUnicode)
```

- **Fonts.** Noto Sans (Latin, digits, punctuation, ₹), Noto Sans Gujarati, Noto Sans Devanagari —
  regular and semibold each. **Pre-subset** once by `pnpm --filter @erp/api fonts:invoice`
  (`scripts/build-invoice-fonts.mjs`, HarfBuzz subsetter via `subset-font`, which keeps GSUB/GPOS so
  conjuncts and mark positions survive): Latin ~52 KB, Gujarati ~128 KB, Devanagari ~165 KB per
  weight, committed in `apps/api/assets/fonts/` with each family's OFL licence. Embedded whole —
  pdf-lib's own subsetter drops Noto glyph outlines (the page prints blank); never go back to it.
  Only the fonts an invoice actually uses are embedded (an English invoice carries no Indic font).
- **Script runs.** Gujarati letters → Noto Sans Gujarati, Devanagari → Noto Sans Devanagari,
  everything else (spaces, digits, ₹, punctuation, Latin) → Noto Sans, so a figure looks the same in
  any script. Marks and ZWJ/ZWNJ stay with the run before them; a danda stays with its Indic run.
  Runs follow each other in one text object — no spacing jump between scripts.
- **Shaping.** Each run is shaped by HarfBuzz with its script set (the engine Chrome uses): conjuncts,
  half forms, reph, the pre-base િ / ि, and mark positions. Every glyph's x/y advance and x/y offset
  is written into the PDF (TJ adjustments and text rise). Latin ligatures are off ("fi" stays two
  letters). One WASM instance and one HarfBuzz font per (script, weight) per process; invoice text
  is cached only for the length of one render.
- **Measuring = drawing.** Column widths, wrapping, alignment and page fit use the widths of the
  SAME shaped glyphs that are drawn. Wrapping breaks at spaces; a word wider than its cell breaks
  only where a grapheme boundary (Intl.Segmenter) is also a HarfBuzz cluster boundary — never inside
  a conjunct, never between a base and its sign.
- **Searchable / copyable text — how it works.** There is no hidden second text layer. Each font is
  embedded as a Type0/CIDFontType2 font whose CIDs are allocated per (glyph, text, width); the
  ToUnicode map gives each CID the original characters it stands for. For each HarfBuzz cluster the
  text is cut into tokens (a letter plus its signs) and dealt to the cluster's ADVANCING glyphs in
  drawing order; the nonspacing signs (virama, most vowel signs, anusvara) move to zero-width
  *carriers* — the font's space glyph at width 0, which draws nothing — placed right after in the
  content stream. Stream order is text order, so extraction returns the original string in logical
  order even where ि is drawn before its consonant. Why carriers: text extractors (pdf.js at least)
  treat a glyph whose text contains a nonspacing mark as zero-width, so putting marks on a wide
  glyph derails their spacing (spurious or missing spaces). Zero-advance glyphs (signs above/below,
  reph) and surplus glyphs (ई is two glyphs, one character) carry no text and are drawn as vector
  outlines at their HarfBuzz position — visible, never extracted twice. Verified with pdf.js over
  ~6,200 Gujarati/Devanagari syllables in both weights: zero mismatches.
- **Unsupported characters are refused, never boxed.** Before drawing, every printed string is
  checked against the fonts' character maps (`unprintableText`); anything outside (Tamil, emoji, CJK…)
  makes the PDF endpoint answer **422 `INVOICE_UNPRINTABLE_TEXT`** naming the characters and the
  invoice area ("in Customer", "in Line 2, Remark"). A glyph 0 reaching the drawer is the same error
  (backstop). The preview still shows the bill (the browser draws what it can) and warns from the
  `pdfUnprintable` list; Download PDF shows the 422 message.
- **Failure is contained.** harfbuzzjs is imported lazily on the first PDF, so a missing or broken
  WASM fails only PDF requests — the standard `INTERNAL` envelope, cause in the server log, no path
  or stack to the browser — and never the server's start. Proven by deleting the WASM from the
  isolated bundle.
- **Layout**: header (logo row, company block), title, Billed To / Invoice Details, the item table,
  GST summary + totals band, remark, terms, thank-you, signatory, and a footer on every page
  (`<title> <book> / <bill>` and "Page x of y"). Numbers, serial and HSN never wrap — they take
  their natural width and the text columns share the rest; if even that does not fit the table's
  type steps down (to 6 pt) before anything breaks.
- **Multi-page**: a row moves to the next page whole (only a row taller than a whole page — a very
  long remark — continues line by line; nothing is ever drawn off the page); the table header is never
  left alone at a page foot and repeats on each new page; the totals band
  and each footer block move to a new page whole rather than overlap; page numbers are written
  once the count is known.
- **Logo**: read through the Phase 3 logo service inside the caller's tenant — never a URL. PNG and
  JPEG embed; pdf-lib cannot embed WebP, so the logo form converts a chosen WebP to PNG in the
  browser before upload (a WebP stored some other way is skipped, not faked). Scaled into a fixed
  box, aspect ratio kept.
- **Deterministic**: same bill + template + settings → byte-identical PDF (the PDF's dates are the
  bill's `updatedAt`; font names are fixed).
- **File name**: `Invoice-<book>-<bill>.pdf`, e.g. `Invoice-2026-27-1.pdf` — no customer data,
  sanitised to letters, digits, `_` and `-`.

## API and RBAC

| Endpoint | Permission |
| --- | --- |
| `GET/POST /api/settings/invoice-templates`, `GET/PUT/DELETE …/:id`, `POST …/:id/default`, `POST …/:id/duplicate` | `settings_invoice_templates` (read / create / update / delete) |
| `GET /api/common/lookups/invoice-templates` | any signed-in user — active templates, picker fields only |
| `GET /api/bills/:id/invoice?templateId=` | `operations_billing` read — the render model |
| `GET /api/bills/:id/invoice/pdf?templateId=&download=1` | `operations_billing` read — `application/pdf`, `nosniff`, `no-store` |

Anyone who may read a bill may preview, print and download its invoice; managing templates is a
Settings permission. The bill, the template and the logo are all looked up inside the caller's
tenant — another tenant's id is "not found". Existing roles need re-saving to gain the new
`settings_invoice_templates` permission (Super Admin bypasses).

Template changes are audit-logged (`invoice_template`: created, updated, set as default, deleted,
created as a copy).

## Web

- **Settings → Invoice Templates**: a gallery of real thumbnails; Preview (sample, with/without
  GST), Edit, Duplicate, Set as default, Delete (not for the default).
- **Designer** (`/modules/settings/invoice-templates/new` or `/:id`, full width): name, supported
  mode, preset and active in the top bar; a compact panel (Header, Customer, Columns, Totals,
  Footer, Page) beside the live A4 preview, with a With/Without GST sample switch. Columns can be
  shown, hidden and reordered. Ctrl/Cmd+S saves.
- **Billing**: a saved bill has **Preview** (disabled while the form has unsaved edits — the
  invoice shows the saved bill; a new bill has none, since it has no number yet). The preview page
  has the compatible-template picker, Print and Download PDF; the bill list's row menu has
  Preview invoice and Download PDF.

## WhatsApp

Built in Phase 5, with the secure public link in Phase 5.1 — see `docs/WHATSAPP_SHARING.md`. The
customer's link (`GET /i/<token>`) serves this same PDF through `getBillInvoicePdf`
(`services/invoice.ts`) for the template the link was made with — byte-identical to the
authenticated download; it adds no PDF code of its own. `getBillInvoicePdf` stays the reusable
entry point for a future official WhatsApp Business API transport.

## Print & Invoice settings

**Settings → Print & Invoice** (`/modules/settings/print-invoice`, `pages/settings/print/`) holds what
every invoice prints besides the bill, beside a live preview drawn by the SAME builder and renderer
over the sample bill (never saved). Permission: `settings_invoice_templates` (read to view, update
to change) — the same people who manage templates; no new permission. Anyone signed in may READ the
settings (they come with `GET /api/settings`), because every invoice viewer renders with them.

| Area | Where it lives | Notes |
| --- | --- | --- |
| Company name, address, mobile, GSTIN, logo | the default company (`Settings → Companies`) | shown read-only here, with the existing logo field; one truth, never copied |
| Show logo / signature / footer image / bank details / terms / page numbers | `app_settings.settings.print` | master switches; a template's own switches still apply |
| Bank name, account name, account number, IFSC (upper-cased), branch | `print.bank` | display text for customers to pay into — NOT the Account Master (money truth) |
| Invoice note, terms & conditions, footer text | `print` | plain text, wrapped in the PDF, length-capped |
| Accent | `print.accent` | a preset (`INVOICE_ACCENT_COLORS`), dark and print-safe; tints rules and headings only |
| Copy label (Original / Duplicate / Office Copy / none) | `print.copyLabel` | the default; the invoice preview can print another (`?copy=`); a label, never a second bill |
| Default delivery days | `print.defaultDeliveryDays` | a NEW bill suggests Planned Delivery = Bill Date + N while the field is empty or still holds that suggestion; saved bills never change |
| Signature image, footer image | `company_print_assets` (migration `0023`) | like the logo: bytea in the database (a deploy replaces the site folder), per default company, PNG/JPEG ≤ 1 MB by the file's own bytes (WebP converted to PNG by the form, refused by the API), aspect ratio kept, never stretched |

- **Stored** under the `print` key of the tenant's app settings — no table. `PUT /api/settings/print`
  validates the whole object strictly (`printSettingsSchema`); General settings can never change it.
  Reads are normalised **field by field** (`toPrintSettings`): a value that no longer validates takes
  its default and every other value is kept. Settings writes merge top-level keys in the database
  (`settings || patch`), so two writers of different keys cannot undo each other.
- **Terms**: a template that shows terms prints its own text; with none of its own it prints the
  settings' terms (when shown). A template that hides terms prints none.
- **Paper size, columns, totals** stay per template (Designer → Page: **A4 or A5**).
- **Historical behaviour — current branding, like the logo.** No bill stores its branding: an old
  bill re-printed today shows today's logo, signature, bank details, terms and accent, and its
  current payment position. Figures never change (they are the bill's own). A public invoice link
  (`/i/<token>`) is therefore NOT revoked by a Print settings change or a new receipt — the same rule
  the logo has always followed; a template edit or a bill edit still revokes it.

### Payments on an invoice

A template with **Advance / Received and Balance Due** (`totals.showPayments`, on for Legacy Studio)
prints the bill's DERIVED payment position — `paidPaiseByBill` (`services/billPayments.ts`, the one
Paid definition: allocations on ACTIVE receipts + ACTIVE advance applications), worked in paise.
A cancelled receipt and a customer's unapplied advance are not in it. Read only when printed.
**Amount in words** (`totals.showAmountInWords`) is `amountInWords(grandTotal)` — Indian crore/lakh
wording, from the same paise as the printed figure.

### Legacy Studio

The studio's old printed bill, re-drawn on the **Studio** preset (`layoutPreset = 'STUDIO'`):
letterhead with the logo beside the company block and the copy label + title opposite (no logo → no
empty box), customer and bill details side by side, a thin-ruled item table (Item, Product, Qty,
Rate, Amount, **Discount** = the line's stored allocation, GST % / GST on GST bills, Total), totals
with amount in words, Advance / Received and Balance Due, then note, terms, and a sign-off band —
bank details, the footer image and a blank **Received By** line at the left; "For <company>", the
signature image and "Authorised Signatory" at the right. Nothing is invented: the old bill's
"Image No." has no authoritative field and is not printed; "Received By" is a blank line for a
handwritten signature, never a user's name.

- New tenants get it with the other starters. Existing tenants get it ONCE (marker
  `invoiceTemplateSeeds` in app settings): deleting it never brings it back, a tenant's own template
  of that name is never touched, and it is **never made the default**.
- `pickInvoiceTemplate` never picks a Studio-preset template by itself (step 2): it prints only as the
  tenant default or when chosen, so adding it cannot change what an existing tenant's bills print.

### Professional Studio

A modern tax-invoice layout on the **Professional** preset (`layoutPreset = 'PROFESSIONAL'`,
migration `0024` only widened the preset check; `headerLayout = 'BANNER'`), drawn by the same model
and both renderers:

- A small centred title ("Tax Invoice" / the without-GST title) with the copy label at its right;
  then the logo (≤ 48 pt high, aspect kept, no box when absent), the company block (name, address,
  GSTIN) and a contact column (Mobile, Email, Web — each only when the company profile has it, email
  and website under the template's "Email" switch). Model: `header.contact`, empty for other presets,
  whose contact line stays in `header.lines` as before.
- ONE compact customer + bill section — headings **CUSTOMER** / **BILL DETAILS** (Name, Mobile, Baby
  Name, Birth Date | Book No., Bill No., Bill Date, Planned Delivery; empty rows are not printed).
  There is **no "Bill To" / "Ship To"**, and no PO, dispatch, place-of-supply or payment-terms field —
  StudioCRM has no authoritative source for them. Tests assert their absence in model, preview and PDF.
- Item table `# | Item | Product | Qty | Rate | Discount | GST% | GST | Total`: each line reconciles
  (Qty × Rate − stored discount allocation + stored GST = stored line total; Qty × Rate is the stored
  gross, rounded to the paisa, so a fractional quantity can differ by under half a paisa — add the
  Amount column in the designer to print the gross itself). Discount drops out on a
  bill without one; GST% / GST drop out without GST (and Total reads "Amount"). The header is the one
  coloured area: an accent band with white headings — the tenant's Invoice Accent, never hard-coded
  (choose Blue in Print & Invoice for the blue look; every accent is dark, so it prints readably in
  black and white).
- Beside the totals: Total in words, then bank details (only filled lines). Totals: Sub Total,
  Discount, GST, **Grand Total** (ruled above and below), Advance / Received, **Balance Due** — the
  same derived payments as Legacy Studio (active allocations + applied advance; an unapplied advance
  or a cancelled receipt never counts). No Taxable row and no GST summary by default (the per-line
  GST columns already carry it); both can be switched on in the designer.
- Remark, note, terms, then the sign-off kept whole on one page: a blank **Received By** line at the
  left and "For <company>" / signature image / "Authorised Signatory" at the right on ONE level line,
  the footer image (if any) centred between them.
- Seeded like Legacy Studio (marker `PROFESSIONAL_STUDIO`), never the default, never picked by
  `pickInvoiceTemplate` step 2. The other templates' output is unchanged (verified byte-for-byte;
  pinned by snapshot tests of their PDF text).
- **Forward-only.** A build older than this one does not know the PROFESSIONAL preset: rolling the
  code back while a tenant uses a Professional template (as default or on a share link) would break
  that tenant's invoices. Before any such rollback, make Classic the default and deactivate the
  Professional templates.

### Legacy Print Settings — what was not migrated

| Legacy setting | Decision |
| --- | --- |
| Company, Address, Mobile, GSTIN, Display Logo, logo / signature / terms images, Bank & A/c, IFSC & Branch, Note, Footer, Delivery Day, Bill Line Color, Bill Copy, Bill Print Size, mobile number on print | **Migrated** (above; line colour → Accent; print size → template A4/A5; mobile on print → the template's Customer switches) |
| Default printer, direct print / direct view, Save-and-Print / Save-and-View, message box before print | **Obsolete desktop behaviour** — the browser's Print and the PDF are the print path |
| SMS 1–4, SMS text, daily SMS timing, SMS to owner/staff, OTP via SMS / WhatsApp | **Obsolete / outside the architecture** — there is no SMS gateway; WhatsApp is click-to-chat with a public link (docs/WHATSAPP_SHARING.md) |
| Permission-password workflow | **Not applicable** — Roles & Permissions (RBAC) |
| Email checkbox | **Not applicable** — no email integration exists |
