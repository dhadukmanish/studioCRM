import { pgTable, text, integer, primaryKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { ts, tenantRef } from './core';

/**
 * Tenant-level document counters — the source of every number the SERVER issues for a document
 * that has one sequence per tenant. Today that is the Appointment No.; a later Voucher or
 * Receipt number fits the same row shape without another table.
 *
 * NOT for bill numbers. A bill's series belongs to a Book row (`books.next_bill_number`), so
 * that two books can each hold a Bill No. 1 — a genuinely different shape, documented in
 * `docs/BILL_NUMBERING.md`. Nothing here touches a Book, and creating an appointment never
 * moves a bill counter.
 *
 * The counter moves only through `allocateDocumentNumber` (`services/documentNumbers.ts`),
 * inside the transaction that writes the document. There is no route, no schema field and no
 * permission that can set it.
 */
export const documentCounters = pgTable(
  'document_counters',
  {
    tenantId: tenantRef(),
    /** `appointment` today — see `DocumentNumberType` in `services/documentNumbers.ts`. */
    documentType: text('document_type').notNull(),
    /** The number the NEXT document of this type will take. Starts at 1 and only ever rises. */
    nextNumber: integer('next_number').notNull().default(1),
    ...ts,
  },
  (t) => [
    /**
     * One counter per tenant per document type. It is also the conflict target the allocator's
     * single atomic upsert needs, which is what lets the first ever allocation create the row
     * and a concurrent one wait for it instead of inserting a second.
     */
    primaryKey({ columns: [t.tenantId, t.documentType], name: 'document_counters_pk' }),
    check('document_counters_next_number_check', sql`${t.nextNumber} >= 1`),
    check('document_counters_document_type_not_blank_check', sql`length(btrim(${t.documentType})) > 0`),
  ],
);
