# Advance Payments

Money a customer pays that is not (yet) against a bill. Extends `RECEIPTS_PAYMENTS.md`; code:
`services/receipts.ts` (`createReceipt`, `applyAdvance`, `reverseApplication`, `cancelReceipt`),
`services/billPayments.ts` (the Paid definition), table `advance_applications`.

## One concept for staff: Receive Payment

- The customer has bills → put the money against them (as before). Anything received **beyond** what
  is put on bills is kept as **advance**.
- The customer has **no bill yet** → type their 10-digit mobile (or open *Receive payment* from an
  appointment, which fills the mobile and name) and record the amount: the whole receipt is advance.
  No fake bill is ever created.

## Advance entered with a new bill

The new-bill form has an **Advance** box under Grand Total for money handed over while the bill is
being made. It is input only — never a bill column:

- Blank = none (no receipt, no payment field asked). An amount reveals **Received via Cash / Bank**
  and **Account** (the only one preselected); **Due** = Grand Total less what goes on the bill.
- On save the server makes an ordinary **receipt** in the bill's own create transaction
  (`createBill` → `createReceiptIn`): dated the bill date, numbered from `document_counters`,
  account-checked, audited (`receipt_created` / `advance_received`), allocated to the new bill up to
  its Grand Total — anything beyond stays the customer's advance. **Grand Total never changes**; Paid
  goes up and Due down, exactly as for any receipt.
- A refused account / amount rolls the whole bill back — no bill, no receipt, no number burned.
  It needs **Receipts Create** as well as Billing Create (403 otherwise; the box is hidden).
- **No duplicates:** each new-bill form sends a `requestId`; it is stored on the bill
  (`bills.create_request_id`, unique per tenant, migration `0021`) and checked after the book row
  lock, so a retry, double click or racing submit returns the bill already made.
- **Only a new bill.** `billUpdateSchema` has no advance: re-saving or editing a bill never creates,
  changes or removes money. After saving, the bill shows **Paid / Due** in its totals; more money is
  *Receive payment*, a wrong receipt is cancelled on the Receipts screen.
- Money received **earlier** (before the bill) is shown separately on the form — "₹X advance received
  earlier — apply it after saving" — and on the saved bill as **Advance available ₹X [Apply ₹X]**.
  It is never consumed without that click.

## The model

```
Receipt amount (received) = allocated when saved + applied later + available
Paid (bill)               = allocations on ACTIVE receipts + ACTIVE applications on ACTIVE receipts
Outstanding (bill)        = Grand Total − Paid
Available advance         = derived from the above, never stored or edited
```

- **Advance reduces no bill until it is applied.** A ₹5,000 advance and a ₹20,000 bill read
  Paid ₹0 · Outstanding ₹20,000 · Available Advance ₹5,000 until someone applies it.
- **Apply is always an explicit action.** The bill shows *Available Advance* and one button,
  **Apply ₹X**, where X = min(available advance, outstanding). *Edit amount* applies less. Nothing is
  ever applied automatically.
- Apply spends the customer's **oldest** advance first (receipt date, then number). Each application
  stores the date it was applied — what the receivables *As of* date compares — never before the bill
  or the receipt.
- A receipt is still never edited or deleted.

## Safety

- **No double spending.** Apply locks the bill, then the customer's active receipts (id order), and
  reads outstanding and available only after both locks. Two simultaneous applies of the same ₹5,000:
  one succeeds, the other is refused. Lock order is always bill → receipts, so it cannot deadlock with
  receipt creation, bill edits or cancellation.
- **Reversal, not deletion.** A wrong application is **Reversed** from the bill's payment history
  (Receipts — Edit): the row stays, marked reversed, stops counting, and the money is available again.
- **Cancelling money that has been applied is refused.** A receipt whose advance is applied to a bill
  cannot be cancelled until those applications are reversed — so a bill is never silently re-opened.
  A receipt with unapplied advance only can be cancelled normally; its advance then disappears.
- A bill with any payment history — allocation or applied advance, even reversed — is never deleted,
  and cannot be edited below what it has been paid.

## Where it shows

| Screen | Shows |
| --- | --- |
| Receive Payment | Received · Against bills · Kept as advance · Advance already available |
| Receipt detail / print | Received · Applied to bills · Available advance; advance applied later, per bill |
| Receipts list | an *Advance* column (still available) |
| Saved bill → Payments | Available Advance, **Apply ₹X**, history rows "Advance applied" with *Reverse* |

## Reports

Receivables (Summary, Outstanding Bills, Aging, drill-down) read the same Paid definition, so they
reconcile to the paisa. Unapplied advance is not a receivable reduction; an application counts from
its applied date for *As of*.

## Permissions

Receive payment and Apply advance: Receipts — Create. Reverse an application and cancel a receipt:
Receipts — Edit.
