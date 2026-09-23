import { z } from 'zod';

/**
 * Appointment — the studio's booking record: a customer calls, a date/time is agreed, and the
 * baby's name and a remark are noted. It is an OPERATIONAL document, not a master.
 *
 * The customer fields are a SNAPSHOT held by the appointment itself. There is deliberately no
 * Customer Master in this phase: nothing here deduplicates customers, and two appointments
 * sharing a mobile number are two independent bookings, not one customer record.
 *
 * `appointmentNumber` is system-issued and deliberately absent from this schema — zod strips
 * unknown keys, so no request body can ever set or move it.
 */

/** Single source of truth for the field limits — the form reuses these, never its own literals. */
export const APPOINTMENT_LIMITS = {
  customerName: 120,
  /** Generous on purpose: a stored number may carry a country prefix, spaces or dashes. */
  mobileNumber: 30,
  babyName: 120,
  remark: 500,
} as const;

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/** Optional free text: trimmed, and blank is stored as NULL, never as ''. */
const optionalText = (label: string, max: number) =>
  z.preprocess((v) => (isBlank(v) ? null : v), z.string().trim().max(max, `${label} cannot exceed ${max} characters`).nullable());

/* -------------------------------------------------------------- date/time -- */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

/**
 * A calendar date is checked by rebuilding it, so 2026-02-30 is rejected instead of silently
 * rolling over into March. Deliberately no `new Date(str)`: that parses a bare date as UTC
 * midnight, which is a different day in some timezones — an appointment date must never shift.
 */
function isRealDate(value: string) {
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/* ------------------------------------------------------------------ mobile -- */

/**
 * The searchable form of a mobile number. The stored/display value is NEVER changed — this is
 * only the key the Billing lookup matches on, so "+91 98765 43210", "98765-43210" and
 * "9876543210" all find the same customer.
 *
 * The rule is deliberately small: keep the digits, and when more than ten remain keep the last
 * ten, which drops an Indian country/trunk prefix without pretending to parse international
 * numbers. Anything shorter is kept as entered.
 */
export function normalizeMobile(raw: string | null | undefined): string {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/* ------------------------------------------------------------------ schema -- */

export const appointmentSchema = z.object({
  /**
   * A plain calendar date (YYYY-MM-DD), stored in a `date` column. It carries no time and no
   * timezone: the business day the customer is booked for is the same day everywhere.
   */
  appointmentDate: z
    .string({ required_error: 'Appointment date is required', invalid_type_error: 'Appointment date is required' })
    .trim()
    .min(1, 'Appointment date is required')
    .regex(DATE_RE, 'Enter a valid appointment date')
    .refine(isRealDate, 'Enter a valid appointment date'),
  /**
   * Local business clock time, optional. An appointment may be agreed for a day before the hour
   * is settled, and nothing in the requirement makes a time mandatory — so a blank time is a
   * real answer, stored as NULL, not a validation error.
   *
   * Seconds are accepted (a `time` column reads back as HH:MM:SS) but never kept: the studio
   * books to the minute.
   */
  appointmentTime: z.preprocess(
    (v) => (isBlank(v) ? null : typeof v === 'string' ? v.trim() : v),
    z.string().regex(TIME_RE, 'Enter a valid time').transform((v) => v.slice(0, 5)).nullable(),
  ),
  customerName: z
    .string({ required_error: 'Customer name is required', invalid_type_error: 'Customer name is required' })
    .trim()
    .min(1, 'Customer name is required')
    .max(APPOINTMENT_LIMITS.customerName, `Customer name cannot exceed ${APPOINTMENT_LIMITS.customerName} characters`),
  /**
   * Text, never numeric: leading zeros, a country prefix and the operator's own spacing all
   * matter, and none of them survive a number column. No fixed length is imposed — the
   * requirement does not establish a 10-digit-only business rule — but a number with no digit
   * at all is not a phone number and would make the Billing lookup meaningless.
   */
  mobileNumber: z
    .string({ required_error: 'Mobile no. is required', invalid_type_error: 'Mobile no. is required' })
    .trim()
    .min(1, 'Mobile no. is required')
    .max(APPOINTMENT_LIMITS.mobileNumber, `Mobile no. cannot exceed ${APPOINTMENT_LIMITS.mobileNumber} characters`)
    .refine((v) => /\d/.test(v), 'Enter a valid mobile no.'),
  /** "Baby Name" on the current form, "Baby/Boy Name" in the legacy wording. Optional. */
  babyName: optionalText('Baby name', APPOINTMENT_LIMITS.babyName),
  /** Free-form note. It is not a status: nothing reads it to drive a workflow. */
  remark: optionalText('Remark', APPOINTMENT_LIMITS.remark),
});
export type AppointmentInput = z.infer<typeof appointmentSchema>;
