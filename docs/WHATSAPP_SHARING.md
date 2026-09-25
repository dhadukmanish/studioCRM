# WhatsApp invoice sharing

Sharing a SAVED bill's invoice with its customer on WhatsApp. Phase 5 opened WhatsApp with the
number and message prefilled; **Phase 5.1** puts a **secure public invoice link** in that message,
so the customer taps it and the invoice PDF opens — no ERP login, no file for the operator to
attach, and the customer does not need to be in the operator's phone contacts.

Browser-based: no WhatsApp API, no WhatsApp credentials, no automation of the operator's WhatsApp.

## The flow

```
saved bill ─> Share on WhatsApp ─> Create link ─> message now holds https://<app>/i/<token>
          ─> Open WhatsApp (click-to-chat: number + message prefilled) ─> operator presses Send
customer taps the link ─> GET /i/<token> ─> the invoice PDF, inline, in the phone's browser
```

1. The Share dialog opens with the bill's saved mobile, a template, and the tenant's message. It
   shows the bill's **current link state** — it never creates a link just by opening.
2. **Create link** (or **Replace link**, see below) asks the server for the link. The server
   **reuses** the bill's live link when it is for the same template and the bill has not changed
   since; otherwise it makes a new one. The message then shows the real URL.
3. **Open WhatsApp** — one click, a real `target="_blank"` link, nothing asynchronous between the
   click and the new tab — opens `https://wa.me/<number>?text=<message>`. The dialog says
   *"Press Send in WhatsApp to share it."* It never says sent, delivered or read.

PDF Download stays where it was (Invoice Preview, saved bill form) for anyone who wants the file;
the WhatsApp flow no longer needs it.

## Where it is

| Place | Action |
| --- | --- |
| Invoice Preview | Print · Download PDF · **WhatsApp** — shares the template shown in the preview |
| Saved bill (`/modules/billing/:id`) | Preview · PDF · **WhatsApp** — disabled while there are unsaved edits; absent on a new, unsaved bill |
| Bills list | row menu → **Share on WhatsApp** |

All three open the same `ShareInvoiceDialog` (`apps/web/src/components/invoice/`).

## The public link — `/i/<token>`

**One link per bill at most.** A link is a capability: whoever holds the URL may read that one
invoice and nothing else.

### Token and storage (`services/publicInvoiceLinks.ts`)

- The token is **32 URL-safe characters = 192 bits**: the first 24 bytes of
  `HMAC-SHA256(PUBLIC_LINK_SECRET, "studiocrm:public-invoice-link:v1:" + link.id)`, base64url.
  `link.id` is a random v4 UUID from Node's `crypto`. The URL carries no bill id, bill number,
  tenant, template, customer or mobile.
- **The raw token is never stored.** `public_invoice_links.token_hash` holds its SHA-256 (hex); a
  request is looked up by hashing the token it presents. A database leak alone yields no working URL.
- **Why HMAC rather than a stored random token:** the product needs both "never store the token"
  and "re-sharing an unchanged bill reuses the link the customer already has". The server can
  rebuild the token from the row id with the secret, so reuse needs no stored token.
- **Every request is also checked against the current secret**: after the hash lookup, the server
  rebuilds the token the current `PUBLIC_LINK_SECRET` signs for that row and compares it with the
  presented one in constant time (`timingSafeEqual`). A server without a valid secret opens nothing.
- **Changing `PUBLIC_LINK_SECRET` invalidates every public invoice URL issued so far** — their tokens
  no longer match. That is accepted, and it is the emergency way to revoke all links at once. The
  next share of each bill makes a new link (the old row is revoked as `STALE` when seen). No secret
  versioning or rotation mechanism exists, deliberately.
- Timing: the lookup is an indexed equality on a SHA-256 of the presented token (an attacker cannot
  steer the hash), and the token comparison is constant-time — no useful timing oracle.

### Table `public_invoice_links` (migration `0016`, with `0015` adding the template key it needs)

