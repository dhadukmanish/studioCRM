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

      /**
       * The series type is frozen by the same evidence: bills issued under it were taxed by it, and
       * the next one must not silently switch between With and Without GST. An unused book may
       * still change type.
       */
      if (existing && body.seriesType !== undefined && body.seriesType !== existing.seriesType && existing.nextBillNumber !== existing.seriesStartsAt) {
        throw validation('Series type cannot be changed once this book has issued bill numbers', [
          { path: ['seriesType'], message: 'This book has already issued bill numbers — create a new book for the other series type' },
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
      const row: Record<string, unknown> = { ...body };
      /**
       * The checks above read the row without a lock, so the write itself is conditional, evaluated
       * under the row lock against the row as it now stands: if a bill took a number in between,
       * neither the series start (nor the counter with it) nor the series type moves. `afterUpdate`
       * then reports that refusal instead of a false "updated". (`createBill` locks the book before
       * reading its type, so the two cannot interleave the other way round.)
       */
      const untouched = sql`${schema.books.nextBillNumber} = ${schema.books.seriesStartsAt}`;
      if (body.seriesStartsAt !== undefined && body.seriesStartsAt !== existing.seriesStartsAt) {
        row.seriesStartsAt = sql`case when ${untouched} then ${body.seriesStartsAt} else ${schema.books.seriesStartsAt} end`;
        row.nextBillNumber = sql`case when ${untouched} then ${body.seriesStartsAt} else ${schema.books.nextBillNumber} end`;
      } else {
        delete row.seriesStartsAt;
      }
      if (body.seriesType !== undefined && body.seriesType !== existing.seriesType) {
        row.seriesType = sql`case when ${untouched} then ${body.seriesType} else ${schema.books.seriesType} end`;
      } else {
        delete row.seriesType;
      }
      return row;
    },
    /** A change the conditional write above declined (a number was issued mid-edit) is an error, not a success. */
    afterUpdate: async (updated, req, previous) => {
      const sent = req.body as { seriesStartsAt?: unknown; seriesType?: unknown };
      const startRefused = sent.seriesStartsAt !== undefined && Number(sent.seriesStartsAt) !== previous.seriesStartsAt && updated.seriesStartsAt === previous.seriesStartsAt;
      const typeRefused = sent.seriesType !== undefined && sent.seriesType !== previous.seriesType && updated.seriesType === previous.seriesType;
      if (startRefused || typeRefused) {
        const field = typeRefused ? 'seriesType' : 'seriesStartsAt';
        const message = `${typeRefused ? 'Series type' : 'Series starts at'} cannot be changed once this book has issued bill numbers`;
        throw validation(message, [{ path: [field], message: 'This book issued a bill number while you were editing it' }]);
      }
    },
  });

  /**
   * Lookup for pickers — Billing's book selector next. Active books only, because an inactive
   * book stays readable and reportable but is closed to new bills. Deliberately just the id,
   * the label and the series type (it decides the new bill's tax mode): the counter is not a value
   * a picker has any business carrying around.
   * `includeInactive=1` (a report's Book filter) lists closed books too, marked `isActive: false`.
   */
  app.get('/api/common/lookups/books', { preHandler: app.authenticate }, async (req) => {
    const includeInactive = (req.query as { includeInactive?: string }).includeInactive === '1';
    const rows = await db
      .select({ id: schema.books.id, bookNumber: schema.books.bookNumber, seriesType: schema.books.seriesType, ...(includeInactive ? { isActive: schema.books.isActive } : {}) })
      .from(schema.books)
      .where(and(eq(schema.books.tenantId, req.user.tenantId), includeInactive ? undefined : eq(schema.books.isActive, true)))
      .orderBy(asc(schema.books.bookNumber));
    return ok(rows);
  });
}
