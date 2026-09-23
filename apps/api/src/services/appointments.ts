import { normalizeMobile, type AppointmentInput } from '@erp/shared';
import { db, schema } from '../db/client';
import { allocateDocumentNumber } from './documentNumbers';

/**
 * Appointment business rules. The route validates and authorizes; this owns the one thing that
 * is more than a single write — taking the appointment number and inserting the row in the
 * same transaction.
 */

/**
 * API shape: a `time` column reads back as HH:MM:SS. The studio books to the minute, so the
 * seconds are dropped here rather than in every screen that shows a time.
 */
export const shapeAppointment = <T extends { appointmentTime: string | null }>(row: T) => ({
  ...row,
  appointmentTime: row.appointmentTime ? row.appointmentTime.slice(0, 5) : null,
});

/**
 * Validated body -> row values. The only place `mobileSearch` is ever written: it is derived
 * from what the operator typed, never accepted from a client, so the search key and the
 * display value can never disagree.
 */
export function appointmentRow(body: Partial<AppointmentInput>): Record<string, unknown> {
  const row: Record<string, unknown> = { ...body };
  if (body.mobileNumber !== undefined) row.mobileSearch = normalizeMobile(body.mobileNumber);
  return row;
}

/**
 * Create an appointment and take its number in ONE transaction.
 *
 * The allocation and the insert commit together: a failed insert rolls the counter back with
 * it, so a rejected save does not burn an appointment number. This is the same contract
 * `allocateBillNumber` documents for the future Billing transaction.
 */
export async function createAppointment(tenantId: string, body: AppointmentInput) {
  return db.transaction(async (tx) => {
    const appointmentNumber = await allocateDocumentNumber(tx, tenantId, 'appointment');
    const [created] = await tx
      .insert(schema.appointments)
      .values({ ...(appointmentRow(body) as typeof schema.appointments.$inferInsert), appointmentNumber, tenantId })
      .returning();
    return shapeAppointment(created);
  });
}