`id, tenant_id, bill_id, template_id (NULL = built-in Classic), token_hash, bill_revision,
created_at, expires_at (NULL — unused, reserved), revoked_at, revoke_reason`.

- **No customer data**: no name, mobile or message. The bill stays the source of truth.
- `UNIQUE (tenant_id, bill_id) WHERE revoked_at IS NULL` — the one-active-link rule in the database.
- Tenant-safe composite FKs to `bills(id, tenant_id)` and `invoice_templates(id, tenant_id)`, both
  `ON DELETE CASCADE` (a deleted bill or template takes its link rows with it — the URL becomes
  unknown). `0015` adds `invoice_templates_id_tenant_uk`; it is a separate migration because
  drizzle-kit orders a new key after the FK that needs it (the HANDOFF "generator gotcha").
- `revoke_reason`: `BILL_UPDATED | TEMPLATE_CHANGED | REPLACED | MANUAL | STALE`.

### Lifecycle

| Event | Effect on the bill's link |
| --- | --- |
| Bill created | none — no link exists until a share asks for one |
| Share dialog opened, preview, print, PDF download, WhatsApp opened | none |
| **Create link**, same template, bill unchanged | the live link is **reused** (same URL) |
| **Create link** with a different template | old link revoked (`REPLACED`), new one made |
| **Bill saved** (any successful edit, even an identical re-save) | revoked (`BILL_UPDATED`) **in the bill update's own transaction**; no new link is made |
| Bill edit refused (validation) or rolled back | nothing — the revoke rolls back with it |
| Template edited, deactivated or deleted | every live link on it revoked (`TEMPLATE_CHANGED`), same transaction |
| Operator clicks **Revoke link** (with a confirm) | revoked (`MANUAL`); nothing new until the next Create |
| Bill deleted | link rows deleted with it |
| Company branding or the date format changes | **nothing** — see "Current presentation" |

Revocation lives in the services, not in React: `updateBill` (`services/bills.ts`) and
`updateTemplate` / `deleteTemplate` (`services/invoiceTemplates.ts`) call `revokeActiveLinks`
inside their transactions.

**Defence in depth — the bill revision.** A link records `bill_revision` = the bill's `updated_at`
when it was made (copied in SQL, so microseconds survive). Every public request requires the link
to be unrevoked **and** its revision to equal the bill's current `updated_at`; a mismatch is refused
and the link revoked on sight (`STALE`). So even a revoke that were somehow missed could not serve
an old revision.

**Concurrency.** `preparePublicLink` takes the bill's row lock (`FOR UPDATE` — the same lock
`updateBill` takes) and a `FOR SHARE` lock on the chosen template, then re-checks the template is
still active. So: simultaneous shares queue and all receive the one link; a share racing a bill edit
lands either before it (and the edit revokes it) or after it (a link for the new revision); a share
racing a template edit likewise. After rendering, the public route re-checks the link is still
active before sending the PDF, so an edit that committed mid-render cannot put new figures under an
old URL. All of this is covered by the DB-backed tests.

### The public endpoint — `GET /i/:token` (`routes/publicInvoice.ts`)

- **Outside `/api/`** and outside the authenticated API — no session, no permission, no bill route
  reachable through it. The token grants exactly one invoice.
- Order of work: token shape (no DB) → one indexed lookup by hash (+ revision + expiry) → rate
  limit **per link** (30 renders/min, in memory, `lib/rateLimit.ts`) → render → re-check active →
  send. Per link, not per client IP: behind IIS the client IP is either one shared address or a
  spoofable `X-Forwarded-For`, so a per-IP limit would let one noisy client lock every customer out.
  Invalid tokens are not counted — they cost one indexed lookup and never reach the renderer.
  **No PDF work happens for an invalid token.**
- Valid: the Phase 4 PDF, byte-identical to the authenticated download for the same template —
  same `buildInvoiceModel`, same renderer and fonts, same file name (`Invoice-<book>-<bill>.pdf`,
  no customer data). `Content-Disposition: inline`, `Cache-Control: private, no-store`,
  `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer`, `nosniff`. The customer's browser shows,
  downloads or prints it.
