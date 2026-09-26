# Studio Workflow

What happens to a job after its bill is saved, and how staff move it along without managing statuses.
Code: `packages/shared/src/workflow.ts`, `apps/api/src/services/work.ts`, `routes/work.ts`.

## The job

A job is its **bill**. Every saved bill goes through four stages:

| Stage | Means | One action |
| --- | --- | --- |
| Selection | the customer chose their photos | **Done** |
| Editing | PHOTO editing is finished (never "the bill was edited") | **Done** |
| WhatsApp | WhatsApp was **opened** from the workflow to message the customer | **Share** |
| Delivery | the work was handed over | **Delivered** |

## Rules

1. **Nobody picks a status.** A stage is either recorded (Done, or Skipped) or it is not. The
   **current stage** — the next thing to do — is derived: the stage **after the furthest one
   recorded** (Selection when nothing is). Staff record what really happened, in any order: marking
   Editing done moves the job on to WhatsApp without anyone faking a Selection, which simply stays
   unrecorded. Nothing stores a "status" that could drift from the milestones.
2. **Delivery closes the job.** Once Delivery is recorded (done or skipped) the job is *Completed*,
   whatever happened before it.
3. **Order guides, it does not block.** Any stage may be recorded out of order. A stage the studio did
   not need is **Skipped** (••• menu) — never faked as done.
