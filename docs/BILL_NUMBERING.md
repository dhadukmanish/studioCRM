# Bill numbering — the contract Billing honours

Book Master defines **bill number series**; Billing takes its numbers from them. This document
was written as the contract the Billing phase would inherit, and is now the record of how that
contract is implemented: `bills` and `bill_items` exist, `/api/bills` is live, and
`allocateBillNumber` has exactly one caller — `createBill` in
[`apps/api/src/services/bills.ts`](../apps/api/src/services/bills.ts).

## The rule

A Book is one independent series. Bills under it run `1, 2, 3 … 487`. When the business opens a
new Book, that Book starts its own series again from its own `seriesStartsAt`:

```
Book 2026-27  →  Bill 1, 2, 3 … 487
Book 2027-28  →  Bill 1, 2, 3 …
```

Both Bill No. 1 rows are valid and must stay valid. There is **no tenant-wide bill sequence**.

**A series never resets by calendar.** Not by year, financial year, month or date. The only
thing that starts a new series is a user creating a new Book. Any future code that derives a
bill number from a date is a bug.

## Where the number lives

`books.next_bill_number` — an integer on the book row, initialised from `series_starts_at` when
the book is created, and moved only by `allocateBillNumber` in
[`apps/api/src/services/billNumbers.ts`](../apps/api/src/services/billNumbers.ts).

It was put on the book rather than in a separate counters table because a book *is* the series:
a second table would add a row, a foreign key and a join to hold one integer that has exactly
one owner.

The counter is system-managed:

- `bookSchema` has no `nextBillNumber` field, and zod strips unknown keys — no request body can
  set it, through the master form or otherwise.
- The book route's `toRow` is the only code outside the allocator that writes it.
- There is no "reset bill number" endpoint and no permission for one, deliberately.
- `CHECK (next_bill_number >= series_starts_at)` is the database's own backstop.

## Allocating a number

```ts
const billNumber = await allocateBillNumber(tx, req.user.tenantId, bookId);
```

The rules, and where each one is enforced today:

1. **It is called inside the transaction that inserts the bill.** `createBill` opens one
   `db.transaction`, validates the book, the optional appointment and every line, allocates,
   inserts the header and inserts the lines. A failure anywhere rolls the number back with it,
   so a rejected save does not burn a number.
2. **It is never called to preview a number.** Opening the billing screen allocates nothing;
   the form shows `Auto on Save` until the bill is saved. Every call consumes one.
3. **No number is computed any other way.** `SELECT max(bill_no) + 1` is not a numbering
   mechanism — two operators reading the same maximum get the same number — and it appears
   nowhere in the repository.
4. **Nothing allocates in React.** The number is the server's to decide, and the client cannot
   even name it: `billSchema` has no `billNumber` field.

It is concurrency-safe because it is a single `UPDATE … RETURNING`: Postgres locks the book row
for the statement, so simultaneous callers queue and receive distinct, gapless numbers. Verified
against the live API — 25 parallel creates on one book returned 1 … 25 with no gaps and no
duplicates, while a second book stayed on its own series.

**An inactive book cannot be billed into.** That is a workflow decision, so it is enforced in
`resolveBook` (the service) rather than inside the allocator, which owns only the counter. An
existing bill whose book was deactivated afterwards still loads and still saves — its book is
not re-checked on edit.

## The bills table, as built

```
bills
  id, tenant_id
  book_id          NOT NULL
  bill_number      NOT NULL          -- from allocateBillNumber, never from the client
  appointment_id   NULL              -- optional booking, traceability only
  bill_date, delivery_date
  customer_name, mobile_number, mobile_search, baby_name
  has_birth_date, birth_date
  remark, tax_mode
  sub_total, gst_amount, grand_total -- derived server-side from the lines
  created_at, updated_at

  UNIQUE (tenant_id, book_id, bill_number)
  FOREIGN KEY (book_id, tenant_id)        REFERENCES books (id, tenant_id)        ON DELETE RESTRICT
  FOREIGN KEY (appointment_id, tenant_id) REFERENCES appointments (id, tenant_id) ON DELETE RESTRICT
```

`books_id_tenant_uk` and `appointments_id_tenant_uk` are the targets of those composite foreign
keys — they make a cross-tenant reference structurally impossible rather than merely checked
for, the same way `sub_items` references `items`.

`ON DELETE RESTRICT` is what finally protects a used book from deletion; Book Master's delete
now counts the bills under a book and explains itself instead of letting the database raise an
opaque error. A book that has issued numbers is set **Inactive**, which keeps it and all of its
history and only closes it to new bills.

## Identity is immutable

- **The bill number cannot be edited.** `billSchema` has no such field.
- **The book cannot be changed after creation.** `billUpdateSchema` does not have `bookId` at
  all, so a payload carrying one loses it in validation. Moving a bill to another book would
  move it into another number series and make it a different document.
- **An update never allocates.** It rewrites the header and replaces the lines inside one
  transaction; `books.next_bill_number` is not touched.

## Deleting a bill does not rewind the counter