- Unknown, malformed, revoked, stale or expired: **the same 404 page**, word for word — *"Invoice
  link no longer valid — This invoice link is not available. The invoice may have been updated —
  please use the latest invoice link shared with you."* So the response does not reveal which of
  those it was. Fixed text only (nothing from the request is echoed), a strict CSP
  (`default-src 'none'`), light/dark aware, phone-friendly.
- A valid link that cannot be rendered (template made unusable, a renderer fault): a calm 503 page;
  the server log gets the link id, never the token.
- Rate limited: 429 page.
- **Logs never hold a full token**: Fastify's request serializer rewrites `/i/<token>` to
  `/i/[redacted]` (`redactPublicToken`), and errors are logged with the link id. (The host's own IIS
  access log is outside the app's control and does record URLs — treat it as sensitive.)

### Current presentation, not a snapshot

A link renders the bill's saved snapshot and stored totals (Phase 4 rule: drawn, never calculated)
with the **current** company branding and date format, like every other invoice output. Changing
Company Settings or the date format therefore changes what an open link shows, and does **not**
revoke links — the link's revision is the bill's. Historical branding snapshots are a later decision
(none was asked for). A template, by contrast, is part of what was shared, so editing it revokes.

### Configuration — the absolute URL

The message needs an absolute URL, and it is taken from configuration only, **never** from the
request's `Host` header (a forged Host would otherwise put someone else's domain into a message the
studio sends to its customer).

| Variable | Where | |
| --- | --- | --- |
| `PUBLIC_APP_URL` | `apps/api/.env`; site-root `.env` in production | The origin customers open, e.g. `https://studio.kriviinfotech.com`. `https` is required except for `localhost`; an origin only — no path (the route lives at `/i/`), credentials, query or fragment. |
| `PUBLIC_LINK_SECRET` | same | 32+ random characters: `node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))"`. Production gets its own value. Server-side only — never in git, docs, the web bundle or a log. **Changing it invalidates all issued links.** |

Missing or invalid → creating a link answers **503 "Invoice links are not set up on this server
yet"** and no link opens; nothing half-works. In development `PUBLIC_APP_URL=http://localhost:5173`
and Vite proxies `^/i/` to the API (`apps/web/vite.config.ts`). Development and production share one
database, but a link made on a dev machine is signed with the dev secret, so production neither
opens nor reuses it — it replaces it on the next share.

**Hosting:** in production Node serves every path (IIS forwards everything through
`httpPlatformHandler`; `deploy/web.config` has no rewrite rules), and `/i/:token` is a real Fastify
route registered before the SPA fallback, so it is never answered with the app shell. Proven with
the built bundle (`dist/server.js` + `public/`) run from an isolated folder.

## Destination number — `whatsappDestination` (`packages/shared/src/whatsapp.ts`)

Defaults to the **bill's saved mobile** (the bill's own snapshot, never a master). The operator may
change it for this share; **the bill is never edited**. The number does not need to be in the
operator's contacts — click-to-chat opens a chat with any number. Normalised to international digits:

| Typed | Opens chat with |
| --- | --- |
| `9876543210`, `98765 43210`, `98765-43210`, `09876543210` | `919876543210` |
| `+91 98765 43210`, `919876543210`, `0091 9876543210` | `919876543210` (never `9191…`) |
| `+44 7700 900123`, `0044 7700 900123` | `447700900123` (an explicit country code is kept) |

Refused with an inline message: empty, letters, a `+` in the middle, a 10-digit number not starting
6–9, a wrong length. Whether the number has WhatsApp cannot be known and is not checked.

## Message — `composeInvoiceMessage`

Default (application):

```
Hello {CustomerName},

Your invoice {BookNumber}/{BillNumber} for {GrandTotal} is ready.

View Invoice:
{InvoiceLink}

Thank you,
{CompanyName}
```

A tenant may set its own in **Settings → General → Invoice sharing** (`whatsappInvoiceMessage` in
`app_settings`). Placeholders are a fixed list — `{CustomerName} {BookNumber} {BillNumber}
{BillDate} {GrandTotal} {CompanyName} {InvoiceLink}` — plain text substitution, nothing evaluated.
An unknown placeholder is refused when saving (400, and inline in the form).

