# Receivables / Outstanding reports (Phase 7)

Operational receivables reporting over Billing + Receipts: how much is owed, by whom, on which
bills, and how old it is. **Read-only and derived.** No table, column or cache stores a Paid,
Outstanding, aging or customer-balance figure; every number is computed by Postgres from bills,
receipts and receipt allocations when the report is asked for. This is **not** accounting: no
journal, ledger, trial balance, P&L, balance sheet or GST posting exists or is implied.

Code: `packages/shared/src/receivables.ts` (buckets, scope/filters schema, response types),
`apps/api/src/services/receivables.ts` (every query), `apps/api/src/routes/receivables.ts`,
`apps/api/src/lib/csv.ts`, `apps/web/src/pages/reports/`, `apps/web/src/lib/receivables.ts`.

## Source of truth

Phase 6's definition, unchanged and in one place (`services/billPayments.ts`):

```
Paid        = SUM(receipt_allocations.amount) over receipts with status = ACTIVE
Outstanding = bills.grand_total - Paid
Status      = PAID when Outstanding = 0 (a zero-total bill is PAID) · UNPAID when Paid = 0 · else PARTIALLY_PAID
```

The reports use `paidSubquery(tenantId, asOf)` + `paymentColumns` — the same aggregate the bill
list and the receipt form use, narrowed by receipt date (below). `services/receivables.ts` builds
ONE bill-level model on it (Paid, Outstanding, Status, age, bucket), and the KPI strip, Summary,
Outstanding Bills, Aging and the customer drill-down all aggregate that model. No view has a
formula of its own, so they cannot drift apart.

**Paid is always a sum of allocations, never of receipt amounts.** A ₹12,000 receipt that put
₹10,000 on Bill A and ₹2,000 on Bill B adds ₹10,000 to A and ₹2,000 to B — ₹12,000 once. The
customer drill-down shows each receipt once, with its full amount and, separately, what it
allocated to this customer's bills in scope.

Money is summed in `numeric` by Postgres (exact) and becomes a JS number only in the response.

## Customer identity (temporary)

A customer is the **normalized mobile** (`bills.mobile_search`), exactly as in Phase 6. Name is
display only: two spellings on one mobile are one customer (shown under the name on their latest
bill in scope); one name on two mobiles is two customers. Tenants never mix — every query is
tenant-scoped, so the same mobile in two tenants is two unrelated customers.

This is a **temporary identity** until a Customer / Party Master exists. Moving receipts and
reports to a real customer id (and merging customers, handling a changed number) is future work.

## The scope every view shares

| Parameter | Meaning |
| --- | --- |
| `asOf` | Bills dated on or before it; receipts dated on or before it. Default: **today in the default company's time zone** (Company → Time Zone, `Asia/Kolkata` if none) — decided by the server, never the browser. |
| `from` / `to` | The **bill date** range. Never applied to receipt dates. |
| `bookId` | One Book (inactive books included in the picker — a closed book is still reportable). |

The KPI strip and all three tabs take the same scope, and the web keeps it in the URL, so a
filtered view survives a drill-down and Back, and can be bookmarked. Per-view filters (search,
status, bucket, "include settled") narrow only that view's table and its totals row.

## As of — what it can and cannot reconstruct

With As of = D the report counts:

- bills with `bill_date <= D` (a later-dated bill is out of scope — ages are never negative);
- allocations of **currently ACTIVE** receipts with `receipt_date <= D` (a receipt dated after D
  does not reduce the balance before its date).

What it does **not** reconstruct, deliberately:

- **Cancellation is treated as void from the start.** A receipt dated 10 Sep and cancelled on
  20 Sep counts nowhere — not even for As of 15 Sep. `cancelled_at` is a system timestamp, not a
  business date, and Phase 6's rule is "a wrong receipt is cancelled and re-entered"; treating the
  cancellation as dated would mix the two. So an As-of report is "the position on D *as recorded
  today*", not a snapshot of what the screen said on D.
- **Bill edits are not versioned.** A bill's current Grand Total is used for every As of.
- A receipt entered later but dated on or before D changes a re-run of the D report.

In short: Paid and Outstanding are derived from the bill and receipt data **as currently
recorded**; the receipt date is respected for the As-of cutoff; a currently cancelled receipt
contributes ₹0 even for an As of before its cancellation; bill edits are not historically
versioned. A past As of is therefore an operational "as recorded today" reconstruction — **not a
frozen historical accounting snapshot**. For a frozen statement, print or export the report on the day.

## The views

**KPI strip** (`GET /api/reports/receivables/overview`) — for every bill in scope, paid ones
included: Billed (sum of Grand Totals), Received (Paid), Outstanding, customers with something
outstanding, pending bills (Outstanding > 0). "Billed" is the billed value of the bills in scope,
not lifetime sales unless the scope is everything.

**Summary** (`GET …/customers`) — customer-wise: Customer, Mobile, Total Billed, Paid,
Outstanding, Pending Bills, Max Age (age of the oldest bill with something outstanding — not a due date).
Customers are **aggregated first** over all their in-scope bills, then filtered, sorted and paginated
server-side — a page of bills is never grouped in the browser. Default: customers with Outstanding
> 0; "Include settled customers" shows everyone. A search selects customers (any of their bills
matching a name spelling, mobile, bill or book number) and still totals all of their in-scope bills.

