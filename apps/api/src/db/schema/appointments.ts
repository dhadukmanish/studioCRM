import { pgTable, text, integer, date, time, unique, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { id, ts, tenantRef } from './core';

/**
 * Appointment — the studio's booking record. Operational, not a master: the customer contacts
 * the studio, a date and (usually) a time are agreed, and the customer's name, mobile and the
 * baby's name are noted so Billing does not have to ask for them again.
 *
 * The customer fields are a SNAPSHOT this row owns. There is no Customer Master in this phase
 * and no deduplication: the same mobile number may appear on any number of appointments, which
 * is exactly why Billing's lookup returns candidates rather than one row.
 *
 * Nothing here models a status, a studio room, a photographer, a duration or a slot: none of
 * those is established by the requirement, so two appointments may share a date and time.
 *
 * Audited through `activity_logs`, like every other module.
 */
export const appointments = pgTable(
  'appointments',
  {
    id: id(),
    tenantId: tenantRef(),
    /**
     * SYSTEM-ISSUED, one sequence per tenant, taken from `document_counters` inside the
     * transaction that inserts the row. Never user-supplied: `appointmentSchema` has no such
     * field. Stored as the bare integer — 1, 2, 3 — because no business rule establishes a
     * decorated format; any prefix or padding would be presentation only.
     *
     * Independent of Book Master: Appointment #1 and Bill No. 1 are unrelated numbers.
     */
    appointmentNumber: integer('appointment_number').notNull(),
    /** A plain calendar date — no time, no timezone, so a booking never shifts by a day. */
    appointmentDate: date('appointment_date', { mode: 'string' }).notNull(),
    /** Local business clock time, optional. Deliberately separate from the date, never a timestamptz. */
    appointmentTime: time('appointment_time'),
    customerName: text('customer_name').notNull(),
    /** Exactly as the operator typed it — display value, never rewritten. */
    mobileNumber: text('mobile_number').notNull(),
    /**
     * Server-derived search key for the same number (`normalizeMobile` in `@erp/shared`), so
     * "+91 98765 43210" and "98765-43210" find each other. Never accepted from a client.
     */
    mobileSearch: text('mobile_search').notNull(),
    /** "Baby Name" on the current form, "Baby/Boy Name" in the legacy wording. */
    babyName: text('baby_name'),
    remark: text('remark'),
    ...ts,
  },
  (t) => [
    /** The document's identity, and the last guard if two creates ever raced past the allocator. */
    unique('appointments_tenant_number_uk').on(t.tenantId, t.appointmentNumber),
    /**
     * Redundant on its own (id is already the primary key), but it is the target a future
     * `bills` table needs in order to reference (appointment_id, tenant_id) together, the same
     * tenant-safe composite key the rest of the schema uses. That foreign key is NOT created
     * here: bills do not exist yet.
     */
    unique('appointments_id_tenant_uk').on(t.id, t.tenantId),
    /** The list's default "most recent first" ordering and its date filters. */
    index('appointments_tenant_date_idx').on(t.tenantId, t.appointmentDate),
    /** The Billing lookup: an exact match on the normalized number, within one tenant. */
    index('appointments_tenant_mobile_idx').on(t.tenantId, t.mobileSearch),
    check('appointments_appointment_number_positive_check', sql`${t.appointmentNumber} >= 1`),
    check('appointments_customer_name_not_blank_check', sql`length(btrim(${t.customerName})) > 0`),
    check('appointments_mobile_number_not_blank_check', sql`length(btrim(${t.mobileNumber})) > 0`),
  ],
);
