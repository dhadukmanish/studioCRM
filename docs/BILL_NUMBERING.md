# Bill numbering — the contract Billing must honour

Book Master exists to define **bill number series**. This document is the contract the Billing
phase inherits. Nothing here is implemented as billing yet: there is no `bills` table, no
billing UI, and `allocateBillNumber` has no callers.

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
- The route's `toRow` is the only code outside the allocator that writes it.
- There is no "reset bill number" endpoint and no permission for one, deliberately.
- `CHECK (next_bill_number >= series_starts_at)` is the database's own backstop.

## Allocating a number

```ts
const billNumber = await allocateBillNumber(tx, req.user.tenantId, bookId);
```

Rules for the Billing phase:

1. **Call it inside the transaction that inserts the bill.** A failed bill must roll the number
   back with it.
2. **Never call it to preview a number.** Every call consumes one. Opening the billing screen
   must not allocate.
3. **Never compute a number any other way.** `SELECT max(bill_no) + 1` is not a numbering
   mechanism — two operators reading the same maximum get the same number.
4. **Never allocate in React.** The number is the server's to decide.

It is concurrency-safe because it is a single `UPDATE … RETURNING`: Postgres locks the book row
for the statement, so simultaneous callers queue and receive distinct, gapless numbers.

Whether an *inactive* book may still be billed into is deliberately not decided inside the
allocator — that is a workflow question needing its own message. The lookup
(`GET /api/common/lookups/books`) already offers active books only.

## What the `bills` table will need

```
bills
  id
  tenant_id
  book_id          NOT NULL
  bill_number      NOT NULL          -- from allocateBillNumber, never from the client
  appointment_id   NULL              -- see below
  ...

  UNIQUE (tenant_id, book_id, bill_number)
  FOREIGN KEY (book_id, tenant_id) REFERENCES books (id, tenant_id) ON DELETE RESTRICT
```

`books_id_tenant_uk` already exists for that composite foreign key — it makes a cross-tenant
book reference structurally impossible rather than merely checked for, the same way `sub_items`
references `items`.

`ON DELETE RESTRICT` is what finally protects a used book from deletion. Until `bills` exists,
Book Master allows delete like any other master; a book that has issued numbers should be set
**Inactive**, which keeps it and all of its history and only closes it to new bills.

## Series start, once bills exist

`seriesStartsAt` is editable while a book has issued nothing — that window is for correcting a
typo, and it moves the counter with it. Once a number has been handed out, the counter has moved
past the start and the API refuses to change it.

That lock is already live and needs no change when Billing arrives: it keys off the counter
having moved, and the counter moves only through `allocateBillNumber`. No bill-existence check
is invented anywhere.

## Appointment → Bill (the appointment half now exists)

Appointments are built (`/api/appointments`). Two things about them matter to Billing:

**Their numbering is not this numbering.** An Appointment No. is a tenant-level sequence taken
from `document_counters` through `allocateDocumentNumber` (`services/documentNumbers.ts`). A
bill number comes from its Book. The two never meet: Appointment #1 and Bill No. 1 are
unrelated, and creating an appointment must never move `books.next_bill_number`. Both
allocators follow the same rule — one atomic statement, inside the document's own transaction,
never `SELECT max(...) + 1`.

**Finding the customer.** `GET /api/common/lookups/appointments?mobile=...` matches a
normalized mobile key and returns the matching appointments, most recent first. It returns
CANDIDATES: one mobile number legitimately has many bookings, so Billing shows the operator
the list and lets them pick — it must not assume the first row.

A bill may then carry `appointment_id` (tenant-safe composite FK to `appointments_id_tenant_uk`)
**plus its own snapshot** of the customer name, mobile and baby name. The snapshot is the
point: an invoice is a historical document, so editing an appointment afterwards must never
rewrite a bill that was already issued. Prefilling the form from an appointment is a
convenience; the values the operator confirms are what the bill stores.
