import { pgTable, text, integer, boolean, unique, uniqueIndex, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { id, ts, tenantRef } from './core';

/**
 * Book Master — one row is one independent BILL NUMBER SERIES ("2026-27", "2027-28").
 *
 * Bills under a book run 1, 2, 3 ... 487; a new book starts again from its own
 * `seriesStartsAt`. Nothing here is driven by the calendar: a series ends because the business
 * opened a new book, never because a year or month turned over.
 *
 * `nextBillNumber` is the SYSTEM-MANAGED counter. It is initialised from `seriesStartsAt` when
 * the book is created and afterwards moves only through `allocateBillNumber`
 * (`services/billNumbers.ts`), inside the transaction that writes the bill. It is not part of
 * `bookSchema`, so no request body can set it.
 *
 * Audited through `activity_logs`, like the other masters.
 */
export const books = pgTable(
  'books',
  {
    id: id(),
    tenantId: tenantRef(),
    bookNumber: text('book_number').notNull(),
    /** The first number this book hands out — user-configured, and frozen once one is issued. */
    seriesStartsAt: integer('series_starts_at').notNull().default(1),
    /** The number the NEXT bill will take. Never edited through the master form. */
    nextBillNumber: integer('next_bill_number').notNull().default(1),
    /**
     * WITH_GST | WITHOUT_GST — the tax mode every NEW bill in this series takes (`createBill`
     * derives it; a contradicting payload is refused). Frozen once the counter has moved, like
     * `seriesStartsAt`. Existing books were backfilled by migration 0019 (docs/BILL_NUMBERING.md).
     */
    seriesType: text('series_type').notNull().default('WITH_GST'),
    /** Active means selectable for NEW bills. Inactive keeps the book and all of its history. */
    isActive: boolean('is_active').notNull().default(true),
    ...ts,
  },
  (t) => [
    // Business key: one book number per tenant, case-insensitive. Also the final guard against
    // two concurrent create requests racing past the application-level check.
    uniqueIndex('books_tenant_number_lower_idx').on(t.tenantId, sql`lower(${t.bookNumber})`),
    // List screen: tenant predicate + default "recently updated first" sort.
    index('books_tenant_updated_idx').on(t.tenantId, t.updatedAt),
    /**
     * Redundant on its own (id is already the primary key), but it is the target the future
     * `bills` table needs in order to reference (book_id, tenant_id) together — the same
     * composite key `sub_items` uses to make a cross-tenant parent structurally impossible.
     * That FK will be ON DELETE RESTRICT: a book that has issued bills is deactivated, never
     * deleted out from under them.
     */
    unique('books_id_tenant_uk').on(t.id, t.tenantId),
    check('books_book_number_not_blank_check', sql`length(btrim(${t.bookNumber})) > 0`),
    check('books_series_type_check', sql`${t.seriesType} in ('WITH_GST', 'WITHOUT_GST')`),
    check('books_series_starts_at_positive_check', sql`${t.seriesStartsAt} >= 1`),
    /**
     * The database's own guard on the counter: the next number can never fall behind the
     * configured start, so no update can rewind a series past numbers it has already issued.
     */
    check('books_next_bill_number_check', sql`${t.nextBillNumber} >= ${t.seriesStartsAt}`),
  ],
);
