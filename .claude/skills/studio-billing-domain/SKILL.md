---
name: studio-billing-domain
description: The authoritative StudioCRM Billing rules — Book series and atomic bill numbering, Book-driven tax mode (WITH_GST / WITHOUT_GST), default/last-used Book, bill snapshots, the GST/discount calculation authority, receipt and payment protections, edit/delete restrictions, the Appointment lookup and the Next Visit appointment link. Use before changing anything that creates, edits, numbers, prices or reports a bill.
---

# StudioCRM billing domain

The contracts are documents; this is the map. Read the one you touch:
`docs/BILL_NUMBERING.md` (identity), `docs/BILLING_CALCULATION.md` (money),
`docs/RECEIPTS_PAYMENTS.md` (payments), `docs/RECEIVABLES_REPORTS.md` (reports).

## Books are number series

- A **Book** is one independent series: its own `series_starts_at` and `next_bill_number`.
  A bill's identity is `(tenant, book, bill_number)`. Two books can both hold Bill No. 1.
- Numbers come ONLY from `allocateBillNumber` (`services/billNumbers.ts`): one atomic
  `UPDATE … SET next = next + 1 RETURNING`, inside the transaction that inserts the bill. A failed
  save rolls the number back. **Never `SELECT max(...) + 1`, never a client-side or previewed
  number, and opening "New Bill" consumes nothing.** Deleting a bill never rewinds a counter.
- `series_starts_at` is frozen once the counter has moved (the counter moving is the evidence).
- A Book has a **Series Type**: `WITH_GST` / `WITHOUT_GST` (`BOOK_SERIES_TYPES`). It is frozen
  the same way. There may be one book or many, of either type, active at once — never assume two.
- **Active** = selectable for NEW bills. Inactive keeps history and stays reportable.

## Book decides tax mode

- A new bill's `tax_mode` IS its book's series type — the server derives it (`createBill`), and a
  payload whose `taxMode` contradicts the book is refused (422 on `taxMode`).
- An edit keeps the bill's own saved `tax_mode` (historical bills made before Series Type existed
  keep theirs); an edit cannot change book, number or tax mode.
- Series Type adds NO formula: `calculateBill` in `packages/shared/src/billing.ts` is unchanged.

## Default Book for a new bill (`resolveDefaultBook`)

1. exactly one active book → it;
2. several → the explicit setting `defaultBillingBookId` (app settings) if that book is active;
3. else the last-used active book (the book of the tenant's most recently created bill);
4. else a stable fallback (first active book by book number).
A stale default / last-used that is inactive or gone is ignored, never an error.

## Money

- Rate is **GST-exclusive** (confirmed). Order: Gross → bill discount (allocated to lines) → Net
  taxable → GST per line at its snapshot rate → Grand Total. One shared function computes the
  preview and the stored figures; the server's answer is the bill. Never trust a client amount.
- WITHOUT_GST charges 0 GST but lines keep their GST % snapshot.
- `numeric` everywhere; paise integers inside the calculation.

## Snapshots — a bill is history

Customer name / mobile / baby name are the bill's own copy. Each line snapshots item name,
product name, HSN and GST %; an edit keeps a product's existing snapshot. Never recalculate or
re-render an issued bill from current masters. Invoices draw the saved bill (`buildInvoiceModel`).

## Customer mobile

Billing mobile is **exactly 10 digits** (`BILL_MOBILE_DIGITS`, `billMobileSchema`), sanitized in the
form by `sanitizeMobileInput` (digits only, max 10, a pasted `+91`/leading `0` dropped). `mobile_search`
(`normalizeMobile`) is the temporary customer key receipts and reports use — no Customer Master.

## Payments (derived, never stored)

Paid = sum of allocations on ACTIVE receipts (`services/billPayments.ts`, the only definition).
Anything that can move a bill's payment position locks the bill `FOR UPDATE` first. An edit may not
take Grand Total below Paid, nor change the mobile once any receipt touched the bill. A bill with
receipt history is never deleted. Receipts are cancelled, never edited or deleted.

## Appointments

- Billing's mobile lookup (`/api/common/lookups/appointments`) offers candidate bookings; the
  operator picks — the bill's `appointment_id` is traceability only.
- **Next Visit**: a bill's optional `next_visit_date` creates exactly one appointment in the SAME
  transaction as the bill save (`services/nextVisit.ts`), numbered by `allocateDocumentNumber`.
  The link is `appointments.source_bill_id`, unique per tenant — the DB guarantees one per bill.
  Changing the date moves that appointment; clearing it detaches the appointment (kept, never
  deleted); an appointment that has itself been billed is never moved. Deleting the bill detaches it.

## Edit/delete restrictions recap

Book, bill number, tax mode: fixed at creation. Lines replaced as a set under the bill's lock;
public invoice links revoked in the same transaction. Delete: refused with payment history.
