import type { FastifyInstance } from 'fastify';
import { and, asc, count, eq, ne, sql } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { bookSchema } from '@erp/shared';
import { crudRoutes } from '../lib/crud';
import { validation } from '../lib/errors';
import { ok } from '../lib/respond';

/**
 * Book Master — each book is one independent bill number series. List/search/filter/sort/
 * paginate, create, update and delete come from the CRUD factory, which also enforces the
 * permission and the tenant predicate on every query.
 *
 * Two things this module owns beyond an ordinary master:
 *  - a new book's counter starts at its `seriesStartsAt`, so the first bill under it takes
 *    that number and the next takes one more;
 *  - the counter is never writable from the form. `bookSchema` has no `nextBillNumber` field
 *    and zod strips unknown keys, so `toRow` below is the only code that can set it.
 *
 * Billing itself is not part of this phase — see `docs/BILL_NUMBERING.md`.
 */
export async function bookRoutes(app: FastifyInstance) {
  crudRoutes(app, {
    table: schema.books,
    base: '/api/masters/books',
    permission: 'masters_books',
    schema: bookSchema,
    label: 'Book',
    labelField: 'bookNumber',
    searchColumns: [schema.books.bookNumber],
    defaultSort: schema.books.updatedAt,
    filter: (_req, q) => [
      q.isActive === 'true' ? eq(schema.books.isActive, true) : q.isActive === 'false' ? eq(schema.books.isActive, false) : undefined,
    ],
    beforeSave: async (body, req, existing) => {
      /**
       * Friendly duplicate message. `books_tenant_number_lower_idx` is the real guard — a race
       * that slips past this check still fails at the database and surfaces as a 409.
       */
      if (body.bookNumber) {
        const [clash] = await db
          .select({ id: schema.books.id })
          .from(schema.books)
          .where(
            and(
              eq(schema.books.tenantId, req.user.tenantId),
              sql`lower(${schema.books.bookNumber}) = lower(${body.bookNumber})`,
              existing ? ne(schema.books.id, existing.id) : undefined,
            ),
          )
          .limit(1);
        if (clash) throw validation(`A book named "${body.bookNumber}" already exists`, [{ path: ['bookNumber'], message: 'This book number is already used' }]);
      }

      /**
       * The series lock. While a book has issued nothing, its counter still sits on its start
       * and the start is a correctable mistake. The moment a number has been handed out the
       * counter has moved, and changing the start would contradict bills that already exist —
       * so from then on it is refused. Nothing here invents bill-existence: the counter having
       * moved IS the evidence, and it only moves through `allocateBillNumber`.
       */
      if (existing && body.seriesStartsAt !== undefined && body.seriesStartsAt !== existing.seriesStartsAt && existing.nextBillNumber !== existing.seriesStartsAt) {
        throw validation('Series starts at cannot be changed once this book has issued bill numbers', [
          { path: ['seriesStartsAt'], message: `This book has already issued bill numbers (next is ${existing.nextBillNumber})` },
        ]);
      }
    },
    /**
     * `bills` references this row with ON DELETE RESTRICT, so the database would refuse
     * anyway — but as an opaque 500. Say what is actually in the way, and point at what the
     * studio should do instead: a book that has issued bills is deactivated, never deleted.
     */
    beforeDelete: async (row, req) => {
      const [{ total }] = await db
        .select({ total: count() })
        .from(schema.bills)
        .where(and(eq(schema.bills.tenantId, req.user.tenantId), eq(schema.bills.bookId, row.id)));
      if (Number(total) > 0) throw validation(`"${row.bookNumber}" has ${total} bill${Number(total) === 1 ? '' : 's'} under it and cannot be deleted. Set this book to Inactive instead.`);
    },
    /**
     * The only place `nextBillNumber` is ever written outside the allocator. On create it is
     * seeded from the chosen start. On update it follows the start ONLY while the series is
     * still untouched — an edit of the book number or the status must never move a counter,
     * which is why it is keyed off the existing row rather than off what was submitted.
     */
    toRow: (body, _req, existing) => {
      if (!existing) return { ...body, nextBillNumber: body.seriesStartsAt };
      const untouched = existing.nextBillNumber === existing.seriesStartsAt;
      return body.seriesStartsAt !== undefined && untouched ? { ...body, nextBillNumber: body.seriesStartsAt } : { ...body };
    },
  });

  /**
   * Lookup for pickers — Billing's book selector next. Active books only, because an inactive
   * book stays readable and reportable but is closed to new bills. Deliberately just the id
   * and the label: the counter is not a value a picker has any business carrying around.
   */
  app.get('/api/common/lookups/books', { preHandler: app.authenticate }, async (req) => {
    const rows = await db
      .select({ id: schema.books.id, bookNumber: schema.books.bookNumber })
      .from(schema.books)
      .where(and(eq(schema.books.tenantId, req.user.tenantId), eq(schema.books.isActive, true)))
      .orderBy(asc(schema.books.bookNumber));
    return ok(rows);
  });
}
