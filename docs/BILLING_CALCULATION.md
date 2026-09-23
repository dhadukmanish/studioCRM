# Billing calculation — the money contract

What a bill's figures mean, in what order they are worked out, and which of them a client may
send. This is the companion to `docs/BILL_NUMBERING.md`, which owns the bill's identity; this
document owns its arithmetic.

One module implements all of it: **`packages/shared/src/billing.ts`**. The browser calls it to
preview a bill while the operator types and the API calls it inside the create/update
transaction to decide what is stored. If the two ever disagreed, the server's answer is the
bill.

## The rate is GST-exclusive — CONFIRMED

`Qty x Rate` is the taxable value; GST is added **on top** of it.

```
Rate 1,000  Qty 1  GST 18%   ->  taxable 1,000   GST 180   line total 1,180
Rate   500  Qty 2  GST 12%   ->  taxable 1,000   GST 120   line total 1,120
```

This was an open assumption in Phase 1 (the legacy billing screens are scanned images with no
text layer and could not settle it). **The studio has since confirmed it.** It is a business
rule now, not a guess to be revisited — and nothing should be written as though it might flip.

## Calculation order

```
Gross Taxable  ->  Discount  ->  Net Taxable  ->  GST  ->  Grand Total
```

The bill-level discount reduces the taxable base **before** tax. The alternative — taxing the
undiscounted lines and subtracting the discount at the bottom — is wrong here for a concrete
reason: a bill may mix 5%, 12% and 18% lines, and a discount applied after tax cannot be
attributed to any of them, so the rate-wise GST summary would not add up to the GST charged.

The named figures, and what each one means:

| Figure | Meaning |
| --- | --- |
| **Sub Total** | Sum of `Qty x Rate` across the lines. Before discount, before GST. Stored as `bills.sub_total`. |
| **Discount** | The bill-level concession in money. Stored as `bills.discount_amount`; the sum of the lines' allocated shares, exactly. |
| **Taxable Amount** | `Sub Total - Discount`, and equally the sum of the lines' `taxable_amount`. Derived by the API as `netTaxable`, not stored — two stored columns already determine it. |
| **GST** | Tax charged, per line, on the line's NET taxable value. 0 throughout a WITHOUT_GST bill. |
| **Grand Total** | `Taxable Amount + GST`. |

## The discount

Stored as the pair the operator actually chose, never as one overloaded number:

| Column | Meaning |
| --- | --- |
| `bills.discount_type` | `NONE` / `AMOUNT` / `PERCENT` |
| `bills.discount_value` | What was typed — rupees for AMOUNT, a percentage for PERCENT, 0 for NONE |
| `bills.discount_amount` | What it came to in money. **Server-calculated**, never sent by a client |
| `bill_items.discount_allocated` | That line's share of it. Allocated, never typed |

Validation (`billSchema`, and therefore identical on create and update):

- `NONE` — the value is normalised to 0, the way an unticked birthdate drops its date.
- `PERCENT` — `0 … 100`. **101% is refused with a field error, not clamped to 100.**
- `AMOUNT` — `0 … the bill's sub total`. An amount above the sub total is refused, not shrunk.
  On a bill whose lines are all worth nothing, any amount above 0 is therefore refused.
- Both — at most 2 decimals, like every other money field in the module.

The rule lives once, in `billDiscountError` (`packages/shared/src/schemas/bills.ts`). The zod
refinement and the billing screen's live warning are both that function.

There is **no per-line discount field**, by requirement. A line's allocated share exists for the
arithmetic and for a future invoice, not for the operator to edit.

## The allocation algorithm

Largest remainder (Hamilton), in integer paise, in `allocateDiscount`:

1. `share_i = discount x gross_i / subTotal`, computed in `bigint` — at the schemas' ceilings
   `discount x gross` is far past 2^53, and the point of this function is exactness.
2. Each line is allocated `floor(share_i)`.
3. The paise the floors dropped are handed out one each to the lines with the largest dropped
   fraction. Ties go to the larger line, then to the earlier one — so the result is data, not
   a side effect of iteration order.
4. A line worth nothing (rate 0) never takes a remainder paisa.

Two guarantees, both pinned by tests:

- **`sum(allocated) === discount_amount`, exactly.** A ₹100 discount over three ₹100 lines is
  33.34 + 33.33 + 33.33, never 99.99.
