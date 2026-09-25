# WhatsApp invoice sharing

Sharing a SAVED bill's invoice with its customer on WhatsApp — Phase 5. Browser-based: no
WhatsApp API, no credentials, no automation of the operator's WhatsApp.

## What actually happens (and what does not)

WhatsApp's public **click-to-chat** link (`https://wa.me/<number>?text=<message>`) opens a chat
with the number and the message prefilled — in the WhatsApp app on a phone, in WhatsApp Desktop or
Web on a computer. **It cannot attach a file.** So the workflow is honest about it:

1. The Share dialog prepares the invoice PDF — the **same PDF Download gives** (Phase 4 pipeline,
   `GET /api/bills/:id/invoice/pdf`), for the chosen template. Only when it is ready does the
   dialog say "Invoice ready"; if it cannot be made (unsupported characters, server trouble) the
   dialog shows the reason and **Open WhatsApp stays disabled**.
2. **Open WhatsApp** — one click — downloads the PDF (`Invoice-<book>-<bill>.pdf`) and opens the
   chat in a new tab. The button is a real link (`target="_blank" rel="noopener noreferrer"`) and
   the PDF is prepared *before* the click, so nothing asynchronous sits between the click and the
   new tab: popup blockers see a genuine user action. The ERP page stays where it was.
3. The dialog then says: *"Invoice PDF downloaded: Invoice-2026-27-1.pdf. Attach it in WhatsApp
   before sending."* It never says the PDF was attached or the message sent. "Download again" and
   "Open WhatsApp again" are there if the operator needs them.

Nothing marks the bill SENT / DELIVERED / READ: opening a chat proves none of those.

## Where it is

| Place | Action |
| --- | --- |
| Invoice Preview | Print · Download PDF · **WhatsApp** — shares the template shown in the preview |
| Saved bill (`/modules/billing/:id`) | Preview · PDF · **WhatsApp** — disabled while there are unsaved edits (the invoice is the saved bill); absent on a new, unsaved bill |
| Bills list | row menu → **Share on WhatsApp** |

All three open the same `ShareInvoiceDialog` (`apps/web/src/components/invoice/`).

## Destination number — `whatsappDestination` (`packages/shared/src/whatsapp.ts`)

Defaults to the **bill's saved mobile** (the bill's own snapshot, never a master). The operator may
change it for this share; **the bill is never edited**. Normalised to international digits:

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

Please find your invoice {BookNumber}/{BillNumber} for {GrandTotal}.

Thank you,
{CompanyName}
```

A tenant may set its own in **Settings → General → Invoice sharing** (`whatsappInvoiceMessage` in
`app_settings` — no new table, no migration), e.g. in Gujarati. Placeholders are a fixed list —
`{CustomerName} {BookNumber} {BillNumber} {BillDate} {GrandTotal} {CompanyName}` — plain text
substitution, nothing evaluated. An unknown placeholder is refused when saving (400, and inline in
the form). The operator can edit the message freely in the dialog, for that share only.

Values come from what is saved: the bill's customer name and **stored** Grand Total (formatted
exactly as the invoice prints it, `₹65,625.00` — no calculation), `{BillDate}` in the tenant's date
format, `{CompanyName}` from Company Settings. No baby name or other personal detail by default.
The text is UTF-8 percent-encoded (`encodeURIComponent`), so Gujarati, Hindi, ₹, `&`, `+` and line
breaks arrive intact.

## API

| Endpoint | Permission | |
| --- | --- | --- |
| `GET /api/bills/:id/invoice/share` | `operations_billing` read | saved customer/mobile, stored total, file name, composed message |
| `GET /api/bills/:id/invoice/pdf?templateId=` | `operations_billing` read | the Phase 4 PDF, unchanged |
| `POST /api/bills/:id/invoice/share-opened` | `operations_billing` read | audit only |

Same permission as preview/download — sharing is showing the invoice to its customer. Bill, template
and company are all read inside the caller's tenant (another tenant's bill or template is "not
found"); an inactive or incompatible template is refused exactly as for the PDF. Nothing here writes
a bill, a line or a counter.

## Audit

`POST …/share-opened` writes one activity-log entry: action **`whatsapp_share_opened`**, entity the
bill, meta `{ transport: 'WHATSAPP_CLICK_TO_CHAT', templateId, templateName }`. The body is strict:
**no phone number and no message text** are accepted or stored (customer PII, audit noise). It
records that the operator opened WhatsApp — not that anything was sent.

## Security

No WhatsApp secret exists in this phase. The PDF is streamed to the operator's browser as before —
no file is written on the server, no public or permanent URL is created, and the invoice never goes
to WhatsApp's servers except as the file the operator chooses to attach.

## Future: official WhatsApp Business API

The pieces are separate on purpose: **invoice generation** (Phase 4 PDF), **message composition**
(`composeInvoiceMessage`), **destination** (`whatsappDestination`), **transport** (today
`WHATSAPP_CLICK_TO_CHAT` → `whatsappChatUrl`). An official provider would be a new transport
(`WHATSAPP_BUSINESS_API`) that uploads the same PDF and sends through the API — and only then could
delivery/read status exist. Not built: no tokens, webhooks, templates, bulk or scheduled sending.
