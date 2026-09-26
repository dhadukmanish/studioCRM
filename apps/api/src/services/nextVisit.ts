import { and, eq } from 'drizzle-orm';
import { normalizeMobile } from '@erp/shared';
import { db, schema } from '../db/client';
import { validation } from '../lib/errors';
import { allocateDocumentNumber } from './documentNumbers';

/**
 * Next Visit — the appointment a bill's Next Visit Date creates.
 *
 * Runs INSIDE the bill's create/update transaction, after the bill row is written, so the bill and
 * its appointment commit or roll back together: a refused bill creates no appointment, and a failed
 * appointment leaves no bill (and burns neither the bill number nor the appointment number).
 *
 * The link is `appointments.source_bill_id`, with a unique index on (tenant, source_bill_id): a bill
 * has at most ONE system-created appointment, whatever the number of saves — the database, not a
 * mobile + date guess, is what refuses a duplicate. Concurrent edits of one bill are serialized by
 * the bill's `FOR UPDATE` lock that `updateBill` takes before calling this.
 *
 * Rules (docs/BILL_NUMBERING.md → Next Visit):
 *  - date set, no linked appointment → create one (customer, mobile, baby name, the date; no time)
 *    — on an EDIT only when the date is new or changed, so an appointment the studio deleted by
 *    hand is not resurrected by an unrelated re-save;
 *  - date changed IN THIS SAVE, linked appointment → move that appointment to the new date, unless it has
 *    itself been billed (the visit happened — history is never rewritten), which is refused;
 *  - date cleared → the appointment is DETACHED (kept, `source_bill_id` = NULL), never deleted.
 */

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
const A = schema.appointments;

export interface NextVisitBill {
  id: string;
  bookNumber: string;
  billNumber: number;
  customerName: string;
  mobileNumber: string;
  babyName: string | null;
  /** The booking this bill came FROM — never its own next visit. */
  appointmentId: string | null;
  nextVisitDate: string | null;
}

export interface NextVisitResult {
  /** What happened to the linked appointment in this save — for the audit trail. */
  action: 'created' | 'moved' | 'detached' | null;
  appointment: { id: string; appointmentNumber: number } | null;
}

/** The appointment a bill's next visit created, if it is still linked. */
export async function linkedAppointment(exec: Executor, tenantId: string, billId: string, lock = false) {
  const q = exec
    .select({ id: A.id, appointmentNumber: A.appointmentNumber, appointmentDate: A.appointmentDate })
    .from(A)
    .where(and(eq(A.tenantId, tenantId), eq(A.sourceBillId, billId)))
    .limit(1);
  const [row] = await (lock ? q.for('update') : q);
  return row ?? null;
}

/**
 * Bring the bill's next-visit appointment in line with the bill just saved.
 * `previousDate` is the bill's saved next visit BEFORE this save (undefined for a new bill).
 */
export async function syncNextVisit(tx: Executor, tenantId: string, bill: NextVisitBill, previousDate?: string | null): Promise<NextVisitResult> {
  const linked = await linkedAppointment(tx, tenantId, bill.id, true);
  if (linked && bill.appointmentId === linked.id) {
    const message = `Appointment #${linked.appointmentNumber} is this bill's own next visit, not the booking it came from`;
    throw validation(message, [{ path: ['appointmentId'], message }]);
  }

  if (!bill.nextVisitDate) {
    if (!linked) return { action: null, appointment: null };
    await tx.update(A).set({ sourceBillId: null, updatedAt: new Date() }).where(and(eq(A.id, linked.id), eq(A.tenantId, tenantId)));
    return { action: 'detached', appointment: linked };
  }

  if (linked) {
    /**
     * Only a save that CHANGES the bill's next visit moves the appointment. An unrelated re-save
     * leaves it alone — the studio may have rescheduled it in Appointments, and that is not the
     * bill's to undo (nor may an appointment billed since then lock the bill against edits).
     */
    const dateChanged = previousDate === undefined || previousDate !== bill.nextVisitDate;
    if (!dateChanged || linked.appointmentDate === bill.nextVisitDate) return { action: null, appointment: linked };
    const [billed] = await tx
      .select({ id: schema.bills.id })
      .from(schema.bills)
      .where(and(eq(schema.bills.tenantId, tenantId), eq(schema.bills.appointmentId, linked.id)))
      .limit(1);
    if (billed) {
      const message = `Next Appointment #${linked.appointmentNumber} has already been billed, so its date cannot change`;
      throw validation(message, [{ path: ['nextVisitDate'], message }]);
    }
    await tx.update(A).set({ appointmentDate: bill.nextVisitDate, updatedAt: new Date() }).where(and(eq(A.id, linked.id), eq(A.tenantId, tenantId)));
    return { action: 'moved', appointment: linked };
  }

  // No linked appointment. An edit that did not touch the date leaves it that way.
  if (previousDate !== undefined && previousDate === bill.nextVisitDate) return { action: null, appointment: null };

  const appointmentNumber = await allocateDocumentNumber(tx, tenantId, 'appointment');
  const [created] = await tx
    .insert(A)
    .values({
      tenantId,
      appointmentNumber,
      appointmentDate: bill.nextVisitDate,
      // Optional on an appointment, and the operator did not choose one — never invented.
      appointmentTime: null,
      customerName: bill.customerName,
      mobileNumber: bill.mobileNumber,
      mobileSearch: normalizeMobile(bill.mobileNumber),
      babyName: bill.babyName,
      remark: `Next visit from Bill ${bill.bookNumber}/${bill.billNumber}`,
      sourceBillId: bill.id,
    })
    .returning();
  return { action: 'created', appointment: { id: created.id, appointmentNumber: created.appointmentNumber } };
}

/** Deleting a bill keeps its next-visit appointment — only the link goes. */
export async function detachNextVisit(tx: Executor, tenantId: string, billId: string) {
  await tx.update(A).set({ sourceBillId: null, updatedAt: new Date() }).where(and(eq(A.tenantId, tenantId), eq(A.sourceBillId, billId)));
}