4. **One click, idempotent.** Recording a stage stores who and when (the business date in the
   company's time zone). Clicking again changes nothing. A mistaken click is corrected with **Mark
   pending** (reopen) — on the bill's Studio Status, or *Mark … pending* in ••• on Today's Work. Every record, skip and undo is in the activity log.
5. **WhatsApp says only what the app knows.** The WhatsApp stage is marked done only when the share
   dialog, opened from the workflow's *Share on WhatsApp*, actually opens WhatsApp. It reads
   "WhatsApp opened" — never sent, delivered, read or seen. By hand it can only be skipped. A plain
   invoice share (the WhatsApp button on the bill toolbar) does not move the job.
6. **Planned vs delivered.** The bill's *Delivery Date* is the **planned** date the studio promised.
   Recording Delivery stores the **delivered** date separately. Only a planned date can make a job
   due today or overdue; a job with none is simply pending.
7. **Delivered is not paid.** Payment stays the receipts' derived position. A delivered job can be
   Unpaid, Partially paid or Paid; nothing in the workflow touches money.

## Appointments

- An appointment is **Pending** until someone presses **Done** (one click, no form). Done stores the
  time and the user; it is history, never deletion — the appointment stays under *Done* and *All* and
  in search. *Mark as pending* corrects a mistaken Done.
- Views: **Pending** (default — every open appointment, oldest first so a missed one stays at the
  top), **Today**, **Upcoming**, **Done** (latest first), **All**.
- A bill's **Next Visit Date** creates an ordinary pending appointment (`BILL_NUMBERING.md`); there is
  one appointment workflow, not two.
- Billing an appointment does **not** mark it Done automatically (a booking may be billed ahead of the
  visit); staff press Done.

## Where staff work

**Today's Work** (Operations, `/modules/work`, API `GET /api/work/queue`) is the screen staff keep open
all day. It answers one question — *what do I need to do now?* — and never asks anyone to manage a
status. Each row: **customer** (bill / appointment no. and mobile underneath, quiet), the **one current
step**, **when**, **payment in plain words**, and **one button**:

| Current step | Button | After it |
| --- | --- | --- |
| Appointment (with its time) | Done | leaves Today (history under Completed / Appointments) |
| Selection | Done | the row turns into Editing |
| Editing | Done | the row turns into WhatsApp |
| WhatsApp | Share | the existing share dialog; opening WhatsApp there turns the row into Delivery |
| Delivery | Delivered | leaves Today — money still due never blocks it |

The row changes in place from the server's answer (no reload, no Save). Everything uncommon is in
**•••**: Receive payment, Apply ₹X advance, Open bill, Set / Change delivery date (opens the bill),
Skip the current step, Mark the last recorded step pending (a delivery asks first), Mark as pending (appointment).

- **Views** (no filter panel, one search box — name, mobile, bill no., appointment no.):
  **Today** (default) = urgency buckets 1 overdue (missed appointment, promised delivery date passed),
  2 today's appointments by time, 3 deliveries promised today, 4 jobs under way (a step recorded) and
  jobs billed today. **Pending** = everything unfinished, same order, incl. jobs neither started nor
  dated. **Upcoming** = appointments and promised deliveries after today. **Completed** = latest first.
  A search on Today looks through everything unfinished (the page says so). Rules: `workQueue` in
  `services/work.ts`. On the test DB (2,376 bills) Today holds ~25 rows; Pending 2,270.
- **Nothing to do** → "You're all caught up for today." with *View upcoming work*, never an empty grid.
  Below a non-empty Today: "N more pending, not due today · View pending".
- **Payment on the row**: `₹X Due`, `Paid`, `₹Y Advance` (the customer's advance not yet applied —
  derived like every figure, `availableAdvanceByCustomer`) — never allocation vocabulary. The server
  also returns `advanceToApply` = min(advance, due), what *Apply* in ••• spends in one explicit click.
- **Phone (390px)**: rows stack into small cards — name, "Selection · Due today", "₹5,000 Due", and a
  full-width 44px button with ••• beside it. **Desktop**: a dense five-column list, not cards.
- **Bill list**: ONE *Next Work* column (Selection / Editing / WhatsApp / Delivery / Done), no inline
  action — the list stays a list.
- **Saved bill → Studio Status** (beside GST Details from 1400px, below it on narrower screens, never
  squeezing the totals): four thin chips — `✓ Selection — ● Editing — ○ WhatsApp — ○ Delivery` — with
  "Next: Editing" and "Planned delivery … · Delivered …" (two dates, never one). It is where an
  authorised operator records or corrects the ACTUAL progress, on the same rows Today's Work uses:
  a not-done chip is one click to done (any step, any order; no dialog, no Save); the recommended one
  is highlighted; WhatsApp opens the real share dialog; a done chip opens who/when and **Mark
  pending** (Delivery asks first); ••• skips the recommended step. No checkboxes. Without Studio Work
  edit the chips are read-only text; with unsaved bill edits they wait for Save.
- **Reports → Delivery** and **Reports → Appointments** stay for history, search, CSV and print; daily
  work never needs them.

## Receive payment — the everyday version

*Receive payment* on a bill, a Today's Work row, the bill list or an appointment opens a small dialog
(`ReceivePaymentDialog`) instead of the full Receipts form: customer and bill are known, so it asks
Amount · Cash/Bank · Account (picked when there is only one) · Date, with a note behind "Add a note".

- From a bill: the amount defaults to **Due**; up to Due goes on the bill, anything beyond is said
  plainly — "₹X more than due — kept as Advance" — and a partial payment says what "will still be due".
- With no bill (an appointment): the dialog is labelled **Advance** and the whole amount is advance.
- The button reads **Receive ₹X**; nothing is saved until it is pressed. It posts the same
  `POST /api/receipts` as the full form, so every rule (locks, never above Due, numbering, audit) is the
  server's. The full Receipts form (many bills at once) is unchanged under Operations → Receipts.
- On the bill the payment strip reads **Total · Paid · Due · Advance available ₹Y** with **Apply ₹Z**
  (one click, Z = min(advance, due) from the server) and *Change amount* as the secondary option.

## Clicks for the common actions

| Action | Clicks |
| --- | --- |
| Appointment done | 1 (Today's Work, Appointments, report) |
| Selection / Editing done | 1 (Today's Work, bill) |
| Delivered | 1 (Today's Work, bill, Delivery report) |
| WhatsApp | Share → Create link (first share only) → Open WhatsApp → then Send in WhatsApp |
| Apply the suggested advance | 1 (bill, or ••• on Today's Work) |
| Receive the Due from a bill | 2 (Receive payment → Receive ₹X; account preselected when there is one) |

## Permissions

| Permission | Allows |
| --- | --- |
| Studio Work — View (`operations_work` read) | Today's Work, a bill's progress, Delivery report (print, CSV). Money on them (Due, Paid, Advance, Grand Total, Outstanding, payment status) only with Billing or Receipts view as well |
| Studio Work — Edit (`operations_work` update) | complete, skip or undo a stage (incl. recording WhatsApp opened) |
| Appointments — Edit | mark an appointment Done / pending |

Seeing a queue never grants changing it. Existing roles must be re-saved in Settings → Roles to pick up
the new permission (Super Admin needs nothing).
