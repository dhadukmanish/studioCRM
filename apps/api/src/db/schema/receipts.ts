import { pgTable, uuid, text, integer, numeric, date, timestamp, unique, index, check, foreignKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { id, ts, tenantRef, users } from './core';
import { accounts } from './accounts';
import { bills } from './bills';

/**
 * Receipt — money received from a customer, and the bills it settles (docs/RECEIPTS_PAYMENTS.md).
 *
 * Operational receivables, shaped so a later accounting phase can post from it: one row says
 * WHEN, FROM WHOM, HOW (cash or bank, and into which account) and HOW MUCH; the allocations below
 * say which bills that money went to. Nothing here is a journal or a ledger.
 *
 * A bill's Paid is DERIVED — the sum of its allocations on ACTIVE receipts. There is no
 * paid/outstanding column on `bills` or anywhere else, so there is nothing that could drift.
 *
 * A receipt is financial history: it is never edited and never deleted. A wrong one is
 * CANCELLED (`status`), which keeps the row and its allocations for audit and simply stops them
 * counting towards Paid.
 *
 * The customer is the one Billing already knows: bills carry their own customer snapshot, keyed
 * by the normalized mobile (`bills.mobile_search`). A receipt belongs to exactly one such key,
 * and every bill it settles must carry it — proven by the service under lock.
 */
export const receipts = pgTable(
  'receipts',
  {
    id: id(),
    tenantId: tenantRef(),
    /** SYSTEM-ISSUED by `allocateDocumentNumber(tx, tenant, 'receipt')` inside the insert's transaction. */
    receiptNumber: integer('receipt_number').notNull(),
    /** A plain calendar date, like a bill date — it never shifts a day. */
    receiptDate: date('receipt_date', { mode: 'string' }).notNull(),
    /** The customer as their most recent settled bill names them, copied by the server — a receipt is history too. */
    customerName: text('customer_name').notNull(),
    mobileNumber: text('mobile_number').notNull(),
    /** The customer key: the normalized mobile every settled bill carries. */
    mobileSearch: text('mobile_search').notNull(),
    /** CASH | BANK — `PAYMENT_MODES` in `@erp/shared`. Credit is not a receipt. */
    paymentMode: text('payment_mode').notNull(),
    /** The cash or bank account the money went into, proven valid for the mode by the service. */
    accountId: uuid('account_id').notNull(),
    /** Exactly the sum of this receipt's allocations — nothing is ever left unallocated. */
    amount: numeric('amount', { precision: 16, scale: 2 }).notNull(),
    remark: text('remark'),
    /** ACTIVE | CANCELLED. Only ACTIVE receipts count towards a bill's Paid. */
    status: text('status').notNull().default('ACTIVE'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    /** Written from the signed-in user, never from a payload. SET NULL: removing a user never removes money history. */
    cancelledBy: uuid('cancelled_by').references(() => users.id, { onDelete: 'set null' }),
    cancelReason: text('cancel_reason'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...ts,
  },
  (t) => [
    /** The document's identity, and the last guard if two creates ever raced past the allocator. */
    unique('receipts_tenant_number_uk').on(t.tenantId, t.receiptNumber),
    /** The target `receipt_allocations` references (id, tenant_id) through. */
    unique('receipts_id_tenant_uk').on(t.id, t.tenantId),
    /**
     * Tenant-safe account reference. RESTRICT, as `accounts_id_tenant_uk` asks of every financial
     * row: an account money was received into is deactivated, never deleted.
     */
    foreignKey({ columns: [t.accountId, t.tenantId], foreignColumns: [accounts.id, accounts.tenantId], name: 'receipts_account_tenant_fk' }).onDelete('restrict'),
    /** The list's default order and its date filters. */
    index('receipts_tenant_date_idx').on(t.tenantId, t.receiptDate),
    /** A customer's receipts. */
    index('receipts_tenant_mobile_idx').on(t.tenantId, t.mobileSearch),
    check('receipts_receipt_number_positive_check', sql`${t.receiptNumber} >= 1`),
    check('receipts_amount_positive_check', sql`${t.amount} > 0`),
    check('receipts_payment_mode_check', sql`${t.paymentMode} IN ('CASH', 'BANK')`),
    check('receipts_status_check', sql`${t.status} IN ('ACTIVE', 'CANCELLED')`),
    /** Cancelled exactly when it says when — no half-cancelled receipt. */
    check('receipts_cancelled_at_check', sql`(${t.status} = 'CANCELLED') = (${t.cancelledAt} IS NOT NULL)`),
    check('receipts_customer_name_not_blank_check', sql`length(btrim(${t.customerName})) > 0`),
    check('receipts_mobile_search_not_blank_check', sql`length(btrim(${t.mobileSearch})) > 0`),
  ],
);

/**
 * Receipt Allocation — how much of one receipt went to one bill WHEN THE RECEIPT WAS SAVED. A
 * receipt may settle many bills; a bill may be settled by many receipts. Immutable once written.
 * Money put on a bill later, out of the receipt's advance, is an `advance_applications` row.
 */
export const receiptAllocations = pgTable(
  'receipt_allocations',
  {
    id: id(),
    tenantId: tenantRef(),
    receiptId: uuid('receipt_id').notNull(),
    billId: uuid('bill_id').notNull(),
    amount: numeric('amount', { precision: 16, scale: 2 }).notNull(),
    ...ts,
  },
  (t) => [
    /** Part of the receipt. CASCADE only matters to a tenant teardown — no workflow deletes a receipt. */
    foreignKey({ columns: [t.receiptId, t.tenantId], foreignColumns: [receipts.id, receipts.tenantId], name: 'receipt_allocations_receipt_tenant_fk' }).onDelete('cascade'),
    /**
     * RESTRICT, never CASCADE: a bill with payment history cannot be deleted out from under it.
     * The bill delete route refuses first with a clear message; this is the database's last word.
     */
    foreignKey({ columns: [t.billId, t.tenantId], foreignColumns: [bills.id, bills.tenantId], name: 'receipt_allocations_bill_tenant_fk' }).onDelete('restrict'),
    /** One line per bill per receipt. Also serves "this receipt's allocations" by its leading column. */
    unique('receipt_allocations_receipt_bill_uk').on(t.receiptId, t.billId),
    /** A bill's Paid, for the bill list, the pending bills and the overpayment check. */
    index('receipt_allocations_tenant_bill_idx').on(t.tenantId, t.billId),
    check('receipt_allocations_amount_positive_check', sql`${t.amount} > 0`),
  ],
);

/**
 * Advance Application — part of a receipt's ADVANCE applied to one bill after the receipt was saved
 * (docs/ADVANCE_PAYMENTS.md). A receipt's advance is what it received beyond its allocations; it
 * reduces no bill until an explicit Apply writes a row here.
 *
 *   Paid (bill)          = allocations on ACTIVE receipts + ACTIVE applications on ACTIVE receipts
 *   Available (receipt)  = amount - allocations - ACTIVE applications      (derived, never stored)
 *
 * Its own table rather than a late `receipt_allocations` row: an application has its own date (the
 * day it was applied, which is what an As-of report must use), can be applied to the same bill more
 * than once, and can be REVERSED on its own — none of which an allocation does.
 *
 * Never deleted. A mistaken application is REVERSED: the row stays for audit and stops counting,
 * and the money is available again. A receipt with an ACTIVE application cannot be cancelled until
 * that application is reversed (`cancelReceipt`).
 */
export const advanceApplications = pgTable(
  'advance_applications',
  {
    id: id(),
    tenantId: tenantRef(),
    receiptId: uuid('receipt_id').notNull(),
    billId: uuid('bill_id').notNull(),
    amount: numeric('amount', { precision: 16, scale: 2 }).notNull(),
    /** The business date it was applied — what the receivables As-of date compares. */
    appliedOn: date('applied_on', { mode: 'string' }).notNull(),
    /** ACTIVE | REVERSED. Only ACTIVE applications count towards Paid. */
    status: text('status').notNull().default('ACTIVE'),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversedBy: uuid('reversed_by').references(() => users.id, { onDelete: 'set null' }),
    reverseReason: text('reverse_reason'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...ts,
  },
  (t) => [
    /** CASCADE only matters to a tenant teardown — no workflow deletes a receipt. */
    foreignKey({ columns: [t.receiptId, t.tenantId], foreignColumns: [receipts.id, receipts.tenantId], name: 'advance_applications_receipt_tenant_fk' }).onDelete('cascade'),
    /** RESTRICT, like allocations: a bill with payment history cannot be deleted out from under it. */
    foreignKey({ columns: [t.billId, t.tenantId], foreignColumns: [bills.id, bills.tenantId], name: 'advance_applications_bill_tenant_fk' }).onDelete('restrict'),
    /** A bill's Paid. */
    index('advance_applications_tenant_bill_idx').on(t.tenantId, t.billId),
    /** A receipt's available advance. */
    index('advance_applications_tenant_receipt_idx').on(t.tenantId, t.receiptId),
    check('advance_applications_amount_positive_check', sql`${t.amount} > 0`),
    check('advance_applications_status_check', sql`${t.status} IN ('ACTIVE', 'REVERSED')`),
    check('advance_applications_reversed_at_check', sql`(${t.status} = 'REVERSED') = (${t.reversedAt} IS NOT NULL)`),
  ],
);
