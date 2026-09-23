import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { notFound } from '../lib/errors';

/**
 * Bill number allocation — the concurrency-safe primitive the Billing phase will build on.
 *
 * Each Book carries its own counter, so every book numbers its bills independently: book
 * "2026-27" and book "2027-28" can both hold a Bill No. 1. There is no tenant-wide sequence,
 * and nothing resets a series by date — a new series exists because a new Book was created.
 *
 * NOTHING calls this yet. Bills do not exist in this phase; the helper is here so that when
 * they do, the number comes from one reviewed place instead of being invented at the call
 * site. See `docs/BILL_NUMBERING.md` for the contract.
 */

/** `db`, or the transaction handle inside `db.transaction(...)` — the same shape `services/accounts.ts` uses. */
export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Takes the next bill number for a book and advances the counter, atomically.
 *
 * One `UPDATE ... RETURNING` does both: Postgres locks the book row for the duration, so two
 * operators billing at the same instant queue up and receive different numbers. There is no
 * read-then-write window, and deliberately no `SELECT max(bill_no) + 1` anywhere — that is
 * exactly the pattern this exists to replace.
 *
 * Call it INSIDE the transaction that inserts the bill, so that a failed bill rolls the number
 * back with it. Never call it to preview a number: every call consumes one.
 *
 * Activating/deactivating a book is deliberately not checked here — whether a book may still
 * be billed into is a Billing workflow decision that needs its own message; this function only
 * owns the counter.
 */
export async function allocateBillNumber(tx: Executor, tenantId: string, bookId: string): Promise<number> {
  const [row] = await tx
    .update(schema.books)
    .set({ nextBillNumber: sql`${schema.books.nextBillNumber} + 1` })
    .where(and(eq(schema.books.id, bookId), eq(schema.books.tenantId, tenantId)))
    .returning({ nextBillNumber: schema.books.nextBillNumber });
  if (!row) throw notFound('Book');
  // RETURNING reports the row as it now stands, so the number this caller owns is the one
  // just vacated.
  return row.nextBillNumber - 1;
}
