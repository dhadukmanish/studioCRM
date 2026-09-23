import { sql } from 'drizzle-orm';
import { db, schema } from '../db/client';

/**
 * Tenant-level document numbering — the same concurrency-safe principle `allocateBillNumber`
 * uses, applied to documents whose sequence belongs to the tenant rather than to a Book.
 *
 * Why a second allocator instead of reusing the Book one: a bill's series lives on a Book row,
 * so two books can each hold a Bill No. 1. An Appointment has no such boundary — there is one
 * appointment sequence per tenant. Coupling the two would mean an appointment moving a book's
 * bill counter, which must never happen. `services/billNumbers.ts` is untouched.
 */

/**
 * The documents that take a tenant-level number. One entry today; a Voucher or Receipt number
 * would be added here and need no new table.
 *
 * Bill numbers are deliberately NOT in this union — see `docs/BILL_NUMBERING.md`.
 */
export type DocumentNumberType = 'appointment';

/** `db`, or the transaction handle inside `db.transaction(...)` — the same shape the services use. */
export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Takes the next number for a document type and advances the counter, atomically.
 *
 * One `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` does everything: it creates the counter
 * on first use and otherwise advances the existing row, holding a row lock for the rest of the
 * transaction, so two operators saving at the same instant queue up and receive different
 * numbers. There is no read-then-write window, and deliberately no `SELECT max(number) + 1`
 * anywhere — that is exactly the pattern this exists to replace.
 *
 * Call it INSIDE the transaction that inserts the document, so a failed insert rolls the number
 * back with it rather than burning it. Never call it to preview a number: every call consumes
 * one.
 */
export async function allocateDocumentNumber(tx: Executor, tenantId: string, documentType: DocumentNumberType): Promise<number> {
  const [row] = await tx
    .insert(schema.documentCounters)
    // 2, because this statement is itself taking number 1 for a tenant that had no counter.
    .values({ tenantId, documentType, nextNumber: 2 })
    .onConflictDoUpdate({
      target: [schema.documentCounters.tenantId, schema.documentCounters.documentType],
      set: { nextNumber: sql`${schema.documentCounters.nextNumber} + 1`, updatedAt: new Date() },
    })
    .returning({ nextNumber: schema.documentCounters.nextNumber });
  // RETURNING reports the row as it now stands, so the number this caller owns is the one just
  // vacated — the same contract as `allocateBillNumber`.
  return row.nextNumber - 1;
}
