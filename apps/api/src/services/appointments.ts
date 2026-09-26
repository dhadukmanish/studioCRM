import { and, asc, desc, eq, gt, gte, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { normalizeMobile, type AppointmentInput, type AppointmentStatus, type AppointmentView } from '@erp/shared';
import { db, schema } from '../db/client';
import { notFound } from '../lib/errors';
import { allocateDocumentNumber } from './documentNumbers';

const A = schema.appointments;

/**
 * Appointment business rules. The route validates and authorizes; this owns the one thing that
 * is more than a single write — taking the appointment number and inserting the row in the
 * same transaction.
 */

/**
 * API shape: a `time` column reads back as HH:MM:SS. The studio books to the minute, so the
 * seconds are dropped here rather than in every screen that shows a time.
 */
export const shapeAppointment = <T extends { appointmentTime: string | null; completedAt?: Date | null }>(row: T) => ({
  ...row,
  appointmentTime: row.appointmentTime ? row.appointmentTime.slice(0, 5) : null,
  ...('completedAt' in row ? { status: (row.completedAt ? 'DONE' : 'PENDING') as AppointmentStatus } : {}),
});

/**
 * Mark an appointment Done — one click. Idempotent: an appointment already Done keeps its original
 * time and person. Returns the row and whether anything changed (for the audit entry).
 */
export async function completeAppointment(tenantId: string, userId: string, id: string) {
  const [updated] = await db
    .update(A)
    .set({ completedAt: new Date(), completedBy: userId, updatedAt: new Date() })
    .where(and(eq(A.id, id), eq(A.tenantId, tenantId), isNull(A.completedAt)))
    .returning();
  if (updated) return { row: updated, changed: true };
  const [existing] = await db.select().from(A).where(and(eq(A.id, id), eq(A.tenantId, tenantId)));
  if (!existing) throw notFound('Appointment');
  return { row: existing, changed: false };
}

/** Back to Pending — for correcting a mistaken Done. */
export async function reopenAppointment(tenantId: string, id: string) {
  const [updated] = await db
    .update(A)
    .set({ completedAt: null, completedBy: null, updatedAt: new Date() })
    .where(and(eq(A.id, id), eq(A.tenantId, tenantId), isNotNull(A.completedAt)))
    .returning();
  if (updated) return { row: updated, changed: true };
  const [existing] = await db.select().from(A).where(and(eq(A.id, id), eq(A.tenantId, tenantId)));
  if (!existing) throw notFound('Appointment');
  return { row: existing, changed: false };
}

/**
 * The list narrowing and order for a view. PENDING is oldest first — a missed appointment stays at
 * the top until someone deals with it; DONE is most recently completed first; ALL keeps the
 * list's historical order (latest date first).
 */
export function appointmentView(view: AppointmentView, today: string, from?: string, to?: string) {
  const range = and(from ? gte(A.appointmentDate, from) : undefined, to ? lte(A.appointmentDate, to) : undefined);
  const soonest = [asc(A.appointmentDate), sql`${A.appointmentTime} ASC NULLS LAST`, asc(A.appointmentNumber)];
  switch (view) {
    case 'TODAY':
      return { where: and(range, isNull(A.completedAt), eq(A.appointmentDate, today)), order: soonest };
    case 'UPCOMING':
      return { where: and(range, isNull(A.completedAt), gt(A.appointmentDate, today)), order: soonest };
    case 'PENDING':
      return { where: and(range, isNull(A.completedAt)), order: soonest };
    case 'DONE':
      return { where: and(range, isNotNull(A.completedAt)), order: [desc(A.completedAt), desc(A.appointmentNumber)] };
    default:
      return { where: range, order: [desc(A.appointmentDate), sql`${A.appointmentTime} DESC NULLS LAST`, desc(A.appointmentNumber)] };
  }
}

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