**Messages saved before Phase 5.1** have no `{InvoiceLink}`. They are **not rewritten**; instead
every compose appends a blank line and `View Invoice:\n{InvoiceLink}` to a template that lacks the
placeholder (`withInvoiceLinkPlaceholder`). The share context returns the message with the literal
`{InvoiceLink}` still in it; the dialog keeps that placeholder in its draft and shows the real URL
once a link exists (`fillInvoiceLink`), so a template switch, a replaced link or a revoke never
leaves a stale URL in the text. If the operator deletes the link from the message, it is appended
again at the end — the dialog says so — so a message never leaves without it.

Values come from what is saved: the bill's customer name and **stored** Grand Total (formatted
exactly as the invoice prints it, `₹65,625.00`), `{BillDate}` in the tenant's date format,
`{CompanyName}` from Company Settings. No baby name or other personal detail by default. The text
is UTF-8 percent-encoded (`encodeURIComponent`), so Gujarati, Hindi, ₹, `&`, `+`, line breaks and
the URL arrive intact.

## API

| Endpoint | Permission | |
| --- | --- | --- |
| `GET /api/bills/:id/invoice/share` | `operations_billing` read | saved customer/mobile, stored total, file name, composed message (with `{InvoiceLink}`) |
| `GET /api/bills/:id/invoice/public-link` | `operations_billing` read | the bill's live link, if any — creates nothing |
| `POST /api/bills/:id/invoice/public-link` `{ templateId? }` | `operations_billing` read | reuse or create the link → `{ url, outcome: CREATED \| REUSED, templateId, templateName, createdAt }` |
| `DELETE /api/bills/:id/invoice/public-link` | `operations_billing` **update** | manual revoke → `{ revoked }` |
| `POST /api/bills/:id/invoice/share-opened` | `operations_billing` read | audit only |
| `GET /i/:token` | **none** — the token is the capability | the PDF, or the "no longer valid" page |

Showing the invoice to its customer is Billing read, like preview/download: a read-only billing user
may make and reuse the link (no new RBAC key). **Manually revoking** a link that may already be with
the customer is a state change and needs Billing **update**; the dialog hides "Revoke link" without
it. Automatic revocation is not a separate permission: it happens inside the bill update (which
already needs update) or template management (which needs its template permissions). Bill and template are always read inside the caller's
tenant (another tenant's bill or template is "not found"); an inactive or incompatible template is
refused exactly as for the PDF, and text the PDF cannot print (Tamil, emoji…) is refused **before**
a link is made (422 `INVOICE_UNPRINTABLE_TEXT`). Nothing here writes a bill, a line or a counter.

## Audit

| Action | Entity | Meta |
| --- | --- | --- |
| `invoice_public_link_created` | bill | `linkId, templateId, templateName` |
| `invoice_public_link_revoked` | bill (or the template, once, for a template edit) | `linkId` (or `links: [{ linkId, billId }]`), `reason` |
| `whatsapp_share_opened` | bill | `transport: WHATSAPP_CLICK_TO_CHAT, templateId, templateName` |

Never recorded: the token, its hash, the phone number, the message text. A reused link writes no
entry. "Opened", never "sent".

## Future: official WhatsApp Business API

The pieces stay separate: **invoice generation** (Phase 4 PDF), **public access** (`/i/<token>`),
**message composition** (`composeInvoiceMessage` + `fillInvoiceLink`), **destination**
(`whatsappDestination`), **transport** (today `WHATSAPP_CLICK_TO_CHAT` → `whatsappChatUrl`). An
official provider would be a new transport (`WHATSAPP_BUSINESS_API`) that sends the same message —
the link works unchanged — or uploads the same PDF; only then could delivery/read status exist.
`expires_at` is already in the table if links ever need to expire. Not built: tokens for a
provider, webhooks, message templates, bulk or scheduled sending, open tracking.
