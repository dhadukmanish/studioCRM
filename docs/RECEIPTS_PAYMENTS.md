# Receipts, payments and outstanding (Phase 6)

Operational receivables: recording money a customer paid, and which saved bills that money
settles. This is **not** accounting. No journal, ledger, trial balance or GST payable entry is
posted from a receipt — a later accounting phase posts *from* these rows once its account
mappings are decided.

Code: `packages/shared/src/receipts.ts` (schemas, statuses, paise helpers, Cash/Bank rule),
`apps/api/src/services/receipts.ts`, `apps/api/src/services/billPayments.ts` (the one definition
of Paid), `apps/api/src/routes/receipts.ts`, `apps/api/src/db/schema/receipts.ts`, migration
`0017_noisy_colonel_america.sql`, and `apps/web/src/pages/receipts/`.

## The model

```
receipts                         receipt_allocations
  id, tenant_id                    id, tenant_id
  receipt_number   (server)        receipt_id  -> receipts (id, tenant_id)   CASCADE
  receipt_date     (date)          bill_id     -> bills    (id, tenant_id)   RESTRICT
  customer_name    (snapshot)      amount      > 0
  mobile_number    (snapshot)      UNIQUE (receipt_id, bill_id)
  mobile_search    (customer key)
  payment_mode     CASH | BANK
  account_id       -> accounts (id, tenant_id) RESTRICT
  amount           > 0  = SUM(allocations)
  remark
  status           ACTIVE | CANCELLED
  cancelled_at / cancelled_by / cancel_reason
  created_by, created_at, updated_at
```

- **One receipt, many bills.** A receipt of ₹12,000 may put ₹10,000 on Bill 10 and ₹2,000 on Bill 11.
- **One bill, many receipts.** Partial payments add up across receipts.
- **Every foreign key carries the tenant** (`(id, tenant_id)` pairs), so a receipt cannot reference
  another tenant's bill or account even if the service forgot to check.

## Paid, Outstanding and Payment Status — derived, never stored

```
Paid        = SUM(receipt_allocations.amount)  over receipts with status = ACTIVE
Outstanding = bills.grand_total - Paid
Status      = PAID            when Outstanding = 0  (a zero-total bill is PAID)
              UNPAID          when Paid = 0
              PARTIALLY_PAID  otherwise
```

There is no `paid_amount`, `outstanding_amount` or status column on `bills` or anywhere else.
`services/billPayments.ts` holds the only definition: `paidPaiseByBill` for the transactional
checks, and `paidSubquery` + `paymentColumns` for lists — one grouped aggregate LEFT JOINed to
the page query, so the bill list, pending bills and customer totals never run a query per row.
The bill list can filter by Payment Status and sort by Paid / Outstanding like any column.

Money is compared in **whole paise** (`toPaise` / `fromPaise`); the server sums in SQL as
`(sum(amount) * 100)::bigint`. No float decides whether a receipt fits.

## The customer

Bills carry their own customer snapshot; there is no customer master link. The customer key
Billing already uses is the **normalized mobile** (`bills.mobile_search`, `normalizeMobile`). A
receipt belongs to one key, and **every bill it settles must carry that key** — checked by the
server under lock, so customer A's money can never land on customer B's bill. The receipt's
name/mobile snapshot is taken by the server from the customer's latest bill, never from the
payload.

**The normalized mobile is a temporary customer identity**, used because nothing better exists
yet. When a customer master (or a bill → CLIENT account link) is built, receipts should move to
that key; until then two people sharing one number are one customer to Receipts.

Because the key is the mobile, an edit that changes the mobile of a bill with **any receipt
history — active or cancelled —** is refused (the name can still be corrected). Otherwise a
cancelled receipt would name one customer while its allocation points at another customer's
bill. A bill that never had a receipt can change its mobile as before.

## Payment modes and accounts

| Mode | Meaning | Account |
| --- | --- | --- |
| CASH | money received now, in cash | an active account whose Account Group is under the **CASH** head group, or is named CASH |
| BANK | money received into a bank | an active account whose Account Group is **BANK** (the group that drives Bank Details) |
| CREDIT | **no money received** | — not a receipt at all |

The classification is `paymentModeForGroup` in `@erp/shared` — Account Master metadata, never an
account's name. Customer, employee, expense, loan and partner accounts are never payment
accounts. The account list the form shows is filtered by the server, and the create re-validates
whatever account id is sent.

**Credit.** A bill sold on credit simply has no receipt: it stays UNPAID with its full Grand
Total outstanding until money actually arrives. Nothing creates a zero or placeholder receipt,
and `CREDIT` is rejected as a payment mode.

## Creating a receipt

```
BEGIN
  prove the account is the tenant's own, active and classified for the mode
  lock every allocated bill  FOR UPDATE OF bills  ORDER BY id
  read Paid for those bills (after the locks)
  each allocation: bill exists in the tenant, carries the customer key,
                   receipt date >= bill date, amount <= outstanding
  take the receipt number (document_counters, 'receipt')
  insert receipt (amount >= sum of allocations; the rest is advance) and allocations
COMMIT            -- any refusal rolls everything back, the number included
audit receipt_created
```

- The payload's `amount` may not be below the allocations (schema). Anything above them — or the
  whole amount, when nothing is allocated — is the customer's **advance**: see `ADVANCE_PAYMENTS.md`
  (applying, reversing, and why Paid counts only applied advance).
- Zero or negative receipts or allocations, a bill twice in one receipt, and 3-decimal amounts are
  refused by the schema.
- **A receipt cannot be dated before any bill it settles** (money cannot be received for a bill
  before the bill exists). Refused under the lock with the error on `receiptDate` and on the bill;
  the form checks it too. Future dates are not restricted.