If Bill No. 25 is deleted, the next bill is **26**. The number 25 is spent: it may already have
been printed, handed to a customer or filed, and handing a second document the same identity
would be worse than a gap. Nothing anywhere lowers `books.next_bill_number` — there is no code
path, no endpoint and no permission for it.

Deleting a bill removes its lines with it (`bill_items` is `ON DELETE CASCADE` from `bills`).
Delete is permission-gated (`operations_billing` / delete) and confirmed in the UI. No
accounting entry exists to reverse yet, which is the only reason deletion is allowed at all;
when Payment and Ledger arrive, that decision needs revisiting.

## Series start, once bills exist

`seriesStartsAt` is editable while a book has issued nothing — that window is for correcting a
typo, and it moves the counter with it. Once a number has been handed out, the counter has moved
past the start and the API refuses to change it.

That lock keys off the counter having moved, and the counter moves only through
`allocateBillNumber`. No bill-existence check is invented anywhere.

## Appointment → Bill

**Their numbering is not this numbering.** An Appointment No. is a tenant-level sequence taken
from `document_counters` through `allocateDocumentNumber` (`services/documentNumbers.ts`). A
bill number comes from its Book. The two never meet: Appointment #1 and Bill No. 1 are
unrelated, and creating an appointment never moves `books.next_bill_number`. Both allocators
follow the same rule — one atomic statement, inside the document's own transaction, never
`SELECT max(...) + 1`.

**Finding the customer.** `GET /api/common/lookups/appointments?mobile=...` matches a
normalized mobile key and returns the matching appointments, most recent first. It returns
CANDIDATES: one mobile number legitimately has many bookings, so Billing shows the operator the
list and lets them pick — it never assumes the first row, even when there is only one.

**The bill keeps its own snapshot.** A bill carries `appointment_id` plus its own
`customer_name`, `mobile_number` and `baby_name`. Prefilling the form from an appointment is a
convenience; the values the operator confirms are what the bill stores. Editing or renaming the
appointment afterwards does not touch a bill that was already issued, and clearing the link on
a bill does not clear the customer values that were typed.

A bill needs no appointment at all — a walk-in customer is billed with `appointment_id` NULL.

## What a line stores, and why

Every `bill_items` row snapshots the master values it was built from: `item_name_snapshot`,
`sub_item_name_snapshot`, `hsn_code_snapshot` and `gst_rate_snapshot`, plus the `rate` and
`remark` that were actually billed. An invoice is a historical document — when Item Master's GST
moves from 12% to 18%, or a product is renamed or repriced, every bill already issued must still
read exactly as it was issued. **Nothing renders a bill by joining the live masters.**
`item_id` and `sub_item_id` are there for traceability and future reporting, not as the source
of the printed values.

The server resolves those snapshots itself, from the masters, inside the transaction. A client
that sends `hsnCodeSnapshot` or `gstRateSnapshot` loses them in validation — they are not fields
of `billItemSchema`.

An **edit keeps the snapshots a line already had**: re-saving a bill after Item Master changed
must not silently reprice history. Only a product that is new to that bill takes a fresh
snapshot, and only a new product has to be active — an existing line may go on referring to a
master row that has since been retired.

`line_number` is 1, 2, 3 … in the order the operator entered, `UNIQUE (bill_id, line_number)`,
and the invoice prints in that order. Nothing orders lines by `created_at` or by id.

## Calculation policy (Phase 1)

One implementation, in [`packages/shared/src/billing.ts`](../packages/shared/src/billing.ts),
used by both apps: the browser previews with it, the server recalculates with it and stores the
result. A total sent by a client is never trusted.

```
taxable    = round2(qty × rate)
gst        = round2(taxable × gstRate / 100)     -- WITH_GST
gst        = 0                                   -- WITHOUT_GST
line total = taxable + gst
sub total / gst / grand total = the sums of the already-rounded lines
```

- **The rate is treated as tax-EXCLUSIVE.** This is an assumption, and it is written here on
  purpose. The legacy billing screens supplied with the requirement are scanned images with no
  text layer and could not be read in this environment, and nothing else in the repository
  establishes whether the studio's rate was ever entered tax-inclusive. If the business says
  inclusive, `lineAmounts` is the one function that changes — and bills already issued would
  have to be recalculated.
- Rounding is half-up, per line, to 2 decimals, on integer arithmetic (paise), so the printed
  lines always add up to the printed total and no float error can reach a stored amount.
- **WITHOUT_GST charges no tax but keeps each line's GST snapshot.** The snapshot records the
  Item Master configuration the line was built from; it is not a claim that tax was charged.
  Nothing about the tax mode edits Item Master.
- GST is **not** operator-editable: it comes from Item Master, per the requirement that GST is
  applied per item. A manual override would need its own decision and its own audit rule.
- The **rate** is operator-editable. Sub Item Master supplies the default; the bill stores what
  was saved.
- CGST/SGST/IGST splitting, rate-wise GST summaries, discount, advance, payment, outstanding and
  any accounting posting are **not** implemented and must not be inferred from these fields.