- **No line is allocated more than it is worth**, so no net taxable value can go negative. When
  the discount is below the sub total every positive line's floor is strictly below its gross,
  so the +1 always fits; when they are equal there is no remainder to hand out.

A 100% discount is allowed: net taxable 0, GST 0, grand total 0. Nothing divides by zero, and
nothing goes negative.

## Rounding

Half-up, to 2 decimals, per LINE — and the bill's totals are the sums of the already-rounded
lines, so the printed lines always add up to the printed total. Every intermediate step is
integer arithmetic (paise, hundredths of a percent). The products that can leave a JS number's
exact range at the ceilings in `schemas/bills.ts` are done in `bigint`.

## WITH_GST and WITHOUT_GST

Same taxable side, different tax:

| | WITH_GST | WITHOUT_GST |
| --- | --- | --- |
| Net taxable | gross − allocated discount | gross − allocated discount |
| GST charged | net x snapshot rate | **0** |
| Line total | net + GST | net |
| Grand Total | Taxable + GST | Taxable |

Switching the mode changes **only** the tax charged. It never touches quantity, rate, item,
product or the GST snapshot, and it never edits Item Master. `1,000 @ 18%` is 1,180 WITH_GST and
1,000 WITHOUT_GST, before any discount.

Every line keeps its `gst_rate_snapshot` in both modes — it records the Item Master
configuration the line was built from, not a tax that was charged. A future non-GST invoice
template must not present those rates as payable tax.

## The rate-wise GST summary

`gstSummary` groups the lines by `gst_rate_snapshot` and adds each group up. It is **derived
from the lines' own calculated amounts**, never recalculated from quantities and rates — a
summary that could disagree with the lines above it would be worse than none.

- The taxable figure in the summary is the **net** one, after the allocated discount.
- A 0% group is kept: its taxable value is part of the bill whether or not a template prints
  the row.
- Groups are sorted by rate, so the summary reads the same on every bill.
- The API returns it on `GET /api/bills/:id`; it is not stored.

For a WITHOUT_GST bill every group's GST is 0. The billing screen hides the table in that mode
rather than showing a column of zeroes that could read as a tax claim.

## Snapshot rules on an edit

A bill is history. What follows is the whole rule, and it is deliberate in every branch:

| The operator… | The line's snapshot |
| --- | --- |
| re-saves the bill unchanged | **kept** — re-saving is an edit of the document, not a repricing of it |
| changes only the Rate | **kept**. The new rate is charged at the original GST snapshot |
| changes the Item/Product identity | **refreshed** from the master as it stands today — it is a different commercial line |
| adds a line for a product NOT already on the bill | takes the master as it stands today |
| adds a second line for a product the bill ALREADY carries | takes the rate **this bill already used** for that product |

The last row is the one trade-off, and it is chosen on purpose: keyed by product rather than by
line, one invoice can never print two different GST rates for the same product, which is the
outcome that would actually be wrong on paper. It is written down in `resolveLines`
(`apps/api/src/services/bills.ts`).

So an edited bill can legitimately read `old line @ 12%` beside `new line @ 18%` when Item
Master moved between the two additions. That is preferable to silently rewriting history.

## What a client may send

Identifiers and typed values only:

- `discountType`, `discountValue`, `taxMode`, `quantity`, `rate`, `remark`, the header fields.

Never, and the fields do not exist in the schemas, so zod strips them before any route code
runs:

- `discountAmount`, `netTaxable`, any line's `discountAllocated`, `grossTaxable`,
  `taxableAmount`, `gstAmount`, `lineTotal`
- any snapshot (`itemNameSnapshot`, `hsnCodeSnapshot`, `gstRateSnapshot`, …)
- `subTotal`, `gstAmount`, `grandTotal`, `billNumber`

## Invoice readiness

A saved bill holds everything a renderer needs, so a future template is presentation only and
recalculates no business logic from Master data: the line snapshots, each line's gross, its
allocated discount, its net taxable, its GST rate and GST, its total, the rate-wise summary
(derivable from the lines, and returned by the API), the discount and the final totals.

## Deliberately NOT implemented

CGST/SGST/IGST — the split needs a supplier state, a place of supply and an intra/inter-state
rule, none of which this repository establishes. Guessing at it would put wrong numbers on a
statutory document. The summary is `Rate / Taxable / GST` until those rules are confirmed.

Also not implemented: payment, advance, outstanding, any accounting posting, ledger, journal,
delivery workflow, Invoice Template Master, PDF, WhatsApp, reports and a Customer Master.