**Outstanding Bills** (`GET …/bills`) — bill-wise: Bill (Book/No.), Bill Date, Customer, Grand
Total, Outstanding, Payment, Age; Mobile and Paid are one click away in Columns (hidden by default
so the row fits a 1280px screen; Paid is in the totals row and = Grand Total − Outstanding). CSV
and print always carry every column. Default status is Outstanding (Unpaid + Partially paid);
Unpaid, Partially paid, Paid or All on request. Filter by aging bucket. Default order is oldest
first. Actions: View bill, Customer details, Receive payment.

**Aging** — the five buckets for the scope (the KPI strip's own figures, never narrowed by the
table's search; their sum is Total Outstanding) and a customer-wise aging table. Selecting a
bucket lists that bucket's bills through the same Outstanding Bills query (`bucket=`), not a
second one.

Every totals row says what it totals ("Totals of the 6 customers listed"): the Summary's Billed
covers the customers listed, the KPI strip's Billed every bill in scope — both are correct, and
their Outstanding is the same.

**Customer drill-down** (`GET …/customers/:key`, route `/modules/reports/receivables/customers/:key`)
— the customer's Summary row as a header, their bills in scope (outstanding by default, paid on
request), and their payment history: each receipt once, with Receipt Amount and Allocated Here,
cancelled ones shown as Cancelled and counting ₹0. The footer shows the active allocations — equal
to Paid.

## Aging

- **Anchor: the bill date.** Bills have no due date, and none is invented; the UI says "Age from
  bill date" and never calls it a due date. Delivery Date is not a due date either.
- **Age** = `As of − bill date` in whole calendar days, computed by Postgres on `date` values —
  no time zone can move a bill into another bucket.
- **Buckets**: 0 → Current · 1–30 · 31–60 · 61–90 · 91+ → 90+ (`AGING_BUCKET_MAX_DAYS`,
  mirrored by the SQL `case`).
- A partly paid bill ages only its remaining Outstanding (₹10,000 bill, ₹7,000 paid, 45 days old
  → ₹3,000 in 31–60). Paid bills contribute nothing.

## Reconciliation

For the same scope, to the paisa (tested):

```
KPI Outstanding = Summary total = Outstanding Bills total = Current + 1–30 + 31–60 + 61–90 + 90+
KPI Billed − KPI Received = KPI Outstanding
```

Every totals row covers the **whole filtered result**, never just the page on screen.

## Filters, search, sorting, pagination

All server-side. Search terms: customer name, mobile, bill number, book number (the Bills list's
own `billSearch`, shared). Sorting: Summary by Customer, Mobile, Total Billed, Paid, Outstanding,
Pending Bills, Max Age and each aging column; Outstanding Bills by every visible column. Each
sort has a stable tie-breaker (customer key / bill identity), so pages never overlap.

## CSV

`GET …/export?report=customers|bills|aging` plus the view's scope, search, filters and sort —
the **whole filtered result**, not the page. Built on the server (`lib/csv.ts`):

- UTF-8 with a BOM (Excel shows Gujarati / Hindi correctly), CRLF rows, RFC 4180 quoting;
- dates as ISO `YYYY-MM-DD` (unambiguous in every spreadsheet locale); money as plain 2-decimal
  numbers without ₹, so the spreadsheet can add them up;
- **formula injection**: user text starting with `=`, `+`, `-`, `@`, tab or CR (after spaces) is
  prefixed with `'`. Server-formatted numbers are written as numbers and never altered. A mobile
  typed with a leading `+` ("+91 98765 43210") is user text, so it too is exported as
  `'+91 98765 43210` — deliberate: the guard never guesses which user text is harmless;
- no action columns.

At most 20,000 rows per export or print (`RECEIVABLES_EXPORT_MAX_ROWS`); past that the request is
refused with a message to narrow the filters — never silently cut. Exports are not audited (there
is no export-audit convention in the app), and viewing reports writes nothing.

## Print

Browser print of a `.print-root` sheet (like the receipt): company name and logo from the company
profile, report title, the scope and filters, print time, headline totals, the **whole** filtered
table and a totals row. A4 portrait for the Summary, landscape for Outstanding Bills and Aging. The
phone card layout never prints. No PDF engine.

## RBAC

`reports_receivables` — **View** only (module "Reports"); View also covers print and CSV. Report
View never grants anything else: Receive payment still needs Receipts **Create** (hidden without it,
and `POST /api/receipts` refuses), opening a bill needs Billing View, opening a receipt Receipts
View. Super Admin gets it automatically; **existing Admin / Manager / User roles are permission
snapshots and must be re-saved in Roles & Permissions to receive it.**

## Tenant isolation and performance

Every query filters `bills.tenant_id`; the Paid subquery filters `receipt_allocations.tenant_id`
inside; every join carries the tenant pair. Another tenant's book id or mobile returns nothing.

One request = a handful of set-based queries (totals + page), never a query per customer or bill.
Existing indexes serve them: `bills_tenant_date_idx`, `bills_tenant_mobile_idx`,
`bills_tenant_book_number_uk` (book filter), `receipt_allocations_tenant_bill_idx`. Phase 7 adds
**no migration**. Measured on 2,248 bills / 330 customers / 468 allocations: every report request 9–23 ms (details in `.claude/HANDOFF.md`).

## Deliberately not here

Customer Master / party ledger / customer merge, GL and every accounting posting, reminders
(WhatsApp/SMS), collection schedules, interest or late fees, receipt PDF, a due date.