- **At most 100 bills per receipt** (`RECEIPT_LIMITS.maxAllocations`). The form never drops bills
  silently: *Pay all in full* fills the oldest 100 and says how many need another receipt, *Auto
  allocate* stops at 100 and says the unplaced amount stays on the receipt as advance, and a save
  with more than 100 rows is refused on screen. The pending list shows at most the oldest 500
  bills and says so when a customer has more.
- The number comes from `allocateDocumentNumber(tx, tenant, 'receipt')`: one sequence per tenant,
  no yearly reset, taken last so a refused receipt burns none. It never touches a Book's
  `next_bill_number` or the appointment counter.

## Concurrency

Every writer that can change a bill's payment position takes the **same row lock** on the bill:

- a receipt locks all its bills, in id order, before reading Paid — two receipts for the same
  bill queue, and the second sees the first's allocation (₹4,000 + ₹4,000 against ₹5,000: one
  commits, one is refused);
- id order means receipts over overlapping bills lock them in the same sequence and cannot
  deadlock, whatever order the operator listed them in;
- `updateBill` locks the bill before checking the new Grand Total against Paid;
- the bill delete locks the bill before checking for allocations.

Cancelling only lowers Paid, so it locks just the receipt.

## Cancelling — never deleting

A receipt is financial history: it is never edited and never deleted. A wrong one is
**cancelled** (`POST /api/receipts/:id/cancel`, optional reason): status becomes CANCELLED, the
row and its allocations stay, and they stop counting towards Paid — the bills' outstanding goes
back up. A second cancel is refused (409 `RECEIPT_ALREADY_CANCELLED`). To correct a receipt:
cancel it and record a new one. Cancellation always asks for confirmation in the UI; no keyboard
shortcut can trigger it.

## Bills with payments

- **Edit:** the new Grand Total may not fall below Paid (₹10,000 bill, ₹7,000 paid: saving ₹6,000
  is refused, ₹7,000 is allowed). The mobile may not change once the bill has any receipt history
  (see "The customer"). Checked inside `updateBill`'s transaction, under the bill lock.
- **Delete:** a bill any receipt ever settled — even one since cancelled — is refused with 409
  `BILL_HAS_PAYMENTS`. `receipt_allocations_bill_tenant_fk` is RESTRICT as the database's own
  last word. Payment history is never cascade-deleted.

## The public invoice link

A receipt never writes a bill row, so it never revokes the bill's public invoice link
(`docs/WHATSAPP_SHARING.md`). The invoice is drawn from the bill's saved snapshot and does not
print Paid / Outstanding, so a payment changes nothing the link shows. A real bill edit still
revokes the link, as before.

## API

| Endpoint | Permission |
| --- | --- |
| `GET /api/receipts` — list (search: receipt no., customer, mobile, account, bill no. / "book/bill") | `operations_receipts` read |
| `GET /api/receipts/:id` — receipt + allocations (each bill's position as of now) | read |
| `GET /api/receipts/customers?search=` / `?key=` — customers with money due / one customer | read |
| `GET /api/receipts/pending-bills?customer=<key>` — outstanding bills, oldest first | read |
| `GET /api/receipts/accounts?mode=CASH\|BANK` — payment accounts for the mode | read |
| `POST /api/receipts` — create | create |
| `POST /api/receipts/:id/cancel` — cancel | **update** |
| `GET /api/bills/:id/payments` — the bill's position + full history (cancelled shown) | `operations_billing` read |

`GET /api/bills` rows also carry `paidAmount`, `outstandingAmount`, `paymentStatus`.

## RBAC

`operations_receipts` — View / Create / Edit, where **Edit means cancel**. There is no delete
action. Roles hold snapshot grants: Super Admin gets it automatically, but **existing Admin /
Manager / User roles must be re-saved in Roles & Permissions** to receive it (a role created
before this phase has no `operations_receipts` key).

## Audit

`receipt_created` and `receipt_cancelled` in `activity_logs`, entity `receipt`, with the receipt
number, amount, mode, the bills it settled (id, book/bill, amount) and the cancel reason. No
mobile number and no bank account number is written. Cancelled is never called "deleted".

## UI

- **Receipts** (Operations): list with search, filters, columns, status; row actions View, Print,
  Cancel.
- **New Receipt** (full page, customer first): pick the customer → their pending bills load
  oldest first → enter amounts (per-bill *Full*, *Pay all in full*, *Clear*, and *Auto allocate*
  a target amount oldest-first, shown before saving) → Cash/Bank + account → Save (Ctrl/Cmd+S).
  The receipt amount is the sum of the rows, never typed twice. At phone width the pending bills
  become stacked rows. With no active cash/bank account for the chosen mode, the Account field
  says so and links to Account Master.
- **Receipt detail**: printable (browser print, A5 copy); cancel with confirmation.
- **Billing**: Outstanding / Payment columns and a Payment Status filter on the list (Paid is one
  click away in Columns — hidden by default with Mobile No., Delivery Date, Tax Mode and Last
  Modified so Outstanding, Payment and Actions fit a 1440px screen; long book numbers and customer
  names are cut with an ellipsis, full text on hover), "Receive payment" row action; on a saved bill a compact payment summary, "Receive payment" (customer and bill
  preselected, other pending bills still allocatable) and the payment history.

## Deliberately not in this phase

Receipt editing, a receipt PDF or WhatsApp share (the
printable page is the receipt; a PDF would reuse the invoice renderer's infrastructure later),
refunds, and every accounting posting (journal, ledger, GST payable, place of supply).
