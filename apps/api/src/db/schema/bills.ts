import { pgTable, uuid, text, integer, numeric, boolean, date, unique, index, check, foreignKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { id, ts, tenantRef } from './core';
import { books } from './books';
import { appointments } from './appointments';
import { items } from './items';
import { subItems } from './subItems';

/**
 * Bill — the studio's invoice document. A header with its own customer snapshot, plus the
 * lines it bills, which live in `bill_items` below.
 *
 * Identity is (tenant, book, bill number), never a tenant-wide sequence: a Book IS the number
 * series, so book "2026-27" and book "2027-28" can each hold a Bill No. 1. The number comes
 * from `allocateBillNumber` inside the transaction that inserts this row — see
 * `docs/BILL_NUMBERING.md`, which this table finally implements.
 *
 * A bill is HISTORY. Everything it needs in order to be re-read or reprinted years later is
 * stored on it: the customer's name, mobile and baby name are this row's own snapshot, and
 * each line snapshots the item name, product name, HSN code and GST rate it was built from.
 * Editing an Appointment or an Item Master row afterwards must never rewrite an issued bill.
 *
 * What this module deliberately does NOT model: payment (it lives in `receipts`, and Paid /
 * Outstanding are derived from its allocations — never stored here), advance, any accounting
 * posting, a delivery or approval workflow, a draft/cancelled status, and the statutory
 * CGST/SGST/IGST split — which needs a place of supply and an intra/inter-state rule that
 * nothing here establishes. Each is a real later decision, not an oversight.
 *
 * Audited through `activity_logs`, like every other module.
 */
export const bills = pgTable(
  'bills',
  {
    id: id(),
    tenantId: tenantRef(),
    /** The series this bill was numbered under. Fixed at creation — see `bills_book_tenant_fk`. */
    bookId: uuid('book_id').notNull(),
    /**
     * SYSTEM-ISSUED by `allocateBillNumber`, which moves `books.next_bill_number` in the same
     * statement. Never user-supplied: `billSchema` has no such field, and `billUpdateSchema`
     * cannot even name the book, so no edit can renumber a bill.
     */
    billNumber: integer('bill_number').notNull(),
    /**
     * The booking this bill came from, when there was one. NULL for a walk-in customer.
     * Traceability only — nothing renders a bill from the appointment's current values.
     */
    appointmentId: uuid('appointment_id'),
    /** A plain calendar date — no time, no timezone, so a bill never shifts a day. */
    billDate: date('bill_date', { mode: 'string' }).notNull(),
    /** When the work was promised. Optional: no delivery workflow exists in this phase. */
    deliveryDate: date('delivery_date', { mode: 'string' }),
    /** The bill's OWN copy of the customer, not a view of `appointments`. */
    customerName: text('customer_name').notNull(),
    /** Exactly as the operator typed it — display value, never rewritten. */
    mobileNumber: text('mobile_number').notNull(),
    /**
     * Server-derived search key for the same number (`normalizeMobile` in `@erp/shared`), so
     * "+91 98765 43210" and "98765-43210" find each other. Never accepted from a client.
     * The identical rule Appointment uses — one normalization, not two.
     */
    mobileSearch: text('mobile_search').notNull(),
    babyName: text('baby_name'),
    /** The legacy form's Birthdate checkbox. Unticked, `birthDate` is NULL — see the check. */
    hasBirthDate: boolean('has_birth_date').notNull().default(false),
    birthDate: date('birth_date', { mode: 'string' }),
    remark: text('remark'),
    /**
     * The customer's next visit, as the operator chose it. The appointment it creates points back
     * here through `appointments.source_bill_id` (one per bill, enforced there) — see
     * `services/nextVisit.ts`. NULL = no next visit planned.
     */
    nextVisitDate: date('next_visit_date', { mode: 'string' }),
    /**
     * The new-bill form's one-time request id (`billSchema.requestId`). A retried or double-submitted
     * create carrying the same id finds this bill instead of making a second bill, number or advance
     * receipt. NULL for bills created without one (older clients, tests). Never shown, never edited.
     */
    createRequestId: uuid('create_request_id'),
    /**
     * SHA-256 of that create request's content. A replay with the same id but DIFFERENT content (the
     * operator changed the form after a lost response) is refused with 409 instead of silently
     * returning the first bill as if it were the new one.
     */
    createRequestHash: text('create_request_hash'),
    /** WITH_GST | WITHOUT_GST — how this bill charges tax. See `INVOICE_TAX_MODES`. */
    taxMode: text('tax_mode').notNull().default('WITH_GST'),
    /**
     * The bill-level discount as the OPERATOR entered it: NONE | AMOUNT | PERCENT, plus the
     * number they typed (rupees, or a percentage). Stored as the pair rather than as one
     * ambiguous figure, so an invoice printed years from now still says WHY the concession
     * was what it was. There is deliberately no per-line discount column — a line's share of
     * this is allocated by the calculation, never typed.
     */
    discountType: text('discount_type').notNull().default('NONE'),
    discountValue: numeric('discount_value', { precision: 16, scale: 2 }).notNull().default('0'),
    /**
     * What the discount came to in money, worked out by the server. Exactly the sum of the
     * lines' `discount_allocated`, to the paisa — that is the property the allocation
     * algorithm exists to guarantee.
     */
    discountAmount: numeric('discount_amount', { precision: 16, scale: 2 }).notNull().default('0'),
    /**
     * Totals DERIVED from this bill's lines inside the same transaction that writes them, so
     * the list and later reports need no per-row aggregate. Never accepted from a client:
     * the server recomputes them from the validated lines through the shared calculation.
     *
     * `sub_total` is the GROSS taxable value — the sum of Qty x Rate across the lines, BEFORE
     * the discount and before GST. The net taxable value GST is actually charged on is
     * `sub_total - discount_amount`; it is not a fourth column, because it is exactly
     * determined by two that are already here and a stored copy could only ever drift from
     * them. `gst_amount` is the tax charged (0 throughout a WITHOUT_GST bill) and
     * `grand_total` is net taxable + GST.
     */
    subTotal: numeric('sub_total', { precision: 16, scale: 2 }).notNull().default('0'),
    gstAmount: numeric('gst_amount', { precision: 16, scale: 2 }).notNull().default('0'),
    grandTotal: numeric('grand_total', { precision: 16, scale: 2 }).notNull().default('0'),
    ...ts,
  },
  (t) => [
    /**
     * The document's identity, and the last guard if two creates ever raced past the
     * allocator. Scoped to the book, which is what lets two books each hold a Bill No. 1.
     */
    unique('bills_tenant_book_number_uk').on(t.tenantId, t.bookId, t.billNumber),
    /** The target `bill_items` needs to reference (bill_id, tenant_id) together. */
    unique('bills_id_tenant_uk').on(t.id, t.tenantId),
    /** One bill per create request — the idempotency backstop. NULLs are distinct, so bills without one are unaffected. */
    unique('bills_tenant_create_request_uk').on(t.tenantId, t.createRequestId),
    /**
     * The book reference carries the tenant, so a bill can only ever be numbered under a book
     * of its own tenant — cross-tenant is structurally impossible, not merely checked for.
     * RESTRICT is what finally protects a used book: a book that has issued bills is set
     * Inactive, never deleted out from under them.
     */
    foreignKey({ columns: [t.bookId, t.tenantId], foreignColumns: [books.id, books.tenantId], name: 'bills_book_tenant_fk' }).onDelete('restrict'),
    /**
     * Same tenant-safe shape for the optional booking. NULL passes (MATCH SIMPLE), so a
     * walk-in bill needs no appointment. RESTRICT, never CASCADE: deleting a booking must
     * never delete the invoice that was raised from it.
     */
    foreignKey({ columns: [t.appointmentId, t.tenantId], foreignColumns: [appointments.id, appointments.tenantId], name: 'bills_appointment_tenant_fk' }).onDelete('restrict'),
    /** The list's default "most recent first" ordering and its date filters. */
    index('bills_tenant_date_idx').on(t.tenantId, t.billDate),
    /** Finding a customer's bills by any shape of their mobile number. */
    index('bills_tenant_mobile_idx').on(t.tenantId, t.mobileSearch),
    /** The list's "Last Modified" sort. */
    index('bills_tenant_updated_idx').on(t.tenantId, t.updatedAt),
    /** The new-bill form's "last used book" (`resolveDefaultBook`): the tenant's most recently created bill. */
    index('bills_tenant_created_idx').on(t.tenantId, t.createdAt),
    check('bills_bill_number_positive_check', sql`${t.billNumber} >= 1`),
    check('bills_customer_name_not_blank_check', sql`length(btrim(${t.customerName})) > 0`),
    check('bills_mobile_number_not_blank_check', sql`length(btrim(${t.mobileNumber})) > 0`),
    check('bills_tax_mode_check', sql`${t.taxMode} IN ('WITH_GST', 'WITHOUT_GST')`),
    /**
     * No stale birth date behind an unticked checkbox. One-directional on purpose: the form
     * requires the date when the box is ticked, but the DATABASE only guarantees the thing
     * that would otherwise be unreadable — a date nobody asked for.
     */
    check('bills_birth_date_check', sql`${t.hasBirthDate} OR ${t.birthDate} IS NULL`),
    check('bills_sub_total_non_negative_check', sql`${t.subTotal} >= 0`),
    check('bills_gst_amount_non_negative_check', sql`${t.gstAmount} >= 0`),
    check('bills_grand_total_non_negative_check', sql`${t.grandTotal} >= 0`),
    check('bills_discount_type_check', sql`${t.discountType} IN ('NONE', 'AMOUNT', 'PERCENT')`),
    check('bills_discount_value_non_negative_check', sql`${t.discountValue} >= 0`),
    check('bills_discount_amount_non_negative_check', sql`${t.discountAmount} >= 0`),
    /** NONE is a statement that there is no discount, so neither number may say otherwise. */
    check('bills_discount_none_check', sql`${t.discountType} <> 'NONE' OR (${t.discountValue} = 0 AND ${t.discountAmount} = 0)`),
    check('bills_discount_percent_check', sql`${t.discountType} <> 'PERCENT' OR ${t.discountValue} <= 100`),
    /** A discount can at most take a bill to zero — never past it into a negative taxable value. */
    check('bills_discount_within_sub_total_check', sql`${t.discountAmount} <= ${t.subTotal}`),
  ],
);

/**
 * Bill Item — one printed line of a bill, and a SNAPSHOT of the masters it was built from.
 *
 * The snapshot columns are the point of this table. An invoice is a historical document: when
 * Item Master's GST moves from 12% to 18% next month, or a product is renamed, or a rate
 * changes, every bill already issued must still read exactly as it was issued. Nothing
 * renders a bill by joining the live masters — `item_id` and `sub_item_id` exist for
 * traceability and for reporting, not as the source of the printed values.
 *
 * The line's amounts are calculated server-side from `quantity`, `rate` and `gst_rate` by the
 * shared calculation in `@erp/shared`, inside the bill's own transaction.
 */
export const billItems = pgTable(
  'bill_items',
  {
    id: id(),
    tenantId: tenantRef(),
    billId: uuid('bill_id').notNull(),
    /** 1, 2, 3 … in the order the operator entered them. The invoice prints in this order. */
    lineNumber: integer('line_number').notNull(),
    /** Traceability to the masters — never the source of what this line prints. */
    itemId: uuid('item_id').notNull(),
    subItemId: uuid('sub_item_id').notNull(),
    itemNameSnapshot: text('item_name_snapshot').notNull(),
    subItemNameSnapshot: text('sub_item_name_snapshot').notNull(),
    /** Needed by a future GST invoice/PDF, so printing never has to join Item Master. */
    hsnCodeSnapshot: text('hsn_code_snapshot').notNull(),
    /** The Item Master GST % as it stood when this line was created. Kept in both tax modes. */
    gstRateSnapshot: numeric('gst_rate_snapshot', { precision: 5, scale: 2 }).notNull(),
    /** Units billed — fixed scale, never a float. */
    quantity: numeric('quantity', { precision: 12, scale: 2 }).notNull(),
    /** The rate this bill charged. Defaulted from Sub Item Master; owned by the line from then on. */
    rate: numeric('rate', { precision: 12, scale: 2 }).notNull(),
    /**
     * This line's share of the BILL's discount, allocated in proportion to its gross taxable
     * value — never a figure the operator typed on the line, and never accepted from a
     * client. 0 on every bill that has no discount, which is why this column could be added
     * to Phase 1 bills without touching a single one of their rows.
     */
    discountAllocated: numeric('discount_allocated', { precision: 16, scale: 2 }).notNull().default('0'),
    /**
     * The NET taxable value: quantity x rate MINUS `discount_allocated`. This is the base GST
     * was actually charged on, which is the figure a reprint or a GST return has to be able
     * to reproduce. The gross value is `taxable_amount + discount_allocated` — exact, so it
     * is not stored a second time.
     *
     * Scaled to 16 digits like the bill's own totals: at the very top of the range the
     * schemas accept, quantity x rate plus 28% GST needs 13 integer digits, and a
     * numeric(14, 2) would reject it at INSERT as a 500 instead of a field-level message.
     */
    taxableAmount: numeric('taxable_amount', { precision: 16, scale: 2 }).notNull(),
    /** Tax charged on this line — always 0 on a WITHOUT_GST bill, whatever the snapshot says. */
    gstAmount: numeric('gst_amount', { precision: 16, scale: 2 }).notNull(),
    lineTotal: numeric('line_total', { precision: 16, scale: 2 }).notNull(),
    /** The line's own note, defaulted from the Sub Item's remark when it was added. */
    remark: text('remark'),
    ...ts,
  },
  (t) => [
    /**
     * Lines are PART of the bill, not rows that outlive it: deleting a bill deletes its
     * lines, which is the one CASCADE in this module. The composite key carries the tenant,
     * so a line can never attach to another tenant's bill.
     */
    foreignKey({ columns: [t.billId, t.tenantId], foreignColumns: [bills.id, bills.tenantId], name: 'bill_items_bill_tenant_fk' }).onDelete('cascade'),
    /**
     * RESTRICT, like everything with history: an Item or Sub Item that has been billed is
     * deactivated, never deleted out from under the bills that reference it. The snapshot
     * would survive the deletion, but the traceability would not.
     */
    foreignKey({ columns: [t.itemId, t.tenantId], foreignColumns: [items.id, items.tenantId], name: 'bill_items_item_tenant_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.subItemId, t.tenantId], foreignColumns: [subItems.id, subItems.tenantId], name: 'bill_items_sub_item_tenant_fk' }).onDelete('restrict'),
    /** Deterministic print order, and the guard against two lines claiming the same position. */
    unique('bill_items_bill_line_uk').on(t.billId, t.lineNumber),
    /** Loading one bill's lines, and future item-wise reporting within a tenant. */
    index('bill_items_tenant_bill_idx').on(t.tenantId, t.billId),
    check('bill_items_line_number_positive_check', sql`${t.lineNumber} >= 1`),
    check('bill_items_quantity_positive_check', sql`${t.quantity} > 0`),
    check('bill_items_rate_non_negative_check', sql`${t.rate} >= 0`),
    check('bill_items_gst_rate_range_check', sql`${t.gstRateSnapshot} >= 0 AND ${t.gstRateSnapshot} <= 100`),
    check('bill_items_taxable_amount_non_negative_check', sql`${t.taxableAmount} >= 0`),
    check('bill_items_discount_allocated_non_negative_check', sql`${t.discountAllocated} >= 0`),
    check('bill_items_gst_amount_non_negative_check', sql`${t.gstAmount} >= 0`),
    check('bill_items_line_total_non_negative_check', sql`${t.lineTotal} >= 0`),
    check('bill_items_item_name_not_blank_check', sql`length(btrim(${t.itemNameSnapshot})) > 0`),
    check('bill_items_sub_item_name_not_blank_check', sql`length(btrim(${t.subItemNameSnapshot})) > 0`),
  ],
);
