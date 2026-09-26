# Bill Summary Report

Reports → **Bill Summary** (`/modules/reports/bills`, API `/api/reports/bills/*`). The legacy "Bill
Summary Report" — the bills of a period with **Sub Total, Discount, Advance / Received, Grand Total** — as ONE
screen with two tabs over ONE scope. Read-only, derived, stored nowhere.
Code: `packages/shared/src/billReport.ts`, `apps/api/src/services/billReport.ts`, `routes/billReport.ts`,
`apps/web/src/pages/reports/BillReportPage.tsx`, `BillReportFilters.tsx`.

## The scope (both tabs)

| Filter | Where | Meaning |
| --- | --- | --- |
| Bill date From – To | filter bar | The bill date. With neither end set: the **current month up to today** in the company's time zone — the server says which range it used and the inputs show it. |
| Customer | filter bar | A customer = the normalized mobile (the temporary identity until a Customer Master exists). Searched by name or mobile. |
| Book · Series (With / Without GST) · Bill No. · Payment (Unpaid / Partially paid / Paid) | **More filters** (Apply / Clear) | Bill fields only — no workflow stages; those belong to the operational reports. |
| Search | the table's one search box | Customer, mobile, baby name, book / bill no., item or product. It selects **bills** (a product match brings the whole bill), so both tabs keep the same bills. `%` and `_` are literal. |

The scope lives in the URL (`from`, `to`, `customer`, `book`, `series`, `billNo`, `payment`, `q` = search,
`tab`) and any change to it starts again at page 1:
switching tabs never resets it, Back restores it, a filtered view can be bookmarked. **Clear all**
returns to the current month. The table's sort (bill-level columns) is shared by both tabs too.

## Summary (default) — one row per bill

Book No. · Bill No. · Customer Name · Mobile · Bill Date · Sub Total · Discount · GST · Grand Total ·
Advance / Received; Baby Name, Planned Delivery, Series and Payment are in **Columns** (hidden by default so the
money fits a 1440 screen). The totals row under the table — and the print's — is the **whole filtered
set**, never the page. The **primary totals** are the legacy four — Sub Total, Discount, Advance /
Received, Grand Total (the totals strip and the print header show exactly these); GST is a table column
whose total sits muted under it, not a primary total.

GST is shown although the legacy screen had none: without it Sub Total − Discount ≠ Grand Total on a
With GST bill. **Entry By is intentionally deferred**: bills store no creator, and the audit log is
fire-and-forget (`logActivity` never throws), so it is not inferred from incomplete audit history. It
needs an authoritative `bills.created_by` column — a migration, deliberately not made in this phase.

## Detailed — one row per bill item

Book No. · Bill No. · Customer · Item / Product · Qty · Amount · Discount · GST · Line Total · Advance / Received;
Bill Date, Mobile, Baby Name, Rate (= Amount at Qty 1, the studio's usual), GST % and Taxable are in
**Columns** (so the money fits a 1440 screen); Print and CSV carry Item and Product separately, with
Rate and GST %. A bill's lines sit together in line
order; its identity shows on its first line, with a rule above each new bill. Sorting is by bill
columns only, so a sort never splits a bill.

- **Amount** = Qty × Rate (the line's share of Sub Total). **Discount** = the line's stored
  `discount_allocated` — the allocation the bill was saved with, never re-allocated here.
  **Taxable** = Amount − Discount. **Line Total** = Taxable + GST.
- **Advance / Received** belongs to the bill, not a line: it is on the bill's **first line only**, blank
  on the others, so the column adds up. The CSV does the same ("Advance / Received (bill, on its first line)").

## Advance / Received — the definition

The legacy report called it Advance; it is labelled **Advance / Received** (screen, print, preview, CSV)
because it includes payments made after the bill too. On screen, one note under the table says:
"Advance / Received includes payments received or applied against the bill. Unapplied customer advance
is excluded."

**Advance / Received = money received against the bill so far**: allocations of ACTIVE receipts + ACTIVE advance
applications on ACTIVE receipts — the one derived Paid (`services/billPayments.ts`), as of now.

- A receipt that settled several bills counts once per bill, for exactly what it put on that bill.
- A customer's advance **not applied** to the bill is in no bill's Advance / Received (it is still the customer's).
- A cancelled receipt and a reversed application count nowhere.
- Grand Total is the saved bill's; Advance / Received never reduces it (Due = Grand Total − Advance / Received).

## Reconciliation

For the same scope, to the paisa:

    Summary Sub Total   = Σ Detailed Amount       Summary GST         = Σ Detailed GST
    Summary Discount    = Σ Detailed Discount     Summary Grand Total = Σ Detailed Line Total
    Summary Advance / Received = Σ Detailed Advance / Received (first lines)

Summary sums the bills' stored totals; Detailed sums the stored lines. They agree because the billing
contract makes a bill's totals the sums of its rounded lines (docs/BILLING_CALCULATION.md). Paid joins
as ONE grouped row per bill, so receipts can never multiply a bill's lines.

## Print · Preview · CSV

- **Preview** shows the exact sheet **Print** prints (`ReportSheet`), at A4-landscape width, with Print
  on it. Company name and logo, "Bill Summary Report" / "Bill Detailed Report", the scope in words,
  the rows, the totals, the print time. No app shell on paper.
- **CSV** (both tabs) is the whole filtered result in the screen's sort: UTF-8 with BOM, ISO dates,
  plain 2-decimal numbers, formula-injection guarded (`lib/csv.ts`). Summary = a row per bill,
  Detailed = a row per line.
- Print, Preview and CSV carry at most 20,000 rows (the receivables ceiling); past it the server refuses
  with a message rather than cutting silently.

## Permissions

| Permission | Allows |
| --- | --- |
| Bill Summary Report — View (`reports_bills` read) | the report, Preview, Print, CSV |

Billing Edit is not needed. Opening a bill from a row needs Billing view (without it the bill number
is plain text). Existing roles must be re-saved in Settings → Roles to pick up the new permission
(Super Admin needs nothing).

## Responsive

1440: both tabs' default columns fit without scrolling. 1280: the page never scrolls sideways; each
table scrolls ~150px inside its own box (or fits with the sidebar collapsed); extra columns chosen in
Columns scroll inside the box too. 390: rows become cards (bill, customer, Grand Total, Sub / Disc / GST / Adv), totals as
a strip, filters stack.
